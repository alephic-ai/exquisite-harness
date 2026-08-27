import type { ApprovalMode } from './types.js'

import { approvalArgsForHarness } from './approval-mode.js'

type PermissionHarness = 'claude' | 'codex' | 'grok' | 'opencode' | 'pi'

// One resolution point owns both permission axes (approval + write-restriction).
// Native flags collide on two of five harnesses (docs/read-only.md "The
// collision findings"), so read-only cannot be a second independent
// arg-appender next to approvalArgsForHarness: when readOnly is set it takes
// precedence and the approval-mode args are suppressed — except opencode, whose
// --agent plan composes with --auto.
export function permissionArgsForHarness(
  harness: PermissionHarness,
  options: { approvalMode: ApprovalMode | undefined; readOnly: boolean },
) {
  if (!options.readOnly) {
    return approvalArgsForHarness(harness, options.approvalMode)
  }
  return readOnlyArgs(harness, options.approvalMode)
}

// Each harness's strongest own write restriction, per docs/read-only.md
// "Decision". A harness with no mechanism hits the unreachable guard so the lane
// refuses to launch rather than run silently unrestricted.
function readOnlyArgs(
  harness: PermissionHarness,
  approvalMode: ApprovalMode | undefined,
) {
  switch (harness) {
    case 'claude':
    case 'grok':
      return ['--permission-mode', 'plan']
    case 'codex':
      return ['--sandbox', 'read-only']
    case 'opencode':
      // --agent plan blocks writes; --auto composes and does not override it.
      return [
        '--agent',
        'plan',
        ...approvalArgsForHarness('opencode', approvalMode),
      ]
    case 'pi':
      return ['--tools', 'read,grep,find,ls']
  }
  return unreachable(harness)
}

function unreachable(harness: never): never {
  throw new Error(
    `no read-only mechanism for harness "${String(harness)}"; refusing to launch a --read-only lane (docs/read-only.md)`,
  )
}
