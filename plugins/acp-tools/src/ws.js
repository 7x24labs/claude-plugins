'use strict';
// Minimal RFC 6455 WebSocket client + server. No dependencies.
// Upgraded sockets are emitted as 'ws' (not 'connection', which Node's http
// server reserves for its own socket bookkeeping).
// Text frames only (ACP is newline-delimited JSON); binary frames are decoded
// as UTF-8 too so a peer using opcode 2 still works.

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B39F';
const MAX_MESSAGE = 64 * 1024 * 1024;

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// ---------------------------------------------------------------- byte queue

class ByteQueue {
  constructor() { this.chunks = []; this.length = 0; }
  push(b) { if (b.length) { this.chunks.push(b); this.length += b.length; } }
  peek(n) {
    if (this.length < n) return null;
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let o = 0;
    for (const c of this.chunks) {
      const t = Math.min(n - o, c.length);
      c.copy(out, o, 0, t);
      o += t;
      if (o === n) break;
    }
    return out;
  }
  take(n) {
    const out = Buffer.allocUnsafe(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0];
      const t = Math.min(n - o, c.length);
      c.copy(out, o, 0, t);
      o += t;
      if (t === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(t);
    }
    this.length -= n;
    return out;
  }
}

// ------------------------------------------------------------------- framing

function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  let hdr = 2;
  if (len >= 65536) hdr += 8;
  else if (len > 125) hdr += 2;
  if (mask) hdr += 4;

  const buf = Buffer.allocUnsafe(hdr + len);
  buf[0] = 0x80 | opcode;
  let p = 2;
  if (len >= 65536) {
    buf[1] = 127;
    buf.writeUInt32BE(Math.floor(len / 4294967296), 2);
    buf.writeUInt32BE(len >>> 0, 6);
    p = 10;
  } else if (len > 125) {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
    p = 4;
  } else {
    buf[1] = len;
  }
  if (mask) {
    buf[1] |= 0x80;
    const key = crypto.randomBytes(4);
    key.copy(buf, p);
    p += 4;
    for (let i = 0; i < len; i++) buf[p + i] = payload[i] ^ key[i & 3];
  } else {
    payload.copy(buf, p);
  }
  return buf;
}

// ------------------------------------------------------------------- socket

class WsSocket extends EventEmitter {
  constructor(socket, isClient, opts = {}) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.maxMessage = opts.maxMessage || MAX_MESSAGE;
    this.closed = false;
    this._q = new ByteQueue();
    this._frag = null;      // { opcode, parts:[], size }
    this._sentClose = false;
    this._alive = true;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._done());

    const every = opts.heartbeatMs === undefined ? 30000 : opts.heartbeatMs;
    if (every > 0) {
      this._hb = setInterval(() => {
        if (!this._alive) return this.terminate(new Error('websocket heartbeat timeout'));
        this._alive = false;
        try { this._frame(OP.PING, Buffer.alloc(0)); } catch { /* closing */ }
      }, every);
      if (this._hb.unref) this._hb.unref();
    }
  }

  _onData(chunk) {
    this._q.push(chunk);
    try {
      for (;;) {
        const f = this._readFrame();
        if (!f) break;
        this._onFrame(f);
      }
    } catch (err) {
      this._fail(err);
    }
  }

  _readFrame() {
    const h = this._q.peek(2);
    if (!h) return null;
    if (h[0] & 0x70) throw new Error('reserved bits set');
    const fin = (h[0] & 0x80) !== 0;
    const opcode = h[0] & 0x0f;
    const masked = (h[1] & 0x80) !== 0;
    let len = h[1] & 0x7f;
    let hdr = 2;

    if (len === 126) {
      const e = this._q.peek(4);
      if (!e) return null;
      len = e.readUInt16BE(2);
      hdr = 4;
    } else if (len === 127) {
      const e = this._q.peek(10);
      if (!e) return null;
      const hi = e.readUInt32BE(2);
      if (hi > 0x1fffff) throw new Error('frame too large');
      len = hi * 4294967296 + e.readUInt32BE(6);
      hdr = 10;
    }
    if (opcode >= 0x8 && (!fin || len > 125)) throw new Error('bad control frame');
    if (len > this.maxMessage) throw new Error('frame exceeds max message size');
    if (masked) hdr += 4;
    if (this._q.length < hdr + len) return null;

    const head = this._q.take(hdr);
    const payload = this._q.take(len);
    if (masked) {
      const key = head.subarray(hdr - 4, hdr);
      for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
    }
    return { fin, opcode, payload };
  }

  _onFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.PING:
        this._frame(OP.PONG, payload);
        return;
      case OP.PONG:
        this._alive = true;
        return;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this._sentClose) this._frame(OP.CLOSE, payload);
        this._closeReason = { code, reason };
        this.socket.end();
        return;
      }
      case OP.TEXT:
      case OP.BIN:
        if (this._frag) throw new Error('interleaved data frame');
        if (fin) return this._deliver(payload);
        this._frag = { parts: [payload], size: payload.length };
        return;
      case OP.CONT: {
        if (!this._frag) throw new Error('continuation without start');
        this._frag.size += payload.length;
        if (this._frag.size > this.maxMessage) throw new Error('message exceeds max size');
        this._frag.parts.push(payload);
        if (!fin) return;
        const full = Buffer.concat(this._frag.parts, this._frag.size);
        this._frag = null;
        return this._deliver(full);
      }
      default:
        throw new Error('unknown opcode ' + opcode);
    }
  }

  _deliver(payload) {
    this._alive = true;
    this.emit('message', payload.toString('utf8'));
  }

  _frame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    return this.socket.write(encodeFrame(opcode, payload, this.isClient));
  }

  send(text) {
    if (this.closed) throw new Error('websocket is closed');
    return this._frame(OP.TEXT, Buffer.from(text, 'utf8'));
  }

  close(code = 1000, reason = '') {
    if (this.closed || this._sentClose) return;
    this._sentClose = true;
    const r = Buffer.from(reason, 'utf8');
    const p = Buffer.allocUnsafe(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._frame(OP.CLOSE, p);
    this.socket.end();
    // Don't linger if the peer never replies.
    const t = setTimeout(() => this.socket.destroy(), 5000);
    if (t.unref) t.unref();
  }

  terminate(err) {
    this._fail(err || new Error('terminated'));
    this.socket.destroy();
  }

  _fail(err) {
    if (this.closed) return;
    this._err = err;
    this.emit('error', err);
  }

  _done() {
    if (this.closed) return;
    this.closed = true;
    if (this._hb) clearInterval(this._hb);
    this.emit('close', this._closeReason || { code: 1006, reason: '' }, this._err);
  }
}

// ------------------------------------------------------------------- client

function connect(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error(`invalid websocket url: ${url}`)); }
    const secure = u.protocol === 'wss:';
    if (!secure && u.protocol !== 'ws:') {
      return reject(new Error(`unsupported websocket scheme: ${u.protocol}`));
    }
    const port = u.port ? Number(u.port) : (secure ? 443 : 80);
    const path = (u.pathname || '/') + (u.search || '');
    const key = crypto.randomBytes(16).toString('base64');

    const headers = Object.assign({
      Host: u.port ? `${u.hostname}:${u.port}` : u.hostname,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    }, opts.headers || {});

    const onFail = (err) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => onFail(new Error(`websocket connect timed out: ${url}`)),
      opts.timeoutMs || 15000);
    if (timer.unref) timer.unref();

    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname,
                      rejectUnauthorized: opts.rejectUnauthorized !== false })
      : net.connect({ host: u.hostname, port });

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onFail);
      socket.removeListener('close', onEarlyClose);
    };
    const onEarlyClose = () => onFail(new Error(`connection closed during handshake: ${url}`));

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > 65536) onFail(new Error('handshake response too large'));
        return;
      }
      const head = buf.subarray(0, end).toString('latin1');
      const rest = buf.subarray(end + 4);
      const [statusLine, ...lines] = head.split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      if (status !== 101) {
        return onFail(new Error(`websocket handshake failed: ${statusLine.trim()}`));
      }
      const got = lines
        .map((l) => l.split(':'))
        .find((p) => p[0].toLowerCase().trim() === 'sec-websocket-accept');
      if (!got || got.slice(1).join(':').trim() !== acceptKey(key)) {
        return onFail(new Error('websocket handshake failed: bad Sec-WebSocket-Accept'));
      }
      cleanup();
      socket.setNoDelay(true);
      const ws = new WsSocket(socket, true, opts);
      resolve(ws);
      if (rest.length) ws._onData(rest);
    };

    socket.on('error', onFail);
    socket.on('close', onEarlyClose);
    socket.on('data', onData);
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      const req = [`GET ${path} HTTP/1.1`]
        .concat(Object.entries(headers).map(([k, v]) => `${k}: ${v}`))
        .join('\r\n') + '\r\n\r\n';
      socket.write(req);
    });
  });
}

// ------------------------------------------------------------------- server

// `verify(req)` may return a string to reject with (e.g. '401 Unauthorized').
function createServer({ verify } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('acp: websocket connections only\n');
  });

  server.on('upgrade', (req, socket, head) => {
    const deny = (line) => {
      socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') return deny('400 Bad Request');
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers['sec-websocket-version'] !== '13') return deny('400 Bad Request');

    if (verify) {
      const rejection = verify(req);
      if (rejection) return deny(rejection);
    }

    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    const ws = new WsSocket(socket, false);
    server.emit('ws', ws, req);
    if (head && head.length) ws._onData(head);
  });

  return server;
}

module.exports = { connect, createServer, WsSocket, encodeFrame, acceptKey };
