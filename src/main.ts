import { Command } from '@commander-js/extra-typings'

import pkg from '../package.json' with { type: 'json' }
import {
  getProvider,
  loadConfig,
  saveConfig,
  searchProviderForSelection,
} from './config.js'
import { doctor } from './doctor.js'
import { launchFlow } from './flow.js'
import { runHeadless } from './headless-run.js'
import {
  modelsList,
  profileList,
  profileRemove,
  profileSave,
  providerKeyDelete,
  providerKeySet,
  providersCommand,
  searchProviderKeyDelete,
  searchProviderKeySet,
} from './manage.js'
import { listModelsCached } from './providers.js'
import { installSkill, printSkill } from './skill.js'
import { runStatusline } from './statusline.js'
import { EFFORT_LEVELS } from './types.js'
import { intro } from './ui/output.js'
import { addProvider, wizard } from './ui/wizard.js'
import { runUpdate } from './update.js'
import { runWebFetchHook } from './web-fetch-hook.js'

const program = new Command()

program
  .name('eh')
  .description('exquisite harness — pick a harness, pick a provider, go')
  .version(pkg.version, '-v, --version')
  // -h is help (commander default); --harness stays long-only — the
  // positional (`eh claude …`) is the short path for harness anyway.
  .helpOption('-h, --help', 'display help for command')

program
  .argument('[harness-or-profile]', 'harness name or saved profile')
  .argument('[provider]', 'provider name')
  .argument('[model]', 'model id')
  .option('--harness <name>', 'harness: claude, codex, grok, opencode, pi')
  .option(
    '-p, --provider <name>',
    'provider: ollama, openrouter, vercel-ai-gateway, …',
  )
  .option(
    '--gateway-provider <slug>',
    'pin OpenRouter or Vercel AI Gateway to one upstream provider',
  )
  .option('-m, --model <id>', 'model id')
  .option('--search <provider>', 'web search/fetch: native, firecrawl')
  .option('-s, --save <name>', 'save the combo as a profile, then launch')
  .option(
    '-e, --effort <level>',
    `reasoning effort: ${EFFORT_LEVELS.join(', ')}`,
  )
  .option('--print-env', 'print env vars instead of launching')
  .option(
    '-r, --resume',
    "pick from this directory's sessions (all harnesses) and resume",
  )
  .action(async (harnessOrProfile, provider, model, opts) => {
    // The first positional may also name a profile. Commander fills positionals
    // left-to-right regardless of flags, so mixing a flag with positionals
    // silently misassigns them — same-slot conflicts error instead.
    if (opts.harness !== undefined && harnessOrProfile !== undefined) {
      throw new Error(
        'harness specified twice — use either --harness <name> or the positional, not both',
      )
    }
    if (opts.provider !== undefined && provider !== undefined) {
      throw new Error(
        'provider specified twice — use either -p/--provider <name> or the positional, not both',
      )
    }
    if (opts.model !== undefined && model !== undefined) {
      throw new Error(
        'model specified twice — use either -m/--model <id> or the positional, not both',
      )
    }
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
        gatewayProvider: opts.gatewayProvider,
        printEnvOnly: opts.printEnv === true,
        resume: opts.resume === true,
        saveAs: opts.save,
        searchProvider: opts.search,
      },
    )
  })
  .addHelpText(
    'after',
    `
Common workflows:
  eh                                  interactive: recents, or harness → provider → model
  eh claude ollama qwen3-coder        launch with zero prompts (positional)
  eh --harness codex -p ollama -m qwen3-coder
      same, with flags
  eh cheap-local                      launch a saved profile
  eh claude -p ollama -s cheap-local
      save the combo as profile "cheap-local", then launch
  eh -r                               pick a session from this directory (all harnesses)
  eh -r codex -p ollama               only codex sessions; -p/-m/-e override the wiring
  eh claude vercel-ai-gateway anthropic/claude-sonnet-4.6 --gateway-provider bedrock
      pin this run to one Vercel AI Gateway upstream provider
  eh claude openrouter anthropic/claude-sonnet-4.6 --gateway-provider anthropic
      same pin through OpenRouter's Anthropic Messages skin
  eh -r --print-env claude ollama qwen3-coder
      scripted resume: no picker, prints env + bare resume args
  eh --print-env claude ollama qwen3-coder
      print the export lines instead of launching
  printf 'fix the parser' | eh run codex ollama qwen3-coder
      headless run: versioned NDJSON on stdout, harness stderr preserved
  printf 'summarize' | eh run claude vercel-ai-gateway anthropic/claude-sonnet-4.6 --gateway-provider bedrock
      headless Gateway run pinned to one upstream provider
  eh doctor                           harnesses installed? providers reachable? keys set?
  eh provider key vercel-ai-gateway   store an API key (masked prompt → OS credential store)
  eh search key firecrawl             store the Firecrawl search key the same way
  eh claude ollama qwen3-coder --search firecrawl
                                      route WebSearch/WebFetch through Firecrawl
  eh update                           self-update to the latest release
`,
  )

configureHeadlessCommand(
  program.command('run <harness> <provider> <model>'),
  'run one harness headlessly (prompt on stdin, NDJSON on stdout)',
)
configureHeadlessCommand(
  program.command('ask <harness> <provider> <model>'),
  'ask one harness headlessly (prompt on stdin, NDJSON on stdout)',
)

const skillCmd = program
  .command('skill')
  .description('print or install the eh delegation skill')
skillCmd
  .command('print')
  .description('print the eh delegation skill')
  .action(() => printSkill())
skillCmd
  .command('install')
  .description('install the eh delegation skill into a directory')
  .requiredOption('--dir <dir>', 'destination skill directory')
  .option('--force', 'overwrite a differing existing skill')
  .action((opts) => installSkill(opts.dir, opts.force === true))

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

// Invoked by Claude Code's statusLine command (stdin JSON → powerline bar).
// Not a user-facing workflow; hidden from help.
program
  .command('statusline', { hidden: true })
  .description('render the eh Claude statusline (stdin: Claude status JSON)')
  .action(async () => {
    await runStatusline()
  })

// Invoked by Claude Code's WebFetch hooks (stdin hook JSON → stdout decision).
// Hidden because users configure the provider, not this bridge command.
program
  .command('web-fetch-hook', { hidden: true })
  .description('route Claude WebFetch hook payloads through eh')
  .action(async () => {
    await runWebFetchHook()
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
  .action(async (providerName) => {
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
  .action(async (name, opts) => {
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

const searchCmd = program.command('search').description('manage web search')
searchCmd
  .command('key <name>')
  .description('store a search API key (Keychain or 0600 secrets file)')
  .option('--delete', 'delete the stored key instead')
  .action(async (name, opts) => {
    const config = loadConfig()
    if (opts.delete) {
      await searchProviderKeyDelete(config, name)
      return
    }
    if (!process.stdout.isTTY) {
      throw new Error('storing a key needs an interactive terminal')
    }
    await searchProviderKeySet(config, name)
  })

const profileCmd = program.command('profile').description('manage profiles')
profileCmd
  .command('save <name>')
  .description('save the most recent combo as a profile')
  .action((name) => {
    const config = loadConfig()
    const last = config.recent.at(0)
    if (!last) throw new Error('no recent launch to save')
    profileSave(config, name, {
      effort: last.effort,
      gatewayProvider: last.gatewayProvider,
      gatewayZdr: last.gatewayZdr,
      harness: last.harness,
      model: last.model,
      provider: last.provider,
      searchProvider: searchProviderForSelection(config, last),
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
  .action((name) => {
    profileRemove(loadConfig(), name)
  })

program
  .command('setup')
  .description('re-run the first-run wizard')
  .action(async () => {
    intro('eh · setup')
    saveConfig(await wizard(loadConfig()))
  })

function configureHeadlessCommand(
  command: Command<[string, string, string]>,
  description: string,
) {
  command
    .description(description)
    .option(
      '--reasoning-effort <level>',
      `reasoning effort: ${EFFORT_LEVELS.join(', ')}`,
      'auto',
    )
    .option(
      '--native-args-json <json>',
      'JSON string array of native harness args to prepend before machine-mode args',
    )
    .option(
      '--gateway-provider <slug>',
      'pin OpenRouter or Vercel AI Gateway to one upstream provider',
    )
    .option('--resume-session <id>', 'resume an existing native session')
    .option('--cwd <dir>', 'run the spawned harness in this working directory')
    .option(
      '--timeout <seconds>',
      'fail the run if the harness runs longer than <seconds> (SIGTERM, then SIGKILL after a grace period)',
    )
    .option(
      '--result-file <path>',
      "write the run's final result text to <path> (created empty when the run produced no result)",
    )
    .action(async (harness, provider, model, opts) => {
      process.exitCode = await runHeadless({
        cwd: opts.cwd,
        effort: opts.reasoningEffort,
        // The root command exposes the same option for interactive launches.
        // Commander assigns an option after a subcommand to the root when both
        // define it, so read both scopes instead of silently dropping the pin.
        gatewayProvider: opts.gatewayProvider ?? rootGatewayProvider(),
        harness,
        model,
        nativeArgsJson: opts.nativeArgsJson,
        provider,
        resultFile: opts.resultFile,
        resumeSessionId: opts.resumeSession,
        timeout: opts.timeout,
      })
    })
}

async function main() {
  await program.parseAsync(process.argv)
}

function rootGatewayProvider() {
  const value: unknown = program.getOptionValue('gatewayProvider')
  return typeof value === 'string' ? value : undefined
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `eh: ${error.message}` : error)
  process.exitCode = 1
})
