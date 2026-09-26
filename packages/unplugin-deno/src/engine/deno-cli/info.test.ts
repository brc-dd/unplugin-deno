import { describe, expect, it } from 'vitest'
import {
  DenoInfoFormatError,
  parseDenoInfo,
  parseDenoStderr,
  splitCacheFile,
  toMediaType,
} from './info.js'

/** Trimmed `deno info --json` output of Deno 2.9.7 (engine-basic and a data: root). */
const SAMPLE = {
  version: 1,
  roots: ['file:///p/src/main.ts'],
  modules: [
    {
      kind: 'esm',
      dependencies: [
        {
          specifier: '@std/path',
          code: {
            specifier: 'jsr:@std/path@^1',
            span: { start: { line: 0, character: 21 }, end: { line: 0, character: 32 } },
          },
        },
        {
          specifier: './types.ts',
          type: { specifier: 'file:///p/src/types.ts', resolutionMode: 'import' },
        },
        { specifier: 'nope', code: { error: 'Import "nope" not a dependency' } },
        { specifier: './lazy.ts', code: { specifier: 'file:///p/src/lazy.ts' }, isDynamic: true },
      ],
      local: '/p/src/main.ts',
      size: 364,
      mediaType: 'TypeScript',
      specifier: 'file:///p/src/main.ts',
    },
    { kind: 'esm', size: 17, mediaType: 'JavaScript', specifier: 'data:text/javascript,1' },
    { kind: 'npm', specifier: 'npm:/kleur@4.1.5', npmPackage: 'kleur@4.1.5' },
    { kind: 'node', specifier: 'node:fs', moduleName: 'fs' },
    { specifier: 'jsr:@std/path@^99', error: 'Could not find version' },
  ],
  redirects: { 'jsr:@std/path@^1': 'https://jsr.io/@std/path/1.1.6/mod.ts' },
  packages: { '@std/path@1': '@std/path@1.1.6' },
  npmPackages: {
    'kleur@4.1.5': {
      name: 'kleur',
      version: '4.1.5',
      dependencies: [],
      registryUrl: 'https://registry.npmjs.org/',
      localPath: '/cache/npm/registry.npmjs.org/kleur/4.1.5',
    },
  },
}

describe('parseDenoInfo', () => {
  it('reads the fields the engine uses and ignores the others', () => {
    const output = parseDenoInfo(JSON.stringify(SAMPLE))
    expect(output.roots).toEqual(['file:///p/src/main.ts'])
    expect(output.modules[0]).toMatchObject({
      specifier: 'file:///p/src/main.ts',
      kind: 'esm',
      local: '/p/src/main.ts',
      mediaType: 'TypeScript',
    })
    expect(output.modules[0]?.dependencies.map((dependency) => dependency.code)).toEqual([
      {
        specifier: 'jsr:@std/path@^1',
        error: undefined,
        span: { start: { line: 0, character: 21 }, end: { line: 0, character: 32 } },
      },
      undefined,
      { specifier: undefined, error: 'Import "nope" not a dependency', span: undefined },
      { specifier: 'file:///p/src/lazy.ts', error: undefined, span: undefined },
    ])
    expect(output.modules[0]?.dependencies[3]?.isDynamic).toBe(true)
    expect(output.modules[1]?.dependencies).toEqual([])
    expect(output.modules[2]?.npmPackage).toBe('kleur@4.1.5')
    expect(output.modules[4]).toMatchObject({ kind: undefined, error: 'Could not find version' })
    expect(output.redirects).toEqual(SAMPLE.redirects)
    expect(output.packages).toEqual(SAMPLE.packages)
    expect(output.npmPackages['kleur@4.1.5']).toEqual({
      id: 'kleur@4.1.5',
      name: 'kleur',
      version: '4.1.5',
      dependencies: [],
      localPath: '/cache/npm/registry.npmjs.org/kleur/4.1.5',
    })
  })

  it('defaults absent optional sections (no JSR or npm packages)', () => {
    const output = parseDenoInfo(JSON.stringify({ version: 1, roots: [], modules: [] }))
    expect(output).toEqual({
      version: 1,
      roots: [],
      modules: [],
      redirects: {},
      packages: {},
      npmPackages: {},
    })
  })

  it('names the offending field of an unexpected shape', () => {
    const invalid: Array<[unknown, RegExp]> = [
      [{ ...SAMPLE, version: 2 }, /unsupported "version" 2/],
      [{ ...SAMPLE, roots: 'x' }, /roots is not an array/],
      [{ ...SAMPLE, modules: [{ kind: 'esm' }] }, /modules\[0\]\.specifier is not a string/],
      [
        { ...SAMPLE, modules: [{ specifier: 'x', dependencies: [{ specifier: 'y', code: {} }] }] },
        /modules\[0\]\.dependencies\[0\]\.code has neither/,
      ],
      [{ ...SAMPLE, redirects: { a: 1 } }, /redirects\["a"\] is not a string/],
      [{ ...SAMPLE, npmPackages: { x: { name: 'x' } } }, /npmPackages\["x"\]\.version/],
    ]
    for (const [value, message] of invalid) {
      expect(() => parseDenoInfo(JSON.stringify(value))).toThrow(DenoInfoFormatError)
      expect(() => parseDenoInfo(JSON.stringify(value))).toThrow(message)
    }
    expect(() => parseDenoInfo('not json')).toThrow(/invalid JSON/)
    expect(() => parseDenoInfo('[]')).toThrow(/the output is not an object/)
  })
})

describe('toMediaType', () => {
  it('maps Deno’s serialised names (JSX and TSX are upper case)', () => {
    expect(toMediaType('TypeScript')).toBe('TypeScript')
    expect(toMediaType('TSX')).toBe('Tsx')
    expect(toMediaType('JSX')).toBe('Jsx')
    expect(toMediaType('Json')).toBe('Json')
    expect(toMediaType('Nope')).toBeUndefined()
    expect(toMediaType(undefined)).toBeUndefined()
  })
})

describe('parseDenoStderr', () => {
  it('collects downloads, installs, warnings and the error', () => {
    const stderr = parseDenoStderr(
      [
        'Download https://jsr.io/@std/path/meta.json',
        'Download https://registry.npmjs.org/kleur',
        'Initialize kleur@4.1.5',
        '⚠️  deno transpile is experimental and subject to changes',
        'error: Integrity check failed for remote specifier.',
        '',
        '  Specifier: https://deno.land/std@0.224.0/fmt/colors.ts',
        '  Actual: 5085',
        'Download https://not-a-progress-line-inside-the-error',
      ].join('\n'),
    )
    expect(stderr.downloads).toEqual([
      'https://jsr.io/@std/path/meta.json',
      'https://registry.npmjs.org/kleur',
    ])
    expect(stderr.installed).toEqual(['kleur@4.1.5'])
    expect(stderr.warnings).toEqual(['⚠️  deno transpile is experimental and subject to changes'])
    expect(stderr.specifiers).toEqual(['https://deno.land/std@0.224.0/fmt/colors.ts'])
    expect(stderr.error).toMatch(/^Integrity check failed for remote specifier\.\n/)
    expect(parseDenoStderr('')).toEqual({
      downloads: [],
      installed: [],
      error: '',
      specifiers: [],
      warnings: [],
    })
  })
})

describe('splitCacheFile', () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const metadata = JSON.stringify({
    headers: { 'Content-Type': 'application/typescript', etag: '"x"' },
    url: 'https://example.com/mod.ts',
    time: 1,
  })

  it('removes the trailing denoCacheMetadata line and keeps the content byte for byte', () => {
    for (const content of ['export const x = 1\n', 'export const x = 1', '', 'a\n\nb\n']) {
      const cached = splitCacheFile(encoder.encode(`${content}\n// denoCacheMetadata=${metadata}`))
      expect(cached === undefined ? undefined : decoder.decode(cached.content)).toBe(content)
      expect(cached?.headers).toEqual({ 'content-type': 'application/typescript', etag: '"x"' })
    }
  })

  it('rejects files that are not in the cache format', () => {
    for (const text of [
      'export const x = 1\n',
      `x\n// denoCacheMetadata=${metadata}\nmore`,
      'x\n// denoCacheMetadata={broken',
      'x\n// other=1',
      '',
    ]) {
      expect(splitCacheFile(encoder.encode(text))).toBeUndefined()
    }
  })
})
