import { createReadStream, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import { configDir, providerLabel as configProviderLabel } from './config.js'
import {
  contextUsedPercentage,
  contextWindowFromEnv,
  formatRatesPerMillion,
  type ModelRates,
  ratesFromEnv,
  sessionCostUsd,
} from './pricing.js'
import { isStandaloneBinary } from './runtime.js'

// Claude Code statusLine stdin payload (fields we actually use).
const statuslineInputSchema = z.looseObject({
  context_window: z
    .looseObject({
      // Prefer recomputing from current_usage + provider window size.
      context_window_size: z.number().optional(),
      current_usage: z
        .looseObject({
          cache_creation_input_tokens: z.number().optional(),
          cache_read_input_tokens: z.number().optional(),
          input_tokens: z.number().optional(),
        })
        .nullable()
        .optional(),
      // Claude's own % — last resort only (often wrong window for 3P models).
      used_percentage: z.number().nullable().optional(),
    })
    .optional(),
  model: z
    .looseObject({
      display_name: z.string().optional(),
      id: z.string().optional(),
    })
    .optional(),
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  workspace: z
    .looseObject({
      current_dir: z.string().optional(),
    })
    .optional(),
})

// Powerline-style separators (same glyph family as @owloops/claude-powerline).
const SEP = '\uE0B0'

// Segment colors — dark theme inspired by the powerline package the user runs.
const C = {
  context: { bg: 24, fg: 255 },
  cost: { bg: 136, fg: 236 },
  effort: { bg: 98, fg: 255 },
  model: { bg: 61, fg: 255 },
  price: { bg: 28, fg: 255 },
  provider: { bg: 31, fg: 255 },
  reset: '\x1b[0m',
  root: { bg: 238, fg: 250 },
}

interface Segment {
  bg: number
  fg: number
  text: string
}

// `eh statusline` — Claude Code invokes this with session JSON on stdin.
export async function runStatusline() {
  const raw = await readStdin()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stdout.write('eh · statusline: bad json\n')
    return
  }
  const input = statuslineInputSchema.safeParse(parsed)
  if (!input.success) {
    process.stdout.write('eh · statusline: unexpected payload\n')
    return
  }

  const provider = configProviderLabel(process.env.EH_PROVIDER ?? '?')
  const model =
    process.env.EH_MODEL ??
    input.data.model?.id ??
    input.data.model?.display_name ??
    '?'
  const effort = process.env.EH_EFFORT ?? 'auto'
  const rates = ratesFromEnv()
  const ratesLabel = formatRatesPerMillion(rates)
  const priceSeg =
    ratesLabel === 'free' || ratesLabel === '—/—'
      ? ratesLabel
      : `${ratesLabel}/M`

  const usage = input.data.transcript_path
    ? await sumTranscriptUsage(input.data.transcript_path)
    : { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
  const costLabel = sessionCostUsd(rates, usage) ?? '—'
  const ctxLabel = formatContextLabel(input.data.context_window)

  const dir = basename(input.data.workspace?.current_dir ?? process.cwd())

  const segments: Segment[] = [
    { bg: C.root.bg, fg: C.root.fg, text: dir },
    { bg: C.provider.bg, fg: C.provider.fg, text: provider },
    { bg: C.model.bg, fg: C.model.fg, text: `✱ ${shortModel(model)}` },
  ]
  if (effort !== 'auto') {
    segments.push({
      bg: C.effort.bg,
      fg: C.effort.fg,
      text: `@${effort}`,
    })
  }
  segments.push(
    { bg: C.price.bg, fg: C.price.fg, text: priceSeg },
    { bg: C.cost.bg, fg: C.cost.fg, text: `☉ ${costLabel}` },
    { bg: C.context.bg, fg: C.context.fg, text: ctxLabel },
  )

  process.stdout.write(`${renderPowerline(segments)}\n`)
}

// Write the session settings file Claude loads via --settings. Only sets
// statusLine so user/project settings still apply for everything else.
export function writeClaudeStatuslineSettings() {
  mkdirSync(configDir(), { recursive: true })
  const settingsPath = path.join(configDir(), 'claude-statusline.json')
  const settings = {
    statusLine: {
      command: ehStatuslineCommand(),
      padding: 0,
      refreshInterval: 5,
      type: 'command',
    },
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  return settingsPath
}

// Env vars the statusline reads. Prices are list rates ($/1M); context window
// is the provider's published size (not Claude's default 200k).
export function statuslineEnv(props: {
  contextWindow: number | undefined
  effort?: string
  model: string
  provider: string
  rates: ModelRates | undefined
}) {
  const env: Record<string, string> = {
    EH_MODEL: props.model,
    EH_PROVIDER: props.provider,
  }
  if (props.effort && props.effort !== 'auto') {
    env.EH_EFFORT = props.effort
  } else {
    env.EH_EFFORT = 'auto'
  }
  if (props.rates) {
    env.EH_PRICE_IN = String(props.rates.inputPerMillion)
    env.EH_PRICE_OUT = String(props.rates.outputPerMillion)
    if (props.rates.cacheReadPerMillion != null) {
      env.EH_PRICE_CACHE_READ = String(props.rates.cacheReadPerMillion)
    }
    if (props.rates.cacheWritePerMillion != null) {
      env.EH_PRICE_CACHE_WRITE = String(props.rates.cacheWritePerMillion)
    }
  }
  if (props.contextWindow != null) {
    env.EH_CONTEXT_WINDOW = String(props.contextWindow)
  }
  return env
}

function basename(p: string) {
  const parts = p.replace(/\/+$/, '').split(path.sep)
  return parts.at(-1) || p
}

// Prefer provider window (EH_CONTEXT_WINDOW) + live current_usage tokens.
// Fall back to Claude's context_window_size, then its precomputed %.
function formatContextLabel(
  window:
    | undefined
    | {
        context_window_size?: number
        current_usage?: null | {
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
          input_tokens?: number
        }
        used_percentage?: null | number
      },
) {
  const usage = window?.current_usage
  const input = num(usage?.input_tokens)
  const cacheWrite = num(usage?.cache_creation_input_tokens)
  const cacheRead = num(usage?.cache_read_input_tokens)
  const usedTokens = input + cacheWrite + cacheRead
  const size =
    contextWindowFromEnv() ??
    (typeof window?.context_window_size === 'number' &&
    window.context_window_size > 0
      ? window.context_window_size
      : undefined)

  const pct =
    usage != null
      ? contextUsedPercentage({
          cacheRead,
          cacheWrite,
          contextWindow: size,
          input,
        })
      : undefined

  if (pct != null) {
    // Match powerline-ish readability: tokens + percent when we know both.
    if (usedTokens > 0) {
      return `◔ ${formatTokenCount(usedTokens)} (${String(Math.round(pct))}%)`
    }
    return `◔ ${String(Math.round(pct))}%`
  }

  // No live usage yet (or null after compact) — show Claude's % if present.
  const fallback = window?.used_percentage
  if (fallback != null && !Number.isNaN(fallback)) {
    return `◔ ${String(Math.round(fallback))}%`
  }
  return '◔ —%'
}

function formatTokenCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// Re-invoke this binary (or tsx entry) so the statusline shares pricing logic.
function ehStatuslineCommand() {
  if (isStandaloneBinary()) {
    return `${shellQuote(process.execPath)} statusline`
  }
  // Dev: node/tsx + this entry file.
  const parts = [process.execPath, ...process.execArgv]
  if (process.argv[1]) parts.push(process.argv[1])
  parts.push('statusline')
  return parts.map(shellQuote).join(' ')
}

async function readStdin() {
  // Text mode keeps the statusline free of Buffer typing edge cases under
  // eslint's no-unsafe-argument on Readable streams.
  const chunks: string[] = []
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    chunks.push(String(chunk))
  }
  return chunks.join('')
}

function renderPowerline(segments: Segment[]) {
  return segments
    .map((seg, i) => {
      const body = `\x1b[48;5;${String(seg.bg)}m\x1b[38;5;${String(seg.fg)}m ${seg.text} `
      const isLast = i === segments.length - 1
      if (isLast) {
        return `${body}\x1b[0m\x1b[38;5;${String(seg.bg)}m${SEP}${C.reset}`
      }
      const next = segments[i + 1]
      return `${body}\x1b[48;5;${String(next.bg)}m\x1b[38;5;${String(seg.bg)}m${SEP}`
    })
    .join('')
}

function shellQuote(value: string) {
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function shortModel(id: string) {
  // Keep vendor/model but drop very long suffixes when the bar is crowded.
  if (id.length <= 40) return id
  return `${id.slice(0, 37)}…`
}

// Sum per-assistant-message usage from the Claude transcript (tokens only —
// dollar fields there use Anthropic list rates and are ignored).
// Claude invokes `eh statusline` as a fresh process each refresh, so an
// in-process cache would never hit — full rescan is the honest design.
function num(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

async function sumTranscriptUsage(transcriptPath: string) {
  const usage = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }
  try {
    const rl = createInterface({
      crlfDelay: Infinity,
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    })
    for await (const line of rl) {
      if (!line.trim()) continue
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!row || typeof row !== 'object') continue
      const rec = row as {
        message?: { usage?: Record<string, unknown> }
        type?: string
      }
      if (rec.type !== 'assistant') continue
      const u = rec.message?.usage
      if (!u) continue
      usage.input += num(u.input_tokens)
      usage.output += num(u.output_tokens)
      usage.cacheRead += num(u.cache_read_input_tokens)
      usage.cacheWrite += num(u.cache_creation_input_tokens)
    }
  } catch {
    // Missing/unreadable transcript → zeros; bar still shows rates.
  }
  return usage
}
