export interface LaunchPlan {
  args: string[]
  bin: string
  // The plan owner must release launch-time artifacts on every post-build
  // exit, including cancellation and pre-launch failures.
  cleanup?: () => Promise<void>
  env: Record<string, string>
  gatewayCostCapture?: {
    resumed: boolean
  }
  // Gateway routing is either a pinned upstream, or automatic routing
  // (`provider` unset) optionally restricted to ZDR providers (zdr true).
  gatewayRouting?: {
    apiKeyEnvKey?: string
    // Which request-body shape the routing proxy injects. Omitted = vercel.
    kind?: 'openrouter' | 'vercel'
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
  // Provider-reported effort values. Omitted when the model does not expose
  // effort selection.
  efforts?: ModelEffortLevel[]
  hint?: string
  id: string
  // Throughput label (tokens/sec) shown on the model picker row.
  throughputLabel?: string
}

export type Protocol = 'anthropic' | 'openai-chat' | 'openai-responses'

export const PROVIDER_TYPES = [
  'ollama',
  'openai-chat',
  'openrouter',
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

// Global approval behavior is resolved at launch time, so profiles and
// recents remain portable when the default changes.
export const APPROVAL_MODES = ['platform', 'auto'] as const
export type ApprovalMode = (typeof APPROVAL_MODES)[number]

export interface Selection {
  effort?: EffortLevel
  // Pinned upstream provider slug (undefined = automatic routing).
  gatewayProvider?: string
  harness: string
  model: string
  provider: string
  searchProvider?: string
  // Restrict automatic routing to ZDR providers.
  gatewayZdr?: boolean
}

// Provider-reported effort values. Harnesses intersect these with what their
// CLIs accept before showing the picker. OpenRouter's documented set is
// none/minimal/low/medium/high/xhigh/max; `null` supported_efforts means all
// of them.
export const MODEL_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ModelEffortLevel = (typeof MODEL_EFFORT_LEVELS)[number]

// `auto` means the model default: no override is sent.
export const EFFORT_LEVELS = ['auto', ...MODEL_EFFORT_LEVELS] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
