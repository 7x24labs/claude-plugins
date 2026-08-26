'use strict';
// Agent Client Protocol helpers shared by the CLI client and the serve daemon.
// Spec: https://agentclientprotocol.com  (JSON-RPC 2.0 over newline-delimited JSON)

const fs = require('node:fs');
const path = require('node:path');
const { RpcError, ERR } = require('./jsonrpc');

const PROTOCOL_VERSION = 1;
const STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];

// We do our own file I/O on behalf of the agent, but we do not host terminals:
// agents run their own shells, and proxying them buys nothing here.
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
};

const textPrompt = (text) => [{ type: 'text', text }];

function blockToText(block) {
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text': return block.text || '';
    case 'resource_link': return `[${block.name || block.uri}](${block.uri})`;
    case 'resource': {
      const r = block.resource || {};
      return r.text !== undefined ? r.text : `[resource ${r.uri || ''}]`;
    }
    case 'image': return '[image]';
    case 'audio': return '[audio]';
    default: return '';
  }
}

const contentToText = (c) =>
  Array.isArray(c) ? c.map(blockToText).join('') : blockToText(c);

// ------------------------------------------------------------- fs handlers

function resolveScoped(target, scopeDirs, mode) {
  const abs = path.resolve(target);
  if (mode === 'any' || !scopeDirs || !scopeDirs.length) return abs;
  const ok = scopeDirs.some((dir) => {
    const root = path.resolve(dir);
    return abs === root || abs.startsWith(root + path.sep);
  });
  if (!ok) {
    throw new RpcError(ERR.INVALID_PARAMS,
      `path is outside the session scope: ${abs}`, { scope: scopeDirs });
  }
  return abs;
}

// scopeFor(sessionId) -> string[] of allowed roots; fsScope: 'session-cwd' | 'any'
function installFsHandlers(peer, { scopeFor, fsScope = 'session-cwd' } = {}) {
  peer.handle('fs/read_text_file', (p) => {
    const file = resolveScoped(p.path, scopeFor ? scopeFor(p.sessionId) : null, fsScope);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new RpcError(ERR.INTERNAL, `cannot read ${file}: ${err.message}`);
    }
    if (p.line === undefined && p.limit === undefined) return { content: text };
    const lines = text.split('\n');
    const start = Math.max(0, (p.line || 1) - 1);
    const end = p.limit === undefined ? lines.length : start + p.limit;
    return { content: lines.slice(start, end).join('\n') };
  });

  peer.handle('fs/write_text_file', (p) => {
    const file = resolveScoped(p.path, scopeFor ? scopeFor(p.sessionId) : null, fsScope);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, p.content === undefined ? '' : p.content, 'utf8');
    } catch (err) {
      throw new RpcError(ERR.INTERNAL, `cannot write ${file}: ${err.message}`);
    }
    return null;
  });
}

// -------------------------------------------------------------- permissions

// mode: 'allow' | 'deny' | 'prompt'
function decidePermission(params, mode) {
  const options = params.options || [];
  if (!options.length) return { outcome: { outcome: 'cancelled' } };
  const byKind = (...kinds) => options.find((o) => kinds.includes(o.kind));

  if (mode === 'deny') {
    const pick = byKind('reject_once', 'reject_always');
    return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
                : { outcome: { outcome: 'cancelled' } };
  }
  const pick = byKind('allow_always', 'allow_once') || options[0];
  return { outcome: { outcome: 'selected', optionId: pick.optionId } };
}

// ------------------------------------------------------------- initialize

async function initialize(peer, { clientName = 'acp-cli', version = '1.0.0' } = {}) {
  const res = await peer.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: CLIENT_CAPABILITIES,
    clientInfo: { name: clientName, version },
  }, { timeoutMs: 60000 });
  return res || {};
}

// -------------------------------------------------------------- rendering

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// Streams session/update notifications into readable console output.
// Returns { write(update), text() } -- text() is the accumulated agent message.
function createRenderer({ color = true, showThoughts = false, out = process.stdout } = {}) {
  const c = color ? { dim, bold, cyan, yellow } : { dim: (s) => s, bold: (s) => s, cyan: (s) => s, yellow: (s) => s };
  let message = '';
  let inMessage = false;
  const seenTools = new Map();

  const line = (s) => { if (inMessage) { out.write('\n'); inMessage = false; } out.write(s + '\n'); };

  return {
    write(u) {
      if (!u || typeof u !== 'object') return;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          const t = contentToText(u.content);
          if (!t) return;
          message += t;
          inMessage = true;
          out.write(t);
          return;
        }
        case 'agent_thought_chunk': {
          if (!showThoughts) return;
          const t = contentToText(u.content).trim();
          if (t) line(c.dim(`  thinking: ${t}`));
          return;
        }
        case 'user_message_chunk':
          return;
        case 'tool_call': {
          seenTools.set(u.toolCallId, u.title);
          line(c.cyan(`  * ${u.title || u.kind || 'tool'}`) +
               (u.status && u.status !== 'pending' ? c.dim(` [${u.status}]`) : ''));
          return;
        }
        case 'tool_call_update': {
          if (!u.status || u.status === 'in_progress') return;
          const title = u.title || seenTools.get(u.toolCallId) || u.toolCallId;
          const mark = u.status === 'failed' ? c.yellow('x') : c.dim('v');
          line(`  ${mark} ${c.dim(`${title} [${u.status}]`)}`);
          return;
        }
        case 'plan': {
          const entries = u.entries || [];
          if (!entries.length) return;
          line(c.bold('  plan:'));
          for (const e of entries) {
            const box = e.status === 'completed' ? 'x' : e.status === 'in_progress' ? '>' : ' ';
            line(c.dim(`    [${box}] ${contentToText(e.content) || e.content || ''}`));
          }
          return;
        }
        case 'current_mode_update':
          line(c.dim(`  mode -> ${u.currentModeId}`));
          return;
        default:
          return;
      }
    },
    finish() { if (inMessage) { out.write('\n'); inMessage = false; } },
    text() { return message; },
  };
}

module.exports = {
  PROTOCOL_VERSION, STOP_REASONS, CLIENT_CAPABILITIES,
  textPrompt, blockToText, contentToText,
  installFsHandlers, decidePermission, initialize, createRenderer, resolveScoped,
};
