export interface LaunchPlan {
  args: string[]
  bin: string
  env: Record<string, string>
  notes: string[]
}

export interface ModelInfo {
  hint?: string
  id: string
}

export type Protocol = 'anthropic' | 'openai-chat' | 'openai-responses'

export interface ProviderStatus {
  detail: string
  ok: boolean
}

export type ProviderType = 'ollama' | 'openai-chat' | 'vercel-gateway'

export interface Selection {
  effort?: string
  harness: string
  model: string
  provider: string
}

// Reasoning/effort levels, normalized across harnesses. `auto` means the
// model default (no override sent). claude accepts xhigh/max; codex maps
// max→high; grok has no knob.
export const EFFORT_LEVELS = [
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
