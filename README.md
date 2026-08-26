# claude-plugins

Claude Code plugin marketplace. Each plugin lives under `plugins/<name>/`.

## Install

```
/plugin marketplace add 7x24labs/claude-plugins
/plugin install speak
```

## Plugins

### speak

Minimal text-to-speech for Claude Code. Toggle spoken replies on/off with
`/speak`, choose a regional accent with `/accent`.

No microphone, no dictation, no background service -- `say` shells out to
gTTS on demand and plays the result with whatever audio player it finds.

Requirements: [`uv`](https://docs.astral.sh/uv/) on `PATH` (runs the bundled
MCP server, resolving its dependencies automatically -- no install step) and
internet access (gTTS calls Google's translate-TTS endpoint). For playback,
one of the following on `PATH`:

- **macOS**: `afplay` (built in, nothing to install)
- **Linux / WSL**: `ffplay` (part of `ffmpeg`), `mpg123`, `mpv`, or `paplay`
  -- whichever is found first is used
- **Windows**: `ffplay` if installed, otherwise falls back to opening the
  file in the default media app
- **WSL without any of the above**: falls back to opening the file via
  Windows (`powershell.exe`)

If no player is found and no fallback applies, `say` returns an explanatory
message instead of failing silently.

Usage: run `/speak` to turn spoken replies on or off. While on, Claude reads
a short version of each reply aloud after responding. Run `/accent` (with no
argument) to see the list of accents, or `/accent uk` to set one directly.

### acp-tools

Agent-to-agent messaging over the [Agent Client Protocol][acp]. Register other
AI agents as named peers -- on this machine or another -- open sessions
against them, and hold multi-turn conversations:

```
acp agent add reviewer ws://box-b:7431 /workspace/api --token <token>
acp send reviewer "review the auth changes on branch fix/login"
acp send reviewer "now check the tests for those files"
```

`acp serve` hosts an agent for others to reach. It is an ACP *proxy*: it
answers callers as an agent and acts as the client for the agent process it
spawns, so file access and permission prompts resolve on the machine that
owns the repo. Token-authenticated WebSocket, loopback by default.

Requirements: Node 20+. No npm dependencies -- the WebSocket client and server
are implemented against RFC 6455 directly. Any stdio ACP agent works as the
backend (`claude-code-acp`, `gemini --experimental-acp`, your own).

[acp]: https://agentclientprotocol.com
