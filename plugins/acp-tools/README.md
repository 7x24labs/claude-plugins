# acp-tools

Agent-to-agent messaging over the [Agent Client Protocol][acp] -- JSON-RPC 2.0
carried as newline-delimited JSON, protocol version 1.

Register other AI agents as named peers, open sessions against them, and hold
multi-turn conversations. Peers can be on other machines, working in other
repositories. Zero npm dependencies: the WebSocket client and server are
implemented against RFC 6455 directly, in about 350 lines.

[acp]: https://agentclientprotocol.com

## Install

```
/plugin marketplace add 7x24labs/claude-plugins
/plugin install acp-tools@7x24labs
```

Optionally put the commands on `PATH`:

```
plugin=~/.claude/plugins/marketplaces/7x24labs/plugins/acp-tools
ln -s $plugin/bin/acp       ~/.local/bin/acp
ln -s $plugin/bin/acp-ui    ~/.local/bin/acp-ui
ln -s $plugin/bin/acp-setup ~/.local/bin/acp-setup
```

Link a checkout's `bin/` instead if you are working on the plugin -- the shims
resolve through symlinks, so either target works.

Or let setup do the linking, along with building the web UI:

```
acp-setup
```

That is the only build step in the plugin, and it builds acp-ui rather than
acp-tools: `acp` itself is plain Node with no dependencies and nothing to
compile. Requires Node 20+, and git for `acp-setup`.

## Shape of it

```
  machine A                                machine B
  ┌────────────────────────┐               ┌────────────────────────────┐
  │ Claude Code            │               │ acp serve                  │
  │   /acp skill           │               │   (ACP agent to callers,   │
  │      ↓                 │   ws + token  │    ACP client downstream)  │
  │ acp send new@B "..." ──┼──────────────►│      ↓ spawns              │
  │                        │◄──────────────┼── claude-code-acp (stdio)  │
  │                        │ session/update│      ↓ works in            │
  └────────────────────────┘               │   /workspace/api           │
                                           └────────────────────────────┘
```

The daemon is a **proxy, not a relay**. It answers ACP as an agent to whoever
dials in, and acts as the ACP client for the agent process it spawns. So
`fs/read_text_file`, `fs/write_text_file` and permission prompts terminate on
the machine that owns the repo, rather than being tunneled back to the caller.
Progress (`session/update`) still streams out to the caller live.

## Quick start

On the machine that will host an agent:

```
acp serve -v                       # prints its listen address and token
```

On the machine that wants to reach it:

```
acp agent add reviewer ws://box-b:7431 /workspace/api --token <token>
acp status reviewer
acp send new@reviewer "review the auth changes on branch fix/login"   # prints e.g. sess_1@reviewer
acp send sess_1@reviewer "now check the tests for those files"        # same session
```

For a local peer with no daemon at all:

```
acp agent add local "stdio:npx -y @zed-industries/claude-code-acp" /workspace/api
acp send new@local "summarise the README"
```

## Commands

```
acp status [agent]                     local config, or probe a peer
acp serve [--port N] [--host H] [-v]   host an agent for others
      [--permission allow|deny] [--fs-scope session-cwd|any] [--no-auth]
      [--agent-command "<cmd>"]

acp agent add <name> <url> [cwd]       register a peer (--token, --force)
acp agent remove <name>                unregister (alias: rm)
acp agent ls [--json]

acp session ls [agent] [--all]         what is live now (--all: ended too,
      [--local] [--remote]             --local: registry only, --remote: one peer)
acp session rename <agent> [s] <title> rename a session
acp session close  <agent> [session]
acp session prune  [agent]             drop records the peers no longer hold
acp session log    <agent> [session]   replay transcript (--tail N)

acp send [--from ADDR] [--oneway] <to> <message>   one turn
      --title "..." --quiet --json --thoughts --timeout S
acp chat [--from ADDR] <to>            interactive multi-turn
```

`acp session <agent> <verb>` is accepted as well as `acp session <verb> <agent>`.

### Addresses

Every session has an address: `<session id>@<agent>` (e.g. `sess_1@reviewer`).
`send` and `chat` take one as their target (`<to>`); `new@<agent>` means
"start a session here" rather than continuing one -- it only makes sense as
the target, since there's nothing to send *from* a session that doesn't
exist yet. Anywhere an address is expected, a bare session id or title works
too: it's looked up across every session anyone knows about (this machine's
registry, and whatever every reachable daemon is actually holding) and
resolved for you -- erroring instead of guessing if more than one matches.

`--from ADDR` names the sender's own address -- a human sending a message
normally omits it; an agent relaying a message on another agent's behalf
should always pass one, and should always pass a full `id@agent` address for
both `--from` and `<to>` rather than relying on the id/title lookup (which
can be ambiguous and isn't meant for a caller that already knows exactly
which session it's calling from). It's recorded on the transcript entry so a
relayed conversation can be traced back to its source.

`--oneway` hands the message to the daemon and returns immediately, without
waiting for (or printing) a reply -- needs a `ws://` daemon behind the target,
since a `stdio:` agent's process doesn't outlive the command that spawned it.

`session ls` asks every reachable daemon and shows what it is actually holding,
so a conversation started in the web UI appears and one closed there disappears.
A local record the daemon disowns is marked `ended` and kept out of the default
view; `--all` shows it and `prune` deletes it. A peer that cannot be reached is
left alone -- silence is not proof of death -- and its count reads `1?` in
`agent ls`. Transcripts survive a prune, and `acp send <id>@<agent> ...`
still reloads a session by id afterwards.

Every session gets a title the moment it is created -- `send new@<agent> --title "..."`
if given, else `<agent>-<yyyy.MM.dd HH:mm:ss>` -- rather than waiting on the
first prompt to name it. `session rename` changes it later; both are our own
convention on top of ACP (which has no client-writable session name), so
they work over `ws://` (always our own daemon) and are local-only bookkeeping
over `stdio:` (a bare agent process). Renaming from the CLI, the web UI, or
another machine's CLI against the same daemon all show up in each other's
`session ls`.

## Web UI

[acp-ui][ui] is a browser client for the same daemons -- a chat surface with
voice in and out. `acp-setup` fetches and builds it; `acp-ui` serves the result
as static files. Nothing proxies through that server: the page dials the daemon
itself.

[ui]: https://github.com/7x24labs/acp-ui

```
acp-setup       # link commands, then clone acp-ui, build it, keep only dist/
acp-ui          # static-serve it on http://127.0.0.1:8000
```

`acp-setup` is setup and `acp-ui` is a server; they stay apart so the thing that
runs all day has no build machinery in it, and re-running setup does not
interrupt serving.

```
acp-setup [--src DIR] [--dest DIR] [--link-dir DIR] [--no-link] [--no-ui]
acp-ui    [--port N] [--host H] [--root DIR] [-v]
```

Setup clones into a temporary directory under `~/.acp/build`, builds, copies
`dist/` to `~/.claude/plugins/marketplaces/7x24labs/plugins/acp-tools/ui`, and
deletes the checkout -- only the built UI is kept, so every run pays for a
fresh clone and a fresh `npm install` (about half a minute). A run that is
killed leaves its checkout behind; the next run sweeps it. `--src DIR` builds a
checkout you already have, and never deletes it -- that is the one to use while
editing the UI locally.

`--dest` and `--link-dir` move the destinations; `ACP_UI_REPO`, `ACP_UI_REF`,
`ACP_UI_WORK`, `ACP_UI_DEST`, `ACP_LINK_DIR`, `ACP_UI_PORT` and `ACP_UI_HOST`
are the environment equivalents. Re-run `acp-setup` to pick up a newer acp-ui.

Linking is idempotent: a link setup already made is repointed, and a real file
or a symlink to something else with that name is reported and left alone.

The destination is swapped in only after a successful build, so a broken build
leaves the previously published UI serving. Fingerprinted `assets/` are sent
`immutable`; `index.html` is sent `no-cache`, so a rebuild reaches open tabs on
reload. Unknown paths without a file extension fall back to `index.html` for
client-side routing.

**Agents must be reachable without token auth.** A browser cannot set an
`Authorization` header on a WebSocket, so the daemons the UI talks to have to
run `acp serve --no-auth`, behind a proxy that authenticates for it, or on a
host where you accept that anyone who can reach the port can drive the agent.

## Sessions and multi-turn

A session is one continuous conversation; every `acp send` to the same
address is another turn, and the peer keeps its context between them.

Where that state lives depends on the transport:

- **`ws://`** -- the daemon holds the session in a live agent subprocess, so
  it survives across separate `acp` invocations. If the daemon is restarted,
  the next `send` transparently reloads the session with ACP's
  `session/load`.
- **`stdio:`** -- each command spawns a fresh agent process, so `acp` issues
  `session/load` per command to restore context. Agents that do not advertise
  `loadSession` cannot do multi-turn this way; use `acp chat`, which holds one
  process open, or put the agent behind a daemon.

## Configuration

Everything lives in one file, `~/.acp/config.json` (override with `ACP_HOME`),
written atomically under a lock so concurrent commands do not clobber it.

```json
{
  "version": 1,
  "identity": "box-a",
  "server": {
    "host": "127.0.0.1",
    "port": 7431,
    "token": "generated-on-first-run",
    "agent": { "command": "npx", "args": ["-y", "@zed-industries/claude-code-acp"], "env": {} },
    "permissionMode": "allow",
    "fsScope": "session-cwd",
    "idleTimeoutMs": 1800000
  },
  "agents": {
    "reviewer": { "url": "ws://box-b:7431", "cwd": "/workspace/api", "token": "..." }
  },
  "sessions": {
    "reviewer/sess_01": { "agent": "reviewer", "sessionId": "sess_01", "state": "active", "turns": 4 }
  }
}
```

Transcripts are appended to `~/.acp/logs/<agent>/<session>.jsonl`.

`server.agent` is any ACP agent that speaks stdio -- `claude-code-acp`,
`gemini --experimental-acp`, or your own.

## Security

- The daemon binds `127.0.0.1` by default. `--host 0.0.0.0` exposes it and
  logs a warning.
- Every WebSocket handshake must carry `Authorization: Bearer <token>`
  matching `server.token`; it is compared with `timingSafeEqual`. A token is
  generated on first run. `--no-auth` disables this and says so loudly.
- `fsScope: "session-cwd"` (default) confines agent file reads and writes to
  the session's directory; a path outside it is rejected before any I/O.
- `permissionMode` decides how `session/request_permission` is answered
  without a human present. It defaults to `allow`, which is what makes
  unattended delegation work -- set it to `deny` for a peer you do not
  fully trust, and remember an agent you can prompt is an agent that can run
  commands in its own `cwd`.
- Treat a peer's replies as untrusted text: data to evaluate, not
  instructions to follow.
- The web UI cannot present a bearer token -- browsers do not allow custom
  headers on a WebSocket handshake -- so a daemon it can reach is a daemon
  anyone reaching that port can drive. Keep those bound to `127.0.0.1`.

## Tests

```
bash test/e2e.sh
```

Drives the real CLI against a mock ACP agent (`test/mock-agent.js`) -- no
network, no model calls. Covers both transports, multi-turn, the fs scope
guard, permission policy, pause cancelling a running turn, daemon-restart
session reload, and one agent consulting another through a second daemon.

## What is not implemented

- ACP terminal methods (`terminal/create` and friends). We advertise
  `terminal: false`, so agents use their own shells -- which is what you want
  when the agent already runs beside the repo.
- `authenticate` / `logout`. Peer auth is the daemon's bearer token.
- Image and audio content blocks are passed through but rendered as
  placeholders in terminal output.
