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
- A throwaway XDG config so the first-run wizard doesn't fire:
  `XDG_CONFIG_HOME=/tmp/qa-letter-select/xdg` with
  `/tmp/qa-letter-select/xdg/eh/config.json` containing an `ollama` provider
  (see the runner script in the run record; the exact body doesn't matter as
  long as `configExists()` is true).
- PTY harness: `script(1)` with a pipe feeding delayed keystrokes
  (`(sleep 2; printf 'b') | script -qec "…" /dev/null`), or Python's `pty`
  module. Keystrokes are sent after the prompt has rendered (~2s).
- A fake harness on PATH is NOT required — steps escape out of the flow before
  any launch.

## A. Static gates

1. Run `pnpm lint`. → exits 0 (eslint + prettier + tsc all clean).
2. Run `pnpm test`. → all tests pass, including the four
   `src/ui/letter-select.test.ts` cases.
3. Run the compile build
   `bun build ./src/main.ts --compile --outfile /tmp/eh-letter-qa --target=bun --define IS_BUNDLE=true`.
   → exits 0 with the same module count as `origin/main` (the new direct
   `@clack/core` dep is already in the bundle transitively).

## B. Unit-level letter behavior (module driver)

A small tsx driver invoking `letterSelect` directly (see run record for the
source). Each step: send the listed keys after the prompt renders, then grep the
PTY transcript for the `PICKED=` marker the driver prints.

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
6. Three options, send uppercase `C`. → `PICKED=codex` — letter matching is
   case-insensitive.
7. Render check (no key sent; kill after ~5s): the transcript shows rows as
   `a) <label>`, `b) <label>`, … and a footer line containing
   `a–c or ↑/↓ to select • Enter: confirm`.

## C. Real flow — pickers in the launch path

Run under the throwaway XDG config. Each step: start `pnpm dev`, send the listed
keys with ~2s delays, grep the transcript for the named markers.

1. Home menu (`eh` bare). Send `a`. → the harness prompt appears in the
   transcript; the home menu rendered letter prefixes (`a) new session →`).
2. Harness prompt. Send `c`. → the transcript shows the submitted frame
   `c) grok` and then the provider prompt appears.
3. Provider prompt. Send Escape. → the transcript ends with `bye` (bail); the
   process exits 0 without launching anything.
4. Home menu again. Send ↓ then Enter. → the harness prompt appears — arrow
   selection still works in the real flow, not just the unit driver.
5. Home menu. Send `d`. → the defaults screen appears (its own lettered menu
   renders).
6. Defaults screen. Send `a`. → the approvals prompt appears (lettered).
7. Defaults screen approvals. Send Escape. → exits cleanly (`bye`) — Esc
   bails from these screens by design; the defaults menu's `← back` row is
   reachable with its letter (`b`) whenever not cancelling.

## D. Real flow — screens and wizard

1. Home menu. Send `b`. → the providers screen appears. With the minimal test
   config the list has two disabled heading rows plus rows for built-in
   providers; headings render without letter prefixes, selectable rows with.
2. Providers screen. Send Escape. → back at the home menu.
3. `eh provider add`. Answer the provider-name text prompt with `qatest`, then
   at the type select send `b`. → the type prompt's submitted frame shows
   `b) openai-chat` and the base-URL text prompt appears; Escape out of it
   terminates cleanly.
4. Effort picker (needs ollama up). Run `pnpm dev claude ollama`, type
   `qwen3-coder` into the model autocomplete and Enter, then send `a` at the
   effort prompt. → the effort prompt renders letter prefixes (`a) auto`);
   the letter selects that effort level and proceeds (claude also shows the
   search-provider picker; Escape at the launch confirm ends the run).
   Fully-specified positionals (`eh claude ollama <model>`) skip every picker
   and launch straight away — don't use them for this step.

## Known limitations

- The launch-confirm prompt (`go/save/back`) is covered indirectly: it uses the
  same `letterSelect` call path as every other picker, but no step drives it to
  a real launch (that would spawn a real harness). Its letter behavior is
  identical to B.1–B.5 by construction.
- The search-provider picker requires a configured search provider to have more
  than the native row; it's exercised only through the same shared code path.
- Video recording not requested; PTY transcripts are the evidence.

## Automated coverage

- `pnpm test` — includes `src/ui/letter-select.test.ts`: sequential letter
  assignment, disabled-row skipping, the five-row cap, and the guardrail that
  assigned letters never collide with clack's global alias keys (j/k/h/l/y/n).
- `pnpm lint` — eslint + prettier + tsc.
