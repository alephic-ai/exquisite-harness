import type { Config } from './config.js'
import type { HarnessDef } from './harnesses.js'
import type { SessionInfo } from './sessions.js'
import type { EffortLevel, Selection } from './types.js'

import { approvalModeLabel } from './approval-mode.js'
import { withCleanup } from './cleanup.js'
import {
  allProviders,
  allSearchProviders,
  canonicalProviderName,
  configExists,
  getProvider,
  loadConfig,
  providerLabel,
  pushRecent,
  reservedProfileNameMessage,
  saveConfig,
  searchProviderForSelection,
  searchProviderLabel,
} from './config.js'
import { doctor } from './doctor.js'
import {
  assertEffortAllowed,
  buildLaunchPlan,
  getHarness,
  harnessNames,
  resolveAvailableEfforts,
} from './harnesses.js'
import { exec, printEnv } from './launch.js'
import { canServeAny, isRoutingProvider } from './providers.js'
import { resolveSearchBackend } from './search-provider.js'
import { listSessionsForCwd } from './sessions.js'
import { defaultsScreen } from './ui/defaults-screen.js'
import { home, selectionFromRecent } from './ui/home.js'
import { intro, log, outro } from './ui/output.js'
import {
  askProfileName,
  confirmLaunch,
  pickEffort,
  pickGatewayProvider,
  pickHarness,
  pickModel,
  pickProvider,
  pickSearchProvider,
} from './ui/prompts.js'
import { providersScreen } from './ui/providers-screen.js'
import { pickSession } from './ui/sessions.js'
import { wizard } from './ui/wizard.js'

const isTTY = process.stdout.isTTY

export interface LaunchOptions {
  effort?: EffortLevel
  gatewayProvider?: string
  printEnvOnly: boolean
  resume?: boolean
  saveAs?: string
  searchProvider?: string
}

// Values that exist to be launched, not to be read off a screen.
const SECRET_ENV = /(^|_)(KEY|TOKEN|SECRET)$/

// `eh [harness-or-profile] [provider] [model]`
export async function launchFlow(
  harnessArg: string | undefined,
  providerArg: string | undefined,
  modelArg: string | undefined,
  options: LaunchOptions,
) {
  let config = loadConfig()

  // First positional can name a saved profile instead of a harness. Copy it —
  // merging overrides below must not mutate (and eventually persist) the
  // stored profile. Extra positionals override the profile for this launch,
  // same as the effort flag.
  const profile = harnessArg ? config.profiles[harnessArg] : undefined
  let selection: Partial<Selection> = profile
    ? {
        ...profile,
        gatewayProvider:
          (providerArg === undefined ||
            canonicalProviderName(providerArg) ===
              canonicalProviderName(profile.provider)) &&
          (modelArg === undefined || modelArg === profile.model)
            ? profile.gatewayProvider
            : undefined,
        model: modelArg ?? profile.model,
        provider: providerArg ?? profile.provider,
      }
    : {
        harness: harnessArg,
        model: modelArg,
        provider: providerArg,
      }
  // Effort: explicit flag wins, then a saved profile's, else interactive/default.
  // Applied before resume resolution so a recent's effort never masks -e.
  if (options.effort) selection.effort = options.effort
  if (options.searchProvider !== undefined) {
    selection.searchProvider = options.searchProvider
  }
  if (options.gatewayProvider !== undefined) {
    selection.gatewayProvider = options.gatewayProvider
    // An explicit pin replaces any ZDR-only routing from a recent.
    selection.gatewayZdr = undefined
  }

  // Before any session-store scanning: `eh -r bogus` should error, not scan.
  if (
    selection.harness !== undefined &&
    getHarness(selection.harness) === undefined
  ) {
    throw new Error(
      `unknown harness or profile "${selection.harness}" (known: ${harnessNames().join(', ')})`,
    )
  }

  let didIntro = false
  let resumeSessionId: string | undefined
  if (options.resume && options.printEnvOnly) {
    // --print-env keeps the scripted behavior: seed the selection from the
    // combo last launched in this directory (harness session stores are
    // cwd-scoped), falling back to the global most recent, and print bare
    // resume args — no picker. Explicit fields win; unspecified ones
    // inherit. Inherit only from a same-harness recent — a foreign harness's
    // provider may not serve its protocol — and inherit the model only when
    // the provider stays, since model ids are provider-scoped.
    const recent =
      config.recent.find((r) => r.cwd === process.cwd()) ?? config.recent.at(0)
    if (!recent) {
      if (selection.harness === undefined) {
        throw new Error('no recent launch to resume')
      }
    } else if (
      selection.harness === undefined ||
      selection.harness === recent.harness
    ) {
      const provider = selection.provider ?? recent.provider
      // Aliases (e.g. "gateway") resolve everywhere else in eh — canonicalize
      // here too, or the model is dropped for the same provider under
      // another name.
      const sameProvider =
        canonicalProviderName(provider) ===
        canonicalProviderName(recent.provider)
      const searchProvider = selection.searchProvider ?? recent.searchProvider
      const model = selection.model ?? (sameProvider ? recent.model : undefined)
      selection = {
        ...selectionFromRecent(config, recent),
        effort: selection.effort ?? recent.effort,
        gatewayProvider:
          selection.gatewayProvider ??
          (sameProvider && model === recent.model
            ? recent.gatewayProvider
            : undefined),
        gatewayZdr:
          selection.gatewayZdr ??
          (options.gatewayProvider === undefined &&
          sameProvider &&
          model === recent.model
            ? recent.gatewayZdr
            : undefined),
        model,
        provider,
        ...(searchProvider === undefined ? {} : { searchProvider }),
      }
    }
  } else if (options.resume) {
    // Interactive resume: eh's own cross-harness picker over this directory's
    // sessions, then wiring resolved from recents (resolveResumeWiring).
    if (!isTTY) {
      throw new Error(
        'eh -r opens a session picker — needs an interactive terminal (use --print-env to script it)',
      )
    }
    intro('eh · resume')
    didIntro = true
    const sessions = await listSessionsForCwd(process.cwd(), {
      harness: selection.harness,
    })
    if (sessions.length === 0) {
      throw new Error(
        selection.harness
          ? `no ${selection.harness} sessions for this directory`
          : 'no sessions for this directory',
      )
    }
    const picked = await pickSession(sessions)
    resumeSessionId = picked.id
    selection = resolveResumeWiring({
      config,
      selection: { ...selection, harness: picked.harness },
      session: picked,
    })
  }

  const needsPicking =
    !selection.harness || !selection.provider || !selection.model

  if (needsPicking) {
    if (!isTTY) {
      throw new Error(
        'incomplete arguments and stdout is not a TTY — usage: eh <harness> <provider> <model>',
      )
    }
    if (!didIntro) intro('eh · exquisite harness')

    if (!configExists()) {
      config = await wizard(config)
      saveConfig(config)
    }

    // Resume never routes to home — the resume block above already resolved
    // the recent, and home's recent-picker would silently discard explicit
    // overrides (-p/-m).
    if (!harnessArg && !profile && !options.resume) {
      for (;;) {
        const choice = await home(config)
        if (choice.kind === 'doctor') {
          await doctor(config)
          continue
        }
        if (choice.kind === 'providers') {
          config = await providersScreen(config)
          continue
        }
        if (choice.kind === 'defaults') {
          config = await defaultsScreen(config)
          continue
        }
        if (choice.kind === 'recent') {
          selection = {
            ...selectionFromRecent(config, choice.recent),
            gatewayProvider:
              options.gatewayProvider ?? choice.recent.gatewayProvider,
            // An explicit pin replaces ZDR-only routing from a recent.
            gatewayZdr:
              options.gatewayProvider !== undefined
                ? undefined
                : choice.recent.gatewayZdr,
          }
        }
        break
      }
    }

    selection = await completeSelection(config, selection)
  }

  const { harness, model, provider: providerName } = selection
  if (!harness || !providerName || !model) {
    throw new Error('incomplete selection')
  }
  const provider = getProvider(config, providerName)
  if (!provider) throw new Error(`unknown provider "${providerName}"`)
  // Persist the canonical id so recents/profiles don't store legacy aliases.
  const complete: Selection = {
    effort: selection.effort,
    gatewayProvider: selection.gatewayProvider,
    gatewayZdr: selection.gatewayZdr,
    harness,
    model,
    provider: provider.name,
    searchProvider: searchProviderForSelection(config, selection),
  }

  const def = getHarness(harness)
  if (
    complete.effort &&
    complete.effort !== 'auto' &&
    def &&
    def.effort !== false
  ) {
    assertEffortAllowed(
      complete.effort,
      await resolveAvailableEfforts(def, provider, model),
    )
  }

  const searchProviderName = complete.searchProvider ?? 'native'
  if (searchProviderName !== 'native' && harness !== 'claude') {
    throw new Error(
      `search provider "${searchProviderName}" is only supported by Claude Code`,
    )
  }
  if (searchProviderName !== 'native' && options.printEnvOnly) {
    throw new Error(
      '--print-env cannot start the local search proxy — launch through eh instead',
    )
  }
  const searchBackend = await resolveSearchBackend(config, searchProviderName)

  const plan = await buildLaunchPlan(harness, provider, model, {
    approvalMode: config.defaultApprovalMode,
    effort: complete.effort,
    gatewayProvider: complete.gatewayProvider,
    gatewayZdr: complete.gatewayZdr,
    resume: options.resume,
    resumeSessionId,
    searchBackend,
  })

  await withCleanup(plan.cleanup, async () => {
    if (options.printEnvOnly) {
      if (plan.cleanup) {
        throw new Error(
          '--print-env cannot expose temporary launch artifacts — launch through eh instead',
        )
      }
      printEnv(plan)
      return
    }

    // Confirm only when the user picked interactively; fully-specified
    // positionals (and profiles) launch straight away.
    if (isTTY && needsPicking) {
      const action = await confirmLaunch(
        planSummary({
          approvalMode: config.defaultApprovalMode,
          env: plan.env,
          selection: complete,
        }),
      )
      if (action === 'back') return
      if (action === 'save') {
        const name = await askProfileName()
        config = {
          ...config,
          profiles: { ...config.profiles, [name]: complete },
        }
        log.success(`profile "${name}" saved`)
      }
    }

    // Explicit --save: persist the combo without any prompt.
    if (options.saveAs) {
      const taken = reservedProfileNameMessage(options.saveAs)
      if (taken) throw new Error(taken)
      config = {
        ...config,
        profiles: { ...config.profiles, [options.saveAs]: complete },
      }
      log.success(`profile "${options.saveAs}" saved`)
    }

    config = pushRecent(config, complete)
    saveConfig(config)

    const code = await exec(plan)
    if (isTTY) outro(`back in eh — ${plan.bin} exited ${String(code)}`)
    process.exitCode = code
  })
}

async function completeSelection(config: Config, partial: Partial<Selection>) {
  const harness = partial.harness ?? (await pickHarness())
  const def = getHarness(harness)
  if (!def) throw new Error(`unknown harness "${harness}"`)
  const provider = partial.provider
    ? mustGetProvider(config, partial.provider, def)
    : await pickProvider(def, allProviders(config))
  const model = partial.model ?? (await pickModel(provider))
  let gatewayProvider = partial.gatewayProvider
  let gatewayZdr = partial.gatewayZdr
  if (isRoutingProvider(provider.type) && gatewayProvider === undefined) {
    const route = await pickGatewayProvider(provider, model)
    gatewayProvider = route.provider
    gatewayZdr = route.zeroDataRetention
  }
  // Harnesses with effort: false (currently opencode) skip the question; an
  // explicit effort still reaches the harness plan. Models that report no
  // efforts keep the harness's own list (Ollama); an empty intersection
  // skips the picker and stays auto.
  const effort =
    partial.effort ??
    (def.effort === false
      ? 'auto'
      : await pickEffort(await resolveAvailableEfforts(def, provider, model)))
  return {
    effort,
    gatewayProvider,
    gatewayZdr,
    harness,
    model,
    provider: provider.name,
    searchProvider:
      partial.searchProvider ??
      (harness === 'claude'
        ? await pickSearchProvider(
            allSearchProviders(config),
            config.defaultSearchProvider,
          )
        : 'native'),
  }
}

function mustGetProvider(config: Config, name: string, def: HarnessDef) {
  const provider = getProvider(config, name)
  if (!provider) throw new Error(`unknown provider "${name}"`)
  if (!canServeAny(provider.type, def.protocols)) {
    throw new Error(
      `provider "${name}" cannot serve ${def.protocols.join(' or ')} (needs the eh router, phase 2)`,
    )
  }
  // Instance-level gate (pi: catalog/models.json membership) on top of the
  // protocol check.
  const compat = def.providerCompat?.(provider)
  if (compat && !compat.ok) {
    throw new Error(`provider "${name}" ${compat.hint}`)
  }
  return provider
}

function planSummary(options: {
  approvalMode: Config['defaultApprovalMode']
  env: Record<string, string>
  selection: Selection
}) {
  const { approvalMode, env, selection } = options
  const lines = [
    `harness:  ${selection.harness}`,
    `provider: ${providerLabel(selection.provider)} (${selection.provider})`,
    ...(selection.gatewayProvider
      ? [`gateway:  ${selection.gatewayProvider}`]
      : selection.gatewayZdr
        ? ['gateway:  ZDR only']
        : []),
    `model:    ${selection.model}`,
    `search:   ${searchProviderLabel(selection.searchProvider ?? 'native')}`,
    `approvals: ${approvalModeLabel(approvalMode)}`,
    '',
    ...Object.entries(env).map(
      ([k, v]) => `${k}=${SECRET_ENV.test(k) ? '•••' : v}`,
    ),
  ]
  return lines.join('\n')
}

// Wiring for a picked session. Explicit fields win; the rest comes from
// recents, preferring the combo that last ran this harness+model — a
// provider is only known to serve the models it actually launched — over the
// latest combo for the harness generally (cwd-matching first). No recent for
// the harness at all → incomplete selection; the pickers fill it.
function resolveResumeWiring(args: {
  config: Config
  selection: Partial<Selection>
  session: SessionInfo
}) {
  const { config, selection, session } = args
  const pool = config.recent.filter((r) => r.harness === session.harness)
  const cwdFirst = [
    ...pool.filter((r) => r.cwd === process.cwd()),
    ...pool.filter((r) => r.cwd !== process.cwd()),
  ]
  const wantedModel = selection.model ?? session.model
  const recent =
    (wantedModel === undefined
      ? undefined
      : cwdFirst.find((r) => r.model === wantedModel)) ?? cwdFirst.at(0)
  // No recent for the harness at all: keep the session's model so the
  // pickers only ask for a provider (they'd otherwise re-ask what we know).
  if (!recent) return { ...selection, model: selection.model ?? session.model }
  const provider = selection.provider ?? canonicalProviderName(recent.provider)
  // recent.model is only meaningful on its own provider — model ids are
  // provider-scoped. The session's own model always carries over: resuming
  // onto different wiring than the session started on is supported.
  const sameProvider =
    canonicalProviderName(provider) === canonicalProviderName(recent.provider)
  const searchProvider = selection.searchProvider ?? recent.searchProvider
  const model =
    selection.model ??
    session.model ??
    (sameProvider ? recent.model : undefined)
  return {
    ...selection,
    effort: selection.effort ?? recent.effort,
    gatewayProvider:
      selection.gatewayProvider ??
      (sameProvider && model === recent.model
        ? recent.gatewayProvider
        : undefined),
    gatewayZdr:
      selection.gatewayZdr ??
      (selection.gatewayProvider === undefined &&
      sameProvider &&
      model === recent.model
        ? recent.gatewayZdr
        : undefined),
    model,
    provider,
    ...(searchProvider === undefined ? {} : { searchProvider }),
  }
}
