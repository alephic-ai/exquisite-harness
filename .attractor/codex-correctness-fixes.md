## Fix: Unwritable --result-file drops the run.completed terminal event
- **Reviewer:** Codex
- **File:** src/headless-run.ts
- **Line:** 390-391 (also 363-367)
- **Current:** `await writeResultFile(options.resultFile, resultText)` then `emit({ exitCode, resultIsError, type: 'run.completed' })`
- **Fix:** Wrap the result-file write so a write failure cannot pre-empt the terminal event — emit `run.completed` (and a `run.error`) with a non-zero exit code even when `writeFile` rejects, because an unwritable path currently throws past `runHeadless`'s catch (`state.executionStarted` is true) and the documented "run.completed is always the final line" guarantee is lost.
