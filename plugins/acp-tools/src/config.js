'use strict';
// Settings live in a single JSON file: ~/.acp/config.json (override with ACP_HOME).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME = process.env.ACP_HOME || path.join(os.homedir(), '.acp');
const CONFIG_PATH = path.join(HOME, 'config.json');
const LOG_DIR = path.join(HOME, 'logs');

const DEFAULTS = () => ({
  version: 1,
  identity: os.hostname(),
  server: {
    host: '127.0.0.1',
    port: 7431,
    token: crypto.randomBytes(24).toString('base64url'),
    // Command the daemon spawns to get a local ACP agent (stdio, ndjson).
    agent: { command: 'npx', args: ['-y', '@zed-industries/claude-code-acp'], env: {} },
    // allow | deny | prompt  -- how the daemon answers session/request_permission.
    permissionMode: 'allow',
    // session-cwd | any  -- limits which paths the agent may read/write via fs/*.
    fsScope: 'session-cwd',
    idleTimeoutMs: 1800000,
  },
  agents: {},
  sessions: {},
});

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

function load() {
  ensureHome();
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = DEFAULTS();
    writeAtomic(cfg);
    return cfg;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config is not valid JSON (${CONFIG_PATH}): ${err.message}`);
  }
  const cfg = DEFAULTS();
  // Shallow merge, one level deep for `server`, so new defaults appear in old files.
  Object.assign(cfg, raw);
  cfg.server = Object.assign(DEFAULTS().server, raw.server || {});
  cfg.server.agent = Object.assign(DEFAULTS().server.agent, (raw.server || {}).agent || {});
  cfg.agents = raw.agents || {};
  cfg.sessions = raw.sessions || {};
  return cfg;
}

function writeAtomic(cfg) {
  ensureHome();
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

// Read-modify-write under a lock so concurrent CLI invocations don't clobber
// each other (every command is its own short-lived process).
function update(fn) {
  ensureHome();
  const lock = path.join(HOME, '.config.lock');
  const deadline = Date.now() + 5000;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Reclaim a lock left behind by a crashed process.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; }
      } catch { /* raced with the holder */ }
      if (Date.now() > deadline) throw new Error(`timed out waiting for config lock: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const cfg = load();
    const result = fn(cfg);
    writeAtomic(cfg);
    return result;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}

const sessionKey = (agent, sessionId) => `${agent}/${sessionId}`;

function transcriptPath(agent, sessionId, create = true) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(LOG_DIR, String(agent).replace(/[^A-Za-z0-9._-]/g, '_'));
  // Readers pass create=false so merely asking for a title cannot litter
  // LOG_DIR with directories for agents that never wrote a transcript.
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${safe}.jsonl`);
}

// A session's display name: the first thing the user said in it, squashed to a
// single short line. Mirrors how the web UI names the same conversation.
const TITLE_MAX = 60;

function titleFrom(text) {
  const one = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1)}\u2026` : one;
}

// Sessions that predate stored titles -- and every session started from the web
// UI, which only ever reaches the transcript -- still have their first prompt on
// disk, so recover the title from there. The daemon writes it as `prompt` and
// the CLI as `text`; accept either. An explicit rename (`type: 'title'`, written
// by serve.js's session/set_title) outranks the first prompt and, since a
// session can be renamed more than once, the last one in the scanned window
// wins over an earlier one.
function titleFromTranscript(agent, sessionId) {
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath(agent, sessionId, false), 'r');
    // The opening prompt sits at the top; a bounded read keeps this cheap even
    // for a transcript that has grown to megabytes of streamed updates. A late
    // rename can fall outside this window -- best effort, same as everything
    // else here.
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let fromPrompt = '';
    let fromRename = '';
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }   // trailing partial line
      if (!entry) continue;
      if (entry.type === 'title') {
        const title = titleFrom(entry.title);
        if (title) fromRename = title;
      } else if (!fromPrompt && entry.type === 'prompt') {
        const title = titleFrom(entry.text !== undefined ? entry.text : entry.prompt);
        if (title) fromPrompt = title;
      }
    }
    if (fromRename || fromPrompt) return fromRename || fromPrompt;
  } catch { /* no transcript, or unreadable -- callers fall back */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } } }
  return '';
}

function appendTranscript(agent, sessionId, entry) {
  try {
    fs.appendFileSync(transcriptPath(agent, sessionId),
      JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n');
  } catch { /* transcripts are best-effort */ }
}

module.exports = {
  HOME, CONFIG_PATH, LOG_DIR,
  load, update, writeAtomic, sessionKey, transcriptPath, appendTranscript, DEFAULTS,
  titleFrom, titleFromTranscript,
};
