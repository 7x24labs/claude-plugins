---
description: Show registered ACP agents and their sessions
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/acp agent ls` and
`${CLAUDE_PLUGIN_ROOT}/bin/acp session ls`, then summarise for the user in a
few lines: which peers are registered, where each one works, and which
sessions are active or paused.

If `$ARGUMENTS` names an agent, probe it with
`${CLAUDE_PLUGIN_ROOT}/bin/acp status $ARGUMENTS` and report whether it is
reachable, which backend answers, and its permission/fs policy.

If nothing is registered, say so and show the one-line form for adding a
peer -- do not register anything without being asked.
