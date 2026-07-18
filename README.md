```
                .-----------------------------.
                /       E X Q U I S I T E       \
               '---------------+---------------'
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
               .---------------+---------------.
                \          H A R N E S S        /
                 '-----------------------------'
```

**`eh` — pick a harness, pick a provider, go.**

A small CLI that launches the agent harness you want (Claude Code, Codex, Grok
CLI) pointed at the model provider you want (Ollama, OpenRouter, Vercel AI
Gateway) — with the right env vars, args, effort level, and keys wired up for
you. Interactive when you want it, flags when you don't.

## Install

Releases are self-contained binaries on GitHub. The repo is private
(internal-only for now), so install goes through an authenticated `gh`. Pick the
asset for your platform — `eh-darwin-arm64` (Apple Silicon), `eh-darwin-x64`
(Intel), `eh-linux-arm64`, `eh-linux-x64`:

```bash
gh release download --repo alephic-ai/exquisite-harness --pattern eh-darwin-arm64
chmod +x eh-darwin-arm64
xattr -d com.apple.quarantine eh-darwin-arm64
mv eh-darwin-arm64 ~/.local/bin/eh
eh doctor
```

The block is comment-free so it pastes cleanly into both bash and zsh
(interactive zsh doesn't parse `#` comments). The `xattr` line is macOS-only and
may print "No such xattr" — harmless. `~/.local/bin` can be anywhere on your
PATH.

No runtime needed — the binary is self-contained. Later, `eh update`
self-updates to the latest release (also via `gh` auth).

## Run it

```bash
pnpm install
pnpm dev          # = tsx src/main.ts

# release build (single binary → dist/eh):
pnpm build        # requires bun
```

## Use it

```bash
eh                                    # interactive: recents, or harness → provider → model
eh claude ollama qwen3-coder          # launch, zero prompts
eh --harness codex -p ollama -m qwen3-coder
                                      # same, with flags (flags win over positionals)
eh cheap-local                        # launch a saved profile
eh claude -p ollama -s cheap-local    # save combo as a profile, then launch
eh --print-env claude ollama qwen3-coder
                                      # print the export lines, don't launch
```

### Effort

```bash
eh claude ollama qwen3-coder -e high  # low|medium|high|xhigh|max (default auto)
```

claude → `CLAUDE_CODE_EFFORT_LEVEL` (+ `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` for
non-Anthropic providers); codex → `model_reasoning_effort` (`xhigh`/`max` map to
`high`); grok has no knob and ignores it. Profiles and recents remember it.

### Keys

```bash
eh provider key gateway               # masked prompt → OS credential store
eh provider key gateway --delete
```

Keys resolve **env → OS credential store → file** (macOS Keychain, Linux Secret
Service via `secret-tool`, `secrets.json` mode `0600` elsewhere). The config
file only ever stores env-var _names_, never secrets. You can also set keys
inline in the picker or via Home → providers.

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

Design doc: [DESIGN.md](DESIGN.md) · QA runbook:
[docs/qa/eh-cli.md](docs/qa/eh-cli.md)
