# QA: eh CLI

Scope: the whole `eh` CLI — flag-driven paths, interactive picker flows,
profiles/recents, model cache, doctor/providers/models, and key storage. The app
is a CLI, so "drive the browser" becomes "drive the terminal": flag paths run
directly; interactive clack flows run under a PTY harness.

## Prerequisites

- `pnpm install` done; `pnpm dev` runs `tsx src/main.ts`.
- Ollama running locally (`ollama serve`) with ≥1 model pulled — steps that hit
  `localhost:11434` depend on it. If it's down, mark those steps BLOCKED.
- Harness binaries (`claude`, `codex`, `grok`, `opencode`, `pi`) only need to
  exist for doctor, spawn, and conditional live steps. Launch steps F.1–F.3 use
  a **fake harness binary**; F.4 is the explicit real-Claude exception. OpenCode
  session enumeration shells out to the real binary (`opencode session list`),
  and pi launch steps need a real `~/.pi/agent/models.json` for ollama.
- A real Gateway key is needed for D.11, F.4, and F.6. A real Firecrawl key is
  needed for G.3 and G.5. Other provider/key steps use `--print-env`, loopback
  fakes, and a fake `secret-tool`/Keychain probe; F.5, G.1, G.2, and G.4 use
  loopback fakes.
- PTY harness: use the runner's real PTY support when available, or `expect`,
  `script(1)` on macOS, or Python's `pty` module to drive interactive flows.

## A. Static gates

1. Run `pnpm lint`. → exits 0 (eslint + prettier + tsc all clean).

## B. Flag-driven launch plans (no TTY)

Each prints env/args and exits 0 without launching, unless noted.

1. `eh --print-env claude ollama qwen3-coder` → prints
   `ANTHROPIC_BASE_URL='http://localhost:11434'`, `ANTHROPIC_MODEL`,
   `ANTHROPIC_AUTH_TOKEN='ollama'`, `ANTHROPIC_SMALL_FAST_MODEL`.
2. `eh --print-env codex ollama qwen3-coder` →
   `# plus args: codex -c model="qwen3-coder" ... wire_api="responses"`; no
   `env_key` line.
3. `eh --print-env grok ollama qwen3-coder` → actionable temporary-artifacts
   error directing the user to launch through `eh`, non-zero exit, and no
   exports. The same applies with `-e high`.
4. `eh --print-env codex openrouter openai/gpt-5.1` (openrouter configured) →
   `wire_api="chat"`, `env_key="OPENROUTER_API_KEY"`.
5. `eh --print-env claude openrouter x` with `OPENROUTER_API_KEY` set →
   `ANTHROPIC_BASE_URL=https://openrouter.ai/api`. With the key unset and no
   stored key → error `no API key for "openrouter"`, non-zero exit.
6. `eh --print-env claude vercel-ai-gateway x` with `AI_GATEWAY_API_KEY` unset
   and no stored key → error "no API key for \"vercel-ai-gateway\"", non-zero
   exit.
7. `eh -r --print-env claude ollama qwen3-coder` → args end with `--resume`.
8. `eh -r --print-env codex ollama qwen3-coder` → args end with `resume` (after
   the `-c` overrides).
9. `eh -r --print-env grok ollama qwen3-coder` → the same actionable
   temporary-artifacts error directing the user to launch through `eh`, non-zero
   exit, and no resume args or exports.
10. `eh --print-env pi ollama qwen3-coder` with a models.json entry
    `{"providers":{"ollama":{"api":"openai-completions","apiKey":"ollama","baseUrl":"http://127.0.0.1:11434/v1","models":[{"id":"qwen3-coder"}]}}}`
    in `~/.pi/agent/models.json` → args `--provider ollama --model qwen3-coder`,
    no env (the provider name is the entry's key; a literal apiKey means no env,
    and `ollama` is the dummy value Pi documents for this keyless server). A
    file containing `//` or block comments and trailing commas is accepted like
    Pi's own loader. With `apiKey: "$OLLAMA_TEST_KEY"` and that var unset → env
    exports `OLLAMA_TEST_KEY='ollama'`. With a compound template such as
    `${KEY_PREFIX}_${KEY_SUFFIX}` or an escaped dollar such as `$$literal`, no
    partial env var is exported; Pi owns interpretation of those values. Without
    a runnable entry → error "needs a runnable provider entry in
    ~/.pi/agent/models.json".
11. `eh --print-env pi ollama qwen3-coder -e high` → args end with
    `--thinking high`. 11b. `eh --print-env codex ollama qwen3-coder -e xhigh` →
    args include `model_reasoning_effort="xhigh"` (no remap to `high`). 11c.
    Against a loopback OpenRouter whose `/models` lists
    `reasoning.supported_efforts: ["low","medium"]` for `test/model`,
    `eh --print-env claude that-provider test/model -e high` → non-zero,
    `effort "high" is not available`. The same launch with `-e medium` succeeds.
    A model that omits `reasoning` still accepts Claude's harness list
    (`-e high` ok, `-e none` rejected).
12. `eh --print-env opencode ollama qwen3-coder` → `OPENCODE_CONFIG_CONTENT`
    inline JSON (provider `eh-ollama`, npm `@ai-sdk/openai-compatible`,
    placeholder `apiKey`, baseURL `…/v1`, model cost `{input:0,output:0}`), args
    `-m eh-ollama/qwen3-coder`.
13. `eh -r --print-env pi ollama qwen3-coder` / `… opencode …` → args end with
    `--continue` (the --print-env path resolves no session id; `--session <id>`
    appears only via the interactive picker).
14. `eh --print-env claude ollama qwen3-coder --search firecrawl` → actionable
    error explaining that a process-scoped proxy requires a normal launch.
15. `eh codex ollama qwen3-coder --search firecrawl` → "only supported by Claude
    Code" before attempting search-key resolution.
16. `AI_GATEWAY_API_KEY=test eh --print-env --gateway-provider bedrock codex vercel-ai-gateway anthropic/claude-sonnet-4.6`
    → prints the normal Gateway launch plan plus `gateway provider: bedrock`; it
    does not start a proxy in print-only mode.
17. Point `XDG_CONFIG_HOME` at a temp directory and write
    `$XDG_CONFIG_HOME/eh/config.json` with
    `{"defaultApprovalMode":"auto","version":1}`. Give pi a runnable Ollama
    entry for `qwen3-coder` in its active `models.json`, then run these four
    commands: `eh --print-env claude ollama qwen3-coder`, the same for `codex`,
    `opencode`, and `pi`. → Claude includes `--permission-mode auto`, Codex
    includes `--approve-for-me`, opencode includes `--auto`, and pi adds no
    approval argument. None includes an unrestricted bypass flag. Grok approval
    argument coverage belongs to automated approval-mode tests because Grok
    `--print-env` is intentionally unsupported with its isolated temp home.
    Change the config value to `platform` and repeat the same commands. → none
    of those approval arguments is present.

## C. Config / error paths

1. Point `XDG_CONFIG_HOME` at a temp dir; write a **malformed** `config.json`.
   Run any command. → friendly "invalid config at <path> — not valid JSON", not
   a stack trace.
2. Write a syntactically valid but schema-wrong config (e.g. `"version": 2`). →
   "invalid config at <path> — version: Invalid input: expected 1".
3. `eh bogus` → "unknown harness or profile \"bogus\" (known: claude, codex,
   grok, opencode, pi)", non-zero exit.
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
    `--gateway-provider requires OpenRouter or Vercel AI Gateway`, non-zero
    exit. An invalid slug such as `not valid` also fails before launch.

## D. Interactive flows (PTY harness)

Drive each with the PTY; assert on screen text.

1. **First-run wizard**: empty config dir, run `eh`. → intro banner, a
   "detected" note listing harnesses + ollama status, then either the generated
   config or a built-ins-only note. The config is written to disk and home opens
   without a redundant confirmation prompt.
2. **Home**: with one recent entry present, run `eh`. → home select lists the
   recent combo with a relative-time hint, plus "new session →", "providers",
   "defaults", "doctor". Enter defaults → approvals shows `platform default` and
   `auto`; choosing `auto` writes `defaultApprovalMode: "auto"`, and the
   approvals row reflects it. Enter providers → one list with disabled "Model
   providers" and "Search providers" headings; Native and Firecrawl appear in
   the latter, the active default is labeled, and the other provider exposes a
   make-default action. Firecrawl also exposes set/delete key actions. Enter on
   the recent → launch-plan note with **redacted** secrets
   (`ANTHROPIC_AUTH_TOKEN=•••`), the resolved approval default, and go/save/back
   options.
3. **Pickers**: run `eh claude` → provider picker lists ollama and, if a key is
   set, openrouter as compatible
   (`openrouter · https://openrouter.ai/api/v1 · ✓ key set`). Pick ollama →
   model picker lists live Ollama models with size hints, plus "other…". Select
   a model → confirm screen. 3b. **providerCompat gate**: with
   `PI_CODING_AGENT_DIR` pointed at an empty dir (no models.json), run `eh pi` →
   provider picker lists ollama last with hint "ollama · needs a runnable
   provider entry in `<PI_CODING_AGENT_DIR>/models.json`"; picking it warns and
   re-prompts.
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
11. **OpenCode row isolation**: put a fake `opencode` first on `PATH`; its
    `session list --format json` response contains one valid current-directory
    row without model metadata plus rows whose `updated` values are above and
    below JavaScript's supported Date range. Run
    `eh -r opencode -p ollama -m qwen3-coder` → only the valid row appears with
    `unknown model`; selecting it launches with `--session <valid-id>` and the
    malformed rows do not crash or suppress it.
12. **Gateway provider picker**: select Vercel AI Gateway and a model → the next
    picker lists `automatic` first, then the model's active endpoint providers,
    plus manual entry. Pick one → the confirm note shows `gateway: <slug>`; save
    as a profile and relaunch → the pin is retained without another prompt.
    Typing in the model picker (so `other…` is visible) must not crash with
    `HTTP 404 from …/models/__manual__/endpoints`.
13. **Effort picker**: select OpenRouter and a model whose `/models` row lists
    `supported_efforts: ["low","medium","high"]` → effort picker is
    `auto, low, medium, high` (no `xhigh`/`max`/`none`). A Claude + Ollama model
    with no `reasoning` field still offers
    `auto, low, medium, high, xhigh, max`. opencode skips the effort picker.

## E. Key storage

1. `eh provider key openrouter` (PTY, key via stdin prompt) → stored in Keychain
   on macOS (`security find-generic-password -s eh -a openrouter -w` returns it)
   or 0600 file elsewhere; value never echoed to screen.
2. Resolve precedence: with the key stored AND `OPENROUTER_API_KEY` set in the
   shell, a Grok launch uses the **env** value; with env unset, it uses the
   stored value.
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
3. Age the cached Ollama entry beyond its five-minute TTL (or wait for expiry),
   then make the provider unreachable (stop Ollama, or use an isolated config
   override pointed at a closed local port). Run `eh claude -p ollama` → a live
   fetch is attempted, the spinner resolves to the cached model count, and the
   stale list remains selectable without a stack trace. Restore the endpoint
   after.

## I. Doctor / providers

1. `eh doctor` → per-harness installed/not-installed lines, per-provider status;
   ollama shows "N models"; configured key providers show "key from
   env|keychain|file" or the "run eh provider key <name>" hint; Firecrawl shows
   the same key source or `eh search key firecrawl` hint without making a live
   search request.

## I. Headless runs

1. Run `bun test src/headless-run.test.ts`. → all five harness adapters pass
   their normalized NDJSON contract tests. The pi and opencode cases assert the
   prompt stays off argv, native policy args precede mandatory machine-mode
   args, `--resume-session` reaches the native CLI, session/text/usage/cost are
   normalized, and a native semantic error makes both completion and process
   exits `66` even if the fake child exits 0. Preflight cases cover empty stdin,
   malformed native args, invalid effort, unknown harness/provider, pi provider
   incompatibility, and missing keys; each must emit only versioned
   `run.error` + failed `run.completed` records on stdout and exit `64`. A raw
   nonzero child exit code still passes through unchanged (including
   `128 + signal`).
2. With Ollama running and a pulled model declared for the `ollama` provider in
   pi's `models.json`, run a short real pi request (replace `<model>`):

   ```bash
   printf 'Reply with exactly EH_PI_OK' |
     eh run pi ollama <model> \
       --native-args-json '["--no-tools","--no-extensions","--no-skills","--no-context-files","--no-session"]'
   ```

   → every stdout line parses as JSON with `v: 1`; the stream contains
   `run.started`, `session.started`, `assistant.text` containing `EH_PI_OK`,
   `usage`, and a successful `run.completed`. Native pi events remain available
   as `harness.event`; stderr contains no TUI.

3. With the same local provider/model, run a short real opencode request:

   ```bash
   printf 'Reply with exactly EH_OPENCODE_OK' |
     eh run opencode ollama <model> --native-args-json '["--pure"]'
   ```

   → every stdout line parses as JSON with `v: 1`; the stream contains
   `run.started`, `session.started`, `assistant.text` containing
   `EH_OPENCODE_OK`, `usage`, and a successful `run.completed`. Native opencode
   events remain available as `harness.event`; stderr contains no TUI.

4. Repeat the pi and opencode fake-binary cases with a nonexistent child binary
   and with the real native error event shape. → the nonexistent-binary case
   exits `65` (spawn failure) and the native-error case exits `66` (semantic
   harness failure); each emits one `run.error`, a failed `run.completed`, and
   preserves native stderr separately.
5. Confirm `--cwd` controls the spawned child's working directory. Step 1's
   automated suite runs a fake codex under `--cwd <scratch>` and asserts the
   child reports that directory as its cwd, plus preflight failures for a
   nonexistent path and a file-not-directory path (each emits only `run.error` +
   failed `run.completed` on stdout, exits `64`, and never spawns the
   child). For a live check with a real provider and key:

   ```bash
   printf 'run pwd and print it' |
     eh run claude vercel-ai-gateway <model> --cwd /tmp
   ```

   → the harness runs in `/tmp`; a nonexistent `--cwd` exits `64` with a
   `run.error` before any `harness.event`.

## Known limitations

- Interactive steps are driven by a PTY harness, not a human; rendering quirks
  of clack in a real terminal emulator are not fully covered.
- Interactive launch/resume steps use fake binaries by default; the real Claude
  check in F.4 remains conditional on an installed binary and key. Headless
  steps I.2-I.3 deliberately run short real pi/opencode sessions against local
  Ollama; other cloud-harness live runs remain conditional on credentials. Real
  cloud-harness and Firecrawl checks remain conditional on their installed
  binaries and credentials.
- OpenRouter/Vercel AI Gateway live model-list fetches need real keys and are
  SKIPPED unless keys are present.
- Linux Secret Service is verified against a simulated `secret-tool`; a real
  GNOME Keyring/KWallet run needs a Linux machine.

## Automated coverage

- `pnpm lint` (eslint typed rules + prettier + tsc) is the static gate.
- `bun test` — `src/statusline.test.ts` (transcript usage),
  `src/sessions.test.ts` (resume session-store parsers), `src/config.test.ts`
  (backwards-compatible approval default, search-default precedence and recent
  retargeting), `src/approval-mode.test.ts` (all approval mappings and bypass
  exclusions), and `src/search-proxy.test.ts` (Firecrawl search/fetch
  interception + Anthropic passthrough), plus exact Gateway stream/cost capture,
  provider routing and model discovery, active-provider pricing ranges,
  transcript usage/cost fallbacks, all five headless adapters and their
  normalized NDJSON/failure contracts, Pi provider matching/config parsing,
  OpenCode inline config, and per-row session isolation for out-of-range
  timestamps.
