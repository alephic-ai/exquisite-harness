import { isCancel } from '@clack/prompts'

import type { Config, RecentEntry } from '../config.js'
import type { Selection } from '../types.js'

import {
  canonicalProviderName,
  providerLabel,
  searchProviderForSelection,
  searchProviderLabel,
} from '../config.js'
import { timeAgo } from '../time-ago.js'
import { letterSelect } from './letter-select.js'
import { bail } from './output.js'

export type HomeChoice =
  | { kind: 'defaults' }
  | { kind: 'doctor' }
  | { kind: 'new' }
  | { kind: 'providers' }
  | { kind: 'recent'; recent: RecentEntry }

const DEFAULTS = '__defaults__'
const NEW = '__new__'
const PROVIDERS = '__providers__'
const DOCTOR = '__doctor__'

export async function home(config: Config) {
  const recents = config.recent.slice(0, 5)
  const value = await letterSelect({
    message: 'eh',
    options: [
      ...recents.map((r, i) => ({
        hint: timeAgo(r.usedAt),
        label: recentLabel(config, r),
        value: `recent:${String(i)}`,
      })),
      // Divider row between the recents and the fixed actions (only when
      // there are recents — a leading one would be weird).
      ...(recents.length > 0 ? [{ disabled: true, value: '__spacer__' }] : []),
      {
        hint: 'pick harness → provider → model',
        hotkey: 'n',
        label: 'new session →',
        value: NEW,
      },
      {
        hint: 'model + search providers',
        hotkey: 'p',
        label: 'providers',
        value: PROVIDERS,
      },
      {
        hint: 'approval behavior',
        // f, not d: d would eat a recents letter (a–e auto-assign around
        // claimed letters, and the 5th recent would get none).
        hotkey: 'f',
        label: 'defaults',
        value: DEFAULTS,
      },
      {
        hint: 'check harnesses & providers',
        hotkey: 'o',
        label: 'doctor',
        value: DOCTOR,
      },
    ],
  })
  if (isCancel(value)) bail()
  if (value === NEW) return { kind: 'new' } as const
  if (value === PROVIDERS) return { kind: 'providers' } as const
  if (value === DEFAULTS) return { kind: 'defaults' } as const
  if (value === DOCTOR) return { kind: 'doctor' } as const
  const index = Number(value.split(':')[1])
  const recent =
    Number.isInteger(index) && index >= 0 ? recents.at(index) : undefined
  if (!recent) throw new Error('bad recent selection')
  return { kind: 'recent' as const, recent }
}

export function selectionFromRecent(config: Config, r: RecentEntry) {
  const selection: Selection = {
    effort: r.effort,
    gatewayProvider: r.gatewayProvider,
    gatewayZdr: r.gatewayZdr,
    harness: r.harness,
    model: r.model,
    provider: canonicalProviderName(r.provider),
    searchProvider: searchProviderForSelection(config, r),
  }
  return selection
}

function recentLabel(config: Config, r: RecentEntry) {
  const effort = r.effort && r.effort !== 'auto' ? ` @${r.effort}` : ''
  const searchProvider = searchProviderForSelection(config, r)
  const search =
    searchProvider !== 'native'
      ? ` · ${searchProviderLabel(searchProvider)} search`
      : ''
  const gateway = r.gatewayProvider
    ? ` via ${r.gatewayProvider}`
    : r.gatewayZdr
      ? ' · ZDR only'
      : ''
  return `${r.harness} · ${providerLabel(r.provider)}${gateway} · ${r.model}${effort}${search}`
}
