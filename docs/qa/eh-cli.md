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
  the conditional live steps F.4, G.3, and G.5. Launch steps F.1–F.3 use a
  **fake harness binary**.
- A real Gateway key is needed for D.11, F.4, and F.6. A real Firecrawl key is
  needed for G.3 and G.5. Other provider/key steps use `--print-env`, loopback
  fakes, and a fake `secret-tool`/Keychain probe; F.5, G.1, G.2, and G.4 use
  loopback fakes.
- A PTY-capable runner (`script(1)`, `expect`, or equivalent) drives interactive
  flows.

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
3. `eh --print-env grok ollama qwen3-coder` → `GROK_MODELS_BASE_URL=.../v1`,
   `XAI_API_KEY='ollama'`, `--model qwen3-coder`.
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
10. `eh --print-env claude ollama qwen3-coder --search firecrawl` → actionable
    error explaining that a process-scoped proxy requires a normal launch.
11. `eh codex ollama qwen3-coder --search firecrawl` → "only supported by Claude
    Code" before attempting search-key resolution.
12. `AI_GATEWAY_API_KEY=test eh --print-env --gateway-provider bedrock codex vercel-ai-gateway anthropic/claude-sonnet-4.6`
    → prints the normal Gateway launch plan plus `gateway provider: bedrock`; it
    does not start a proxy in print-only mode.

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
10. `eh --print-env --gateway-provider bedrock codex ollama qwen3-coder` → error
    `--gateway-provider requires a Vercel AI Gateway provider`, non-zero exit.
    An invalid slug such as `not valid` also fails before launch.

## D. Interactive flows (PTY harness)

Drive each with the PTY; assert on screen text.

1. **First-run wizard**: empty config dir, run `eh`. → intro banner, a
   "detected" note listing harnesses + ollama status, then either the generated
   config or a built-ins-only note. The config is written to disk and home
   opens.
2. **Home**: with one recent entry present, run `eh`. → home select lists the
   recent combo with a relative-time hint, plus "new session →", "providers",
   "doctor". Enter providers → one list with disabled "Model providers" and
   "Search providers" headings; Native and Firecrawl appear in the latter, the
   active default is labeled, and the other provider exposes a make-default
   action. Firecrawl also exposes set/delete key actions. Enter on the recent →
   launch-plan note with **redacted** secrets (`ANTHROPIC_AUTH_TOKEN=•••`), and
   go/save/back options.
3. **Pickers**: run `eh claude` → provider picker lists ollama (compatible) and,
   if configured, openrouter. Arrow down to focus openrouter → its hint reads
   "needs router" (clack only shows the focused row's hint). Pick ollama → model
   picker lists live Ollama models with size hints, plus "other…". Select a
   model → confirm screen.
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
11. **Gateway provider picker**: select Vercel AI Gateway and a model → the next
    picker lists `automatic` first, then the model's active endpoint providers,
    plus manual entry. Pick one → the confirm note shows `gateway: <slug>`; save
    as a profile and relaunch → the pin is retained without another prompt.

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
6. `eh search key firecrawl` follows the same masked-prompt and storage rules,
   under the separate `search:firecrawl` account. `FIRECRAWL_API_KEY` overrides
   that stored value; `--delete` removes only the search credential.
7. Home → providers → Firecrawl → make default writes
   `defaultSearchProvider: "firecrawl"`; the list labels Firecrawl as default.
   Setting a new key first asks whether Firecrawl should become the default.
   Making Native default reverses the config and retargets Claude recents; saved
   profiles keep their explicit search choice.

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
5. Run the `chains search, cost capture, and Gateway provider routing` case in
   `src/search-proxy.test.ts`. → ordinary Messages traffic reaches the fake
   gateway through all three proxies with the requested provider pin, hidden
   search reaches fake Firecrawl only, and the Firecrawl credential is absent
   from the child environment.
6. **Conditional provider-routing check:** launch the same Gateway model with a
   known endpoint slug via `--gateway-provider`, send one short prompt, and
   confirm the Gateway trace used that provider. A deliberately unavailable slug
   must fail rather than fall back. Request-body injection and unchanged
   streamed responses are covered by `src/gateway-routing.test.ts` for Anthropic
   Messages, OpenAI Responses, and Chat Completions; model discovery and
   count-token requests are relayed unchanged.

## G. Claude WebSearch/WebFetch → Firecrawl shim

1. `bun test src/search-proxy.test.ts` → the hidden Claude Code request with a
   `web_search_20250305` tool calls fake Firecrawl `POST /v2/search` with the
   expected bearer token, query, and allowed/blocked-domain constraints, returns
   `server_tool_use` and `web_search_tool_result` SSE blocks with
   `web_search_requests: 1`, and never reaches the model-provider upstream.
2. The same test suite sends an ordinary streamed Messages request → headers and
   body reach the fake upstream, its SSE body passes through byte-for-byte, and
   Firecrawl is not contacted. A configured upstream path prefix and query
   string are preserved.
3. With a real Firecrawl key stored, launch real Claude Code through a
   configured model provider and force exactly one `WebSearch` call → the UI
   reports `Did 1 search`, the persisted tool result contains Firecrawl
   links/descriptions, the final answer links a returned source, and the proxy
   exits with the harness.
4. The loopback tests send Claude Code `PostToolUse` and `PostToolUseFailure`
   payloads for `WebFetch` → fake Firecrawl receives `POST /v2/scrape` with the
   selected URL; success replaces the structured tool output with Firecrawl
   markdown and updates HTTP code/status text together, while native failure
   receives the markdown as recovery context.
5. In a real Firecrawl-backed Claude session, force exactly one `WebFetch` → the
   persisted tool result contains the `Firecrawl fetched` marker and page
   content, and the final answer uses that content.

## H. Models cache

1. `eh models ollama` (fresh) → prints live models with size hints; writes
   `cache.json`.
2. Immediately rerun → served from cache (same output, no refetch — check
   `fetchedAt` unchanged).
3. Stop Ollama, `eh` → model picker → spinner fails, falls back to stale cache,
   list still shown. Restart Ollama after.

## I. Doctor / providers

1. `eh doctor` → per-harness installed/not-installed lines, per-provider status;
   ollama shows "N models"; configured key providers show "key from
   env|keychain|file" or the "run eh provider key <name>" hint; Firecrawl shows
   the same key source or `eh search key firecrawl` hint without making a live
   search request.

## Known limitations

- Interactive steps are driven by a PTY harness, not a human; rendering quirks
  of clack in a real terminal emulator are not fully covered.
- Real `claude`/`codex`/`grok` sessions are conditional on installed binaries
  and keys; fake harnesses cover the default spawn contract. Live Firecrawl QA
  is conditional on a real search key.
- OpenRouter/Vercel AI Gateway live model-list fetches need real keys and are
  SKIPPED unless keys are present.
- Linux Secret Service is verified against a simulated `secret-tool`; a real
  GNOME Keyring/KWallet run needs a Linux machine.

## Automated coverage

- `pnpm lint` (eslint typed rules + prettier + tsc) is the static gate.
- `bun test` — `src/statusline.test.ts` (transcript usage),
  `src/sessions.test.ts` (resume session-store parsers), `src/config.test.ts`
  (search-default precedence and recent retargeting), and
  `src/search-proxy.test.ts` (Firecrawl search/fetch interception + Anthropic
  passthrough), plus exact Gateway stream/cost capture, provider routing and
  model discovery, active-provider pricing ranges, transcript usage/cost
  fallbacks, headless-run contracts, and resume session-store parsers.
