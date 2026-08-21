## Fix: Pinned gateway run falls back to aggregate model rates when endpoint pricing is unresolved
- **Reviewer:** Codex
- **File:** src/pricing.ts
- **Line:** 177-192
- **Current:** `if (pricing) return { kind: 'endpoint', pricing }` then unconditional `const meta = await fetchModelMeta(...)`
- **Fix:** When `gatewayProvider != null` and endpoint pricing fails to resolve, return `{ kind: 'unavailable' }` instead of falling through to `fetchModelMeta`; only fetch model-aggregate rates when no gateway provider is pinned, so a pinned run never emits the wrong (aggregate) provider's cost reported as authoritative `gateway-rates`.
