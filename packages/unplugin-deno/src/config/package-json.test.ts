import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempDir } from '../../test/helpers/temp-dir.js'
import {
  packageJsonDependencies,
  parseDependency,
  parsePackageJson,
  readPackageJson,
  workspaceCatalogs,
} from './package-json.js'

describe('parsePackageJson', () => {
  it('reads the fields the config layer uses', () => {
    expect(
      parsePackageJson(
        JSON.stringify({
          name: 'app',
          version: '1.0.0',
          main: './index.js',
          type: 'module',
          exports: { '.': { import: './index.js' } },
          dependencies: { react: '^19.0.0' },
          devDependencies: { vite: '^8.0.0' },
          workspaces: ['packages/*'],
          catalog: { react: '^19.0.0' },
          catalogs: { legacy: { react: '^18.0.0' } },
          scripts: { build: 'vite build' },
        }),
        'package.json',
      ),
    ).toEqual({
      name: 'app',
      version: '1.0.0',
      main: './index.js',
      exports: { '.': { import: './index.js' } },
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^8.0.0' },
      workspaces: ['packages/*'],
      catalog: { react: '^19.0.0' },
      catalogs: { legacy: { react: '^18.0.0' } },
    })
  })

  it('accepts yarn-style workspaces and null fields', () => {
    expect(
      parsePackageJson('{"workspaces": {"packages": ["a/*"]}, "name": null}', 'p').workspaces,
    ).toEqual(['a/*'])
    expect(parsePackageJson('{"workspaces": {"nohoist": []}}', 'p').workspaces).toEqual([])
    expect(parsePackageJson('{}', 'p')).toEqual({})
  })

  it.each([
    ['[]', '/p/package.json:1:1: The package.json must be a JSON object.'],
    ['{"name": 1}', '/p/package.json:1:10: "name" must be a string.'],
    ['{"dependencies": {"a": 1}}', '/p/package.json:1:24: "dependencies.a" must be a string.'],
    ['{"dependencies": []}', '/p/package.json:1:18: "dependencies" must be an object.'],
    [
      '{"workspaces": [1]}',
      '/p/package.json:1:16: "workspaces" must be an array of strings or { "packages": [...] }.',
    ],
    ['{"catalogs": 1}', '/p/package.json:1:14: "catalogs" must be an object.'],
  ])('rejects %j', (text, message) => {
    expect(() => parsePackageJson(text, '/p/package.json')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID', message }),
    )
  })

  it('reports syntax errors', () => {
    expect(() => parsePackageJson('{"name": }', 'package.json')).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: 'Cannot parse package.json: ValueExpected at 1:10.',
      }),
    )
  })
})

describe('readPackageJson', () => {
  let dir: TempDir

  beforeEach(async () => {
    dir = await tempDir({ 'package.json': { name: 'x', dependencies: { a: '1' } } })
  })

  afterEach(() => dir.dispose())

  it('reads a file and maps a missing one to CONFIG_NOT_FOUND', async () => {
    expect(await readPackageJson(dir.path('package.json'))).toEqual({
      name: 'x',
      dependencies: { a: '1' },
    })
    await expect(readPackageJson(dir.path('missing/package.json'))).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
    })
  })
})

describe('parseDependency', () => {
  it.each([
    ['left-pad', '^1.3.0', { kind: 'npm', name: 'left-pad', range: '^1.3.0' }],
    ['left-pad', '>=1 <2', { kind: 'npm', name: 'left-pad', range: '>=1 <2' }],
    ['left-pad', 'latest', { kind: 'npm', name: 'left-pad', range: 'latest' }],
    ['left-pad', '', { kind: 'npm', name: 'left-pad', range: '*' }],
    ['left-pad', ' 1.0.0 ', { kind: 'npm', name: 'left-pad', range: '1.0.0' }],
    ['alias', 'npm:real@^2', { kind: 'npm', name: 'real', range: '^2' }],
    ['alias', 'npm:@scope/real@^2', { kind: 'npm', name: '@scope/real', range: '^2' }],
    ['alias', 'npm:real', { kind: 'npm', name: 'real', range: '*' }],
    ['@std/path', 'jsr:@std/path@^1', { kind: 'jsr', specifier: 'jsr:@std/path@^1' }],
    ['m1', 'workspace:*', { kind: 'workspace', range: '*' }],
    ['m1', 'workspace:^', { kind: 'workspace', range: '^' }],
    ['react', 'catalog:', { kind: 'catalog', catalog: 'default' }],
    ['react', 'catalog:legacy', { kind: 'catalog', catalog: 'legacy' }],
    ['x', 'file:../x', { kind: 'other', value: 'file:../x' }],
    ['x', 'link:../x', { kind: 'other', value: 'link:../x' }],
    [
      'x',
      'git+https://github.com/a/b.git',
      { kind: 'other', value: 'git+https://github.com/a/b.git' },
    ],
    ['x', 'https://example.com/x.tgz', { kind: 'other', value: 'https://example.com/x.tgz' }],
    ['x', 'user/repo', { kind: 'other', value: 'user/repo' }],
  ])('%s: %j', (alias, value, expected) => {
    expect(parseDependency(alias, value)).toEqual(expected)
  })
})

describe('packageJsonDependencies', () => {
  it('lists dependencies, then devDependencies, first entry wins', () => {
    expect(
      packageJsonDependencies({
        dependencies: { a: '1', b: '2' },
        devDependencies: { b: '9', c: '3' },
      }),
    ).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ])
    expect(packageJsonDependencies({})).toEqual([])
  })
})

describe('workspaceCatalogs', () => {
  it('prefers the root package.json and falls back to deno.json', () => {
    const deno = { catalog: { a: '1' }, catalogs: { x: { b: '2' } } }
    expect([...workspaceCatalogs(undefined, deno)]).toEqual([
      ['default', { a: '1' }],
      ['x', { b: '2' }],
    ])
    expect([...workspaceCatalogs({ catalogs: { y: { c: '3' } } }, deno)]).toEqual([
      ['y', { c: '3' }],
    ])
    expect([...workspaceCatalogs({ name: 'no-catalogs' }, deno)]).toEqual([
      ['default', { a: '1' }],
      ['x', { b: '2' }],
    ])
    expect(workspaceCatalogs(undefined, undefined).size).toBe(0)
  })
})
