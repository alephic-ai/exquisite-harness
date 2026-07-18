import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

import type { ModelInfo } from './types.js'

import { cachePath, configDir } from './config.js'

const cacheSchema = z.record(
  z.string(),
  z.object({
    fetchedAt: z.number(),
    models: z.array(z.object({ hint: z.string().optional(), id: z.string() })),
  }),
)

interface CacheEntry {
  fetchedAt: number
  models: ModelInfo[]
}

const TTL_MS = 5 * 60 * 1000

// A Map keeps lookups honestly typed as `CacheEntry | undefined` — Record
// indexing without noUncheckedIndexedAccess would lie about that.
export function cachedModels(provider: string) {
  return readCache().get(provider)?.models
}

export function freshModels(provider: string) {
  const entry = readCache().get(provider)
  if (!entry || Date.now() - entry.fetchedAt > TTL_MS) return undefined
  return entry.models
}

export function writeModels(provider: string, models: ModelInfo[]) {
  try {
    mkdirSync(configDir(), { recursive: true })
    const cache = readCache()
    cache.set(provider, { fetchedAt: Date.now(), models })
    writeFileSync(
      cachePath(),
      `${JSON.stringify(Object.fromEntries(cache), null, 2)}\n`,
    )
  } catch {
    // A cache we cannot write is a cache we do not need.
  }
}

function readCache() {
  try {
    const parsed = cacheSchema.safeParse(
      JSON.parse(readFileSync(cachePath(), 'utf8')),
    )
    return parsed.success
      ? new Map(Object.entries<CacheEntry>(parsed.data))
      : new Map<string, CacheEntry>()
  } catch {
    return new Map<string, CacheEntry>()
  }
}
