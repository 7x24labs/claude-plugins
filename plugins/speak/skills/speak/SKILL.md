---
name: speak
description: One-way text-to-speech for Claude Code replies via gTTS -- no dictation, no push-to-talk, no background service. Use when the user says "speak", "toggle speech/TTS", or asks Claude to read replies aloud.
---

# Speak

Reads assistant replies aloud. No microphone input and nothing to install or
run in the background -- it only speaks text via gTTS, run as a plain stdio
MCP subprocess (`server/speak_server.py`, launched on demand by `uv run`).
Playback picks whatever player is available on the current platform (macOS,
Windows, Linux, or WSL) rather than requiring one specific tool.

## Toggle

`/speak` calls `mcp__speak__speak_toggle`, which flips a boolean in
`~/.speak/state.json` and reports the new state. Persists across turns and
MCP reconnects.

## Accent

`/accent <name>` calls `mcp__speak__set_accent`, which sets the gTTS
regional accent (e.g. `uk`, `australia`, `india`) also stored in
`~/.speak/state.json`. Run `/accent` with no argument to see the full list.

## While speech is ON

After finishing a reply (or when narrating an action), call
`mcp__speak__say(text=...)` with a short, spoken-friendly version of what you
said -- fire it without blocking on other tool calls. If speech is OFF,
`say` is a silent no-op, so it's safe to skip calling it rather than
tracking state yourself -- but prefer just not calling it once you know it's
off.
