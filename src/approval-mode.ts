import type { ApprovalMode } from './types.js'

type ApprovalHarness = 'claude' | 'codex' | 'grok' | 'opencode' | 'pi'

export function approvalArgsForHarness(
  harness: ApprovalHarness,
  mode: ApprovalMode | undefined,
) {
  switch (mode) {
    case 'auto':
      return autoApprovalArgs(harness)
    case 'platform':
    case undefined:
      return []
  }
  return unreachable(mode)
}

export function approvalModeLabel(mode: ApprovalMode) {
  switch (mode) {
    case 'auto':
      return 'auto'
    case 'platform':
      return 'platform default'
  }
  return unreachable(mode)
}

function autoApprovalArgs(harness: ApprovalHarness) {
  switch (harness) {
    case 'claude':
    case 'grok':
      return ['--permission-mode', 'auto']
    case 'codex':
      return ['--approve-for-me']
    case 'opencode':
      return ['--auto']
    case 'pi':
      return []
  }
  return unreachable(harness)
}

function unreachable(value: never): never {
  throw new Error(`unsupported approval value: ${String(value)}`)
}
