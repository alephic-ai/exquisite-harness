## Fix: Broad catch mislabels post-spawn/cleanup failures as preflight exit 64

- **Reviewer:** Codex
- **File:** src/headless-run.ts
- **Line:** 115-123
- **Current:**
  `} catch (error) { emit({ message: errorMessage(error), type: 'run.error' }); emit({ exitCode: EH_EXIT_PREFLIGHT, resultIsError: true, type: 'run.completed' }); return EH_EXIT_PREFLIGHT }`
- **Fix:** The catch wraps `run.started`, `executeHeadlessPlan`, and both
  `withCleanup` layers, so a post-success teardown failure (grok's `rm` cleanup,
  or `withGatewayRouting`'s `await proxy.close()` in its `finally`) — surfaced
  uncaught by `withCleanup` on the success path — propagates here and emits a
  second `run.completed` returning `64`, the code the PR documents as
  "preflight/usage error — nothing was spawned"; narrow the `64`/preflight path
  to setup-before-execution and stop emitting a duplicate `run.completed` for
  failures raised after the child already completed.
