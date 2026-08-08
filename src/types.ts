export interface LaunchPlan {
  args: string[]
  bin: string
  // Optional teardown for launch-time temp artifacts (e.g. pi's gateway
  // routing extension). Runs after the child exits, alongside proxy shutdown.
  cleanup?: () => Promise<void>
  env: Record<string, string>
  gatewayCostCapture?: {
    resumed: boolean
  }
  // Gateway routing is either a pinned provider, or automatic Vercel routing
  // (`provider` unset) optionally restricted to ZDR providers (zdr true).
  gatewayRouting?: {
    apiKeyEnvKey?: string
    model: string
    provider?: string
    targetBaseURL: string
    zdr?: boolean
  }
  notes: string[]
  searchProxy?: SearchProxy
}

export interface ModelInfo {
  // Cost label ($ in/out per 1M) shown on the model picker row.
  costLabel?: string
  hint?: string
  id: string
  // Throughput label (tokens/sec) shown on the model picker row.
  throughputLabel?: string
}

export type Protocol = 'anthropic' | 'openai-chat' | 'openai-responses'

export const PROVIDER_TYPES = [
  'ollama',
  'openai-chat',
  'vercel-gateway',
] as const
export type ProviderType = (typeof PROVIDER_TYPES)[number]

export const SEARCH_PROVIDER_TYPES = ['firecrawl'] as const
export interface SearchBackend {
  apiKey: string
  baseURL: string
  envKey: string
  type: SearchProviderType
}

export type SearchProviderType = (typeof SEARCH_PROVIDER_TYPES)[number]

export interface SearchProxy extends SearchBackend {
  upstreamBaseURL: string
}

export interface Selection {
  effort?: EffortLevel
  // Pinned Gateway provider slug (undefined = automatic Vercel routing).
  gatewayProvider?: string
  harness: string
  model: string
  provider: string
  searchProvider?: string
  // Restrict automatic Gateway routing to ZDR providers.
  gatewayZdr?: boolean
}

// Reasoning/effort levels, normalized across harnesses. `auto` means the
// model default (no override sent). claude, grok, and pi accept xhigh/max;
// codex maps xhigh/max→high; opencode has no knob.
export const EFFORT_LEVELS = [
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
