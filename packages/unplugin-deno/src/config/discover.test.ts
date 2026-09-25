import { realpath, symlink } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempDir, TempFiles } from '../../test/helpers/temp-dir.js'
import { toFileUrl } from '../utils/path.js'
import type { Discovery } from './discover.js'
import { discoverProject } from './discover.js'

// Discovery follows Deno 2.9.7's `discover_workspace_config_files`; the scenarios marked
// "verified" were reproduced with `deno run` in scratch projects on 2026-09-26.

let dir: TempDir | undefined

afterEach(async () => {
  await dir?.dispose()
  dir = undefined
})

async function setup(files: TempFiles): Promise<TempDir> {
  dir = await tempDir(files)
  return dir
}

/** Paths of a discovery relative to the temp dir, `/`-separated. */
function summary(discovery: Discovery, root: TempDir) {
  const rel = (path: string | null): string | null =>
    path === null
      ? null
      : path === root.root
        ? '.'
        : path.slice(root.root.length + 1).replaceAll('\\', '/')
  return {
    configPath: rel(discovery.configPath),
    workspaceRoot: rel(discovery.workspaceRoot),
    members: discovery.members.map((member) => rel(member.dir)),
    links: discovery.links.map((link) => [rel(link.dir), link.link]),
    watchFiles: discovery.watchFiles.map(rel),
    warnings: discovery.warnings.map((warning) => [rel(warning.file), warning.message]),
  }
}

describe('discoverProject: finding the config', () => {
  it('walks up from the root and records the config', async () => {
    const root = await setup({ 'deno.json': { imports: {} }, 'src/app/x.ts': '' })
    const discovery = await discoverProject(root.path('src/app'))
    expect(summary(discovery, root)).toEqual({
      configPath: 'deno.json',
      workspaceRoot: '.',
      members: [],
      links: [],
      watchFiles: ['deno.json'],
      warnings: [],
    })
    expect(discovery.root).toBe(root.path('src/app'))
    expect(discovery.configUrl).toBe(root.url('deno.json'))
    expect(discovery.workspaceRootUrl).toBe(root.url('/'))
    expect(discovery.rootFolder?.denoJson?.config).toEqual({ imports: {} })
    expect(discovery.disabled).toBe(false)
  })

  it('prefers deno.json over deno.jsonc in the same directory (verified)', async () => {
    const root = await setup({
      'deno.json': { imports: { which: './json.ts' } },
      'deno.jsonc': '// jsonc\n{ "imports": { "which": "./jsonc.ts" } }',
    })
    const discovery = await discoverProject(root.root)
    expect(summary(discovery, root).configPath).toBe('deno.json')
    expect(discovery.rootFolder?.denoJson?.config.imports).toEqual({ which: './json.ts' })
  })

  it('finds deno.jsonc and reads comments and trailing commas', async () => {
    const root = await setup({ 'deno.jsonc': '{ /* c */ "imports": { "a": "./a.ts", }, }' })
    const discovery = await discoverProject(root.root)
    expect(summary(discovery, root).configPath).toBe('deno.jsonc')
    expect(discovery.rootFolder?.denoJson?.importMap).toEqual({
      baseUrl: root.url('deno.jsonc'),
      value: { imports: { a: './a.ts' } },
      path: root.path('deno.jsonc'),
      inline: true,
    })
  })

  it('stops at a nearer package.json and ignores a parent deno.json without members (verified)', async () => {
    const root = await setup({
      'deno.json': { imports: { x: './x.ts' } },
      'app/package.json': { name: 'app' },
    })
    const discovery = await discoverProject(root.path('app'))
    expect(summary(discovery, root)).toMatchObject({
      configPath: null,
      workspaceRoot: 'app',
      members: [],
      watchFiles: ['app/package.json'],
    })
    expect(discovery.rootFolder?.packageJson?.json).toEqual({ name: 'app' })
  })

  it('uses the parent workspace when the package.json folder is a member (verified)', async () => {
    const root = await setup({
      'deno.json': { workspace: ['./app'], imports: { x: './x.ts' } },
      'app/package.json': { name: 'app' },
    })
    const discovery = await discoverProject(root.path('app'))
    expect(summary(discovery, root)).toMatchObject({
      configPath: 'deno.json',
      workspaceRoot: '.',
      members: ['app'],
    })
  })

  it('ignores a parent workspace the nearest config is not a member of, with a warning (verified)', async () => {
    const root = await setup({
      'deno.json': { workspace: ['./other'] },
      'other/deno.json': {},
      'app/deno.json': { imports: { y: './y.ts' } },
    })
    const discovery = await discoverProject(root.path('app'))
    const result = summary(discovery, root)
    expect(result).toMatchObject({ configPath: 'app/deno.json', workspaceRoot: 'app', members: [] })
    expect(result.warnings).toEqual([
      [
        'app/deno.json',
        `Config file ${root.path('app/deno.json')} is not a member of the workspace at ${root.root}; ignoring the parent workspace config.`,
      ],
    ])
  })

  it('silently ignores a parent npm workspace the folder is not a member of', async () => {
    const root = await setup({
      'package.json': { workspaces: ['packages/*'] },
      'app/deno.json': {},
    })
    const discovery = await discoverProject(root.path('app'))
    expect(summary(discovery, root)).toMatchObject({ workspaceRoot: 'app', warnings: [] })
  })

  it('rejects an intermediate config that is not a workspace member', async () => {
    const root = await setup({
      'deno.json': { workspace: ['./a/b'] },
      'a/deno.json': {},
      'a/b/deno.json': {},
    })
    await expect(discoverProject(root.path('a/b'))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: `Config file ${root.path('a/deno.json')} is not a member of the workspace at ${root.root}.`,
    })
  })

  it('never starts inside node_modules', async () => {
    const root = await setup({ 'deno.json': {}, 'node_modules/pkg/deno.json': { name: '@x/pkg' } })
    const discovery = await discoverProject(root.path('node_modules/pkg/sub'))
    expect(summary(discovery, root).configPath).toBe('deno.json')
  })

  it('returns an empty discovery when nothing is found or discovery is disabled', async () => {
    const root = await setup({ 'deno.json': {} })
    const disabled = await discoverProject(root.root, { config: false })
    expect(disabled).toEqual({
      root: root.root,
      disabled: true,
      configPath: null,
      configUrl: null,
      workspaceRoot: root.root,
      workspaceRootUrl: root.url('/'),
      rootFolder: null,
      members: [],
      links: [],
      watchFiles: [],
      warnings: [],
    })
  })

  it('skips package.json files when package.json discovery is off (DENO_NO_PACKAGE_JSON)', async () => {
    const root = await setup({ 'deno.json': {}, 'app/package.json': { name: 'app' } })
    const discovery = await discoverProject(root.path('app'), { packageJson: false })
    expect(summary(discovery, root)).toMatchObject({ configPath: 'deno.json', workspaceRoot: '.' })
  })
})

describe('discoverProject: explicit config', () => {
  it('uses a natural config path like discovery from its directory', async () => {
    const root = await setup({ 'deno.json': { workspace: ['./app'] }, 'app/deno.json': {} })
    const discovery = await discoverProject(root.root, { config: 'app/deno.json' })
    expect(summary(discovery, root)).toMatchObject({
      configPath: 'app/deno.json',
      workspaceRoot: '.',
      members: ['app'],
    })
  })

  it('uses another file on its own', async () => {
    const root = await setup({
      'deno.json': { workspace: ['./app'] },
      'app/deno.json': {},
      'app/custom.json': { imports: { c: './c.ts' } },
      'app/package.json': { name: 'app' },
    })
    const discovery = await discoverProject(root.path('app'), { config: './custom.json' })
    expect(summary(discovery, root)).toMatchObject({
      configPath: 'app/custom.json',
      workspaceRoot: 'app',
      members: [],
    })
    expect(discovery.rootFolder?.packageJson).toBeNull()
  })

  it('treats deno.jsonc as custom when a deno.json exists next to it', async () => {
    const root = await setup({ 'deno.json': {}, 'deno.jsonc': '{}' })
    const discovery = await discoverProject(root.root, { config: root.path('deno.jsonc') })
    expect(summary(discovery, root).configPath).toBe('deno.jsonc')
  })

  it('fails with CONFIG_NOT_FOUND for a missing file', async () => {
    const root = await setup({})
    await expect(discoverProject(root.root, { config: 'nope/deno.json' })).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
      message: `Cannot find ${root.path('nope/deno.json')}.`,
    })
  })
})

describe('discoverProject: workspace members', () => {
  it('expands globs to directories with deno.json, deno.jsonc or package.json (verified)', async () => {
    const root = await setup({
      'deno.json': { workspace: ['./packages/*', './tools/cli'] },
      'packages/a/deno.json': { name: '@x/a', exports: './mod.ts' },
      'packages/b/deno.jsonc': '{ "name": "@x/b", "exports": "./mod.ts", }',
      'packages/c/package.json': { name: 'c' },
      'packages/no-config/README.md': '',
      'packages/file.json': '{}',
      'tools/cli/deno.json': {},
    })
    const discovery = await discoverProject(root.root)
    expect(summary(discovery, root)).toMatchObject({
      members: ['packages/a', 'packages/b', 'packages/c', 'tools/cli'],
      watchFiles: [
        'deno.json',
        'packages/a/deno.json',
        'packages/b/deno.jsonc',
        'packages/c/package.json',
        'tools/cli/deno.json',
      ],
    })
    expect(discovery.members[1]?.denoJson?.config.name).toBe('@x/b')
  })

  it('handles globstars, exclusions, dot directories and node_modules like Deno (verified)', async () => {
    const root = await setup({
      'deno.json': { workspace: { members: ['./pk/**', '!./pk/excluded', '!./pk/*-skip'] } },
      'pk/a/deno.json': {},
      'pk/a/deep/deno.json': {},
      'pk/.hidden/deno.json': {},
      'pk/excluded/deno.json': {},
      'pk/excluded/nested/deno.json': {},
      'pk/x-skip/deno.json': {},
      'pk/n/package.json': { name: 'n' },
      'pk/n/node_modules/dep/package.json': { name: 'dep' },
    })
    const discovery = await discoverProject(root.root)
    expect(summary(discovery, root).members).toEqual(['pk/a', 'pk/a/deep', 'pk/n'])
  })

  it('accepts a glob that matches nothing and skips missing path members with a warning (verified)', async () => {
    const root = await setup({
      'deno.json': { workspace: ['./nothing/*', './missing', './p'] },
      'p/deno.json': {},
    })
    const discovery = await discoverProject(root.root)
    expect(summary(discovery, root)).toMatchObject({
      members: ['p'],
      warnings: [
        [
          'deno.json',
          `Workspace member "./missing" not found at ${root.path('missing')}; skipping it.`,
        ],
      ],
    })
  })

  it.each([
    [
      'an existing directory without a config (verified)',
      { 'deno.json': { workspace: ['./empty'] }, 'empty/README.md': '' },
      'has no deno.json, deno.jsonc or package.json',
    ],
    [
      'a member outside the workspace (verified)',
      { 'ws/deno.json': { workspace: ['../outside'] }, 'outside/deno.json': {} },
      'is not inside the workspace directory',
    ],
    [
      'the workspace root itself',
      { 'deno.json': { workspace: ['.'] } },
      'refers to the workspace root itself',
    ],
    [
      'a directory listed twice (verified)',
      {
        'deno.json': { workspace: ['./pk/a', './pk/*'] },
        'pk/a/deno.json': {},
        'pk/b/deno.json': {},
      },
      'is specified twice',
    ],
    [
      'duplicate package names (verified)',
      {
        'deno.json': { workspace: ['./a', './b'] },
        'a/deno.json': { name: '@i/x', exports: './mod.ts' },
        'b/deno.json': { name: '@i/x', exports: './mod.ts' },
      },
      'has the same name as the package in',
    ],
  ])('rejects %s', async (_name, files, message) => {
    const root = await setup(files)
    const start = Object.keys(files).some((file) => file.startsWith('ws/'))
      ? root.path('ws')
      : root.root
    await expect(discoverProject(start)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining(message),
    })
  })

  it('reads npm workspaces from the root package.json', async () => {
    const root = await setup({
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'packages/a/package.json': { name: 'a' },
      'packages/b/deno.json': {},
      'packages/c/package.json': { name: 'c' },
    })
    const discovery = await discoverProject(root.root)
    // npm workspaces only match package.json files.
    expect(summary(discovery, root)).toMatchObject({
      configPath: null,
      workspaceRoot: '.',
      members: ['packages/a', 'packages/c'],
    })
  })

  it('records the real path of symlinked members', async () => {
    const root = await setup({
      'deno.json': { workspace: ['./packages/*'] },
      'elsewhere/lib/deno.json': { name: '@x/lib', exports: './mod.ts' },
      'packages/': null,
    })
    await symlink(root.path('elsewhere/lib'), root.path('packages/lib'), 'junction')
    const discovery = await discoverProject(root.root)
    expect(summary(discovery, root).members).toEqual(['packages/lib'])
    expect(discovery.members[0]?.realDir).toBe(await realpath(root.path('elsewhere/lib')))
  })

  it('warns about root-only fields in members (verified wording)', async () => {
    const root = await setup({
      'deno.json': { workspace: ['./p'], nodeModulesDir: true },
      'p/deno.json': { lock: false, vendor: true, compilerOptions: { jsx: 'precompile' } },
    })
    const discovery = await discoverProject(root.root)
    expect(summary(discovery, root).warnings).toEqual([
      ['deno.json', '"nodeModulesDir": true is deprecated; use "nodeModulesDir": "auto" instead.'],
      [
        'p/deno.json',
        'The "lock" field can only be specified in the workspace root deno.json file.',
      ],
      [
        'p/deno.json',
        'The "vendor" field can only be specified in the workspace root deno.json file.',
      ],
    ])
  })
})

describe('discoverProject: links', () => {
  it('links a sibling directory outside the workspace (verified)', async () => {
    const root = await setup({
      'app/deno.json': { links: ['../linked'] },
      'linked/deno.json': { name: '@fx/linked', version: '2.1.0', exports: './mod.ts' },
    })
    const discovery = await discoverProject(root.path('app'))
    expect(summary(discovery, root)).toMatchObject({
      workspaceRoot: 'app',
      links: [['linked', '../linked']],
      watchFiles: ['app/deno.json', 'linked/deno.json'],
    })
  })

  it('expands link globs, absolute paths and file: URLs', async () => {
    const root = await setup({
      'app/deno.json': {},
      'libs/one/deno.json': { name: '@l/one', exports: './mod.ts' },
      'libs/two/package.json': { name: 'two' },
      'libs/skip/deno.json': {},
      'abs/deno.json': { name: '@l/abs', exports: './mod.ts' },
      'url/deno.json': { name: '@l/url', exports: './mod.ts' },
    })
    await root.write({
      'app/deno.json': {
        links: ['../libs/*', '!../libs/skip', root.path('abs'), toFileUrl(root.path('url'))],
      },
    })
    const discovery = await discoverProject(root.path('app'))
    expect(summary(discovery, root).links).toEqual([
      ['abs', root.path('abs')],
      ['url', toFileUrl(root.path('url'))],
      ['libs/one', '../libs/*'],
      ['libs/two', '../libs/*'],
    ])
  })

  it('brings in the whole workspace of a linked member or workspace root (verified)', async () => {
    const root = await setup({
      'app/deno.json': { links: ['../linkws/pkgs/p1'] },
      'linkws/deno.json': { workspace: ['./pkgs/*'] },
      'linkws/pkgs/p1/deno.json': { name: '@fx/p1', exports: './mod.ts' },
      'linkws/pkgs/p2/deno.json': { name: '@fx/p2', exports: './mod.ts' },
      'other/deno.json': { workspace: ['./m'] },
      'other/m/deno.json': { name: '@o/m', exports: './mod.ts' },
    })
    const discovery = await discoverProject(root.path('app'))
    expect(summary(discovery, root).links).toEqual([
      ['linkws', '../linkws/pkgs/p1'],
      ['linkws/pkgs/p1', '../linkws/pkgs/p1'],
      ['linkws/pkgs/p2', '../linkws/pkgs/p1'],
    ])
    await root.write({ 'app/deno.json': { links: ['../other'] } })
    const again = await discoverProject(root.path('app'))
    expect(summary(again, root).links).toEqual([
      ['other', '../other'],
      ['other/m', '../other'],
    ])
  })

  it('accepts the deprecated "patch" with a warning (verified)', async () => {
    const root = await setup({ 'app/deno.json': { patch: ['../linked'] }, 'linked/deno.json': {} })
    const discovery = await discoverProject(root.path('app'))
    expect(summary(discovery, root)).toMatchObject({
      links: [['linked', '../linked']],
      warnings: [['app/deno.json', '"patch" property was renamed to "links".']],
    })
  })

  it.each([
    [
      { 'app/deno.json': { links: ['../missing'] } },
      'has no deno.json, deno.jsonc or package.json',
    ],
    [{ 'app/deno.json': { links: ['.'] } }, 'points at this workspace or one of its members'],
    [
      // Deno: "Workspace member cannot be specified as a link."
      { 'app/deno.json': { workspace: ['./a'], links: ['./a'] }, 'app/a/deno.json': {} },
      'points at this workspace or one of its members',
    ],
  ])('rejects invalid links: %j', async (files, message) => {
    const root = await setup(files)
    await expect(discoverProject(root.path('app'))).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining(message),
    })
  })

  it('links directories that import map paths point into (Deno 2.8.3+ auto-links, verified)', async () => {
    const root = await setup({
      'ws/deno.json': {
        imports: { legacy: './legacy/mod.ts', lib: '../lib/', local: './src/x.ts' },
      },
      'ws/legacy/deno.json': { importMap: './import_map.json' },
      'ws/legacy/import_map.json': { imports: { next: '../../chain/mod.ts' } },
      'chain/deno.json': {},
      'lib/deno.json': { name: '@x/lib', exports: './mod.ts' },
      'ws/src/x.ts': '',
    })
    const discovery = await discoverProject(root.path('ws'))
    expect(summary(discovery, root)).toMatchObject({
      workspaceRoot: 'ws',
      links: [
        ['ws/legacy', null],
        ['lib', null],
        ['chain', null],
      ],
      watchFiles: [
        'chain/deno.json',
        'lib/deno.json',
        'ws/deno.json',
        'ws/legacy/deno.json',
        'ws/legacy/import_map.json',
      ],
    })
  })
})

describe('discoverProject: external import maps', () => {
  it('reads the importMap file relative to the config (strict JSON, not expanded)', async () => {
    const root = await setup({
      'deno.json': { importMap: './maps/import_map.json' },
      'maps/import_map.json': { imports: { a: './a.ts' } },
    })
    const discovery = await discoverProject(root.root)
    expect(discovery.rootFolder?.denoJson?.importMap).toEqual({
      baseUrl: root.url('maps/import_map.json'),
      value: { imports: { a: './a.ts' } },
      path: root.path('maps/import_map.json'),
      inline: false,
    })
    expect(summary(discovery, root).watchFiles).toEqual(['deno.json', 'maps/import_map.json'])
  })

  it('prefers inline imports with a warning (verified wording)', async () => {
    const root = await setup({
      'deno.json': { importMap: './import_map.json', imports: { inline: './inline.ts' } },
      'import_map.json': { imports: { external: './external.ts' } },
    })
    const discovery = await discoverProject(root.root)
    expect(discovery.rootFolder?.denoJson?.importMap?.inline).toBe(true)
    expect(summary(discovery, root)).toMatchObject({
      watchFiles: ['deno.json'],
      warnings: [
        [
          'deno.json',
          '"importMap" field is ignored when "imports" or "scopes" are specified in the config file.',
        ],
      ],
    })
  })

  it.each([
    [
      'comments (Deno: "key must be a string")',
      { 'deno.json': { importMap: './im.json' }, 'im.json': '{\n  // no\n  "imports": {}\n}' },
      {
        code: 'IMPORT_MAP_INVALID',
        message: expect.stringMatching(/InvalidCommentToken at 2:3\.$/),
      },
    ],
    [
      'a missing file',
      { 'deno.json': { importMap: './missing.json' } },
      {
        code: 'IMPORT_MAP_INVALID',
        message: expect.stringContaining('Cannot read the import map'),
      },
    ],
    [
      'a remote URL',
      { 'deno.json': { importMap: 'https://example.com/import_map.json' } },
      { code: 'CONFIG_INVALID', message: expect.stringContaining('must be a local file') },
    ],
  ])('rejects %s', async (_name, files, error) => {
    const root = await setup(files)
    await expect(discoverProject(root.root)).rejects.toMatchObject(error)
  })
})
