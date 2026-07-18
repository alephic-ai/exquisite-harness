#!/usr/bin/env bun
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

const pkgRoot = import.meta.dir
const outDir = path.join(pkgRoot, 'release')
const entryPath = path.join(pkgRoot, 'src', 'main.ts')

// Same matrix as ax (tools/main pkgs/alephix/build.ts). `bun-linux-x64-modern`
// needs a post-2013 x86 CPU — same trade-off ax made.
const TARGETS = [
  { arch: 'arm64', bun: 'bun-darwin-arm64', platform: 'darwin' },
  { arch: 'x64', bun: 'bun-darwin-x64', platform: 'darwin' },
  { arch: 'arm64', bun: 'bun-linux-arm64', platform: 'linux' },
  { arch: 'x64', bun: 'bun-linux-x64-modern', platform: 'linux' },
] satisfies readonly {
  arch: string
  bun: Bun.Build.CompileTarget
  platform: string
}[]

async function buildTarget(target: (typeof TARGETS)[number]) {
  const outfile = path.join(outDir, `eh-${target.platform}-${target.arch}`)
  process.stdout.write(
    `\n→ Building ${target.platform}-${target.arch} (${target.bun})\n`,
  )
  const result = await Bun.build({
    bytecode: false, // true adds ~70M to the binary and only makes it ~8ms faster
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
      outfile,
      target: target.bun,
    },
    entrypoints: [entryPath],
    minify: true,
    // Inline so runtime stack traces map back to original TS source positions
    // (otherwise `minify: true` would leave traces pointing at unreadable
    // mangled output). Baked into the binary — no external `.map` to ship.
    sourcemap: 'inline',
    target: 'bun',
  })
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log.message}\n`)
    throw new Error(`Build failed for ${target.platform}-${target.arch}`)
  }
}

async function main() {
  await rm(outDir, { force: true, recursive: true })
  await mkdir(outDir, { recursive: true })

  try {
    for (const target of TARGETS) await buildTarget(target)
  } finally {
    // Bun's `compile` drops intermediate `.bun-build` scratch files in the
    // package root and doesn't always clean them up; they're large binaries
    // that would otherwise leak into git. Remove them even when a build fails.
    const scratch = (await readdir(pkgRoot)).filter((f) =>
      f.endsWith('.bun-build'),
    )
    for (const file of scratch) {
      await rm(path.join(pkgRoot, file), { force: true })
    }
    // `compile` also leaks an external `main.js.map` into the out dir even
    // with `sourcemap: 'inline'` — the release glob is `eh-*` so it would
    // never ship, but keep the dir to binaries only.
    const maps = (await readdir(outDir)).filter((f) => f.endsWith('.js.map'))
    for (const file of maps) {
      await rm(path.join(outDir, file), { force: true })
    }
  }

  process.stdout.write(`\nBinaries written to ${outDir}\n`)
}

await main()
