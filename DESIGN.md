# Exquisite Harness (`eh`) — Design

A CLI that lets you choose a **harness** (Claude Code, Codex, Grok Build,
opencode, pi) and point it at a **provider** (Ollama, OpenRouter, Vercel AI
Gateway), then launches it. Pick a cell in the matrix, `eh` wires it up.

## Core insight

Harnesses speak a wire protocol; providers expose protocol endpoints. Matching
them is the whole game, and the matrix is already mostly green natively:

| Harness     | Speaks                  | Configured via                                                                   |
| ----------- | ----------------------- | -------------------------------------------------------------------------------- |
| Claude Code | Anthropic Messages      | env: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`             |
| Codex CLI   | OpenAI Responses / Chat | `-c` overrides (TOML): `model_providers.*`                                       |
| Grok Build  | OpenAI Chat Completions | env: `XAI_API_KEY`, `GROK_MODELS_BASE_URL`, `--model`                            |
| opencode    | OpenAI Chat (AI SDK)    | env: `OPENCODE_CONFIG_CONTENT` (inline provider def), `-m eh-<provider>/<model>` |
| pi          | OpenAI Chat             | args: `--provider`/`--model`/`--thinking`; catalog + `~/.pi/agent/models.json`   |

| Provider          | Endpoints                                       |
| ----------------- | ----------------------------------------------- |
| Ollama            | OpenAI chat + responses, **Anthropic Messages** |
| OpenRouter        | OpenAI chat + responses, **Anthropic Messages** |
| Vercel AI Gateway | OpenAI chat + responses, **Anthropic Messages** |

Resulting compatibility (✅ = native, ⚠️ router = needs protocol translation, ⚠️
models.json = harness-level provider gate):

|             | Ollama         | OpenRouter | Vercel AI Gateway |
| ----------- | -------------- | ---------- | ----------------- |
| Claude Code | ✅             | ✅         | ✅                |
| Codex       | ✅             | ✅         | ✅                |
| Grok        | ✅             | ✅         | ✅                |
| opencode    | ✅             | ✅         | ✅                |
| pi          | ⚠️ models.json | ✅         | ✅                |

pi's ⚠️ is not a protocol gap — pi only talks to providers in its own catalog
(models.dev-derived; openrouter and vercel-ai-gateway are in it) or declared in
`~/.pi/agent/models.json`. eh never writes that file (phase-1 no-mutation rule);
a provider pi doesn't know needs a runnable entry with a base URL, API type, API
key configuration, and at least one model. The picker hint names the active
models.json path via the harness's `providerCompat` hook, an instance-level gate
on top of the protocol-set intersection.

## Architecture

**Phase 1 (this build): thin launcher plus process-scoped shims.** Resolve
`(harness, provider, model)` → env vars + CLI args → `spawn` the harness with
inherited stdio. Native web access remains server-free. Choosing Firecrawl for a
Claude launch starts a process-scoped localhost proxy; there is still no daemon,
separately installed runtime, or mutation of the harnesses' own config files.
The official Firecrawl Node SDK is bundled into the standalone `eh` binary.
Vercel Gateway and OpenRouter launches can use two more transparent
process-scoped proxies: one records exact billed cost from Anthropic SSE
metadata, and one injects an explicit upstream provider into JSON inference
requests. None of these shims translates protocols. When all three are active,
ordinary model traffic flows through search interception, then cost capture,
then provider routing, then the configured gateway.

Claude Code exposes `WebSearch` to the main model as a normal custom tool, then
fulfills it with a second, hidden Anthropic Messages request whose sole tool has
type `web_search_20250305` and whose user message starts
`Perform a web search for the query:`. The search shim temporarily points
`ANTHROPIC_BASE_URL` at itself, forwards all ordinary requests and streams to
the selected model provider, and answers only that hidden request using
Firecrawl `POST /v2/search`. It returns an Anthropic Messages JSON/SSE response
with `server_tool_use`, `web_search_tool_result`, and server-use accounting plus
linked result text. Claude's allowed/blocked-domain constraints are forwarded to
Firecrawl. Claude Code therefore renders the real search count and wraps the
Firecrawl data as the original `WebSearch` tool result. This preserves the
harness UX without MCP and works with non-Anthropic models. It is deliberately
coupled to an undocumented Claude Code boundary, so a real loopback integration
test locks down both interception and transparent passthrough.

`WebFetch` is a local Claude Code tool, so it never reaches that Messages proxy.
The generated session settings add `PostToolUse` and `PostToolUseFailure`
command hooks for `WebFetch`; their hidden eh subprocess passes the hook payload
to the same process-scoped proxy, which calls Firecrawl `POST /v2/scrape`.
Successful tool output is replaced with Firecrawl markdown, and failed native
fetches receive it as recovery context. The built-in download still runs before
the post-tool hook; this controls the content the model sees, not the original
network request. The hook is inert without the proxy URL, so native sessions and
concurrent launches retain their own behavior.

**Headless execution:** `eh run <harness> <provider> <model>` is the stable
orchestrator boundary alongside the interactive launcher. It reads the prompt
from stdin, selects each harness's native machine-output mode, preserves native
events inside a versioned NDJSON envelope, and emits normalized session, text,
usage, and completion events. It does not open UI, write recents, or install the
Claude statusline. The caller owns cwd, scratch/config roots, and lifecycle
policy, though `eh run` offers `--cwd <dir>` for the spawned child and an
optional `--timeout <seconds>` deadline that emits a `run.error`, sends
`SIGTERM`, then escalates to `SIGKILL` after the named `TIMEOUT_KILL_GRACE_MS`
grace (overridable via `EH_TIMEOUT_KILL_GRACE_MS` for tests); `eh` owns provider
wiring and harness protocol parsing. `--cwd` is validated to be an existing
directory before spawn. Callers can preserve harness-specific policy with a
validated JSON string array of native arguments, which `eh` prepends before its
mandatory machine-mode arguments. The five native adapters are Claude
`stream-json`, Codex `--json`, Grok `streaming-json`, pi `--mode json`, and
opencode `run --format json`; pi and opencode keep prompt input on stdin and
expose their native session IDs, text, usage, cost, and semantic errors through
the same normalized contract. For failures `eh` detects itself it reserves a
contiguous exit-code block at `>=64`: `64` (preflight/usage error — nothing
spawned), `65` (spawn failure — binary missing/unspawnable), and `66` (semantic
harness failure — `resultIsError` while the child exited `0`). Every other code
is the raw child exit code passed through unchanged (including `128 + signal`),
so a harness's own code can collide with the reserved block only in that
passthrough case. `eh ask` is the single-agent delegation entry point for the
same contract — identical stdin, options, and NDJSON output, with no UI,
recents, statusline, or config mutation. The bundled delegation skill that
teaches an agent to use it is exposed by `eh skill print` and
`eh skill install --dir <dir>`.

**Headless computed cost:** `eh run` does not trust the inner harness's
self-reported cost as authoritative. It accumulates its own normalized usage
across the run (a `cumulative: true` total from the harness wins outright;
otherwise per-event deltas are summed, so a harness like grok that emits both is
not double-counted) and, before `run.completed`, emits one final summary `usage`
event carrying `costUsd` that it computes from that usage times the resolved
model's gateway rates. Rates come from the model's per-endpoint pricing when
`--gateway-provider` is pinned (honoring prompt/completion tiers as context
brackets), else the model-aggregate rates. `costSource` records provenance:
`gateway-rates`, `free` (zero-rate providers like ollama), or `unavailable` —
and when unavailable no `costUsd` is emitted, never a fabricated `$0`. Cache
read/write tokens bill at the endpoint's published cache rates; when an endpoint
publishes none they bill at the regular input rate (a provider that gives no
cache discount charges cache tokens as ordinary input). Any harness-reported
cost is preserved separately as `harnessCostUsd`, never promoted to `costUsd`.
Because the event shape changed, the NDJSON stream version `v` is now `2`.

`run.completed` is by construction the final NDJSON line: it is emitted exactly
once per run, after stdout EOF and child close, and every completion path
returns immediately after emitting it, so no event can follow — orchestrators
treat it as the end-of-run marker. `--result-file <path>` writes the run's final
result text — the harness-native terminal result string where a harness defines
one (only Claude's `result` event does today), otherwise every `assistant.text`
value joined in stream order — and always creates the file, empty for no-result
or error runs. The write completes before `run.completed` is emitted, so the
file is ready once that line appears.

**Phase 2 (later): local router.** An opt-in localhost proxy that receives
Anthropic Messages / OpenAI requests and fulfills them via the Vercel AI SDK
(`createProviderRegistry` + `customProvider` aliases). Unlocks the ⚠️ cell
(Claude Code → OpenAI-only providers) plus logging/cost/failover. In the UI it
appears as a synthetic provider that serves all protocols, so the picker logic
(protocol set intersection) does not change.

> **Evaluated and skipped:**
> [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (Go proxy: OAuth
> subscriptions + multi-account balancing as OpenAI/Claude endpoints). Its
> unique value is subscription arbitrage and self-hosting, not aggregation —
> OpenRouter + Vercel AI Gateway already cover aggregation, and both natively
> close the Anthropic-protocol gap. Revisit only if we ever want
> OAuth-subscription providers (Claude Pro / ChatGPT Plus as APIs).

## UX

```text
eh                                  # home: recents, new session, providers, defaults, doctor
eh claude                           # interactive: provider + model pickers
eh claude ollama                    # interactive: model picker only
eh claude ollama qwen3-coder        # no UI, just launches
eh claude vercel-ai-gateway anthropic/claude-sonnet-4.6 --gateway-provider bedrock
eh claude openrouter anthropic/claude-sonnet-4.6 --gateway-provider anthropic
eh cheap-local                      # launch saved profile
eh -r                               # pick from this dir's sessions (all harnesses) and resume
eh -r codex -p ollama               # only codex sessions; -p/-m/-e override the wiring
eh --print-env claude ollama …      # print the export lines, don't launch
eh claude ollama … --search firecrawl
                                    # native web UX, Firecrawl backend
eh search key firecrawl             # store its key like a provider key
eh doctor                           # harnesses installed? providers reachable? keys set?
eh models ollama                    # live model list (5 min cache)
eh providers                        # configured providers + status
eh provider add                     # interactive: add a provider to config
eh profile save <name>              # save last launched combo as a profile
eh profile list / rm <name>
eh setup                            # re-run first-run wizard
eh update                           # self-update to the latest GitHub release
```

Picker flow (via `@clack/prompts`, skipped per already-specified args; the short
menus also answer to letter hotkeys — press a row's bracketed letter (`[a]`,
`[n]`, …) to pick it directly, ↑/↓ + enter as before):

1. **Home** — recent combos (`a`–`e`; Enter relaunches last), new session (`n`),
   providers (`p`), defaults (`f`), or doctor (`o`). Home → defaults → approvals
   sets a global launch-time choice between each harness's platform behavior and
   native auto mode.
2. **Harness** — installed status in the hint.
3. **Provider** — filtered to protocol-compatible; incompatible rows shown with
   a `needs router` hint or the harness's own providerCompat reason (pi:
   `needs a runnable provider entry in <active agent dir>/models.json`). Status
   hints: `● running`, `✓ key set`, `✗ KEY not set`. Providers with a key set
   sort first, then no-key-needed ones, then rows missing a key (with a `✗`
   label marker), then incompatible rows last. Selecting a provider that needs a
   key but has none prompts for it inline (masked, Esc to go back) — no separate
   command needed. Home → providers is one management screen split into visible
   Model providers and Search providers sections, with per-provider key status
   (same ordering, `⚠` marker on keyless rows), a visible search default, and
   set/delete/default actions. Storing a new search key offers to make that
   provider the default.
4. **Model** — live list from the provider (cached 5 min, stale fallback),
   scrollable, with a manual-entry escape hatch.
5. **Upstream provider** — only for OpenRouter and Vercel AI Gateway: live
   endpoint providers for the selected model, each hinting its cost ($ in/out
   per 1M) and p50 throughput (tps), plus `automatic` (the default), `ZDR only`
   (restrict routing to zero-data-retention providers), and manual entry.
   Selecting a provider pins the run with no fallback to another upstream.
6. **Effort** — `auto` plus the intersection of the harness's accepted levels
   and the model's reported efforts (Vercel `reasoning_options`, OpenRouter
   `reasoning.supported_efforts`). Skipped when the intersection is empty
   (including opencode). Models that omit the field keep the harness list.
7. **Web access** (Claude only) — Native (default), or Firecrawl with the same
   inline key-status and masked key-entry behavior as model providers. Explicit
   `--search` skips this picker; Codex and Grok stay native.
8. **Confirm** — `note()` with resolved env/args → go / save as profile / back.

First run (no config file): mini-wizard detects harness binaries, probes
`localhost:11434`, detects `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` /
`FIRECRAWL_API_KEY` in the environment, and offers to stash those keys in the OS
credential store (there is nothing provider-related to write — model and search
providers are built in). Non-TTY stdout ⇒ positional args must be complete; no
prompts.

## Config

`~/.config/eh/config.json` (XDG-aware), zod-validated:

```jsonc
{
  "version": 1,
  "defaultApprovalMode": "auto",
  "defaultSearchProvider": "firecrawl",
  "providers": {
    "ollama": { "type": "ollama", "baseURL": "http://localhost:11434" },
    "openrouter": { "type": "openrouter", "envKey": "OPENROUTER_API_KEY" },
    "vercel-ai-gateway": {
      "type": "vercel-gateway",
      "envKey": "AI_GATEWAY_API_KEY",
    },
  },
  "searchProviders": {
    "firecrawl": {
      "type": "firecrawl",
      "baseURL": "https://api.firecrawl.dev",
      "envKey": "FIRECRAWL_API_KEY",
    },
  },
  "profiles": {
    "gateway-bedrock": {
      "harness": "claude",
      "provider": "vercel-ai-gateway",
      "model": "anthropic/claude-sonnet-4.6",
      "gatewayProvider": "bedrock",
      "searchProvider": "firecrawl",
    },
  },
  "recent": [
    {
      "harness": "claude",
      "provider": "ollama",
      "model": "qwen3-coder",
      "searchProvider": "firecrawl",
      "cwd": "…",
      "usedAt": "…",
    },
  ],
}
```

Provider `type` implies: protocols served, default base URL, default API-key env
var, model-listing strategy, Codex `wire_api`. Each harness declares the set of
protocols it can speak (`claude: [anthropic]`,
`codex: [openai-responses, openai-chat]`, `grok: [openai-chat]`,
`opencode: [openai-chat]`, `pi: [openai-chat]`); a harness/provider pair is
compatible when the sets intersect — plus any instance-level `providerCompat`
gate the harness declares (pi's catalog/models.json membership). All three
matrix providers are built in, so the full 5×3 is visible with no config file at
all: Ollama works zero-config (no key needed; token value `ollama` is sent where
required but ignored), while openrouter and vercel-ai-gateway appear with a "key
not set" hint until a key is stored or their env var is set. The config file
only overrides built-ins or adds custom providers. Profiles and recents may
store `gatewayProvider`; it is only valid for OpenRouter or Vercel AI Gateway.
Model cache: `~/.config/eh/cache.json`, 5-minute TTL.

Search resolution is explicit `--search` → profile/recent choice →
`defaultSearchProvider` → Native. The global default applies only to Claude and
retargets existing Claude recents so home-screen shortcuts follow it. Saved
profiles remain reproducible and keep their explicit choice.

Approval resolution is the current `defaultApprovalMode` at launch time. It is
deliberately absent from selections, profiles, and recents: changing the global
default immediately affects every launch path, including `eh run`, while
`platform` remains the backwards-compatible default for existing config files.

## Key handling

`eh` can store provider and search API keys so you don't have to pre-export env
vars. Design follows the doc-backed patterns of the harnesses themselves:

| Tool        | Storage pattern                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Claude Code | macOS Keychain (darwin) / `~/.claude/.credentials.json` 0600 (linux); `apiKeyHelper` shell hook |
| Codex CLI   | `cli_auth_credentials_store=auto`: OS credential store, else `~/.codex/auth.json`               |
| Grok Build  | OAuth in `~/.grok/auth.json` 0600; `XAI_API_KEY` fallback                                       |
| gh / stripe | plaintext files in `$HOME`, env var wins                                                        |

Two standard patterns adopted here:

1. **OS credential store first, file-fallback.** `eh provider key <name>` stores
   to the platform's credential store, probed once per process:
   - **macOS** → Keychain via the `security` CLI (service `eh`). Trade-off: the
     key passes through argv briefly on set; `security` has no stdin mode.
   - **Linux** → freedesktop Secret Service (GNOME Keyring / KWallet) via
     `secret-tool` (libsecret). The key travels over **stdin** — never argv. A
     probe (`lookup` of a dummy item; exit 1 = daemon reachable) guards headless
     servers with no D-Bus session, which fall through to file.
   - **Windows** → no usable shell-out for reading credentials back, so it goes
     straight to the file store — the same posture Claude Code documents for
     `%USERPROFILE%\.claude\.credentials.json` (profile-dir ACLs).

   The file fallback everywhere is `~/.config/eh/secrets.json` (`%APPDATA%\eh`
   on Windows), written mode `0600`. No keys ever live in `config.json` — only
   `envKey` _names_.

2. **Env always wins.** Resolution order is `process.env[envKey]` → OS store →
   file, so `op run` / dotenvx / 1Password stay composable on top. Config paths
   follow XDG (`XDG_CONFIG_HOME`, `%APPDATA%` on Windows), and binary lookup
   honors `PATHEXT` on Windows.

Key-entry hygiene (from Codex's `--with-api-key` stdin pattern): the key comes
in through a masked `password` prompt on stdin — never argv, never shell
history, never echoed. `eh provider key <name> --delete` removes it.
`checkProvider`/`doctor` report the key _source_ (`env`/`keychain`/`file`),
never the value. Search credentials use namespaced store accounts such as
`search:firecrawl`, so a custom model provider and search provider can safely
share a config name. `FIRECRAWL_API_KEY` still wins over stored credentials.

Phase-2 note (Claude Code's `apiKeyHelper` pattern): a stored key _command_
(`eh provider key <name> --cmd 'op read "op://…"'`) would let 1Password users
resolve at launch time without eh storing anything.

## Launch plans

Approval mode `auto` maps to each harness's native automatic behavior: Claude
and Grok `--permission-mode auto`, Codex `--approve-for-me`, and opencode
`--auto`. Pi receives no flag because it has no tool-approval prompts;
`--approve` is its project-trust option and is not equivalent. Platform mode
adds no argument. The mapping never uses unrestricted bypass flags, and native
availability/errors remain owned by the selected harness.

`eh run --read-only` resolves together with approval mode in
`permission-posture.ts` — one point owns both axes because the native flags
collide on Codex and Grok. Read-only wins and the approval-mode argument is
suppressed, except opencode, whose `--agent plan` composes with `--auto`. A
harness with no read-only mechanism hits an exhaustiveness guard and refuses to
launch rather than run silently unrestricted (`docs/read-only.md`).

For an OpenRouter or Vercel AI Gateway selection, `--gateway-provider <slug>`
adds a process-scoped loopback proxy to Claude, Codex, Grok, opencode, and pi
launch plans. The proxy preserves the harness's native Anthropic Messages,
OpenAI Responses, or Chat Completions protocol and only merges the provider's
pin into JSON inference bodies: Vercel `providerOptions.gateway.only: [slug]`,
OpenRouter `provider.only: [slug]` plus `allow_fallbacks: false`. Existing
provider options are preserved; count-token bodies are relayed unchanged. With
Claude, request routing composes with exact cost capture as
`harness → cost proxy → routing proxy → Gateway`. OpenRouter slugs may include a
path suffix (`deepinfra/turbo`, `google-vertex/us-east5`). A base slug
(`amazon-bedrock`) matches every regional tag (`amazon-bedrock/global`); a full
tag still has to match exactly.

Pi's provider URL comes from its own catalog (a file eh never writes), so eh
redirects the native `openrouter` or `vercel-ai-gateway` provider at the
loopback proxy with a temporary `--extension <file>` that overrides its
`baseUrl` to `process.env.EH_PI_PROXY_URL`; the temp file is removed after the
run. This also means pi needs no `~/.pi/agent/models.json` mutation.

A `ZDR only` routing choice (picker, recents, or profile) starts the same proxy
but injects the provider's ZDR flag without pinning an upstream (Vercel
`providerOptions.gateway.zeroDataRetention: true`, OpenRouter
`provider.zdr: true`), so only zero-data-retention endpoints may serve the
model. Launch validates up front against `/models/{model}/endpoints`: when every
active endpoint reports explicit `has_zdr: false`, eh fails before launch
(`has no ZDR providers on the gateway … relaunch without ZDR-only routing`)
instead of surfacing the gateway's raw mid-session 400. Provider cost/throughput
hints come from the same `/models/{model}/endpoints` response the picker already
fetches.

- **claude**: env `ANTHROPIC_BASE_URL` (provider's Anthropic endpoint),
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`.
  Effort (when not `auto`): `CLAUDE_CODE_EFFORT_LEVEL=<level>`, plus
  `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` for non-Anthropic providers (the model ID
  isn't effort-recognized there, so force the parameter through).
  **Statusline:** session override via
  `claude --settings ~/.config/eh/claude-statusline.json` pointing at
  `eh statusline`. Env `EH_PROVIDER` / `EH_MODEL` / `EH_EFFORT` / `EH_PRICE_IN`
  / `EH_PRICE_OUT` / cache-price vars / `EH_RATE_LABEL` / `EH_CONTEXT_WINDOW` /
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (selected endpoint rates when Gateway routing
  is pinned, otherwise the active provider rate range
  $/1M + real context size from the provider APIs at
  launch). Context % is recomputed as
  `(input + cache_write + cache_read) / provider_window` from live
  `current_usage` — not Claude's default 200k-based `used_percentage`. Vercel
  Gateway and OpenRouter launches pass through an eh-owned loopback proxy that
  relays the Anthropic SSE event payloads without modification and records
  billed cost in a session ledger: Vercel
  `provider_metadata.gateway.{generationId,cost}`, OpenRouter `usage.cost`.
  Those
  unprefixed totals are the gateway's exact billed costs, deduplicated by
  generation. A request that finishes without cost metadata (e.g. an error or a
  turn the gateway didn't tag) counts against the session's exactness but does
  not null out the others: the sum of the priced generations is still shown,
  prefixed with `~` to mark it partial, so one unpriced request can't hide the
  whole session's cost. The running total also stays visible while a request is
  in flight — it reads `~` until every request has settled and priced, so the
  statusline doesn't go dark mid-conversation. The session reads as `—` only
  when nothing is priced or the session is resumed (its ledger is written with
  `complete: false` and never flips, so a resumed session's total is never shown
  exact). Non-gateway paid sessions fall back to
  transcript tokens × explicitly published rates and prefix the result with
  `~`; providers with published zero rates show exact `$0`. Missing cache rates make the estimate unavailable rather than inferred. Claude's `cost.total_cost_usd`
  is ignored because it applies Anthropic rates.

  **External web access:** when selected, the launch plan retains the real
  upstream base URL and Firecrawl credential, starts the search proxy, and gives
  the child its Messages base URL plus a non-secret hook endpoint. The
  credential remains in the parent and is removed from the child environment. On
  OpenRouter and Vercel Gateway the search proxy forwards ordinary traffic
  through the cost and provider-routing proxies, preserving all three features.
  Every proxy closes when Claude exits. `--print-env` rejects external web
  access because the process-scoped proxy cannot be represented as static
  exports.

- **codex**: `-c` TOML overrides — `model`, `model_provider=eh`,
  `model_providers.eh.{name,base_url,wire_api,env_key}`, plus
  `model_reasoning_effort=<level>` (the value is passed through; the picker and
  `-e` only offer levels the model and Codex both accept). No writes to
  `~/.codex/config.toml`.
- **grok**: env `XAI_API_KEY`, `GROK_MODELS_BASE_URL`, args `--model <id>` and
  optional `--reasoning-effort <level>`. These are Grok Build's documented
  custom-model and CLI interfaces; `eh doctor` reports the installed binary.
  Grok's session OAuth in `~/.grok/auth.json` outranks `XAI_API_KEY`, so a
  logged-in user would otherwise send an xAI JWT to third-party bases (Gateway,
  Ollama, …). Launch therefore uses a process-scoped `GROK_HOME` without
  `auth.json`, replaces the selected model's routing/auth fields with
  `env_key = "XAI_API_KEY"`, and carries forward existing Grok state so
  sessions, skills, agents, rules, and plugins keep working. `--print-env`
  rejects this plan because the caller cannot inherit ownership of the temporary
  home and its cleanup.
- **opencode**: env `OPENCODE_CONFIG_CONTENT` — an inline JSON provider
  definition (`@ai-sdk/openai-compatible`, chat completions) that merges over
  the user's own config, so nothing is written to disk; `apiKey` uses
  `{env:VAR}` indirection so the payload stays key-free (print-env safe). The
  model entry includes published per-million-token rates when available so
  opencode can calculate session spend. No `limit` on the model entry: opencode
  requires context and output together, and the output limit isn't knowable.
  Args `-m eh-<provider>/<model>`. No CLI effort knob; an explicit effort is
  noted and ignored.
- **pi**: args `--provider <pi name> --model <id>`, plus `--thinking <level>`
  for effort (pi's levels are eh's 1:1). The pi provider name resolves from pi's
  native catalog (openrouter, vercel-ai-gateway — both read the same key env
  vars eh uses, matched on canonical upstream) or from `~/.pi/agent/models.json`
  by baseUrl (loopback- and `/v1`-insensitive) when the entry also defines an
  API type, API key configuration, and at least one model; an exact
  provider-name match wins, while multiple fallback entries for one base URL are
  rejected as ambiguous. eh never writes that file. Keys ride via env injection
  only (never `--api-key` argv): a models.json entry's `apiKey: "$VAR"` names
  the var to inject, while keyless local servers use a dummy literal. Unknown
  model ids pass through — pi prints its own generic-limits warning.

**Effort** is an optional part of a selection (`auto`, plus provider-reported
values from `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`),
resolved flag → profile → interactive default (`auto` = model default, sends
nothing). The picker and `-e` intersect the harness's accepted levels with the
model's reported set; an explicit level that survives that filter is passed
through (Codex no longer remaps `xhigh`/`max` to `high`). OpenRouter
`supported_efforts: null` means every gateway effort; `mandatory: true` drops
`none`. Vercel AI Gateway also exposes the OpenAI `reasoning.effort`
pass-through, so effort works end-to-end for Gateway-backed Codex/OpenAI models.

**Resume** (`-r`): an eh-owned picker over this directory's sessions across all
harnesses, then resume the pick by session id — claude `--resume <id>`, codex
`resume <id>` (a subcommand; the global `-c` overrides precede it), grok
`--resume <id>`, opencode `--session <id>`, pi `--session <id>` (opencode and pi
fall back to `--continue` when no id is resolved — the `--print-env` path).
Sessions come from the harnesses' own stores, read best-effort
(`src/sessions.ts`; roots honor `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` when set):
claude
`~/.claude/projects/<cwd with every non-alphanumeric char → - >/<id>.jsonl`
(title from the first real user record, model from the first assistant record,
mtime for recency — the encoding is lossy, so colliding cwds share sessions, and
claude truncates + hash-suffixes names over 200 chars, which eh doesn't
replicate: sessions in very deep paths don't list), codex
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (line 1 `session_meta` gives
id+cwd — files are date-organized, so the scan is bounded to 300 files / 25
matches; title from the first `user_message` event, model from the first
`turn_context`), grok
`${GROK_HOME:-~/.grok}/sessions/<encodeURIComponent(cwd)>/<id>/summary.json`
(ready-made title/model/timestamps), pi
`~/.pi/agent/sessions/--<cwd, leading slash stripped, / \ : → ->--/<ts>_<id>.jsonl`
(line-1 header gives the id — the cwd match comes from the directory name —
first `model_change` the model, first user message the title; roots honor
`$PI_CODING_AGENT_DIR`; `$PI_CODING_AGENT_SESSION_DIR` is treated as one flat
directory and filtered by the header cwd), opencode via
`opencode session list --format json` (its 1.x store is a sqlite db — eh asks
the CLI rather than linking a driver; the list is global but root-sessions-only,
matched to cwd by `directory`). Subagent sessions are filtered (grok
`session_kind`, codex `thread_source`; opencode's list excludes them itself).
The list shows sessions whether or not eh launched them, each with harness, age,
and model when the store exposes one — never provider, which transcripts don't
record.

Wiring: explicit positionals/flags win. Otherwise the recents supply it,
preferring the combo that last ran that harness+model (a provider is only known
to serve the models it actually launched; recents carry a `cwd` stamp, cwd
matches first), then the latest combo for the harness, then the pickers.
Resuming onto different wiring than the session started on is supported — the
env/`-c` overrides apply to the resumed session. The picker needs an interactive
terminal; `eh -r --print-env` skips enumeration entirely and prints the bare
resume args (harness picker / most recent), which is the scripting escape hatch.

## Stack

TypeScript (strict, tools/main shared configs), `@clack/prompts` + `@clack/core`
(UI; core is the prompt-class layer prompts builds on, pinned at the same
version prompts requires), `commander` (args), `zod` (config + API response
validation). Dev via `tsx`; release build via `bun build --compile` → single
`dist/eh` binary. All clack imports are isolated in `src/ui/`; flag-driven paths
never touch that module, which keeps non-TTY use clean and a future
Ink/miller-column UI swappable.

## File map

```text
src/main.ts       entry: commander wiring
src/flow.ts       positional/profile resolution → pickers → launch
src/headless-run.ts  non-interactive harness execution + NDJSON normalization
src/skill.ts       embedded delegation skill printing and installation
skills/eh-delegate/SKILL.md  installable delegation instructions
src/approval-mode.ts  approval labels + per-harness native argument mapping
src/permission-posture.ts  read-only + approval resolution (one point, both axes)
src/config.ts     schema, load/save, recents, profiles, XDG paths
src/providers.ts  provider types: protocols, model listing, status checks
src/pricing.ts    provider rates/ranges ($/1M), headless rate cards + computed cost
src/gateway-costs.ts transparent Vercel stream proxy + exact session ledger
src/gateway-routing.ts process-scoped request rewriter for Gateway provider pins / ZDR-only routing
src/statusline.ts Claude statusline render + session settings writer
src/harnesses.ts  harness registry: detection + launch plans
src/grok-home.ts  process-scoped GROK_HOME isolation so custom bases use XAI_API_KEY
src/pi.ts         pi provider resolution: native catalog map + models.json matching
src/opencode.ts   opencode inline-config builder (OPENCODE_CONFIG_CONTENT)
src/sessions.ts   cross-harness session enumeration for -r (read-only store scans)
src/launch.ts     spawn / print-env
src/search-provider.ts  web config/key resolution + Firecrawl v2 client
src/search-proxy.ts  Claude WebSearch/WebFetch interception + upstream passthrough
src/search-proxy.test.ts  loopback boundary tests with fake upstreams
src/web-fetch-hook.ts  Claude command-hook bridge to the process-scoped proxy
src/doctor.ts     doctor report
src/update.ts     self-update: gh-auth release lookup → staged download → atomic swap
src/runtime.ts    build-time constants (standalone-binary detection)
src/manage.ts     non-interactive commands: models, profiles, provider keys
src/cache.ts      model-list cache
src/which.ts      PATH binary lookup (PATHEXT-aware)
src/time-ago.ts   relative time for recents
src/atomic-write.ts  crash-safe file writes (staged temp + atomic rename)
src/types.ts      shared types
src/ui/defaults-screen.ts  home → defaults: global launch behavior
src/ui/home.ts    home screen
src/ui/letter-select.ts  select with letter hotkeys — auto a–e or per-row mnemonic (src/ui/prompts.ts and screens)
src/ui/output.ts  single re-export site for clack output helpers (+ bail, keyStoredText)
src/ui/prompts.ts pickers + confirm
src/ui/sessions.ts  resume session picker (autocomplete)
src/ui/providers-screen.ts  home → providers: key status + set/delete actions
src/ui/wizard.ts  first-run wizard + provider add
```
