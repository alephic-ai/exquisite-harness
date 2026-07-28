import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import type { ResolvedProvider } from './config.js'

import { opencodeConfigContent } from './opencode.js'

const ollama: ResolvedProvider = {
  baseURL: 'http://localhost:11434',
  name: 'ollama',
  type: 'ollama',
}

const openrouter: ResolvedProvider = {
  baseURL: 'https://openrouter.ai/api/v1',
  envKey: 'OPENROUTER_API_KEY',
  name: 'openrouter',
  type: 'openai-chat',
}

// The contract opencode (and these tests) rely on. Strict: an unexpected key
// (e.g. a context-only `limit`, which opencode rejects) fails the parse.
const configSchema = z.object({
  provider: z.record(
    z.string(),
    z.object({
      models: z.record(z.string(), z.object({ name: z.string() }).strict()),
      name: z.string(),
      npm: z.string(),
      options: z.object({ apiKey: z.string(), baseURL: z.string() }),
    }),
  ),
})

function buildConfig(provider: ResolvedProvider, model: string) {
  return configSchema.parse(JSON.parse(opencodeConfigContent(provider, model)))
}

describe('opencodeConfigContent', () => {
  // The payload rides in OPENCODE_CONFIG_CONTENT (env) and shows up in
  // --print-env, so it must reference keys by env var — never carry one.
  test('references the key by env var, never a literal value', () => {
    const config = buildConfig(openrouter, 'anthropic/claude-fable-5')
    const entry = config.provider['eh-openrouter']
    expect(entry.npm).toBe('@ai-sdk/openai-compatible')
    expect(entry.options.apiKey).toBe('{env:OPENROUTER_API_KEY}')
    expect(entry.options.baseURL).toBe('https://openrouter.ai/api/v1')
    expect(entry.models['anthropic/claude-fable-5'].name).toBe(
      'anthropic/claude-fable-5',
    )
  })

  test('keyless providers get a placeholder key', () => {
    const config = buildConfig(ollama, 'qwen3.5:latest')
    expect(config.provider['eh-ollama'].options.apiKey).toBe('eh')
  })
})
