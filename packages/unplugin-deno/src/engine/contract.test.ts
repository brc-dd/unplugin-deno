/**
 * The engine contract: every engine implementation must pass these tests on the `engine-*`
 * fixtures (docs/architecture.md §4.1). Remote fixtures download into the shared test DENO_DIR on
 * their first run and are served from it afterwards. The `deno` engine's run is skipped (with the
 * reason in its name) when the `deno` binary is missing or older than 2.8.3.
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { denoBinary } from '../../test/helpers/deno-binary.js'
import { denoDir } from '../../test/helpers/deno-dir.js'
import { normalize } from '../../test/helpers/normalize.js'
import { runtime } from '../../test/helpers/runtime.js'
import type { TempProject } from '../../test/helpers/temp-project.js'
import { tempProject } from '../../test/helpers/temp-project.js'
import type { ErrorCode } from '../diagnostics/errors.js'
import { isDenoPluginError } from '../diagnostics/errors.js'
import { createSilentLogger } from '../diagnostics/logger.js'
import { denoCliEngineFactory } from './deno-cli/engine.js'
import { loaderEngineFactory } from './loader/engine.js'
import type {
  Engine,
  EngineCreateOptions,
  EngineDiagnostic,
  EngineFactory,
  EngineProject,
  LoadedModule,
  ResolvedModule,
} from './types.js'

/** Every engine factory, with the reason its contract run is skipped in this environment. */
const engines: ReadonlyArray<{ factory: EngineFactory; skipReason: string | undefined }> = [
  { factory: loaderEngineFactory, skipReason: undefined },
  { factory: denoCliEngineFactory, skipReason: denoBinary.skipReason },
]

const JSR_PATH = 'https://jsr.io/@std/path/1.1.6/mod.ts'
const STD_COLORS = 'https://deno.land/std@0.224.0/fmt/colors.ts'

/** The engine project of a temporary fixture copy. */
function projectOf(
  temp: TempProject,
  nodeModulesDir: EngineProject['nodeModulesDir'],
): EngineProject {
  const configPath = temp.path('deno.json')
  const lockfilePath = temp.path('deno.lock')
  return {
    root: temp.root,
    workspaceRoot: temp.root,
    configPath: existsSync(configPath) ? configPath : undefined,
    lockfilePath: existsSync(lockfilePath) ? lockfilePath : undefined,
    nodeModulesDir,
  }
}

async function createEngine(
  factory: EngineFactory,
  project: EngineProject,
  options: Partial<EngineCreateOptions> = {},
): Promise<Engine> {
  vi.stubEnv('DENO_DIR', await denoDir())
  return factory.create({
    project,
    platform: 'browser',
    conditions: [],
    cachedOnly: false,
    logger: createSilentLogger(),
    denoBinary: denoBinary.binary,
    ...options,
  })
}

/** The error a promise rejects with (fails the test when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

function expectCode(error: unknown, code: ErrorCode): void {
  expect(isDenoPluginError(error)).toBe(true)
  expect(error).toMatchObject({ code })
}

function asModule(loaded: Awaited<ReturnType<Engine['load']>>): LoadedModule {
  if (loaded.kind !== 'module') throw new Error(`expected a module, got ${loaded.kind}`)
  return loaded
}

/** A resolved module with machine-specific paths replaced (see test/helpers/normalize.ts). */
/**
 * Replaces machine-specific paths in every string field of `module` with placeholders. Strings are
 * normalized one by one rather than through `JSON.stringify`, because JSON escapes Windows
 * backslashes (`D:\\a\\…`) and the path variants would no longer match.
 */
function portable(module: ResolvedModule, temp: TempProject): unknown {
  const options = { paths: [[temp.root, '<root>']] as const }
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return normalize(value, options)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]))
    }
    return value
  }
  return walk(module)
}

for (const { factory, skipReason } of engines) {
  describe.skipIf(skipReason !== undefined)(
    `${factory.kind} engine contract on ${runtime}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      contract(factory)
    },
  )
}

/** A path in the test DENO_DIR's npm cache, normalised (see test/helpers/normalize.ts). */
function cachedNpmFile(file: string | undefined): string {
  return `<deno-dir>/npm/registry.npmjs.org/${file ?? ''}`
}

/** The contract tests for one engine factory. */
function contract(factory: EngineFactory): void {
  describe('engine-basic', () => {
    let temp: TempProject
    let engine: Engine
    let main: string
    let diagnostics: EngineDiagnostic[]
    const resolve = (specifier: string): Promise<ResolvedModule> =>
      engine.resolve(specifier, main, 'import')

    beforeAll(async () => {
      temp = await tempProject('engine-basic')
      engine = await createEngine(factory, projectOf(temp, 'none'))
      main = temp.url('src/main.ts')
      diagnostics = await engine.addEntrypoints([main])
    }, 120_000)

    afterAll(async () => {
      await engine?.dispose()
      await temp?.dispose()
    })

    it('adds the entrypoint without diagnostics', () => {
      expect(diagnostics).toEqual([])
    })

    it('classifies jsr:, npm:, https:, node:, data:, relative and external resolutions', async () => {
      expect(await resolve('@std/path')).toEqual({
        kind: 'remote',
        url: JSR_PATH,
        mediaType: 'TypeScript',
      })
      expect(await resolve('fmt-colors')).toEqual({
        kind: 'remote',
        url: STD_COLORS,
        mediaType: 'TypeScript',
      })
      expect(await resolve('node:fs')).toEqual({
        kind: 'node',
        url: 'node:fs',
        mediaType: 'Unknown',
      })
      expect(await resolve('fs')).toEqual({ kind: 'node', url: 'node:fs', mediaType: 'Unknown' })
      expect(await resolve('data:text/javascript,export default 42')).toEqual({
        kind: 'data',
        url: 'data:text/javascript,export default 42',
        mediaType: 'JavaScript',
      })
      expect(await resolve('./util.ts')).toEqual({
        kind: 'local',
        url: temp.url('src/util.ts'),
        path: temp.path('src/util.ts'),
        mediaType: 'TypeScript',
      })
      expect((await resolve('./util')).path).toBe(temp.path('src/util.ts'))
      expect(await resolve('bun:sqlite')).toEqual({
        kind: 'external',
        url: 'bun:sqlite',
        mediaType: 'Unknown',
      })
    })

    it('resolves npm packages in the global cache with their package, version and subpath', async () => {
      const kleur = await engine.resolve('kleur', main, 'import')
      expect(portable(kleur, temp)).toEqual({
        kind: 'npm',
        url: 'file:///<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5/index.mjs',
        path: '<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5/index.mjs',
        mediaType: 'Mjs',
        npm: {
          name: 'kleur',
          version: '4.1.5',
          subpath: '',
          packageDir: '<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5',
          packageJsonPath: '<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5/package.json',
        },
        sideEffects: null,
      })
      expect(existsSync(kleur.path ?? '')).toBe(true)
      for (const specifier of ['kleur/colors', 'npm:kleur@^4/colors', 'npm:kleur@4.1.5/colors']) {
        const colors = await engine.resolve(specifier, main, 'import')
        expect(colors.kind).toBe('npm')
        expect(normalize(colors.path ?? '')).toBe(
          '<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5/colors.mjs',
        )
        expect(colors.npm).toMatchObject({ name: 'kleur', version: '4.1.5', subpath: '/colors' })
      }
      const required = await engine.resolve('kleur', main, 'require')
      expect(normalize(required.path ?? '')).toBe(
        '<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5/index.js',
      )
    })

    it('matches the resolutions recorded in fixture.json', async () => {
      const expected = temp.manifest.expect as { resolve: Record<string, string> }
      for (const [specifier, target] of Object.entries(expected.resolve)) {
        const resolved = await engine.resolve(specifier, main, 'import')
        expect(normalize(resolved.path ?? resolved.url)).toBe(target)
      }
    })

    it('resolves synchronously what is in the graph', () => {
      expect(engine.resolveSync?.('@std/path', main, 'import')?.url).toBe(JSR_PATH)
      expect(engine.resolveSync?.('./util.ts', main, 'import')?.kind).toBe('local')
      expect(engine.resolveSync?.('kleur', main, 'import')?.kind).toBe('npm')
    })

    it('falls back to asynchronous resolution for jsr: specifiers outside the graph', async () => {
      const specifier = 'jsr:@std/path@1.1.6/join'
      expect(engine.resolveSync?.(specifier, main, 'import')).toBeUndefined()
      expect(await engine.resolve(specifier, main, 'import')).toEqual({
        kind: 'remote',
        url: 'https://jsr.io/@std/path/1.1.6/join.ts',
        mediaType: 'TypeScript',
      })
      // Now part of the graph.
      expect(engine.resolveSync?.(specifier, main, 'import')?.url).toBe(
        'https://jsr.io/@std/path/1.1.6/join.ts',
      )
      // A mapped bare subpath (no other test resolves it): the loader's synchronous answer is
      // `jsr:/@std/path@^1/to-file-url`.
      expect(engine.resolveSync?.('@std/path/to-file-url', main, 'import')).toBeUndefined()
      expect((await engine.resolve('@std/path/to-file-url', main, 'import')).url).toBe(
        'https://jsr.io/@std/path/1.1.6/to_file_url.ts',
      )
    })

    it('falls back to asynchronous resolution when the synchronous one throws without a code', async () => {
      // Not in the lockfile or graph: `resolveSync` throws "Could not find constraint".
      const specifier = 'npm:esm-env@1.2.2/browser'
      expect(engine.resolveSync?.(specifier, main, 'import')).toBeUndefined()
      const resolved = await engine.resolve(specifier, main, 'import')
      expect(resolved.kind).toBe('npm')
      expect(resolved.npm).toMatchObject({ name: 'esm-env', version: '1.2.2', subpath: '/browser' })
      expect(normalize(resolved.path ?? '')).toBe(
        '<deno-dir>/npm/registry.npmjs.org/esm-env/1.2.2/true.js',
      )
    })

    it('resolves relative imports of remote modules', async () => {
      expect(await engine.resolve('./bytes.ts', STD_COLORS, 'import')).toEqual({
        kind: 'remote',
        url: 'https://deno.land/std@0.224.0/fmt/bytes.ts',
        mediaType: 'TypeScript',
      })
      expect((await engine.resolve('../path/mod.ts', STD_COLORS, 'import')).url).toBe(
        'https://deno.land/std@0.224.0/path/mod.ts',
      )
    })

    it('resolves referrer-less specifiers from the project root', async () => {
      expect((await engine.resolve('./src/util.ts', undefined, 'import')).path).toBe(
        temp.path('src/util.ts'),
      )
      expect((await engine.resolve('@std/path', undefined, 'import')).url).toBe(JSR_PATH)
    })

    it('loads jsr: modules as JavaScript with a separate source map', async () => {
      const loaded = asModule(await engine.load(JSR_PATH, 'default'))
      expect(loaded.url).toBe(JSR_PATH)
      expect(loaded.mediaType).toBe('TypeScript')
      expect(loaded.code).toContain('export * from "./basename.ts";')
      expect(loaded.code).not.toContain('sourceMappingURL')
      expect(loaded.code.endsWith('\n')).toBe(true)
      expect(loaded.map?.sources).toEqual([JSR_PATH])
      expect(loaded.map?.sourcesContent?.[0]).toContain('export * from "./basename.ts"')
      expect(loaded.map?.mappings).not.toBe('')
      // The loader keeps its inline source map in the bytes; `deno transpile` writes none.
      const bytes = new TextDecoder().decode(loaded.bytes)
      expect(bytes.startsWith(loaded.code)).toBe(true)
      expect(bytes.includes('sourceMappingURL=data:')).toBe(factory.kind === 'loader')
    })

    it('transpiles TypeScript and keeps text loads unchanged', async () => {
      const url = 'https://jsr.io/@std/path/1.1.6/join.ts'
      const code = asModule(await engine.load(url, 'default')).code
      expect(code).toContain('export function join(')
      expect(code).not.toMatch(/\.\.\.paths: string\[\]/)
      const text = asModule(await engine.load(url, 'text'))
      expect(text.code).toMatch(/\.\.\.paths: string\[\]/)
      expect(text.map).toBeUndefined()
      const colors = asModule(await engine.load(STD_COLORS, 'default'))
      expect(colors.map?.sources).toEqual([STD_COLORS])
    })

    it('loads data: URLs and reports node: builtins as external', async () => {
      const data = asModule(await engine.load('data:text/javascript,export default 42', 'default'))
      expect(data).toMatchObject({ mediaType: 'JavaScript', code: 'export default 42' })
      expect(data.map).toBeUndefined()
      expect(await engine.load('node:fs', 'default')).toEqual({ kind: 'external', url: 'node:fs' })
      expect(await engine.load('bun:sqlite', 'default')).toEqual({
        kind: 'external',
        url: 'bun:sqlite',
      })
    })

    it('refuses to load unresolved jsr: and npm: specifiers', async () => {
      for (const specifier of ['jsr:@std/path@^1', 'npm:kleur@^4']) {
        const error = await rejection(engine.load(specifier, 'default'))
        expectCode(error, 'RESOLVE_FAILED')
        expect(error).toMatchObject({ hint: expect.stringMatching(/resolve/i) })
      }
    })

    it('returns diagnostics for broken imports instead of throwing', async () => {
      const broken = await engine.addEntrypoints([temp.url('src/broken.ts')])
      expect(broken).toHaveLength(2)
      expect(broken.map((diagnostic) => diagnostic.message).join('\n')).toMatch(
        /does-not-exist\.ts[\s\S]*not-in-the-import-map|not-in-the-import-map[\s\S]*does-not-exist\.ts/,
      )
      // An unresolvable entrypoint does not stop the others from being added.
      const mixed = await engine.addEntrypoints(['not-in-the-import-map', './src/util.ts'])
      expect(mixed).toHaveLength(1)
      expect(mixed[0]?.message).toContain('not-in-the-import-map')
    })

    it('maps resolution failures to stable error codes', async () => {
      const failure = (specifier: string, referrer: string | undefined = main): Promise<unknown> =>
        rejection(engine.resolve(specifier, referrer, 'import'))
      const unmapped = await failure('not-in-the-import-map')
      expectCode(unmapped, 'RESOLVE_UNMAPPED_BARE')
      expect(unmapped).toMatchObject({
        specifier: 'not-in-the-import-map',
        importer: main,
        hint: expect.stringContaining('`imports` in deno.json'),
      })
      expectCode(await failure('npm:kleur@^4/nope'), 'RESOLVE_NOT_EXPORTED')
      const constraint = await failure('jsr:@std/path@^99')
      expectCode(constraint, 'RESOLVE_CONSTRAINT')
      expect((constraint as Error).message).toContain("version constraint '^99'")
      const unknownExport = await failure('@std/path/nope')
      expectCode(unknownExport, 'RESOLVE_FAILED')
      expect((unknownExport as Error).message).toContain("Unknown export './nope'")
      expect(unknownExport).toMatchObject({ hint: expect.stringContaining('does not export') })
      const kleurUrl = (await engine.resolve('kleur', main, 'import')).url
      const missingDependency = await failure('not-a-dependency-of-kleur', kleurUrl)
      expectCode(missingDependency, 'RESOLVE_NOT_FOUND')
      expect(missingDependency).toMatchObject({ isOptionalDependency: false })
    })

    it('handles 20 concurrent resolutions', async () => {
      const specifiers = [
        '@std/path',
        '@std/path/windows',
        'jsr:@std/path@^1/basename',
        'jsr:@std/path@^1/dirname',
        'jsr:@std/path@^1/extname',
        'jsr:@std/path@1.1.6/relative',
        'jsr:@std/path@1.1.6/normalize',
        'jsr:@std/path@1.1.6/parse',
        'kleur',
        'kleur/colors',
        'npm:kleur@4.1.5',
        'npm:esm-env@1.2.2/node',
        'npm:esm-env@1.2.2/development',
        'fmt-colors',
        'node:path',
        'fs',
        './util.ts',
        'data:text/javascript,export {}',
        'https://deno.land/std@0.224.0/fmt/printf.ts',
        'jsr:@std/internal@^1.0.14/os',
      ]
      const results = await Promise.all(
        specifiers.map((specifier) => engine.resolve(specifier, main, 'import')),
      )
      expect(results.map((result) => result.kind)).toEqual([
        'remote',
        'remote',
        'remote',
        'remote',
        'remote',
        'remote',
        'remote',
        'remote',
        'npm',
        'npm',
        'npm',
        'npm',
        'npm',
        'remote',
        'node',
        'node',
        'local',
        'data',
        'remote',
        'remote',
      ])
      expect(results[5]?.url).toBe('https://jsr.io/@std/path/1.1.6/relative.ts')
      expect(results[19]?.url).toBe('https://jsr.io/@std/internal/1.0.14/os.ts')
    })

    it('exposes the module graph', () => {
      const graph = engine.graph() as { roots: string[]; modules: Array<{ specifier: string }> }
      expect(graph.roots).toContain(main)
      expect(graph.modules.map((module) => module.specifier)).toContain(JSR_PATH)
    })
  })

  describe('engine-node-modules-auto', () => {
    it(
      'installs npm packages into node_modules/.deno while adding entrypoints',
      { timeout: 120_000 },
      async () => {
        await using temp = await tempProject('engine-node-modules-auto')
        await using engine = await createEngine(factory, projectOf(temp, 'auto'))
        expect(existsSync(temp.path('node_modules'))).toBe(false)
        expect(await engine.addEntrypoints([temp.url('src/main.ts')])).toEqual([])
        expect(existsSync(temp.path('node_modules/.deno'))).toBe(true)
        const expected = temp.manifest.expect as { packageDir: string }
        const packageDir = temp.path(expected.packageDir)
        const kleur = await engine.resolve('kleur', temp.url('src/main.ts'), 'import')
        expect(kleur).toEqual({
          kind: 'npm',
          url: temp.url(expected.packageDir, 'index.mjs'),
          path: temp.path(expected.packageDir, 'index.mjs'),
          mediaType: 'Mjs',
          npm: {
            name: 'kleur',
            version: '4.1.5',
            subpath: '',
            packageDir,
            packageJsonPath: temp.path(expected.packageDir, 'package.json'),
          },
          sideEffects: null,
        })
        const colors = await engine.resolve(
          'npm:kleur@^4/colors',
          temp.url('src/main.ts'),
          'import',
        )
        expect(colors.path).toBe(temp.path(expected.packageDir, 'colors.mjs'))
        expect(colors.npm).toMatchObject({ name: 'kleur', subpath: '/colors', packageDir })
      },
    )

    it(
      'installs on demand when resolving before any entrypoint was added',
      { timeout: 120_000 },
      async () => {
        await using temp = await tempProject('engine-node-modules-auto')
        await using engine = await createEngine(factory, projectOf(temp, 'auto'))
        const main = temp.url('src/main.ts')
        // Known from the lockfile but not installed: the synchronous path cannot answer.
        expect(engine.resolveSync?.('kleur', main, 'import')).toBeUndefined()
        const kleur = await engine.resolve('kleur', main, 'import')
        expect(kleur.path).toBe(
          temp.path('node_modules/.deno/kleur@4.1.5/node_modules/kleur/index.mjs'),
        )
        expect(existsSync(kleur.path ?? '')).toBe(true)
      },
    )

    it(
      'installs npm packages on their first resolution, without entrypoints',
      { timeout: 120_000 },
      async () => {
        await using temp = await tempProject('engine-node-modules-auto')
        await using engine = await createEngine(factory, projectOf(temp, 'auto'))
        const main = temp.url('src/main.ts')
        const expected = temp.manifest.expect as { packageDir: string }
        // What a Vite dev server does: its entrypoints are HTML files, so nothing seeds the graph.
        const colors = await engine.resolve('npm:kleur@^4/colors', main, 'import')
        expect(colors.path).toBe(temp.path(expected.packageDir, 'colors.mjs'))
        expect(colors.npm).toMatchObject({ name: 'kleur', version: '4.1.5', subpath: '/colors' })
        // Installed: the synchronous path answers, for the other resolution mode too.
        expect(engine.resolveSync?.('npm:kleur@^4/colors', main, 'import')?.path).toBe(colors.path)
        expect((await engine.resolve('kleur', main, 'require')).path).toBe(
          temp.path(expected.packageDir, 'index.js'),
        )
        // A second package (not in the lockfile) installs on its first resolution as well.
        const esmEnv = await engine.resolve('npm:esm-env@1.2.2/browser', main, 'import')
        expect(esmEnv.path).toBe(
          temp.path('node_modules/.deno/esm-env@1.2.2/node_modules/esm-env/true.js'),
        )
        expect(existsSync(esmEnv.path ?? '')).toBe(true)
      },
    )

    it('does not let a failed or premature resolution stick', { timeout: 120_000 }, async () => {
      await using temp = await tempProject('engine-node-modules-auto')
      await using engine = await createEngine(factory, projectOf(temp, 'auto'))
      const main = temp.url('src/main.ts')
      const expected = temp.manifest.expect as { packageDir: string }
      const colors = temp.path(expected.packageDir, 'colors.mjs')
      // A mapped bare subpath: only the loader knows it names an npm package, so the synchronous
      // path looks for its files before the package is installed.
      expect(engine.resolveSync?.('kleur/colors', main, 'import')).toBeUndefined()
      expect((await engine.resolve('kleur/colors', main, 'import')).path).toBe(colors)
      expect(engine.resolveSync?.('kleur/colors', main, 'import')?.path).toBe(colors)
      // A subpath the package does not export fails; other subpaths keep resolving.
      expectCode(
        await rejection(engine.resolve('npm:kleur@^4/nope', main, 'import')),
        'RESOLVE_NOT_EXPORTED',
      )
      expect((await engine.resolve('npm:kleur@^4/colors', main, 'import')).path).toBe(colors)
      // Concurrent first resolutions of one package share its installation.
      const results = await Promise.all(
        ['npm:esm-env@1.2.2/browser', 'npm:esm-env@1.2.2', 'npm:esm-env@1.2.2/node'].map(
          (specifier) => engine.resolve(specifier, main, 'import'),
        ),
      )
      expect(results.map((result) => result.npm?.name)).toEqual(['esm-env', 'esm-env', 'esm-env'])
    })
  })

  describe('engine-node-modules-manual', () => {
    it(
      'never installs, reports missing packages and resolves them once installed',
      { timeout: 60_000 },
      async () => {
        await using temp = await tempProject('engine-node-modules-manual')
        await using engine = await createEngine(factory, projectOf(temp, 'manual'))
        const main = temp.url('src/main.ts')
        for (const specifier of ['npm:stub-pkg@^1', 'stub-pkg']) {
          const missing = await rejection(engine.resolve(specifier, main, 'import'))
          expectCode(missing, 'RESOLVE_NOT_FOUND')
          expect(missing).toMatchObject({ hint: expect.stringContaining('`deno install`') })
        }
        expect(existsSync(temp.path('node_modules'))).toBe(false)
        // Installed by the user (`deno install`, npm, pnpm, …) while the engine lives.
        const expected = temp.manifest.expect as { packageDir: string }
        const packageDir = temp.path(expected.packageDir)
        await mkdir(packageDir, { recursive: true })
        await writeFile(
          temp.path(expected.packageDir, 'package.json'),
          JSON.stringify({
            name: 'stub-pkg',
            version: '1.0.0',
            type: 'module',
            exports: './index.js',
          }),
        )
        await writeFile(temp.path(expected.packageDir, 'index.js'), 'export default (s) => s\n')
        for (const specifier of ['npm:stub-pkg@^1', 'stub-pkg']) {
          const resolved = await engine.resolve(specifier, main, 'import')
          expect(resolved).toMatchObject({
            kind: 'npm',
            path: temp.path(expected.packageDir, 'index.js'),
            npm: { name: 'stub-pkg', version: '1.0.0', subpath: '', packageDir },
          })
        }
      },
    )

    it('reports packages missing from node_modules when adding entrypoints', async () => {
      await using temp = await tempProject('engine-node-modules-manual')
      await using engine = await createEngine(factory, projectOf(temp, 'manual'))
      const diagnostics = await engine.addEntrypoints([temp.url('src/main.ts')])
      expect(diagnostics.filter((diagnostic) => diagnostic.code !== undefined)).toEqual([
        {
          code: 'RESOLVE_NOT_FOUND',
          message: expect.stringMatching(/^npm:stub-pkg@\^1 is not installed\. .*`deno install`/),
        },
      ])
      expect(existsSync(temp.path('node_modules'))).toBe(false)
    })
  })

  describe('engine-no-config', () => {
    it('resolves jsr: and npm: specifiers without a deno.json', { timeout: 120_000 }, async () => {
      await using temp = await tempProject('engine-no-config')
      const project = projectOf(temp, 'none')
      expect(project.configPath).toBeUndefined()
      await using engine = await createEngine(factory, project)
      const main = temp.url('src/main.ts')
      expect(await engine.addEntrypoints([main])).toEqual([])
      expect((await engine.resolve('jsr:@std/path@1.1.6', main, 'import')).url).toBe(JSR_PATH)
      const kleur = await engine.resolve('npm:kleur@4.1.5', main, 'import')
      expect(kleur.kind).toBe('npm')
      expect(normalize(kleur.path ?? '')).toBe(
        '<deno-dir>/npm/registry.npmjs.org/kleur/4.1.5/index.mjs',
      )
      expect(kleur.npm).toMatchObject({ name: 'kleur', version: '4.1.5', subpath: '' })
      expectCode(await rejection(engine.resolve('kleur', main, 'import')), 'RESOLVE_UNMAPPED_BARE')
    })
  })

  describe('engine-platform-conditions', () => {
    let temp: TempProject

    beforeAll(async () => {
      temp = await tempProject('engine-platform-conditions')
    })

    afterAll(async () => {
      await temp?.dispose()
    })

    const cases: Array<[string, Pick<EngineCreateOptions, 'platform' | 'conditions'>]> = [
      ['browser', { platform: 'browser', conditions: [] }],
      ['node', { platform: 'node', conditions: [] }],
      ['node+development', { platform: 'node', conditions: ['development'] }],
    ]

    it.each(cases)(
      'resolves conditional exports for %s',
      { timeout: 120_000 },
      async (name, options) => {
        await using engine = await createEngine(factory, projectOf(temp, 'none'), options)
        const main = temp.url('src/main.ts')
        expect(await engine.addEntrypoints([main])).toEqual([])
        const expected =
          (temp.manifest.expect as Record<string, Record<string, string>>)[name] ?? {}
        for (const [specifier, file] of Object.entries(expected)) {
          const resolved = await engine.resolve(specifier, main, 'import')
          expect(normalize(resolved.path ?? '')).toBe(
            `<deno-dir>/npm/registry.npmjs.org/esm-env/1.2.2/${file}`,
          )
          expect(resolved.npm).toMatchObject({
            name: 'esm-env',
            version: '1.2.2',
            subpath: specifier.slice('esm-env'.length),
          })
        }
      },
    )
  })

  describe('engine-npm-dependencies', () => {
    it(
      'resolves relative, bare and builtin imports inside global-cache npm packages',
      { timeout: 120_000 },
      async () => {
        await using temp = await tempProject('engine-npm-dependencies')
        const expected = temp.manifest.expect as Record<string, string>
        const cached = cachedNpmFile
        await using engine = await createEngine(factory, projectOf(temp, 'none'))
        const main = temp.url('src/main.ts')
        expect(await engine.addEntrypoints([main])).toEqual([])
        // The `browser` field wins on the browser platform (there are no `exports`).
        const debug = await engine.resolve('debug', main, 'import')
        expect(normalize(debug.path ?? '')).toBe(cached(expected.browser))
        expect(debug.npm).toMatchObject({ name: 'debug', version: '4.4.3', subpath: '' })
        // `require('./common')`: a `.js` extension is added.
        const common = await engine.resolve('./common', debug.url, 'require')
        expect(normalize(common.path ?? '')).toBe(cached(expected.common))
        expect(common.npm).toMatchObject({ name: 'debug', subpath: '/src/common.js' })
        // A dependency of the package, whose `main` (`./index`) has no extension.
        const ms = await engine.resolve('ms', common.url, 'require')
        expect(ms).toMatchObject({
          kind: 'npm',
          npm: { name: 'ms', version: '2.1.3', subpath: '' },
        })
        expect(normalize(ms.path ?? '')).toBe(cached(expected.ms))
        expect(await engine.resolve('tty', common.url, 'require')).toEqual({
          kind: 'node',
          url: 'node:tty',
          mediaType: 'Unknown',
        })
        const missing = await rejection(engine.resolve('not-a-dependency', common.url, 'import'))
        expectCode(missing, 'RESOLVE_NOT_FOUND')
        expect(missing).toMatchObject({ isOptionalDependency: false })
        await using node = await createEngine(factory, projectOf(temp, 'none'), {
          platform: 'node',
        })
        expect(normalize((await node.resolve('debug', main, 'import')).path ?? '')).toBe(
          cached(expected.node),
        )
      },
    )
  })
}
