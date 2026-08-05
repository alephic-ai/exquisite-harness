```
                .-----------------------------.
               /       E X Q U I S I T E       \
               '---------------++--------------'
                               ||
                         o\    ||    /o
                         | \   ||   / |
                         o--\--++--/--o
                         |   \ || /   |
                         o----\XX/----o
                         |    /XX\    |
                         o---/ || \---o
                         |  /  ||  \  |
                         o-/---++---\-o
                               ||
               .---------------++--------------.
                \        H A R N E S S        /
                 '---------------------------'
```

**`eh` — pick a harness, pick a provider, go.**

A small CLI that launches the agent harness you want (Claude Code, Codex,
[Grok Build](https://x.ai/cli)) pointed at the model provider you want (Ollama,
OpenRouter, Vercel AI Gateway) — with the right env vars, args, effort level,
and keys wired up for you. Interactive when you want it, flags when you don't.

## Install

Install the latest self-contained binary with no runtime or GitHub account:

```bash
curl -fsSL https://raw.githubusercontent.com/alephic-ai/exquisite-harness/main/install.sh | bash
```

The installer detects macOS or Linux and arm64 or x64, then installs `eh` to
`~/.local/bin`. Set `EH_INSTALL_DIR` to use another directory. Direct binaries
are also available from
[GitHub Releases](https://github.com/alephic-ai/exquisite-harness/releases). Run
`eh doctor` after installation to check your harnesses, providers, and keys.

No runtime needed — the binary is self-contained. Later, `eh update`
self-updates to the latest public release.

![Claude Code launched via eh, with a powerline statusline showing Vercel AI Gateway, model, list rates, session cost, and context usage](docs/images/eh-statusline.jpg)

When you launch Claude through `eh`, it injects a session statusline: provider,
model, the active provider rate range
($/1M), session cost, and context %
against the provider’s published window. Vercel AI Gateway sessions use the
gateway's exact billed cost metadata. Other totals are token-based estimates and
paid-provider fallbacks carry a `~`; providers with published zero rates show
exact `$0`. Partial or unpriceable totals show `—`
instead of guessing.

## Use it

```bash
eh                                    # interactive: recents, or harness → provider → model
eh claude ollama qwen3-coder          # launch, zero prompts
eh --harness codex -p ollama -m qwen3-coder
                                      # same, with flags (flags win over positionals)
eh cheap-local                        # launch a saved profile
eh claude -p ollama -s cheap-local    # save combo as a profile, then launch
eh -r                                 # pick from this dir's sessions (all harnesses)
eh -r codex -p ollama                 # only codex sessions; -p/-m/-e override the wiring
eh --print-env claude ollama qwen3-coder
                                      # print the export lines, don't launch
eh claude ollama qwen3-coder --search firecrawl
                                      # keep Claude's web UX, use Firecrawl
```

### Effort

```bash
eh claude ollama qwen3-coder -e high  # low|medium|high|xhigh|max (default auto)
```

claude → `CLAUDE_CODE_EFFORT_LEVEL` (+ `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` for
non-Anthropic providers); codex → `model_reasoning_effort` (`xhigh`/`max` map to
`high`); grok → `--reasoning-effort`. Profiles and recents remember it.

### Resume

`eh -r` shows a filterable list of the current directory's sessions across all
harnesses — claude, codex, and grok — newest first, each with its model and age,
and resumes your pick by session id. Sessions show up whether or not eh launched
them; the list comes from the harnesses' own session stores.

The wiring comes from your recents: the provider that last ran that
harness+model wins, falling back to the latest combo for the harness, then to
the pickers. Add positionals or flags to override — start local, resume on a
gateway model. `eh -r codex` lists only codex sessions.

Resume needs an interactive terminal. For scripts, `eh -r --print-env …` keeps
the old behavior: no picker, prints the env lines plus the harness's bare resume
args (its own picker / most recent).

### Headless runs

`eh run` is the non-interactive execution contract for orchestrators. It reads
one prompt from stdin, runs the selected harness in its native JSON streaming
mode, and writes versioned NDJSON to stdout:

```bash
printf 'fix the parser' |
  eh run codex ollama qwen3-coder --reasoning-effort high
```

Every output object carries `v: 1`. The normalized events are `run.started`,
`session.started`, `assistant.text`, `usage`, `run.error`, and `run.completed`.
Native machine events are preserved as `harness.event`; non-JSON output is
preserved as `harness.output`. Harness stderr remains stderr. A semantically
failed native result makes both `run.completed.exitCode` and the `eh` process
exit code non-zero, even when the child process exits zero.

The fully specified command never opens UI, updates recents, or installs a
statusline. Claude and Codex receive the prompt over stdin. Grok receives a
private temporary prompt file because its headless CLI exposes `--prompt-file`;
`eh` removes that file after the child exits. Native session resume is available
with `--resume-session <id>`. Orchestrators that must preserve harness-specific
policy flags can pass a JSON string array with `--native-args-json`; those args
are prepended before `eh`'s required machine-output flags.

### Keys

```bash
eh provider key vercel-ai-gateway               # masked prompt → OS credential store
eh provider key vercel-ai-gateway --delete
eh search key firecrawl                         # same storage, separate account
eh search key firecrawl --delete
```

Keys resolve **env → OS credential store → file** (macOS Keychain, Linux Secret
Service via `secret-tool`, `secrets.json` mode `0600` elsewhere). The config
file only ever stores env-var _names_, never secrets. You can also set keys
inline in the picker or via Home → providers.

### Web search and fetch

Claude Code normally fulfills `WebSearch` with an Anthropic server tool, which
breaks when the selected model provider does not implement that tool. `eh` can
keep Claude Code's native tool flow while fulfilling searches and page fetches
through Firecrawl:

```bash
eh search key firecrawl
eh claude vercel-ai-gateway deepseek/deepseek-v4-flash --search firecrawl
```

On an interactive Claude launch, the web-search picker offers Native (the
fallback) and Firecrawl. Home → Providers shows both under Search providers;
choose one and select **make default**. After storing a new Firecrawl key there,
or with `eh search key firecrawl`, `eh` also asks whether to use it by default
for new Claude sessions. Existing Claude recents follow the new default, saved
profiles remain pinned to their saved choice, and `--search` still overrides
everything. Firecrawl's key resolves from `FIRECRAWL_API_KEY` or the same secure
stores used for model providers; `config.json` contains only its env-var name
and endpoint.

This is intentionally a harness-level hack, not MCP. For the life of the Claude
process, `eh` runs a loopback proxy that forwards normal Anthropic traffic to
the chosen model provider and intercepts Claude Code's hidden `web_search_*`
server-tool request. The response uses Anthropic's structured server-tool blocks
so Claude Code reports the real search count and retains the Firecrawl links.

Claude Code executes `WebFetch` locally rather than through the Messages API, so
`eh` also installs process-scoped `PostToolUse` and `PostToolUseFailure` hooks.
They use Firecrawl's official Node SDK to call `POST /v2/scrape`; a successful
native fetch has its model-visible result replaced with Firecrawl markdown,
while a native failure receives the Firecrawl content as recovery context.
Claude's built-in download still happens before the post-tool hook—the hook
controls what the model reads, not the original network request. The SDK is
bundled into the standalone `eh` binary, so users do not install another runtime
or daemon. Both undocumented Claude Code boundaries are covered by loopback
integration tests and may need updating if Claude Code changes them.

### Everything else

```bash
eh doctor                             # harnesses installed? providers reachable? keys set?
eh providers                          # provider list + status
eh models ollama                      # live model list (5-min cache)
eh provider add                       # add a custom provider interactively
eh profile save|list|rm               # manage saved combos
eh setup                              # re-run the first-run wizard
eh update                             # self-update to the latest release
```

## The matrix

|             | Ollama | OpenRouter | Vercel AI Gateway |
| ----------- | ------ | ---------- | ----------------- |
| Claude Code | ✅     | ⚠️ router  | ✅                |
| Codex       | ✅     | ✅         | ✅                |
| Grok        | ✅     | ✅         | ✅                |

✅ = native protocol match, launched with env/args only. ⚠️ = needs the phase-2
protocol router (see [DESIGN.md](DESIGN.md)).

## Config

`~/.config/eh/config.json` (`$XDG_CONFIG_HOME/eh`, `%APPDATA%\eh` on Windows) —
providers, profiles, recents. `~/.config/eh/cache.json` — model lists. All three
matrix providers are built in; config only overrides or adds custom ones.
Firecrawl search is also built in; `searchProviders` can override its `baseURL`
or `envKey`, and `defaultSearchProvider` controls new Claude launches.

## Developing

Only needed if you're hacking on `eh` itself — users should
[install a release](#install) instead.

```bash
pnpm install
pnpm dev          # run from source (tsx src/main.ts)
pnpm build        # release build: single binary → dist/eh (requires bun)
```

Design doc: [DESIGN.md](DESIGN.md) · QA runbook:
[docs/qa/eh-cli.md](docs/qa/eh-cli.md)
