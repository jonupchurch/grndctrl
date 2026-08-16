---
description: Fast orientation pass on an unfamiliar repo — delegates deep recon to codebase-scout in the background while giving you an immediate high-level read.
argument-hint: "[optional: a specific area/feature to focus the recon on]"
---

Orient in this codebase. Optimize for speed — this runs at the *start* of a
session, often while I'm talking to a client/interviewer.

1. **Immediate foreground read** (do this yourself, keep it to seconds): from
   the README, package manifest / build config, and top-level directory
   layout, tell me the language, framework(s), architectural style, entry
   points, and how a request/action flows through the app. A few bullets.

2. **Delegate deep recon to the background**: spin off the `codebase-scout`
   subagent (read-only) to investigate further so I'm not blocked on it. If
   `$ARGUMENTS` is provided, point it at that specific area/feature; otherwise
   have it map the conventions I'll most need to match — how similar features
   are structured, where new code of the common kinds goes, the test and
   validation patterns, and any open questions worth asking the client.

3. **Report back** the foreground read now, and note that scout is running in
   the background. Don't wait on scout before responding to me.

Do not edit, install, or commit anything during orientation.
