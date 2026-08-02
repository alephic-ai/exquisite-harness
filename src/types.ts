export interface LaunchPlan {
  args: string[]
  bin: string
  env: Record<string, string>
  gatewayCostCapture?: {
    resumed: boolean
  }
  notes: string[]
}

export interface ModelInfo {
  efforts?: ModelEffortLevel[]
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

export interface Selection {
  effort?: EffortLevel
  harness: string
  model: string
  provider: string
}

// Provider-reported effort values. Harnesses intersect these with what their
// CLIs accept before showing the picker.
export const MODEL_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const
export type ModelEffortLevel = (typeof MODEL_EFFORT_LEVELS)[number]

// `auto` means the model default: no override is sent.
export const EFFORT_LEVELS = ['auto', ...MODEL_EFFORT_LEVELS] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
