import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DenoPluginError } from '../diagnostics/errors.js'
import { ensureDir, parseJsonc, readJsonc, writeFileAtomic } from './fs.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'unplugin-deno-fs-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ensureDir', () => {
  it('creates nested directories and is idempotent', async () => {
    const target = join(dir, 'a', 'b', 'c')
    await ensureDir(target)
    await ensureDir(target)
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['c'])
  })
})

describe('writeFileAtomic', () => {
  it('writes strings and bytes, creating parent directories', async () => {
    const text = join(dir, 'nested', 'mod.ts.js')
    await writeFileAtomic(text, 'export {}\n')
    expect(await readFile(text, 'utf8')).toBe('export {}\n')

    const bytes = join(dir, 'nested', 'data.bin')
    await writeFileAtomic(bytes, new Uint8Array([0, 1, 255]))
    expect([...(await readFile(bytes))]).toEqual([0, 1, 255])
  })

  it('replaces existing files and leaves no temporary files behind', async () => {
    const file = join(dir, 'manifest.json')
    await writeFile(file, 'old')
    await writeFileAtomic(file, 'new')
    expect(await readFile(file, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['manifest.json'])
  })

  it('survives concurrent writers of the same file', async () => {
    const file = join(dir, 'shared.js')
    const contents = Array.from({ length: 8 }, (_, i) => `export const n = ${i}\n`)
    await Promise.all(contents.map((content) => writeFileAtomic(file, content)))
    expect(contents).toContain(await readFile(file, 'utf8'))
    expect(await readdir(dir)).toEqual(['shared.js'])
  })

  it('cleans up the temporary file when the rename fails', async () => {
    const target = join(dir, 'occupied')
    await ensureDir(join(target, 'child'))
    await expect(writeFileAtomic(target, 'x')).rejects.toMatchObject({
      code: expect.stringMatching(/^E[A-Z]+$/),
    })
    expect(await readdir(dir)).toEqual(['occupied'])
  })
})

describe('parseJsonc', () => {
  it('accepts comments, trailing commas and a BOM', () => {
    const text = '﻿{\n  // comment\n  "imports": { "a": "jsr:@std/path@^1", },\n  /* block */\n}\n'
    expect(parseJsonc(text, 'deno.jsonc')).toEqual({ imports: { a: 'jsr:@std/path@^1' } })
  })

  it('reports the position of the first error', () => {
    const text = '{\n  "imports": {\n    "a": "b"\n    "c": "d"\n  }\n}\n'
    let error: unknown
    try {
      parseJsonc(text, '/project/deno.json')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DenoPluginError)
    expect((error as DenoPluginError).code).toBe('CONFIG_INVALID')
    expect((error as DenoPluginError).message).toBe(
      'Cannot parse /project/deno.json: CommaExpected at 4:5.',
    )
  })

  it('counts CRLF line endings once', () => {
    expect(() => parseJsonc('{\r\n"a": 1\r\n"b": 2}', 'x.json')).toThrow(/at 3:1\./)
  })

  it('uses the given error code', () => {
    expect(() => parseJsonc('{', 'deno.lock', 'LOCKFILE_INVALID')).toThrow(
      expect.objectContaining({ code: 'LOCKFILE_INVALID' }),
    )
  })

  it('rejects empty content', () => {
    expect(() => parseJsonc('', 'deno.json')).toThrow(DenoPluginError)
  })
})

describe('readJsonc', () => {
  it('reads and parses a file', async () => {
    const file = join(dir, 'deno.jsonc')
    await writeFile(file, '{ "name": "@scope/pkg", // trailing\n}')
    expect(await readJsonc(file)).toEqual({ name: '@scope/pkg' })
  })

  it('passes file system errors through', async () => {
    await expect(readJsonc(join(dir, 'missing.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
