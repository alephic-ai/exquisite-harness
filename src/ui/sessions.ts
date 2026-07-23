import { autocomplete, isCancel } from '@clack/prompts'

import type { SessionInfo } from '../sessions.js'

import { getHarness } from '../harnesses.js'
import { timeAgo } from '../time-ago.js'
import { findBin } from '../which.js'
import { bail, log } from './output.js'

// Filterable picker over the cross-harness session list. Rows are indexed by
// position, not session id — ids could collide across harness stores.
export async function pickSession(sessions: SessionInfo[]) {
  // findBin walks PATH synchronously — once per harness, not once per row.
  const installedByHarness = new Map<string, boolean>()
  for (const harness of new Set(sessions.map((s) => s.harness))) {
    const bin = getHarness(harness)?.bin
    installedByHarness.set(
      harness,
      bin !== undefined && findBin(bin) !== undefined,
    )
  }
  const rows = sessions.map((session, i) => {
    const installed = installedByHarness.get(session.harness) ?? false
    const hint = [
      session.harness,
      session.model ?? 'unknown model',
      timeAgo(session.updatedAt),
      ...(installed ? [] : ['not installed']),
    ].join(' · ')
    return {
      installed,
      option: {
        hint,
        label: session.title || `(untitled · ${session.id.slice(0, 8)})`,
        value: String(i),
      },
      session,
    }
  })
  for (;;) {
    const value = await autocomplete({
      maxItems: 12,
      message: 'resume session',
      options: rows.map((r) => r.option),
      placeholder: 'type to filter…',
    })
    if (isCancel(value)) bail()
    // Enter on a zero-match filter submits undefined (clack has no guard);
    // Number(undefined) → NaN → rows.at(0) would silently resume the newest
    // session, so reject anything that isn't a real row index instead.
    const index = typeof value === 'string' ? Number(value) : Number.NaN
    const row = Number.isInteger(index) ? rows.at(index) : undefined
    if (!row) {
      log.warn('no session selected — clear the filter or pick one')
      continue
    }
    if (row.installed) return row.session
    const bin = getHarness(row.session.harness)?.bin
    log.warn(
      `"${bin ?? row.session.harness}" is not on PATH — install it or pick another session`,
    )
  }
}
