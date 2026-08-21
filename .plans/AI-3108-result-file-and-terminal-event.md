# eh run --result-file Implementation Plan

## Goal

Add `eh run --result-file <path>`: after the run, `<path>` contains exactly the
run's final result text — the harness-native terminal result string for
harnesses that define one (only Claude), else all `assistant.text` content
joined in stream order. The file is always created, empty when the run produced
no result text (including error runs). Adding the flag changes nothing else: the
NDJSON stream, exit code, and stderr stay byte-identical aside from the file
write. Separately, document `run.completed` as the guaranteed final NDJSON line
and lock it with a regression test.

## Scope Boundary

IN: `--result-file` flag + result extraction/write; a terminal-event regression
test; README/DESIGN/QA docs for the `run.completed` guarantee and the new flag;
version bump.

OUT (do not touch): exit-code semantics; a structured JSON result envelope
(plain text only — `usage` already flows as `usage` events); result extraction
for interactive (non-`run`) mode. Do NOT add native terminal-result parsing to
codex/grok/opencode/pi — they use the concat fallback by design.

## Context for Implementer

`eh run` spawns a harness, reads its stdout line-by-line, and normalizes each
line via `normalizeHarnessLine` → per-harness `normalize*Event`. Assistant text
is emitted as `{ text, type: 'assistant.text' }` at five sites. Usage/session/
errors are emitted similarly. The run always ends by emitting exactly one
`run.completed` and returning.

Key facts verified in this repo (see Load-Bearing Assumptions for evidence):

- Only **Claude** defines a native terminal result: the `result` event carries a
  top-level `event.result` string (today read only as an error fallback in
  `emitRunError`, `src/headless-run.ts:206`). codex/grok/opencode/pi have no
  equivalent — they use the concat fallback.
- `run.completed` is already the last line on every path (nothing emits after
  it); the change must preserve that.

**Concat separator decision (load-bearing):** join `assistant.text` values in
stream order with a single `\n` between them (no leading/trailing newline). The
first text is written as-is; each subsequent text is prefixed with `\n`. Claude
never uses this path (it has a native result), so the fallback only affects
codex/grok/opencode/pi. The per-harness fixture tests pin the exact bytes.

**Native-result rule:** capture `event.result` into state whenever it is a
string (even `''`). Final text = `state.nativeResult ?? state.assistantText`.
`??` keeps an empty native result (`''`) — that is the documented failure mode
(a Claude run whose native result is empty yields an empty file even if
assistant text existed).

## Load-Bearing Assumptions

- **`run.completed` is the final NDJSON line on every path** — VERIFIED. Three
  emit sites, each immediately followed by `return`: preflight catch
  (`src/headless-run.ts:148-153`), spawn error (`:342-347`), normal completion
  (`:368-369`). The `finally` (`:370-376`) only clears timers / removes signal
  handlers — no `emit`.
- **Only Claude defines a native terminal result** — VERIFIED by reading every
  `normalize*Event` (`src/headless-run.ts:391-620`): claude reads a `result`
  event; codex (`item.completed`/`turn.completed`), grok (text deltas), opencode
  (text parts), pi (`message_end` content) have no top-level terminal result
  string.
- **Claude's `result` event carries a top-level `result` string** — VERIFIED:
  `emitRunError` already reads `event.result` (`src/headless-run.ts:206`). The
  fake Claude fixture omits it today; the test adds it.
- **commander camelCases `--result-file` → `opts.resultFile`** — VERIFIED by the
  existing pattern (`--native-args-json`→`opts.nativeArgsJson`,
  `--resume-session`→`opts.resumeSession`, `src/main.ts:131-158`).
- **`writeFile` is already imported from `node:fs/promises`** — VERIFIED
  (`src/headless-run.ts:3`).

## File Map

- `src/headless-run.ts` (edit) — result accumulation, native-result capture,
  file write, thread `resultFile`.
- `src/headless-run.test.ts` (edit) — per-harness byte tests, multi-turn concat,
  no-result error, invariant, terminal-event regression.
- `src/main.ts` (edit) — `--result-file` option + wire into `runHeadless`.
- `README.md` (edit) — document `--result-file` and the `run.completed`
  guarantee.
- `DESIGN.md` (edit) — same, in the Headless execution paragraph.
- `docs/qa/eh-cli.md` (edit) — QA step for the new coverage.
- `package.json` (edit) — bump `version` (`0.15.0` → `0.16.0`).

## Tasks

### Task 1 — Implement `--result-file` + result extraction + tests

**Test first (red):** add a `describe('--result-file')` block to
`src/headless-run.test.ts` (fixtures/helpers already exist: `createFakeClaude`,
`createFakeCodex`, `createFakeGrok`, `createFakeOpencode`, `createFakePi`,
`parseEvents`, `childExitCode`, `readStream`, `tempDirs`). Cover:

1. Per-harness byte comparison via `test.each`. For each harness, spawn `eh run`
   with `--result-file <path>` (write the path under a `mkdtempSync` dir pushed
   to `tempDirs`), await exit, then `readFileSync(path, 'utf8')` and
   `expect(...).toBe(expected)`:
   - claude → the native result (see fixture change below), e.g.
     `'claude-result: <prompt>'` (proves native wins over the `'saw: …'` text).
   - codex/grok/opencode/pi → `'saw: <prompt>'` (single-block concat).
2. Multi-turn concat (fallback path): drive the codex fake to emit two
   `agent_message` items and assert the file equals `'part one\npart two'`.
3. No-result error case: run codex with `EH_TEST_CODEX_FAIL=1` and
   `--result-file`; assert exit `66` and the file bytes are `''`.
4. Invariant: run the codex fake twice — with and without `--result-file` — and
   assert `parseEvents(stdout)` arrays are equal, exit codes equal, and stderr
   equal. (Template: the existing
   `leaves a run that finishes before the deadline unchanged` test,
   `src/headless-run.test.ts:1645-1682`.)

Fixture edits (gated so existing tests are unaffected):

- `createFakeClaude`: add `result: 'claude-result: ' + prompt` to the emitted
  `result` event object.
- `createFakeCodex`: add a branch
  `if (process.env.EH_TEST_CODEX_MULTITURN === '1')` that emits two
  `item.completed` agent_message events (`'part one'`, `'part two'`) then
  `turn.completed`, and `process.exit(0)`.

Run `bun test src/headless-run.test.ts` → new tests fail.

**Implement (green):** in `src/headless-run.ts`:

1. Extend `NormalizerState` (`:47-51`):

   ```ts
   interface NormalizerState {
     assistantText: string
     nativeResult: string | undefined
     pendingGrokText: string
     resultIsError: boolean
     sessionId: string | undefined
   }
   ```

   Initialize both new fields in the state literal at `:321-325`
   (`assistantText: '', nativeResult: undefined,`).

2. Add the accumulating emit helper (near `flushGrokText`):

   ```ts
   function emitAssistantText(text: string, state: NormalizerState) {
     emit({ text, type: 'assistant.text' })
     return {
       ...state,
       assistantText:
         state.assistantText === '' ? text : `${state.assistantText}\n${text}`,
     }
   }
   ```

3. Replace each `emit({ text, type: 'assistant.text' })` with a threaded
   `emitAssistantText` call, returning the updated state:
   - `flushGrokText` (`:379-383`):
     ```ts
     function flushGrokText(state: NormalizerState) {
       if (!state.pendingGrokText) return state
       return emitAssistantText(state.pendingGrokText, {
         ...state,
         pendingGrokText: '',
       })
     }
     ```
   - `normalizeClaudeEvent` (`:400-410`): in the content-block loop, thread a
     local `let next = state` (also carry it through the session/result
     handling) and call `next = emitAssistantText(block.text, next)`. In the
     `result` branch return with
     `nativeResult: typeof event.result === 'string' ? event.result : next.nativeResult`
     alongside the existing `resultIsError`/`sessionId`.
   - `normalizeCodexEvent` (`:445-450`), `normalizeOpencodeEvent` (`:552-558`),
     `normalizePiEvent` (`:591-598`): thread a local `let next = state` from
     that function's existing initial state and replace the assistant-text
     `emit` with `next = emitAssistantText(<text>, next)`, returning `next`
     (error branches return `{ ...next, resultIsError: true }`). These emit the
     identical `assistant.text` object — no stdout change.

4. Add the write helper:

   ```ts
   async function writeResultFile(
     resultFile: string | undefined,
     text: string,
   ) {
     if (resultFile === undefined) return
     await writeFile(resultFile, text)
   }
   ```

5. Thread `resultFile`:
   - Add `resultFile?: string` to `HeadlessRunOptions` (`:35-45`) and
     `resultFile: string | undefined` to `ResolvedHeadlessRunOptions`
     (`:53-63`).
   - Set `resultFile: options.resultFile,` in the `resolved` literal (`:78-91`).
   - Add `resultFile?: string` to the option objects of `executeHeadlessPlan`
     (`:242-249`) and `executePreparedHeadlessPlan` (`:255-262`); pass
     `resultFile: resolved.resultFile` at the `executeHeadlessPlan` call
     (`:133-142`).

6. Write the file at every completion path (compute
   `const resultText = state.nativeResult ?? state.assistantText` after the grok
   flush at `:333`):
   - Before the spawn-error `emit({...run.completed})` (`:342`):
     `await writeResultFile(options.resultFile, resultText)`.
   - Before the normal
     `emit({ exitCode, resultIsError, type: 'run.completed' })` (`:368`):
     `await writeResultFile(options.resultFile, resultText)`.
   - In the preflight catch (`:145-154`), before the `emit` calls:
     `await writeResultFile(options.resultFile, '')` (uses `options.resultFile`
     directly — `resolved` may not exist yet).

7. In `src/main.ts`, add to the `run` command (after `--timeout`, `:141-144`):
   ```ts
   .option('--result-file <path>', "write the run's final result text to <path>")
   ```
   and pass `resultFile: opts.resultFile,` into the `runHeadless({...})` call
   (`:145-159`).

Run `bun test src/headless-run.test.ts` → all pass. `pnpm lint:ci`. Commit.

### Task 2 — Terminal-event regression test + docs + version bump

**Test first:** add a regression test to `src/headless-run.test.ts` asserting
`run.completed` is the final line and no event follows it, for both a successful
run (`createFakeCodex`) and a semantic-error run (`EH_TEST_CODEX_FAIL=1`):
`const events = parseEvents(stdout); const i = events.findIndex(e => e.type === 'run.completed'); expect(i).toBe(events.length - 1)`.
(This characterizes existing behavior and passes immediately — it locks the
guarantee AC #3 names.) Run `bun test src/headless-run.test.ts` → passes.

**Docs:**

- `README.md` `### Headless runs`: add a sentence documenting
  `--result-file <path>` (final result text: native terminal result where
  defined, else `assistant.text` joined in stream order; always created, empty
  for no-result/ error runs) near the other `eh run` flags (~README.md:190-206).
  Add a sentence stating `run.completed` is guaranteed to be the last NDJSON
  line orchestrators can rely on (near the events list, ~README.md:162-168).
- `DESIGN.md` Headless execution paragraph (`DESIGN.md:85-108`): document
  `--result-file` and state `run.completed` is by construction the final NDJSON
  line (emitted only after stdout EOF and child close, with no code path after
  it).
- `docs/qa/eh-cli.md` section I (Headless runs, after step 5 ~line 362): add a
  step noting the automated suite covers `--result-file` (per-harness byte
  comparison incl. Claude native result vs concat fallback, multi-turn concat,
  no-result error → empty file, the with/without invariant) and the
  `run.completed`-is-final regression.

**Version bump:** `package.json` `"version": "0.15.0"` → `"0.16.0"`.

Run `pnpm lint:ci`; `bun test src/headless-run.test.ts`. Commit.

## Verification

- `pnpm lint:ci`
- `bun test src/headless-run.test.ts`
- `pnpm test`
- `bash scripts/check-version-guard.sh` (if runnable locally) — confirms the
  version bump satisfies the release guard for the touched `src/`,
  `package.json`, and README/DESIGN changes.
