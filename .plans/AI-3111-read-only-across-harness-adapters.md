# `eh run --read-only` Implementation Plan

## Goal

Add a `--read-only` boolean flag to `eh run` that engages each of the five
harnesses' strongest native write-restriction, exactly per the signed-off spike
mapping in `docs/read-only.md`. Approval-mode and write-restriction are
independent axes, but the native flags collide on two of five harnesses, so a
single new mapping module resolves both axes at one point.

## Scope Boundary

In scope: the `--read-only` flag on the `eh run` subcommand only; a new mapping
module; wiring through `buildLaunchPlan` → each `planX` → `runHeadless` →
`main.ts`; subprocess + unit tests; docs + version bump.

Out of scope (do NOT touch): interactive-mode read-only or the root command;
any config-level default; OS sandboxing beyond harness flags; re-verifying
harness CLI behavior (the spike owns that evidence — treat `docs/read-only.md`
as the specification and do not re-litigate the mapping). `src/approval-mode.ts`
stays as-is — the new module reuses `approvalArgsForHarness` rather than
replacing it.

## Context for Implementer

The spike (`docs/read-only.md`) is the specification. Its "Decision" section
(lines 55–89) says: `--read-only` is a boolean orthogonal to `ApprovalMode`;
`APPROVAL_MODES` is NOT extended; one resolution point owns both axes because
native flags collide; when `readOnly` is set it takes precedence and approval
args are suppressed — **except opencode**, whose `--agent plan` composes with
`--auto`. Per-harness exact args (spike lines 68–74):

| Harness  | read-only args              | approval suppressed?          |
| -------- | --------------------------- | ----------------------------- |
| claude   | `--permission-mode plan`    | yes (drop `--permission-mode auto`) |
| grok     | `--permission-mode plan`    | yes (drop `--permission-mode auto`) |
| codex    | `--sandbox read-only`       | yes (drop `--approve-for-me`) |
| pi       | `--tools read,grep,find,ls` | n/a (pi has no approval args) |
| opencode | `--agent plan`              | NO — keep `--auto` when auto  |

Invariant (spike lines 75–83): a lane started with `--read-only` is never
silently unrestricted. All five harnesses now have a mechanism; the "no
mechanism = refuse to launch" default is forward-looking for any future harness.

Reference implementation — the sibling mapping module to mirror,
`src/approval-mode.ts:1-47` (switch + `unreachable` exhaustiveness guard;
condensed below — the real file also exports `approvalModeLabel` at lines
19–27, which stays untouched):

```ts
import type { ApprovalMode } from './types.js'
type ApprovalHarness = 'claude' | 'codex' | 'grok' | 'opencode' | 'pi'
export function approvalArgsForHarness(harness: ApprovalHarness, mode: ApprovalMode | undefined) {
  switch (mode) {
    case 'auto': return autoApprovalArgs(harness)
    case 'platform':
    case undefined: return []
  }
  return unreachable(mode)
}
function autoApprovalArgs(harness: ApprovalHarness) {
  switch (harness) {
    case 'claude':
    case 'grok': return ['--permission-mode', 'auto']
    case 'codex': return ['--approve-for-me']
    case 'opencode': return ['--auto']
    case 'pi': return []
  }
  return unreachable(harness)
}
function unreachable(value: never): never {
  throw new Error(`unsupported approval value: ${String(value)}`)
}
```

Each `planX` in `src/harnesses.ts` currently appends approval args, e.g.
`planCodex` at `src/harnesses.ts:198`:
`args.push(...approvalArgsForHarness('codex', options.approvalMode))`. The five
call sites are lines 139 (claude), 198 (codex), 226 (grok), 286 (pi), 346
(opencode). Each is replaced by a `permissionArgsForHarness` call that carries
both axes.

The subprocess test pattern (`createFakeHarness`) lives in
`src/headless-run.test.ts` — fixtures `createFakeClaude/Codex/Grok/Opencode/Pi`
each emit `{ type: 'fake.args', args: process.argv.slice(2), ... }`. Assert
against `fake.args`. See the existing approval-default test at
`src/headless-run.test.ts:289-333` (writes `{defaultApprovalMode:'auto'}` config,
asserts `--approve-for-me` in `fake.args`) — the composition test mirrors it.
Note: pi fixtures require `PI_CODING_AGENT_DIR: fixture.configDir` in env (see
`src/headless-run.test.ts:1115`); grok reads its prompt from `--prompt-file`
(passed by `eh` at `src/headless-run.ts:714`).

## Load-Bearing Assumptions

- **Per-harness read-only args and suppression rules** (claude/grok
  `--permission-mode plan`; codex `--sandbox read-only`; pi
  `--tools read,grep,find,ls`; opencode `--agent plan` keeping `--auto`).
  VERIFIED against `docs/read-only.md:27-33` (mapping table) and lines 68–74
  (decision). In-repo tests can only pin the *args passed*; live write-blocking
  proof lives in the spike.
- **Approval + read-only collide for codex and grok** (cannot both be appended).
  VERIFIED `docs/read-only.md:41-53`. Consequence: read-only suppresses approval
  args for all harnesses except opencode; this is why one function owns both axes.
- **opencode `--agent plan` composes with `--auto`** and still blocks writes.
  VERIFIED `docs/read-only.md:51-53, 73-74`.
- **`--sandbox read-only` is accepted at codex's pre-`exec` arg position.**
  VERIFIED — `--approve-for-me` is already appended there by `planCodex`
  (`src/harnesses.ts:198`, before `prepareHeadlessPlan` prepends `exec`), and the
  spike's codex collision (`docs/read-only.md:46-47`) proves `--sandbox` and
  `--approve-for-me` occupy the same compatible position.
- **`opts.readOnly` is a boolean from commander for a valueless `--read-only`.**
  VERIFIED by the existing valueless flag `--print-env` (`src/main.ts:62`).

## File Map

- `src/permission-posture.ts` (create) — mapping module: `permissionArgsForHarness`.
- `src/permission-posture.test.ts` (create) — unit tests: mapping, composition, refuse-to-launch invariant.
- `src/harnesses.ts` (edit) — add `readOnly` to `HarnessPlanOptions` + `buildLaunchPlan`; swap 5 call sites to `permissionArgsForHarness`.
- `src/headless-run.ts` (edit) — thread `readOnly` through `HeadlessRunOptions`, `ResolvedHeadlessRunOptions`, and the `buildLaunchPlan` call.
- `src/main.ts` (edit) — add `--read-only` option to the `run` command; pass to `runHeadless`.
- `src/headless-run.test.ts` (edit) — per-harness read-only subprocess tests + auto+read-only composition tests.
- `package.json` (edit) — version bump `0.15.0` → `0.16.0`.
- `README.md` (edit) — document `--read-only` in `### Headless runs`.
- `DESIGN.md` (edit) — File map entry + Launch plans note.
- `docs/qa/eh-cli.md` (edit) — manual read-only probe.

## Tasks

### Task 1 — Create the `permission-posture` mapping module + unit tests

Delivers AC #1 (mapping module analogous to `approval-mode.ts`), the unit-level
proof of AC #2 (refuse-to-launch invariant) and AC #3 (composition). Also bump
the version here since this is the first src change.

1. Write `src/permission-posture.test.ts` first (fail): import
   `permissionArgsForHarness` from `./permission-posture.js`. Tests:
   - `test.each` mapping, `approvalMode: 'platform', readOnly: true`:
     claude→`['--permission-mode','plan']`, grok→same,
     codex→`['--sandbox','read-only']`, pi→`['--tools','read,grep,find,ls']`,
     opencode→`['--agent','plan']`.
   - composition, `readOnly: true, approvalMode: 'auto'`:
     opencode→`['--agent','plan','--auto']`, codex→`['--sandbox','read-only']`,
     claude→`['--permission-mode','plan']` (approval suppressed).
   - `test.each(['claude','codex','grok','opencode','pi'])`: read-only args are
     non-empty (never silently unrestricted).
   - refuse-to-launch: `permissionArgsForHarness('futureharness' as never,
     {approvalMode: undefined, readOnly: true})` throws `/no read-only mechanism/`.
   - no-bypass: flatten all 5 harnesses' read-only args; assert they contain no
     `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
     `--always-approve` (mirror `src/approval-mode.test.ts:32-40`).
   - not-read-only delegates: `permissionArgsForHarness('codex',
     {approvalMode:'auto', readOnly:false})` equals `['--approve-for-me']`.
2. Create `src/permission-posture.ts`:

```ts
import { approvalArgsForHarness } from './approval-mode.js'

import type { ApprovalMode } from './types.js'

type PermissionHarness = 'claude' | 'codex' | 'grok' | 'opencode' | 'pi'

// One resolution point owns both permission axes (approval + write-restriction).
// Native flags collide on two of five harnesses (docs/read-only.md "The
// collision findings"), so read-only cannot be a second independent
// arg-appender next to approvalArgsForHarness: when readOnly is set it takes
// precedence and the approval-mode args are suppressed — except opencode, whose
// --agent plan composes with --auto.
export function permissionArgsForHarness(
  harness: PermissionHarness,
  options: { approvalMode: ApprovalMode | undefined; readOnly: boolean },
) {
  if (!options.readOnly) {
    return approvalArgsForHarness(harness, options.approvalMode)
  }
  return readOnlyArgs(harness, options.approvalMode)
}

// Each harness's strongest own write restriction, per docs/read-only.md
// "Decision". A harness with no mechanism hits the unreachable guard so the lane
// refuses to launch rather than run silently unrestricted.
function readOnlyArgs(
  harness: PermissionHarness,
  approvalMode: ApprovalMode | undefined,
) {
  switch (harness) {
    case 'claude':
    case 'grok':
      return ['--permission-mode', 'plan']
    case 'codex':
      return ['--sandbox', 'read-only']
    case 'pi':
      return ['--tools', 'read,grep,find,ls']
    case 'opencode':
      // --agent plan blocks writes; --auto composes and does not override it.
      return [
        '--agent',
        'plan',
        ...approvalArgsForHarness('opencode', approvalMode),
      ]
  }
  return unreachable(harness)
}

function unreachable(harness: never): never {
  throw new Error(
    `no read-only mechanism for harness "${String(harness)}"; refusing to launch a --read-only lane (docs/read-only.md)`,
  )
}
```

3. Bump `package.json` version `0.15.0` → `0.16.0`.
4. `bun test src/permission-posture.test.ts` passes; `pnpm lint:ci` clean. Commit.

### Task 2 — Wire `readOnly` through the launch plan and CLI + subprocess tests

Delivers the `createFakeHarness` proof for AC #1 and AC #3.

1. `src/harnesses.ts`:
   - Replace `import { approvalArgsForHarness } from './approval-mode.js'`
     (line 7) with `import { permissionArgsForHarness } from './permission-posture.js'`.
   - `HarnessPlanOptions` (line 58): add `readOnly?: boolean`.
   - At the 5 call sites (lines 139, 198, 226, 286, 346) replace
     `args.push(...approvalArgsForHarness('<h>', options.approvalMode))` with
     `args.push(...permissionArgsForHarness('<h>', { approvalMode: options.approvalMode, readOnly: options.readOnly ?? false }))`.
   - `buildLaunchPlan` options object (line 475): add `readOnly?: boolean`; in the
     `def.plan(provider, model, {...})` call (line 488) add `readOnly: options.readOnly`.
2. `src/headless-run.ts`:
   - `HeadlessRunOptions` (line 35): add `readOnly?: boolean`.
   - `ResolvedHeadlessRunOptions` (line 53): add `readOnly: boolean`.
   - In the `resolved` object (line 78): add `readOnly: options.readOnly ?? false`.
   - In the `buildLaunchPlan(...)` call (line 104) options object add
     `readOnly: resolved.readOnly`.
3. `src/main.ts`: on the `run` command (after line 144, before `.action`) add
   `.option('--read-only', 'restrict the harness to its strongest read-only / no-write mode')`.
   In the action (line 146) add `readOnly: opts.readOnly,` to the `runHeadless` arg.
4. Add subprocess tests to `src/headless-run.test.ts` (write, run, watch fail
   before wiring exists — sequence tests after step 1–3 if preferred, but they
   must fail against current `main`):
   - Per-harness read-only (platform approval), a `test.each` over
     `[['claude',createFakeClaude,['--permission-mode','plan']],
     ['grok',createFakeGrok,['--permission-mode','plan']],
     ['codex',createFakeCodex,['--sandbox','read-only']],
     ['opencode',createFakeOpencode,['--agent','plan']],
     ['pi',createFakePi,['--tools','read,grep,find,ls']]]`. Spawn
     `run <harness> ollama qwen3-coder --read-only`; for pi add
     `PI_CODING_AGENT_DIR: fixture.configDir` to env. Extract `fake.args` (see
     the `argsEvent` parse at `src/headless-run.test.ts:104-117`) and assert each
     expected token is present via `expect(args).toContain(...)`; assert
     `expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')`.
     For opencode assert `expect(args).not.toContain('--auto')` (platform).
   - Composition (auto + read-only): write config
     `{defaultApprovalMode:'auto', version:1}` to `$XDG_CONFIG_HOME/eh/config.json`
     (mirror `src/headless-run.test.ts:289-296`), then:
     - codex `--read-only`: `args` contains `--sandbox`,`read-only`; NOT
       `--approve-for-me`.
     - opencode `--read-only`: `args` contains `--agent`,`plan`,`--auto`.
     - claude `--read-only`: `args` contains `--permission-mode`,`plan`; assert
       `expect(args).not.toContain('auto')` (approval suppressed).
5. `bun test src/headless-run.test.ts` passes; `pnpm lint:ci` clean. Commit.

### Task 3 — Docs

1. `README.md` `### Headless runs` (after the `--timeout` sentence ending at
   line 203): add a paragraph documenting `--read-only` — "engages each
   harness's strongest own file-write restriction (claude/grok
   `--permission-mode plan`, codex `--sandbox read-only` OS sandbox, opencode
   `--agent plan`, pi `--tools read,grep,find,ls`); composes with an `auto`
   approval default and takes precedence where the native flags would collide;
   it is best-available per harness, not a uniform sandbox (network is not
   uniformly restricted)". Reference `docs/read-only.md`.
2. `DESIGN.md`:
   - File map (after line 492): add
     `src/permission-posture.ts  read-only + approval resolution (one point, both axes)`.
   - Launch plans section (after line 317): add a sentence — `--read-only`
     resolves with approval mode in `permission-posture.ts`; read-only wins and
     suppresses approval args (except opencode, where `--agent plan` composes
     with `--auto`); no-mechanism harness refuses to launch.
3. `docs/qa/eh-cli.md`: add item 18 after line 102 in section B — a `--print-env`
   / read-only manual probe per available harness (ask it to write a file under
   `--read-only`, observe refusal), noting the args are pinned by automated tests
   and this checks live behavior.
4. `pnpm lint:ci` clean. Commit.

## Verification

- `pnpm lint:ci`
- `bun test src/permission-posture.test.ts`
- `bun test src/headless-run.test.ts`
- `pnpm test`
- `bash scripts/check-version-guard.sh` (version bump present: `0.16.0`)
- Manual (owner, not implementer-blocking): one live probe per available harness
  — ask it to write a file under `--read-only`, observe refusal.

## Plan review

Fact-checked 2026-08-21 against this repo (branch
`intelligencev2/ai-3111-eh-run-implement-read-only-across-all-five-harness-adapters`).
The approach was not changed; only line-reference corrections were applied.

**Claims verified: 38.** Highlights, each confirmed by reading the code:

- `docs/read-only.md` — mapping table at lines 27–33; collision findings 41–53
  (codex 45–47, opencode 51–53); per-harness decision args 68–74; invariant
  75–83. All five exact-args rows match the plan's table verbatim.
- `src/approval-mode.ts` — `approvalArgsForHarness` + `unreachable` shape as
  quoted; auto args per harness match (claude/grok `--permission-mode auto`,
  codex `--approve-for-me`, opencode `--auto`, pi `[]`).
- `src/harnesses.ts` — import at line 7; `HarnessPlanOptions` at 58; the five
  `approvalArgsForHarness` call sites at exactly 139/198/226/286/346;
  `buildLaunchPlan` at 471 with `def.plan(...)` call at 488.
- `src/headless-run.ts` — `HeadlessRunOptions` at 35, `ResolvedHeadlessRunOptions`
  at 53, `resolved` object at 78, `buildLaunchPlan` call at 104 (approval mode
  comes from `config.defaultApprovalMode` at 109); `prepareHeadlessPlan`
  (line 658) prepends codex `exec` at 691–692, after plan args — so
  `--sandbox read-only` lands at the same pre-`exec` position as
  `--approve-for-me` does today.
- `src/main.ts` — `--print-env` valueless flag at 62; `run` subcommand at 124,
  options end at 144, `.action` at 145 with the `runHeadless` call at 146.
- `src/headless-run.test.ts` — `argsEvent` parse at 104–117; approval-default
  test at 289–333 (writes `{defaultApprovalMode:'auto', version:1}` to
  `<configDir>/eh/config.json` at 291–296, asserts `--approve-for-me` at 332,
  spawns `run codex ollama qwen3-coder`); fixtures `createFakeClaude` (1704),
  `createFakeCodex` (1735), `createFakeGrok` (1763, reads `--prompt-file`),
  `createFakeOpencode` (1837), `createFakePi` (1883), all emitting
  `{type:'fake.args', args: process.argv.slice(2), ...}`.
- `src/approval-mode.test.ts:32-40` — no-bypass test with exactly the three
  flags the plan lists.
- `src/types.ts:64-65` — `APPROVAL_MODES = ['platform','auto']`, `ApprovalMode`.
- `package.json` — version `0.15.0`; scripts `lint:ci` and `test` (= `bun test`)
  exist; `scripts/check-version-guard.sh` exists and runs standalone against
  `origin/main` (note: it needs the `gh` CLI for its already-released check).
- Docs anchors — README `### Headless runs` at 151, `--timeout` sentence ends at
  203; DESIGN.md File map heading at 486 with the `approval-mode.ts` entry at
  492, Launch plans heading at 310 with the approval paragraph ending at 317;
  `docs/qa/eh-cli.md` section B's last item is 17 and the section ends at 102 —
  all four "insert after line N" targets are correct.

**Claims corrected: 4.**

1. "Decision" section cited as lines 56–89 → 55–89 (the `## Decision` heading is
   at `docs/read-only.md:55`).
2. Reference module cited as `src/approval-mode.ts:1-46` → `1-47`, with a note
   that the quoted snippet is condensed and omits the `approvalModeLabel` export
   (lines 19–27), which the scope boundary already says stays untouched.
3. `PI_CODING_AGENT_DIR` citation `src/headless-run.test.ts:1116` → `1115`
   (1116 is the adjacent `XDG_CONFIG_HOME` line); also added the
   `src/headless-run.ts:714` evidence for grok's `--prompt-file`.
4. `buildLaunchPlan` options object cited at `src/harnesses.ts:474` → `475`
   (474 is the `model: string,` parameter).

**Assumptions flagged: 0.** No inline `(assumption — verify: ...)` markers were
needed: every in-repo claim was verified by reading the code, and the live
harness-CLI behavior claims are owned by the merged spike (`docs/read-only.md`),
which the scope boundary explicitly designates as the specification not to be
re-litigated.
