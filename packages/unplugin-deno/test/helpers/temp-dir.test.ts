import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixturesDir } from './fixture.js'
import { flattenImportMapCases, loadImportMapCases } from './import-map-data.js'
import { tempDir } from './temp-dir.js'

describe('tempDir', () => {
  it('writes files, JSON and directories and removes them on dispose', async () => {
    const dir = await tempDir({
      'a/b.txt': 'text',
      'c/deno.json': { imports: { x: './x.ts' } },
      'empty/': null,
    })
    try {
      expect(dir.root.startsWith(join(fixturesDir, '..'))).toBe(false)
      expect(await readFile(dir.path('a/b.txt'), 'utf8')).toBe('text')
      expect(JSON.parse(await readFile(dir.path('c', 'deno.json'), 'utf8'))).toEqual({
        imports: { x: './x.ts' },
      })
      expect((await stat(dir.path('empty'))).isDirectory()).toBe(true)
      await dir.write({ 'a/more.txt': 'more' })
      expect(await readFile(dir.path('a/more.txt'), 'utf8')).toBe('more')
      expect(dir.url('a/b.txt')).toMatch(/^file:\/\/\/.*\/a\/b\.txt$/)
      expect(dir.url('a/')).toMatch(/^file:\/\/\/.*\/a\/$/)
      expect(dir.url()).toMatch(/\/$/)
    } finally {
      await dir.dispose()
    }
    await expect(access(dir.root)).rejects.toMatchObject({ code: 'ENOENT' })
    await dir.dispose()
  })
})

describe('import-map data', () => {
  it('flattens nested tests with inherited fields and joined names', () => {
    const cases = flattenImportMapCases('x.json', {
      name: 'Root',
      importMapBaseURL: 'https://base.example/',
      importMap: { imports: {} },
      tests: {
        parse: {
          expectedParsedImportMap: null,
          tests: { a: { importMap: 1 }, b: { importMap: [] } },
        },
        resolve: { baseURL: 'https://base.example/app.mjs', expectedResults: { x: null } },
        expanded: { expandImports: true, expectedResults: { y: 'https://y/' } },
      },
    })
    expect(cases).toEqual([
      {
        file: 'x.json',
        name: 'Root: parse: a',
        importMap: 1,
        importMapBaseURL: 'https://base.example/',
        expandImports: false,
        expectedParsedImportMap: null,
      },
      {
        file: 'x.json',
        name: 'Root: parse: b',
        importMap: [],
        importMapBaseURL: 'https://base.example/',
        expandImports: false,
        expectedParsedImportMap: null,
      },
      {
        file: 'x.json',
        name: 'Root: resolve',
        importMap: { imports: {} },
        importMapBaseURL: 'https://base.example/',
        expandImports: false,
        baseURL: 'https://base.example/app.mjs',
        expectedResults: { x: null },
      },
      {
        file: 'x.json',
        name: 'Root: expanded',
        importMap: { imports: {} },
        importMapBaseURL: 'https://base.example/',
        expandImports: true,
        expectedResults: { y: 'https://y/' },
      },
    ])
  })

  it('rejects leaves without expectations or base URL', () => {
    expect(() => flattenImportMapCases('x.json', { importMapBaseURL: 'https://b/' })).toThrow(
      /no expectations/,
    )
    expect(() => flattenImportMapCases('x.json', { expectedResults: {} })).toThrow(
      /no importMapBaseURL/,
    )
    expect(() => flattenImportMapCases('x.json', null)).toThrow(/expected an object/)
  })

  it('loads the vendored data sets', () => {
    expect(loadImportMapCases('wpt-import-maps').length).toBeGreaterThan(50)
    expect(loadImportMapCases('deno-import-map').length).toBeGreaterThan(5)
  })
})
