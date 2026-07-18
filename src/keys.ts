import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

import { configDir } from './config.js'
import { findBin } from './which.js'

const run = promisify(execFile)

export type KeySource = 'env' | 'file' | 'keychain' | 'secret-service'

// `none` never carries a value; every other source always does.
export type ResolvedKey =
  { source: 'none' } | { source: KeySource; value: string }

// Service label as shown in Keychain Access.app / Seahorse.
const SERVICE = 'eh'

const secretsSchema = z.record(z.string(), z.string())

function secretsPath() {
  return path.join(configDir(), 'secrets.json')
}

// --- OS credential-store backends -------------------------------------------
// One backend per platform, probed once per process. macOS uses the
// `security` CLI; Linux uses `secret-tool` (libsecret / freedesktop Secret
// Service — GNOME Keyring, KWallet). Windows has no usable shell-out for
// reading credentials back, so it goes straight to the file store — the same
// posture Claude Code documents for %USERPROFILE%\.claude\.credentials.json.

interface Backend {
  delete: (account: string) => Promise<void>
  get: (account: string) => Promise<string | undefined>
  id: 'keychain' | 'secret-service'
  set: (account: string, value: string) => Promise<void>
  usable: () => Promise<boolean>
}

async function runPiped(cmd: string, args: string[], input: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${cmd} exited ${String(code)}: ${stderr.trim()}`))
    })
    // If the child exits before draining stdin, the stream errors (EPIPE) —
    // without a listener that crashes the process. A second settle is a no-op.
    child.stdin.on('error', reject)
    child.stdin.end(input)
  })
}

// Trade-off accepted (documented in DESIGN.md): on macOS the key passes
// through argv for a split second; `security` has no stdin write mode.
const macosBackend: Backend = {
  delete: async (account) => {
    try {
      await run('security', [
        'delete-generic-password',
        '-s',
        SERVICE,
        '-a',
        account,
      ])
    } catch {
      // absent is fine
    }
  },
  get: async (account) => {
    try {
      const { stdout } = await run('security', [
        'find-generic-password',
        '-s',
        SERVICE,
        '-a',
        account,
        '-w',
      ])
      const value = stdout.trim()
      return value.length > 0 ? value : undefined
    } catch {
      return undefined // exit 44 = item not found
    }
  },
  id: 'keychain',
  set: async (account, value) => {
    await run('security', [
      'add-generic-password',
      '-U', // update if the item already exists
      '-s',
      SERVICE,
      '-a',
      account,
      '-w',
      value,
    ])
  },
  usable: async () =>
    Promise.resolve(
      process.platform === 'darwin' && findBin('security') !== undefined,
    ),
}

const PROBE_ACCOUNT = '__eh_probe__'

// execFile rejections carry a numeric `code`; read it without assertions.
function exitCodeOf(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const code: unknown = Reflect.get(error, 'code')
  return typeof code === 'number' ? code : undefined
}

async function secretServiceReachable() {
  try {
    await run('secret-tool', [
      'lookup',
      'service',
      SERVICE,
      'account',
      PROBE_ACCOUNT,
    ])
    return true
  } catch (error) {
    // Exit 1 = daemon reachable, item simply not found. Anything else
    // (no daemon, no D-Bus session, timeout) = unusable.
    return exitCodeOf(error) === 1
  }
}

let secretServiceCache: boolean | undefined

const linuxBackend: Backend = {
  delete: async (account) => {
    try {
      await run('secret-tool', [
        'clear',
        'service',
        SERVICE,
        'account',
        account,
      ])
    } catch {
      // absent is fine
    }
  },
  get: async (account) => {
    try {
      const { stdout } = await run('secret-tool', [
        'lookup',
        'service',
        SERVICE,
        'account',
        account,
      ])
      // secret-tool prints the raw secret with no trailing newline.
      return stdout.length > 0 ? stdout : undefined
    } catch {
      return undefined
    }
  },
  id: 'secret-service',
  // The secret travels over stdin — never argv, never `ps`.
  set: async (account, value) => {
    await runPiped(
      'secret-tool',
      [
        'store',
        `--label=eh: ${account}`,
        'service',
        SERVICE,
        'account',
        account,
      ],
      value,
    )
  },
  usable: async () => {
    secretServiceCache ??=
      process.platform === 'linux' &&
      findBin('secret-tool') !== undefined &&
      (await secretServiceReachable())
    return secretServiceCache
  },
}

const BACKENDS = [macosBackend, linuxBackend]

async function usableBackend() {
  for (const backend of BACKENDS) {
    if (await backend.usable()) return backend
  }
  return undefined
}

// --- 0600 file store (fallback everywhere, primary on Windows) ---------------

function lookupFile(providerName: string) {
  const secrets = readSecrets()
  return Object.hasOwn(secrets, providerName)
    ? secrets[providerName]
    : undefined
}

function readSecrets() {
  try {
    const parsed = secretsSchema.safeParse(
      JSON.parse(readFileSync(secretsPath(), 'utf8')),
    )
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function writeSecrets(secrets: Record<string, string>) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(secretsPath(), `${JSON.stringify(secrets, null, 2)}\n`, {
    mode: 0o600,
  })
  // mode only applies at creation — enforce on every write. Best-effort on
  // Windows, where the file is protected by the profile-dir ACLs instead.
  chmodSync(secretsPath(), 0o600)
}

// --- public API ---------------------------------------------------------------

// Resolution order: explicit environment wins (keeps `op run` / dotenvx
// composable), then the OS credential store, then the 0600 secrets file.
export async function resolveApiKey(
  envKey: string | undefined,
  providerName: string,
): Promise<ResolvedKey> {
  if (envKey) {
    const fromEnv = process.env[envKey]
    if (fromEnv) return { source: 'env', value: fromEnv }
  }
  const backend = await usableBackend()
  if (backend) {
    const fromStore = await backend.get(providerName)
    if (fromStore) return { source: backend.id, value: fromStore }
  }
  const fromFile = lookupFile(providerName)
  if (fromFile) return { source: 'file', value: fromFile }
  return { source: 'none' }
}

export async function storeApiKey(providerName: string, value: string) {
  const backend = await usableBackend()
  if (backend) {
    try {
      await backend.set(providerName, value)
      return backend.id
    } catch {
      // fall through to the file store
    }
  }
  const secrets = readSecrets()
  secrets[providerName] = value
  writeSecrets(secrets)
  return 'file' as const
}

// Returns true if anything was actually removed.
export async function deleteApiKey(providerName: string) {
  let removed = false
  const backend = await usableBackend()
  if (backend) {
    const had = await backend.get(providerName)
    if (had !== undefined) {
      await backend.delete(providerName)
      removed = true
    }
  }
  const secrets = readSecrets()
  if (Object.hasOwn(secrets, providerName)) {
    const { [providerName]: _dropped, ...rest } = secrets
    writeSecrets(rest)
    removed = true
  }
  return removed
}

export function secretsPathForDisplay() {
  return secretsPath()
}
