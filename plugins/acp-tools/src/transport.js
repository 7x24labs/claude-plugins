'use strict';
// Turns an agent registration into a JSON-RPC channel.
//   ws://host:port  /  wss://host:port  -> remote `acp serve` daemon
//   stdio:<command> <args...>           -> ACP agent spawned as a child process

const { spawn } = require('node:child_process');
const ws = require('./ws');

// Split a command string the way a shell would for simple quoting.
function splitCommand(str) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < str.length) cur += str[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (has || cur) out.push(cur);
  if (quote) throw new Error(`unbalanced ${quote} in command: ${str}`);
  return out;
}

function ndjsonChannel(write, onLine, onDone, closeFn) {
  const handlers = { message: [], close: [] };
  let buf = '';
  onLine((chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) for (const h of handlers.message) h(line);
    }
  });
  onDone((reason) => { for (const h of handlers.close) h(reason); });
  return {
    send: (line) => write(line + '\n'),
    onMessage: (cb) => handlers.message.push(cb),
    onClose: (cb) => handlers.close.push(cb),
    close: closeFn,
  };
}

async function openWs(url, { token, timeoutMs, rejectUnauthorized } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const sock = await ws.connect(url, { headers, timeoutMs, rejectUnauthorized });
  const handlers = { message: [], close: [] };
  sock.on('message', (m) => { for (const h of handlers.message) h(m); });
  sock.on('close', (info) => { for (const h of handlers.close) h(`code ${info.code}`); });
  sock.on('error', () => { /* surfaced via close */ });
  return {
    send: (line) => sock.send(line),
    onMessage: (cb) => handlers.message.push(cb),
    onClose: (cb) => handlers.close.push(cb),
    close: () => sock.close(1000, 'client done'),
    kind: 'ws',
  };
}

function openStdio(command, opts = {}) {
  return openStdioArgv(splitCommand(command), opts);
}

function openStdioArgv(argv, { cwd, env, onStderr } = {}) {
  if (!argv || !argv.length) throw new Error('stdio: needs a command');
  const child = spawn(argv[0], argv.slice(1), {
    cwd: cwd || process.cwd(),
    env: Object.assign({}, process.env, env || {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  if (onStderr) child.stderr.on('data', onStderr);
  else child.stderr.resume();

  let onDoneCb = () => {};
  child.on('error', (err) => onDoneCb(`spawn failed: ${err.message}`));
  child.on('exit', (code, signal) =>
    onDoneCb(signal ? `agent killed by ${signal}` : `agent exited with code ${code}`));

  const chan = ndjsonChannel(
    (line) => { if (child.stdin.writable) child.stdin.write(line); },
    (cb) => child.stdout.on('data', cb),
    (cb) => { onDoneCb = cb; },
    () => { try { child.stdin.end(); } catch { /* gone */ } child.kill('SIGTERM'); }
  );
  chan.kind = 'stdio';
  chan.child = child;
  return chan;
}

// agentCfg: { url, cwd, token }
async function open(agentCfg, opts = {}) {
  const url = agentCfg.url || '';
  if (url.startsWith('stdio:')) {
    return openStdio(url.slice('stdio:'.length).trim(),
      { cwd: agentCfg.cwd, env: agentCfg.env, onStderr: opts.onStderr });
  }
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return openWs(url, { token: agentCfg.token, timeoutMs: opts.timeoutMs,
      rejectUnauthorized: agentCfg.rejectUnauthorized });
  }
  throw new Error(`unsupported agent url: ${url || '(empty)'} -- expected ws://, wss:// or stdio:`);
}

module.exports = { open, openWs, openStdio, openStdioArgv, splitCommand, ndjsonChannel };
