import type { Config } from './config.js'
import type { EffortLevel, Protocol, Selection } from './types.js'

import {
  allProviders,
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
  // `-r` with no harness/profile: pick up the combo last launched in this
  // directory (harness session stores are cwd-scoped), falling back to the
  // global most recent. No pickers — resume is the zero-prompt fast path.
  // Provider/model flags still override the recent, same as for profiles.
  if (options.resume && selection.harness === undefined) {
    const recent =
      config.recent.find((r) => r.cwd === process.cwd()) ?? config.recent.at(0)
    if (!recent) throw new Error('no recent launch to resume')
    selection = {
      ...selectionFromRecent(recent),
      model: selection.model ?? recent.model,
      provider: selection.provider ?? recent.provider,
    }
  }

  // Effort: explicit flag wins, then a saved profile's, else interactive/default.
  if (options.effort) selection.effort = options.effort

  if (
    selection.harness !== undefined &&
    getHarness(selection.harness) === undefined
  ) {
    throw new Error(
      `unknown harness or profile "${selection.harness}" (known: ${harnessNames().join(', ')})`,
    )
  }

  const needsPicking =
    !selection.harness || !selection.provider || !selection.model

  if (needsPicking) {
    if (!isTTY) {
      throw new Error(
        'incomplete arguments and stdout is not a TTY — usage: eh <harness> <provider> <model>',
      )
    }
    intro('eh · exquisite harness')

    if (!configExists()) {
      config = await wizard(config)
      saveConfig(config)
    }

    if (!harnessArg && !profile) {
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
