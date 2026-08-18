# `eh run --timeout <seconds>` Implementation Plan

## Goal

Add an optional `--timeout <seconds>` flag to `eh run` so a hung harness lane
fails loudly instead of blocking forever. On expiry, `eh` emits a `run.error`
naming the timeout and the configured limit, sends `SIGTERM`, escalates to
`SIGKILL` after a 10s grace period if the child ignores `SIGTERM`, and still
emits `run.completed` as the final event. Non-positive / non-integer /
non-numeric values fail preflight before spawn. Omitting the flag preserves
today's behavior exactly (no deadline).

## Scope Boundary

- **In scope:** the `--timeout` flag, its preflight validation, the
  timer→SIGTERM→SIGKILL escalation wired into the existing child-lifecycle
  plumbing in `src/headless-run.ts`, tests, docs, and a version bump.
- **Out of scope (do NOT touch):** token/cost budgets; a config-level default
  timeout (per-invocation flag only); reserved exit-code remapping for timeouts
  (the reserved-exit-codes ticket owns that — a timed-out SIGTERM stays `143`,
  indistinguishable by exit code from any other SIGTERM; orchestrators that need
  certainty read the `run.error` event). No new runtime deps —
  `setTimeout`/`clearTimeout` only.

## Context for Implementer

`eh run` is wired in `src/main.ts` (the `run <harness> <provider> <model>`
command, `.action` at line 140) which calls `runHeadless` in
`src/headless-run.ts`. The child harness is spawned in
`executePreparedHeadlessPlan` (`src/headless-run.ts:198`), which already:

- installs `SIGINT`/`SIGTERM` forwarding handlers around the child lifecycle
  (lines 218-226) and removes them in a `finally` (lines 274-278) — the timeout
  hooks into this exact point;
- derives the child exit code as
  `completed.code ?? (signalNumber ? 128 + signalNumber : 1)` (lines 257-261),
  so a `SIGTERM`'d child yields `143` with no new exit-code machinery;
- emits a generic `run.error` when the child exits non-zero without a semantic
  error (lines 262-269), then always emits `run.completed` last (line 272).

Preflight validation belongs alongside the existing effort check in
`runHeadless` (lines 51-56), which runs **before** `emit(run.started)` (line
90). A throw there is caught (lines 108-112) and emits exactly `run.error` then
`run.completed` with exit `1` — the same shape the existing preflight
`test.each` asserts (`src/headless-run.test.ts:228-380`).

**Reference implementation — the existing signal test** that proves child
termination and the `128 + signal` exit code
(`src/headless-run.test.ts:1180-1258`, test name "forwards termination signals
and removes the Grok prompt file"): it spawns `eh run`, waits for the fake
harness's `fake.args` event, kills, and asserts
`exitCode === 128 + os.constants.signals.SIGTERM` plus a `run.completed` with
the same code. The timeout tests reuse this exit-code and event-ordering
approach.

## Load-Bearing Assumptions

1. **Signal handlers wrap the child lifecycle in `executePreparedHeadlessPlan`;
   a `finally` is the cleanup point.** VERIFIED — `src/headless-run.ts:218-226`
   (install) and `:274-278` (`finally` removes them). Timers are cleared in the
   same `finally`.
2. **A `SIGTERM`'d child yields exit `128 + signal` via the existing
   derivation.** VERIFIED — `src/headless-run.ts:257-261`; the existing signal
   test asserts `128 + os.constants.signals.SIGTERM` (`:1231`).
3. **A throw in `runHeadless` before `emit(run.started)` produces exactly
   `[run.error, run.completed(exit 1)]` and never spawns.** VERIFIED — catch at
   `:108-112`; preflight `test.each` at `:228-380` asserts that two-event shape
   and non-zero exit.
4. **`--timeout` is an eh-level flag, never forwarded to the child's argv.**
   VERIFIED — `prepareHeadlessPlan` (`:549-652`) builds child args only from
   `effort`, `harness`, `model`, `nativeArgs`, `resumeSessionId`; it never reads
   a timeout. This is why the invariant test can deep-equal the with-flag and
   no-flag event streams.
5. **The `ollama` provider is a zero-config built-in.** VERIFIED — every
   existing headless test spawns `run codex ollama qwen3-coder` with only an
   empty `XDG_CONFIG_HOME` and passes.
6. **A pending 60s `setTimeout` keeps the `eh` process alive until it fires or
   is cleared (timers are NOT unref'd).** VERIFIED — standard Node timer-ref
   semantics. Load-bearing: the invariant test proves cleanup by exiting
   promptly instead of hanging ~60s.
7. **`SIGKILL` is uncatchable, so a child that traps `SIGTERM` still dies on the
   grace escalation, closing with signal `SIGKILL` → exit `137`.** VERIFIED —
   POSIX semantics.

## File Map

| Path                       | Change                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `src/headless-run.ts`      | edit — flag plumbing, `parseTimeoutSeconds`, grace constant/resolver, timer→SIGTERM→SIGKILL |
| `src/headless-run.test.ts` | edit — validation, timeout, SIGKILL-escalation, invariant tests + fake harnesses            |
| `src/main.ts`              | edit — `--timeout <seconds>` option on the `run` command                                    |
| `README.md`                | edit — `### Headless runs` mentions `--timeout`                                             |
| `DESIGN.md`                | edit — `Headless execution` mentions `--timeout`                                            |
| `docs/qa/eh-cli.md`        | edit — `## I. Headless runs` gains a timeout QA step                                        |
| `package.json`             | edit — version `0.11.0` → `0.12.0`                                                          |

## Tasks

### Task 1 — Add `--timeout <seconds>` flag with preflight validation

Wire the flag and reject bad values before spawn. No enforcement yet (a valid
timeout is a temporary no-op until Task 2, both land in one PR).

1. **Test (fail):** in `src/headless-run.test.ts`, add a `test.each` that
   installs `createFakeCodex()`, spawns
   `run codex ollama qwen3-coder --timeout <value>` for values `'0'`, `'-5'`,
   `'soon'`, pipes `'run the task'`, and asserts:
   - `exitCode === 1`, `stderr === ''`;
   - `parseEvents(stdout)` equals exactly
     `[{ message: expect.stringContaining('--timeout must be a positive integer'), type: 'run.error', v: 1 }, { exitCode: 1, resultIsError: true, type: 'run.completed', v: 1 }]`;
   - `events.some((e) => asRecord(e.event)?.type === 'fake.args') === false`
     (proves the fake harness on `PATH` was never invoked).
2. **Implement:** in `src/headless-run.ts`
   - add `timeout?: string` to `HeadlessRunOptions` and
     `timeoutSeconds: number | undefined` to `ResolvedHeadlessRunOptions`;
   - add the parser:
     ```ts
     function parseTimeoutSeconds(value: string | undefined) {
       if (value === undefined) return undefined
       const seconds = Number(value)
       if (!Number.isInteger(seconds) || seconds <= 0) {
         throw new Error(
           `--timeout must be a positive integer number of seconds (got "${value}")`,
         )
       }
       return seconds
     }
     ```
   - in `runHeadless`, alongside the effort check (after line 56), compute
     `const timeoutSeconds = parseTimeoutSeconds(options.timeout)` and set
     `timeoutSeconds,` in the `resolved` object literal.
   - in `src/main.ts`, add to the `run` command (after the `--resume-session`
     option, line 139):
     ```ts
     .option(
       '--timeout <seconds>',
       'fail the run if the harness runs longer than <seconds> (SIGTERM, then SIGKILL after a grace period)',
     )
     ```
     and pass `timeout: opts.timeout,` into the `runHeadless({ ... })` call.
3. **Pass:** `bun test src/headless-run.test.ts`.
4. **Commit:** `feat: add eh run --timeout flag with preflight validation`.

### Task 2 — Enforce the timeout: SIGTERM then SIGKILL escalation

1. **Test (fail):** in `src/headless-run.test.ts` add fake harnesses and three
   tests. Add near the other `createFake*` helpers:
   ```ts
   function createFakeSleeper() {
     return createFakeHarness(
       'codex',
       `const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
   emit({ type: 'thread.started', thread_id: 'thread-timeout' })
   emit({ type: 'fake.args', args: process.argv.slice(2), pid: process.pid })
   setInterval(() => {}, 1000)`,
     )
   }
   function createFakeSigtermTrap() {
     return createFakeHarness(
       'codex',
       `const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
   process.on('SIGTERM', () => {})
   emit({ type: 'thread.started', thread_id: 'thread-timeout' })
   emit({ type: 'fake.args', args: process.argv.slice(2), pid: process.pid })
   setInterval(() => {}, 1000)`,
     )
   }
   ```
   - **AC1 (SIGTERM on expiry):** spawn `createFakeSleeper()` with
     `--timeout 1`, pipe `'hang forever'`. Assert `stderr === ''`,
     `exitCode === 128 + os.constants.signals.SIGTERM`; find `errorIndex` =
     first `run.error` whose `message` includes `'1s'`, and `completedIndex` =
     the `run.completed` index; assert `errorIndex > -1`,
     `completedIndex === events.length - 1` (final event),
     `errorIndex < completedIndex`, and the completed event equals
     `{ exitCode: 128 + os.constants.signals.SIGTERM, resultIsError: true, type: 'run.completed', v: 1 }`.
     Capture the `fake.args` `pid` and best-effort
     `process.kill(pid, 'SIGKILL')` in a `finally` (mirror the existing signal
     test, `:1245-1257`).
   - **AC2 (SIGKILL escalation):** spawn `createFakeSigtermTrap()` with
     `--timeout 1` and env `EH_TIMEOUT_KILL_GRACE_MS: '100'`. Assert
     `exitCode === 128 + os.constants.signals.SIGKILL`, a `run.error` message
     including `'1s'` precedes the final `run.completed`
     (`exitCode: 128 + os.constants.signals.SIGKILL`). Same `finally` pid
     cleanup.
   - **AC4 (invariant — no effect when it completes in time):** run
     `createFakeCodex()` once with `--timeout 60` and once with no timeout flag
     (helper that spawns and returns `{ exitCode, events }`); assert both
     `exitCode === 0` and `withTimeout.events` deep-equals `without.events` (the
     flag never reaches child argv — Assumption 4). Give this test an explicit
     timeout of `20_000` ms so a leaked 60s timer fails fast instead of hanging:
     `test('...', async () => { ... }, 20_000)`. A prompt exit proves the timer
     was cleared (Assumption 6).
2. **Implement:** in `src/headless-run.ts`
   - add the constant near `PROTOCOL_VERSION` (line 17):
     ```ts
     const TIMEOUT_KILL_GRACE_MS = 10_000
     ```
   - add the resolver:
     ```ts
     function timeoutKillGraceMs() {
       const raw = process.env.EH_TIMEOUT_KILL_GRACE_MS
       if (raw === undefined) return TIMEOUT_KILL_GRACE_MS
       const parsed = Number(raw)
       return Number.isFinite(parsed) && parsed >= 0
         ? parsed
         : TIMEOUT_KILL_GRACE_MS
     }
     ```
   - thread `timeoutSeconds` from `resolved` into the
     `executeHeadlessPlan({...})` call in `runHeadless` (add
     `timeoutSeconds: resolved.timeoutSeconds,`), add `timeoutSeconds?: number`
     to the `options` types of both `executeHeadlessPlan` and
     `executePreparedHeadlessPlan`, and forward it in `executeHeadlessPlan`'s
     inner call.
   - in `executePreparedHeadlessPlan`, declare before the `try` (after the
     `signalHandlers` array, line 226):
     ```ts
     let timedOut = false
     let timeoutTimer: ReturnType<typeof setTimeout> | undefined
     let killTimer: ReturnType<typeof setTimeout> | undefined
     ```
   - inside the `try`, right after `child.stdin.end(options.stdin)` (line 231):
     ```ts
     if (options.timeoutSeconds !== undefined) {
       timeoutTimer = setTimeout(() => {
         timedOut = true
         emit({
           message: `${options.harness} exceeded the --timeout limit of ${options.timeoutSeconds}s`,
           type: 'run.error',
         })
         if (child.exitCode === null && child.signalCode === null) {
           child.kill('SIGTERM')
           killTimer = setTimeout(() => {
             if (child.exitCode === null && child.signalCode === null) {
               child.kill('SIGKILL')
             }
           }, timeoutKillGraceMs())
         }
       }, options.timeoutSeconds * 1000)
     }
     ```
     Do NOT call `.unref()` — an uncleared timer must keep the process alive so
     the invariant test genuinely proves cleanup.
   - suppress the duplicate generic signal error when the timeout already
     reported it: change the condition at line 262 to
     `if (!state.resultIsError && childExitCode !== 0 && !timedOut) {` so
     exactly one `run.error` (the timeout one) precedes `run.completed`.
   - in the `finally` (line 274), before the handler-removal loop, add:
     ```ts
     if (timeoutTimer) clearTimeout(timeoutTimer)
     if (killTimer) clearTimeout(killTimer)
     ```
3. **Pass:** `bun test src/headless-run.test.ts`.
4. **Commit:** `feat: enforce eh run --timeout with SIGTERM then SIGKILL`.

### Task 3 — Docs and version bump

1. **Implement:**
   - `README.md` `### Headless runs` (near line 177, after the
     `--gateway-provider` sentence): add a sentence, e.g. "Pass
     `--timeout <seconds>` to fail a hung lane loudly: on expiry `eh` emits a
     `run.error` naming the limit, sends `SIGTERM`, then escalates to `SIGKILL`
     after a 10s grace period; `run.completed` is still the final event and a
     timed-out child exits `143`. Omitting the flag keeps today's no-deadline
     behavior."
   - `DESIGN.md` `Headless execution` (line 85-98): note that the caller still
     owns lifecycle policy, but `eh run` now offers an optional
     `--timeout <seconds>` deadline (SIGTERM then SIGKILL after a named
     `TIMEOUT_KILL_GRACE_MS` grace, overridable via `EH_TIMEOUT_KILL_GRACE_MS`
     for tests); update the "The caller owns … process timeouts …" clause to
     reflect the opt-in deadline.
   - `docs/qa/eh-cli.md` `## I. Headless runs` (after step 1, ~line 299): add a
     step noting the `bun test src/headless-run.test.ts` suite now also covers
     `--timeout` preflight rejection (non-positive/negative/non-numeric, fake
     never invoked), SIGTERM-on-expiry with a limit-naming `run.error`, SIGKILL
     escalation via `EH_TIMEOUT_KILL_GRACE_MS`, and the no-effect invariant.
   - `package.json`: bump `"version": "0.11.0"` → `"0.12.0"` (plain X.Y.Z).
2. **Pass:** `pnpm lint:ci`.
3. **Commit:** `docs: document eh run --timeout and bump version`.

## Verification

```bash
pnpm lint:ci
bun test src/headless-run.test.ts
pnpm test
```

All three must pass. The version bump is required for release (a minor feature:
`0.11.0` → `0.12.0`); `scripts/check-version-guard.sh` rejects non-`X.Y.Z`
strings.
