import type { ResolvedProvider } from './config.js'

import { openAIBaseURLFor } from './providers.js'

// opencode takes a full custom-provider definition as inline JSON in
// OPENCODE_CONFIG_CONTENT, which merges over the user's own config — eh writes
// nothing to disk. apiKey uses {env:VAR} indirection, so no key material ever
// appears in the payload (print-env safe). No `limit` on the model: opencode
// requires context AND output together, the output limit isn't knowable from
// eh's model meta, and a context-only entry is rejected outright (verified).
export function opencodeConfigContent(
  provider: ResolvedProvider,
  model: string,
) {
  return JSON.stringify({
    provider: {
      [opencodeProviderId(provider)]: {
        models: { [model]: { name: model } },
        name: `eh · ${provider.name}`,
        npm: '@ai-sdk/openai-compatible',
        options: {
          // Keyless providers (ollama) still need a placeholder — the AI SDK
          // errors when no apiKey resolves; the value is ignored upstream.
          apiKey: provider.envKey ? `{env:${provider.envKey}}` : 'eh',
          baseURL: openAIBaseURLFor(provider),
        },
      },
    },
  })
}

// The id the config registers the provider under; `-m` addresses models as
// <id>/<model>.
export function opencodeProviderId(provider: ResolvedProvider) {
  return `eh-${provider.name}`
}
