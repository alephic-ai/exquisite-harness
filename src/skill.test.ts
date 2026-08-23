import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { delegationSkill, installSkill } from './skill.js'

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
    expect(stdout).toMatch(/^\s+skill\s+print or install/m)
  })

  test('prints the checked-in skill byte-identically', () => {
    expect(delegationSkill()).toBe(
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

  test('refuses to install through an intermediate symlink', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'eh-skill-'))
    const target = path.join(directory, 'target')
    const link = path.join(directory, 'link')
    mkdirSync(target)
    symlinkSync(target, link)
    try {
      expect(() => installSkill(path.join(link, 'nested'))).toThrow('symlink')
      expect(existsSync(path.join(target, 'nested', 'SKILL.md'))).toBe(false)
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
