import { autocomplete, isCancel, select } from '@clack/prompts'

import type { SessionInfo } from '../sessions.js'

import { getHarness, harnessNames } from '../harnesses.js'
import { timeAgo } from '../time-ago.js'
import { findBin } from '../which.js'
import { bail, log } from './output.js'

// Filterable picker over the cross-harness session list. Rows are indexed by
// position, not session id — ids could collide across harness stores.
export async function pickSession(sessions: SessionInfo[]) {
  // installedBin walks PATH synchronously — once per harness, not per row.
  const installedByHarness = new Map<string, boolean>()
  for (const harness of new Set(sessions.map((s) => s.harness))) {
    installedByHarness.set(harness, installedBin(harness) !== undefined)
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
    return row.session
  }
}

// Which harness should the picked session continue in — its own (native
// resume by id, preselected so Enter keeps today's flow) or another (context
// handoff into a fresh session).
export async function pickTargetHarness(source: string) {
  const ordered = [source, ...harnessNames().filter((n) => n !== source)]
  const options = ordered.map((name) => {
    const mode =
      name === source
        ? 'native — resume by session id'
        : 'hand off — continue the conversation in a fresh session'
    return {
      hint: installedBin(name) === undefined ? `${mode} · not installed` : mode,
      label: name,
      value: name,
    }
  })
  for (;;) {
    const value = await select({
      initialValue: source,
      message: 'resume on:',
      options,
    })
    if (isCancel(value)) bail()
    if (installedBin(value) !== undefined) return value
    log.warn(
      `"${getHarness(value)?.bin ?? value}" is not on PATH — install it or pick another harness`,
    )
  }
}

// The harness's bin when it's on PATH, undefined otherwise.
function installedBin(harness: string) {
  const bin = getHarness(harness)?.bin
  return bin !== undefined && findBin(bin) !== undefined ? bin : undefined
}
