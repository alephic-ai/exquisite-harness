# Gateway-Rate costUsd on Headless Usage Events Implementation Plan

## Goal

`eh run` must stop trusting the inner harness's self-reported cost as the
authoritative number. Instead it computes cost from **its own** cumulative
normalized usage × the resolved model's gateway rates (honoring
`--gateway-provider` pins with per-endpoint, tiered pricing), and emits that on a
final summary `usage` event as `costUsd` with `costSource: "gateway-rates"`. Any
harness-reported cost is preserved separately as `harnessCostUsd`, never silently
preferred. When rates can't be resolved, no cost is fabricated and `costSource`
says why.

## Scope Boundary

IN: headless (`eh run`) cost computation and NDJSON event shape. New pure
pricing/cost functions in `src/pricing.ts`. Usage accumulation + final cost emit
in `src/headless-run.ts`. Doc updates.

OUT (do not touch): interactive-mode cost display / statusline (`src/statusline.ts`
stays as-is), reconciliation against the Vercel billing dashboard, the gateway
cost-capture proxy ledger (`src/gateway-costs.ts` — that is the *exact-billed*
path for interactive Claude and is unrelated to headless computed cost).

## Context for Implementer

Read `CLAUDE.md` (repo rules: no new runtime deps; all clack via `src/ui/`),
`DESIGN.md` "Headless execution" (lines 85-108) and the Claude statusline cost
notes (lines 345-378), and the two skills named in `CLAUDE.md`.

Key facts verified in this checkout:

- `fetchModelMeta` (`src/pricing.ts:87`) returns `rates: ModelRates` for a
  gateway model **from the model-aggregate `/models` pricing** — NOT
  per-endpoint. Proof: `src/pricing.test.ts` (the `bedrock`-pinned assertion,
  ~line 90) shows `rates` identical whether pinned or not; only `rateLabel`
  reflects the pin. So honoring the pin for *cost* (AC-1) needs a new
  per-endpoint path — the existing `rates` are insufficient.
- Per-endpoint pricing lives at `/models/{model}/endpoints`, fetched and
  filtered by status + `gatewaySlugMatches(pin)` inside `fetchGatewayRateLabel`
  (`src/pricing.ts:260-300`) — but that function only builds a display *range
  label*, it never returns usable rates. It is the reference for the fetch +
  filter + tier-collection pattern.
- The endpoint pricing schema (`gatewayEndpointsSchema`, `src/pricing.ts:68-84`)
  parses `prompt`/`completion` + `prompt_tiers`/`completion_tiers` but does NOT
  currently declare cache-rate fields. It is a `looseObject`, so unknown fields
  survive parsing but are untyped — you must add the cache fields to read them.
- Headless never fetches rates today: `buildLaunchPlan` is called with
  `statusline: false` (`src/headless-run.ts:104-114`), and `planClaude` only
  fetches meta when `statusline` is true (`src/harnesses.ts:93-106`). So the
  rate fetch for headless is entirely new and must live in `runHeadless`.
- Usage is normalized per-harness and emitted via `emitUsage`
  (`src/headless-run.ts:219-236`) with a `cumulative` flag. Grok emits BOTH a
  per-step `usage` (`cumulative:false`) and a final `end` (`cumulative:true`)
  total (fake fixture `src/headless-run.test.ts:1794-1813`) — the accumulator
  must not double-count these.

## Load-Bearing Assumptions

- VERIFIED — `fetchModelMeta`'s gateway `rates` are model-aggregate, not
  per-endpoint. Evidence: `src/pricing.test.ts` pinned-vs-unpinned `rates` are
  equal (~line 78-102); `fetchGatewayMeta` reads `match.pricing.input/output`
  from `/models` (`src/pricing.ts:237-247`).
- VERIFIED — `/models/{model}/endpoints` is fetched with the pin filter via
  `gatewaySlugMatches`. Evidence: `src/pricing.ts:266-281`, `withV1`
  (`src/providers.ts:155`), `gatewaySlugMatches` (`src/providers.ts:362`).
- VERIFIED — grok double-emits per-step + cumulative usage; the accumulator rule
  "cumulative:true total wins; else sum deltas" avoids double-counting.
  Evidence: fake fixture `src/headless-run.test.ts:1794-1813`, normalizer
  `src/headless-run.ts:484-491`.
- VERIFIED — headless spawns without fetching rates (`statusline:false`).
  Evidence: `src/headless-run.ts:112`, `src/harnesses.ts:84,93-106`.
- UNVERIFIED (external API shape) — whether the gateway publishes cache rates
  (`input_cache_read` / `cachedInputTokens` etc.) *per endpoint*, and the exact
  semantics of `prompt_tiers`/`completion_tiers` (context-bracket vs marginal).
  Cannot be probed from this repo (no live gateway key). DEFENSIVE DESIGN (AC-4):
  (a) if an endpoint publishes no cache rate, bill cache read/write at the
  **regular input rate** — documented in code; the alternative (zero) is rejected
  because a provider that gives no cache discount bills cache tokens as ordinary
  input, so input-rate is the non-fabricating default. (b) Tiers are treated as
  **context brackets**: pick the single tier whose `[min, max]` contains the
  relevant token count (input tokens for prompt tiers, output for completion),
  charging all of that bucket at the matched tier's rate; fall back to the base
  `prompt`/`completion` rate, then the first tier. Both choices are covered by
  synthetic-fixture unit tests, so a wrong guess is a localized, testable fix.

## File Map

- `src/pricing.ts` — edit: extend `gatewayEndpointsSchema` with cache fields;
  add `NormalizedUsage`, `HeadlessRateCard`, `fetchHeadlessRateCard`,
  `endpointRates`, `gatewayCostUsd`, `headlessCost`.
- `src/pricing.test.ts` — edit: unit tests for the new functions.
- `src/headless-run.ts` — edit: bump `PROTOCOL_VERSION` to `2`; accumulate
  normalized usage; per-event usage carries `harnessCostUsd` (not `costUsd`);
  fetch the rate card in `runHeadless`; emit a final summary `usage` event with
  computed `costUsd` + `costSource` + `harnessCostUsd`.
- `src/headless-run.test.ts` — edit: bump `v:1`→`v:2` expectations; assert the
  new summary event + `harnessCostUsd` separation.
- `DESIGN.md` — edit: document the headless computed-cost contract.
- `README.md` — edit: document the new event fields in "Headless runs".

## Tasks

### Task 1 — Pricing: rate-card fetch + cost computation

Add pure + fetch functions to `src/pricing.ts`, TDD against `src/pricing.test.ts`
(the file already spins a local `createServer` returning `/v1/models` and
`/v1/models/{model}/endpoints` — copy that harness).

1. Write failing tests in `src/pricing.test.ts`:
   - `fetchHeadlessRateCard`: ollama provider → `{ kind: 'free' }` (no network);
     gateway + `gatewayProvider: 'nebius'` → `{ kind: 'endpoint', pricing }`
     carrying that endpoint's prompt/completion (assert via a follow-up
     `headlessCost`); gateway unpinned → `{ kind: 'rates', rates }` (aggregate);
     unknown model → `{ kind: 'unavailable' }`.
   - `gatewayCostUsd`: nebius-style rates `{ inputPerMillion: 1.4,
     outputPerMillion: 4.4 }` with `{ input: 200_000, output: 50_000,
     cacheRead: 0, cacheWrite: 0 }` → `0.2 + 0.22 = 0.42` (assert `≈` to avoid
     float noise). Cache fallback: `cacheRead: 100_000` with no cache rate →
     billed at input rate (`+0.14`); with `cacheReadPerMillion: 0.14` → uses it.
   - `endpointRates` tier selection: `prompt_tiers` `[{cost, min:0, max:200001},
     {cost:high, min:200001}]` → small input picks tier 0, large input picks
     tier 1; base used when no tiers; `undefined` when no base and no tiers.
   - `headlessCost`: `'free'`→`{costSource:'free', costUsd:0}`;
     `'unavailable'`→`{costSource:'unavailable', costUsd:undefined}`;
     `'rates'`/`'endpoint'`→`{costSource:'gateway-rates', costUsd:<n>}`.
2. Implement in `src/pricing.ts`:
   - Extend the endpoint `pricing` looseObject in `gatewayEndpointsSchema`
     (line 72) with optional `cacheCreationInputTokens`, `cachedInputTokens`,
     `input_cache_read`, `input_cache_write` (all `priceField`).
   - `export interface NormalizedUsage { cacheRead: number; cacheWrite: number;
     input: number; output: number }`.
   - `export type HeadlessRateCard = { kind: 'free' } | { kind: 'endpoint';
     pricing: <parsed endpoint pricing type> } | { kind: 'rates'; rates:
     ModelRates } | { kind: 'unavailable' }`.
   - `fetchHeadlessRateCard({ gatewayProvider, modelId, provider })`: ollama →
     `free`; resolve `apiKey` exactly as `fetchModelMeta` (lines 100-103); in a
     `try`, when `provider.type` is `'vercel-gateway'`/`'openrouter'` AND
     `gatewayProvider != null`, fetch endpoints (reuse the fetch+filter of
     `fetchGatewayRateLabel`, lines 266-282) and return `{ kind: 'endpoint',
     pricing }` for the first matching endpoint; otherwise fall back to
     `fetchModelMeta(...)` — `rates` free → `free`, paid → `{ kind:'rates' }`,
     absent → `unavailable`; `catch` → `unavailable`.
   - `endpointRates(pricing, usage)`: `input = tierRate(pricing.prompt,
     pricing.prompt_tiers, usage.input)`, `output = tierRate(pricing.completion,
     pricing.completion_tiers, usage.output)`; return `undefined` if either is
     `null`; cache rates via `perTokenToPerMillion` of
     `cachedInputTokens ?? input_cache_read` and
     `cacheCreationInputTokens ?? input_cache_write` (mirrors lines 242-247).
     Private `tierRate(base, tiers, count)`: if tiers present, pick first tier
     with `count >= (min ?? 0) && (max == null || count <= max)`, else base,
     else `tiers[0].cost`; run through `perTokenToPerMillion` (line 394).
   - `gatewayCostUsd(rates, usage)`: like `sessionCostUsd` (lines 189-194) but
     numeric and with the AC-4 fallback — `const cacheReadRate =
     rates.cacheReadPerMillion ?? rates.inputPerMillion` (same for write),
     with a comment stating cache tokens bill at the input rate when the
     endpoint publishes no cache rate.
   - `headlessCost(card, usage)`: the switch described in the tests; reuse
     `ratesAreFree` (line 383) to map all-zero paid rates to `costSource:'free'`.
3. Run `bun test src/pricing.test.ts` → green.
4. `bun run lint && bun run typecheck`.
5. Commit: `feat(pricing): headless gateway rate card + cost computation`.

### Task 2 — Headless: accumulate usage, emit computed cost

Depends on Task 1. Edit `src/headless-run.ts` + `src/headless-run.test.ts`.

1. Update failing tests first in `src/headless-run.test.ts`:
   - Bump every `v: 1` expectation to `v: 2` (mechanical; `PROTOCOL_VERSION`
     changes). The existing per-event `usage` assertions (e.g. lines 88-96)
     stay, but any that expected `costUsd` from a harness must expect
     `harnessCostUsd` instead.
   - Add: with the fake codex on `ollama`, assert a final summary event
     `toContainEqual({ cacheReadTokens:4, cacheWriteTokens:0, cumulative:true,
     inputTokens:10, outputTokens:2, costUsd:0, costSource:'free', type:'usage',
     v:2 })`.
   - Add (AC-2): the fake claude on `ollama` (result carries
     `total_cost_usd:0.25`, usage 9/4/3/2 at `src/headless-run.test.ts:1721`)
     → final summary has `costSource:'free'`, `costUsd:0`, and
     `harnessCostUsd:0.25` (proves harness cost preserved, never preferred).
   - Add (accumulator): the fake grok on `ollama` → final summary uses the
     `end` cumulative totals `input:20, output:8, cacheReadTokens:4,
     cacheWriteTokens:6`, `harnessCostUsd:0.12` — NOT the summed deltas.
2. Implement in `src/headless-run.ts`:
   - `const PROTOCOL_VERSION = 2` (line 22).
   - Rename the per-event field: in `emitUsage` (lines 227-235) emit
     `harnessCostUsd` in place of `costUsd`, and change the param name to
     `harnessCostUsd`. Update every call site's key accordingly (grok/claude/
     codex/opencode/pi normalizers).
   - Add an accumulator to `NormalizerState` (line 47): `usage: {
     cumulative: NormalizedUsage | undefined; cumulativeHarnessCostUsd: number |
     undefined; delta: NormalizedUsage; deltaHarnessCostUsd: number | undefined
     }` initialized to zeroed `delta`, `undefined` cumulative (init at line 321).
   - Replace the raw `emitUsage(...)` calls in the normalizers with
     `state = recordUsage(state, {...})` where a new `recordUsage(state, usage)`
     both calls `emitUsage` and folds via a pure `foldUsage(acc, usage)`:
     `cumulative:true` → set `acc.cumulative`/`acc.cumulativeHarnessCostUsd`;
     else add tokens into `acc.delta` and add cost into
     `acc.deltaHarnessCostUsd`. (`emitGrokUsage` must thread and return state
     too.)
   - In `runHeadless` (after `provider`/`def` resolve, ~line 97) fetch
     `const rateCard = await fetchHeadlessRateCard({ gatewayProvider:
     resolved.gatewayProvider, modelId: resolved.model, provider })` and pass it
     into `executeHeadlessPlan` → `executePreparedHeadlessPlan` via their option
     objects (add `rateCard: HeadlessRateCard`).
   - In `executePreparedHeadlessPlan`, after the read loop + grok flush and
     before the normal `emit({ exitCode, ... 'run.completed' })` (line 368),
     compute `const usage = state.usage.cumulative ?? state.usage.delta` and
     `const harnessCostUsd = state.usage.cumulative ?
     state.usage.cumulativeHarnessCostUsd : state.usage.deltaHarnessCostUsd`,
     then `const { costSource, costUsd } = headlessCost(options.rateCard,
     usage)` and emit ONE summary event:
     `emit({ cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
     cumulative: true, inputTokens: usage.input, outputTokens: usage.output,
     ...(costUsd === undefined ? {} : { costUsd }), costSource,
     ...(harnessCostUsd === undefined ? {} : { harnessCostUsd }),
     type: 'usage' })`. Emit it only on the normal completion path (not the
     spawn-error early return at line 342-347). Leave `run.completed` unchanged.
3. Run `bun test src/headless-run.test.ts` → green.
4. `bun run lint && bun run typecheck`.
5. Commit: `feat(eh run): emit gateway-rate costUsd on headless usage events`.

### Task 3 — Docs

Depends on Tasks 1-2. No test.

1. `README.md` "Headless runs" (lines 151-167): note that the final `usage`
   event carries `costUsd` (eh-computed from gateway rates), `costSource`
   (`gateway-rates` | `free` | `unavailable`), and `harnessCostUsd` (the
   harness's own estimate, preserved, never preferred); and that the stream is
   now `v: 2`.
2. `DESIGN.md` "Headless execution" (~lines 96-108): one paragraph — eh computes
   cost from its own cumulative normalized usage × resolved gateway rates
   (per-endpoint when `--gateway-provider` is pinned, honoring tiers), documents
   the missing-cache-rate = input-rate fallback, and never fabricates a cost when
   rates are unavailable.
3. `bun run lint`.
4. Commit: `docs: headless computed-cost contract (AI-3129)`.

## Verification

Final commands (run from repo root, all must pass):

```bash
bun test
bun run lint
bun run typecheck
```

Manual contract check (uses the free ollama path, no key/network needed):

```bash
printf 'hi' | bun run src/main.ts run codex ollama qwen3-coder \
  | grep '"costSource"'
```

Expect a final `usage` line with `"costSource":"free"` and `"costUsd":0` and
`"v":2`.
