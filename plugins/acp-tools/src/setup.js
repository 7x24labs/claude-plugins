'use strict';
// `acp-setup` -- first-run setup for the parts of acp-tools that are not just
// files in this repo: the acp-ui web client has to be fetched and built.
//
//   git clone 7x24labs/acp-ui  ->  npm install  ->  vite build  ->  publish
//   dist/ into the plugin's ui/ directory, where `acp-ui serve` finds it.
//
// Run it after installing the plugin, and again to pick up a newer acp-ui.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { UI_ROOT, DEFAULT_PORT } = require('./ui');

const REPO = process.env.ACP_UI_REPO || 'https://github.com/7x24labs/acp-ui.git';
const REF = process.env.ACP_UI_REF || 'main';

// Where the checkout lives between builds. Kept outside the plugin so a plugin
// update never wipes it, and so npm's node_modules survives for the next build.
const SRC_DIR = process.env.ACP_UI_SRC
  || path.join(process.env.ACP_HOME || path.join(os.homedir(), '.acp'), 'build', 'acp-ui');

const out = (s = '') => process.stdout.write(s + '\n');

// ------------------------------------------------------------------ commands

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${[cmd, ...args].join(' ')} failed (exit ${r.status}) in ${cwd || process.cwd()}`);
}

// Like run(), but captures output instead of streaming it, so a first attempt
// that we expect to sometimes fail does not dump a wall of npm errors.
function tryRun(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: !r.error && r.status === 0, output };
}

function capture(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// --------------------------------------------------------------------- steps

// Clone on first run, fast-forward to the tip of REF after that.
function sync(srcDir) {
  if (fs.existsSync(path.join(srcDir, '.git'))) {
    out(`updating ${srcDir} (${REF})`);
    run('git', ['remote', 'set-url', 'origin', REPO], srcDir);
    run('git', ['fetch', '--depth', '1', 'origin', REF], srcDir);
    run('git', ['reset', '--hard', 'FETCH_HEAD'], srcDir);
    run('git', ['clean', '-fd'], srcDir);   // untracked, but not ignored: node_modules stays
  } else {
    out(`cloning ${REPO} -> ${srcDir}`);
    fs.mkdirSync(path.dirname(srcDir), { recursive: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
    run('git', ['clone', '--depth', '1', '--branch', REF, REPO, srcDir]);
  }
  return capture('git', ['rev-parse', 'HEAD'], srcDir);
}

// acp-ui's `overrides` pin the TypeScript peer of typescript-eslint below the
// TypeScript it actually builds with, which npm refuses to resolve. That is a
// lint-only conflict -- `tsc -b && vite build` is unaffected -- so retry the way
// npm itself suggests rather than failing a build that would otherwise work.
function install(uiDir) {
  const locked = fs.existsSync(path.join(uiDir, 'package-lock.json'));
  const args = [locked ? 'ci' : 'install', '--no-audit', '--no-fund'];
  out(`installing dependencies (npm ${args[0]})`);

  const first = tryRun('npm', args, uiDir);
  if (first.ok) {
    out(`  ${first.output.split('\n').filter(Boolean).pop() || 'done'}`);
    return;
  }

  const reason = /ERESOLVE/.test(first.output) ? 'peer dependency conflict' : 'install failed';
  out(`  ${reason} -- retrying with --legacy-peer-deps`);
  const second = tryRun('npm', [...args, '--legacy-peer-deps'], uiDir);
  if (second.ok) {
    out(`  ${second.output.split('\n').filter(Boolean).pop() || 'done'}`);
    return;
  }

  process.stderr.write(first.output + '\n');
  throw new Error(`npm ${args[0]} failed in ${uiDir}`);
}

// Replace the destination only once the build succeeded, so a failed build
// leaves the previously published UI serving.
function publish(distDir, destDir, info) {
  fs.writeFileSync(path.join(distDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

  const staging = `${destDir}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(distDir, staging, { recursive: true });

  const previous = `${destDir}.old-${process.pid}`;
  if (fs.existsSync(destDir)) fs.renameSync(destDir, previous);
  try {
    fs.renameSync(staging, destDir);
  } catch (err) {
    if (fs.existsSync(previous)) fs.renameSync(previous, destDir);   // put it back
    throw err;
  }
  fs.rmSync(previous, { recursive: true, force: true });
}

function buildUi({ srcDir = SRC_DIR, destDir = UI_ROOT, skipSync = false } = {}) {
  if (!capture('git', ['--version'])) throw new Error('git is required to build the UI');

  const commit = skipSync ? capture('git', ['rev-parse', 'HEAD'], srcDir) : sync(srcDir);

  const uiDir = path.join(srcDir, 'src', 'ui');
  if (!fs.existsSync(path.join(uiDir, 'package.json'))) {
    throw new Error(`no UI package.json at ${uiDir} -- has the acp-ui layout changed?`);
  }

  install(uiDir);

  out('building');
  run('npm', ['run', 'build'], uiDir);

  const distDir = path.join(uiDir, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(`build produced no index.html in ${distDir}`);
  }

  publish(distDir, destDir, {
    repo: REPO,
    ref: REF,
    commit,
    builtAt: new Date().toISOString(),
    node: process.version,
  });

  out('');
  out(`published ${destDir}`);
  out(`  commit  ${commit.slice(0, 12) || '(unknown)'}`);
  out(`  files   ${fs.readdirSync(destDir).length} entries`);
  out(`  serve   acp-ui --port ${DEFAULT_PORT}`);
}

// ----------------------------------------------------------------------- cli

function usage() {
  out(`acp-setup -- set up acp-tools' web client

  acp-setup [--src DIR] [--dest DIR] [--no-sync]

Clones or updates ${REPO} (${REF}),
installs its dependencies, builds it, and publishes the result where
\`acp-ui\` serves it from. Re-run it to pick up a newer acp-ui.

  --src DIR    checkout to build from   (default ${SRC_DIR})
  --dest DIR   publish the build here   (default ${UI_ROOT})
  --no-sync    build the checkout as it stands, skipping git

Env: ACP_UI_REPO, ACP_UI_REF, ACP_UI_SRC, ACP_UI_DEST`);
}

function parse(argv) {
  const VALUE = new Set(['src', 'dest']);
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
    rest.push(a);
  }
  return { flags, rest };
}

function main(argv) {
  const { flags, rest } = parse(argv);
  if (flags.help || rest[0] === 'help') return usage();
  if (rest[0] && rest[0] !== 'ui') {
    console.error(`unknown argument: ${rest[0]} (try \`acp-setup --help\`)`);
    process.exit(2);
  }

  buildUi({
    srcDir: flags.src ? path.resolve(flags.src) : SRC_DIR,
    destDir: flags.dest ? path.resolve(flags.dest) : UI_ROOT,
    skipSync: Boolean(flags['no-sync']),
  });
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(`acp-setup: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = { buildUi, SRC_DIR };
