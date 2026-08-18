# QA: OpenRouter Gateway parity

Scope: OpenRouter as a first-class routing provider — Anthropic Messages for
Claude Code, upstream picker / `--gateway-provider` / ZDR, cost capture, and the
adjacent Vercel/Ollama regressions those changes can break. Drive the real `eh`
CLI (`pnpm dev` / `tsx src/main.ts`). Interactive pickers need a PTY.

## Coverage map

| Surface                                                        | How it is covered                       |
| -------------------------------------------------------------- | --------------------------------------- |
| Claude + OpenRouter Anthropic skin                             | B.1–B.3, F.1                            |
| Codex / Grok / opencode / pi + OpenRouter                      | B.4–B.7                                 |
| Upstream pin + ZDR flags                                       | B.8–B.11, C.3–C.4                       |
| Model list cost labels                                         | B.12                                    |
| Persistence (profile / recent pin)                             | E.1–E.2                                 |
| Failure modes (missing key, bad slug, wrong provider)          | C.1–C.5                                 |
| Adjacent Vercel + Ollama regressions                           | D.1–D.4                                 |
| Interactive picker (OpenRouter compatible, not "needs router") | G.1                                     |
| Live billed launch + exact cost                                | H.1 (needs a real `OPENROUTER_API_KEY`) |

## Prerequisites

- Worktree: `exquisite-harness-openrouter-parity`, branch `openrouter-parity`.
- `pnpm install` done; run the CLI as `pnpm dev -- <args>` or `tsx src/main.ts`.
- Point `XDG_CONFIG_HOME` at a temp directory for every step unless the step
  says otherwise, so this run does not mutate the operator's real
  `~/.config/eh`.
- Confirm whether `OPENROUTER_API_KEY` is set **without printing the value**.
  H.1 is BLOCKED when it is unset and no stored `eh` key exists for
  `openrouter`. A dummy env value is enough for `--print-env` (B/C/D/E).
- Confirm whether `AI_GATEWAY_API_KEY` or a stored Gateway key exists **without
  printing it** — D.3 uses it when present.
- PTY harness (`expect`, `script(1)`, or Python `pty`) for G.1.

## A. Static gates

1. In the worktree, run `pnpm lint`. → exits 0 (eslint + prettier + tsc).
2. Run `pnpm test`. → all tests pass.
3. Run `git diff --check`. → no whitespace errors.

## B. Flag-driven OpenRouter launch plans (no TTY)

Use a temp `XDG_CONFIG_HOME`. Set `OPENROUTER_API_KEY` to a dummy non-empty
value unless the step says otherwise.

1. `eh --print-env claude openrouter anthropic/claude-sonnet-4.6` →
   `ANTHROPIC_BASE_URL='https://openrouter.ai/api'`,
   `ANTHROPIC_MODEL='anthropic/claude-sonnet-4.6'`, `ANTHROPIC_SMALL_FAST_MODEL`
   matches, `ANTHROPIC_API_KEY=''`, and `ANTHROPIC_AUTH_TOKEN` is redacted/`•••`
   is not required here (print-env prints the dummy). Exit 0.
2. Same command, inspect notes / comments → no "needs the eh router" error.
3. Repeat B.1 with a dummy model id `x` → still prints
   `ANTHROPIC_BASE_URL='https://openrouter.ai/api'` (the skin URL does not
   depend on the model existing). Exit 0.
4. `eh --print-env codex openrouter openai/gpt-5.1` → args include
   `wire_api="chat"` and `env_key="OPENROUTER_API_KEY"`,
   `base_url="https://openrouter.ai/api/v1"`. Exit 0.
5. `eh --print-env grok openrouter openai/gpt-5.1` → temporary-artifacts error
   (Grok isolated home), non-zero, no exports. Same as other Grok print-env.
6. `eh --print-env opencode openrouter anthropic/claude-sonnet-4.6` →
   `OPENCODE_CONFIG_CONTENT` names `eh-openrouter` and
   `https://openrouter.ai/api/v1`; args include
   `-m eh-openrouter/anthropic/claude-sonnet-4.6`. Exit 0.
7. `eh --print-env pi openrouter anthropic/claude-sonnet-4.6` → args
   `--provider openrouter --model anthropic/claude-sonnet-4.6`. Exit 0 (pi knows
   openrouter natively).
8. `eh --print-env --gateway-provider anthropic claude openrouter anthropic/claude-sonnet-4.6`
   → same Anthropic skin env as B.1 plus a comment
   `gateway provider: anthropic (pinned by an eh loopback proxy on launch)`.
   Exit 0. No proxy is started.
9. `eh --print-env --gateway-provider deepinfra/turbo claude openrouter anthropic/claude-sonnet-4.6`
   → comment names `deepinfra/turbo`. Slash slugs are accepted. Exit 0.
10. `eh --print-env --gateway-provider anthropic --gateway-zdr` is not a flag;
    ZDR is picker/profile only. Instead write a profile JSON with
    `"provider":"openrouter","gatewayZdr":true` and launch via the profile name
    with `--print-env` → comment `gateway routing: ZDR only`. Exit 0.
11. `eh --print-env --gateway-provider anthropic opencode openrouter anthropic/claude-sonnet-4.6`
    → OpenCode plan comment includes the pin. Exit 0.
12. `eh --print-env claude openrouter anthropic/claude-sonnet-4.6` (same as B.1)
    → `EH_PRICE_IN` / `EH_PRICE_OUT` / `EH_RATE_LABEL` are populated (`$…` range
    or a single pair). `eh models openrouter` lists ids + context hints only —
    cost labels live on the picker and in those env vars.

## C. Failure modes

Temp `XDG_CONFIG_HOME`. Unset `OPENROUTER_API_KEY` and do not store a key.

1. `eh --print-env claude openrouter anthropic/claude-sonnet-4.6` →
   `no API key for "openrouter"`, non-zero, no `ANTHROPIC_BASE_URL` export.
2. `eh --print-env --gateway-provider bedrock claude ollama qwen3-coder` →
   `--gateway-provider requires OpenRouter or Vercel AI Gateway`, non-zero.
3. With dummy `OPENROUTER_API_KEY`,
   `eh --print-env --gateway-provider 'not valid' claude openrouter x` →
   `invalid gateway provider "not valid"`, non-zero.
4. With dummy `OPENROUTER_API_KEY`,
   `eh --print-env --gateway-provider anthropic pi openrouter x` → either a
   valid pi pin plan (extension note) or a clear error. Record the actual
   contract: pi **does** support routing via `--extension` after this change.
5. `eh --help` → mentions OpenRouter in `--gateway-provider` help
   (`pin OpenRouter or Vercel AI Gateway`).

## D. Adjacent regressions

Temp `XDG_CONFIG_HOME`.

1. `eh --print-env claude ollama qwen3-coder` →
   `ANTHROPIC_BASE_URL='http://localhost:11434'`,
   `ANTHROPIC_AUTH_TOKEN='ollama'`. Exit 0.
2. `eh --print-env --gateway-provider bedrock codex ollama qwen3-coder` → same
   C.2 error (Ollama is not a routing provider).
3. If a Gateway key is configured (env or store; do not print it):
   `eh --print-env --gateway-provider bedrock claude vercel-ai-gateway anthropic/claude-sonnet-4.6`
   → `ANTHROPIC_BASE_URL` is the Vercel host (not `openrouter.ai`), plus
   `gateway provider: bedrock`. Exit 0.
4. `eh --print-env claude vercel-ai-gateway x` with no Gateway key in the temp
   config/env → `no API key for "vercel-ai-gateway"`, non-zero.

## E. Persistence

Temp `XDG_CONFIG_HOME`. Dummy `OPENROUTER_API_KEY`. Use a fake `claude` first on
`PATH` that prints env/args and exits 0.

1. `eh --save or-bedrock claude openrouter anthropic/claude-sonnet-4.6 --gateway-provider amazon-bedrock`
   → profile `or-bedrock` is written with `provider: openrouter` and
   `gatewayProvider: amazon-bedrock`. Then `eh --print-env or-bedrock` → pin
   comment `gateway provider: amazon-bedrock`.
2. After E.1, read `$XDG_CONFIG_HOME/eh/config.json` → `recent[0]` has the same
   provider, model, and `gatewayProvider`.

## F. Fake-harness launch (no live billing)

Temp `XDG_CONFIG_HOME`. Dummy `OPENROUTER_API_KEY`. Fake `claude` on `PATH`.

1. `eh claude openrouter anthropic/claude-sonnet-4.6` → no picker; fake claude
   prints `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` (cost-capture proxy) and
   `ANTHROPIC_MODEL=anthropic/claude-sonnet-4.6`. eh exits 0. The official skin
   URL is the `--print-env` contract (B.1), not the spawned child.
2. `eh claude openrouter anthropic/claude-sonnet-4.6 --gateway-provider anthropic`
   with the dummy key → fake claude still starts on a loopback base URL
   (OpenRouter `/endpoints` is public, so pin validation does not need a real
   key). A deliberately unavailable slug such as `not-a-provider` fail-closes
   before spawn with `unavailable for model` and the available tag list.

## G. Interactive picker (PTY)

Temp `XDG_CONFIG_HOME`. Dummy `OPENROUTER_API_KEY`.

1. `eh claude` → provider picker lists `openrouter` as compatible (hint contains
   `openrouter` and `✓ key set` or the dummy env source). It must **not** show
   `needs router`. Esc / Ctrl+C → `bye`, exit 0.

## H. Conditional live OpenRouter launch

Only when a real `OPENROUTER_API_KEY` or stored `eh` key for `openrouter` is
present. Do not print the key.

1. Launch
   `eh claude openrouter <cheap-or-known-model> --gateway-provider anthropic`,
   send one short prompt, then exit. → Claude starts against OpenRouter (no
   "needs router"); statusline shows a session cost (`$…` or `~$…` or `—` if
   unpriced). A missing real key → mark BLOCKED, not FAIL.

## Known limitations

- Dummy keys cannot fetch a live model catalog or validate that `anthropic`
  actually hosts a given model. B.12 may be an auth error; that is still a pass
  if the error is user-facing.
- Grok `--print-env` is intentionally unsupported (isolated home).
- Live billed traffic is opt-in via a real key (H.1).
- Full `docs/qa/firecrawl-search-proxy.md` and
  `docs/qa/claude-custom-model-context.md` are out of this feature's surface.

## Automated coverage

- `src/providers.test.ts` — OpenRouter model list + endpoint tags / 30m
  throughput.
- `src/gateway-routing.test.ts` — OpenRouter `provider.only` / `zdr` injection
  and Claude Anthropic-skin plan.
- `src/gateway-costs.test.ts` — `usage.cost` capture and `/api` path prefix.
- `src/pricing.test.ts` — pinned rate label uses the endpoint `tag`.
- `pnpm test` / `pnpm lint` cover the rest of the CLI contract.
