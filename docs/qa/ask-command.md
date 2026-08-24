# QA: `eh ask` and delegation skill (PR #54)

Scope: changed-surface regression coverage for the non-interactive `eh ask`
entry point and the `eh skill print` / `eh skill install` commands. The app is a
CLI, so manual steps are driven in a terminal rather than a browser.

## Prerequisites

- `pnpm install` has completed and Bun is available.
- Run commands from the branch checkout using `./dist/eh` after building; do not
  use an installed release.
- Use a fresh temporary `XDG_CONFIG_HOME` and a deterministic fake `codex`
  binary for the no-billing delegation steps. Do not print real credentials.
- Keep run evidence under `tmp/qa-runs/ask-command/`; it must remain ignored.

## A. Static and packaging gates

1. Run `pnpm lint:ci`. → ESLint, Prettier, and TypeScript all exit 0.
2. Run `bun test`. → every repository test exits 0, including the `eh ask`,
   embedded-skill, install, and symlink-regression tests.
3. Run `pnpm build`, then `./dist/eh --version`. → the standalone binary builds
   and prints `0.17.0`.
4. Run `bash scripts/check-version-guard.sh` and `git diff --check`. → the
   release version is strictly ahead of `origin/main`, and no whitespace errors
   are reported.

## B. Command discovery and skill output

1. Run `./dist/eh --help`. → the help lists
   `ask [options] <harness> <provider> <model>` and the `skill` command without
   opening an interactive picker.
2. Run `./dist/eh ask --help`. → the command lists the shared headless options:
   `--reasoning-effort`, `--native-args-json`, `--gateway-provider`,
   `--resume-session`, `--cwd`, and `--timeout`.
3. Run `./dist/eh skill --help` and `./dist/eh skill install --help`. → the
   print/install subcommands and required `--dir <dir>` option are visible.
4. Run `./dist/eh skill print > "$RUN_DIR/printed-skill.md"`, then compare it
   with `skills/eh-delegate/SKILL.md`. → the files are byte-identical and the
   output starts with the `eh-delegate` frontmatter.

## C. `eh ask` delegation contract

1. Put a fake `codex` executable on `PATH` that reads stdin and emits the
   smallest valid Codex JSON stream: `thread.started`, an `item.completed`
   `agent_message`, and `turn.completed`. Set `XDG_CONFIG_HOME` to an empty
   temporary directory.
2. Run `printf 'delegate this task' | ./dist/eh ask codex ollama qwen3-coder`. →
   exit 0; stdout is versioned NDJSON containing `run.started`,
   `session.started`, `assistant.text` with `saw: delegate this task`, and a
   successful `run.completed`; no UI text appears and fake-harness stderr is
   preserved separately.
3. Inspect the temporary config directory. → no `eh/config.json` is created; the
   command does not write recents or mutate configuration.
4. Repeat with
   `--reasoning-effort high --native-args-json '["--sandbox","read-only"]' --resume-session thread-previous`.
   → the fake harness receives the native arguments plus the expected Codex
   machine-mode/resume arguments, and the normalized event contract remains
   unchanged.
5. Run the equivalent stdin prompt through
   `./dist/eh run codex ollama qwen3-coder`. → the existing `eh run` path still
   emits the same normalized contract and does not create configuration state.
6. Run `./dist/eh ask codex ollama qwen3-coder </dev/null`. → exit 64 with a
   versioned `run.error` explaining that a prompt is required; the fake harness
   is not spawned.

## D. Skill installation safety and lifecycle

1. Run `./dist/eh skill install --dir "$RUN_DIR/skill"` twice. → the first run
   creates `SKILL.md`; the second succeeds without changing its bytes.
2. Replace that file with different text and rerun without `--force`. → the
   command exits non-zero, names the destination, and tells the user to use
   `--force`; the differing file remains unchanged.
3. Run the same command with `--force`. → the file is replaced with the exact
   embedded skill content.
4. Create a symlink at `"$RUN_DIR/symlink/SKILL.md"` pointing to a separate
   target file, then run installation there. → the command exits non-zero with a
   symlink refusal and the target file remains unchanged.
5. Create a real directory and an intermediate symlink to it, then run
   installation into a new child below the symlink. → the command exits non-zero
   with a symlink refusal and does not create `SKILL.md` in the real target
   directory.

## Known limitations

- This is smoke/regression QA for the changed CLI contracts, not full QA of
  every existing `docs/qa/*.md` runbook.
- No browser or deployed app exists for this CLI feature; no browser evidence or
  real third-party provider/model execution is required here.
- Real harness behavior, provider authentication, billing, and live model
  quality remain covered by the existing provider-specific runbooks and are
  excluded from this local fake-harness pass.

## Automated coverage

- `src/headless-run.test.ts`: `eh ask` stdin delegation, normalized events,
  option forwarding, preflight failures, and no config mutation.
- `src/skill.test.ts`: help discovery, checked-in skill output, idempotent
  install, differing-content refusal, force replacement, and destination symlink
  and intermediate-path symlink protection.
- `pnpm lint:ci`, `bun test`, `pnpm build`,
  `bash scripts/check-version-guard.sh`, and `git diff --check`: static,
  regression, packaging, release, and whitespace gates.
