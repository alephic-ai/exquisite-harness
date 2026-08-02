import { spawn } from 'node:child_process'
import os from 'node:os'

import type { LaunchPlan } from './types.js'

import { startSearchProxy } from './search-proxy.js'

export async function exec(plan: LaunchPlan) {
  const proxy = plan.searchProxy
    ? await startSearchProxy(plan.searchProxy)
    : undefined
  try {
    const { EH_SEARCH_PROXY_URL: _ambientProxyURL, ...parentEnv } = process.env
    const env: Record<string, string | undefined> = {
      ...parentEnv,
      ...plan.env,
      ...(proxy
        ? {
            ANTHROPIC_BASE_URL: proxy.baseURL,
            EH_SEARCH_PROXY_URL: `${proxy.baseURL}/hooks/web-fetch`,
          }
        : {}),
    }
    if (!plan.searchProxy) return await spawnHarness(plan, env)
    const { [plan.searchProxy.envKey]: _searchKey, ...childEnv } = env
    return await spawnHarness(plan, childEnv)
  } finally {
    await proxy?.close()
  }
}

export function printEnv(plan: LaunchPlan) {
  for (const [key, value] of Object.entries(plan.env)) {
    console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`)
  }
  if (plan.args.length > 0) {
    console.log(`# plus args: ${plan.bin} ${plan.args.join(' ')}`)
  }
}

async function spawnHarness(
  plan: LaunchPlan,
  env: Record<string, string | undefined>,
) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(plan.bin, plan.args, {
      env,
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
