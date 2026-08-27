// Select with letter hotkeys: the first few selectable rows each get a letter
// (a–e) and pressing it picks that row directly — no arrow round-trip. Up/down
// + enter keep working, so this is a strict upgrade over clack's `select`.
//
// Why not @clack/prompts' own pieces: `select` has no per-option keys, and
// `selectKey` (the API built for this) drops arrow navigation entirely. So we
// instantiate core's SelectPrompt — the same class behind `select` — and add a
// 'key' listener that submits on the row's assigned letter (the same mechanism
// SelectKeyPrompt uses internally). @clack/prompts doesn't re-export the
// prompt classes, which is why @clack/core is a direct dependency: prompts
// 1.7.0 pins it at exactly 1.4.3, so it adds nothing to the compiled binary.
import { SelectPrompt, wrapTextWithPrefix } from '@clack/core'
import {
  formatInstructionFooter,
  limitOptions,
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  SELECT_INSTRUCTIONS,
  settings,
  symbol,
  symbolBar,
} from '@clack/prompts'
import { styleText } from 'node:util'

// Keys clack binds globally (j/k/h/l cursor aliases, y/n confirm events) — a
// hotkey letter must never collide with one, or a keypress does two things.
export const CLACK_ALIAS_KEYS = new Set(['h', 'j', 'k', 'l', 'n', 'y'])

// Rows that get a letter. a–e deliberately stays clear of clack's alias keys
// — raise this cap and that stops holding (see letter-select.test.ts).
export const HOTKEY_MAX_ROWS = 5

export interface LetterSelectOption<Value extends string> {
  disabled?: boolean
  hint?: string
  label?: string
  value: Value
}

export interface LetterSelectOptions<Value extends string> {
  initialValue?: Value
  message: string
  options: LetterSelectOption<Value>[]
}

// One letter per selectable row, in order (a, b, c, …). Disabled rows and
// rows past HOTKEY_MAX_ROWS get undefined.
export function hotkeyLetters(options: readonly { disabled?: boolean }[]) {
  const letters: (string | undefined)[] = []
  let assigned = 0
  for (const option of options) {
    if (option.disabled || assigned >= HOTKEY_MAX_ROWS) {
      letters.push(undefined)
      continue
    }
    letters.push(String.fromCharCode(97 + assigned))
    assigned += 1
  }
  return letters
}

// Drop-in for clack's select: every list answers to ↑/↓ + enter as before,
// plus letter hotkeys on its first HOTKEY_MAX_ROWS selectable rows.
export async function letterSelect<Value extends string>(
  opts: LetterSelectOptions<Value>,
): Promise<symbol | Value> {
  const letters = hotkeyLetters(opts.options)
  const byLetter = new Map<string, Value>()
  const options = opts.options.map((option, index) => {
    const letter = letters[index]
    if (!letter || option.disabled) return option
    byLetter.set(letter, option.value)
    return { ...option, label: `${letter}) ${option.label ?? option.value}` }
  })

  const first = 'a'
  const last = String.fromCharCode(97 + byLetter.size - 1)
  const hotkeyRange = first === last ? first : `${first}–${last}`
  const instructions =
    byLetter.size === 0
      ? SELECT_INSTRUCTIONS
      : [
          `${styleText('dim', `${hotkeyRange} or ↑/↓`)} to select`,
          `${styleText('dim', 'Enter:')} confirm`,
        ]

  const prompt = new SelectPrompt<LetterSelectOption<Value>>({
    initialValue: opts.initialValue,
    options,
    render() {
      const guide = settings.withGuide
      const prefix = `${symbol(this.state)}  `
      const bar = `${symbolBar(this.state)}  `
      const header = `${guide ? `${styleText('gray', S_BAR)}\n` : ''}${wrapTextWithPrefix(undefined, opts.message, bar, prefix)}\n`
      switch (this.state) {
        // error, initial and active all render the live list — clack's own
        // select render does the same through its default branch.
        case 'active':
        case 'error':
        case 'initial': {
          const rowPrefix = guide ? `${styleText('cyan', S_BAR)}  ` : ''
          const footer = formatInstructionFooter(instructions, guide)
          const rowPadding = header.split('\n').length + footer.length + 1
          return `${header}${rowPrefix}${limitOptions({
            columnPadding: rowPrefix.length,
            cursor: this.cursor,
            options: this.options,
            rowPadding,
            style: (option, active) =>
              row(
                option,
                option.disabled ? 'disabled' : active ? 'active' : 'inactive',
              ),
          }).join(`\n${rowPrefix}`)}
${footer.join('\n')}
`
        }
        case 'cancel': {
          const rowPrefix = guide ? `${styleText('gray', S_BAR)}  ` : ''
          const line = wrapTextWithPrefix(
            undefined,
            row(this.options[this.cursor], 'cancelled'),
            rowPrefix,
          )
          return `${header}${line}${guide ? `\n${styleText('gray', S_BAR)}` : ''}`
        }
        case 'submit': {
          const rowPrefix = guide ? `${styleText('gray', S_BAR)}  ` : ''
          // A letter can submit a row the cursor never touched, so show the
          // chosen row, not the cursor row.
          const chosen =
            this.options.find((option) => option.value === this.value) ??
            this.options[this.cursor]
          const line = wrapTextWithPrefix(
            undefined,
            row(chosen, 'selected'),
            rowPrefix,
          )
          return `${header}${line}`
        }
      }
    },
  })
  prompt.on('key', (key) => {
    if (typeof key !== 'string' || key.length !== 1) return
    const value = byLetter.get(key.toLowerCase())
    if (value === undefined) return
    prompt.value = value
    prompt.state = 'submit'
  })
  const result = await prompt.prompt()
  // clack types the abort path as undefined; a submit always carries a value
  // (ours or the cursor row's) and a cancel resolves to the cancel symbol, so
  // reaching here would be a clack contract break, not a user state.
  if (result === undefined) {
    throw new Error('letterSelect: prompt ended without a value')
  }
  return result
}

// Row renderer, mirroring @clack/prompts' select row style so the two
// prompts are visually indistinguishable apart from the letter prefixes.
type RowState = 'active' | 'cancelled' | 'disabled' | 'inactive' | 'selected'

function row(option: LetterSelectOption<string> | undefined, state: RowState) {
  if (option === undefined) return ''
  const label = option.label ?? option.value
  const hint = option.hint ? ` ${styleText('dim', `(${option.hint})`)}` : ''
  switch (state) {
    case 'active':
      return `${styleText('green', S_RADIO_ACTIVE)} ${label}${hint}`
    case 'cancelled':
      return styleLines(label, (line) =>
        styleText(['strikethrough', 'dim'], line),
      )
    case 'disabled':
      return `${styleText('gray', S_RADIO_INACTIVE)} ${styleLines(label, (line) => styleText('gray', line))}${hint}`
    case 'inactive':
      return `${styleText('dim', S_RADIO_INACTIVE)} ${styleLines(label, (line) => styleText('dim', line))}${hint}`
    case 'selected':
      return styleText('dim', label)
  }
}

// Multi-line labels need the style applied per line, or the escape codes
// break across the newline.
function styleLines(text: string, style: (line: string) => string) {
  return text.includes('\n')
    ? text.split('\n').map(style).join('\n')
    : style(text)
}
