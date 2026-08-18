## Codex Review Complete

**Files reviewed**: 8 **Issues found**: 2 **Blockers**: 1 **Suggestions**: 1

---

## Verdict

**Mergeable**: NO **Blockers**: src/headless-run.ts:303 - Inferred from the
existing failure contract, a timed-out child that handles SIGTERM and exits 0
emits `run.error` but final `run.completed` reports success; include
`timeout.fired` in the result error calculation and force a non-zero wrapper
exit when the child exit code is 0. **Suggestions**: README.md:181 - The docs
say a timed-out child exits 143, but the implemented escalation path can report
137 after SIGKILL; document signal-dependent timeout exit codes instead.

## Findings

- **Blocker:** src/headless-run.ts:303 — Inferred from the existing failure
  contract, a timed-out child that handles SIGTERM and exits 0 emits `run.error`
  but final `run.completed` reports success. Fix: Include `timeout.fired` in the
  result error calculation and force a non-zero wrapper exit when the child exit
  code is 0.
- **Suggestion:** README.md:181 — The docs say a timed-out child exits 143, but
  the implemented escalation path can report 137 after SIGKILL. Change: Document
  signal-dependent timeout exit codes instead.
