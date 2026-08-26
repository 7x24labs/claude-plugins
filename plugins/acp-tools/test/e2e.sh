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
SID=$("$ACP_BIN" session new local 2>/dev/null)
check "session new"  'sess_'               "$SID"
check "turn 1"       'you said "one"'      "$("$ACP_BIN" send local "$SID" --quiet one 2>&1)"
check "turn 2 reuses session" 'you said "two"' "$("$ACP_BIN" send local --quiet two 2>&1)"
check "turn count"   'local  '             "$("$ACP_BIN" session ls 2>&1)"
check "fs read"      'content of repo'     "$("$ACP_BIN" send local --quiet "read $WORK/repo/note.txt" 2>&1)"
check "fs scope"     'outside the session scope' "$("$ACP_BIN" send local --quiet "read /etc/hostname" 2>&1)"
check "stdio pause is local" 'local record' "$("$ACP_BIN" session pause local "$SID" 2>&1)"

echo "== ws transport (daemon) =="
daemon_cfg "$WORK/home_b" box-b "$PORT_B" tokenB
ACP_HOME="$WORK/home_b" "$ACP_BIN" serve -v > "$WORK/b.log" 2>&1 & PIDS+=($!)
wait_up "$WORK/b.log" || exit 1

export ACP_HOME="$WORK/home_cli"
"$ACP_BIN" agent add reviewer "ws://127.0.0.1:$PORT_B" "$WORK/repo" --token tokenB >/dev/null
"$ACP_BIN" agent add badtok  "ws://127.0.0.1:$PORT_B" "$WORK/repo" --token WRONG   >/dev/null
check "bad token rejected" '401'          "$("$ACP_BIN" status badtok 2>&1)"
check "status"             'identity   box-b' "$("$ACP_BIN" status reviewer 2>&1)"
WSID=$("$ACP_BIN" session new reviewer 2>/dev/null)
check "ws session new"     'sess_'        "$WSID"
check "ws turn 1"          'turn 1'       "$("$ACP_BIN" send reviewer "$WSID" --quiet alpha 2>&1)"
check "ws turn 2 is live"  'turn 2'       "$("$ACP_BIN" send reviewer --quiet beta 2>&1)"
check "session ls --remote" "$WSID"       "$("$ACP_BIN" session ls reviewer --remote 2>&1)"
check "permission policy"  '"optionId":"yes"' "$("$ACP_BIN" send reviewer --quiet "permission check" 2>&1)"
check "daemon-side fs"     'content of repo' "$("$ACP_BIN" send reviewer --quiet "read $WORK/repo/note.txt" 2>&1)"

echo "== pause / resume =="
check "pause"              'paused'       "$("$ACP_BIN" session pause reviewer "$WSID" 2>&1)"
check "paused refuses"     'is paused'    "$("$ACP_BIN" send reviewer "$WSID" nope 2>&1)"
check "resume"             'resumed'      "$("$ACP_BIN" session resume reviewer "$WSID" 2>&1)"
check "send after resume"  'you said "gamma"' "$("$ACP_BIN" send reviewer "$WSID" --quiet gamma 2>&1)"

"$ACP_BIN" send reviewer "$WSID" --json "slow one" > "$WORK/slow.out" 2>&1 &
SLOW=$!
sleep 0.8
"$ACP_BIN" session pause reviewer "$WSID" >/dev/null 2>&1
wait $SLOW 2>/dev/null
check "pause cancels a running turn" '"stopReason":"cancelled"' "$(cat "$WORK/slow.out")"
"$ACP_BIN" session resume reviewer "$WSID" >/dev/null 2>&1

echo "== daemon restart recovery =="
kill "${PIDS[-1]}" 2>/dev/null; sleep 0.6
check "peer down error" 'Start the daemon' "$("$ACP_BIN" send reviewer "$WSID" hi 2>&1)"
ACP_HOME="$WORK/home_b" "$ACP_BIN" serve -v > "$WORK/b2.log" 2>&1 & PIDS+=($!)
wait_up "$WORK/b2.log" || exit 1
check "session reloaded" 'you said "after restart"' "$("$ACP_BIN" send reviewer "$WSID" --quiet "after restart" 2>&1)"

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
ALT=$("$ACP_BIN" session reviewer new 2>/dev/null)
check "acp session <agent> new" 'sess_'  "$ALT"
check "acp session <agent> ls"  'AGENT'  "$("$ACP_BIN" session reviewer ls 2>&1)"
check "close"                   'closed' "$("$ACP_BIN" session close reviewer "$ALT" 2>&1)"
check "closed refuses"          'is closed' "$("$ACP_BIN" send reviewer "$ALT" x 2>&1)"
check "rm"                      'deleted' "$("$ACP_BIN" session rm reviewer "$ALT" 2>&1)"
check "transcript"              '>>'     "$("$ACP_BIN" session log reviewer "$WSID" --tail 4 2>&1)"
check "agent remove"            'removed' "$("$ACP_BIN" agent remove badtok 2>&1)"
check "unknown agent"           'unknown agent' "$("$ACP_BIN" send ghost hi 2>&1)"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
