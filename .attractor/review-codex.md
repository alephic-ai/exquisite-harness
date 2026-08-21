## Repair Verification

Verified only the prior fixes listed in `.attractor/review-fixes.md`; no fresh
full review was run.

- Resolved: pinned gateway runs no longer fall back to aggregate model rates
  when endpoint pricing is unresolved. `fetchHeadlessRateCard` now returns
  `{ kind: 'unavailable' }` immediately after an unresolved pinned
  `fetchEndpointPricing` lookup.
- Resolved: prompt-tier selection includes cache tokens. `endpointRates` now
  keys the prompt tier on `usage.input + usage.cacheRead + usage.cacheWrite`,
  with a regression test crossing a tier boundary via cache reads.
- Resolved: duplicate API-key resolution on the unpinned path was removed.
  `resolveApiKey` now runs only inside the pinned endpoint-pricing branch, while
  the unpinned path lets `fetchModelMeta` resolve its own key.

Focused verification passed:

`pnpm test src/pricing.test.ts src/headless-run.test.ts` -> 45 pass, 0 fail.

No critical regression causing data loss, a security vulnerability, or a
production crash was identified during this scoped repair verification.
