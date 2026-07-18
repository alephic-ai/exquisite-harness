# exquisite-harness

`eh` — pick a harness, pick a provider, go. Self-contained bun-compiled CLI.
DESIGN.md has the full design; README.md has usage.

## Standards

House standards live in skills — read them before changing code:

- `~/.claude/skills/coding-best-practices/SKILL.md` (+
  `references/typescript.md`)
- `~/.claude/skills/code-organization/SKILL.md`

Repo rules that aren't in the skills:

- **No new runtime deps without discussion** — everything is bundled into a
  single binary; keep it to commander, zod, @clack/prompts. (`src/update.ts`
  uses raw fetch + the clack spinner instead of octokit + ora for this reason.)
- **All clack imports go through `src/ui/`** — flag-driven paths import from
  `src/ui/output.ts` only, never prompt widgets (DESIGN.md "Stack").
- **`src/ui/output.ts` is a deliberate barrel** — the single re-export site that
  keeps the UI library swappable. The one allowed exception to the
  no-barrel-files rule.
- **Versions are plain X.Y.Z** — `scripts/check-version-guard.sh` rejects
  anything else at PR time, and `src/update.ts`'s comparator relies on it.

## Releases

Merging to main releases automatically — never create tags or releases by hand.
`version-guard.yml` requires a strictly-forward version bump whenever
release-affecting files change (the list lives in
`scripts/release-affecting-files.sh`, the single source of truth sourced by both
the guard and the release workflow). `release.yml` compiles 4 targets and
publishes `eh-v<version>` to GitHub releases; `eh update` self-updates from
those.

## Layout

DESIGN.md "File map" is the source of truth for `src/` — update it when adding
modules.
