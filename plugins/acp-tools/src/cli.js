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
  'cwd', 'token', 'port', 'host', 'timeout', 'tail', 'agent-command', 'permission', 'fs-scope', 'title', 'from',
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

// --------------------------------------------------------------- addresses

// A session's address is "<sessionId>@<agent>" -- the one thing that names a
// session unambiguously anywhere in the system. "new@<agent>" is not a real
// session, it means "start one here"; it only makes sense as a *to* address,
// since there is nothing to send a message *from* that does not exist yet.
function splitAddress(token) {
  const at = token.lastIndexOf('@');
  if (at === -1) return null;
  return { id: token.slice(0, at), agent: token.slice(at + 1) };
}

// Looks a bare id or title up across every session anyone knows about --
// this machine's registry, and whatever every reachable daemon actually
// holds (a session started from the web UI never touches the registry).
// Same union `cmdSessionLs` shows, so what matches here is what you'd see
// there. Errors on more than one match instead of guessing: an AI caller
// should never hit this path at all (see resolveAddress below), it exists
// for a human who would rather type a title than an id.
async function findAddress(cfg, token, flags) {
  const authority = await pollDaemons(cfg, Object.keys(cfg.agents), flags);
  const byKey = new Map();
  for (const s of client.listSessions(cfg))
    byKey.set(config.sessionKey(s.agent, s.sessionId), s);
  for (const list of authority.values()) {
    for (const s of list) {
      const key = config.sessionKey(s.agent, s.sessionId);
      byKey.set(key, Object.assign({}, byKey.get(key), s));
    }
  }

  const matches = [...byKey.values()].filter((s) => s.sessionId === token || sessionTitle(s) === token);
  if (!matches.length) die(`no session found matching "${token}" -- use an address (<id>@<agent>) or check \`acp session ls\``);
  if (matches.length > 1) {
    die(`"${token}" matches more than one session -- say which:\n` +
      matches.map((s) => `  ${s.sessionId}@${s.agent}  ${sessionTitle(s) ? `(${sessionTitle(s)})` : ''}`).join('\n'));
  }
  return { id: matches[0].sessionId, agent: matches[0].agent };
}

// Resolves an address argument. "<id>@<agent>" (or "new@<agent>") is taken
// exactly as given -- no lookup, no ambiguity possible, which is what makes
// it the only form an AI caller should ever pass (see the SESSIONS section
// of `acp help` and skills/acp/SKILL.md). Anything without an "@" goes
// through findAddress -- a convenience for a human typing an id or title.
async function resolveAddress(cfg, token, flags, { allowNew = false } = {}) {
  if (!token) return null;
  const addr = splitAddress(token) || await findAddress(cfg, token, flags);

  if (!cfg.agents[addr.agent]) {
    const known = Object.keys(cfg.agents);
    die(`unknown agent: ${addr.agent}` +
      (known.length ? ` -- registered: ${known.join(', ')}` : ' -- none registered yet, use `acp agent add`'));
  }
  if (addr.id === 'new') {
    if (!allowNew) die(`"new@${addr.agent}" only makes sense as the message's recipient, not its sender`);
    return { agent: addr.agent, sessionId: null, isNew: true };
  }
  return { agent: addr.agent, sessionId: addr.id, isNew: false };
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

// ACP delivers a prompt as plain text -- the peer has no view into `--from`,
// it is local-only bookkeeping (see runTurn's transcript entry below). A
// peer that only gets the message body has no address to reply to, which
// defeats the point of `--from` for anything but a one-off note: prepend
// email-style headers when there is a sender to name, so the reply -- an
// ordinary `acp send <from> ...` the peer runs on its own, ACP has no
// protocol-level reply routing -- has somewhere to go.
function addressedMessage(text, fromAddr, toAddr) {
  return fromAddr ? `From: ${fromAddr}\nTo: ${toAddr}\n\n${text}` : text;
}

// Runs one prompt turn. Returns { stopReason, text }. `from`, if given, is
// the sender's own resolved address ("<id>@<agent>") -- recorded on the
// transcript entry so a relayed conversation can be traced back to whoever
// sent it, same as the web UI would show it. `titleText` -- the message
// before addressedMessage() headers were added, if any -- is what a first
// turn names the session from; falls back to `text` itself when not given.
async function runTurn(conn, sessionId, text, flags, from, titleText = text) {
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

  config.appendTranscript(conn.name, sessionId, Object.assign({ type: 'prompt', text }, from ? { from } : {}));

  // The opening prompt names the conversation, the way the web UI titles it.
  // Recorded before the turn runs so a session that errors out is still
  // identifiable, and only when unset so later turns don't rename it.
  const titled = client.listSessions(config.load(), conn.name)
    .find((s) => s.sessionId === sessionId);
  if (!titled || !titled.title)
    client.rememberSession(conn.name, sessionId, { title: config.titleFrom(titleText) });

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
  const toToken = rest[0];
  if (!toToken) die('usage: acp send [--from ADDR] [--oneway] <to_session_address> <message...>');

  let message = rest.slice(1).join(' ').trim();
  if (!message && !process.stdin.isTTY) message = fs.readFileSync(0, 'utf8').trim();
  if (!message) die('nothing to send -- pass a message, or pipe one on stdin');

  // `to` may be "new@<agent>" (start a session) or an existing address; `from`
  // -- the sender's own address, mandatory for an AI caller relaying a
  // message, never required of a human -- is never "new@": there is nothing
  // to send *from* that does not exist yet.
  const to = await resolveAddress(cfg, toToken, flags, { allowNew: true });
  const from = flags.from ? await resolveAddress(cfg, flags.from, flags) : null;

  if (flags.oneway && (cfg.agents[to.agent].url || '').startsWith('stdio:'))
    die(`--oneway needs a daemon to keep the turn running after this process exits -- ` +
        `"${to.agent}" is a stdio: agent (a process per command, gone the moment this returns). ` +
        `Put it behind \`acp serve\`, or drop --oneway and wait for the reply.`);

  const conn = await client.connectAgent(cfg, to.agent, {
    verbose: flags.verbose,
    onUpdate: (p) => { if (conn && conn.onUpdate) conn.onUpdate(p); },
  });
  try {
    let sessionId = to.sessionId;
    if (to.isNew) {
      const res = await client.newSession(conn, flags.cwd, flags.title);
      sessionId = res.sessionId;
      if (!flags.json && isTTY()) process.stderr.write(`(new session ${sessionId}@${to.agent})\n`);
    }

    const record = cfg.sessions[config.sessionKey(to.agent, sessionId)] || {};
    await client.ensureLive(conn, sessionId, record.cwd || flags.cwd);

    const address = `${sessionId}@${to.agent}`;
    const fromAddr = from ? `${from.sessionId}@${from.agent}` : null;
    const wire = addressedMessage(message, fromAddr, address);

    if (flags.oneway) {
      // Fire and forget: hand the prompt to the daemon and return without
      // waiting on session/prompt's response. The write itself is synchronous
      // (see jsonrpc.js#request -> _write), so the message is genuinely on
      // its way before conn.close() below runs -- only the reply is skipped.
      // That close() always rejects this same request's promise with "local
      // close" once it lands (see jsonrpc.js#_shutdown) -- that is us hanging
      // up on purpose, not a real failure, so it is not worth recording.
      config.appendTranscript(to.agent, sessionId,
        Object.assign({ type: 'prompt', text: wire }, fromAddr ? { from: fromAddr } : {}));
      const titled = client.listSessions(config.load(), to.agent).find((s) => s.sessionId === sessionId);
      if (!titled || !titled.title) client.rememberSession(to.agent, sessionId, { title: config.titleFrom(message) });
      conn.peer.request('session/prompt', { sessionId, prompt: acp.textPrompt(wire) }, { timeoutMs: 0 }).catch(() => {});
      if (flags.json) jsonOut({ sessionId: address, sent: true });
      else if (isTTY()) process.stderr.write(`sent to ${address}\n`);
      return;
    }

    let result;
    try {
      result = await runTurn(conn, sessionId, wire, flags, fromAddr, message);
    } catch (err) {
      // A daemon that restarted has forgotten the session; ask it to reload.
      if (!/unknown session/i.test(err.message || '')) throw err;
      await conn.peer.request('acp/resume',
        { sessionId, cwd: record.cwd || conn.agentCfg.cwd }, { timeoutMs: 180000 });
      result = await runTurn(conn, sessionId, wire, flags, fromAddr, message);
    }
    const { stopReason, text } = result;
    if (flags.quiet) out(text.trim());
    if (flags.json) jsonOut({ sessionId: address, stopReason, text });
    else if (isTTY()) process.stderr.write(`\n[${stopReason}] session ${address}\n`);
    if (stopReason === 'refusal') process.exitCode = 2;
  } finally { conn.close(); }
}

// --------------------------------------------------------------------- chat

async function cmdChat(cfg, rest, flags) {
  const toToken = rest[0];
  if (!toToken) die('usage: acp chat [--from ADDR] <to_session_address>');
  const to = await resolveAddress(cfg, toToken, flags, { allowNew: true });
  const from = flags.from ? await resolveAddress(cfg, flags.from, flags) : null;

  const conn = await client.connectAgent(cfg, to.agent, {
    verbose: flags.verbose,
    onUpdate: (p) => { if (conn && conn.onUpdate) conn.onUpdate(p); },
  });
  try {
    let sessionId = to.isNew ? (await client.newSession(conn, flags.cwd)).sessionId : to.sessionId;
    await client.ensureLive(conn, sessionId,
      (cfg.sessions[config.sessionKey(to.agent, sessionId)] || {}).cwd);
    out(`chatting with "${to.agent}" -- session ${sessionId}@${to.agent}` +
        (from ? ` (as ${from.sessionId}@${from.agent})` : ''));
    out('type a message, or /exit to leave, /new for a fresh session\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => new Promise((r) => rl.question('> ', r));
    for (;;) {
      const line = (await ask()).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/new') {
        sessionId = (await client.newSession(conn, flags.cwd)).sessionId;
        out(`new session ${sessionId}@${to.agent}\n`);
        continue;
      }
      try {
        const fromAddr = from ? `${from.sessionId}@${from.agent}` : null;
        const wire = addressedMessage(line, fromAddr, `${sessionId}@${to.agent}`);
        const { stopReason } = await runTurn(conn, sessionId, wire, flags, fromAddr, line);
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

ADDRESSES
  Every session has an address: <session id>@<agent> -- e.g. sess_1@reviewer.
  new@<agent> means "start a session here" (a *to* address only -- there is
  nothing to send *from* that doesn't exist yet). Anywhere an address is
  taken, a bare id or title works too: it is looked up across every known
  session and resolved for you, erroring if more than one matches. An id@agent
  or new@agent needs no lookup and cannot be ambiguous -- the only form an AI
  caller relaying a message should ever pass.

TALKING
  acp send [--from ADDR] [--oneway] <to_address> <message>
        --from ADDR    sender's own address -- omit as a human; an AI
                       relaying a message must always give one
        --oneway       hand it off and return -- do not wait for a reply
                       (needs a ws:// daemon; not for a stdio: agent)
        --title "..."  name a session started by this call (i.e. new@<agent>)
        --quiet        print only the reply text
        --json         newline-delimited updates, then a final result object
        --thoughts     include the agent's reasoning
        --timeout S    give up after S seconds
  acp chat [--from ADDR] <to_address>    interactive multi-turn session
        (same --quiet/--json/--thoughts/--timeout, applied per turn)

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
