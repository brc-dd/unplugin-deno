import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import { toFileUrl } from '../utils/path.js'
import { normalizeEntries } from './entries.js'

describe('normalizeEntries', () => {
  const posix = { flavor: 'posix' as const, isFile: (path: string) => path === '/proj/src/main.ts' }

  it('accepts a string, an array and a record, keeping order without duplicates', () => {
    expect(normalizeEntries('./src/main.ts', '/proj', posix)).toEqual(['file:///proj/src/main.ts'])
    expect(normalizeEntries(['/a.ts', '/b.ts', '/a.ts'], '/proj', posix)).toEqual([
      'file:///a.ts',
      'file:///b.ts',
    ])
    expect(normalizeEntries({ main: 'src/main.ts', other: './x.ts' }, '/proj', posix)).toEqual([
      'file:///proj/src/main.ts',
      'file:///proj/x.ts',
    ])
    expect(normalizeEntries(undefined, '/proj', posix)).toEqual([])
    expect(normalizeEntries(null, '/proj', posix)).toEqual([])
  })

  it('keeps specifiers and maps existing root-relative files to URLs', () => {
    expect(
      normalizeEntries(
        [
          'src/main.ts',
          '@app/entry',
          'jsr:@std/path@^1',
          'npm:kleur@4',
          'https://deno.land/x/mod.ts?x=1',
          'data:text/javascript,1',
          'file:///proj/a.ts',
          '../up.ts',
        ],
        '/proj',
        posix,
      ),
    ).toEqual([
      'file:///proj/src/main.ts',
      '@app/entry',
      'jsr:@std/path@^1',
      'npm:kleur@4',
      'https://deno.land/x/mod.ts?x=1',
      'data:text/javascript,1',
      'file:///proj/a.ts',
      'file:///up.ts',
    ])
  })

  it('skips virtual ids, other schemes and empty strings', () => {
    expect(
      normalizeEntries(['\0x', 'virtual:x', 'node:fs', 'bun:test', 'mailto:x', ''], '/proj', posix),
    ).toEqual([])
  })

  it('handles Windows paths', () => {
    const win32 = {
      flavor: 'win32' as const,
      isFile: (path: string) => path === 'C:\\proj\\src\\main.ts',
    }
    expect(
      normalizeEntries(
        ['C:\\proj\\a.ts', 'src\\main.ts', '.\\b.ts', 'c:/proj/c.ts'],
        'C:\\proj',
        win32,
      ),
    ).toEqual([
      'file:///C:/proj/a.ts',
      'file:///C:/proj/src/main.ts',
      'file:///C:/proj/b.ts',
      'file:///C:/proj/c.ts',
    ])
  })

  it('checks the file system by default', async () => {
    const dir = await tempDir({ 'src/main.ts': 'export {}' })
    onTestFinished(() => dir.dispose())
    expect(normalizeEntries(['src/main.ts', 'src/missing.ts'], dir.root)).toEqual([
      toFileUrl(dir.path('src/main.ts')),
      'src/missing.ts',
    ])
  })
})
