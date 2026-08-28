'use strict';
// Client side: open a registered agent, run the ACP handshake, keep the
// session registry in the config file up to date.

const path = require('node:path');
const acp = require('./acp');
const transport = require('./transport');
const { Peer } = require('./jsonrpc');
const config = require('./config');

function lookupAgent(cfg, name) {
  const a = cfg.agents[name];
  if (!a) {
    const known = Object.keys(cfg.agents);
    throw new Error(`unknown agent: ${name}` +
      (known.length ? ` -- registered: ${known.join(', ')}` : ' -- none registered yet, use `acp agent add`'));
  }
  return a;
}

// onUpdate(updateParams) receives forwarded session/update notifications.
async function connectAgent(cfg, name, { onUpdate, verbose = false, timeoutMs } = {}) {
  const agentCfg = lookupAgent(cfg, name);
  let channel;
  try {
    channel = await transport.open(agentCfg, {
      timeoutMs,
      onStderr: (d) => { if (verbose) process.stderr.write(`[${name}] ${d}`); },
    });
  } catch (err) {
    const hint =
      err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(err.message)
        ? ` -- nothing is listening there. Start the daemon on that host with \`acp serve\`.`
        : /401/.test(err.message)
          ? ` -- the daemon rejected the token. Check \`acp agent add ${name} ... --token\` against its config.json.`
          : /ENOTFOUND|EAI_AGAIN/.test(err.message)
            ? ` -- host not found; check the url.`
            : '';
    throw new Error(`cannot reach agent "${name}" at ${agentCfg.url}: ${err.message}${hint}`);
  }

  let closedReason = null;
  channel.onClose((r) => { closedReason = r; });

  const peer = new Peer(channel, {
    name,
    onError: (err) => { if (verbose) process.stderr.write(`[${name}] ${err.message}\n`); },
  });

  peer.handle('session/update', (p) => { if (onUpdate) onUpdate(p); });

  // Only reached when talking straight to a stdio agent -- against a daemon
  // these terminate on the far side, next to the repo.
  acp.installFsHandlers(peer, {
    fsScope: agentCfg.fsScope || 'session-cwd',
    scopeFor: () => [agentCfg.cwd || process.cwd()],
  });
  peer.handle('session/request_permission', (p) =>
    acp.decidePermission(p, agentCfg.permissionMode || 'allow'));

  const info = await acp.initialize(peer, { clientName: 'acp-cli' });

  return {
    name, peer, channel, info, agentCfg,
    get closedReason() { return closedReason; },
    close() { try { peer.close(); } catch { /* gone */ } },
  };
}

// ------------------------------------------------- local session bookkeeping

function rememberSession(agent, sessionId, fields) {
  config.update((cfg) => {
    const key = config.sessionKey(agent, sessionId);
    const prev = cfg.sessions[key] || {};
    cfg.sessions[key] = Object.assign({
      agent, sessionId, state: 'active',
      createdAt: new Date().toISOString(), turns: 0,
    }, prev, fields, { updatedAt: new Date().toISOString() });
  });
}

function forgetSession(agent, sessionId) {
  config.update((cfg) => { delete cfg.sessions[config.sessionKey(agent, sessionId)]; });
}

const pad2 = (n) => String(n).padStart(2, '0');

// `<agent>-<yyyy.MM.dd HH:mm:ss>`, local time -- what a session is called when nobody names it.
// Matches the UI's own default (see acp-ui's helpers/sessionTitle.ts) so a conversation started
// from either side reads the same way in `acp session ls` and the Sidebar.
function defaultTitle(agent) {
  const d = new Date();
  const date = `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${agent}-${date} ${time}`;
}

function listSessions(cfg, agent) {
  return Object.values(cfg.sessions)
    .filter((s) => !agent || s.agent === agent)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// Most recently used session that can still take a prompt.
function latestUsable(cfg, agent) {
  return listSessions(cfg, agent).find((s) => s.state === 'active') || null;
}

function isKnownSession(cfg, agent, id) {
  return Boolean(cfg.sessions[config.sessionKey(agent, id)]);
}

// Whether the daemon on the far side is holding that session right now. The
// registry is only half of what exists -- a session started from the web UI
// never touches it -- so this is how the other half gets recognised. Best
// effort: a stdio agent has no daemon, and a refusal simply means "no".
async function daemonHasSession(conn, sessionId) {
  if (conn.channel.kind !== 'ws') return false;
  try {
    const res = await conn.peer.request('session/list', {}, { timeoutMs: 5000 });
    return ((res && res.sessions) || []).some((s) => s.sessionId === sessionId);
  } catch {
    return false;
  }
}

// A `stdio:` agent is a fresh process per CLI invocation, so a session made by
// an earlier command is not in its memory. ACP's session/load restores it.
// A ws:// daemon keeps sessions live, so nothing is needed there.
async function ensureLive(conn, sessionId, cwd) {
  if (!conn._loaded) conn._loaded = new Set();
  if (conn._loaded.has(sessionId)) return;
  conn._loaded.add(sessionId);
  if (conn.channel.kind !== 'stdio') return;

  const caps = conn.info.agentCapabilities || {};
  if (!caps.loadSession) {
    throw new Error(
      `agent "${conn.name}" does not support session/load, so a session cannot ` +
      `outlive one command. Use \`acp chat ${conn.name}\` for multi-turn, or put ` +
      `it behind a ws:// daemon (acp serve) which keeps sessions in memory.`);
  }
  await conn.peer.request('session/load', {
    sessionId, cwd: path.resolve(cwd || conn.agentCfg.cwd || process.cwd()), mcpServers: [],
  }, { timeoutMs: 180000 });
}

// A session always gets a name at creation -- `title` if given, else the
// `<agent>-<timestamp>` default -- rather than waiting on the first prompt to
// name it. It goes to the agent as `_meta.title` (ACP's own extension point,
// so a real agent that has never heard of the convention just ignores it);
// our own daemon (serve.js) picks it up and holds onto it, so a rename is the
// only thing that ever changes it after this.
async function newSession(conn, cwd, title) {
  const dir = path.resolve(cwd || conn.agentCfg.cwd || process.cwd());
  const name = config.titleFrom(title) || defaultTitle(conn.name);
  const res = await conn.peer.request('session/new',
    { cwd: dir, mcpServers: [], _meta: { title: name } }, { timeoutMs: 180000 });
  if (!res || !res.sessionId) throw new Error(`${conn.name}: agent returned no sessionId`);
  rememberSession(conn.name, res.sessionId, { cwd: dir, state: 'active', title: name });
  if (!conn._loaded) conn._loaded = new Set();
  conn._loaded.add(res.sessionId);   // freshly created: already live
  return res;
}

// Renames a session -- our own convention layered on top of ACP, which has no
// client-writable session name (see serve.js#session/set_title). A `ws://`
// agent is always our own daemon, so the request is always understood; a
// `stdio:` agent is a bare process with no daemon behind it, so the rename can
// only ever be local bookkeeping, same as any other session state on that
// transport (see cmdSessionClose in cli.js).
async function renameSession(cfg, conn, agent, sessionId, title) {
  const name = config.titleFrom(title);
  if (!name) throw new Error('title must not be empty');
  const isStdio = (cfg.agents[agent].url || '').startsWith('stdio:');
  if (!isStdio) {
    await conn.peer.request('session/set_title', { sessionId, title: name }, { timeoutMs: 15000 });
  }
  rememberSession(agent, sessionId, { title: name });
  return { title: name, local: isStdio };
}

module.exports = {
  lookupAgent, connectAgent, rememberSession, forgetSession,
  listSessions, latestUsable, isKnownSession, daemonHasSession, newSession, renameSession, ensureLive,
};
