import { spawn } from 'node:child_process'

import type { LaunchPlan } from './types.js'

// Exit code convention: 128 + signal number for signaled processes.
const SIGNAL_CODES = new Map([
  ['SIGHUP', 1],
  ['SIGINT', 2],
  ['SIGKILL', 9],
  ['SIGQUIT', 3],
  ['SIGTERM', 15],
])

export async function exec(plan: LaunchPlan) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(plan.bin, plan.args, {
      env: { ...process.env, ...plan.env },
      stdio: 'inherit',
    })
    child.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'ENOENT') {
        reject(new Error(`harness binary "${plan.bin}" not found on PATH`))
        return
      }
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (code != null) {
        resolve(code)
        return
      }
      resolve(128 + (SIGNAL_CODES.get(signal ?? '') ?? 1))
    })
  })
}

export function printEnv(plan: LaunchPlan) {
  for (const [key, value] of Object.entries(plan.env)) {
    console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`)
  }
  if (plan.args.length > 0) {
    console.log(`# plus args: ${plan.bin} ${plan.args.join(' ')}`)
  }
}
