## Fix: Timed-out run reports success when the child traps SIGTERM and exits 0

- **Reviewer:** Codex
- **File:** src/headless-run.ts
- **Line:** 295-306
- **Current:**
  `const resultIsError = state.resultIsError || childExitCode !== 0`
- **Fix:** Fold `timeout.fired` into the result so a timed-out lane fails
  loudly, e.g.
  `const resultIsError = state.resultIsError || childExitCode !== 0 || timeout.fired`
  and force a non-zero `exitCode` when `timeout.fired`, otherwise a child that
  handles SIGTERM and exits 0 emits `run.error` yet reports
  `run.completed { exitCode: 0, resultIsError: false }`.
