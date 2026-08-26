'use strict';
// `acp-setup` -- first-run setup for the parts of acp-tools that are not just
// files in this repo: the commands want to be on PATH, and the acp-ui web
// client has to be fetched and built.
//
//   link bin/* into ~/.local/bin
//   git clone 7x24labs/acp-ui  ->  npm install  ->  vite build  ->  copy
//   dist/ into the plugin's ui/ directory, where `acp-ui` serves it from
//
// The checkout is a means to an end, so it is cloned into a temporary
// directory and removed once dist/ has been copied out -- only the built UI
// is kept. That costs a fresh clone and a fresh npm install on every run.
//
// Run it after installing the plugin, and again to pick up a newer acp-ui.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { UI_ROOT, DEFAULT_PORT } = require('./ui');

const REPO = process.env.ACP_UI_REPO || 'https://github.com/7x24labs/acp-ui.git';
const REF = process.env.ACP_UI_REF || 'main';

// Where the throwaway checkout is made. Under ACP_HOME rather than /tmp so a
// build that dies mid-flight leaves its mess somewhere findable, and so the
// clone and its destination sit on the same filesystem.
const WORK_DIR = process.env.ACP_UI_WORK
  || path.join(process.env.ACP_HOME || path.join(os.homedir(), '.acp'), 'build');

const BIN_DIR = path.resolve(__dirname, '..', 'bin');
const LINK_DIR = process.env.ACP_LINK_DIR || path.join(os.homedir(), '.local/bin');

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

// The checkout in flight. A normal failure unwinds through `finally` and takes
// it with us; a kill does not -- every step here is synchronous, so the event
// loop never turns to run a signal handler, and installing one would only stop
// Ctrl-C from working. The sweep below is what makes that harmless.
let pendingClone = null;

function discardPendingClone() {
  if (!pendingClone) return;
  fs.rmSync(pendingClone, { recursive: true, force: true });
  pendingClone = null;
}

// Anything matching acp-ui-* in the work dir is a clone of ours that outlived
// its run -- an earlier setup that was killed. Sweeping at the start rather
// than at the end is deliberate: a killed run leaves npm still writing into
// that directory for a while, so only the next run can safely clear it.
function sweepStaleClones() {
  for (const entry of (() => { try { return fs.readdirSync(WORK_DIR); } catch { return []; } })()) {
    if (!entry.startsWith('acp-ui-')) continue;
    const stale = path.join(WORK_DIR, entry);
    out(`removing leftover checkout ${stale}`);
    fs.rmSync(stale, { recursive: true, force: true });
  }
}

// A shallow clone into a directory we own and will delete.
function clone() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  sweepStaleClones();
  const dir = fs.mkdtempSync(path.join(WORK_DIR, 'acp-ui-'));
  pendingClone = dir;
  out(`cloning ${REPO} (${REF})`);
  try {
    run('git', ['clone', '--depth', '1', '--branch', REF, REPO, dir]);
  } catch (err) {
    discardPendingClone();   // never leave an empty shell behind
    throw err;
  }
  return dir;
}

// Put the commands where a shell will find them. An existing link of ours is
// repointed; anything else with that name is left alone and reported.
function linkCommands(linkDir = LINK_DIR) {
  out(`linking commands into ${linkDir}`);
  fs.mkdirSync(linkDir, { recursive: true });

  for (const name of fs.readdirSync(BIN_DIR).sort()) {
    const target = path.join(BIN_DIR, name);
    const link = path.join(linkDir, name);

    let existing = null;
    try { existing = fs.lstatSync(link); } catch { /* nothing there */ }

    if (existing) {
      if (!existing.isSymbolicLink()) {
        out(`  ${name}: a file is already there, leaving it alone`);
        continue;
      }
      const current = fs.readlinkSync(link);
      if (path.resolve(path.dirname(link), current) === target) {
        out(`  ${name}: already linked`);
        continue;
      }
      // Only reclaim a link that points at some copy of this plugin.
      if (!current.includes('acp-tools')) {
        out(`  ${name}: points at ${current}, leaving it alone`);
        continue;
      }
      fs.unlinkSync(link);
      fs.symlinkSync(target, link);
      out(`  ${name}: repointed from ${current}`);
      continue;
    }

    fs.symlinkSync(target, link);
    out(`  ${name}: linked`);
  }

  const onPath = (process.env.PATH || '').split(path.delimiter).includes(linkDir);
  if (!onPath) out(`  note: ${linkDir} is not on your PATH`);
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

function buildUi({ srcDir = null, destDir = UI_ROOT } = {}) {
  if (!srcDir && !capture('git', ['--version'])) {
    throw new Error('git is required to fetch the UI');
  }

  // --src builds a checkout the caller owns; anything we clone, we delete.
  const disposable = !srcDir;
  const dir = srcDir || clone();

  try {
    const commit = capture('git', ['rev-parse', 'HEAD'], dir);

    const uiDir = path.join(dir, 'src', 'ui');
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
  } finally {
    // The dist/ we wanted is copied out by now, so the checkout is spent --
    // drop it whether the build worked or not.
    if (disposable) {
      discardPendingClone();
      out(`  cleaned ${dir}`);
    }
  }
}

// ----------------------------------------------------------------------- cli

function usage() {
  out(`acp-setup -- set up acp-tools

  acp-setup [--src DIR] [--dest DIR] [--link-dir DIR] [--no-link] [--no-ui]

Links this plugin's commands into ${LINK_DIR}, then clones
${REPO} (${REF}) into a temporary
directory, builds it, copies dist/ to where \`acp-ui\` serves it from, and
deletes the checkout. Re-run it to pick up a newer acp-ui.

  --src DIR       build this checkout instead of cloning (it is never deleted)
  --dest DIR      copy the build here    (default ${UI_ROOT})
  --link-dir DIR  link commands here     (default ${LINK_DIR})
  --no-link       skip linking commands
  --no-ui         only link commands, skip the UI build

Env: ACP_UI_REPO, ACP_UI_REF, ACP_UI_WORK, ACP_UI_DEST, ACP_LINK_DIR`);
}

function parse(argv) {
  const VALUE = new Set(['src', 'dest', 'link-dir']);
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

  if (!flags['no-link']) linkCommands(flags['link-dir'] ? path.resolve(flags['link-dir']) : LINK_DIR);
  if (flags['no-ui']) return;
  if (!flags['no-link']) out('');

  buildUi({
    srcDir: flags.src ? path.resolve(flags.src) : null,
    destDir: flags.dest ? path.resolve(flags.dest) : UI_ROOT,
  });
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(`acp-setup: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = { buildUi, linkCommands, WORK_DIR, LINK_DIR };
