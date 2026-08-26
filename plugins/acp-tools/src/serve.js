'use strict';
// `acp serve` -- an ACP *proxy*.
//
//   ws client  <--ACP--> [ daemon ] <--ACP--> agent subprocess (stdio)
//              (we are             (we are the client:
//               the agent)          fs + permissions land here)
//
// The daemon runs on the machine that owns the repo, so file access and
// permission prompts are answered locally instead of tunneled to the caller.
// session/update notifications are streamed back out to whoever is listening.

const fsp = require('node:fs');
const path = require('node:path');
const ws = require('./ws');
const acp = require('./acp');
const transport = require('./transport');
const { Peer, RpcError, ERR } = require('./jsonrpc');
const config = require('./config');

const now = () => new Date().toISOString();

class Daemon {
  constructor(cfg, { verbose = false } = {}) {
    this.cfg = cfg;
    this.server = cfg.server;
    this.verbose = verbose;
    this.agents = new Map();    // cwd -> { peer, channel, info, refs, idleTimer }
    this.sessions = new Map();  // sessionId -> { cwd, state, createdAt, turns, owners:Set }
    this.conns = new Set();
    this.startedAt = now();
  }

  log(...a) { console.error(`[acp ${new Date().toISOString().slice(11, 19)}]`, ...a); }
  vlog(...a) { if (this.verbose) this.log(...a); }

  // ------------------------------------------------------- agent subprocess

  async agentFor(cwd) {
    const key = path.resolve(cwd);
    let entry = this.agents.get(key);
    if (entry) {
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      return entry.ready;
    }
    if (!fsp.existsSync(key)) {
      throw new RpcError(ERR.INVALID_PARAMS, `cwd does not exist on the agent host: ${key}`);
    }

    const spec = this.server.agent;
    const argv = [spec.command].concat(spec.args || []);
    this.log(`spawning agent for ${key}: ${argv.join(' ')}`);

    const channel = transport.openStdioArgv(argv, {
      cwd: key,
      env: spec.env,
      onStderr: (d) => this.vlog(`agent[${path.basename(key)}] ${String(d).trimEnd()}`),
    });

    entry = { channel, cwd: key, refs: 0, idleTimer: null };
    this.agents.set(key, entry);

    const peer = new Peer(channel, {
      name: `agent(${path.basename(key)})`,
      onError: (err) => this.vlog('agent handler error:', err.message),
    });
    entry.peer = peer;

    // Agent -> us. These terminate here, on the repo's own machine.
    acp.installFsHandlers(peer, {
      fsScope: this.server.fsScope,
      scopeFor: (sessionId) => {
        const s = this.sessions.get(sessionId);
        return [s ? s.cwd : key].concat(s && s.extraDirs ? s.extraDirs : []);
      },
    });
    peer.handle('session/request_permission', (p) => {
      const decision = acp.decidePermission(p, this.server.permissionMode);
      const tool = (p.toolCall && (p.toolCall.title || p.toolCall.kind)) || 'tool call';
      this.vlog(`permission [${this.server.permissionMode}] ${tool}`);
      this.record(p.sessionId, { type: 'permission', tool, mode: this.server.permissionMode });
      return decision;
    });
    peer.handle('session/update', (p) => { this.fanout(p); });

    channel.onClose((reason) => {
      this.log(`agent for ${key} closed: ${reason}`);
      this.agents.delete(key);
      for (const [id, s] of this.sessions) {
        if (s.cwd === key && s.state !== 'closed') s.state = 'stale';
      }
    });

    entry.ready = (async () => {
      const info = await acp.initialize(peer, { clientName: 'acp-daemon' });
      entry.info = info;
      this.vlog(`agent ready for ${key}:`, JSON.stringify(info.agentInfo || {}));
      return entry;
    })();

    try {
      return await entry.ready;
    } catch (err) {
      this.agents.delete(key);
      try { channel.close(); } catch { /* gone */ }
      throw new RpcError(ERR.INTERNAL, `failed to start agent for ${key}: ${err.message}`);
    }
  }

  releaseAgent(cwd) {
    const entry = this.agents.get(path.resolve(cwd));
    if (!entry) return;
    const live = [...this.sessions.values()]
      .filter((s) => s.cwd === entry.cwd && (s.state === 'active' || s.state === 'paused'));
    if (live.length) return;
    const ms = this.server.idleTimeoutMs;
    if (!ms || ms <= 0) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      this.log(`agent for ${entry.cwd} idle for ${ms}ms, shutting down`);
      try { entry.channel.close(); } catch { /* gone */ }
      this.agents.delete(entry.cwd);
    }, ms);
    if (entry.idleTimer.unref) entry.idleTimer.unref();
  }

  // ------------------------------------------------------------ bookkeeping

  record(sessionId, entry) {
    if (!sessionId) return;
    config.appendTranscript('_daemon', sessionId, entry);
  }

  fanout(params) {
    const s = this.sessions.get(params.sessionId);
    this.record(params.sessionId, { type: 'update', update: params.update });
    if (!s) return;
    for (const peer of s.owners) {
      if (!peer.closed) peer.notify('session/update', params);
    }
  }

  mustSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new RpcError(ERR.INVALID_PARAMS, `unknown session: ${sessionId}`);
    return s;
  }

  // -------------------------------------------------------- ws connections

  onConnection(sock, req) {
    const who = req.socket.remoteAddress;
    this.vlog(`client connected from ${who}`);
    const handlers = { message: [], close: [] };
    sock.on('message', (m) => { for (const h of handlers.message) h(m); });
    sock.on('error', (err) => this.vlog(`client socket error: ${err.message}`));
    sock.on('close', () => { for (const h of handlers.close) h('socket closed'); });

    const channel = {
      send: (line) => sock.send(line),
      onMessage: (cb) => handlers.message.push(cb),
      onClose: (cb) => handlers.close.push(cb),
      close: () => sock.close(1000, 'daemon closing'),
    };

    const peer = new Peer(channel, {
      name: 'client',
      onError: (err) => this.vlog('client handler error:', err.message),
    });
    this.conns.add(peer);
    handlers.close.push(() => {
      this.conns.delete(peer);
      for (const s of this.sessions.values()) s.owners.delete(peer);
      this.vlog(`client from ${who} disconnected`);
    });

    this.installAgentSide(peer);
  }

  // We answer these as if we were an ACP agent.
  installAgentSide(peer) {
    peer.handle('initialize', () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'acp-daemon', version: '1.0.0' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      authMethods: [],
    }));

    peer.handle('session/new', async (p) => {
      const cwd = p.cwd || process.cwd();
      const entry = await this.agentFor(cwd);
      const res = await entry.peer.request('session/new', {
        cwd: path.resolve(cwd),
        mcpServers: p.mcpServers || [],
        additionalDirectories: p.additionalDirectories,
      }, { timeoutMs: 120000 });

      const sessionId = res && res.sessionId;
      if (!sessionId) throw new RpcError(ERR.INTERNAL, 'agent returned no sessionId');
      this.sessions.set(sessionId, {
        sessionId, cwd: path.resolve(cwd), state: 'active',
        createdAt: now(), updatedAt: now(), turns: 0,
        extraDirs: p.additionalDirectories || [], owners: new Set([peer]),
      });
      this.log(`session ${sessionId} created in ${cwd}`);
      return res;
    });

    peer.handle('session/prompt', async (p) => {
      const s = this.mustSession(p.sessionId);
      if (s.state === 'paused') {
        throw new RpcError(ERR.INVALID_PARAMS,
          `session ${p.sessionId} is paused -- resume it before prompting`);
      }
      if (s.state === 'closed') {
        throw new RpcError(ERR.INVALID_PARAMS, `session ${p.sessionId} is closed`);
      }
      const entry = await this.agentFor(s.cwd);
      s.owners.add(peer);
      s.state = 'active';
      s.turns += 1;
      s.updatedAt = now();
      this.record(p.sessionId, { type: 'prompt', prompt: acp.contentToText(p.prompt) });

      // A prompt turn can run for a long time; no client-side timeout.
      const res = await entry.peer.request('session/prompt',
        { sessionId: p.sessionId, prompt: p.prompt });
      s.updatedAt = now();
      this.record(p.sessionId, { type: 'stop', stopReason: res && res.stopReason });
      return res;
    });

    peer.handle('session/cancel', async (p) => {
      const s = this.sessions.get(p.sessionId);
      if (!s) return null;
      const entry = this.agents.get(s.cwd);
      if (entry) entry.peer.notify('session/cancel', { sessionId: p.sessionId });
      return null;
    });

    // pause = cancel the running turn and refuse new prompts until resumed.
    peer.handle('acp/pause', async (p) => {
      const s = this.mustSession(p.sessionId);
      const entry = this.agents.get(s.cwd);
      if (entry) entry.peer.notify('session/cancel', { sessionId: p.sessionId });
      s.state = 'paused';
      s.updatedAt = now();
      this.log(`session ${p.sessionId} paused`);
      return { sessionId: p.sessionId, state: s.state };
    });

    peer.handle('acp/resume', async (p) => {
      let s = this.sessions.get(p.sessionId);
      const cwd = (s && s.cwd) || p.cwd;
      if (!cwd) {
        throw new RpcError(ERR.INVALID_PARAMS,
          `unknown session ${p.sessionId} -- pass cwd so it can be reloaded`);
      }
      const entry = await this.agentFor(cwd);

      // If the agent lost the session (daemon or agent restarted), reload it.
      const needsReload = !s || s.state === 'stale';
      if (needsReload) {
        const caps = (entry.info && entry.info.agentCapabilities) || {};
        if (!caps.loadSession) {
          throw new RpcError(ERR.INTERNAL,
            `agent cannot reload sessions (loadSession not supported); start a new one`);
        }
        await entry.peer.request('session/load', {
          sessionId: p.sessionId, cwd: path.resolve(cwd), mcpServers: p.mcpServers || [],
        }, { timeoutMs: 120000 });
        this.log(`session ${p.sessionId} reloaded from ${cwd}`);
      }
      if (!s) {
        s = { sessionId: p.sessionId, cwd: path.resolve(cwd), createdAt: now(),
              turns: 0, extraDirs: [], owners: new Set() };
        this.sessions.set(p.sessionId, s);
      }
      s.owners.add(peer);
      s.state = 'active';
      s.updatedAt = now();
      return { sessionId: p.sessionId, state: s.state, reloaded: needsReload };
    });

    peer.handle('session/close', async (p) => this.closeSession(p.sessionId, false));
    peer.handle('session/delete', async (p) => this.closeSession(p.sessionId, true));

    peer.handle('session/set_mode', async (p) => {
      const s = this.mustSession(p.sessionId);
      const entry = await this.agentFor(s.cwd);
      return entry.peer.request('session/set_mode', p, { timeoutMs: 30000 });
    });

    // Answered from our own registry: it is the only place that knows the
    // pause/turn bookkeeping, and not every agent implements session/list.
    peer.handle('session/list', async (p) => {
      const wanted = p && p.cwd ? path.resolve(p.cwd) : null;
      const sessions = [...this.sessions.values()]
        .filter((s) => !wanted || s.cwd === wanted)
        .map((s) => ({
          sessionId: s.sessionId, cwd: s.cwd, state: s.state,
          createdAt: s.createdAt, updatedAt: s.updatedAt, turns: s.turns,
        }));
      return { sessions, nextCursor: null };
    });

    peer.handle('acp/status', () => ({
      identity: this.cfg.identity,
      startedAt: this.startedAt,
      agentCommand: [this.server.agent.command].concat(this.server.agent.args || []).join(' '),
      permissionMode: this.server.permissionMode,
      fsScope: this.server.fsScope,
      liveAgents: [...this.agents.keys()],
      connections: this.conns.size,
      sessions: this.sessions.size,
    }));
  }

  async closeSession(sessionId, forget) {
    const s = this.sessions.get(sessionId);
    if (!s) return { sessionId, state: 'unknown' };
    const entry = this.agents.get(s.cwd);
    if (entry) {
      // Best effort: many agents don't implement these yet.
      try {
        await entry.peer.request(forget ? 'session/delete' : 'session/close',
          { sessionId }, { timeoutMs: 15000 });
      } catch (err) {
        this.vlog(`agent did not handle session close (${err.message})`);
      }
    }
    s.state = 'closed';
    s.updatedAt = now();
    s.owners.clear();
    if (forget) this.sessions.delete(sessionId);
    this.log(`session ${sessionId} ${forget ? 'deleted' : 'closed'}`);
    this.releaseAgent(s.cwd);
    return { sessionId, state: forget ? 'deleted' : 'closed' };
  }

  // ------------------------------------------------------------------ start

  listen() {
    const token = this.server.token;
    const server = ws.createServer({
      verify: (req) => {
        if (!token) return null;
        const auth = req.headers['authorization'] || '';
        const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const a = Buffer.from(given);
        const b = Buffer.from(token);
        const ok = a.length === b.length && require('node:crypto').timingSafeEqual(a, b);
        if (!ok) {
          this.log(`rejected unauthenticated connection from ${req.socket.remoteAddress}`);
          return '401 Unauthorized';
        }
        return null;
      },
    });
    server.on('ws', (sock, req) => this.onConnection(sock, req));
    this.httpServer = server;

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.server.port, this.server.host, () => {
        const addr = server.address();
        this.log(`listening on ws://${this.server.host}:${addr.port} as "${this.cfg.identity}"`);
        this.log(`agent command: ${[this.server.agent.command].concat(this.server.agent.args || []).join(' ')}`);
        this.log(`permissions: ${this.server.permissionMode}   fs scope: ${this.server.fsScope}`);
        if (this.server.host !== '127.0.0.1' && this.server.host !== 'localhost') {
          this.log(`WARNING: bound to ${this.server.host} -- reachable off this machine, token auth is the only guard`);
        }
        if (!token) this.log('WARNING: no token set, every connection is trusted');
        resolve(server);
      });
    });
  }

  async shutdown() {
    this.log('shutting down');
    for (const peer of this.conns) { try { peer.close(); } catch { /* gone */ } }
    for (const entry of this.agents.values()) { try { entry.channel.close(); } catch { /* gone */ } }
    if (this.httpServer) await new Promise((r) => this.httpServer.close(r));
  }
}

module.exports = { Daemon };
