# Reserved Exit Codes for eh-Detected Failure Categories Implementation Plan

## Goal

`eh run` currently collapses distinct failures into exit code `1`: a missing
harness binary (spawn `ENOENT`), a semantic harness failure (`resultIsError`
with child exit 0), and every preflight error all return `1`, so an orchestrator
cannot classify a dead lane without parsing stderr. Give `eh` a small, reserved,
documented, contiguous block of exit codes at ≥64 for the three eh-detected
categories, while raw child codes continue to pass through unchanged.

Chosen block (contiguous, ≥64, mirrors `sysexits.h`'s `EX_` range):

| Code | Category |
|------|----------|
| `64` | Preflight/usage error (TTY, empty stdin, invalid flag values, unknown harness/provider — nothing was spawned) |
| `65` | Spawn failure (harness binary missing or otherwise unspawnable) |
| `66` | Semantic harness failure (`resultIsError` while the child exited `0`) |

## Scope Boundary

**In scope:** the three exit-code categories above in `src/headless-run.ts`,
extending the existing subprocess tests to assert them, the README/DESIGN/qa
docs, and the required version bump.

**Out of scope (do NOT touch):**
- Provider/auth-error classification (deferred — needs per-harness error parsing).
- An `errorCategory` field on `run.completed` (exit codes are the contract now).
- Remapping the timeout / `128 + signal` shape — it stays as-is (may be
  documented, not changed).
- The nonzero-passthrough behavior (`childExitCode` such as `7`) and the
  `128 + signal` behavior — these are the invariant and must stay byte-for-byte.

## Context for Implementer

- `process.exitCode = await runHeadless(...)` in `src/main.ts:141` — the value
  `runHeadless` returns IS the `eh` process exit code. In every code path the
  emitted `run.completed.exitCode` already equals that returned value; keep that
  identity (emit the same number you return).
- `run.completed.exitCode` field semantics do not change: in the passthrough
  case it carries the raw child code; in the three eh-detected categories there
  is no raw child code to carry (spawn failed / no child was launched / the
  semantic case has child exit `0`), so it carries the reserved code — exactly
  as it already carried `1` there today.
- The semantic branch only fires when the child exited `0`: line 271's
  `resultIsError && childExitCode === 0`. When a semantic error coincides with a
  nonzero child code, the raw code passes through — leave that untouched.
- Preflight errors are everything thrown inside `runHeadless`'s `try` (prompt
  read, effort validation, config load, provider lookup, `buildLaunchPlan`,
  `prepareHeadlessPlan`); they are all caught at `src/headless-run.ts:108`.
- A missing binary reaches the `child.on('error')` path (`spawn` emits `error`
  asynchronously on `ENOENT`; it does not throw), so it is the spawn category,
  not preflight.

## Load-Bearing Assumptions

- **VERIFIED** — `runHeadless`'s return value is the process exit code:
  `src/main.ts:141` `process.exitCode = await runHeadless({...})`.
- **VERIFIED** — Preflight errors all funnel through one catch returning `1`:
  `src/headless-run.ts:108-112` wraps the whole run body.
- **VERIFIED** — Spawn/missing-binary uses the `child.on('error')` resolve path
  emitting `exitCode: 1`, distinct from the completion path:
  `src/headless-run.ts:212-215, 248-256`.
- **VERIFIED** — Semantic forcing lives at `src/headless-run.ts:271`
  `const exitCode = resultIsError && childExitCode === 0 ? 1 : childExitCode`.
- **VERIFIED** — Raw-passthrough invariant is pinned by the test "emits a run
  error when a harness exits non-zero without a semantic error"
  (`src/headless-run.test.ts:1141-1178`) asserting `exitCode` `7`, and the
  signal test (`:1180-1258`) asserting `128 + SIGTERM`. Both must stay green
  **unmodified**.
- **VERIFIED** — `src/` and `package.json` are release-affecting, so a version
  bump is required (`scripts/release-affecting-files.sh`).

## File Map

- `src/headless-run.ts` — edit: add reserved-code constants; wire the three
  categories.
- `src/headless-run.test.ts` — edit: assert reserved codes in the missing-binary,
  preflight, and semantic tests (leave passthrough + signal tests untouched).
- `README.md` — edit: add the "Exit codes" table + passthrough/collision notes.
- `DESIGN.md` — edit: mirror the table in the headless section.
- `docs/qa/eh-cli.md` — edit: note the reserved codes in section I.
- `package.json` — edit: bump `version` `0.11.0` → `0.12.0`.

## Tasks

### Task 1 — Reserved exit codes in headless-run.ts + extend tests

**Fail first:** In `src/headless-run.test.ts` change the three category
assertions to the new codes and run `bun test src/headless-run.test.ts` — the
three edited tests fail against the current `1`.

- "normalizes a missing harness binary as a failed run" (`:176`): change
  `expect(exitCode).toBe(1)` → `65`, and `events[2]` from `exitCode: 1` →
  `exitCode: 65`.
- The `test.each` preflight block (`:228-380`): change `expect(exitCode).toBe(1)`
  → `64`, and the `run.completed` record's `exitCode: 1` → `exitCode: 64`.
- "converts a semantic %s failure into a non-zero wrapper exit" (`:1018`):
  change `expect(exitCode).toBe(1)` → `66` and the `run.completed` `exitCode: 1`
  → `exitCode: 66`.
- "converts a semantic Codex failure into a non-zero wrapper exit" (`:1100`):
  change `expect(exitCode).toBe(1)` → `66` and the `run.completed` `exitCode: 1`
  → `exitCode: 66`.
- Do NOT modify "emits a run error when a harness exits non-zero without a
  semantic error" (`:1141`, asserts `7`) or "forwards termination signals…"
  (`:1180`, asserts `128 + SIGTERM`) — they are the passthrough proof.

**Implement:** In `src/headless-run.ts`, add constants below `PROTOCOL_VERSION`
(line 17):

```ts
// Reserved eh exit codes for eh-detected failure categories — a contiguous
// block at >=64 (sysexits.h's EX_ range). Raw child codes pass through
// unchanged when eh has no category, so a harness's own code may only collide
// with this block in the passthrough case. Documented in README's "Exit codes".
const EH_EXIT_PREFLIGHT = 64
const EH_EXIT_SPAWN = 65
const EH_EXIT_HARNESS_ERROR = 66
```

Preflight catch — current `src/headless-run.ts:108-112`:

```ts
  } catch (error) {
    emit({ message: errorMessage(error), type: 'run.error' })
    emit({ exitCode: 1, resultIsError: true, type: 'run.completed' })
    return 1
  }
```

becomes `exitCode: EH_EXIT_PREFLIGHT` in the emit and `return EH_EXIT_PREFLIGHT`.

Spawn-error path — current `src/headless-run.ts:248-256`:

```ts
    if ('error' in completed) {
      emit({
        message:
          completed.error.message || `Failed to spawn "${options.plan.bin}"`,
        type: 'run.error',
      })
      emit({ exitCode: 1, resultIsError: true, type: 'run.completed' })
      return 1
    }
```

becomes `exitCode: EH_EXIT_SPAWN` in the emit and `return EH_EXIT_SPAWN`.

Semantic forcing — current `src/headless-run.ts:271`:

```ts
    const exitCode = resultIsError && childExitCode === 0 ? 1 : childExitCode
```

becomes:

```ts
    const exitCode =
      resultIsError && childExitCode === 0 ? EH_EXIT_HARNESS_ERROR : childExitCode
```

Leave the `childExitCode` derivation (`completed.code ?? (signalNumber ? 128 +
signalNumber : 1)`, `:260-261`) and the `resultIsError` computation (`:270`)
untouched — the raw passthrough and `128 + signal` behaviors do not change.

**Pass:** `bun test src/headless-run.test.ts` green (edited tests now match,
passthrough + signal tests still pass). Then `pnpm lint:ci`.

**Commit:** `feat: reserve exit codes 64-66 for eh-detected run failures`

### Task 2 — Document the reserved block

**Implement (README.md):** After the headless-runs paragraph ending
"…even when the child process exits zero." (`README.md:166`), add an
"#### Exit codes" subsection with this table and notes:

```markdown
#### Exit codes

`eh` owns a small reserved block of exit codes for failures it detects itself;
any other code is the harness's own, passed through unchanged.

| Exit code | Meaning |
|-----------|---------|
| `0` | Clean completion |
| `64` | Preflight/usage error — TTY, empty stdin, invalid flag values, unknown harness/provider; nothing was spawned |
| `65` | Spawn failure — the harness binary is missing or otherwise unspawnable |
| `66` | Semantic harness failure — `resultIsError` while the child process exited `0` |
| any other | Raw child exit code, passed through unchanged (including `128 + signal` for a signalled child) |

`run.completed.exitCode` always equals the `eh` process exit code and, in the
passthrough case, carries the raw child code. Because raw codes pass through
untouched, a harness's own exit code may numerically collide with this reserved
block only in the passthrough case; classify from the `run.error` event when the
distinction matters.
```

**Implement (DESIGN.md):** In the headless-execution section (near
`DESIGN.md:85-97`), append a short paragraph mirroring the block: eh reserves
`64` (preflight/usage), `65` (spawn failure), `66` (semantic harness failure);
all other codes are the raw child code passed through unchanged (including
`128 + signal`), which is why a harness code can collide with the block only in
the passthrough case.

**Implement (docs/qa/eh-cli.md):** In section I (`docs/qa/eh-cli.md:289-329`),
update the wording so the missing-binary case asserts exit `65`, the preflight
cases assert exit `64`, and the semantic-failure cases assert exit `66` (rather
than the generic "non-zero"), and note that a raw nonzero child code still
passes through unchanged.

**Pass:** `pnpm lint:ci` (prettier/markdown clean).

**Commit:** `docs: document eh run reserved exit-code block`

### Task 3 — Version bump

**Implement:** In `package.json`, bump `"version": "0.11.0"` → `"0.12.0"`
(plain `X.Y.Z`; the guard rejects anything else).

**Pass:** `bash scripts/check-version-guard.sh` if runnable locally; otherwise
rely on CI's `version-guard.yml`.

**Commit:** `chore: bump version to 0.12.0`

## Verification

```bash
pnpm lint:ci
bun test src/headless-run.test.ts
pnpm test
```

All green; the passthrough test (`exitCode` `7`) and the signal test
(`128 + SIGTERM`) must pass unmodified as the proof that raw child codes are
never remapped.
