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
  harness: string
  model: string
  provider: string
}
