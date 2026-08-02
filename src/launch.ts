import { spawn } from 'node:child_process'
import os from 'node:os'

import type { LaunchPlan } from './types.js'

import { gatewayCostsDir, startGatewayCostProxy } from './gateway-costs.js'

export async function exec(plan: LaunchPlan) {
  const proxy = plan.gatewayCostCapture
    ? await startGatewayCostProxy({
        costDir: gatewayCostsDir(),
        resumed: plan.gatewayCostCapture.resumed,
        targetBaseURL: gatewayTargetBaseURL(plan),
      })
    : undefined
  const env = {
    ...process.env,
    ...plan.env,
    ...(proxy
      ? {
          ANTHROPIC_BASE_URL: proxy.baseURL,
          EH_GATEWAY_COST_CAPTURE: '1',
        }
      : {}),
  }
  try {
    return await spawnHarness(plan, env)
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

function gatewayTargetBaseURL(plan: LaunchPlan) {
  const targetBaseURL = plan.env.ANTHROPIC_BASE_URL
  if (!targetBaseURL) {
    throw new Error('gateway cost capture requires ANTHROPIC_BASE_URL')
  }
  return targetBaseURL
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
