import type { Config } from './config.js'
import type { SessionInfo } from './sessions.js'
import type { EffortLevel, Protocol, Selection } from './types.js'

import {
  allProviders,
  canonicalProviderName,
  configExists,
  getProvider,
  loadConfig,
  providerLabel,
  pushRecent,
  reservedProfileNameMessage,
  saveConfig,
} from './config.js'
import { doctor } from './doctor.js'
import { buildLaunchPlan, getHarness, harnessNames } from './harnesses.js'
import { exec, printEnv } from './launch.js'
import { canServeAny } from './providers.js'
import { listSessionsForCwd } from './sessions.js'
import { home, selectionFromRecent } from './ui/home.js'
import { intro, log, outro } from './ui/output.js'
import {
  askProfileName,
  confirmLaunch,
  pickEffort,
  pickHarness,
  pickModel,
  pickProvider,
} from './ui/prompts.js'
import { providersScreen } from './ui/providers-screen.js'
import { pickSession } from './ui/sessions.js'
import { wizard } from './ui/wizard.js'

const isTTY = process.stdout.isTTY

export interface LaunchOptions {
  effort?: EffortLevel
  printEnvOnly: boolean
  resume?: boolean
  saveAs?: string
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
      selection = {
        ...selectionFromRecent(recent),
        effort: selection.effort ?? recent.effort,
        model: selection.model ?? (sameProvider ? recent.model : undefined),
        provider,
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
          await providersScreen(config)
          continue
        }
        if (choice.kind === 'recent') {
          selection = selectionFromRecent(choice.recent)
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
    harness,
    model,
    provider: provider.name,
  }

  const plan = await buildLaunchPlan(harness, provider, model, {
    effort: complete.effort,
    resume: options.resume,
    resumeSessionId,
  })

  if (options.printEnvOnly) {
    printEnv(plan)
    return
  }

  // Confirm only when the user picked interactively; fully-specified
  // positionals (and profiles) launch straight away.
  if (isTTY && needsPicking) {
    const action = await confirmLaunch(planSummary(complete, plan.env))
    if (action === 'back') return
    if (action === 'save') {
      const name = await askProfileName()
      config = { ...config, profiles: { ...config.profiles, [name]: complete } }
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
}

async function completeSelection(config: Config, partial: Partial<Selection>) {
  const harness = partial.harness ?? (await pickHarness())
  const def = getHarness(harness)
  if (!def) throw new Error(`unknown harness "${harness}"`)
  const provider = partial.provider
    ? mustGetProvider(config, partial.provider, def.protocols)
    : await pickProvider(def.protocols, allProviders(config))
  const model = partial.model ?? (await pickModel(provider))
  // Only ask when the user is picking interactively and hasn't chosen one.
  const effort =
    partial.effort ?? (harness === 'grok' ? 'auto' : await pickEffort())
  return { effort, harness, model, provider: provider.name }
}

function mustGetProvider(config: Config, name: string, protocols: Protocol[]) {
  const provider = getProvider(config, name)
  if (!provider) throw new Error(`unknown provider "${name}"`)
  if (!canServeAny(provider.type, protocols)) {
    throw new Error(
      `provider "${name}" cannot serve ${protocols.join(' or ')} (needs the eh router, phase 2)`,
    )
  }
  return provider
}

function planSummary(selection: Selection, env: Record<string, string>) {
  const lines = [
    `harness:  ${selection.harness}`,
    `provider: ${providerLabel(selection.provider)} (${selection.provider})`,
    `model:    ${selection.model}`,
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
  return {
    ...selection,
    effort: selection.effort ?? recent.effort,
    model:
      selection.model ??
      session.model ??
      (sameProvider ? recent.model : undefined),
    provider,
  }
}
