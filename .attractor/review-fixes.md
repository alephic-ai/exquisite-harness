## Fix: Pinned gateway run falls back to aggregate model rates when endpoint pricing is unresolved
- **Reviewer:** Codex
- **File:** src/pricing.ts
- **Line:** 177-192
- **Current:** `if (pricing) return { kind: 'endpoint', pricing }` then unconditional `const meta = await fetchModelMeta(...)`
- **Fix:** When `gatewayProvider != null` and endpoint pricing fails to resolve, return `{ kind: 'unavailable' }` instead of falling through to `fetchModelMeta`; only fetch model-aggregate rates when no gateway provider is pinned, so a pinned run never emits the wrong (aggregate) provider's cost reported as authoritative `gateway-rates`.

## Fix: Prompt-tier bracket excludes cache tokens, under-billing cached long-context runs
- **Reviewer:** guillaumeify
- **File:** src/pricing.ts
- **Line:** 337-341
- **Current:** `tierRate(pricing.prompt, pricing.prompt_tiers, usage.input)`
- **Fix:** Key the prompt-tier lookup on `usage.input + usage.cacheRead + usage.cacheWrite` (completion tier stays on `usage.output`) so the "context bracket" matches eh's own `contextUsedPercentage` context definition; otherwise a heavily-cached long-context run drops into a cheaper bracket and under-bills — the exact accuracy failure this ticket exists to fix. Add a tier test with non-zero cache tokens crossing a bracket boundary.

## Fix: Duplicate API-key resolution on the unpinned headless path
- **Reviewer:** guillaumeify
- **File:** src/pricing.ts
- **Line:** 172-189
- **Current:** `resolveApiKey(...)` resolved at function top, then the unpinned path calls `fetchModelMeta` which resolves the key again
- **Fix:** Move the `resolveApiKey`/`apiKey` resolution inside the pinned `fetchEndpointPricing` branch so the unpinned path lets `fetchModelMeta` own its resolution, dropping a redundant keychain subprocess + secrets-file read on every unpinned run (dead work once the Codex fix returns early on the pinned branch).
