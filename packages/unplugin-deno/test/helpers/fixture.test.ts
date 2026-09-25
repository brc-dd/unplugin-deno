import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { fixturesDir, loadFixture } from './fixture.js'
import { tempProject } from './temp-project.js'

describe('loadFixture', () => {
  it('reads fixture.json', async () => {
    const fixture = await loadFixture('smoke-jsr-npm')
    expect(fixture.dir).toBe(join(fixturesDir, 'smoke-jsr-npm'))
    expect(fixture.manifest.entries).toEqual(['src/main.ts'])
    expect(fixture.manifest.hosts).toEqual([])
  })

  it.each([
    ['{"title": "x", "entries": [], "hosts": []}', /"entries" must be a non-empty array/],
    ['{"title": "x", "entries": ["a.ts"], "hosts": ["parcel"]}', /"hosts" must be an array of/],
    ['{"entries": ["a.ts"], "hosts": []}', /"title" must be a non-empty string/],
    [
      '{"title": "x", "entries": ["a.ts"], "hosts": [], "expect": []}',
      /"expect" must be an object/,
    ],
    ['[]', /expected an object/],
  ])('rejects %s', async (json, message) => {
    const root = await mkdtemp(join(tmpdir(), 'unplugin-deno-fixtures-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'bad'))
    await writeFile(join(root, 'bad', 'fixture.json'), json)
    await expect(loadFixture('bad', root)).rejects.toThrow(message)
  })
})

describe('tempProject', () => {
  it('copies the fixture outside the repository and removes the copy on dispose', async () => {
    const project = await tempProject('smoke-jsr-npm')
    try {
      expect(project.root.startsWith(fixturesDir)).toBe(false)
      expect(project.path('src/main.ts')).toBe(join(project.root, 'src', 'main.ts'))
      expect(project.url('src/main.ts')).toMatch(/^file:\/\/\/.*\/src\/main\.ts$/)
      expect(await readFile(project.path('deno.json'), 'utf8')).toContain('jsr:@std/path@^1')
      expect(await readFile(project.path('deno.lock'), 'utf8')).toContain('"version": "5"')
    } finally {
      await project.dispose()
    }
    await expect(access(project.root)).rejects.toMatchObject({ code: 'ENOENT' })
    await project.dispose()
  })
})
