import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempDir } from '../../test/helpers/temp-dir.js'
import { DenoPluginError } from '../diagnostics/errors.js'
import { toFileUrl } from '../utils/path.js'
import type { DenoConfig } from './deno-config.js'
import {
  DEFAULT_MINIMUM_DEPENDENCY_AGE_MINUTES,
  jsxSettings,
  memberConfigWarnings,
  normalizeExports,
  normalizeLinks,
  normalizeLock,
  normalizeNodeModulesDir,
  normalizeWorkspace,
  parseDenoConfig,
  readDenoConfig,
  resolveConfigPath,
  resolveMinimumDependencyAge,
  validateExports,
} from './deno-config.js'

function errorOf(run: () => unknown): DenoPluginError {
  try {
    run()
  } catch (error) {
    if (error instanceof DenoPluginError) return error
    throw error
  }
  throw new Error('expected an error')
}

describe('parseDenoConfig', () => {
  it('reads the fields the plugin uses and ignores the rest', () => {
    const config = parseDenoConfig(
      JSON.stringify({
        name: '@scope/pkg',
        version: '1.0.0',
        exports: { '.': './mod.ts' },
        imports: { a: './a.ts', b: 1 },
        scopes: { './s/': { a: './s-a.ts' } },
        importMap: './import_map.json',
        workspace: ['./packages/*'],
        links: ['../linked'],
        patch: ['../old'],
        nodeModulesDir: 'auto',
        nodeModulesLinker: 'hoisted',
        jsrDepsInNodeModules: true,
        vendor: true,
        lock: { path: './locks/deno.lock', frozen: true },
        compilerOptions: {
          jsx: 'precompile',
          jsxImportSource: 'preact',
          jsxImportSourceTypes: 'preact',
          jsxFactory: 'h',
          jsxFragmentFactory: 'Fragment',
          jsxPrecompileSkipElements: ['a'],
          types: ['./types.d.ts'],
          strict: true,
        },
        unstable: ['raw-imports'],
        exclude: ['dist'],
        minimumDependencyAge: { age: 'P2D', exclude: ['npm:react'] },
        catalog: { react: '^19.0.0' },
        catalogs: { legacy: { react: '^18.0.0' } },
        tasks: { dev: 'vite' },
        fmt: { lineWidth: 100 },
      }),
      '/p/deno.json',
    )
    expect(config).toEqual({
      name: '@scope/pkg',
      version: '1.0.0',
      exports: { '.': './mod.ts' },
      imports: { a: './a.ts', b: 1 },
      scopes: { './s/': { a: './s-a.ts' } },
      importMap: './import_map.json',
      workspace: ['./packages/*'],
      links: ['../linked'],
      patch: ['../old'],
      nodeModulesDir: 'auto',
      nodeModulesLinker: 'hoisted',
      jsrDepsInNodeModules: true,
      vendor: true,
      lock: { path: './locks/deno.lock', frozen: true },
      compilerOptions: {
        jsx: 'precompile',
        jsxImportSource: 'preact',
        jsxImportSourceTypes: 'preact',
        jsxFactory: 'h',
        jsxFragmentFactory: 'Fragment',
        jsxPrecompileSkipElements: ['a'],
        types: ['./types.d.ts'],
      },
      unstable: ['raw-imports'],
      exclude: ['dist'],
      minimumDependencyAge: { age: 'P2D', exclude: ['npm:react'] },
      catalog: { react: '^19.0.0' },
      catalogs: { legacy: { react: '^18.0.0' } },
    })
  })

  it('accepts comments, trailing commas, a BOM, null values and an empty file', () => {
    const text =
      '\uFEFF{\n  // comment\n  "imports": { "a": "./a.ts", },\n  "name": null,\n  /* x */\n}\n'
    expect(parseDenoConfig(text, 'deno.jsonc')).toEqual({ imports: { a: './a.ts' } })
    expect(parseDenoConfig('', 'deno.json')).toEqual({})
    expect(parseDenoConfig('  \n', 'deno.json')).toEqual({})
  })

  it('accepts both workspace forms and legacy nodeModulesDir booleans', () => {
    expect(parseDenoConfig('{"workspace": {"members": ["./a"]}}', 'x').workspace).toEqual({
      members: ['./a'],
    })
    expect(parseDenoConfig('{"workspace": {}}', 'x').workspace).toEqual({})
    expect(parseDenoConfig('{"nodeModulesDir": false}', 'x').nodeModulesDir).toBe(false)
    expect(parseDenoConfig('{"lock": false}', 'x').lock).toBe(false)
    expect(parseDenoConfig('{"lock": "./x.lock"}', 'x').lock).toBe('./x.lock')
    expect(parseDenoConfig('{"exports": "./mod.ts"}', 'x').exports).toBe('./mod.ts')
    expect(parseDenoConfig('{"minimumDependencyAge": 0}', 'x').minimumDependencyAge).toBe(0)
  })

  it.each([
    ['[]', '/p/deno.json:1:1: The config must be a JSON object.'],
    ['{\n  "name": 5\n}', '/p/deno.json:2:11: "name" must be a string.'],
    ['{"imports": []}', '/p/deno.json:1:13: "imports" must be an object.'],
    ['{"scopes": {"./a/": "x"}}', '/p/deno.json:1:21: "scopes../a/" must be an object.'],
    ['{"workspace": [1]}', '/p/deno.json:1:16: "workspace.0" must be a string.'],
    [
      '{"workspace": "x"}',
      '/p/deno.json:1:15: "workspace" must be an array of strings or { "members": [...] }.',
    ],
    [
      '{"nodeModulesDir": "yes"}',
      '/p/deno.json:1:20: "nodeModulesDir" must be one of "auto", "manual", "none".',
    ],
    ['{"lock": {"frozen": "yes"}}', '/p/deno.json:1:21: "lock.frozen" must be a boolean.'],
    [
      '{"compilerOptions": {"jsx": "vue"}}',
      '/p/deno.json:1:29: "compilerOptions.jsx" must be one of "preserve", "react", "react-jsx", "react-jsxdev", "react-native", "precompile".',
    ],
    ['{"exports": 1}', '/p/deno.json:1:13: "exports" must be a string or an object.'],
    [
      '{"minimumDependencyAge": []}',
      '/p/deno.json:1:26: "minimumDependencyAge" must be a number, a string, false or { "age", "exclude" }.',
    ],
    ['{"catalogs": {"a": {"b": 1}}}', '/p/deno.json:1:26: "catalogs.a.b" must be a string.'],
    ['{"vendor": 1}', '/p/deno.json:1:12: "vendor" must be a boolean.'],
  ])('rejects %j with its position', (text, message) => {
    const error = errorOf(() => parseDenoConfig(text, '/p/deno.json'))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toBe(message)
    expect(error.hint).toContain('docs.deno.com')
  })

  it('reports syntax errors with line and column', () => {
    const error = errorOf(() =>
      parseDenoConfig('{\n  "imports": {\n    "a": "b"\n    "c": "d"\n  }\n}', 'deno.jsonc'),
    )
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toBe('Cannot parse deno.jsonc: CommaExpected at 4:5.')
  })
})

describe('readDenoConfig', () => {
  let dir: TempDir

  beforeEach(async () => {
    dir = await tempDir({
      'deno.jsonc': '{ "imports": { "a": "./a.ts", }, }',
      'bad.json': '{ "name": 1 }',
    })
  })

  afterEach(() => dir.dispose())

  it('reads a file', async () => {
    expect(await readDenoConfig(dir.path('deno.jsonc'))).toEqual({ imports: { a: './a.ts' } })
  })

  it('maps a missing file to CONFIG_NOT_FOUND', async () => {
    await expect(readDenoConfig(dir.path('missing.json'))).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
      message: `Cannot find ${dir.path('missing.json')}.`,
    })
    await expect(readDenoConfig(join(dir.path('deno.jsonc'), 'x.json'))).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
    })
  })

  it('maps other read errors and invalid content to CONFIG_INVALID', async () => {
    await expect(readDenoConfig(dir.root)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await expect(readDenoConfig(dir.path('bad.json'))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: `${dir.path('bad.json')}:1:11: "name" must be a string.`,
    })
  })
})

describe('normalisation helpers', () => {
  it('normalizeNodeModulesDir maps the legacy booleans', () => {
    expect(normalizeNodeModulesDir(true)).toBe('auto')
    expect(normalizeNodeModulesDir(false)).toBe('none')
    expect(normalizeNodeModulesDir('manual')).toBe('manual')
    expect(normalizeNodeModulesDir(undefined)).toBeUndefined()
  })

  it('normalizeWorkspace reads both forms', () => {
    expect(normalizeWorkspace({ workspace: ['./a'] })).toEqual(['./a'])
    expect(normalizeWorkspace({ workspace: { members: ['./b'] } })).toEqual(['./b'])
    expect(normalizeWorkspace({ workspace: {} })).toEqual([])
    expect(normalizeWorkspace({})).toBeUndefined()
  })

  it('normalizeLinks prefers links over the deprecated patch', () => {
    expect(normalizeLinks({ links: ['../a'], patch: ['../b'] })).toEqual({
      links: ['../a'],
      deprecatedPatch: false,
    })
    expect(normalizeLinks({ patch: ['../b'] })).toEqual({ links: ['../b'], deprecatedPatch: true })
    expect(normalizeLinks({})).toEqual({ links: [], deprecatedPatch: false })
  })

  it('normalizeExports turns a root export into a map', () => {
    expect(normalizeExports('./mod.ts')).toEqual({ '.': './mod.ts' })
    expect(normalizeExports({ '.': './mod.ts', './x': './x.ts', './bad': 1 })).toEqual({
      '.': './mod.ts',
      './x': './x.ts',
    })
    expect(normalizeExports(undefined)).toEqual({})
  })

  it.each<[DenoConfig['exports'], string | undefined]>([
    ['./mod.ts', undefined],
    [{ '.': './mod.ts', './sub/path': './sub.tsx' }, undefined],
    [undefined, undefined],
    ['mod.ts', 'the "." export "mod.ts" must start with "./"'],
    ['./dir/', 'the "." export "./dir/" must not end with "/"'],
    ['./mod', 'the "." export "./mod" must have a file extension'],
    [{ '': './mod.ts' }, 'an export name must not be empty (use "." for the root export)'],
    [{ sub: './mod.ts' }, 'the export name "sub" must start with "./"'],
    [{ './sub/': './mod.ts' }, 'the export name "./sub/" must not end with "/"'],
    [{ './a b': './mod.ts' }, 'the export name "./a b" has invalid characters'],
    [{ './a//b': './mod.ts' }, 'the export name "./a//b" has empty or dot-only segments'],
    [{ './..': './mod.ts' }, 'the export name "./.." has empty or dot-only segments'],
    [{ '.': { import: './mod.ts' } }, 'the "." export must be a string'],
  ])('validateExports(%j)', (exports, expected) => {
    expect(validateExports(exports)).toBe(expected)
  })

  it('normalizeLock resolves paths against the config directory', () => {
    const configPath = resolve('/p/deno.json')
    expect(normalizeLock({}, configPath)).toEqual({
      enabled: true,
      path: resolve('/p/deno.lock'),
      frozen: false,
    })
    expect(normalizeLock({ lock: false }, configPath)).toEqual({
      enabled: false,
      path: null,
      frozen: false,
    })
    expect(normalizeLock({ lock: true }, configPath).path).toBe(resolve('/p/deno.lock'))
    expect(normalizeLock({ lock: './locks/x.lock' }, configPath).path).toBe(
      resolve('/p/locks/x.lock'),
    )
    expect(normalizeLock({ lock: { frozen: true } }, configPath)).toEqual({
      enabled: true,
      path: resolve('/p/deno.lock'),
      frozen: true,
    })
    expect(normalizeLock({ lock: { path: '../y.lock' } }, configPath).path).toBe(resolve('/y.lock'))
  })

  it('resolveConfigPath handles relative paths, absolute paths and file: URLs', () => {
    const base = resolve('/p/q')
    expect(resolveConfigPath(base, './x.json')).toBe(resolve('/p/q/x.json'))
    expect(resolveConfigPath(base, '../x.json')).toBe(resolve('/p/x.json'))
    expect(resolveConfigPath(base, resolve('/abs/x.json'))).toBe(resolve('/abs/x.json'))
    expect(resolveConfigPath(base, toFileUrl(resolve('/abs/x y.json')))).toBe(
      resolve('/abs/x y.json'),
    )
  })

  it('jsxSettings applies Deno defaults', () => {
    expect(jsxSettings(undefined)).toEqual({
      jsx: 'react',
      importSource: undefined,
      importSourceTypes: undefined,
      factory: 'React.createElement',
      fragmentFactory: 'React.Fragment',
      precompileSkipElements: undefined,
    })
    expect(
      jsxSettings({
        compilerOptions: {
          jsx: 'precompile',
          jsxImportSource: 'preact',
          jsxPrecompileSkipElements: ['a'],
        },
      }),
    ).toMatchObject({ jsx: 'precompile', importSource: 'preact', precompileSkipElements: ['a'] })
  })

  it('memberConfigWarnings lists root-only fields (verified with Deno 2.9.7)', () => {
    expect(
      memberConfigWarnings({
        importMap: './im.json',
        nodeModulesDir: 'auto',
        lock: false,
        vendor: true,
        unstable: ['raw-imports'],
        links: ['../x'],
        scopes: {},
        compilerOptions: { jsx: 'precompile' },
        exclude: ['dist'],
        imports: {},
      }),
    ).toEqual([
      'The "importMap" field can only be specified in the workspace root deno.json file.',
      'The "lock" field can only be specified in the workspace root deno.json file.',
      'The "nodeModulesDir" field can only be specified in the workspace root deno.json file.',
      'The "links" field can only be specified in the workspace root deno.json file.',
      'The "scopes" field can only be specified in the workspace root deno.json file.',
      'The "unstable" field can only be specified in the workspace root deno.json file.',
      'The "vendor" field can only be specified in the workspace root deno.json file.',
    ])
  })
})

describe('resolveMinimumDependencyAge', () => {
  const now = new Date('2026-09-26T12:00:00Z')
  const minutesAgo = (minutes: number): Date => new Date(now.getTime() - minutes * 60_000)

  it.each<[DenoConfig['minimumDependencyAge'], Date | null]>([
    [120, minutesAgo(120)],
    ['120', minutesAgo(120)],
    [0, null],
    ['0', null],
    [false, null],
    ['P2D', minutesAgo(2 * 1440)],
    ['PT12H', minutesAgo(12 * 60)],
    ['PT30M', minutesAgo(30)],
    ['P1DT2H3M4S', new Date(minutesAgo(1440 + 2 * 60 + 3).getTime() - 4000)],
    ['PT1.5S', new Date(now.getTime() - 1500)],
    ['P1W', minutesAgo(7 * 1440)],
    ['2025-09-16', new Date('2025-09-16T00:00:00Z')],
    ['2025-09-16T12:00:00+00:00', new Date('2025-09-16T12:00:00Z')],
    ['2025-09-16T12:00:00Z', new Date('2025-09-16T12:00:00Z')],
    ['2025-09-16T12:00+0900', new Date('2025-09-16T03:00:00Z')],
  ])('%j', (value, expected) => {
    expect(resolveMinimumDependencyAge(value, now)).toEqual({
      newestDependencyDate: expected,
      exclude: [],
    })
  })

  it('reads the object form', () => {
    expect(
      resolveMinimumDependencyAge({ age: 60, exclude: ['npm:react', 'jsr:@std/*'] }, now),
    ).toEqual({
      newestDependencyDate: minutesAgo(60),
      exclude: ['npm:react', 'jsr:@std/*'],
    })
    expect(resolveMinimumDependencyAge({ exclude: ['npm:a'] }, now)).toEqual({
      newestDependencyDate: null,
      exclude: ['npm:a'],
    })
  })

  it('returns undefined when unset; the default is 24 hours', () => {
    expect(resolveMinimumDependencyAge(undefined, now)).toBeUndefined()
    expect(DEFAULT_MINIMUM_DEPENDENCY_AGE_MINUTES).toBe(1440)
  })

  it.each([true, 1.5, 'P1M', 'P1Y', 'P', 'PT', 'soon', 'P1W2D'])('rejects %j', (value) => {
    expect(() => resolveMinimumDependencyAge(value, now, '/p/deno.json')).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('/p/deno.json'),
      }),
    )
  })
})
