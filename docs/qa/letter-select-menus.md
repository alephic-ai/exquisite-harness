# QA: letter-select menus (branch `letter-select`)

Scope: the a–e letter hotkeys added to every clack select in the UI — the prompt
rows render letter prefixes, pressing a letter submits that row directly,
arrows/enter/escape keep behaving exactly like clack's `select`, and long lists
letter only their first five selectable rows. The app is a CLI, so "drive the
browser" becomes "drive the terminal": interactive clack flows run under a PTY
harness.

Surfaces touched by the branch diff (all in `src/ui/`): `home.ts`, `prompts.ts`
(pickEffort, pickHarness, pickProvider, pickSearchProvider, confirmLaunch),
`wizard.ts` (provider type), `defaults-screen.ts`, `providers-screen.ts`, plus
the new `letter-select.ts` module itself.

## Prerequisites

- `pnpm install` done; `pnpm dev` runs `tsx src/main.ts`.
- A throwaway XDG config so the first-run wizard doesn't fire. The home-menu
  letter mapping depends on the recents count — use an **empty recents list** so
  the rows are fixed: a=new session, b=providers, c=defaults, d=doctor. Create
  `config.json` under `$XDG_CONFIG_HOME/eh/` with an `ollama` provider and no
  recents:

  ```json
  {
    "version": 1,
    "providers": {
      "ollama": { "type": "ollama", "baseURL": "http://localhost:11434" }
    }
  }
  ```

- PTY harness: `script(1)` with a pipe feeding delayed keystrokes
  (`(sleep 2; printf 'b') | script -qec "…" /dev/null`), or Python's `pty`
  module. Keystrokes are sent after the prompt has rendered (~2s).
- A fake harness on PATH is NOT required — steps escape out of the flow before
  any launch, except D.4 which stays at the launch confirm.

## A. Static gates

1. Run `pnpm lint:ci`. → exits 0 (eslint + prettier --check + tsc all clean —
   note `pnpm lint` auto-fixes formatting and can mask a lint:ci failure).
2. Run `pnpm test`. → all tests pass, including the four
   `src/ui/letter-select.test.ts` cases.
3. Run the compile build
   `bun build ./src/main.ts --compile --outfile /tmp/eh-letter-qa --target=bun --define IS_BUNDLE=true`.
   → exits 0 with exactly one more module than `origin/main` (the new
   `src/ui/letter-select.ts` itself; the new direct `@clack/core` dep is already
   in the bundle transitively and adds zero modules).

## B. Unit-level letter behavior (module driver)

Save this driver as a scratch file (outside the repo) and run it with
`pnpm exec tsx <driver> <mode>` from the repo root under the PTY harness:

```ts
import { letterSelect } from '<repo>/src/ui/letter-select.js'

const mode = process.argv[2] ?? 'letter'
const OPTIONS: Record<
  string,
  { disabled?: boolean; label: string; value: string }[]
> = {
  letter: [
    { label: 'claude', value: 'claude' },
    { label: 'codex', value: 'codex' },
    { label: 'grok', value: 'grok' },
  ],
  arrows: [
    { label: 'claude', value: 'claude' },
    { label: 'codex', value: 'codex' },
    { label: 'grok', value: 'grok' },
  ],
  long: [
    { label: 'm1', value: 'v1' },
    { label: 'm2', value: 'v2' },
    { label: 'm3', value: 'v3' },
    { label: 'm4', value: 'v4' },
    { label: 'm5', value: 'v5' },
    { label: 'm6', value: 'v6' },
    { label: 'm7', value: 'v7' },
    { label: 'm8', value: 'v8' },
  ],
  disabled: [
    { disabled: true, label: 'Model providers', value: 'h1' },
    { label: 'ollama', value: 'ollama' },
    { disabled: true, label: 'Search providers', value: 'h2' },
    { label: 'firecrawl', value: 'firecrawl' },
  ],
  cancel: [
    { label: 'claude', value: 'claude' },
    { label: 'codex', value: 'codex' },
  ],
  case: [
    { label: 'claude', value: 'claude' },
    { label: 'codex', value: 'codex' },
    { label: 'grok', value: 'grok' },
  ],
  render: [
    { label: 'claude', value: 'claude' },
    { label: 'codex', value: 'codex' },
    { label: 'grok', value: 'grok' },
  ],
}
async function main() {
  const v = await letterSelect({ message: 'harness', options: OPTIONS[mode] })
  console.log('PICKED=' + (typeof v === 'symbol' ? 'CANCEL' : v))
}
main().catch((e) => {
  console.log('ERROR=' + (e as Error).message)
  process.exit(1)
})
```

Each step: send the listed keys after the prompt renders, then grep the PTY
transcript for the `PICKED=` marker the driver prints.

1. Three options, send `b`. → `PICKED=codex` — a single letter submits the
   second row without any arrow keys.
2. Three options, send ↓ ↓ Enter. → `PICKED=grok` — arrow navigation and enter
   still work through the same prompt.
3. Eight options, send `g` then `e`. → `PICKED=v5` — `g` is beyond the five-row
   cap and does nothing; `e` still picks the fifth row.
4. Options with two `disabled: true` heading rows, send `b`. →
   `PICKED=firecrawl` — disabled rows don't consume letters; `b` is the second
   _selectable_ row.
5. Two options, send Escape (`\033`). → `PICKED=CANCEL` — the prompt resolves to
   clack's cancel symbol, not a crash or a stale value.
6. Three options, send uppercase `C`. → `PICKED=grok` — letter matching is
   case-insensitive; `c` is the third row's letter (letters follow row order,
   not label initials).
7. Render check (no key sent; kill after ~5s): the transcript shows rows as
   `a) <label>`, `b) <label>`, … and a footer line containing
   `a–c or ↑/↓ to select • Enter: confirm`.

## C. Real flow — pickers in the launch path

Run under the throwaway XDG config (empty recents). Each step: start `pnpm dev`,
send the listed keys with ~2s delays, grep the transcript for the named markers.

1. Home menu (`eh` bare). Send `a`. → the harness prompt appears in the
   transcript; the home menu rendered letter prefixes (`a) new session →`).
2. Harness prompt. Send `c`. → the transcript shows the submitted frame
   `c) grok` and then the provider prompt appears.
3. Provider prompt. Send Escape. → the transcript ends with `bye` (bail); the
   process exits 0 without launching anything.
4. Home menu again. Send ↓ then Enter. → the providers screen appears (row 1
   after row 0) — arrow selection still works in the real flow, not just the
   unit driver.
5. Home menu. Send `c`. → the defaults screen appears (its own lettered menu
   renders).
6. Defaults screen. Send `a`. → the approvals prompt appears (lettered).
7. Defaults screen approvals. Send Escape. → exits cleanly (`bye`) — Esc bails
   from these screens by design; the defaults menu's `← back` row is reachable
   with its letter (`b`) whenever not cancelling.

## D. Real flow — screens and wizard

1. Home menu. Send `b`. → the providers screen appears. With the minimal test
   config the list has two disabled heading rows plus rows for built-in
   providers; headings render without letter prefixes, selectable rows with.
2. Providers screen. Send Escape. → the transcript ends with `bye` — Esc exits
   the app from these screens (same bail semantics as C.3/C.7); the `← back` row
   (arrows + Enter) is the way back to the home menu.
3. `eh provider add`. Answer the provider-name text prompt with `qatest`, then
   at the type select send `b`. → the type prompt's submitted frame shows
   `b) openai-chat` and the base-URL text prompt appears; Escape out of it
   terminates cleanly.
4. Effort picker (needs ollama up). Run `pnpm dev claude ollama`, type
   `qwen3-coder` into the model autocomplete and Enter, then send `a` at the
   effort prompt. → the effort prompt renders letter prefixes (`a) auto`); the
   letter selects that effort level and proceeds (claude also shows the
   search-provider picker; Escape at the launch confirm ends the run).
   Fully-specified positionals (`eh claude ollama <model>`) skip every picker
   and launch straight away — don't use them for this step.

## E. Real flow — letters driving side-effecting paths

These steps need a **fake harness** (`claude` / `grok` shell scripts that print
their env and args, exit 0) first on PATH, per the eh-cli runbook's F.1
convention, plus a recents-seeded config (two entries: a claude/ollama and a
grok/ollama combo).

1. Launch confirm `go` by letter: `eh claude ollama`, pick the model, `a` at the
   effort prompt, `a` at the search picker, then `a` at the launch confirm. →
   the fake harness runs (its args/env banner prints) and eh exits with
   `back in eh`.
2. Launch confirm `save…` by letter: same chain but `b` at the confirm, type a
   profile name + Enter. → the profile lands in `config.json` and the launch
   still proceeds through the fake harness.
3. Providers-screen action menu: home → providers screen → pick a key-missing
   provider row (e.g. OpenRouter) by letter. → its action menu renders lettered
   (`a) set key…`, `b) ← back`); `b` returns to the providers list, and `a`
   opens the key prompt (Esc returns to the list). Key-less providers (ollama)
   show no action menu — existing behavior, not a letter regression.
4. Blocked-provider re-loop: with a custom `openai-chat` provider in the config,
   `eh claude` → the provider picker shows it with a `needs router` hint (sorted
   last). Send its letter. → the warn (`needs the phase-2 router`) prints and
   the picker re-renders lettered; Escape exits cleanly. A key-missing row's
   letter likewise flows warn → key prompt → re-loop.
5. Back-row letter: home → defaults screen → `b` (the `← back` row's letter). →
   the home menu renders again.
6. Recents lettered on a long home menu: with 2 recents the home menu has 6
   selectable rows — the recents and three static rows get a–e, `doctor` gets
   none, footer still `a–e or ↑/↓`. Send a recent's letter, complete any
   follow-up pickers by letter, `a` at the launch confirm. → the fake harness
   for that recent's harness runs and eh exits cleanly.

## Known limitations

- The launch-confirm prompt (`go/save/back`) is covered directly by E.1/E.2
  (real spawns through a fake harness, driven by letters).
- The search-provider picker requires a configured search provider to have more
  than the native row; it's exercised only through the same shared code path
  (the `native` row's letter is covered in D.4).
- Real (non-fake) harness spawns are out of scope here — the eh-cli runbook's
  launch section owns them.
- Video recording not requested; PTY transcripts are the evidence.

## Automated coverage

- `pnpm test` — includes `src/ui/letter-select.test.ts`: sequential letter
  assignment, disabled-row skipping, the five-row cap, and the guardrail that
  assigned letters never collide with clack's global alias keys (j/k/h/l/y/n).
- `pnpm lint:ci` — eslint + prettier --check + tsc.
