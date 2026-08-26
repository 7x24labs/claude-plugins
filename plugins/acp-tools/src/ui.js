'use strict';
// `acp-ui` -- serve the acp-ui web client.
//
// The UI is a single-page app that talks ACP straight from the browser to a
// daemon (`acp serve`), so this only ever hands out static files: it never
// proxies, and it holds no agent state of its own.
//
// `acp-setup` is what fetches and builds the app; this serves what it published.

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');

// Where `acp-setup` publishes the built web client.
const UI_ROOT = process.env.ACP_UI_DEST
  || path.join(os.homedir(), '.claude/plugins/marketplaces/7x24labs/plugins/acp-tools/ui');

const DEFAULT_PORT = Number(process.env.ACP_UI_PORT || 8000);
const DEFAULT_HOST = process.env.ACP_UI_HOST || '127.0.0.1';

const out = (s = '') => process.stdout.write(s + '\n');

// --------------------------------------------------------------------- serve

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// Resolve a URL path to a file inside root, or null if it escapes or is missing.
function resolveFile(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (decoded.includes('\0')) return null;

  const target = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  if (target !== root && !target.startsWith(root + path.sep)) return null;   // traversal

  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const index = path.join(target, 'index.html');
      return fs.existsSync(index) ? index : null;
    }
    return target;
  } catch { return null; }
}

function serve({ root = UI_ROOT, port = DEFAULT_PORT, host = DEFAULT_HOST, verbose = false } = {}) {
  root = path.resolve(root);
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`no built UI at ${root} -- run \`acp-setup\` first`);
  }
  const index = path.join(root, 'index.html');

  const log = (...a) => console.error(`[acp-ui ${new Date().toISOString().slice(11, 19)}]`, ...a);

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain' });
      return res.end('method not allowed\n');
    }

    const file = resolveFile(root, req.url || '/');
    // A miss with no file extension is a client-side route: React Router owns
    // it, so hand back index.html and let the app render it. A miss that looks
    // like an asset is a real 404.
    const hasExt = path.extname((req.url || '').split('?')[0]) !== '';
    const target = file || (hasExt ? null : index);

    if (!target) {
      if (verbose) log(`404 ${req.url}`);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found\n');
    }

    let stat;
    try { stat = fs.statSync(target); } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found\n');
    }

    // Vite fingerprints everything under assets/, so those are safe to pin;
    // index.html must not be, or a rebuild never reaches an open tab.
    const immutable = target.startsWith(path.join(root, 'assets') + path.sep);
    const headers = {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Last-Modified': stat.mtime.toUTCString(),
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };

    if (verbose) log(`${stat.size}B ${req.url} -> ${path.relative(root, target)}`);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res).on('error', () => res.destroy());
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`acp-ui: ${host}:${port} is already in use`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    let info = {};
    try { info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8')); } catch { /* not built by us */ }
    log(`serving ${root}`);
    if (info.commit) log(`build ${info.commit.slice(0, 12)} from ${info.builtAt}`);
    log(`open http://${host}:${port}`);
  });

  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

// ----------------------------------------------------------------------- cli

function usage() {
  out(`acp-ui -- serve the acp-ui web client

  acp-ui [--port N] [--host H] [--root DIR] [-v]

Static-serves the UI published by \`acp-setup\`, single-page-app fallback
included. It serves files and nothing else -- the page dials agents itself.

  --port N     listen on this port  (default ${DEFAULT_PORT})
  --host H     bind this address    (default ${DEFAULT_HOST})
  --root DIR   serve this directory (default ${UI_ROOT})
  -v           log every request

Env: ACP_UI_DEST, ACP_UI_PORT, ACP_UI_HOST

The UI dials agents from the browser, where a WebSocket carries no Authorization
header -- run the daemons it talks to with \`acp serve --no-auth\` on a trusted
host, or put an authenticating proxy in front.`);
}

function parse(argv) {
  const VALUE = new Set(['root', 'port', 'host']);
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      flags[key] = VALUE.has(key) ? argv[++i] : true;
      continue;
    }
    if (a === '-v') { flags.verbose = true; continue; }
    rest.push(a);
  }
  return { flags, rest };
}

function main(argv) {
  const { flags, rest } = parse(argv);
  const cmd = rest[0];

  if (flags.help || cmd === 'help') return usage();
  // `acp-ui serve` still works; serving is all it does.
  if (cmd && cmd !== 'serve') {
    if (cmd === 'build') {
      console.error('acp-ui only serves now -- run `acp-setup` to fetch and build the UI');
      process.exit(2);
    }
    console.error(`unknown argument: ${cmd} (try \`acp-ui --help\`)`);
    process.exit(2);
  }

  serve({
    root: flags.root ? path.resolve(flags.root) : UI_ROOT,
    port: flags.port ? Number(flags.port) : DEFAULT_PORT,
    host: flags.host || DEFAULT_HOST,
    verbose: Boolean(flags.verbose),
  });
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(`acp-ui: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = { serve, UI_ROOT, DEFAULT_PORT, DEFAULT_HOST };
