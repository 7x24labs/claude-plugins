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

Then, if you want the web UI, run setup once:

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
  │ acp send B "..."  ─────┼──────────────►│      ↓ spawns              │
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
acp send reviewer "review the auth changes on branch fix/login"
acp send reviewer "now check the tests for those files"     # same session
```

For a local peer with no daemon at all:

```
acp agent add local "stdio:npx -y @zed-industries/claude-code-acp" /workspace/api
acp send local "summarise the README"
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

acp session ls [agent] [--remote]      local registry, or the peer's live view
acp session new <agent> [--cwd DIR]
acp session pause  <agent> [session]   cancel the running turn, refuse new ones
acp session resume <agent> [session]   allow prompts again
acp session close  <agent> [session]
acp session rm     <agent> [session]
acp session log    <agent> [session]   replay transcript (--tail N)

acp send <agent> [session] <message>   one turn, streamed
      --new --quiet --json --thoughts --timeout S
acp chat <agent> [session]             interactive multi-turn
```

`acp session <agent> <verb>` is accepted as well as `acp session <verb> <agent>`.

## Web UI

[acp-ui][ui] is a browser client for the same daemons -- a chat surface with
voice in and out. `acp-setup` fetches and builds it; `acp-ui` serves the result
as static files. Nothing proxies through that server: the page dials the daemon
itself.

[ui]: https://github.com/7x24labs/acp-ui

```
acp-setup       # clone/update acp-ui, npm install, vite build, publish dist/
acp-ui          # static-serve it on http://127.0.0.1:8000
```

`acp-setup` is setup and `acp-ui` is a server; they stay apart so the thing that
runs all day has no build machinery in it, and re-running setup does not
interrupt serving.

```
acp-setup [--src DIR] [--dest DIR] [--no-sync]
acp-ui    [--port N] [--host H] [--root DIR] [-v]
```

The checkout lives in `~/.acp/build/acp-ui` and the build is published to
`~/.claude/plugins/marketplaces/7x24labs/plugins/acp-tools/ui`. Both move with
`ACP_UI_SRC` / `ACP_UI_DEST`; `ACP_UI_REPO`, `ACP_UI_REF`, `ACP_UI_PORT` and
`ACP_UI_HOST` cover the rest. `--no-sync` builds the checkout as it stands,
which is what you want when you are editing the UI locally. Re-run `acp-setup`
to pick up a newer acp-ui.

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
session id is another turn, and the peer keeps its context between them.

Where that state lives depends on the transport:

- **`ws://`** -- the daemon holds the session in a live agent subprocess, so
  it survives across separate `acp` invocations. If the daemon is restarted,
  the next `send` transparently reloads the session with ACP's
  `session/load`.
- **`stdio:`** -- each command spawns a fresh agent process, so `acp` issues
  `session/load` per command to restore context. Agents that do not advertise
  `loadSession` cannot do multi-turn this way; use `acp chat`, which holds one
  process open, or put the agent behind a daemon.

`pause` maps to ACP `session/cancel` plus a local state flag: it interrupts
the running turn and makes further sends fail until `resume`. That is a real
interrupt -- an in-flight turn comes back with `stopReason: cancelled`.

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
