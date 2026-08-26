#!/usr/bin/env node
// Mock ACP agent: stdio, newline-delimited JSON. Implements enough of the
// protocol to exercise the CLI end to end without spending real model calls.
//
// Prompt keywords it understands:
//   read <path>      -> calls back via fs/read_text_file
//   permission       -> raises session/request_permission
//   slow             -> a 4s turn, so cancellation can be tested
//   relay <peer> ... -> shells out to `acp send <peer>` (agent-to-agent)
'use strict';
const fs = require('fs');
let buf = '';
const sessions = new Map();
let n = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
const note = (method, params) => send({ jsonrpc: '2.0', method, params });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) await handle(JSON.parse(line));
  }
});

async function handle(m) {
  const { id, method, params = {} } = m;
  process.stderr.write(`mock-agent: ${method}\n`);
  switch (method) {
    case 'initialize':
      return reply(id, { protocolVersion: 1, agentInfo: { name: 'mock-agent', version: '0.1' },
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } }, authMethods: [] });
    case 'session/new': {
      const sid = `sess_${++n}`;
      sessions.set(sid, { cwd: params.cwd, turns: 0, cancelled: false });
      return reply(id, { sessionId: sid, modes: null, configOptions: [] });
    }
    case 'session/load':
      sessions.set(params.sessionId, { cwd: params.cwd, turns: 0, cancelled: false });
      return reply(id, { modes: null, configOptions: [] });
    case 'session/cancel': {
      const s = sessions.get(params.sessionId); if (s) s.cancelled = true; return;
    }
    case 'session/close': case 'session/delete':
      sessions.delete(params.sessionId); return reply(id, null);
    case 'session/prompt': {
      const s = sessions.get(params.sessionId);
      if (!s) return fail(id, 'unknown session ' + params.sessionId);
      s.cancelled = false; s.turns++;
      const text = (params.prompt || []).map(b => b.text || '').join('');
      const sid = params.sessionId;

      if (/read /.test(text)) {
        // exercise the client's fs capability
        const file = text.split('read ')[1].trim().split(/\s/)[0];
        note('session/update', { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: `Read ${file}`, kind: 'read', status: 'in_progress' } });
        try {
          const r = await request('fs/read_text_file', { sessionId: sid, path: file });
          note('session/update', { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' } });
          note('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `file says: ${r.content.trim()}` } } });
        } catch (e) {
          note('session/update', { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'failed' } });
          note('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `read blocked: ${e.message}` } } });
        }
        return reply(id, { stopReason: 'end_turn' });
      }

      if (/^relay /.test(text)) {
        // The agent itself uses the acp CLI to consult another agent.
        const [, peer, ...msg] = text.split(/\s+/);
        const { execFileSync } = require('child_process');
        let answer;
        try {
          answer = execFileSync(process.env.ACP_BIN,
            ['send', peer, '--quiet', msg.join(' ')], { encoding: 'utf8' }).trim();
        } catch (e) { answer = 'relay failed: ' + (e.stderr || e.message); }
        note('session/update', { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'consult ' + peer, kind: 'other', status: 'completed' } });
        note('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: peer + ' replied: ' + answer } } });
        return reply(id, { stopReason: 'end_turn' });
      }

      if (/slow/.test(text)) {
        for (let k = 0; k < 40; k++) {
          if (s.cancelled) return reply(id, { stopReason: 'cancelled' });
          await sleep(100);
        }
        return reply(id, { stopReason: 'end_turn' });
      }

      if (/permission/.test(text)) {
        const r = await request('session/request_permission', { sessionId: sid,
          toolCall: { toolCallId: 'p1', title: 'rm -rf /', kind: 'execute' },
          options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] });
        note('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission outcome: ${JSON.stringify(r.outcome)}` } } });
        return reply(id, { stopReason: 'end_turn' });
      }

      note('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'pondering' } } });
      note('session/update', { sessionId: sid, update: { sessionUpdate: 'plan', entries: [{ content: 'answer it', status: 'in_progress' }] } });
      for (const w of ['turn ', String(s.turns), ' in ', s.cwd, ': you said "', text, '"']) {
        await sleep(10);
        note('session/update', { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w } } });
      }
      return reply(id, { stopReason: 'end_turn' });
    }
    default:
      if (id !== undefined) return fail(id, 'method not found: ' + method);
  }
}

let rid = 1000; const pending = new Map();
function request(method, params) {
  const id = ++rid;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
}
const origHandle = handle;
handle = async (m) => {
  if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    return m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
  return origHandle(m);
};
