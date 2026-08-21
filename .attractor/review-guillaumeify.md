## Verdict

**Mergeable**: YES **Blockers**: None **Suggestions**:

- src/pricing.ts:172-189 — `fetchHeadlessRateCard` resolves the API key itself
  and, on the unpinned path, calls `fetchModelMeta` which resolves the key
  again; the locally-resolved key is only needed by the pinned
  `fetchEndpointPricing`. Change: resolve the key only inside the pinned branch
  and let `fetchModelMeta` own its own key resolution.
- src/pricing.ts:337-346 — `endpointRates` selects the prompt tier from
  `usage.input` alone while AC1/DESIGN call tiers "context brackets" and the
  sibling `contextUsedPercentage` counts input+cache; a heavily-cached
  long-context run may pick a cheaper bracket and under-bill. Change: key the
  prompt-tier lookup on input+cacheRead+cacheWrite (confirm the endpoint's tier
  semantics first, since this is the delegated judgment call).

## Findings

- **Suggestion:** src/pricing.ts:172-189 — duplicate API-key resolution (and a
  redundant fetch on the unpinned fallback) on every headless run. Change:
  resolve the key only in the pinned branch; leave `fetchModelMeta` to resolve
  its own.
- **Suggestion:** src/pricing.ts:337-346 — prompt-tier bracket keyed on
  `usage.input` only, excluding cache tokens, contradicting the "context
  brackets" wording and the neighboring context formula. Change: include
  cacheRead/cacheWrite in the tier-selection count after confirming endpoint
  tier semantics.
