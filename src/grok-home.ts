import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse, stringify } from 'smol-toml'
import { z } from 'zod'

const modelTableSchema = z.record(z.string(), z.record(z.string(), z.unknown()))

// Grok prefers a signed-in session token from ~/.grok/auth.json over
// XAI_API_KEY, even when GROK_MODELS_BASE_URL points at a custom endpoint
// (Gateway, Ollama, …). That sends an xAI OAuth JWT (and X-XAI-Token-Auth)
// to third-party providers, which reject it.
//
// Process-scoped GROK_HOME without auth.json, plus a per-model env_key that
// names XAI_API_KEY, forces Bearer API-key auth while still sharing the user's
// sessions/skills via symlinks. The temp dir is removed by the plan's cleanup.
export async function prepareGrokApiKeyHome(model: string) {
  const realHome = process.env.GROK_HOME ?? path.join(os.homedir(), '.grok')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eh-grok-'))
  try {
    await mkdir(path.join(realHome, 'sessions'), {
      mode: 0o700,
      recursive: true,
    })
    await Promise.all(
      (await readdir(realHome, { withFileTypes: true }))
        .filter(
          (entry) =>
            ![
              'auth.json',
              'auth.json.lock',
              'config.toml',
              'config.toml.lock',
            ].includes(entry.name),
        )
        .map(async (entry) => {
          const source = path.join(realHome, entry.name)
          const target = path.join(dir, entry.name)
          if (entry.isFile()) return copyFile(source, target)
          return symlink(source, target)
        }),
    )
    await writeFile(
      path.join(dir, 'config.toml'),
      await apiKeyConfig(realHome, model),
      { mode: 0o600 },
    )
    return {
      cleanup: async () => rm(dir, { force: true, recursive: true }),
      home: dir,
    }
  } catch (error) {
    try {
      await rm(dir, { force: true, recursive: true })
    } catch {
      // Preserve the preparation failure.
    }
    throw error
  }
}

async function apiKeyConfig(realHome: string, model: string) {
  const config = await readUserConfig(realHome)
  const models = Object.hasOwn(config, 'model')
    ? modelTableSchema.parse(Reflect.get(config, 'model'))
    : {}

  // The selected provider owns its model id, endpoint, protocol, headers, and
  // credentials. A minimal entry prevents stale per-model routing from winning.
  return stringify({
    ...config,
    model: {
      ...models,
      [model]: { env_key: 'XAI_API_KEY' },
    },
  })
}

function isMissingPath(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

async function readUserConfig(realHome: string) {
  try {
    return parse(await readFile(path.join(realHome, 'config.toml'), 'utf8'))
  } catch (error) {
    if (isMissingPath(error)) return {}
    throw error
  }
}
