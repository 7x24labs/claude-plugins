#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "fastmcp>=2.0,<3",
#     "gTTS>=2.5",
# ]
# ///
"""Minimal stdio MCP server exposing three tools: speak_toggle(), set_accent(),
and say(text).

No microphone, no dictation, no HTTP server or background service -- `say`
shells out to gTTS on demand and plays the result with whatever audio player
is available on the current platform. Launched by Claude Code as a plain
subprocess via `uv run` (see .mcp.json); `uv` resolves the dependencies
above into an ephemeral venv, so there's no install step.
"""

import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastmcp import FastMCP
from gtts import gTTS

STATE_FILE = Path.home() / ".speak" / "state.json"

# https://gtts.readthedocs.io/en/latest/module.html#localized-accents
ACCENTS = {
    "default": "com",
    "us": "us",
    "uk": "co.uk",
    "australia": "com.au",
    "canada": "ca",
    "india": "co.in",
    "ireland": "ie",
    "south-africa": "co.za",
    "nigeria": "com.ng",
}

def _read_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    return json.loads(STATE_FILE.read_text())

def _write_state(**updates) -> None:
    state = _read_state()
    state.update(updates)
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state))

def _is_wsl() -> bool:
    if platform.system() != "Linux":
        return False
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False

def _player_candidates() -> list[list[str]]:
    """Ordered list of [executable, *flags] to try, checked with shutil.which."""
    system = platform.system()
    if system == "Darwin":
        return [["afplay"]]  # built into macOS, no install needed
    if _is_wsl():
        return [
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"],
            ["mpg123", "-q"],
            ["paplay"],
        ]
    if system == "Linux":
        return [
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"],
            ["mpg123", "-q"],
            ["mpv", "--no-video", "--really-quiet"],
            ["paplay"],
        ]
    if system == "Windows":
        return [["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]]
    return []

def _play(path: str) -> str:
    for cmd in _player_candidates():
        exe = shutil.which(cmd[0])
        if not exe:
            continue
        try:
            subprocess.run([exe, *cmd[1:], path], check=True, capture_output=True, timeout=30)
            return "spoken"
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
            continue

    # No CLI player found -- hand off to the OS's default handler instead of failing.
    if platform.system() == "Windows":
        os.startfile(path)  # noqa: S606 -- Windows-only, opens the default media app
        return "spoken (opened in default player)"
    if _is_wsl() and shutil.which("wslpath") and shutil.which("powershell.exe"):
        win_path = subprocess.run(
            ["wslpath", "-w", path], capture_output=True, text=True, check=True
        ).stdout.strip()
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", f"Start-Process -FilePath '{win_path}'"],
            check=True,
        )
        return "spoken (opened via Windows)"

    return (
        "could not play audio -- no supported player found. "
        "Install one of: ffmpeg (ffplay), mpg123, mpv"
    )

mcp = FastMCP("speak")

@mcp.tool
def speak_toggle() -> str:
    """Toggle text-to-speech on/off. Returns the new state."""
    enabled = not _read_state().get("enabled", False)
    _write_state(enabled=enabled)
    return f"Speech is now {'ON' if enabled else 'OFF'}"

@mcp.tool
def set_accent(accent: str) -> str:
    """Set the accent used for spoken replies.

    One of: default, us, uk, australia, canada, india, ireland,
    south-africa, nigeria. 'default' uses the local accent Google infers
    from network location.
    """
    key = accent.strip().lower()
    if key not in ACCENTS:
        return f"Unknown accent '{accent}'. Choose one of: {', '.join(ACCENTS)}"
    _write_state(tld=ACCENTS[key])
    return f"Accent set to {key}"

@mcp.tool
def say(text: str) -> str:
    """Speak text aloud via gTTS. Silent no-op if speech is currently off."""
    state = _read_state()
    if not state.get("enabled", False):
        return "Speech is off -- nothing spoken"

    tld = state.get("tld", "com")
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        gTTS(text=text, tld=tld).write_to_fp(f)
        path = f.name

    try:
        return _play(path)
    finally:
        Path(path).unlink(missing_ok=True)

if __name__ == "__main__":
    mcp.run()
