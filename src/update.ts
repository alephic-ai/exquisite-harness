import { execFile } from 'node:child_process'
import { chmod, open, realpath, rename, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { z } from 'zod'

import pkg from '../package.json' with { type: 'json' }
import { isStandaloneBinary } from './runtime.js'
import { log, spinner } from './ui/output.js'

const execFileAsync = promisify(execFile)

const RELEASE_OWNER = 'alephic-ai'
const RELEASE_REPO = 'exquisite-harness'
const TAG_PREFIX = 'eh-v'
const USER_AGENT = 'eh'
const API_BASE = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}`
// Bound the release metadata lookups so a hung network can't stall `eh update`.
const RELEASE_CHECK_TIMEOUT_MS = 5000
// The download has no overall deadline (a big binary on a slow link is fine),
// but a connection that goes silent must eventually fail instead of spinning
// forever. Abort if no bytes arrive within this window; the timer resets on
// every chunk, so only a genuinely stalled socket trips it.
const DOWNLOAD_STALL_TIMEOUT_MS = 30_000

const releaseListSchema = z.array(z.object({ tag_name: z.string() }))
const releaseSchema = z.object({
  assets: z.array(
    z.object({ name: z.string(), size: z.number(), url: z.string() }),
  ),
})

// Releases are plain X.Y.Z — check-version-guard.sh rejects anything else
// before it can ship, so a numeric compare is sufficient (and correct for
// multi-digit segments, unlike a string compare).
function isNewerVersion(current: string, latest: string) {
  const c = parseVersion(current)
  const l = parseVersion(latest)
  if (!c || !l) return false
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i]
  }
  return false
}

function parseVersion(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const
}

// Take the semver max, not the first match: GitHub's release list order is
// not version order, so trusting it can claim "already up to date" on an old
// binary.
function detectPlatform() {
  const { arch, platform } = process
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported architecture: ${arch}`)
  }
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Unsupported platform: ${platform}`)
  }
  return { asset: `eh-${platform}-${arch}`, isMacOS: platform === 'darwin' }
}

async function getGitHubToken() {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'])
    const token = stdout.trim()
    if (!token) throw new Error('empty token')
    return token
  } catch {
    throw new Error(
      'Could not get a GitHub token. Install the GitHub CLI and run `gh auth login`.',
    )
  }
}

function pickLatestVersion(tags: string[]) {
  let best: string | undefined
  for (const tag of tags) {
    if (!tag.startsWith(TAG_PREFIX)) continue
    const version = tag.slice(TAG_PREFIX.length)
    if (parseVersion(version) && (!best || isNewerVersion(best, version))) {
      best = version
    }
  }
  return best
}

// Every metadata request is bounded so a hung network can't stall the command.
async function apiFetch(path: string, token: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'accept': 'application/vnd.github+json',
      'authorization': `token ${token}`,
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(RELEASE_CHECK_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `GitHub API ${path}: ${response.status} ${response.statusText}`,
    )
  }
  return response.json()
}

async function downloadAssetToFile({
  asset,
  onProgress,
  stagedPath,
  token,
}: {
  asset: { name: string; size: number; url: string }
  onProgress: (downloaded: number, total: number) => void
  stagedPath: string
  token: string
}) {
  // Reset on every chunk; if it ever fires, the socket has gone silent and we
  // abort the in-flight fetch so the read loop rejects instead of hanging.
  const stall = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armStallTimer = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stall.abort(), DOWNLOAD_STALL_TIMEOUT_MS)
  }

  try {
    armStallTimer()
    // Raw fetch: GitHub 302-redirects the asset URL to a signed S3 URL and the
    // auth header is stripped cross-origin on the way. Streaming keeps a
    // ~90 MB binary out of memory and lets us report byte progress.
    const response = await fetch(asset.url, {
      headers: {
        'accept': 'application/octet-stream',
        'authorization': `token ${token}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
      },
      signal: stall.signal,
    })
    // The fetch types don't narrow `body` through the null check below, so
    // pin it once — everything downstream (reader, chunk lengths) stays typed.
    const body = response.body as null | ReadableStream<Uint8Array>
    if (!response.ok || !body) {
      throw new Error(
        `Failed to download ${asset.name}: ${response.status} ${response.statusText}.`,
      )
    }
    const total =
      asset.size || Number(response.headers.get('content-length')) || 0
    const handle = await open(stagedPath, 'w')
    try {
      const reader = body.getReader()
      let downloaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armStallTimer()
        await handle.write(value)
        downloaded += value.length
        onProgress(downloaded, total)
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    // A partial download is removed so it can't be promoted later.
    await rm(stagedPath, { force: true })
    if (stall.signal.aborted) {
      throw new Error(
        `Download of ${asset.name} stalled — no data for ${DOWNLOAD_STALL_TIMEOUT_MS / 1000}s.`,
        { cause: error },
      )
    }
    throw error
  } finally {
    if (stallTimer !== undefined) clearTimeout(stallTimer)
  }
}

async function findLatestVersion(token: string) {
  // Walk every page: the list order from GitHub is not version order, so the
  // true latest can sit anywhere in the list.
  const tags: string[] = []
  for (let page = 1; ; page++) {
    const releases = releaseListSchema.parse(
      await apiFetch(`/releases?per_page=100&page=${page}`, token),
    )
    tags.push(...releases.map((r) => r.tag_name))
    if (releases.length < 100) break
  }
  return pickLatestVersion(tags)
}

// The download writes a sibling of the destination on the same filesystem, so
// the final rename is atomic — a crash mid-update can't leave a truncated
// `eh` on $PATH.
export async function runUpdate() {
  if (!isStandaloneBinary()) {
    // Fires before the spinner exists, so report explicitly — the action
    // swallows the throw assuming a failure was already surfaced.
    log.error(
      '`eh update` only works on the installed binary, not when running from source (pnpm dev / tsx).',
    )
    throw new Error('not a standalone binary')
  }
  // One spinner drives the whole flow: it animates on a TTY and degrades to
  // plain status lines when piped. On any failure we mark it stopped with the
  // message and rethrow so the caller can still set a non-zero exit code.
  const s = spinner()
  s.start('checking for the latest eh release …')
  try {
    const token = await getGitHubToken()
    const latest = await findLatestVersion(token)
    if (!latest) {
      throw new Error(
        `No released eh version found on GitHub (${RELEASE_OWNER}/${RELEASE_REPO}).`,
      )
    }

    const current = pkg.version
    if (!isNewerVersion(current, latest)) {
      s.stop(`eh is already up to date (v${current})`)
      return
    }

    const { asset: assetName, isMacOS } = detectPlatform()
    s.message(`resolving eh v${latest} (${assetName}) …`)
    const release = releaseSchema.parse(
      await apiFetch(`/releases/tags/${TAG_PREFIX}${latest}`, token),
    )
    const asset = release.assets.find((entry) => entry.name === assetName)
    if (!asset) {
      throw new Error(
        `Release ${TAG_PREFIX}${latest} has no asset named ${assetName}.`,
      )
    }

    // Resolve symlinks so the staged temp and the atomic rename land on the
    // real binary's filesystem.
    const destPath = await realpath(process.execPath)
    const stagedPath = `${destPath}.staged`

    const mb = (n: number) => (n / 1e6).toFixed(1)
    s.message(`downloading eh v${latest} …`)
    await downloadAssetToFile({
      asset,
      onProgress: (downloaded, total) => {
        if (total) {
          s.message(
            `downloading eh v${latest} … ${Math.floor((downloaded / total) * 100)}% (${mb(downloaded)}/${mb(total)} MB)`,
          )
        }
      },
      stagedPath,
      token,
    })

    s.message(`installing eh v${latest} …`)
    await installStagedBinary({ destPath, isMacOS, stagedPath })
    s.stop(`updated eh to v${latest}`)
  } catch (error) {
    // clack's spinner.stop takes only the message in this version — the
    // message text and the caller's non-zero exit carry the failure.
    s.stop(error instanceof Error ? error.message : 'eh update failed')
    throw error
  }
}

async function installStagedBinary({
  destPath,
  isMacOS,
  stagedPath,
}: {
  destPath: string
  isMacOS: boolean
  stagedPath: string
}) {
  try {
    await chmod(stagedPath, 0o755)
    if (isMacOS) {
      // Best-effort: clear Gatekeeper quarantine so `eh` runs without a
      // prompt. Exits non-zero when the attribute is absent — ignore it.
      await execFileAsync('xattr', [
        '-d',
        'com.apple.quarantine',
        stagedPath,
      ]).catch(() => undefined)
    }
    await rename(stagedPath, destPath)
  } catch (error) {
    await rm(stagedPath, { force: true })
    throw error
  }
}
