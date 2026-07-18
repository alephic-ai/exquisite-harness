// Single re-export site for clack's non-interactive output helpers. Modules
// outside src/ui/ import from here, so the UI library stays swappable and
// flag-driven paths never pull in prompt widgets (DESIGN.md "Stack"). The
// spinner counts as output, not a prompt: it animates status on a TTY and
// degrades to plain log lines when piped.
import { cancel } from '@clack/prompts'

import { secretsPathForDisplay } from '../keys.js'

export { intro, log, note, outro, spinner } from '@clack/prompts'

// Annotated: TS cannot infer `never` here, and the narrowing at every
// isCancel call site depends on it.
export function bail(): never {
  cancel('bye')
  process.exit(0)
}

// One wording for where a stored key landed — storeApiKey's three outcomes.
export function keyStoredText(where: 'file' | 'keychain' | 'secret-service') {
  switch (where) {
    case 'file':
      return `stored in ${secretsPathForDisplay()} (mode 0600)`
    case 'keychain':
      return 'stored in macOS Keychain (service "eh")'
    case 'secret-service':
      return 'stored in the OS credential store (secret service)'
  }
}
