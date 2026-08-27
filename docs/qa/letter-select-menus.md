# QA: letter-select menus (branch `home-menu-hotkeys`)

Scope: the letter hotkeys on every clack select in the UI — rows render
bracketed letter prefixes (`[a]`, `[n]`, …), pressing a letter submits that row
directly, arrows/enter/escape keep behaving exactly like clack's `select`,
auto-assigned letters cover only the first five selectable rows (a–e), and rows
can carry a fixed mnemonic hotkey (home: `n`/`p`/`f`/`o`; effort: `m` for
`max`). A disabled row with no label renders as a divider rule (`─`) that the
cursor skips. The app is a CLI, so "drive the browser" becomes "drive the
terminal": interactive clack flows run under a PTY harness.

Surfaces touched by the branch diff (all in `src/ui/`): `letter-select.ts`
(bracket labels, `hotkey` option, divider rendering, footer summary), `home.ts`
(fixed hotkeys + divider row), `prompts.ts` (`pickEffort` `m` hotkey).
Shared-primitive regression candidates: `wizard.ts`, `defaults-screen.ts`,
`providers-screen.ts`, and the other `prompts.ts` pickers (all render through
`letterSelect`).

## Prerequisites

- `pnpm install` done; `pnpm dev` runs `tsx src/main.ts`.
- A throwaway XDG config so the first-run wizard doesn't fire. With an **empty
  recents list** the home rows are fixed: n=new session, p=providers,
  f=defaults, o=doctor, and no divider row renders. Create `config.json` under
  `$XDG_CONFIG_HOME/eh/` with an `ollama` provider and no recents:

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
  any launch, except E.1/E.2/E.6 which launch through the fake harness.
- **The throwaway XDG config does NOT isolate the macOS keychain.** eh resolves
  provider keys from env → keychain → file, and the keychain is global. Never
  drive a provider action menu blind: capture the menu first, and never send a
  letter whose row you haven't confirmed. A key-set provider's action menu is
  `set key… / delete stored key / ← back` — the `b` you meant for `← back`
  deletes the real key. (Learned the hard way, 2026-08-27.)

## A. Static gates

1. Run `pnpm lint:ci`. → exits 0 (eslint + prettier --check + tsc all clean —
   note `pnpm lint` auto-fixes formatting and can mask a lint:ci failure).
2. Run `pnpm test`. → all tests pass, including the
   `src/ui/letter-select.test.ts` cases.
3. Run the compile build
   `bun build ./src/main.ts --compile --outfile /tmp/eh-letter-qa --target=bun --define IS_BUNDLE=true`
   on this branch and on `origin/main`. → both exit 0 with the **same** module
   count (this branch adds no new modules).

## B. Unit-level letter behavior (module driver)

Save this driver as a scratch file (outside the repo) and run it with
`pnpm exec tsx <driver> <mode>` from the repo root under the PTY harness:

```ts
import { letterSelect } from '<repo>/src/ui/letter-select.js'

const mode = process.argv[2] ?? 'letter'
const OPTIONS: Record<
  string,
  { disabled?: boolean; hotkey?: string; label?: string; value: string }[]
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
  named: [
    { hotkey: 'n', label: 'new session', value: 'new' },
    { label: 'alpha', value: 'alpha' },
    { label: 'beta', value: 'beta' },
  ],
  skip: [
    { hotkey: 'b', label: 'claimed', value: 'claimed' },
    { label: 'one', value: 'one' },
    { label: 'two', value: 'two' },
  ],
  divider: [
    { label: 'r1', value: 'r1' },
    { label: 'r2', value: 'r2' },
    { disabled: true, value: '__divider__' },
    { label: 'act', value: 'act' },
  ],
  reserved: [{ hotkey: 'y', label: 'bad', value: 'bad' }],
  dup: [
    { hotkey: 'n', label: 'x', value: 'x' },
    { hotkey: 'n', label: 'y', value: 'y' },
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

1. `letter` mode, send `b`. → `PICKED=codex` — a single letter submits the
   second row without any arrow keys.
2. `arrows` mode, send ↓ ↓ Enter. → `PICKED=grok` — arrow navigation and enter
   still work through the same prompt.
3. `long` mode, send `g` then `e`. → `PICKED=v5` — `g` is beyond the five-row
   auto cap and does nothing; `e` still picks the fifth row.
4. `disabled` mode, send `b`. → `PICKED=firecrawl` — disabled heading rows don't
   consume letters; `b` is the second _selectable_ row.
5. `cancel` mode, send Escape (`\033`). → `PICKED=CANCEL` — the prompt resolves
   to clack's cancel symbol, not a crash or a stale value.
6. `case` mode, send uppercase `C`. → `PICKED=grok` — letter matching is
   case-insensitive; `c` is the third row's letter (letters follow row order,
   not label initials).
7. Render check (`render` mode; no key sent; kill after ~5s): the transcript
   shows rows as `[a] <label>`, `[b] <label>`, `[c] <label>` and a footer line
   containing `a–c or ↑/↓ to select • Enter: confirm`.
8. `named` mode, send `n`. → `PICKED=new` — a fixed mnemonic hotkey submits its
   row; the transcript shows `[n] new session`, `[a] alpha`, `[b] beta` and a
   footer containing `n, a–b or ↑/↓ to select`.
9. `skip` mode, send `c`. → `PICKED=two` — auto letters skip the claimed `b`:
   rows are `[b] claimed`, `[a] one`, `[c] two`.
10. `divider` mode, send ↓ ↓ Enter. → `PICKED=act` — the cursor skips the
    divider row (row order r1, r2, divider, act: two downs land on act; if the
    divider were focusable this would submit `__divider__` instead).
11. Render check (`divider` mode; no key sent): the transcript shows a `─` rule
    line between `[b] r2` and `[c] act`; the rule line contains no radio (`○`)
    and no letter bracket.
12. `reserved` mode. → the transcript shows
    `ERROR=letterSelect: hotkey "y" collides with a key clack binds globally`
    and no prompt renders.
13. `dup` mode. → the transcript shows
    `ERROR=letterSelect: duplicate hotkey "n"` and no prompt renders.

## C. Real flow — pickers in the launch path

Run under the throwaway XDG config (empty recents). Each step: start `pnpm dev`,
send the listed keys with ~2s delays, grep the transcript for the named markers.

1. Home menu (`eh` bare). Send `n`. → the harness prompt appears in the
   transcript; the home menu rendered `[n] new session →`, `[p] providers`,
   `[f] defaults`, `[o] doctor` with no divider row and a footer containing
   `n, p, f, o or ↑/↓ to select`.
2. Harness prompt. Send `c`. → the transcript shows the submitted frame
   `[c] grok` and then the provider prompt appears.
3. Provider prompt. Send Escape. → the transcript ends with `bye` (bail); the
   process exits 0 without launching anything.
4. Home menu again. Send ↓ then Enter. → the providers screen appears (row 1
   after row 0) — arrow selection still works in the real flow, not just the
   unit driver.
5. Home menu. Send `f`. → the defaults screen appears (its own lettered menu
   renders).
6. Defaults screen. Send `a`. → the approvals prompt appears (lettered).
7. Defaults screen approvals. Send Escape. → exits cleanly (`bye`) — Esc bails
   from these screens by design; the defaults menu's `← back` row is reachable
   with its letter (`b`) whenever not cancelling.

## D. Real flow — screens and wizard

1. Home menu. Send `p`. → the providers screen appears. With the minimal test
   config the list has two disabled heading rows plus rows for built-in
   providers; heading rows render grayed without letters (they are not divider
   rules — they have labels), selectable rows with `[a]`-style brackets.
2. Providers screen. Send Escape. → the transcript ends with `bye` (Esc exits
   the app from these screens; the `← back` row is the way back to home).
3. `eh provider add`. Answer the provider-name text prompt with `qatest`, then
   at the type select send `b`. → the type prompt's submitted frame shows
   `[b] openai-chat` and the base-URL text prompt appears; Escape out of it
   terminates cleanly.
4. Effort picker (needs ollama up). Run `pnpm dev claude ollama`, pick `other…`
   in the model autocomplete and type `qwen3-coder`, then at the effort prompt
   check the render and send `m`. → the effort picker renders `[a] auto` and
   `[m] max` (auto-assigned a–e on the first five rows, `m` pinned to `max`
   regardless of how many levels the harness lists); pressing `m` selects the
   max effort and the flow proceeds to the next prompt (claude also shows the
   search-provider picker; Escape at the launch confirm ends the run).
   Fully-specified positionals (`eh claude ollama <model>`) skip every picker
   and launch straight away — don't use them for this step.

## E. Real flow — letters driving side-effecting paths

These steps need a **fake harness** (`claude` / `grok` shell scripts that print
their env and args, exit 0) first on PATH, per the eh-cli runbook's F.1
convention, plus a recents-seeded config (two entries: a claude/ollama and a
grok/ollama combo, claude most recent).

1. Launch confirm `go` by letter: `eh claude ollama`, pick the model, `a` at the
   effort prompt, `a` at the search picker, then `a` at the launch confirm. →
   the fake harness runs (its args/env banner prints) and eh exits with
   `back in eh`.
2. Launch confirm `save…` by letter: same chain but `b` at the confirm, type a
   profile name + Enter. → the profile lands in `config.json` and the launch
   still proceeds through the fake harness.
3. Providers-screen action menu: home → providers screen → pick a
   **key-missing** provider row by its shown letter (read it from a render-only
   run first; on a machine whose OpenRouter has a stored key, use another row).
   → its action menu renders lettered (`[a] set key…`, `[b] ← back`); `b`
   returns to the providers list, and `a` opens the key prompt (Esc returns to
   the list). Key-less providers (ollama) show no action menu — existing
   behavior, not a letter regression. **Do not run this step against a key-set
   row** — its menu contains `delete stored key` and the keychain is not
   isolated (see Prerequisites).
4. Blocked-provider re-loop: with a custom `openai-chat` provider in the config,
   `eh claude` → the provider picker shows it with a `needs router` hint (sorted
   last). Send its letter. → the warn (`needs the phase-2 router`) prints and
   the picker re-renders lettered; Escape exits cleanly. A key-missing row's
   letter likewise flows warn → key prompt → re-loop.
5. Back-row letter: home → `f` (defaults screen) → `b` (the `← back` row's
   letter). → the home menu renders again.
6. Recents lettered on a long home menu: with 2 recents the home menu shows
   `[a]`/`[b]` on the recents, a `─` divider rule with no letter and no radio,
   then `[n]`/`[p]`/`[f]`/`[o]` on the fixed rows, footer
   `a–b, n, p, f, o or ↑/↓`. Send recent `a`'s letter, complete any follow-up
   pickers by letter, `a` at the launch confirm. → the fake harness for that
   recent's harness runs and eh exits cleanly.

## Known limitations

- The launch-confirm prompt (`go/save/back`) is covered directly by E.1/E.2
  (real spawns through a fake harness, driven by letters).
- The search-provider picker requires a configured search provider to have more
  than the native row; it's exercised only through the same shared code path
  (the `native` row's letter is covered in E.1).
- Real (non-fake) harness spawns are out of scope here — the eh-cli runbook's
  launch section owns them.
- `src/skill.test.ts` ("installs idempotently…") fails on macOS hosts where
  `/var` is a symlink, identically on `origin/main` — a pre-existing environment
  issue, not a branch regression; note it in the run record.
- Video recording not requested; PTY transcripts are the evidence.

## Automated coverage

- `pnpm test` — includes `src/ui/letter-select.test.ts`: sequential letter
  assignment, disabled-row skipping, the five-row auto cap, explicit-hotkey
  honoring/skipping/case-folding, the disabled-explicit-claims-its-letter case,
  reserved-key/duplicate/non-letter rejection, the guardrail that auto letters
  never collide with clack's reserved keys (j/k/h/l/y), and `summarizeHotkeys`
  range compression.
- `pnpm lint:ci` — eslint + prettier --check + tsc.
