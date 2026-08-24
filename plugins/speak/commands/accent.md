---
description: Choose the accent used for spoken replies (gTTS regional voice)
argument-hint: [default|us|uk|australia|canada|india|ireland|south-africa|nigeria]
---

The user's chosen accent, if given, is in $ARGUMENTS.

- If $ARGUMENTS is non-empty, call `mcp__speak__set_accent` with it now and
  relay the tool's result in one short sentence.
- If $ARGUMENTS is empty, ask the user which accent they want, listing the
  valid names: default, us, uk, australia, canada, india, ireland,
  south-africa, nigeria (`default` uses the local accent Google infers from
  network location).
