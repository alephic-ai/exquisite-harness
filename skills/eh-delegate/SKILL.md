---
name: eh-delegate
description: Delegate a focused task to another configured agent through eh.
---

# Delegate with eh

Use `eh ask` when a task is well-scoped and another configured harness should
handle it. Keep the delegated prompt self-contained: include the goal, relevant
context, constraints, and the expected output. Do not include API keys or other
secrets.

```bash
printf '%s' "$TASK" | eh ask <harness> <provider> <model>
```

`eh ask` is a one-shot, non-interactive command. It reads the prompt from stdin
and emits versioned NDJSON on stdout; stderr belongs to the harness. Read
`assistant.text` events for the response, and treat `run.error` or a non-zero
`run.completed.exitCode` as failure. Preserve the complete event stream when
debugging rather than assuming every harness produces the same native events.

Use explicit target arguments so delegation is reproducible. Set a reasonable
external timeout, and avoid asking the delegated agent to delegate again unless
your orchestration policy explicitly permits recursion. Summarize the result for
the caller and distinguish the delegated agent's claims from your own
verification.

Useful options include `--reasoning-effort`, `--gateway-provider`,
`--native-args-json`, and `--resume-session`.
