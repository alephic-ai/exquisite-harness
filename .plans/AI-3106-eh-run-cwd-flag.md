# eh run `--cwd <dir>` Implementation Plan

## Goal

Add a `--cwd <dir>` flag to `eh run` so the spawned harness child process runs
with `<dir>` as its working directory. A missing or non-directory value fails
preflight before the child is spawned; omitting the flag preserves today's
behavior exactly (child inherits `eh`'s cwd).

## Scope Boundary

**In scope:** the `--cwd` option on the `run` command (`src/main.ts`), threading
`cwd` through `HeadlessRunOptions → ResolvedHeadlessRunOptions` into the
`spawn()` call in `executePreparedHeadlessPlan` (`src/headless-run.ts`),
preflight validation, subprocess tests, README/DESIGN/QA docs, version bump.

**Out of scope (do NOT touch):**
- cwd support for the interactive launcher (`src/launch.ts`) or a config-level
  default cwd.
- Grok's temp prompt-file location (`mkdtemp` under `os.tmpdir()` — unaffected).
- Any change to `LaunchPlan` in `src/types.ts` — `cwd` rides the options
  objects, **not** the launch plan (see Load-Bearing Assumptions).

## Context for Implementer

`eh run` reads a prompt on stdin and spawns the selected harness in JSON
streaming mode. `runHeadless` (`src/headless-run.ts:48`) resolves options into
`ResolvedHeadlessRunOptions`, builds a `LaunchPlan`, then calls
`executeHeadlessPlan` → `executePreparedHeadlessPlan`, which is where `spawn()`
lives (`src/headless-run.ts:203`). That spawn passes `env` and `stdio` but **no**
`cwd`, so the child inherits `eh`'s cwd today.

`--resume-session` is the flag-addition pattern to copy. It is an optional
string plumbed `main.ts` option → `HeadlessRunOptions.resumeSessionId` →
`ResolvedHeadlessRunOptions.resumeSessionId`. `cwd` follows the same path but is
consumed at the spawn call (not in `prepareHeadlessPlan`).

Preflight failures in this file are surfaced as **normalized NDJSON on stdout**,
not raw stderr: `runHeadless`'s `try/catch` (`src/headless-run.ts:108-112`)
turns any thrown error into a `run.error` event plus a failed `run.completed`
(`exitCode: 1`) and returns 1, leaving stderr empty. The `--cwd` validation
throws inside that `try`, so it inherits this exact behavior. This is the
established contract (see Load-Bearing Assumptions for why this overrides the
ticket's "on stderr" wording).

## Load-Bearing Assumptions

- **VERIFIED — `cwd` does not belong on `LaunchPlan`.** Both `HeadlessRunOptions`
  (`src/headless-run.ts:22`) and `ResolvedHeadlessRunOptions`
  (`src/headless-run.ts:38`) are declared in `headless-run.ts`, not `types.ts`.
  `spawn` is called with `options.plan` **and** the surrounding `options` object;
  threading `cwd` on the options object reaches the spawn without touching
  `LaunchPlan`. `grep -n HeadlessRunOptions src/*.ts` confirms both interfaces
  live only in `headless-run.ts`.
- **VERIFIED — omitting `--cwd` preserves behavior.** Node's `child_process.spawn`
  treats `cwd: undefined` identically to omitting `cwd` (inherits the parent
  process cwd). So `spawn(bin, args, { cwd: options.cwd, env, stdio })` with
  `options.cwd === undefined` is a no-op change. Existing headless-run tests that
  pass no `--cwd` must stay green unmodified — this is the proof.
- **VERIFIED — preflight errors surface as `run.error` NDJSON on stdout, stderr
  empty, exit 1.** The existing preflight test asserts exactly this shape
  (`src/headless-run.test.ts:360-378`: `expect(stderr).toBe('')`, then only a
  `run.error` and a failed `run.completed` on stdout). The ticket AC says "clear
  error on stderr"; that wording conflicts with the file's established contract.
  Follow the codebase convention (stdout `run.error`) — it is consistent with
  every other preflight failure and is what orchestrators parse.
- **VERIFIED — a zod `z.object` schema strips unknown keys rather than failing.**
  Adding a `cwd` field to the fake-codex `fake.args` emit will not break the
  existing tests that `safeParse` that event with `{ args, type }` schemas
  (`src/headless-run.test.ts:103-115`). Confirmed by zod's default object
  behavior (non-strict objects strip extras).
- **VERIFIED — the fake-harness pattern reports child process state via a
  `fake.args` event.** `createFakeHarness`/`createFakeCodex`
  (`src/headless-run.test.ts:1311-1411`) write a Node script that emits
  `{ type: 'fake.args', args: process.argv.slice(2), ... }`, surfaced by `eh` as
  a `harness.event`. A `cwd: process.cwd()` field added there is readable from
  the parsed stdout events.

## File Map

- `src/headless-run.ts` — edit: add `cwd?` to both option interfaces, thread it
  into `executeHeadlessPlan`/`executePreparedHeadlessPlan`, pass `cwd` to
  `spawn`, add + call preflight validation.
- `src/headless-run.test.ts` — edit: add `cwd: process.cwd()` to the fake-codex
  emit; add one success test and two preflight-failure tests.
- `src/main.ts` — edit: add the `--cwd <dir>` option to the `run` command and
  pass `cwd: opts.cwd` to `runHeadless`.
- `README.md` — edit: document `--cwd` in `### Headless runs`.
- `DESIGN.md` — edit: note `--cwd` in `Headless execution`.
- `docs/qa/eh-cli.md` — edit: add a `--cwd` QA step under `## I. Headless runs`.
- `package.json` — edit: bump `version` `0.11.0` → `0.12.0`.

## Tasks

### Task 1 — Thread `--cwd` through the run command with preflight validation

Reference — the `--resume-session` flag in `src/main.ts:139` and its handoff at
`src/main.ts:151`:

```ts
  .option('--resume-session <id>', 'resume an existing native session')
  .action(async (harness, provider, model, opts) => {
    process.exitCode = await runHeadless({
      ...
      resumeSessionId: opts.resumeSession,
    })
  })
```

Reference — the spawn in `executePreparedHeadlessPlan` (`src/headless-run.ts:203`):

```ts
  const child = spawn(options.plan.bin, options.plan.args, {
    env: { ...process.env, ...options.plan.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
```

Steps:
1. **Test first.** In `src/headless-run.test.ts`, add `cwd: process.cwd()` to the
   `createFakeCodex` `fake.args` emit (alongside `args: process.argv.slice(2)`).
   Then add three tests inside the `describe('eh run', …)` block, modeled on the
   existing codex test (`src/headless-run.test.ts:27-128`) and the preflight
   `test.each` (`src/headless-run.test.ts:228-380`):
   - **success**: `mkdtempSync` a scratch dir, spawn `run codex ollama
     qwen3-coder --cwd <scratch>` with a `createFakeCodex()` fixture, and assert
     the parsed `fake.args` `harness.event`'s `cwd` equals `realpathSync(scratch)`
     (wrap both sides in `fs.realpathSync` — macOS `/tmp` is a symlink), exit 0,
     stderr empty.
   - **missing path**: spawn with `--cwd <scratch>/does-not-exist`; assert exit
     1, stderr `''`, stdout contains a `run.error` whose `message` mentions the
     path and a failed `run.completed` (`exitCode: 1`), and that **no**
     `harness.event` with `event.type === 'fake.args'` appears (the child never
     spawned).
   - **file, not directory**: `writeFileSync` a regular file, spawn with `--cwd
     <thatFile>`; same assertions as the missing-path case.
   Run `bun test src/headless-run.test.ts` → the three new tests FAIL (flag
   unknown / not validated / cwd not applied).
2. **Implement.** In `src/headless-run.ts`:
   - Add `statSync` to the `node:fs` import (currently `import { readFileSync }
     from 'node:fs'`).
   - Add `cwd?: string` to `HeadlessRunOptions` (after `resumeSessionId`) and
     `cwd: string | undefined` to `ResolvedHeadlessRunOptions`; set
     `cwd: options.cwd` in the `resolved` object literal (`src/headless-run.ts:57`).
   - Add a validator and call it inside `runHeadless`'s `try`, after `resolved`
     is built and before `buildLaunchPlan`:
     ```ts
     if (resolved.cwd !== undefined) assertRunnableCwd(resolved.cwd)
     ```
     ```ts
     function assertRunnableCwd(cwd: string) {
       let stats
       try {
         stats = statSync(cwd)
       } catch {
         throw new Error(`--cwd "${cwd}" does not exist`)
       }
       if (!stats.isDirectory()) {
         throw new Error(`--cwd "${cwd}" is not a directory`)
       }
     }
     ```
   - Add `cwd?: string` to the `executeHeadlessPlan` and
     `executePreparedHeadlessPlan` option types, thread `cwd: resolved.cwd` at
     the `executeHeadlessPlan` call site (`src/headless-run.ts:101-105`), and add
     `cwd: options.cwd,` to the `spawn` options object.
   In `src/main.ts`, add to the `run` command options (after `--resume-session`,
   `src/main.ts:139`):
   ```ts
   .option('--cwd <dir>', 'run the spawned harness in this working directory')
   ```
   and pass `cwd: opts.cwd,` in the `runHeadless({ … })` call (`src/main.ts:141`).
3. **Pass.** `bun test src/headless-run.test.ts` → all green (new + existing).
4. **Commit** `feat: add eh run --cwd for the spawned harness`.

### Task 2 — Docs and version bump

Steps:
1. **README.md** (`### Headless runs`, near `src`/line 173): after the
   `--resume-session` sentence, add that `--cwd <dir>` sets the spawned harness
   child's working directory and that a missing or non-directory value fails
   before launch.
2. **DESIGN.md** (`Headless execution`, near line 90 where it says "The caller
   owns cwd …"): note that `--cwd <dir>` lets the caller set the child's working
   directory, validated before spawn.
3. **docs/qa/eh-cli.md** (`## I. Headless runs`): add a step: `printf 'run pwd
   and print it' | eh run claude vercel-ai-gateway <model> --cwd /tmp` runs the
   child in `/tmp`; a nonexistent `--cwd` exits non-zero with a `run.error`
   before any harness event.
4. **package.json**: bump `version` from `0.11.0` to `0.12.0`.
5. **Verify** `bash scripts/check-version-guard.sh --staged` passes (stage the
   files first: `git add -A`).
6. **Commit** `docs: document eh run --cwd and bump version`.

## Verification

```bash
pnpm lint:ci
bun test src/headless-run.test.ts
pnpm test
git add -A && bash scripts/check-version-guard.sh --staged
```

Manual (optional, needs a real provider+key):
```bash
printf 'run pwd and print it' | pnpm dev run claude vercel-ai-gateway anthropic/claude-opus-5 --cwd /tmp
```
