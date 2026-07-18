# Exquisite Harness (`eh`) — Design

A CLI that lets you choose a **harness** (Claude Code, Codex, Grok CLI) and
point it at a **provider** (Ollama, OpenRouter, Vercel AI Gateway), then
launches it. Pick a cell in the matrix, `eh` wires it up.

## Core insight

Harnesses speak a wire protocol; providers expose protocol endpoints. Matching
them is the whole game, and the matrix is already mostly green natively:

| Harness     | Speaks                  | Configured via                                                       |
| ----------- | ----------------------- | -------------------------------------------------------------------- |
| Claude Code | Anthropic Messages      | env: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` |
| Codex CLI   | OpenAI Responses / Chat | `-c` overrides (TOML): `model_providers.*`                           |
| Grok CLI    | OpenAI Chat Completions | env: `GROK_API_KEY`, `GROK_BASE_URL`, `--model`                      |

| Provider          | Endpoints                                       |
| ----------------- | ----------------------------------------------- |
| Ollama            | OpenAI chat + responses, **Anthropic Messages** |
| OpenRouter        | OpenAI chat (normalized across upstreams)       |
| Vercel AI Gateway | OpenAI chat + responses, **Anthropic Messages** |

Resulting compatibility (✅ = native, ⚠️ = needs protocol translation):

|             | Ollama | OpenRouter | Vercel Gateway |
| ----------- | ------ | ---------- | -------------- |
| Claude Code | ✅     | ⚠️ router  | ✅             |
| Codex       | ✅     | ✅         | ✅             |
| Grok        | ✅     | ✅         | ✅             |

## Architecture

**Phase 1 (this build): thin launcher.** Resolve `(harness, provider, model)` →
env vars + CLI args → `spawn` the harness with inherited stdio. No server, no
runtime dependency, no mutation of the harnesses' own config files.

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
> OpenRouter + Vercel AI Gateway already cover aggregation, and Gateway natively
> closes the Anthropic-protocol gap. Revisit only if we ever want
> OAuth-subscription providers (Claude Pro / ChatGPT Plus as APIs).

## UX

```text
eh                                  # home: recents, new session, providers, doctor
eh claude                           # interactive: provider + model pickers
eh claude ollama                    # interactive: model picker only
eh claude ollama qwen3-coder        # no UI, just launches
eh cheap-local                      # launch saved profile
eh --print-env claude ollama …      # print the export lines, don't launch
eh doctor                           # harnesses installed? providers reachable? keys set?
eh models ollama                    # live model list (5 min cache)
eh providers                        # configured providers + status
eh provider add                     # interactive: add a provider to config
eh profile save <name>              # save last launched combo as a profile
eh profile list / rm <name>
eh setup                            # re-run first-run wizard
```

Picker flow (via `@clack/prompts`, skipped per already-specified args):

1. **Home** — recent combos (Enter relaunches last), or new session.
2. **Harness** — installed status in the hint.
3. **Provider** — filtered to protocol-compatible; incompatible rows shown with
   a `needs router` hint. Status hints: `● running`, `✓ key set`,
   `✗ KEY not set`. Selecting a provider that needs a key but has none prompts
   for it inline (masked, Esc to go back) — no separate command needed. Home →
   providers is a management screen: per-provider key status with set/delete-key
   actions.
4. **Model** — live list from the provider (cached 5 min, stale fallback),
   scrollable, with a manual-entry escape hatch.
5. **Confirm** — `note()` with resolved env/args → go / save as profile / back.

First run (no config file): mini-wizard detects harness binaries, probes
`localhost:11434`, detects `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` in the
environment, and offers to stash those keys in the OS credential store (there is
nothing provider-related to write — all three are built in). Non-TTY stdout ⇒
positional args must be complete; no prompts.

## Config

`~/.config/eh/config.json` (XDG-aware), zod-validated:

```jsonc
{
  "version": 1,
  "providers": {
    "ollama": { "type": "ollama", "baseURL": "http://localhost:11434" },
    "openrouter": { "type": "openai-chat", "envKey": "OPENROUTER_API_KEY" },
    "gateway": { "type": "vercel-gateway", "envKey": "AI_GATEWAY_API_KEY" },
  },
  "profiles": {
    "cheap-local": {
      "harness": "claude",
      "provider": "ollama",
      "model": "qwen3-coder",
    },
  },
  "recent": [
    {
      "harness": "claude",
      "provider": "ollama",
      "model": "qwen3-coder",
      "usedAt": "…",
    },
  ],
}
```

Provider `type` implies: protocols served, default base URL, default API-key env
var, model-listing strategy, Codex `wire_api`. Each harness declares the set of
protocols it can speak (`claude: [anthropic]`,
`codex: [openai-responses, openai-chat]`, `grok: [openai-chat]`); a
harness/provider pair is compatible when the sets intersect. All three matrix
providers are built in, so the full 3×3 is visible with no config file at all:
Ollama works zero-config (no key needed; token value `ollama` is sent where
required but ignored), while openrouter/gateway appear with a "key not set" hint
until a key is stored or their env var is set. The config file only overrides
built-ins or adds custom providers. Model cache: `~/.config/eh/cache.json`,
5-minute TTL.

## Key handling

`eh` can store provider API keys so you don't have to pre-export env vars.
Design follows the doc-backed patterns of the harnesses themselves:

| Tool        | Storage pattern                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Claude Code | macOS Keychain (darwin) / `~/.claude/.credentials.json` 0600 (linux); `apiKeyHelper` shell hook |
| Codex CLI   | `cli_auth_credentials_store=auto`: OS credential store, else `~/.codex/auth.json`               |
| Grok CLI    | plaintext `~/.grok/user-settings.json`                                                          |
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
never the value.

Phase-2 note (Claude Code's `apiKeyHelper` pattern): a stored key _command_
(`eh provider key <name> --cmd 'op read "op://…"'`) would let 1Password users
resolve at launch time without eh storing anything.

## Launch plans

- **claude**: env `ANTHROPIC_BASE_URL` (provider's Anthropic endpoint),
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`.
  Effort (when not `auto`): `CLAUDE_CODE_EFFORT_LEVEL=<level>`, plus
  `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` for non-Anthropic providers (the model ID
  isn't effort-recognized there, so force the parameter through).
- **codex**: `-c` TOML overrides — `model`, `model_provider=eh`,
  `model_providers.eh.{name,base_url,wire_api,env_key}`, plus
  `model_reasoning_effort=<level>` (codex caps at `high`, so `xhigh`/`max` map
  down). No writes to `~/.codex/config.toml`.
- **grok**: env `GROK_API_KEY`, `GROK_BASE_URL`, args `--model <id>`. grok-cli
  has no effort knob; an explicit effort is noted and ignored. (Flag shape
  follows grok-cli's README; verify against installed version — `eh doctor`
  reports the binary path.)

**Effort** is an optional part of a selection (`auto`, `low`, `medium`, `high`,
`xhigh`, `max`), resolved flag → profile → interactive default (`auto` = model
default, sends nothing). Vercel AI Gateway also exposes the OpenAI
`reasoning.effort` pass-through, so effort works end-to-end for gateway-backed
codex/OpenAI models.

## Stack

TypeScript (strict, tools/main shared configs), `@clack/prompts` (UI),
`commander` (args), `zod` (config + API response validation). Dev via `tsx`;
release build via `bun build --compile` → single `dist/eh` binary. All clack
imports are isolated in `src/ui/`; flag-driven paths never touch that module,
which keeps non-TTY use clean and a future Ink/miller-column UI swappable.

## File map

```text
src/main.ts       entry: commander wiring
src/flow.ts       positional/profile resolution → pickers → launch
src/config.ts     schema, load/save, recents, profiles, XDG paths
src/providers.ts  provider types: protocols, model listing, status checks
src/harnesses.ts  harness registry: detection + launch plans
src/launch.ts     spawn / print-env
src/doctor.ts     doctor report
src/manage.ts     non-interactive commands: models, profiles, provider keys
src/cache.ts      model-list cache
src/which.ts      PATH binary lookup (PATHEXT-aware)
src/time-ago.ts   relative time for recents
src/types.ts      shared types
src/ui/home.ts    home screen
src/ui/output.ts  single re-export site for clack log/intro/outro/note
src/ui/prompts.ts pickers + confirm
src/ui/providers-screen.ts  home → providers: key status + set/delete actions
src/ui/wizard.ts  first-run wizard + provider add
```
