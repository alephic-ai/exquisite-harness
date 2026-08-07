import { spawn } from 'node:child_process'
import os from 'node:os'

import type { LaunchPlan } from './types.js'

import { gatewayCostsDir, startGatewayCostProxy } from './gateway-costs.js'
import { withGatewayRouting } from './gateway-routing.js'
import { startSearchProxy } from './search-proxy.js'

export async function exec(plan: LaunchPlan) {
  return withGatewayRouting(plan, execWithAuxiliaryProxies)
}

export function printEnv(plan: LaunchPlan) {
  for (const [key, value] of Object.entries(plan.env)) {
    console.log(`export ${key}='${value.replaceAll("'", "'\\''")}'`)
  }
  if (plan.args.length > 0) {
    console.log(`# plus args: ${plan.bin} ${plan.args.join(' ')}`)
  }
  if (plan.gatewayRouting) {
    const label = plan.gatewayRouting.provider
      ? `gateway provider: ${plan.gatewayRouting.provider}`
      : 'gateway routing: ZDR only'
    console.log(`# ${label} (pinned by an eh loopback proxy on launch)`)
  }
}

async function execWithAuxiliaryProxies(plan: LaunchPlan) {
  const costProxy = plan.gatewayCostCapture
    ? await startGatewayCostProxy({
        costDir: gatewayCostsDir(),
        resumed: plan.gatewayCostCapture.resumed,
        targetBaseURL: gatewayTargetBaseURL(plan),
      })
    : undefined
  try {
    const searchProxy = plan.searchProxy
      ? await startSearchProxy({
          ...plan.searchProxy,
          upstreamBaseURL:
            costProxy?.baseURL ?? plan.searchProxy.upstreamBaseURL,
        })
      : undefined
    try {
      return await spawnWithProxies(plan, {
        costProxyURL: costProxy?.baseURL,
        searchProxyURL: searchProxy?.baseURL,
      })
    } finally {
      await searchProxy?.close()
    }
  } finally {
    await costProxy?.close()
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

async function spawnWithProxies(
  plan: LaunchPlan,
  proxies: { costProxyURL?: string; searchProxyURL?: string },
) {
  const {
    EH_GATEWAY_COST_CAPTURE: _ambientCostCapture,
    EH_SEARCH_PROXY_URL: _ambientProxyURL,
    ...parentEnv
  } = process.env
  const env: Record<string, string | undefined> = {
    ...parentEnv,
    ...plan.env,
    ...(proxies.costProxyURL
      ? {
          ANTHROPIC_BASE_URL: proxies.costProxyURL,
          EH_GATEWAY_COST_CAPTURE: '1',
        }
      : {}),
    ...(proxies.searchProxyURL
      ? {
          ANTHROPIC_BASE_URL: proxies.searchProxyURL,
          EH_SEARCH_PROXY_URL: `${proxies.searchProxyURL}/hooks/web-fetch`,
        }
      : {}),
  }
  if (!plan.searchProxy) return spawnHarness(plan, env)
  const { [plan.searchProxy.envKey]: _searchKey, ...childEnv } = env
  return spawnHarness(plan, childEnv)
}
