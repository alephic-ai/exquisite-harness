# QA: eh CLI

Scope: the whole `eh` CLI — flag-driven paths, interactive picker flows,
profiles/recents, model cache, doctor/providers/models, and key storage. The app
is a CLI, so "drive the browser" becomes "drive the terminal": flag paths run
directly; interactive clack flows run under a PTY harness.

## Prerequisites

- `pnpm install` done; `pnpm dev` runs `tsx src/main.ts`.
- Ollama running locally (`ollama serve`) with ≥1 model pulled — steps that hit
  `localhost:11434` depend on it. If it's down, mark those steps BLOCKED.
- Harness binaries (`claude`, `codex`, `grok`) only need to exist for doctor and
  the conditional live step. Launch steps F.1–F.3 use a **fake harness binary**;
  F.4 is the explicit real-Claude exception.
- No real API keys are needed except for conditional step F.4. Other
  OpenRouter/Vercel AI Gateway steps use `--print-env` and a fake
  `secret-tool`/Keychain probe.
- PTY harness: `scripts/pty-drive.mjs` (node-pty if available, else `script(1)`
  on macOS / `python3 -c pty`) drives interactive flows.

## A. Static gates

1. Run `pnpm lint`. → exits 0 (eslint + prettier + tsc all clean).

## B. Flag-driven launch plans (no TTY)

Each prints env/args and exits 0 without launching.

1. `eh --print-env claude ollama qwen3-coder` → prints
   `ANTHROPIC_BASE_URL='http://localhost:11434'`, `ANTHROPIC_MODEL`,
   `ANTHROPIC_AUTH_TOKEN='ollama'`, `ANTHROPIC_SMALL_FAST_MODEL`.
2. `eh --print-env codex ollama qwen3-coder` →
   `# plus args: codex -c model="qwen3-coder" ... wire_api="responses"`; no
   `env_key` line.
3. `eh --print-env grok ollama qwen3-coder` → `GROK_BASE_URL=.../v1`,
   `GROK_API_KEY='ollama'`, `--model qwen3-coder`.
4. `eh --print-env codex openrouter openai/gpt-5.1` (openrouter configured) →
   `wire_api="chat"`, `env_key="OPENROUTER_API_KEY"`.
5. `eh --print-env claude openrouter x` → error "cannot serve the Anthropic
   protocol (needs the eh router, phase 2)", non-zero exit.
6. `eh --print-env claude vercel-ai-gateway x` with `AI_GATEWAY_API_KEY` unset
   and no stored key → error "no API key for \"vercel-ai-gateway\"", non-zero
   exit.
7. `eh -r --print-env claude ollama qwen3-coder` → args end with `--resume`.
8. `eh -r --print-env codex ollama qwen3-coder` → args end with `resume` (after
   the `-c` overrides).
9. `eh -r --print-env grok ollama qwen3-coder` → args end with `--resume`.
10. `eh --print-env codex ollama openai/gpt-5.6 -e xhigh` → args contain
    `model_reasoning_effort="xhigh"` exactly, with no downgrade note. Repeat
    with `none`, `minimal`, `max`, and `ultra` → each exact value is preserved.

## C. Config / error paths

1. Point `XDG_CONFIG_HOME` at a temp dir; write a **malformed** `config.json`.
   Run any command. → friendly "invalid config at <path> — not valid JSON", not
   a stack trace.
2. Write a syntactically valid but schema-wrong config (e.g. `"version": 2`). →
   "invalid config at <path> — version: Invalid literal…".
3. `eh bogus` → "unknown harness or profile \"bogus\" (known: claude, codex,
   grok)", non-zero exit.
4. `eh claude ollama` with stdout not a TTY → "incomplete arguments and stdout
   is not a TTY", non-zero exit.
5. `eh -r` without a TTY → "eh -r opens a session picker — needs an interactive
   terminal", non-zero exit. In a directory with no sessions in any harness
   store (PTY) → "no sessions for this directory", non-zero exit.
6. Config with two recents — one's `cwd` matching the current directory, one
   older with a different `cwd` — then `eh -r --print-env` → uses the
   cwd-matching combo. Delete the `cwd` fields → falls back to the most recent.
7. Launch the same combo in two directories (fake harness binary), then again in
   the first → recents keep one entry per directory; the second launch in a
   directory replaces only that directory's entry.
8. `eh -r codex --print-env` with a codex recent for this directory → inherits
   provider/model, no prompts. `-p` naming the recent's provider still inherits
   the model; `-p` naming a different provider → "incomplete arguments" non-TTY.
   A non-codex recent → no inheritance (prompts, or non-TTY error).
9. cd into a directory, delete it from another shell, then any `eh` command →
   the runtime refuses before eh's code runs ("The current working directory was
   deleted…"), non-zero exit — no raw `uv_cwd` stack trace.

## D. Interactive flows (PTY harness)

Drive each with the PTY; assert on screen text.

1. **First-run wizard**: empty config dir, run `eh`. → intro banner, a
   "detected" note listing harnesses + ollama status, then a "write this
   config?" prompt. Answer yes → config written to disk with expected keys.
2. **Home**: with one recent entry present, run `eh`. → home select lists the
   recent combo with a relative-time hint, plus "new session →", "providers",
   "doctor". Enter on the recent → launch-plan note with **redacted** secrets
   (`ANTHROPIC_AUTH_TOKEN=•••`), and go/save/back options.
3. **Pickers**: run `eh claude` → provider picker lists ollama (compatible) and,
   if configured, openrouter. Arrow down to focus openrouter → its hint reads
   "needs router (phase 2)" (clack only shows the focused row's hint). Pick
   ollama → model picker lists live Ollama models with size hints, plus
   "other…". Select a model → confirm screen.
4. **Manual model entry**: in the model picker choose "other…" → text prompt
   appears; type a model id → accepted and shown in the confirm note.
5. **Cancel**: at any picker, press Ctrl+C → "bye" and exit 0 (no stack).
6. **Save profile**: at confirm screen choose "save…" → profile-name prompt;
   enter a name → success line and the profile exists in config.json.
7. **`eh provider add`**: run it → name/type/baseURL/envKey prompts; for a
   non-ollama type, "store an API key now?" → masked password prompt (input not
   echoed) → stored in Keychain (macOS) or 0600 file.
8. **Resume picker**: with claude + codex sessions for the current directory on
   disk, run `eh -r` → one filterable list, newest first, hints read
   `harness · model · <age>`; sessions show up whether or not eh launched them.
   Type to filter. Pick one → resumes that session by id (fake harness asserts
   the `--resume <id>` / `resume <id>` arg). Esc → "bye", exit 0.
9. **Resume filter**: `eh -r codex` → only codex sessions listed. A session
   whose harness bin is not on PATH → "not installed" hint; selecting it warns
   and re-prompts.
10. **Resume wiring**: with a recent for (claude, model X) in this directory,
    pick a claude session whose model is X → resumes on that recent's provider
    with no further prompts. `-p`/`-m` override.
11. **Model-specific effort — Vercel shape**: configure a `vercel-gateway`
    fixture with `envKey: "FIXTURE_API_KEY"` whose `/v1/models` response
    contains one model with
    `reasoning_options: [{"type":"effort","values":["minimal","high"]}]`. Run
    `FIXTURE_API_KEY=fake eh --print-env codex <fixture>` and select it → effort
    picker contains exactly `auto`, `minimal`, `high`; select `high` → printed
    args contain `model_reasoning_effort="high"`.
12. **Model-specific effort — OpenRouter shape**: configure a no-key
    `openai-chat` fixture with one model whose `reasoning.supported_efforts` is
    `["max","high","low"]`. Select it with `eh --print-env codex <fixture>` →
    picker contains exactly `auto`, `low`, `high`, `max` in normalized order; it
    does not contain `medium`, `xhigh`, or `ultra`.
13. **No exact effort metadata**: the same fixture lists a model with no
    `reasoning.supported_efforts`, and one with only toggle/budget reasoning.
    Select either with `--print-env` → no effort prompt appears and printed args
    contain no effort override. Choose `other…` and type a manual ID → same
    no-prompt behavior.
14. **Harness intersection**: serve a Vercel-style model with
    `none|minimal|low|medium|high|xhigh|max|ultra`. Select it through Claude
    with `FIXTURE_API_KEY=fake` → picker shows only
    `auto|low|medium|high|xhigh|max`. Select it through Codex or Grok → every
    provider-published value appears.

## E. Key storage

1. `eh provider key openrouter` (PTY, key via stdin prompt) → stored in Keychain
   on macOS (`security find-generic-password -s eh -a openrouter -w` returns it)
   or 0600 file elsewhere; value never echoed to screen.
2. Resolve precedence: with the key stored AND `OPENROUTER_API_KEY` set in the
   shell, a `grok` print-env plan uses the **env** value; with env unset, it
   uses the stored value.
3. `eh provider key openrouter --delete` → key removed from store; a later
   resolve finds none.
4. Linux secret-service path (simulated `secret-tool` on PATH): store → lookup →
   delete all work and the key passes over stdin. (Already verified by harness
   script; rerun only if keys.ts changed.)
5. Non-TTY `eh provider key openrouter` → "storing a key needs an interactive
   terminal", non-zero exit.

## F. Launch / spawn

1. Put a **fake harness** (`claude` shell script that prints its env and args)
   first on PATH. Run `eh claude ollama qwen3-coder` (full positionals). → no
   picker UI; fake harness runs and prints `ANTHROPIC_MODEL=qwen3-coder`; eh
   exits 0 and the combo lands in `recent`.
2. Fake harness exits 3 → eh exit code is 3.
3. Fake harness killed by SIGTERM → eh exit code 143 (128+15).
4. **Conditional live check:** in a terminal at least 140 columns wide, launch a
   low-cost Vercel AI Gateway model through `eh`, send one short prompt, and
   observe the statusline total → it has no `~`. Exit and use Claude's printed
   session ID to open `~/.config/eh/gateway-costs/<session-id>.jsonl` → every
   `pending` request has a matching `settled` entry, and the exact decimal sum
   of unique generation costs equals the visible total. Resume a session that
   predates its ledger → cost displays `—`, not a partial total. Raw SSE →
   ledger equality is covered by `src/gateway-costs.test.ts`, which sends the
   stream through the proxy and compares the unchanged response with the ledger.

## G. Models cache

1. `eh models ollama` (fresh) → prints live models with size hints; writes
   `cache.json`.
2. Immediately rerun → served from cache (same output, no refetch — check
   `fetchedAt` unchanged).
3. Stop Ollama, `eh` → model picker → spinner fails, falls back to stale cache,
   list still shown. Restart Ollama after.
4. With a fixture model that publishes exact efforts, complete one model fetch
   and inspect `cache.json` → the model entry includes its normalized `efforts`
   array. Stop the fixture and rerun the picker after the five-minute freshness
   window → stale-cache fallback presents the same exact effort choices.
5. Fetch the live Vercel AI Gateway and OpenRouter `/v1/models` catalogs into an
   isolated config directory. Inspect `cache.json` → Vercel
   `reasoning_options[type=effort].values` and OpenRouter
   `reasoning.supported_efforts` are retained as normalized `efforts` per model;
   models that omit exact effort metadata do not receive invented choices.

## H. Doctor / providers

1. `eh doctor` → per-harness installed/not-installed lines, per-provider status;
   ollama shows "N models"; configured key providers show "key from
   env|keychain|file" or the "run eh provider key <name>" hint.

## Known limitations

- Interactive steps are driven by a PTY harness, not a human; rendering quirks
  of clack in a real terminal emulator are not fully covered.
- Real `claude`/`codex`/`grok` sessions are conditional on installed binaries
  and keys; fake harnesses cover the default spawn contract.
- OpenRouter/Vercel AI Gateway model-list endpoints can be checked without paid
  inference; actual launches still require keys and are SKIPPED unless present.
- Linux Secret Service is verified against a simulated `secret-tool`; a real
  GNOME Keyring/KWallet run needs a Linux machine.

## Automated coverage

- `pnpm lint` (eslint typed rules + prettier + tsc) is the static gate.
- `bun test` — provider effort-metadata parsing, exact Codex effort
  pass-through, gateway stream/cost capture, active-provider pricing ranges,
  transcript usage/cost fallbacks, and resume session-store parsers.
