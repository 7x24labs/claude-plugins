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
