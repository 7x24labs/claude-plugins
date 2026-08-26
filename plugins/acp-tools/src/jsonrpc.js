'use strict';
// JSON-RPC 2.0 peer over any bidirectional message channel.
// `channel` = { send(string), onMessage(cb), onClose(cb), close() }

const ERR = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602, INTERNAL: -32603,
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class Peer {
  constructor(channel, { name = 'peer', onError } = {}) {
    this.channel = channel;
    this.name = name;
    this.onError = onError || (() => {});
    this.methods = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;

    channel.onMessage((line) => this._receive(line));
    channel.onClose((reason) => this._shutdown(reason));
  }

  // handler(params, ctx) -> result | Promise<result>. Throw RpcError for a coded failure.
  handle(method, handler) { this.methods.set(method, handler); return this; }

  request(method, params, { timeoutMs = 0 } = {}) {
    if (this.closed) return Promise.reject(new Error(`${this.name}: connection closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${this.name}: ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (entry.timer.unref) entry.timer.unref();
      }
      this.pending.set(id, entry);
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    if (this.closed) return;
    try { this._write({ jsonrpc: '2.0', method, params }); } catch (err) { this.onError(err); }
  }

  _write(msg) { this.channel.send(JSON.stringify(msg)); }

  async _receive(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return this._write({ jsonrpc: '2.0', id: null,
        error: { code: ERR.PARSE, message: 'invalid JSON' } });
    }
    if (Array.isArray(msg)) { for (const m of msg) await this._dispatch(m); return; }
    await this._dispatch(msg);
  }

  async _dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;

    // Response to something we sent.
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        const err = new RpcError(msg.error.code, msg.error.message || 'rpc error', msg.error.data);
        err.method = entry.method;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method !== 'string') return;
    const isRequest = msg.id !== undefined && msg.id !== null;
    const handler = this.methods.get(msg.method);

    if (!handler) {
      if (isRequest) {
        this._write({ jsonrpc: '2.0', id: msg.id,
          error: { code: ERR.METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } });
      }
      return;
    }

    try {
      const result = await handler(msg.params || {}, { method: msg.method, id: msg.id });
      if (isRequest) {
        this._write({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result });
      }
    } catch (err) {
      this.onError(err);
      if (isRequest) {
        this._write({ jsonrpc: '2.0', id: msg.id, error: {
          code: err instanceof RpcError ? err.code : ERR.INTERNAL,
          message: err.message || String(err),
          data: err instanceof RpcError ? err.data : undefined,
        } });
      }
    }
  }

  _shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`${this.name}: connection closed${reason ? ` (${reason})` : ''}`);
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  close() { try { this.channel.close(); } catch { /* already gone */ } this._shutdown('local close'); }
}

module.exports = { Peer, RpcError, ERR };
