import { cancel, isCancel, select } from '@clack/prompts'

import type { Config, RecentEntry } from '../config.js'
import type { Selection } from '../types.js'

import { timeAgo } from '../time-ago.js'

export type HomeChoice =
  | { kind: 'doctor' }
  | { kind: 'new' }
  | { kind: 'providers' }
  | { kind: 'recent'; recent: RecentEntry }

const NEW = '__new__'
const PROVIDERS = '__providers__'
const DOCTOR = '__doctor__'

export async function home(config: Config) {
  const recents = config.recent.slice(0, 5)
  const value = await select({
    message: 'eh',
    options: [
      ...recents.map((r, i) => ({
        hint: timeAgo(r.usedAt),
        label: recentLabel(r),
        value: `recent:${String(i)}`,
      })),
      {
        hint: 'pick harness → provider → model',
        label: 'new session →',
        value: NEW,
      },
      {
        hint: 'configured providers + status',
        label: 'providers',
        value: PROVIDERS,
      },
      { hint: 'check harnesses & providers', label: 'doctor', value: DOCTOR },
    ],
  })
  if (isCancel(value)) {
    cancel('bye')
    process.exit(0)
  }
  if (value === NEW) return { kind: 'new' } as const
  if (value === PROVIDERS) return { kind: 'providers' } as const
  if (value === DOCTOR) return { kind: 'doctor' } as const
  const index = Number(value.split(':')[1])
  const recent =
    Number.isInteger(index) && index >= 0 ? recents.at(index) : undefined
  if (!recent) throw new Error('bad recent selection')
  return { kind: 'recent' as const, recent }
}

export function selectionFromRecent(r: RecentEntry) {
  const selection: Selection = {
    harness: r.harness,
    model: r.model,
    provider: r.provider,
  }
  return selection
}

function recentLabel(r: RecentEntry) {
  return `${r.harness} · ${r.provider} · ${r.model}`
}
