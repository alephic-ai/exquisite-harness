import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { delegationSkill, EMBEDDED_SKILL, installSkill } from './skill.js'

describe('delegation skill', () => {
  test('documents ask and skill in root help', async () => {
    const child = spawn(process.execPath, ['src/main.ts', '--help'], {
      cwd: path.resolve(import.meta.dir, '..'),
    })
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.on('error', reject)
      child.on('close', () => resolve(output))
    })
    expect(stdout).toContain('ask [options] <harness> <provider> <model>')
    expect(stdout).toContain('skill')
  })

  test('keeps the embedded fallback byte-identical to the source skill', () => {
    expect(EMBEDDED_SKILL).toBe(
      readFileSync(
        path.resolve(import.meta.dir, '../skills/eh-delegate/SKILL.md'),
        'utf8',
      ),
    )
  })

  test('refuses to install through a symlink', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-skill-'))
    const target = path.join(directory, 'target')
    const destination = path.join(directory, 'SKILL.md')
    writeFileSync(target, 'target')
    symlinkSync(target, destination)
    try {
      expect(() => installSkill(directory)).toThrow('symlink')
      expect(readFileSync(target, 'utf8')).toBe('target')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('installs idempotently and refuses differing content', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-skill-'))
    try {
      installSkill(directory)
      const destination = path.join(directory, 'SKILL.md')
      expect(readFileSync(destination, 'utf8')).toBe(delegationSkill())
      installSkill(directory)
      writeFileSync(destination, 'different')
      expect(() => installSkill(directory)).toThrow('--force')
      installSkill(directory, true)
      expect(readFileSync(destination, 'utf8')).toBe(delegationSkill())
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
