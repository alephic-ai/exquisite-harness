import { isCancel, select } from '@clack/prompts'

import type { Config } from '../config.js'
import type { ApprovalMode } from '../types.js'

import { approvalModeLabel } from '../approval-mode.js'
import { saveConfig } from '../config.js'
import { bail, log } from './output.js'

const APPROVALS = '__approvals__'
const BACK = '__back__'

export async function defaultsScreen(config: Config) {
  let currentConfig = config
  for (;;) {
    const value = await select({
      message: 'defaults',
      options: [
        {
          hint: approvalModeLabel(currentConfig.defaultApprovalMode),
          label: 'approvals',
          value: APPROVALS,
        },
        { hint: 'home', label: '← back', value: BACK },
      ],
    })
    if (isCancel(value)) bail()
    if (value === BACK) return currentConfig

    const approvalMode = await select<ApprovalMode | typeof BACK>({
      message: 'approvals',
      options: [
        {
          hint: "use each harness's normal approval behavior",
          label: 'platform default',
          value: 'platform',
        },
        {
          hint: 'native guarded auto mode; pi already has no approval prompts',
          label: 'auto',
          value: 'auto',
        },
        { hint: 'defaults', label: '← back', value: BACK },
      ],
    })
    if (isCancel(approvalMode)) bail()
    if (approvalMode === BACK) continue
    if (approvalMode === currentConfig.defaultApprovalMode) continue

    currentConfig = { ...currentConfig, defaultApprovalMode: approvalMode }
    saveConfig(currentConfig)
    log.success(`approval default: ${approvalModeLabel(approvalMode)}`)
  }
}
