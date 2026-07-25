import type { Config } from './config.js'
import type { SessionInfo } from './sessions.js'
import type { Selection } from './types.js'

import { canonicalProviderName } from './config.js'

// Explicit fields win. Otherwise prefer proof that the target/provider served
// the session model, then that provider's latest target-harness recent.
export function resolveResumeWiring(args: {
  config: Config
  selection: Partial<Selection>
  session: SessionInfo
}) {
  const { config, selection, session } = args
  const launchHarness = selection.harness ?? session.harness
  const pool = config.recent.filter((r) => r.harness === launchHarness)
  const cwdFirst = [
    ...pool.filter((r) => r.cwd === process.cwd()),
    ...pool.filter((r) => r.cwd !== process.cwd()),
  ]
  const isHandoff = launchHarness !== session.harness
  const selectedProvider = selection.provider
    ? canonicalProviderName(selection.provider)
    : undefined
  const wantedModel = selection.model ?? session.model
  const modelMatch =
    wantedModel === undefined
      ? undefined
      : cwdFirst.find(
          (r) =>
            r.model === wantedModel &&
            (!isHandoff ||
              selectedProvider === undefined ||
              canonicalProviderName(r.provider) === selectedProvider),
        )
  const providerMatch =
    isHandoff && selectedProvider !== undefined
      ? cwdFirst.find(
          (r) => canonicalProviderName(r.provider) === selectedProvider,
        )
      : undefined
  const recent = modelMatch ?? providerMatch ?? cwdFirst.at(0)
  // A source model is foreign to the target harness unless a matching recent
  // proves the chosen target provider has actually served it.
  const foreignModel = isHandoff && modelMatch === undefined
  if (!recent) {
    return {
      ...selection,
      model: selection.model ?? (foreignModel ? undefined : session.model),
    }
  }
  const provider = selection.provider ?? canonicalProviderName(recent.provider)
  const sameProvider =
    canonicalProviderName(provider) === canonicalProviderName(recent.provider)
  return {
    ...selection,
    effort: selection.effort ?? recent.effort,
    model:
      selection.model ??
      (foreignModel ? undefined : session.model) ??
      (sameProvider ? recent.model : undefined),
    provider,
  }
}
