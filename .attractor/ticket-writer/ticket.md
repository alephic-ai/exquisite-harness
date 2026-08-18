# eh gateway validation: a blank plan provider key must suppress the ambient env fallback

## Problem

`gatewayValidationHeaders` (`src/gateway-routing.ts:232-244`) picks the credential for
`eh`'s gateway preflight validation from a fallback chain that ranks the ambient
`process.env[apiKeyEnvKey]` **above** the launch plan's own `ANTHROPIC_AUTH_TOKEN` — even
when the plan explicitly owns that key with a blank value. `planClaude` blanks it on
purpose (`src/harnesses.ts:108`, `ANTHROPIC_API_KEY: ''`) precisely so Claude Code
authenticates with `ANTHROPIC_AUTH_TOKEN` instead, and the child process really does
receive the blank (`src/headless-run.ts:216-218` and `src/launch.ts:96-113` both spread
`plan.env` over `process.env`). So validation can put a shell credential on the wire that
the spawned child is configured never to use.

This is not hypothetical: the repo's own test at `src/gateway-routing.test.ts:419` fails on
`main` today on any machine or CI runner with `ANTHROPIC_API_KEY` exported. Verified in a
clean checkout of `c7f965f`:

```
$ ANTHROPIC_API_KEY=ambient-leaked-key bun test src/gateway-routing.test.ts
Expected: "Bearer qa-auth-token"
Received: "Bearer ambient-leaked-key"
(fail) gateway provider routing > uses a non-empty auth token when the provider key
       variable is deliberately blank
17 pass, 1 fail
```

Left unfixed, the suite stays environment-dependent (or gets patched to sanitize the
environment, hiding the precedence bug rather than fixing it), and the latent credential
divergence becomes a live authentication bug the moment key resolution stops being
env-first or a second harness plan blanks a provider key.

## Context

- **Where the precedence comes from.** `planEnvValue` (`src/gateway-routing.ts:260-262`)
  distinguishes absent (`undefined`, via `Object.hasOwn`) from present-and-blank (`''`),
  but the chain's selector — `.find((value) => value !== undefined && value.trim().length > 0)`
  — collapses both to "skip". The ownership signal is computed and then discarded. That is
  the whole mechanism.
- **The ambient rung is load-bearing and must survive.** `planCodex`
  (`src/harnesses.ts:174-178`), `planPi` (`:278-282`) and `planOpencode` (`:340-344`)
  inject `env[provider.envKey]` **only when the ambient var is unset**. When ambient *is*
  set, `plan.env` holds no such key and no `ANTHROPIC_AUTH_TOKEN`, so
  `process.env[apiKeyEnvKey]` is the only credential available. Deleting the fallback, or
  suppressing it on *absence* rather than on *blank ownership*, breaks gateway auth for
  those three harnesses. No existing test covers that path (the plan-construction fixtures
  at `src/gateway-routing.test.ts:678-682` and `:721-725` all declare providers without
  `envKey` and assert `apiKeyEnvKey: undefined`), so a wrong fix can go green.
- **Why the divergence is currently masked.** `resolveApiKey` is env-first
  (`src/keys.ts:246-251`: `const fromEnv = process.env[envKey]; if (fromEnv) return ...`),
  so when ambient is non-empty the plan's `ANTHROPIC_AUTH_TOKEN` usually *is* that same
  ambient value. The bug is real and reproducible as the failing test above; the
  user-facing credential mismatch is gated behind that coupling, which is undocumented —
  hence the DESIGN.md criterion below.
- **Single site, not a family.** `grep -n "process.env" src/gateway-routing.ts` returns
  exactly one hit (`:238`). The other ambient-adjacent reads are a different, deliberate
  pattern: `src/harnesses.ts:174`/`:278`/`:340` use ambient as a *presence check* to decide
  whether to inject, never as a value validation consumes; `src/keys.ts:249` is the
  documented env-first resolution order; `src/launch.ts:92-97` strips `EH_*` before
  merging. Fixing `:238` leaves no inconsistent siblings. Treat this as the verified
  starting list, not a closed world — re-grep before assuming.
- **`gatewayValidationHeaders` is module-private** with exactly one caller
  (`src/gateway-routing.ts:42`, inside `withGatewayRouting`). No exported API or type
  changes; `LaunchPlan.gatewayRouting.apiKeyEnvKey` (`src/types.ts:14`) is untouched.
- **Relationship to PR #49 / AI-3109.** This is a deferred `codex` review finding from
  https://github.com/alephic-ai/exquisite-harness/pull/49. That PR did not touch
  `src/gateway-routing.ts`; it only added 6 lines to
  `src/gateway-routing.test.ts` (capture `priorApiKey`, `delete process.env.ANTHROPIC_API_KEY`,
  restore in `finally`) to make the test hermetic against the leaked ambient key. This
  ticket is **independently dispatchable** — the red test exists on `main`. If PR #49 has
  merged by the time you start, that sanitization scaffolding is now dead and must be
  removed as part of the test change; do not leave both the workaround and the fix in
  place. No open PR (#47, #48, #49, #50) touches `src/gateway-routing.ts`.
- **Version bump is mandatory.** `src/gateway-routing.ts` matches the release-affecting
  pattern in `scripts/release-affecting-files.sh:13`. Bump `package.json` to the next
  unreleased version — do not assume a literal number, since several open PRs are all
  sitting on the current one; `scripts/check-version-guard.sh` rejects a stale bump.

## Acceptance Criteria

- [ ] **Invariant:** the credential `gatewayValidationHeaders` selects is never a value the
      spawned child would not see. Concretely: when `plan.env` owns `apiKeyEnvKey` (per
      `Object.hasOwn`) with a blank or whitespace-only value, resolution skips the ambient
      `process.env[apiKeyEnvKey]` rung entirely and continues down the chain to the plan's
      `ANTHROPIC_AUTH_TOKEN` / `XAI_API_KEY`. **Complement — what must never happen:** the
      ambient rung is still consulted when `plan.env` does **not** own `apiKeyEnvKey`, so
      the codex / pi / opencode ambient-key path (`src/harnesses.ts:174`, `:278`, `:340`)
      keeps resolving a header; and when nothing in the chain yields a non-empty value the
      function still returns headers with no `authorization` set (a blank owned key
      suppresses the ambient fallback — it does not short-circuit the chain or blank the
      header). The relative order of the remaining rungs is unchanged.
- [ ] **Fail-first proof:** `src/gateway-routing.test.ts`'s existing test
      `'uses a non-empty auth token when the provider key variable is deliberately blank'`
      (`:419`) asserts `Bearer qa-auth-token` **with a non-empty ambient
      `ANTHROPIC_API_KEY` deliberately set for the duration of the test** (set and restored
      in `finally`, the shape already used at `src/grok-home.test.ts:47-48`), so it
      reproduces the real failure — currently `Received: "Bearer ambient-leaked-key"` — and
      passes only after the fix. If PR #49's `delete process.env.ANTHROPIC_API_KEY`
      sanitization is present on your base, remove it: the test must now prove the
      precedence rather than hide the ambient value.
- [ ] DESIGN.md's gateway-routing section (~`:308-334`) states the validation-credential
      rule: preflight validation authenticates with the same credential the child will use,
      a plan-owned blank provider key suppresses the ambient fallback, and the ambient
      fallback exists for harnesses whose plans omit the key. Note the `resolveApiKey`
      env-first coupling (`src/keys.ts:246-251`) so a future change to key-resolution order
      does not silently reintroduce a divergence.

## Out of Scope

- Refactoring `gatewayValidationHeaders` (or `withGatewayRouting` and its two callers) to
  take an injected `env` parameter in the style of `ratesFromEnv`
  (`src/pricing.ts:406-407`). Wider blast radius for no behavioral gain — the loopback-
  upstream test already proves the header on the wire.
- Changing `resolveApiKey`'s env-first resolution order (`src/keys.ts:239-262`) or
  "aligning" the ambient presence checks in `src/harnesses.ts:174`/`:278`/`:340`.
- Any change to the reserved exit codes, `run.completed`, or `src/headless-run.ts` from
  AI-3109 / PR #49.
- Provider/auth-error classification or per-harness error-shape parsing (deferred by
  decision on AI-3109).
- Adding coverage for the codex / pi / opencode ambient-injection path. The invariant above
  constrains the fix; building out that fixture family is separate work.

## Key Decisions

- **Chosen: "blank owned value suppresses only the ambient rung."** Resolution continues
  to `ANTHROPIC_AUTH_TOKEN` / `XAI_API_KEY`. Grounded in `planClaude`'s intent — it blanks
  `ANTHROPIC_API_KEY` *in order to* redirect Claude Code onto `ANTHROPIC_AUTH_TOKEN`
  (`src/harnesses.ts:107-113`) — and it is what the existing test asserts.
  **How this choice can still be wrong:** if the ownership test is written against
  emptiness rather than `Object.hasOwn`, the ambient rung gets suppressed for plans that
  merely *omit* the key, breaking codex/pi/opencode gateway auth with a 401 that no
  existing test catches. That failure mode is exactly why the invariant's complement is
  spelled out above.
- **Rejected: treat a blank owned value as "no credential at all"** and send no
  `authorization` header. Contradicts `planClaude`'s redirection intent and would break the
  existing test.
- **Rejected: frame this as a live user-facing credential-mismatch bug** (the review
  finding's original wording). The repo's env-first `resolveApiKey` (`src/keys.ts:246-251`)
  means ambient and the plan's auth token coincide today, and reaching a diverging pair
  needs a hand-written config with `envKey: "ANTHROPIC_API_KEY"` on a routing provider
  (permitted by `src/config.ts:15-19`, defaulted away by `:100-106`/`:138`, suggested
  nowhere). The grounded, verified failure is the environment-dependent test; the ticket is
  written against that.
- **Rejected: leaving the test hermetic** (PR #49's approach — delete the ambient key
  before the assertion). It makes the suite green while the precedence stays wrong, and
  discards the only check that can catch a regression.

## Verification

- `bun test src/gateway-routing.test.ts` — the targeted check. Confirm it is **red before**
  the fix (run it with `ANTHROPIC_API_KEY=ambient-leaked-key` if your shell does not
  already export one) and green after.
- `pnpm test` — full suite.
- `pnpm lint:ci` — eslint + prettier + `tsc --noEmit`.
- Bump `package.json` to the next unreleased version, then
  `bash scripts/check-version-guard.sh --staged`.
- Optional, needs a real Gateway key and is outside automated scope:
  `docs/qa/eh-cli.md:247-251` (conditional provider-routing check). Whether the selected
  credential is actually *accepted* by Vercel AI Gateway / OpenRouter cannot be exercised
  in-repo — every gateway-routing test runs against a loopback fake.

## Delegability

```yaml
design_freedom: low
verification_strength: high
silent_failure_cost: medium
context_volatility: low
recommended_tier: low
recommended_effort: medium
```
