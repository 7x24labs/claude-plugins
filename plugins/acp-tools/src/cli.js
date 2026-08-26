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
  'cwd', 'token', 'port', 'host', 'timeout', 'tail', 'agent-command', 'permission', 'fs-scope',
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

function cmdAgentLs(cfg, rest, flags) {
  const names = Object.keys(cfg.agents).sort();
  if (flags.json) return jsonOut(cfg.agents);
  if (!names.length) {
    out('no agents registered');
    out('  acp agent add <name> <ws://host:port | stdio:command> [cwd]');
    return;
  }
  table(names.map((n) => {
    const a = cfg.agents[n];
    const live = client.listSessions(cfg, n).filter((s) => s.state === 'active').length;
    return [n, a.url, a.cwd, live || '-'];
  }), ['NAME', 'URL', 'CWD', 'ACTIVE']);
}

// ------------------------------------------------------------------ session

async function cmdSessionLs(cfg, rest, flags) {
  const agent = rest[0];
  if (agent && !cfg.agents[agent]) die(`unknown agent: ${agent}`);

  // Without --remote this is answered from the local registry: no network,
  // and it still works when a daemon is down.
  if (!flags.remote) {
    const rows = client.listSessions(cfg, agent);
    if (flags.json) return jsonOut(rows);
    if (!rows.length) {
      out(agent ? `no sessions for "${agent}"` : 'no sessions');
      return;
    }
    return table(rows.map((s) => [s.agent, s.sessionId, s.state, s.turns || 0, s.cwd || '-', ago(s.updatedAt)]),
      ['AGENT', 'SESSION', 'STATE', 'TURNS', 'CWD', 'UPDATED']);
  }

  if (!agent) die('--remote needs an agent: acp session ls <agent> --remote');
  const conn = await client.connectAgent(cfg, agent, { verbose: flags.verbose });
  try {
    const res = await conn.peer.request('session/list', {}, { timeoutMs: 30000 });
    const rows = (res && res.sessions) || [];
    if (flags.json) return jsonOut(rows);
    if (!rows.length) return out(`no live sessions on "${agent}"`);
    table(rows.map((s) => [s.sessionId, s.state || '-', s.turns === undefined ? '-' : s.turns,
      s.cwd || '-', ago(s.updatedAt)]), ['SESSION', 'STATE', 'TURNS', 'CWD', 'UPDATED']);
  } finally { conn.close(); }
}

async function cmdSessionNew(cfg, rest, flags) {
  const agent = rest[0];
  if (!agent) die('usage: acp session new <agent> [--cwd DIR]');
  const conn = await client.connectAgent(cfg, agent, { verbose: flags.verbose });
  try {
    const res = await client.newSession(conn, flags.cwd);
    if (flags.json) return jsonOut(res);
    out(res.sessionId);
    if (isTTY()) {
      process.stderr.write(`new session on "${agent}" in ${path.resolve(flags.cwd || conn.agentCfg.cwd)}\n`);
      process.stderr.write(`  acp send ${agent} ${res.sessionId} "your first message"\n`);
    }
  } finally { conn.close(); }
}

// close | pause | resume | rm
async function cmdSessionState(cfg, action, rest, flags) {
  const agent = rest[0];
  let sessionId = rest[1];
  if (!agent) die(`usage: acp session ${action} <agent> [session]`);
  if (!sessionId) {
    const latest = client.listSessions(cfg, agent)[0];
    if (!latest) die(`no known sessions for "${agent}"`);
    sessionId = latest.sessionId;
  }

  const method = { close: 'session/close', rm: 'session/delete',
                   pause: 'acp/pause', resume: 'acp/resume' }[action];
  const record = cfg.sessions[config.sessionKey(agent, sessionId)] || {};
  const newState = { close: 'closed', pause: 'paused', resume: 'active', rm: null }[action];

  // A stdio agent holds no state between commands, so there is nothing to
  // reach: the local record is the whole truth.
  if ((cfg.agents[agent].url || '').startsWith('stdio:')) {
    if (action === 'rm') client.forgetSession(agent, sessionId);
    else client.rememberSession(agent, sessionId, { state: newState });
    if (flags.json) return jsonOut({ sessionId, action, state: newState, local: true });
    return out(`session ${sessionId} on "${agent}" marked ${newState || 'deleted'} (local record)`);
  }
  const conn = await client.connectAgent(cfg, agent, { verbose: flags.verbose });
  try {
    const params = { sessionId };
    if (action === 'resume') params.cwd = record.cwd || cfg.agents[agent].cwd;
    const res = await conn.peer.request(method, params, { timeoutMs: 120000 });

    if (action === 'rm') client.forgetSession(agent, sessionId);
    else client.rememberSession(agent, sessionId, { state: newState });

    if (flags.json) return jsonOut(Object.assign({ sessionId, action }, res || {}));
    const verb = { close: 'closed', pause: 'paused', resume: 'resumed', rm: 'deleted' }[action];
    out(`session ${sessionId} on "${agent}" ${verb}` +
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
  client.rememberSession(conn.name, sessionId, {
    turns: (client.listSessions(config.load(), conn.name)
      .find((s) => s.sessionId === sessionId) || {}).turns + 1 || 1,
  });
  return { stopReason, text: reply };
}

async function cmdSend(cfg, rest, flags) {
  const agent = rest[0];
  if (!agent) die('usage: acp send <agent> [session] <message...>');

  let sessionId = null;
  let words = rest.slice(1);
  if (words.length > 1 && client.isKnownSession(cfg, agent, words[0])) {
    sessionId = words[0];
    words = words.slice(1);
  }
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
    if (!sessionId && !flags.new) {
      const latest = client.latestUsable(cfg, agent);
      if (latest) sessionId = latest.sessionId;
    }
    if (!sessionId) {
      const res = await client.newSession(conn, flags.cwd);
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
  acp session ls [agent] [--remote]      list sessions (local registry by default)
  acp session new <agent> [--cwd DIR]    start one, prints the session id
  acp session pause  <agent> [session]   cancel the running turn, refuse new ones
  acp session resume <agent> [session]   allow prompts again (reloads if needed)
  acp session close  <agent> [session]   end the session
  acp session rm     <agent> [session]   end it and drop the local record
  acp session log    <agent> [session]   replay the transcript (--tail N)

  \`acp session <agent> <verb>\` also works, e.g. acp session reviewer new

TALKING
  acp send <agent> [session] <message>   one turn; streams progress live
        --new       force a fresh session
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
      const VERBS = ['ls', 'list', 'new', 'close', 'pause', 'resume', 'rm', 'delete', 'log'];
      let sub = args[0];
      let a = args.slice(1);
      // Accept `acp session <agent> <verb>` as well as `acp session <verb> <agent>`.
      if (sub && !VERBS.includes(sub) && VERBS.includes(a[0])) {
        const agent = sub;
        sub = a[0];
        a = [agent, ...a.slice(1)];
      }
      if (sub === 'ls' || sub === 'list' || sub === undefined) return cmdSessionLs(cfg, a, flags);
      if (sub === 'new') return cmdSessionNew(cfg, a, flags);
      if (sub === 'log') return cmdSessionLog(cfg, a, flags);
      if (['close', 'pause', 'resume'].includes(sub)) return cmdSessionState(cfg, sub, a, flags);
      if (sub === 'rm' || sub === 'delete') return cmdSessionState(cfg, 'rm', a, flags);
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
