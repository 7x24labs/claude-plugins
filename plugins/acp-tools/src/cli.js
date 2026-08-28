#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const config = require('./config');
const client = require('./client');
const acp = require('./acp');

const VERSION = '1.0.0';
const VALUE_FLAGS = new Set([
  'cwd', 'token', 'port', 'host', 'timeout', 'tail', 'agent-command', 'permission', 'fs-scope', 'title',
]);

// ------------------------------------------------------------------- helpers

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key)) { flags[key] = argv[++i]; continue; }
      flags[key] = true;
      continue;
    }
    rest.push(a);
  }
  return { flags, rest };
}

const isTTY = () => process.stdout.isTTY;
const useColor = () => isTTY() && !process.env.NO_COLOR;
const out = (s = '') => process.stdout.write(s + '\n');
const jsonOut = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function die(msg, code = 1) {
  process.stderr.write(`acp: ${msg}\n`);
  process.exit(code);
}

function table(rows, headers) {
  if (!rows.length) return;
  const cols = headers.length;
  const w = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] === undefined ? '' : r[i]).length)));
  const line = (cells, dim) => {
    const s = cells.map((c, i) =>
      String(c === undefined ? '' : c).padEnd(i === cols - 1 ? 0 : w[i])).join('  ').trimEnd();
    out(dim && useColor() ? `\x1b[2m${s}\x1b[0m` : s);
  };
  line(headers, true);
  for (const r of rows) line(r);
}

const ago = (iso) => {
  if (!iso) return '-';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// -------------------------------------------------------------------- agent

function cmdAgentAdd(cfg, rest, flags) {
  const [name, url, cwdArg] = rest;
  if (!name || !url) die('usage: acp agent add <name> <url> [cwd] [--token TOKEN]');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    die(`invalid agent name "${name}" -- letters, digits, dot, dash, underscore only`);
  }
  if (!/^(wss?:\/\/|stdio:)/.test(url)) {
    die(`invalid url "${url}" -- expected ws://host:port, wss://host:port, or stdio:<command>`);
  }
  const cwd = path.resolve(cwdArg || process.cwd());
  if (url.startsWith('stdio:') && !fs.existsSync(cwd)) {
    die(`cwd does not exist: ${cwd}`);
  }
  const entry = { url, cwd, addedAt: new Date().toISOString() };
  if (flags.token) entry.token = flags.token;
  if (flags.permission) entry.permissionMode = flags.permission;

  config.update((c) => {
    if (c.agents[name] && !flags.force) {
      die(`agent "${name}" already exists -- use --force to overwrite, or acp agent remove ${name}`);
    }
    c.agents[name] = entry;
  });
  out(`added agent "${name}" -> ${url}`);
  out(`  cwd: ${cwd}`);
  if (url.startsWith('ws') && !entry.token) {
    out('  note: no --token given; the remote daemon will reject you unless it runs without auth');
  }
}

function cmdAgentRemove(cfg, rest) {
  const [name] = rest;
  if (!name) die('usage: acp agent remove <name>');
  const removed = config.update((c) => {
    if (!c.agents[name]) return false;
    delete c.agents[name];
    for (const key of Object.keys(c.sessions)) {
      if (c.sessions[key].agent === name) delete c.sessions[key];
    }
    return true;
  });
  if (!removed) die(`unknown agent: ${name}`);
  out(`removed agent "${name}" and its session records`);
}

async function cmdAgentLs(cfg, rest, flags) {
  const names = Object.keys(cfg.agents).sort();
  if (flags.json) return jsonOut(cfg.agents);
  if (!names.length) {
    out('no agents registered');
    out('  acp agent add <name> <ws://host:port | stdio:command> [cwd]');
    return;
  }
  // ACTIVE counts what the daemons are really holding, sessions started from
  // the web UI included. An agent that cannot be asked falls back to the
  // registry, flagged `?` so a guess is never mistaken for a count.
  const authority = flags.local ? new Map() : await pollDaemons(cfg, names, flags);
  table(names.map((n) => {
    const a = cfg.agents[n];
    const live = authority.get(n);
    if (live) return [n, a.url, a.cwd, live.length || '-'];
    const known = client.listSessions(cfg, n).filter((s) => s.state === 'active').length;
    return [n, a.url, a.cwd, known ? `${known}?` : '-'];
  }), ['NAME', 'URL', 'CWD', 'ACTIVE']);
}

// ------------------------------------------------------------------ session

// Stored title when there is one, else recovered from the transcript so
// sessions started before titles were recorded -- and those started from the
// web UI, which never touches this registry -- are still recognizable.
const sessionTitle = (s) =>
  s.title
  || config.titleFromTranscript(s.agent, s.sessionId)
  || config.titleFromTranscript('_daemon', s.sessionId)   // browser-started
  || '';

// What a daemon says it is holding right now, shaped like local records: an
// array when it answered -- and then it is the whole truth, because a session
// missing from it has been closed or deleted, very likely from the web UI,
// which talks straight to the daemon and never touches this registry -- or
// null when there was nobody to ask, leaving the registry as the only source.
async function liveSessions(cfg, agent, flags) {
  const url = (cfg.agents[agent] || {}).url || '';
  // A stdio agent is spawned per command and keeps no state between them, so
  // there is no daemon to ask -- and asking would spawn a process just to list.
  if (!/^wss?:/.test(url)) return null;
  let conn = null;
  try {
    conn = await client.connectAgent(cfg, agent, { verbose: flags.verbose, timeoutMs: 3000 });
    const res = await conn.peer.request('session/list', {}, { timeoutMs: 5000 });
    return ((res && res.sessions) || []).map((s) => Object.assign({ agent }, s));
  } catch {
    return null;   // down, slow, or refusing us: we learned nothing
  } finally {
    if (conn) { try { conn.close(); } catch { /* already gone */ } }
  }
}

// Ask every daemon in parallel. The result maps agent name -> live sessions,
// and holds only the agents that answered: the rest have no authority here.
async function pollDaemons(cfg, names, flags) {
  const answers = await Promise.all(names.map((n) => liveSessions(cfg, n, flags)));
  const authority = new Map();
  names.forEach((n, i) => { if (answers[i]) authority.set(n, answers[i]); });
  return authority;
}

// Registry records the daemons have disowned, and records left behind by an
// agent that is no longer registered. Split out of the listing so the default
// view shows what is actually running.
function classifyStale(cfg, s, authority) {
  if (!cfg.agents[s.agent]) return 'orphan';
  return authority.has(s.agent) ? 'ended' : null;
}

async function cmdSessionLs(cfg, rest, flags) {
  const agent = rest[0];
  if (agent && !cfg.agents[agent]) die(`unknown agent: ${agent}`);

  // Default view is live: the daemons are asked, and for every daemon that
  // answers its list wins outright. --local keeps it offline (registry only);
  // --remote asks one daemon and nothing else; --all also prints the records
  // that are no longer live, which `acp send` can still reload by id.
  if (!flags.remote) {
    const names = agent ? [agent] : Object.keys(cfg.agents);
    const authority = flags.local ? new Map() : await pollDaemons(cfg, names, flags);

    const merged = new Map();
    for (const list of authority.values()) {
      for (const s of list) merged.set(config.sessionKey(s.agent, s.sessionId), s);
    }

    const stale = [];
    for (const s of client.listSessions(cfg, agent)) {
      const key = config.sessionKey(s.agent, s.sessionId);
      const live = merged.get(key);
      if (!live) {
        const why = classifyStale(cfg, s, authority);
        if (why) stale.push(Object.assign({}, s, { state: why }));
        else merged.set(key, s);   // nobody to ask -- the record is all we have
        continue;
      }
      // Live and recorded: the daemon owns the state, the record owns the rest.
      const next = Object.assign({}, s, live);
      next.turns = Math.max(live.turns || 0, s.turns || 0);
      next.title = live.title || s.title;
      next.cwd = live.cwd || s.cwd;
      merged.set(key, next);
    }

    // Write back what we learned, so the registry stops calling dead sessions
    // active -- `acp agent ls` counts those, and `acp send` picks the latest.
    const demoted = stale.filter((s) => s.state === 'ended'
      && (cfg.sessions[config.sessionKey(s.agent, s.sessionId)] || {}).state !== 'ended');
    if (demoted.length) {
      config.update((c) => {
        for (const s of demoted) {
          const rec = c.sessions[config.sessionKey(s.agent, s.sessionId)];
          if (rec) rec.state = 'ended';   // not updatedAt: that is when it last ran
        }
      });
    }

    const rows = (flags.all ? [...merged.values(), ...stale] : [...merged.values()])
      .map((s) => Object.assign({}, s, { title: sessionTitle(s) }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    if (flags.json) return jsonOut(rows);
    if (!rows.length) {
      out(agent ? `no sessions for "${agent}"` : 'no sessions');
    } else {
      table(rows.map((s) => [s.agent, s.sessionId, s.state || '-', s.turns || 0, s.cwd || '-',
        ago(s.updatedAt), s.title || '-']),
        ['AGENT', 'SESSION', 'STATE', 'TURNS', 'CWD', 'UPDATED', 'TITLE']);
    }
    if (stale.length && !flags.all && isTTY()) {
      process.stderr.write(`(${stale.length} record(s) no longer live -- ` +
        `acp session ls --all, or acp session prune)\n`);
    }
    return;
  }

  if (!agent) die('--remote needs an agent: acp session ls <agent> --remote');
  const conn = await client.connectAgent(cfg, agent, { verbose: flags.verbose });
  try {
    const res = await conn.peer.request('session/list', {}, { timeoutMs: 30000 });
    const rows = (res && res.sessions) || [];
    if (flags.json) return jsonOut(rows);
    if (!rows.length) return out(`no live sessions on "${agent}"`);
    table(rows.map((s) => [s.sessionId, s.state || '-', s.turns === undefined ? '-' : s.turns,
      s.cwd || '-', ago(s.updatedAt), s.title || '-']),
      ['SESSION', 'STATE', 'TURNS', 'CWD', 'UPDATED', 'TITLE']);
  } finally { conn.close(); }
}

// Drop the registry records that can no longer be reached: sessions a daemon
// we could reach is not holding, and sessions of an unregistered agent. An
// agent nobody could reach is left alone -- silence is not proof of death.
async function cmdSessionPrune(cfg, rest, flags) {
  const agent = rest[0];
  if (agent && !cfg.agents[agent]) die(`unknown agent: ${agent}`);
  const names = agent ? [agent] : Object.keys(cfg.agents);
  const authority = await pollDaemons(cfg, names, flags);

  const live = new Set();
  for (const [name, list] of authority) {
    for (const s of list) live.add(config.sessionKey(name, s.sessionId));
  }

  const doomed = client.listSessions(cfg, agent)
    .filter((s) => classifyStale(cfg, s, authority)
      && !live.has(config.sessionKey(s.agent, s.sessionId)));

  if (doomed.length) {
    config.update((c) => {
      for (const s of doomed) delete c.sessions[config.sessionKey(s.agent, s.sessionId)];
    });
  }
  if (flags.json) {
    return jsonOut(doomed.map((s) => ({ agent: s.agent, sessionId: s.sessionId })));
  }
  if (!doomed.length) return out('nothing to prune');
  for (const s of doomed) out(`${s.agent}  ${s.sessionId}`);
  out(`pruned ${doomed.length} session record(s); transcripts kept in ${config.LOG_DIR}`);
}

// `acp session rename <agent> [session] <title...>` -- the middle word is a
// session id only if some session actually goes by it, same rule `send` uses;
// otherwise the session defaults to the agent's most recently used one, same
// as close/pause/resume/rm.
async function cmdSessionRename(cfg, rest, flags) {
  const agent = rest[0];
  if (!agent) die('usage: acp session rename <agent> [session] <title...>');
  const words = rest.slice(1);
  if (!words.length) die('usage: acp session rename <agent> [session] <title...>');
  // The first word is a session id only if a title still remains after it --
  // `acp session rename reviewer alone` renames the latest session to "alone".
  const maybeId = words.length > 1 ? words[0] : null;
  let sessionId = maybeId && (client.isKnownSession(cfg, agent, maybeId)
    || fs.existsSync(config.transcriptPath(agent, maybeId, false))) ? maybeId : null;

  const conn = await client.connectAgent(cfg, agent, { verbose: flags.verbose });
  try {
    // Not a known local id -- ask the daemon before assuming it is the start
    // of the title, the same way `send` recognizes a web-UI session.
    if (!sessionId && maybeId && await client.daemonHasSession(conn, maybeId))
      sessionId = maybeId;

    const title = (sessionId ? words.slice(1) : words).join(' ').trim();
    if (!title) die('usage: acp session rename <agent> [session] <title...>');

    if (!sessionId) {
      const latest = client.latestUsable(cfg, agent);
      if (!latest) die(`no known sessions for "${agent}"`);
      sessionId = latest.sessionId;
    }

    const res = await client.renameSession(cfg, conn, agent, sessionId, title);
    if (flags.json) return jsonOut(Object.assign({ sessionId }, res));
    out(`session ${sessionId} on "${agent}" renamed to "${res.title}"` + (res.local ? ' (local record)' : ''));
  } finally { conn.close(); }
}

async function cmdSessionClose(cfg, rest, flags) {
  const agent = rest[0];
  let sessionId = rest[1];
  if (!agent) die('usage: acp session close <agent> [session]');
  if (!sessionId) {
    const latest = client.listSessions(cfg, agent)[0];
    if (!latest) die(`no known sessions for "${agent}"`);
    sessionId = latest.sessionId;
  }

  // A stdio agent holds no state between commands, so there is nothing to
  // reach: the local record is the whole truth.
  if ((cfg.agents[agent].url || '').startsWith('stdio:')) {
    client.rememberSession(agent, sessionId, { state: 'closed' });
    if (flags.json) return jsonOut({ sessionId, action: 'close', state: 'closed', local: true });
    return out(`session ${sessionId} on "${agent}" marked closed (local record)`);
  }
  const conn = await client.connectAgent(cfg, agent, { verbose: flags.verbose });
  try {
    const res = await conn.peer.request('session/close', { sessionId }, { timeoutMs: 120000 });
    client.rememberSession(agent, sessionId, { state: 'closed' });

    if (flags.json) return jsonOut(Object.assign({ sessionId, action: 'close' }, res || {}));
    out(`session ${sessionId} on "${agent}" closed` +
        (res && res.reloaded ? ' (reloaded from disk)' : ''));
  } finally { conn.close(); }
}

function cmdSessionLog(cfg, rest, flags) {
  const [agent, sessionArg] = rest;
  if (!agent) die('usage: acp session log <agent> [session] [--tail N]');
  const sessionId = sessionArg || (client.listSessions(cfg, agent)[0] || {}).sessionId;
  if (!sessionId) die(`no known sessions for "${agent}"`);
  const file = config.transcriptPath(agent, sessionId);
  if (!fs.existsSync(file)) die(`no transcript yet: ${file}`);

  let lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (flags.tail) lines = lines.slice(-Number(flags.tail));
  if (flags.json) { for (const l of lines) out(l); return; }

  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const when = String(e.ts || '').slice(11, 19);
    if (e.type === 'prompt') out(`${when} >> ${e.text}`);
    else if (e.type === 'reply') out(`${when} << ${e.text}`);
    else if (e.type === 'stop') out(`${when} -- ${e.stopReason}`);
    else if (e.type === 'error') out(`${when} !! ${e.error}`);
  }
}

// --------------------------------------------------------------------- send

// Runs one prompt turn. Returns { stopReason, text }.
async function runTurn(conn, sessionId, text, flags) {
  const json = Boolean(flags.json);
  const quiet = Boolean(flags.quiet);
  const renderer = (json || quiet) ? null : acp.createRenderer({
    color: useColor(), showThoughts: Boolean(flags.thoughts),
  });
  let collected = '';

  conn.onUpdate = (p) => {
    if (p.sessionId && p.sessionId !== sessionId) return;
    if (json) { jsonOut(p); }
    const u = p.update || {};
    if (u.sessionUpdate === 'agent_message_chunk') collected += acp.contentToText(u.content);
    if (renderer) renderer.write(u);
  };

  config.appendTranscript(conn.name, sessionId, { type: 'prompt', text });

  // The opening prompt names the conversation, the way the web UI titles it.
  // Recorded before the turn runs so a session that errors out is still
  // identifiable, and only when unset so later turns don't rename it.
  const titled = client.listSessions(config.load(), conn.name)
    .find((s) => s.sessionId === sessionId);
  if (!titled || !titled.title)
    client.rememberSession(conn.name, sessionId, { title: config.titleFrom(text) });

  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 0;
  let res;
  try {
    res = await conn.peer.request('session/prompt',
      { sessionId, prompt: acp.textPrompt(text) }, { timeoutMs });
  } catch (err) {
    config.appendTranscript(conn.name, sessionId, { type: 'error', error: err.message });
    throw err;
  }
  if (renderer) renderer.finish();

  const stopReason = (res && res.stopReason) || 'unknown';
  const reply = collected || renderer && renderer.text() || '';
  config.appendTranscript(conn.name, sessionId, { type: 'reply', text: reply });
  config.appendTranscript(conn.name, sessionId, { type: 'stop', stopReason });
  const bump = {
    turns: (client.listSessions(config.load(), conn.name)
      .find((s) => s.sessionId === sessionId) || {}).turns + 1 || 1,
  };
  // A turn that ran to the end is proof the session is live again, which
  // matters after a daemon restart demoted the record: `send` with no session
  // id picks the latest active one. A cancelled turn proves nothing -- it may
  // have been paused (via `acp/pause`) by some other client, which owns the
  // state until then.
  if (stopReason !== 'cancelled') bump.state = 'active';
  client.rememberSession(conn.name, sessionId, bump);
  return { stopReason, text: reply };
}

async function cmdSend(cfg, rest, flags) {
  const agent = rest[0];
  if (!agent) die('usage: acp send <agent> [session] <message...>');

  let words = rest.slice(1);
  // `acp send <agent> [session] <message...>`: the first word is a session id
  // only if some session actually goes by it. The registry answers for the
  // ones this machine started; the daemon is asked below for the rest.
  const maybeId = words.length > 1 ? words[0] : null;
  // A transcript counts as much as a record: it is what survives `session
  // prune`, and it is proof this id named a real conversation.
  let sessionId = maybeId && (client.isKnownSession(cfg, agent, maybeId)
    || fs.existsSync(config.transcriptPath(agent, maybeId, false))) ? maybeId : null;
  if (sessionId) words = words.slice(1);
  let message = words.join(' ').trim();
  if (!message && !process.stdin.isTTY) {
    message = fs.readFileSync(0, 'utf8').trim();
  }
  if (!message) die('nothing to send -- pass a message, or pipe one on stdin');

  const conn = await client.connectAgent(cfg, agent, {
    verbose: flags.verbose,
    onUpdate: (p) => { if (conn && conn.onUpdate) conn.onUpdate(p); },
  });
  try {
    // Still unclaimed: a session started from the web UI, or one whose record
    // was pruned, is live with nothing about it on this machine. Ask the
    // daemon before sending its id off as the first word of the message.
    if (!sessionId && maybeId && !flags.new
        && await client.daemonHasSession(conn, maybeId)) {
      sessionId = maybeId;
      message = words.slice(1).join(' ').trim();
    }
    if (!sessionId && !flags.new) {
      const latest = client.latestUsable(cfg, agent);
      if (latest) sessionId = latest.sessionId;
    }
    if (!sessionId) {
      const res = await client.newSession(conn, flags.cwd, flags.title);
      sessionId = res.sessionId;
      if (!flags.json && isTTY()) process.stderr.write(`(new session ${sessionId})\n`);
    }

    const record = cfg.sessions[config.sessionKey(agent, sessionId)] || {};
    await client.ensureLive(conn, sessionId, record.cwd || flags.cwd);

    let result;
    try {
      result = await runTurn(conn, sessionId, message, flags);
    } catch (err) {
      // A daemon that restarted has forgotten the session; ask it to reload.
      if (!/unknown session/i.test(err.message || '')) throw err;
      await conn.peer.request('acp/resume',
        { sessionId, cwd: record.cwd || conn.agentCfg.cwd }, { timeoutMs: 180000 });
      result = await runTurn(conn, sessionId, message, flags);
    }
    const { stopReason, text } = result;
    if (flags.quiet) out(text.trim());
    if (flags.json) jsonOut({ sessionId, stopReason, text });
    else if (isTTY()) process.stderr.write(`\n[${stopReason}] session ${sessionId}\n`);
    if (stopReason === 'refusal') process.exitCode = 2;
  } finally { conn.close(); }
}

// --------------------------------------------------------------------- chat

async function cmdChat(cfg, rest, flags) {
  const agent = rest[0];
  if (!agent) die('usage: acp chat <agent> [session]');
  const conn = await client.connectAgent(cfg, agent, {
    verbose: flags.verbose,
    onUpdate: (p) => { if (conn && conn.onUpdate) conn.onUpdate(p); },
  });
  try {
    let sessionId = rest[1];
    if (!sessionId) {
      const latest = flags.new ? null : client.latestUsable(cfg, agent);
      sessionId = latest ? latest.sessionId : (await client.newSession(conn, flags.cwd)).sessionId;
    }
    await client.ensureLive(conn, sessionId,
      (cfg.sessions[config.sessionKey(agent, sessionId)] || {}).cwd);
    out(`chatting with "${agent}" -- session ${sessionId}`);
    out('type a message, or /exit to leave, /new for a fresh session\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => new Promise((r) => rl.question('> ', r));
    for (;;) {
      const line = (await ask()).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/new') {
        sessionId = (await client.newSession(conn, flags.cwd)).sessionId;
        out(`new session ${sessionId}\n`);
        continue;
      }
      try {
        const { stopReason } = await runTurn(conn, sessionId, line, flags);
        if (stopReason !== 'end_turn') out(`[${stopReason}]`);
      } catch (err) {
        out(`error: ${err.message}`);
        if (conn.peer.closed) break;
      }
      out('');
    }
    rl.close();
  } finally { conn.close(); }
}

// ------------------------------------------------------------------- status

async function cmdStatus(cfg, rest, flags) {
  const agent = rest[0];
  if (!agent) {
    const info = {
      config: config.CONFIG_PATH,
      identity: cfg.identity,
      listen: `ws://${cfg.server.host}:${cfg.server.port}`,
      agents: Object.keys(cfg.agents),
      sessions: Object.keys(cfg.sessions).length,
    };
    if (flags.json) return jsonOut(info);
    out(`config    ${info.config}`);
    out(`identity  ${info.identity}`);
    out(`serve on  ${info.listen}`);
    out(`token     ${cfg.server.token ? cfg.server.token : '(none -- unauthenticated)'}`);
    out(`agents    ${info.agents.length ? info.agents.join(', ') : '(none)'}`);
    out(`sessions  ${info.sessions}`);
    return;
  }
  const conn = await client.connectAgent(cfg, agent, { verbose: flags.verbose });
  try {
    let remote = null;
    try { remote = await conn.peer.request('acp/status', {}, { timeoutMs: 15000 }); }
    catch { /* a plain stdio agent has no acp/status */ }
    const info = { agent, url: conn.agentCfg.url, reachable: true,
                   agentInfo: conn.info.agentInfo, capabilities: conn.info.agentCapabilities,
                   daemon: remote };
    if (flags.json) return jsonOut(info);
    out(`agent      ${agent}  (${conn.agentCfg.url})`);
    out(`reachable  yes`);
    if (conn.info.agentInfo) {
      out(`backend    ${conn.info.agentInfo.name} ${conn.info.agentInfo.version || ''}`.trimEnd());
    }
    if (remote) {
      out(`identity   ${remote.identity}`);
      out(`command    ${remote.agentCommand}`);
      out(`policy     permissions=${remote.permissionMode} fs=${remote.fsScope}`);
      out(`live       ${remote.sessions} session(s), ${remote.connections} connection(s)`);
    }
  } finally { conn.close(); }
}

// -------------------------------------------------------------------- serve

async function cmdServe(cfg, rest, flags) {
  if (flags.port) cfg.server.port = Number(flags.port);
  if (flags.host) cfg.server.host = flags.host;
  if (flags['agent-command']) {
    const argv = require('./transport').splitCommand(flags['agent-command']);
    cfg.server.agent = { command: argv[0], args: argv.slice(1), env: cfg.server.agent.env || {} };
  }
  if (flags.permission) cfg.server.permissionMode = flags.permission;
  if (flags['fs-scope']) cfg.server.fsScope = flags['fs-scope'];
  if (flags['no-auth']) cfg.server.token = '';

  const { Daemon } = require('./serve');
  const daemon = new Daemon(cfg, { verbose: Boolean(flags.verbose) });
  await daemon.listen();

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await daemon.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

// --------------------------------------------------------------------- help

function usage() {
  out(`acp ${VERSION} -- agent-to-agent messaging over the Agent Client Protocol

SETUP
  acp status [agent]                     show local config, or probe an agent
  acp serve [--port N] [--host H] [-v]   run the daemon other agents dial into
        [--permission allow|deny] [--fs-scope session-cwd|any] [--no-auth]
        [--agent-command "<cmd>"]

AGENTS
  acp agent add <name> <url> [cwd]       register a peer (--token, --force)
  acp agent remove <name>                unregister it (alias: rm)
  acp agent ls [--json]                  list registered peers

  url is  ws://host:port  (a remote acp serve)
      or  stdio:<command> (spawn an ACP agent locally, no daemon needed)

SESSIONS
  acp session ls [agent] [--all]        list the sessions that are live now
        [--local] [--remote]             --all: also ended  --local: registry only
                                         --remote: one daemon and nothing else
  acp session rename <agent> [s] <title> rename a session
  acp session close  <agent> [session]   end the session
  acp session log    <agent> [session]   replay the transcript (--tail N)
  acp session prune  [agent]             drop records the daemons no longer hold

  \`acp session <agent> <verb>\` also works, e.g. acp session reviewer close

TALKING
  acp send <agent> [session] <message>   one turn; streams progress live
        --new       force a fresh session
        --title "..."  name a session started by this call
        --quiet     print only the reply text
        --json      newline-delimited updates, then a final result object
        --thoughts  include the agent's reasoning
        --timeout S give up after S seconds
  acp chat <agent> [session]             interactive multi-turn session

Config: ${config.CONFIG_PATH}`);
}

// --------------------------------------------------------------------- main

async function main(argv) {
  const { flags, rest } = parseFlags(argv);
  if (flags.v) flags.verbose = true;
  const cmd = rest[0];

  if (flags.version || cmd === 'version') { out(VERSION); return; }
  if (!cmd || flags.help || cmd === 'help') { usage(); return; }

  const cfg = config.load();
  const args = rest.slice(1);

  switch (cmd) {
    case 'agent': {
      const sub = args[0];
      const a = args.slice(1);
      if (sub === 'add') return cmdAgentAdd(cfg, a, flags);
      if (sub === 'remove' || sub === 'rm') return cmdAgentRemove(cfg, a);
      if (sub === 'ls' || sub === 'list' || sub === undefined) return cmdAgentLs(cfg, a, flags);
      return die(`unknown: acp agent ${sub}`);
    }

    case 'session': {
      const VERBS = ['ls', 'list', 'close', 'log', 'prune', 'rename'];
      let sub = args[0];
      let a = args.slice(1);
      // Accept `acp session <agent> <verb>` as well as `acp session <verb> <agent>`.
      if (sub && !VERBS.includes(sub) && VERBS.includes(a[0])) {
        const agent = sub;
        sub = a[0];
        a = [agent, ...a.slice(1)];
      }
      if (sub === 'ls' || sub === 'list' || sub === undefined) return cmdSessionLs(cfg, a, flags);
      if (sub === 'log') return cmdSessionLog(cfg, a, flags);
      if (sub === 'prune') return cmdSessionPrune(cfg, a, flags);
      if (sub === 'rename') return cmdSessionRename(cfg, a, flags);
      if (sub === 'close') return cmdSessionClose(cfg, a, flags);
      return die(`unknown: acp session ${sub}`);
    }

    case 'send': return cmdSend(cfg, args, flags);
    case 'chat': return cmdChat(cfg, args, flags);
    case 'status': return cmdStatus(cfg, args, flags);
    case 'serve': return cmdServe(cfg, args, flags);
    case 'config': out(config.CONFIG_PATH); return;
    default: return die(`unknown command: ${cmd} (try \`acp help\`)`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  die(err && err.message ? err.message : String(err));
});
