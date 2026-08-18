# QA: model-specific effort filtering

Scope: effort picker and `-e` intersect each harness's accepted levels with the
model's reported efforts (OpenRouter `reasoning.supported_efforts`, Vercel
`reasoning_options`). Codex no longer silently remaps `xhigh`/`max` to `high`.
Drive the real `eh` CLI (`pnpm dev` / `tsx src/main.ts`). Interactive pickers
need a PTY.

## Coverage map

| Surface                                        | How it is covered |
| ---------------------------------------------- | ----------------- |
| CLI help enumerates the new levels             | B.1               |
| Codex `xhigh`/`max` pass-through               | B.2–B.3           |
| Claude harness list (Ollama, no model efforts) | B.4–B.5           |
| Codex accepts `none` / `minimal`               | B.6               |
| opencode ignores explicit effort               | B.7               |
| pi `--thinking` unchanged                      | B.8               |
| OpenRouter model list intersection fail-closed | C.1–C.3           |
| Adjacent Ollama / Grok / Vercel regressions    | D.1–D.3           |
| Persistence of an explicit effort              | E.1               |
| Interactive effort picker                      | F.1–F.2           |
| Live OpenRouter list (optional)                | G.1               |

## Prerequisites

- Worktree: `exquisite-harness-model-effort-filter`, branch
  `model-effort-filter`.
- `pnpm install` done; run the CLI as `pnpm dev -- <args>` or
  `./node_modules/.bin/tsx src/main.ts`.
- Point `XDG_CONFIG_HOME` at a temp directory for every step unless the step
  says otherwise, so this run does not mutate the operator's real
  `~/.config/eh`.
- Confirm whether `OPENROUTER_API_KEY` is set **without printing the value**.
  G.1 is BLOCKED when it is unset and no stored `eh` key exists for
  `openrouter`. A dummy env value is enough for `--print-env` on Ollama.
- PTY harness (`expect`, `script(1)`, or Python `pty`) for F.1–F.2.

## A. Static gates

1. In the worktree, run `pnpm lint`. → exits 0 (eslint + prettier + tsc).
2. Run `pnpm test`. → all tests pass.
3. Run `git diff --check`. → no whitespace errors.

## B. Flag-driven effort (no TTY)

Temp `XDG_CONFIG_HOME`. No OpenRouter key required.

1. `eh --help` → `-e, --effort` help lists
   `auto, none, minimal, low, medium, high, xhigh, max`.
2. `eh --print-env codex ollama qwen3-coder -e xhigh` → stdout contains
   `model_reasoning_effort="xhigh"` and does **not** contain
   `model_reasoning_effort="high"` as the only effort line. Exit 0.
3. Same with `-e max` → `model_reasoning_effort="max"`. Exit 0.
4. `eh --print-env claude ollama qwen3-coder -e high` →
   `CLAUDE_CODE_EFFORT_LEVEL=high`. Exit 0.
5. `eh --print-env claude ollama qwen3-coder -e none` → non-zero,
   `effort "none" is not available for this model`.
6. `eh --print-env codex ollama qwen3-coder -e none` →
   `model_reasoning_effort="none"`. Exit 0.
7. `eh --print-env opencode ollama qwen3-coder -e high` → exit 0; notes mention
   ignoring effort; args still include `-m eh-ollama/qwen3-coder`.
8. `eh --print-env pi ollama qwen3-coder -e high` with a runnable ollama entry
   in a temp `PI_CODING_AGENT_DIR/models.json` → args include `--thinking high`.
   Exit 0.

## C. OpenRouter list intersection (loopback)

Temp `XDG_CONFIG_HOME`. Dummy `OPENROUTER_API_KEY`. Stand up a loopback HTTP
server that answers `GET /v1/models` with:

```json
{
  "data": [
    {
      "id": "test/limited",
      "reasoning": { "supported_efforts": ["low", "medium"] }
    },
    { "id": "test/plain" }
  ]
}
```

Write `config.json` with a custom provider:

```json
{
  "version": 1,
  "profiles": {},
  "providers": {
    "or-loop": {
      "type": "openrouter",
      "baseURL": "http://127.0.0.1:<port>/v1",
      "envKey": "OPENROUTER_API_KEY"
    }
  },
  "recent": []
}
```

1. `eh --print-env claude or-loop test/limited -e high` → non-zero,
   `effort "high" is not available` and `available: auto, low, medium`.
2. `eh --print-env claude or-loop test/limited -e medium` → exit 0,
   `CLAUDE_CODE_EFFORT_LEVEL=medium`.
3. `eh --print-env claude or-loop test/plain -e high` → exit 0 (omitted
   `reasoning` keeps Claude's harness list). `-e none` → non-zero.

## D. Adjacent regressions

Temp `XDG_CONFIG_HOME`.

1. `eh --print-env claude ollama qwen3-coder` (no `-e`) →
   `ANTHROPIC_BASE_URL='http://localhost:11434'`, no `CLAUDE_CODE_EFFORT_LEVEL`.
   Exit 0.
2. `eh --print-env grok ollama qwen3-coder -e high` → temporary-artifacts error,
   non-zero, no exports.
3. `eh --print-env --gateway-provider bedrock claude ollama qwen3-coder` →
   `--gateway-provider requires OpenRouter or Vercel AI Gateway`, non-zero.

## E. Persistence

Temp `XDG_CONFIG_HOME`. Dummy key not required. Fake `codex` first on `PATH`
that prints args and exits 0.

1. `eh --save xhigh-codex codex ollama qwen3-coder -e xhigh` → profile
   `xhigh-codex` has `"effort":"xhigh"`. Then `eh --print-env xhigh-codex` →
   `model_reasoning_effort="xhigh"`.

## F. Interactive picker (PTY)

Temp `XDG_CONFIG_HOME`.

1. `eh claude ollama` → model picker, pick `other…`, type `qwen3-coder` → effort
   picker lists `auto` first, then `low`, `medium`, `high`, `xhigh`, `max`. It
   must **not** list `none` or `minimal`. Esc / Ctrl+C → `bye`, exit 0.
2. `eh opencode ollama` → model picker, pick a model → confirm `launch?` appears
   with **no** effort picker (opencode has no knob). Esc / Ctrl+C → `bye`,
   exit 0. Do not use a fully specified `eh opencode ollama <model>` command
   here — that path skips every picker and launches immediately.

## G. Conditional live OpenRouter list

Only when a real `OPENROUTER_API_KEY` or stored `eh` key for `openrouter` is
present. Do not print the key.

1. `eh --print-env claude openrouter anthropic/claude-sonnet-4.6 -e high` →
   either a valid Claude plan (exit 0, `CLAUDE_CODE_EFFORT_LEVEL=high`) or a
   clear `effort "high" is not available` listing the model's reported set. A
   missing real key → mark BLOCKED, not FAIL.

## Known limitations

- Dummy keys cannot fetch the public OpenRouter catalog if the listing endpoint
  requires auth; C uses a loopback fixture for that contract.
- Grok `--print-env` is intentionally unsupported (isolated home).
- Live billed traffic is out of scope.
- Full `docs/qa/eh-cli.md` and `docs/qa/openrouter-parity.md` are adjacent
  runbooks, not this feature's surface.

## Automated coverage

- `src/providers.test.ts` — OpenRouter `supported_efforts` / null / mandatory
  and Vercel `reasoning_options`.
- `src/harnesses.test.ts` — Codex pass-through; `availableEfforts` /
  `assertEffortAllowed`.
- `src/flow.test.ts` — `eh --print-env … -e xhigh` keeps `xhigh`.
- `pnpm test` / `pnpm lint` cover the rest of the CLI contract.
