import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempDir, TempFiles } from '../../test/helpers/temp-dir.js'
import type { Project } from '../config/project.js'
import { loadProject } from '../config/project.js'
import { DenoPluginError, isDenoPluginError } from '../diagnostics/errors.js'
import { createSilentLogger } from '../diagnostics/logger.js'
import { EngineResolveError } from '../engine/errors.js'
import { mediaTypeFromUrl } from '../engine/media-type.js'
import type { Engine, LoadedModule, ResolutionMode, ResolvedModule } from '../engine/types.js'
import { toFileUrl } from '../utils/path.js'
import type { Mirror } from './mirror.js'
import { createMirror } from './mirror.js'
import type { NpmStrategy } from './npm.js'
import type { Options, Platform } from './options.js'
import { resolveOptions } from './options.js'
import type { Resolver, ResolverState } from './resolve.js'
import {
  BROAD_RESOLVE_ID_FILTER,
  createResolver,
  packageJsonDependencyNames,
  resolveIdFilter,
} from './resolve.js'

/** An engine that answers from a table and records its calls. */
class TableEngine implements Engine {
  readonly kind = 'loader'
  readonly calls: Array<[string, string | undefined, ResolutionMode]> = []
  readonly table = new Map<string, ResolvedModule | Error>()
  readonly sources = new Map<string, string>()

  addEntrypoints(): Promise<[]> {
    return Promise.resolve([])
  }

  async resolve(
    specifier: string,
    referrer: string | undefined,
    mode: ResolutionMode,
  ): Promise<ResolvedModule> {
    this.calls.push([specifier, referrer, mode])
    const answer = this.table.get(specifier)
    if (answer instanceof Error) throw answer
    if (answer !== undefined) return answer
    if (
      /^(?:https?|data):/.test(specifier) ||
      (referrer !== undefined && /^\.{0,2}\//.test(specifier))
    ) {
      const url = new URL(specifier, referrer).href
      return {
        kind: url.startsWith('data:') ? 'data' : 'remote',
        url,
        mediaType: mediaTypeFromUrl(url),
      }
    }
    if (specifier.startsWith('node:')) return { kind: 'node', url: specifier, mediaType: 'Unknown' }
    throw new DenoPluginError('RESOLVE_NOT_FOUND', `Cannot resolve ${specifier}`, { specifier })
  }

  async load(url: string): Promise<LoadedModule> {
    const code = this.sources.get(url) ?? 'export {};\n'
    return {
      kind: 'module',
      url,
      mediaType: mediaTypeFromUrl(url) === 'Unknown' ? 'JavaScript' : mediaTypeFromUrl(url),
      code,
      bytes: new TextEncoder().encode(code),
    }
  }

  graph(): unknown {
    return {}
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }
}

interface Setup {
  dir: TempDir
  engine: TableEngine
  mirror: Mirror
  project: Project
  resolver: Resolver
  state: ResolverState
  /** A stand-in DENO_DIR inside the temporary directory. */
  denoDir: string
}

async function setup(
  files: TempFiles,
  options: Options = {},
  extra: { platform?: Platform; npmStrategy?: NpmStrategy } = {},
): Promise<Setup> {
  const dir = await tempDir(files)
  onTestFinished(() => dir.dispose())
  const engine = new TableEngine()
  const project = await loadProject(dir.root)
  const mirror = createMirror({
    cacheDir: dir.path('node_modules/.unplugin-deno'),
    generation: 'abcdef12',
    engine: () => Promise.resolve(engine),
    lockfile: project.lockfile,
    logger: createSilentLogger(),
  })
  const state: ResolverState = {
    options: resolveOptions(options, { root: dir.root, env: {} }),
    project,
    platform: extra.platform ?? 'browser',
    npmStrategy: extra.npmStrategy ?? 'node_modules',
    denoDirs: [dir.path('deno-dir')],
    mirror,
    logger: createSilentLogger(),
    framework: 'rolldown',
    engine: () => Promise.resolve(engine),
  }
  return {
    dir,
    engine,
    mirror,
    project,
    resolver: createResolver(state),
    state,
    denoDir: dir.path('deno-dir'),
  }
}

function npmModule(
  dir: TempDir,
  name: string,
  version: string,
  subpath: string,
  file: string,
): ResolvedModule {
  const packageDir = dir.path(`node_modules/.deno/${name}@${version}/node_modules/${name}`)
  const path = join(packageDir, file)
  return {
    kind: 'npm',
    url: toFileUrl(path),
    path,
    mediaType: 'Mjs',
    npm: { name, version, subpath, packageDir, packageJsonPath: join(packageDir, 'package.json') },
    sideEffects: null,
  }
}

const denoJson = (imports: Record<string, string>, extra: object = {}): TempFiles => ({
  'deno.json': { imports, ...extra },
})

describe('resolveOwned: ids that are not ours', () => {
  it('returns null for virtual ids, relative and absolute local imports and unmapped bare names', async () => {
    const { resolver, dir, engine } = await setup(denoJson({ kleur: 'npm:kleur@^4' }))
    const importer = dir.path('src/main.ts')
    for (const id of [
      '\0virtual:x',
      'virtual:answer',
      '\0deno:other',
      './util.ts',
      '../x.ts',
      '/abs/x.ts',
      'react',
      '#internal',
      'mailto:x',
      '',
    ]) {
      expect(await resolver.resolveOwned(id, importer)).toBeNull()
    }
    expect(await resolver.resolveOwned('./util.ts', undefined)).toBeNull()
    expect(engine.calls).toEqual([])
  })

  it('resolves its own empty module', async () => {
    const { resolver } = await setup({})
    expect(await resolver.resolveOwned('\0deno:empty', undefined)).toEqual({
      type: 'virtual',
      id: '\0deno:empty',
    })
  })

  it('leaves imports inside node_modules packages to the host, even for import-map keys', async () => {
    const { resolver, dir, engine } = await setup(denoJson({ kleur: 'npm:kleur@^4' }))
    const importer = dir.path('node_modules/.deno/a@1.0.0/node_modules/a/index.js')
    expect(await resolver.resolveOwned('kleur', importer)).toBeNull()
    expect(engine.calls).toEqual([])
  })

  it('honours exclude and importers', async () => {
    const files = denoJson({ '@std/path': 'jsr:@std/path@^1' })
    const excluded = await setup(files, { exclude: ['@std/path', /^jsr:/] })
    const importer = excluded.dir.path('src/main.ts')
    expect(await excluded.resolver.resolveOwned('@std/path/join', importer)).toBeNull()
    expect(await excluded.resolver.resolveOwned('jsr:@std/fmt', importer)).toBeNull()
    const included = await setup(files, {
      importers: { include: [/[\\/]src[\\/]/], exclude: ['./src/vendor/'] },
    })
    included.engine.table.set('jsr:@std/path@^1', {
      kind: 'node',
      url: 'node:path',
      mediaType: 'Unknown',
    })
    expect(
      await included.resolver.resolveOwned('@std/path', included.dir.path('other/x.ts')),
    ).toBeNull()
    expect(
      await included.resolver.resolveOwned('@std/path', included.dir.path('src/vendor/x.ts')),
    ).toBeNull()
    expect(
      await included.resolver.resolveOwned('@std/path', included.dir.path('src/x.ts')),
    ).toEqual({
      type: 'external',
      id: 'node:path',
    })
  })
})

describe('resolveOwned: the import map (§5.2 step 1)', () => {
  it('maps bare keys (with subpaths) and hands the mapped specifier to the engine', async () => {
    const { resolver, dir, engine } = await setup(denoJson({ kleur: 'npm:kleur@^4' }))
    const importer = dir.path('src/main.ts')
    engine.table.set(
      'npm:kleur@^4/colors',
      npmModule(dir, 'kleur', '4.1.5', '/colors', 'colors.mjs'),
    )
    expect(
      await resolver.resolveOwned('kleur/colors', importer, { kind: 'import-statement' }),
    ).toEqual({
      type: 'npm-redirect',
      request: 'kleur/colors',
      resolveDir: dir.path('node_modules/.deno/kleur@4.1.5/node_modules/kleur'),
      packageJsonPath: dir.path('node_modules/.deno/kleur@4.1.5/node_modules/kleur/package.json'),
      rawSpecifier: 'npm:kleur@^4/colors',
      fallbackPath: dir.path('node_modules/.deno/kleur@4.1.5/node_modules/kleur/colors.mjs'),
      query: '',
      sideEffects: null,
    })
    expect(engine.calls).toEqual([['npm:kleur@^4/colors', toFileUrl(importer), 'import']])
  })

  it('keeps host queries on the result', async () => {
    const { resolver, dir, engine } = await setup(
      denoJson({ kleur: 'npm:kleur@^4', util: './src/util.ts' }),
    )
    engine.table.set('npm:kleur@^4', npmModule(dir, 'kleur', '4.1.5', '', 'index.mjs'))
    const importer = dir.path('src/main.ts')
    expect(await resolver.resolveOwned('kleur?raw', importer)).toMatchObject({
      type: 'npm-redirect',
      query: '?raw',
    })
    engine.table.set(toFileUrl(dir.path('src/util.ts')), {
      kind: 'local',
      url: toFileUrl(dir.path('src/util.ts')),
      path: dir.path('src/util.ts'),
      mediaType: 'TypeScript',
    })
    expect(await resolver.resolveOwned('util?worker&url', importer)).toEqual({
      type: 'path',
      path: `${dir.path('src/util.ts')}?worker&url`,
    })
  })

  it('uses the resolve mode of require calls', async () => {
    const { resolver, dir, engine } = await setup(denoJson({ kleur: 'npm:kleur@^4' }))
    engine.table.set('npm:kleur@^4', npmModule(dir, 'kleur', '4.1.5', '', 'index.js'))
    await resolver.resolveOwned('kleur', dir.path('src/main.cjs'), { kind: 'require-call' })
    expect(engine.calls[0]?.[2]).toBe('require')
  })

  it('leaves package.json dependencies to the host, except on the Deno platform', async () => {
    const files: TempFiles = {
      'deno.json': { imports: {} },
      'package.json': { dependencies: { react: '^19.0.0' } },
    }
    const browser = await setup(files)
    expect(await browser.resolver.resolveOwned('react', browser.dir.path('src/main.ts'))).toBeNull()
    const deno = await setup(files, {}, { platform: 'deno' })
    deno.engine.table.set(
      'react/jsx-runtime',
      npmModule(deno.dir, 'react', '19.2.0', '/jsx-runtime', 'jsx-runtime.js'),
    )
    expect(
      await deno.resolver.resolveOwned('react/jsx-runtime', deno.dir.path('src/main.ts')),
    ).toEqual({
      type: 'external',
      id: 'npm:react@19.2.0/jsx-runtime',
    })
    const bundled = await setup(files, { bundle: ['react'] }, { platform: 'deno' })
    expect(await bundled.resolver.resolveOwned('react', bundled.dir.path('src/main.ts'))).toBeNull()
  })

  it('resolves workspace members and member-scoped aliases to local files', async () => {
    const { resolver, dir, engine } = await setup({
      'deno.json': { workspace: ['./packages/*'] },
      'packages/app/deno.json': { imports: { 'app-alias': './src/alias.ts' } },
      'packages/app/src/alias.ts': 'export {}',
      'packages/lib/deno.json': {
        name: '@ws/lib',
        version: '1.0.0',
        exports: { '.': './mod.ts', './extra': './extra.ts' },
      },
      'packages/lib/mod.ts': 'export {}',
      'packages/lib/extra.ts': 'export {}',
    })
    for (const path of [
      'packages/app/src/alias.ts',
      'packages/lib/mod.ts',
      'packages/lib/extra.ts',
    ]) {
      const url = toFileUrl(dir.path(path))
      engine.table.set(url, { kind: 'local', url, path: dir.path(path), mediaType: 'TypeScript' })
    }
    const importer = dir.path('packages/app/src/main.ts')
    expect(await resolver.resolveOwned('@ws/lib', importer)).toEqual({
      type: 'path',
      path: dir.path('packages/lib/mod.ts'),
    })
    expect(await resolver.resolveOwned('@ws/lib/extra', importer)).toEqual({
      type: 'path',
      path: dir.path('packages/lib/extra.ts'),
    })
    expect(await resolver.resolveOwned('app-alias', importer)).toEqual({
      type: 'path',
      path: dir.path('packages/app/src/alias.ts'),
    })
    // The member alias is not visible from the workspace root.
    expect(await resolver.resolveOwned('app-alias', dir.path('main.ts'))).toBeNull()
  })

  it('reports import-map errors of owned specifiers with the importer', async () => {
    const { resolver, dir } = await setup({
      'deno.json': { workspace: ['./lib'] },
      'lib/deno.json': { name: '@ws/lib', version: '1.0.0', exports: { '.': './mod.ts' } },
    })
    const importer = dir.path('main.ts')
    const error: unknown = await resolver
      .resolveOwned('@ws/lib/missing', importer)
      .catch((caught: unknown) => caught)
    expect(isDenoPluginError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'RESOLVE_NOT_EXPORTED' })
  })
})

describe('resolveOwned: schemes, externals and the engine (§5.2 steps 2–3)', () => {
  it('mirrors jsr: and https: modules and returns the mirror file', async () => {
    const { resolver, dir, engine, mirror } = await setup(
      denoJson({ '@std/path': 'jsr:@std/path@^1' }),
    )
    engine.table.set('jsr:@std/path@^1', {
      kind: 'remote',
      url: 'https://jsr.io/@std/path/1.1.6/mod.ts',
      mediaType: 'TypeScript',
    })
    const importer = dir.path('src/main.ts')
    expect(await resolver.resolveOwned('@std/path', importer)).toEqual({
      type: 'mirror',
      path: mirror.mirrorPathFor('https://jsr.io/@std/path/1.1.6/mod.ts', 'TypeScript'),
      url: 'https://jsr.io/@std/path/1.1.6/mod.ts',
    })
    // The query of a remote URL is part of the resource.
    const esm = 'https://esm.sh/preact@10.19.0?target=esnext'
    const outcome = await resolver.resolveOwned(esm, importer)
    expect(outcome).toMatchObject({ type: 'mirror', url: esm })
    expect(engine.calls.at(-1)?.[0]).toBe(esm)
    expect(outcome !== null && 'path' in outcome && outcome.path.includes('?')).toBe(false)
  })

  it('mirrors data: modules', async () => {
    const { resolver, dir } = await setup({})
    const outcome = await resolver.resolveOwned(
      'data:text/javascript,export default 1',
      dir.path('main.ts'),
    )
    expect(outcome).toMatchObject({ type: 'mirror', url: 'data:text/javascript,export default 1' })
  })

  it('keeps builtins external, except node: for the browser', async () => {
    const node = await setup({}, {}, { platform: 'node' })
    const importer = node.dir.path('main.ts')
    expect(await node.resolver.resolveOwned('node:fs/promises', importer)).toEqual({
      type: 'external',
      id: 'node:fs/promises',
    })
    expect(await node.resolver.resolveOwned('bun:sqlite', importer)).toEqual({
      type: 'external',
      id: 'bun:sqlite',
    })
    expect(await node.resolver.resolveOwned('cloudflare:workers', importer)).toEqual({
      type: 'external',
      id: 'cloudflare:workers',
    })
    const browser = await setup({})
    expect(await browser.resolver.resolveOwned('node:fs', browser.dir.path('main.ts'))).toBeNull()
    expect(await browser.resolver.resolveOwned('bun:sqlite', browser.dir.path('main.ts'))).toEqual({
      type: 'external',
      id: 'bun:sqlite',
    })
    expect(node.engine.calls).toEqual([])
  })

  it('pins npm: and jsr: externals on the Deno platform (§5.6)', async () => {
    const { resolver, dir, engine } = await setup(
      denoJson({ kleur: 'npm:kleur@^4', '@std/path': 'jsr:@std/path@^1' }),
      {},
      { platform: 'deno' },
    )
    engine.table.set(
      'npm:kleur@^4/colors',
      npmModule(dir, 'kleur', '4.1.5', '/colors', 'colors.mjs'),
    )
    engine.table.set('jsr:@std/path@^1/join', {
      kind: 'remote',
      url: 'https://jsr.io/@std/path/1.1.6/join.ts',
      mediaType: 'TypeScript',
    })
    const importer = dir.path('main.ts')
    expect(await resolver.resolveOwned('kleur/colors', importer)).toEqual({
      type: 'external',
      id: 'npm:kleur@4.1.5/colors',
    })
    expect(await resolver.resolveOwned('@std/path/join', importer)).toEqual({
      type: 'external',
      id: 'jsr:@std/path@1.1.6/join',
    })
    expect(await resolver.resolveOwned('https://deno.land/x/mod.ts', importer)).toMatchObject({
      type: 'mirror',
    })
  })

  it('keeps the mapped range with pinExternals: false and bundles `bundle` matches', async () => {
    const files = denoJson({ kleur: 'npm:kleur@^4' })
    const ranges = await setup(files, { pinExternals: false }, { platform: 'deno' })
    expect(await ranges.resolver.resolveOwned('kleur', ranges.dir.path('main.ts'))).toEqual({
      type: 'external',
      id: 'npm:kleur@^4',
    })
    expect(ranges.engine.calls).toEqual([])
    const bundled = await setup(files, { bundle: ['npm:kleur'] }, { platform: 'deno' })
    bundled.engine.table.set(
      'npm:kleur@^4',
      npmModule(bundled.dir, 'kleur', '4.1.5', '', 'index.mjs'),
    )
    expect(await bundled.resolver.resolveOwned('kleur', bundled.dir.path('main.ts'))).toMatchObject(
      { type: 'npm-redirect' },
    )
  })

  it('externalises `external` matches on any platform', async () => {
    const { resolver, dir } = await setup({}, { external: ['https://esm.sh/*'] })
    expect(await resolver.resolveOwned('https://esm.sh/preact', dir.path('main.ts'))).toEqual({
      type: 'external',
      id: 'https://esm.sh/preact',
    })
  })

  it('resolves file: URLs to paths', async () => {
    const { resolver, dir } = await setup({})
    expect(
      await resolver.resolveOwned(`${toFileUrl(dir.path('src/x.ts'))}?raw`, dir.path('main.ts')),
    ).toEqual({
      type: 'path',
      path: `${dir.path('src/x.ts')}?raw`,
    })
  })

  it('keeps missing optional dependencies external', async () => {
    const { resolver, dir, engine } = await setup(denoJson({ opt: 'npm:opt@1' }))
    engine.table.set(
      'npm:opt@1',
      new EngineResolveError('RESOLVE_NOT_FOUND', 'optional', { isOptionalDependency: true }),
    )
    expect(await resolver.resolveOwned('opt', dir.path('main.ts'))).toEqual({
      type: 'external',
      id: 'npm:opt@1',
    })
  })

  it('adds the importer to engine errors', async () => {
    const { resolver, dir, engine } = await setup({})
    engine.table.set(
      'jsr:@std/missing',
      new DenoPluginError('RESOLVE_FAILED', 'Cannot resolve jsr:@std/missing.', {
        hint: 'Check it.',
      }),
    )
    const importer = dir.path('main.ts')
    const error: unknown = await resolver
      .resolveOwned('jsr:@std/missing', importer)
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'RESOLVE_FAILED',
      importer,
      specifier: 'jsr:@std/missing',
      hint: 'Check it.',
    })
  })

  it('applies the resolve option hook', async () => {
    const { resolver, dir, engine } = await setup(
      {},
      {
        resolve: (specifier, _importer, context) => {
          expect(context).toEqual({ host: 'rolldown', platform: 'browser' })
          if (specifier === 'jsr:@std/skip') return false
          return specifier === 'jsr:@std/alias' ? 'node:path' : undefined
        },
      },
    )
    const importer = dir.path('main.ts')
    expect(await resolver.resolveOwned('jsr:@std/skip', importer)).toBeNull()
    expect(await resolver.resolveOwned('jsr:@std/alias', importer)).toBeNull()
    expect(engine.calls).toEqual([])
  })
})

describe('resolveOwned: npm packages in the global cache (deno-cache)', () => {
  it('resolves bare and relative imports inside global-cache packages through the engine', async () => {
    const { resolver, engine, dir, denoDir } = await setup(
      denoJson({ kleur: 'npm:kleur@^4' }),
      {},
      { npmStrategy: 'deno-cache' },
    )
    const importer = join(denoDir, 'npm', 'registry.npmjs.org', 'strip-ansi', '7.2.0', 'index.js')
    const target = join(denoDir, 'npm', 'registry.npmjs.org', 'ansi-regex', '6.3.0', 'index.js')
    engine.table.set('ansi-regex', {
      kind: 'npm',
      url: toFileUrl(target),
      path: target,
      mediaType: 'JavaScript',
      npm: {
        name: 'ansi-regex',
        version: '6.3.0',
        subpath: '',
        packageDir: join(denoDir, 'npm', 'registry.npmjs.org', 'ansi-regex', '6.3.0'),
        packageJsonPath: '',
      },
      sideEffects: false,
    })
    expect(await resolver.resolveOwned('ansi-regex', importer)).toEqual({
      type: 'path',
      path: target,
      sideEffects: false,
    })
    expect(engine.calls).toEqual([['ansi-regex', toFileUrl(importer), 'import']])
    // The import map does not apply inside npm packages.
    engine.table.set('kleur', new DenoPluginError('RESOLVE_NOT_FOUND', 'no kleur dependency'))
    await expect(resolver.resolveOwned('kleur', importer)).rejects.toMatchObject({
      code: 'RESOLVE_NOT_FOUND',
    })
    // node_modules files use the engine too with this strategy.
    const inModules = dir.path('node_modules/a/index.js')
    engine.table.set('b', { kind: 'node', url: 'node:b', mediaType: 'Unknown' })
    expect(await resolver.resolveOwned('b', inModules)).toEqual({ type: 'external', id: 'node:b' })
  })
})

describe('resolveOwned: imports from mirror files', () => {
  it('resolves rewritten relative specifiers as paths and others against the source URL', async () => {
    const { resolver, mirror, engine } = await setup({})
    const url = 'https://x.test/lib/mod.js'
    engine.sources.set(url, 'import t from "./a.txt" with { type: "text" };\nimport "./b.js";\n')
    const file = await mirror.ensureMirrored(url)
    const outcome = await resolver.resolveOwned('./a.txt?deno-type=text', file.path)
    expect(outcome).toEqual({
      type: 'marker',
      path: `${mirror.mirrorPathFor('https://x.test/lib/a.txt', 'Unknown', 'asset')}?deno-type=text`,
      denoType: 'text',
      sourceUrl: 'https://x.test/lib/a.txt',
    })
    expect(await resolver.resolveOwned('./b.js', file.path)).toEqual({
      type: 'path',
      path: mirror.mirrorPathFor('https://x.test/lib/b.js', 'JavaScript'),
    })
    // Not a mirror file: the engine resolves it against the module's URL.
    const other = await resolver.resolveOwned('./other.js', file.path)
    expect(engine.calls.at(-1)).toEqual(['./other.js', url, 'import'])
    expect(other).toMatchObject({ type: 'mirror', url: 'https://x.test/lib/other.js' })
  })
})

describe('resolveOwned: import-attribute markers (§5.5)', () => {
  it('hands local and unmapped markers back to the host', async () => {
    const { resolver, dir } = await setup({})
    const importer = dir.path('src/main.ts')
    expect(await resolver.resolveOwned('./data.txt?deno-type=text', importer)).toEqual({
      type: 'host-marker',
      request: './data.txt',
      denoType: 'text',
    })
    expect(await resolver.resolveOwned('./data.txt?raw&deno-type=bytes', importer)).toEqual({
      type: 'host-marker',
      request: './data.txt?raw',
      denoType: 'bytes',
    })
    expect(await resolver.resolveOwned('pkg/style.css?deno-type=css', importer)).toEqual({
      type: 'host-marker',
      request: 'pkg/style.css',
      denoType: 'css',
    })
  })

  it('mirrors remote targets as raw assets, also when the engine refuses them', async () => {
    const { resolver, dir, engine, mirror } = await setup({})
    const url = 'https://cdn.test/x/style.css'
    engine.table.set(
      url,
      new DenoPluginError('RESOLVE_FAILED', 'The import attribute type of "css" is unsupported.'),
    )
    engine.sources.set(url, 'a{}')
    expect(await resolver.resolveOwned(`${url}?deno-type=css`, dir.path('main.ts'))).toEqual({
      type: 'marker',
      path: `${mirror.mirrorPathFor(url, 'Css', 'asset')}?deno-type=css`,
      denoType: 'css',
      sourceUrl: url,
    })
  })

  it('marks local and npm files the engine resolved', async () => {
    const { resolver, dir, engine } = await setup(
      denoJson({ data: './data.txt', pkg: 'npm:pkg@1' }),
    )
    const local = dir.path('data.txt')
    engine.table.set(toFileUrl(local), {
      kind: 'local',
      url: toFileUrl(local),
      path: local,
      mediaType: 'Unknown',
    })
    engine.table.set('npm:pkg@1/a.txt', npmModule(dir, 'pkg', '1.0.0', '/a.txt', 'a.txt'))
    expect(await resolver.resolveOwned('data?deno-type=text', dir.path('main.ts'))).toEqual({
      type: 'marker',
      path: `${local}?deno-type=text`,
      denoType: 'text',
      sourceUrl: toFileUrl(local),
    })
    expect(
      await resolver.resolveOwned('pkg/a.txt?deno-type=bytes', dir.path('main.ts')),
    ).toMatchObject({
      type: 'marker',
      path: `${dir.path('node_modules/.deno/pkg@1.0.0/node_modules/pkg/a.txt')}?deno-type=bytes`,
    })
  })
})

describe('resolveIdFilter', () => {
  it('matches owned schemes, markers and import-map keys', async () => {
    const { project } = await setup(
      denoJson({
        '@std/path': 'jsr:@std/path@^1',
        react: 'npm:react@19',
        'a.b': './x.ts',
        'dir/': './dir/',
      }),
    )
    const filter = resolveIdFilter(project, { npm: 'node_modules' }, 'browser')
    for (const id of [
      'jsr:@std/fmt',
      'npm:kleur',
      'https://x.test/a.ts',
      'http://x.test',
      'data:text/javascript,1',
      'node:fs',
      'bun:sqlite',
      'cloudflare:workers',
      'file:///x.ts',
      '@std/path',
      '@std/path/join',
      'react',
      'react/jsx-runtime',
      'react?raw',
      'a.b',
      'dir/x.ts',
      './a.txt?deno-type=text',
      'x.css?raw&deno-type=css',
    ]) {
      expect(filter.test(id)).toBe(true)
    }
    for (const id of [
      './util.ts',
      '/abs.ts',
      'reactx',
      '@std/pathx',
      'axb',
      'lodash',
      'virtual:x',
      '\0x',
      'C:\\x.ts',
    ]) {
      expect(filter.test(id)).toBe(false)
    }
  })

  it('adds every bare specifier for the deno-cache strategy', async () => {
    const { project } = await setup(denoJson({}))
    const filter = resolveIdFilter(project, { npm: 'deno-cache' }, 'browser')
    expect(filter.test('lodash')).toBe(true)
    expect(filter.test('./x.js')).toBe(false)
    expect(filter.test('\0x')).toBe(false)
    expect(BROAD_RESOLVE_ID_FILTER.test('lodash')).toBe(true)
    expect(BROAD_RESOLVE_ID_FILTER.test('jsr:x')).toBe(true)
    expect(BROAD_RESOLVE_ID_FILTER.test('./x.js')).toBe(false)
  })

  it('adds package.json dependencies for the Deno platform', async () => {
    const { project } = await setup({
      'deno.json': { imports: {} },
      'package.json': { dependencies: { react: '^19' }, devDependencies: { '@types/node': '*' } },
    })
    expect(packageJsonDependencyNames(project)).toEqual(['@types/node', 'react'])
    expect(resolveIdFilter(project, { npm: 'auto' }, 'deno').test('react/jsx-runtime')).toBe(true)
    expect(resolveIdFilter(project, { npm: 'node_modules' }, 'browser').test('react')).toBe(false)
  })
})
