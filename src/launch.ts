import { spawn } from 'node:child_process'
import os from 'node:os'

import type { LaunchPlan } from './types.js'

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
      // Exit code convention: 128 + signal number for signaled processes.
      resolve(code ?? 128 + (signal ? os.constants.signals[signal] : 1))
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
