import { symlink, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempDir } from '../../test/helpers/temp-dir.js'
import { tempProject } from '../../test/helpers/temp-project.js'
import type { TempProject } from '../../test/helpers/temp-project.js'
import { toDirUrl } from '../utils/path.js'
import type { Project } from './project.js'
import { configGeneration, loadProject } from './project.js'

const disposables: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(disposables.splice(0).map((item) => item.dispose()))
})

async function fixture(name: string): Promise<TempProject> {
  const project = await tempProject(name)
  disposables.push(project)
  return project
}

async function scratch(files: Parameters<typeof tempDir>[0]): Promise<TempDir> {
  const dir = await tempDir(files)
  disposables.push(dir)
  return dir
}

/** `fixture.json` `resolve` rows: [referrer, specifier, expected]; paths are fixture-relative. */
type ResolveRow = [from: string, specifier: string, expected: string | null]

function expectResolutions(project: Project, copy: TempProject, rows: ResolveRow[]): void {
  const toUrl = (value: string | null): string | null =>
    value === null || /^[a-z][a-z\d+.-]*:/i.test(value)
      ? value
      : value.endsWith('/')
        ? toDirUrl(copy.path(value))
        : copy.url(value)
  const actual = rows.map(([from, specifier]) => [
    from,
    specifier,
    project.importMap.resolve(specifier, copy.url(from))?.mapped ?? null,
  ])
  expect(actual).toEqual(
    rows.map(([from, specifier, expected]) => [from, specifier, toUrl(expected)]),
  )
}

function relative(copy: TempProject, paths: string[]): string[] {
  return paths.map((path) => path.slice(copy.root.length + 1).replaceAll('\\', '/'))
}

describe('loadProject on fixtures', () => {
  it('config-jsonc-comments', async () => {
    const copy = await fixture('config-jsonc-comments')
    const expected = copy.manifest.expect as {
      configFile: string
      jsx: Record<string, string>
      nodeModulesDir: string
      resolve: ResolveRow[]
    }
    const project = await loadProject(copy.root)
    expect(project.configPath).toBe(copy.path(expected.configFile))
    expect(project.jsx).toMatchObject(expected.jsx)
    expect(project.nodeModules).toMatchObject({ mode: expected.nodeModulesDir, explicit: true })
    expect(project.lockfilePath).toBeNull()
    expect(project.lockfile).toBeNull()
    expect(relative(copy, project.watchFiles)).toEqual(['deno.jsonc'])
    expect(project.warnings).toEqual([])
    expectResolutions(project, copy, expected.resolve)
  })

  it('import-map-scopes', async () => {
    const copy = await fixture('import-map-scopes')
    const expected = copy.manifest.expect as {
      autoLinks: string[]
      watchFiles: string[]
      resolve: ResolveRow[]
    }
    const project = await loadProject(copy.root)
    expect(
      relative(
        copy,
        project.links.map((link) => link.dir),
      ),
    ).toEqual(expected.autoLinks)
    expect(project.links.every((link) => link.link === null)).toBe(true)
    expect(relative(copy, project.watchFiles)).toEqual(
      [...expected.watchFiles, 'deno.lock'].toSorted(),
    )
    expectResolutions(project, copy, expected.resolve)
    expect(project.importMap.ownedKeys()).toEqual(['@std/path', 'config', 'kleur', 'legacy', 'ui'])
  })

  it('workspace-globs', async () => {
    const copy = await fixture('workspace-globs')
    const expected = copy.manifest.expect as {
      workspaceRoot: string
      members: string[]
      links: string[]
      resolve: ResolveRow[]
    }
    const project = await loadProject(copy.path('app/src'))
    expect(project.workspaceRoot).toBe(copy.path(expected.workspaceRoot))
    expect(project.configPath).toBe(copy.path('app/deno.json'))
    expect(
      relative(
        copy,
        project.members.map((member) => member.dir),
      ),
    ).toEqual(expected.members)
    expect(
      relative(
        copy,
        project.links.map((link) => link.dir),
      ),
    ).toEqual(expected.links)
    expect(project.nodeModules).toMatchObject({ mode: 'none', dir: null, layout: null })
    expect(relative(copy, project.watchFiles)).toEqual([
      'app/deno.json',
      'app/deno.lock',
      'app/packages/jsr-pkg/deno.json',
      'app/packages/node-pkg/package.json',
      'linked/deno.json',
    ])
    expectResolutions(project, copy, expected.resolve)
  })

  it('lockfile-v5-sample', async () => {
    const copy = await fixture('lockfile-v5-sample')
    const expected = copy.manifest.expect as { pins: Record<string, string | null> }
    const project = await loadProject(copy.path('src'))
    expect(project.lockfilePath).toBe(copy.path('deno.lock'))
    expect(project.lockfile?.version).toBe('5')
    const pins = Object.keys(expected.pins).map((specifier) => [
      specifier,
      project.lockfile?.pin(specifier),
    ])
    expect(Object.fromEntries(pins)).toEqual(expected.pins)
    expect(project.importMap.resolve('@std/path/join')?.mapped).toBe('jsr:@std/path@1.1.6/join')
    expect(project.importMap.resolve('colors')?.mapped).toBe(
      'https://deno.land/std@0.224.0/fmt/colors.ts',
    )
  })

  it('smoke-jsr-npm', async () => {
    const copy = await fixture('smoke-jsr-npm')
    const project = await loadProject(copy.root)
    expect(relative(copy, project.watchFiles)).toEqual(['deno.json', 'deno.lock'])
    expect(project.lockfile?.pin('jsr:@std/path@^1')).toBe('jsr:@std/path@1.1.6')
    expect(project.importMap.resolve('kleur', copy.url('src/main.ts'))).toEqual({
      mapped: 'npm:kleur@^4',
      kind: 'import-map',
      key: 'kleur',
      configPath: copy.path('deno.json'),
    })
  })
})

describe('loadProject', () => {
  const now = new Date('2026-09-26T00:00:00Z')

  it('assembles defaults for a plain deno.json', async () => {
    const dir = await scratch({ 'deno.json': {} })
    const project = await loadProject(dir.root, { now })
    expect(project).toMatchObject({
      configPath: dir.path('deno.json'),
      config: {},
      workspaceConfig: {},
      lockfilePath: dir.path('deno.lock'),
      lockfile: null,
      unsupportedLockfile: null,
      lockfileFrozen: false,
      jsx: { jsx: 'react', factory: 'React.createElement', fragmentFactory: 'React.Fragment' },
      unstable: [],
      vendor: false,
      jsrDepsInNodeModules: false,
      minimumDependencyAge: {
        newestDependencyDate: new Date('2026-09-25T00:00:00Z'),
        exclude: [],
        source: 'default',
      },
      nodeModules: {
        mode: 'none',
        explicit: false,
        dir: null,
        layout: null,
        hasJsrDeps: false,
        foreignManager: null,
      },
    })
    // The lockfile is watched even before it exists, so `deno install` creating it is noticed.
    expect(project.watchFiles).toEqual([dir.path('deno.json'), dir.path('deno.lock')])
  })

  it('reads root settings: lock, unstable, vendor, jsrDepsInNodeModules, minimumDependencyAge', async () => {
    const dir = await scratch({
      'deno.json': {
        lock: { path: './locks/deno.lock', frozen: true },
        unstable: ['raw-imports'],
        vendor: true,
        jsrDepsInNodeModules: true,
        minimumDependencyAge: { age: 60, exclude: ['npm:react'] },
      },
    })
    const project = await loadProject(dir.root, { now })
    expect(project).toMatchObject({
      lockfilePath: dir.path('locks/deno.lock'),
      lockfileFrozen: true,
      unstable: ['raw-imports'],
      vendor: true,
      // vendor: true implies nodeModulesDir "auto", which jsrDepsInNodeModules needs.
      jsrDepsInNodeModules: true,
      nodeModules: { mode: 'auto' },
      minimumDependencyAge: {
        newestDependencyDate: new Date('2026-09-25T23:00:00Z'),
        exclude: ['npm:react'],
        source: 'config',
      },
    })
  })

  it('ignores jsrDepsInNodeModules without a node_modules directory mode', async () => {
    const dir = await scratch({
      'deno.json': { jsrDepsInNodeModules: true, nodeModulesDir: 'none' },
    })
    expect((await loadProject(dir.root)).jsrDepsInNodeModules).toBe(false)
  })

  it('skips the lockfile for lockfile: "off"', async () => {
    const dir = await scratch({ 'deno.json': {}, 'deno.lock': '{"version": "5"}' })
    const project = await loadProject(dir.root, { lockfile: 'off' })
    expect(project).toMatchObject({ lockfilePath: null, lockfile: null })
    expect(project.watchFiles).toEqual([dir.path('deno.json')])
  })

  it('warns about unsupported lockfile versions and ignores them', async () => {
    const dir = await scratch({
      'deno.json': {},
      'deno.lock': '{"version": "4", "specifiers": {}}',
    })
    const project = await loadProject(dir.root)
    expect(project.lockfile).toBeNull()
    expect(project.unsupportedLockfile).toEqual({
      path: dir.path('deno.lock'),
      version: '4',
      unsupported: true,
    })
    expect(project.warnings).toEqual([
      {
        file: dir.path('deno.lock'),
        message:
          'deno.lock version 4 is not supported (expected 5), so it is ignored; run `deno install` to upgrade it.',
      },
    ])
  })

  it('uses deno.lock next to a root package.json when there is no deno.json', async () => {
    const dir = await scratch({ 'package.json': { name: 'app', dependencies: { kleur: '^4' } } })
    const project = await loadProject(dir.root)
    expect(project).toMatchObject({
      configPath: null,
      lockfilePath: dir.path('deno.lock'),
      nodeModules: { mode: 'manual' },
    })
    expect(project.importMap.resolve('kleur/colors', dir.url('main.ts'))).toMatchObject({
      mapped: 'npm:kleur@^4/colors',
      kind: 'package-json-dependency',
    })
  })

  it('merges member compilerOptions over the root for JSX', async () => {
    const dir = await scratch({
      'deno.json': {
        workspace: ['./site'],
        compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react', jsxFactory: 'h' },
      },
      'site/deno.json': { compilerOptions: { jsx: 'precompile', jsxImportSource: 'preact' } },
    })
    const project = await loadProject(dir.path('site'))
    expect(project.configPath).toBe(dir.path('site/deno.json'))
    expect(project.config).toEqual({
      compilerOptions: { jsx: 'precompile', jsxImportSource: 'preact' },
    })
    expect(project.jsx).toMatchObject({ jsx: 'precompile', importSource: 'preact', factory: 'h' })
  })

  it('maps real paths of symlinked members to their scope', async () => {
    const dir = await scratch({
      'deno.json': { workspace: ['./packages/*'] },
      'elsewhere/lib/deno.json': {
        name: '@x/lib',
        exports: './mod.ts',
        imports: { dep: './dep.ts' },
      },
      'packages/': null,
    })
    await symlink(dir.path('elsewhere/lib'), dir.path('packages/lib'), 'junction')
    const project = await loadProject(dir.root)
    expect(project.importMap.resolve('dep', dir.url('packages/lib/mod.ts'))?.mapped).toBe(
      dir.url('packages/lib/dep.ts'),
    )
    // Hosts usually report the real path of a symlinked file.
    expect(project.importMap.resolve('dep', dir.url('elsewhere/lib/mod.ts'))?.mapped).toBe(
      dir.url('packages/lib/dep.ts'),
    )
  })

  it('returns an inert project for config: false', async () => {
    const dir = await scratch({ 'deno.json': { imports: { a: './a.ts' } } })
    const project = await loadProject(dir.root, { config: false })
    expect(project).toMatchObject({
      disabled: true,
      configPath: null,
      lockfilePath: null,
      watchFiles: [],
    })
    expect(project.importMap.resolve('a')).toBeNull()
  })

  it('surfaces configuration errors', async () => {
    const dir = await scratch({ 'deno.json': '{ "imports": [] }' })
    await expect(loadProject(dir.root)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  })
})

describe('configGeneration', () => {
  it('hashes the watched files and changes when one changes or appears', async () => {
    const dir = await scratch({ 'deno.json': { imports: { a: './a.ts' } } })
    const project = await loadProject(dir.root)
    const first = await configGeneration(project)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await configGeneration(project)).toBe(first)
    expect(await configGeneration({ watchFiles: project.watchFiles.toReversed() })).toBe(first)

    await writeFile(dir.path('deno.lock'), '{"version": "5"}')
    const withLock = await configGeneration(project)
    expect(withLock).not.toBe(first)

    await writeFile(dir.path('deno.json'), '{"imports": {"a": "./b.ts"}}')
    expect(await configGeneration(project)).not.toBe(withLock)
  })

  it('is stable for identical content in different directories only when paths match', async () => {
    const a = await scratch({ 'deno.json': {} })
    const b = await scratch({ 'deno.json': {} })
    const generationA = await configGeneration(await loadProject(a.root))
    const generationB = await configGeneration(await loadProject(b.root))
    expect(generationA).not.toBe(generationB)
  })
})
