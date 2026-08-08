# QA: Claude custom-model context window (PR #43)

Scope: Claude Code launches through `eh` with a third-party model whose provider
publishes a context window, including new launches, resume plans, missing
metadata fallback, and the release binary. The app is a CLI, so all manual steps
are driven in a terminal.

## Prerequisites

- `pnpm install` has completed.
- Build and run the branch binary as `./dist/eh`, not an installed release.
- `claude --version` succeeds.
- A Vercel AI Gateway key is configured without printing its value.
- Vercel AI Gateway lists `alibaba/qwen-3-235b` with a published context window.
- Run evidence goes under `tmp/qa-runs/claude-custom-model-context/`, which must
  be gitignored.

## A. Static and packaging gates

1. Run `pnpm lint:ci`. → ESLint, Prettier, and TypeScript all exit 0.
2. Run `bun test`. → every repository test exits 0, including the assertion that
   a 256k provider window becomes both context environment variables.
3. Run `pnpm build`, then `./dist/eh --version`. → the standalone binary builds
   and prints the version in `package.json`.
4. Run `bash scripts/check-version-guard.sh` and `git diff --check`. → the
   release version is greater than `origin/main`, no matching release exists,
   and the diff has no whitespace errors.

## B. Launch-plan context contract

1. Run `./dist/eh --print-env claude vercel-ai-gateway alibaba/qwen-3-235b`. →
   the output includes identical values for `EH_CONTEXT_WINDOW` and
   `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, matching the provider-published window;
   credentials remain redacted from the QA record.
2. Run `./dist/eh -r --print-env claude vercel-ai-gateway alibaba/qwen-3-235b`.
   → the same two context values appear and the printed Claude arguments include
   `--resume`.
3. Run
   `./dist/eh --print-env claude vercel-ai-gateway qa/nonexistent-context-model`.
   → the command exits 0 but prints neither context variable, so `eh` does not
   invent a window when provider metadata is absent.

## C. Real Claude Code acceptance

1. Run `claude --version`. → record the installed Claude Code version.
2. In a PTY at least 140 columns wide, run
   `./dist/eh claude vercel-ai-gateway alibaba/qwen-3-235b`, send
   `Reply with exactly EH_QWEN_CONTEXT_OK`, wait for the completed turn, then
   exit Claude. → Claude starts without the
   `is not a model this version of Claude Code recognizes` context-window
   warning, the model returns a normal assistant turn, and Claude prints a
   resumable session ID on exit.
3. Open the saved Claude JSONL for that session. → its assistant row identifies
   `alibaba/qwen-3-235b`, has `stop_reason: "end_turn"`, and contains no API
   error record.

## Known limitations

- This run does not fill the session to 200k or 256k tokens; it validates Claude
  Code's declared compaction window and a real short turn.
- Model quality and instruction-following beyond one deterministic response are
  excluded.
- `eh run` disables the interactive statusline metadata path and is covered by
  its existing headless adapter tests, not this interactive warning regression.
- Provider outages, account exhaustion, and provider-reported metadata drift can
  block the live acceptance step.

## Automated coverage

- `src/statusline.test.ts`: provider context serialization to
  `EH_CONTEXT_WINDOW` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
- `src/pricing.test.ts`: Vercel AI Gateway context-window parsing.
- `src/flow.test.ts`: printed launch-plan behavior.
- `pnpm lint:ci`, `bun test`, `pnpm build`,
  `bash scripts/check-version-guard.sh`, and `git diff --check`: static,
  regression, packaging, release, and whitespace gates.
