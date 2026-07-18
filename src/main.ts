import { Command } from 'commander'

import pkg from '../package.json' with { type: 'json' }
import { freshModels, writeModels } from './cache.js'
import { getProvider, loadConfig, saveConfig } from './config.js'
import { doctor } from './doctor.js'
import { launchFlow } from './flow.js'
import {
  modelsList,
  profileList,
  profileRemove,
  profileSave,
  providerKeyDelete,
  providerKeySet,
  providersCommand,
} from './manage.js'
import { listModels } from './providers.js'
import { intro } from './ui/output.js'
import { addProvider, wizard } from './ui/wizard.js'

const program = new Command()

program
  .name('eh')
  .description('exquisite harness — pick a harness, pick a provider, go')
  .version(pkg.version)

program
  .argument('[harness-or-profile]', 'harness name or saved profile')
  .argument('[provider]', 'provider name')
  .argument('[model]', 'model id')
  .option('--print-env', 'print env vars instead of launching')
  .action(
    async (
      harnessOrProfile: string | undefined,
      provider: string | undefined,
      model: string | undefined,
      opts: { printEnv?: boolean },
    ) => {
      await launchFlow(harnessOrProfile, provider, model, {
        printEnvOnly: opts.printEnv === true,
      })
    },
  )

program
  .command('doctor')
  .description('check harnesses, providers, and keys')
  .action(async () => {
    intro('eh · doctor')
    await doctor(loadConfig())
  })

program
  .command('providers')
  .description('list configured providers with status')
  .action(async () => {
    await providersCommand(loadConfig())
  })

program
  .command('models <provider>')
  .description('list models available from a provider')
  .action(async (providerName: string) => {
    const provider = getProvider(loadConfig(), providerName)
    if (!provider) throw new Error(`unknown provider "${providerName}"`)
    const cached = freshModels(providerName)
    if (cached) {
      modelsList(cached)
      return
    }
    const models = await listModels(provider)
    writeModels(providerName, models)
    modelsList(models)
  })

const providerCmd = program.command('provider').description('manage providers')
providerCmd
  .command('add')
  .description('add a provider interactively')
  .action(async () => {
    intro('eh · add provider')
    saveConfig(await addProvider(loadConfig()))
  })
providerCmd
  .command('key <name>')
  .description('store a provider API key (Keychain or 0600 secrets file)')
  .option('--delete', 'delete the stored key instead')
  .action(async (name: string, opts: { delete?: boolean }) => {
    const config = loadConfig()
    if (opts.delete) {
      await providerKeyDelete(config, name)
      return
    }
    if (!process.stdout.isTTY) {
      throw new Error('storing a key needs an interactive terminal')
    }
    await providerKeySet(config, name)
  })

const profileCmd = program.command('profile').description('manage profiles')
profileCmd
  .command('save <name>')
  .description('save the most recent combo as a profile')
  .action((name: string) => {
    const config = loadConfig()
    if (config.recent.length === 0) throw new Error('no recent launch to save')
    const last = config.recent[0]
    profileSave(config, name, {
      harness: last.harness,
      model: last.model,
      provider: last.provider,
    })
  })
profileCmd
  .command('list')
  .description('list profiles')
  .action(() => {
    profileList(loadConfig())
  })
profileCmd
  .command('rm <name>')
  .description('remove a profile')
  .action((name: string) => {
    profileRemove(loadConfig(), name)
  })

program
  .command('setup')
  .description('re-run the first-run wizard')
  .action(async () => {
    intro('eh · setup')
    saveConfig(await wizard(loadConfig()))
  })

async function main() {
  await program.parseAsync(process.argv)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `eh: ${error.message}` : error)
  process.exitCode = 1
})
