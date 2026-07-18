import { Command } from 'commander'

import pkg from '../package.json' with { type: 'json' }
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
import { listModelsCached } from './providers.js'
import { EFFORT_LEVELS } from './types.js'
import { intro } from './ui/output.js'
import { addProvider, wizard } from './ui/wizard.js'
import { runUpdate } from './update.js'

const program = new Command()

program
  .name('eh')
  .description('exquisite harness — pick a harness, pick a provider, go')
  .version(pkg.version, '-v, --version')
  // -h belongs to --harness; help lives on the long flag only.
  .helpOption('--help', 'display help for command')

program
  .argument('[harness-or-profile]', 'harness name or saved profile')
  .argument('[provider]', 'provider name')
  .argument('[model]', 'model id')
  .option('-h, --harness <name>', 'harness: claude, codex, grok')
  .option('-p, --provider <name>', 'provider: ollama, openrouter, gateway, …')
  .option('-m, --model <id>', 'model id')
  .option('-s, --save <name>', 'save the combo as a profile, then launch')
  .option(
    '-e, --effort <level>',
    'reasoning effort: auto, low, medium, high, xhigh, max',
  )
  .option('--print-env', 'print env vars instead of launching')
  .action(
    async (
      harnessOrProfile: string | undefined,
      provider: string | undefined,
      model: string | undefined,
      opts: {
        effort?: string
        harness?: string
        model?: string
        printEnv?: boolean
        provider?: string
        save?: string
      },
    ) => {
      // Flags win over positionals; positionals may also name a profile.
      const effort = EFFORT_LEVELS.find((level) => level === opts.effort)
      if (opts.effort !== undefined && effort === undefined) {
        throw new Error(
          `unknown effort "${opts.effort}" (known: ${EFFORT_LEVELS.join(', ')})`,
        )
      }
      await launchFlow(
        opts.harness ?? harnessOrProfile,
        opts.provider ?? provider,
        opts.model ?? model,
        {
          effort,
          printEnvOnly: opts.printEnv === true,
          saveAs: opts.save,
        },
      )
    },
  )
  .addHelpText(
    'after',
    `
Common workflows:
  eh                                  interactive: recents, or harness → provider → model
  eh claude ollama qwen3-coder        launch with zero prompts (positional)
  eh -h codex -p ollama -m qwen3-coder
      same, with flags — flags win over positionals
  eh cheap-local                      launch a saved profile
  eh -h claude -p ollama -s cheap-local
      save the combo as profile "cheap-local", then launch
  eh --print-env claude ollama qwen3-coder
      print the export lines instead of launching
  eh doctor                           harnesses installed? providers reachable? keys set?
  eh provider key gateway             store an API key (masked prompt → OS credential store)
  eh update                           self-update to the latest release
`,
  )

program
  .command('doctor')
  .description('check harnesses, providers, and keys')
  .action(async () => {
    intro('eh · doctor')
    await doctor(loadConfig())
  })

program
  .command('update')
  .description('update eh to the latest release')
  .action(async () => {
    // runUpdate's spinner already reported the failure; just exit non-zero.
    await runUpdate().catch(() => {
      process.exitCode = 1
    })
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
    modelsList(await listModelsCached(provider))
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
    const last = config.recent.at(0)
    if (!last) throw new Error('no recent launch to save')
    profileSave(config, name, {
      effort: last.effort,
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
