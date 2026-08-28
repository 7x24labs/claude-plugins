#!/usr/bin/env bash
# End-to-end test for the acp CLI. Uses a mock ACP agent, so it spends no
# model calls and needs no network. Run: bash test/e2e.sh
set -uo pipefail

HERE="$(cd -P "$(dirname "$0")" && pwd)"
export ACP_BIN="$HERE/../bin/acp"
MOCK="$HERE/mock-agent.js"
WORK="$(mktemp -d)"
PORT_B=${PORT_B:-7455}
PORT_C=${PORT_C:-7456}
PIDS=()

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok    %s\n' "$1"; }
no()   { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '        got: %s\n' "$2"; }
check(){ # check <name> <expected-substring> <actual>
  case "$3" in (*"$2"*) ok "$1";; (*) no "$1" "$(printf '%s' "$3" | head -3 | tr '\n' '|')";; esac
}

cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  sleep 0.3
  rm -rf "$WORK"
}
trap cleanup EXIT

mkrepo() { mkdir -p "$WORK/$1"; echo "content of $1" > "$WORK/$1/note.txt"; }
mkrepo repo; mkrepo repo2

# `acp session new` is gone -- a session is now only created via `send --new`
# (or `chat --new`). This drives one real turn to create one and prints its
# id, same shape the old `session new` gave callers below. `--json` streams
# one line per update plus a final result line -- only the last line is the
# {sessionId, stopReason, text} result.
new_session() { # new_session <agent> [more send flags...]
  "$ACP_BIN" send "$@" --new --json hello 2>/dev/null | node -e '
    let d = "";
    process.stdin.on("data", (c) => { d += c; });
    process.stdin.on("end", () => {
      const lines = d.trim().split("\n");
      try { process.stdout.write(JSON.parse(lines[lines.length - 1]).sessionId || ""); } catch { /* empty */ }
    });
  '
}

# Write a daemon config that spawns the mock agent.
daemon_cfg() { # daemon_cfg <home> <identity> <port> <token> [agent-env-json]
  ACP_HOME="$1" "$ACP_BIN" status >/dev/null 2>&1
  node -e '
    const fs=require("fs"), p=process.argv[1]+"/config.json";
    const c=JSON.parse(fs.readFileSync(p,"utf8"));
    c.identity=process.argv[2]; c.server.port=+process.argv[3]; c.server.token=process.argv[4];
    c.server.agent={command:"node",args:[process.argv[5]],env:JSON.parse(process.argv[6]||"{}")};
    fs.writeFileSync(p, JSON.stringify(c,null,2));
  ' "$1" "$2" "$3" "$4" "$MOCK" "${5:-{\}}"
}

wait_up() { # wait_up <logfile>
  for _ in $(seq 1 100); do grep -q listening "$1" 2>/dev/null && return 0; sleep 0.1; done
  echo "daemon never came up; log:"; cat "$1"; return 1
}

echo "== stdio transport (no daemon) =="
export ACP_HOME="$WORK/home_stdio"
check "agent add"    'added agent "local"' "$("$ACP_BIN" agent add local "stdio:node $MOCK" "$WORK/repo" 2>&1)"
check "agent ls"     'local'               "$("$ACP_BIN" agent ls 2>&1)"
SID=$(new_session local)
check "send --new creates a session" 'sess_' "$SID"
check "turn 1"       'you said "one"'      "$("$ACP_BIN" send local "$SID" --quiet one 2>&1)"
check "turn 2 reuses session" 'you said "two"' "$("$ACP_BIN" send local --quiet two 2>&1)"
check "turn count"   'local  '             "$("$ACP_BIN" session ls 2>&1)"
check "fs read"      'content of repo'     "$("$ACP_BIN" send local --quiet "read $WORK/repo/note.txt" 2>&1)"
check "fs scope"     'outside the session scope' "$("$ACP_BIN" send local --quiet "read /etc/hostname" 2>&1)"
check "stdio close is local" 'local record' "$("$ACP_BIN" session close local "$SID" 2>&1)"
check "stdio rename is local" 'local record' "$("$ACP_BIN" session rename local "$SID" "renamed locally" 2>&1)"
check "stdio rename sticks locally" 'renamed locally' "$("$ACP_BIN" session ls local 2>&1)"

echo "== ws transport (daemon) =="
daemon_cfg "$WORK/home_b" box-b "$PORT_B" tokenB
ACP_HOME="$WORK/home_b" "$ACP_BIN" serve -v > "$WORK/b.log" 2>&1 & PIDS+=($!)
wait_up "$WORK/b.log" || exit 1

export ACP_HOME="$WORK/home_cli"
"$ACP_BIN" agent add reviewer "ws://127.0.0.1:$PORT_B" "$WORK/repo" --token tokenB >/dev/null
"$ACP_BIN" agent add badtok  "ws://127.0.0.1:$PORT_B" "$WORK/repo" --token WRONG   >/dev/null
check "bad token rejected" '401'          "$("$ACP_BIN" status badtok 2>&1)"
check "status"             'identity   box-b' "$("$ACP_BIN" status reviewer 2>&1)"
WSID=$(new_session reviewer)
check "send --new creates a session over ws" 'sess_' "$WSID"
check "ws turn 2"          'you said "alpha"' "$("$ACP_BIN" send reviewer "$WSID" --quiet alpha 2>&1)"
check "ws turn 3 is live"  'you said "beta"'  "$("$ACP_BIN" send reviewer --quiet beta 2>&1)"
check "session ls --remote" "$WSID"       "$("$ACP_BIN" session ls reviewer --remote 2>&1)"
check "session ls is live"  "$WSID"       "$("$ACP_BIN" session ls reviewer 2>&1)"
check "agent ls counts live" ' 1'         "$("$ACP_BIN" agent ls 2>&1 | grep reviewer)"

echo "== naming =="
NAMED=$(new_session reviewer)
NAMED_ROW="$("$ACP_BIN" session ls reviewer --remote 2>&1 | grep "$NAMED")"
if [[ "$NAMED_ROW" =~ reviewer-[0-9]{4}\.[0-9]{2}\.[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2} ]]
then ok "untitled session defaults to <agent>-<timestamp>"
else no "untitled session defaults to <agent>-<timestamp>" "$NAMED_ROW"
fi
# `new_session` (unlike a plain `| grep -q sessionId`) drains the whole
# --json stream before checking anything -- closing that pipe early, mid-turn,
# kills the CLI's websocket out from under the daemon, which does not guard
# its next write against a socket that just closed and crashes outright,
# taking down every other client's connection with it.
new_session reviewer --title "call it bob" >/dev/null
check "explicit title at creation" 'call it bob' "$("$ACP_BIN" session ls reviewer --remote 2>&1)"
check "rename by id"    'renamed for real' "$("$ACP_BIN" session rename reviewer "$NAMED" "renamed for real" 2>&1)"
check "rename sticks"   'renamed for real' "$("$ACP_BIN" session ls reviewer --remote 2>&1 | grep "$NAMED")"
check "a real message does not undo a rename" 'renamed for real'   "$("$ACP_BIN" send reviewer "$NAMED" --quiet "does this rename the session" >/dev/null 2>&1; "$ACP_BIN" session ls reviewer --remote 2>&1 | grep "$NAMED")"
check "rename with no id renames latest" 'latest one' "$("$ACP_BIN" session rename reviewer "latest one" 2>&1)"
check "permission policy"  '"optionId":"yes"' "$("$ACP_BIN" send reviewer --quiet "permission check" 2>&1)"
check "daemon-side fs"     'content of repo' "$("$ACP_BIN" send reviewer --quiet "read $WORK/repo/note.txt" 2>&1)"

echo "== daemon restart recovery =="
check "rename before restart" 'renamed one' "$("$ACP_BIN" session rename reviewer "$WSID" "renamed one" 2>&1)"
kill "${PIDS[-1]}" 2>/dev/null; sleep 0.6
check "peer down error" 'Start the daemon' "$("$ACP_BIN" send reviewer "$WSID" hi 2>&1)"
# Silence is not proof of death: a daemon we cannot reach keeps its records.
check "unreachable keeps record"   "$WSID"            "$("$ACP_BIN" session ls reviewer 2>&1)"
check "unreachable prunes nothing" 'nothing to prune' "$("$ACP_BIN" session prune reviewer 2>&1)"
REVIEWER_ROW="$("$ACP_BIN" agent ls 2>&1 | grep reviewer)"
if [[ "$REVIEWER_ROW" =~ [0-9]+\? ]]
then ok "unreachable count is a guess"
else no "unreachable count is a guess" "$REVIEWER_ROW"
fi
ACP_HOME="$WORK/home_b" "$ACP_BIN" serve -v > "$WORK/b2.log" 2>&1 & PIDS+=($!)
wait_up "$WORK/b2.log" || exit 1
# The restarted daemon holds nothing, so the record is no longer live -- but it
# is still on file, and still reloadable by id.
check "restart demotes record" 'no sessions for' "$("$ACP_BIN" session ls reviewer 2>&1)"
check "--all still shows it"   'ended'           "$("$ACP_BIN" session ls reviewer --all 2>&1)"
check "prune drops the dead"   "$WSID"           "$("$ACP_BIN" session prune reviewer 2>&1)"
check "pruned for good" 'no sessions for'        "$("$ACP_BIN" session ls reviewer --all 2>&1)"
check "transcript outlives it" '>>'              "$("$ACP_BIN" session log reviewer "$WSID" --tail 4 2>&1)"
# A pruned record is not a lost session: the daemon reloads it from the id.
check "session reloaded" 'you said "after restart"' "$("$ACP_BIN" send reviewer "$WSID" --quiet "after restart" 2>&1)"
check "reload relists it live" "$WSID"           "$("$ACP_BIN" session ls reviewer 2>&1)"
check "send with no id reuses it" 'you said "again"' "$("$ACP_BIN" send reviewer --quiet again 2>&1)"

# The reload above went through a fresh in-memory entry with no title -- if the daemon didn't
# recover it from the transcript first, the "again" prompt just sent would have named it instead.
check "title survives the reload too" "$WSID" "$("$ACP_BIN" session ls reviewer --remote 2>&1 | grep 'renamed one')"

echo "== agent to agent =="
daemon_cfg "$WORK/home_c" box-c "$PORT_C" tokenC
ACP_HOME="$WORK/home_c" "$ACP_BIN" serve -v > "$WORK/c.log" 2>&1 & PIDS+=($!)
wait_up "$WORK/c.log" || exit 1
ACP_HOME="$WORK/home_agentB" "$ACP_BIN" agent add peer-c "ws://127.0.0.1:$PORT_C" "$WORK/repo2" --token tokenC >/dev/null
kill "${PIDS[-2]}" 2>/dev/null; sleep 0.5
daemon_cfg "$WORK/home_b" box-b "$PORT_B" tokenB "{\"ACP_HOME\":\"$WORK/home_agentB\",\"ACP_BIN\":\"$ACP_BIN\"}"
ACP_HOME="$WORK/home_b" "$ACP_BIN" serve -v > "$WORK/b3.log" 2>&1 & PIDS+=($!)
wait_up "$WORK/b3.log" || exit 1
check "peer consults peer" 'peer-c replied' \
  "$(ACP_HOME="$WORK/home_cli" "$ACP_BIN" send reviewer --new --quiet "relay peer-c what is here" 2>&1)"
check "second hop ran in its own repo" 'repo2' \
  "$(ACP_HOME="$WORK/home_cli" "$ACP_BIN" session log reviewer --tail 4 2>&1)"

echo "== lifecycle + arg order =="
export ACP_HOME="$WORK/home_cli"
ALT=$(new_session reviewer)
check "have a session to close" 'sess_'  "$ALT"
check "acp session <agent> ls"  'AGENT'  "$("$ACP_BIN" session reviewer ls 2>&1)"
check "close"                   'closed' "$("$ACP_BIN" session close reviewer "$ALT" 2>&1)"
check "closed refuses"          'is closed' "$("$ACP_BIN" send reviewer "$ALT" x 2>&1)"
check "transcript"              '>>'     "$("$ACP_BIN" session log reviewer "$WSID" --tail 4 2>&1)"
check "prune keeps the live"   'active' "$("$ACP_BIN" session ls reviewer 2>&1)"
check "nothing left to prune"  'nothing to prune' "$("$ACP_BIN" session prune reviewer 2>&1)"
check "agent remove"            'removed' "$("$ACP_BIN" agent remove badtok 2>&1)"
check "unknown agent"           'unknown agent' "$("$ACP_BIN" send ghost hi 2>&1)"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
