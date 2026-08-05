export interface LaunchPlan {
  args: string[]
  bin: string
  env: Record<string, string>
  gatewayCostCapture?: {
    resumed: boolean
  }
  gatewayRouting?: {
    apiKeyEnvKey?: string
    model: string
    provider: string
    targetBaseURL: string
  }
  notes: string[]
  searchProxy?: SearchProxy
}

export interface ModelInfo {
  hint?: string
  id: string
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
  gatewayProvider?: string
  harness: string
  model: string
  provider: string
  searchProvider?: string
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
