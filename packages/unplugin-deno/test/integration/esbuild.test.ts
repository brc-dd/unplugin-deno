/**
 * esbuild builds (docs/architecture.md §6.4): the core fixtures with the assertions of
 * `core-suite.ts` (esbuild output described by its metafile), the esbuild-specific fixtures
 * (`esbuild-*`), and the adapter's own behaviour: Go-side filters instead of catch-alls, esbuild's
 * `external` and `packages` options, contexts and rebuilds, errors as esbuild messages, and
 * plugin instances shared by several builds.
 */
import { execFile } from 'node:child_process'
import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify, stripVTControlCharacters } from 'node:util'
import type {
  BuildFailure,
  OnLoadArgs,
  OnResolveArgs,
  OnResolveResult,
  Plugin,
  PluginBuild,
} from 'esbuild'
import { build as esbuildBuild, context as esbuildContext } from 'esbuild'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { Options } from '../../src/core/options.js'
import denoEsbuild from '../../src/esbuild.js'
import { evaluateModule, installCssStyleSheet } from '../helpers/build.js'
import type { BuildEntries } from '../helpers/build.js'
import { testDenoDirPath } from '../helpers/deno-dir.js'
import type { EsbuildBuildOptions, EsbuildBuildResult } from '../helpers/esbuild.js'
import {
  buildWithEsbuild,
  collectResult,
  contextWithEsbuild,
  esbuildOptions,
} from '../helpers/esbuild.js'
import type { TempProject } from '../helpers/temp-project.js'
import { DENO_AVAILABLE, fixture } from './core-suite.js'

const execFileAsync = promisify(execFile)
const timeout = { timeout: 180_000 }

function noop(): void {}

/** A promise and the function that resolves it. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire = noop
  const promise = new Promise<void>((done) => {
    fire = done
  })
  return { promise, fire }
}

/** The number of times a build added entry points to the engine (debug output). */
function entrypointsAdded(out: EsbuildBuildResult): number {
  return out.logs.filter((log) => /\[core\] added \d+ entrypoint/.test(log.message)).length
}

/** Builds with esbuild; the output directory is removed after the test. */
async function bundle(
  root: string,
  entries: BuildEntries,
  options: Options = {},
  extra: EsbuildBuildOptions = {},
): Promise<EsbuildBuildResult> {
  const out = await buildWithEsbuild(root, entries, options, extra)
  onTestFinished(() => out.dispose())
  return out
}

function entryChunk(out: EsbuildBuildResult): EsbuildBuildResult['chunks'][number] {
  const chunk = out.chunks.find((item) => item.isEntry)
  if (chunk === undefined) throw new Error('no entry chunk')
  return chunk
}

function expectedValues(project: TempProject): Record<string, unknown> {
  return (project.manifest.expect?.values ?? {}) as Record<string, unknown>
}

/** Module ids with `/` separators, for assertions that hold on Windows too. */
function slashed(ids: readonly string[]): string[] {
  return ids.map((id) => id.replaceAll('\\', '/'))
}

/** The mirror generation directories of a project (default `cacheDir`). */
function generations(root: string): string[] {
  const cacheDir = join(root, 'node_modules', '.unplugin-deno')
  if (!existsSync(cacheDir)) return []
  return readdirSync(cacheDir).filter((name) => /^[0-9a-f]{8}$/.test(name))
}

/** The single mirror generation directory of a project. */
function generationDir(root: string): string {
  const found = generations(root)
  expect(found).toHaveLength(1)
  return join(root, 'node_modules', '.unplugin-deno', found[0] ?? '')
}

function mirrorLoads(out: EsbuildBuildResult): string[] {
  return out.logs
    .map((log) => log.message)
    .filter((message) => message.includes('[mirror] loading '))
}

/** Imports an output file under a new name, so rebuilt output is not served from the cache. */
async function evaluateCopy<T>(file: string, name: string): Promise<T> {
  const copy = join(dirname(file), `${name}.mjs`)
  await copyFile(file, copy)
  return (await import(pathToFileURL(copy).href)) as T
}

/** esbuild's counterpart of core-suite's `?raw` plugin: serves `?raw` imports as text. */
function rawQueryPlugin(seen: string[]): Plugin {
  return {
    name: 'test-raw-query',
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (args) => {
        seen.push(args.path)
        return {
          path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
          namespace: 'raw',
        }
      })
      build.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
        contents: readFileSync(args.path, 'utf8'),
        loader: 'text',
      }))
    },
  }
}

/** A companion plugin with `virtual:` modules in its own namespace; records what reaches it. */
function virtualPlugin(seen: string[]): Plugin {
  return {
    name: 'test-virtual',
    setup(build) {
      build.onResolve({ filter: /^virtual:/ }, (args) => {
        seen.push(args.path)
        return { path: args.path, namespace: 'test-virtual' }
      })
      build.onLoad({ filter: /.*/, namespace: 'test-virtual' }, (args) => ({
        contents:
          args.path === 'virtual:answer'
            ? 'export default 42'
            : 'const note = "with { type: \'text\' } stays as it is"\nexport default `hi, ${note}`',
        loader: 'js',
      }))
    },
  }
}

/** A callback registration of the plugin under test. */
interface Registration {
  hook: 'onResolve' | 'onLoad'
  filter: RegExp
  namespace: string | undefined
}

/**
 * Wraps the plugin so its `onResolve`/`onLoad` registrations, the paths that reach its
 * `onResolve` callbacks and their results are recorded (the real esbuild build object does the
 * work).
 */
function recording(
  plugin: Plugin,
  registrations: Registration[],
  calls: string[],
  results: OnResolveResult[] = [],
): Plugin {
  return {
    name: plugin.name,
    setup(build) {
      const proxy: PluginBuild = {
        ...build,
        initialOptions: build.initialOptions,
        resolve: (path, options) => build.resolve(path, options),
        onStart: (callback) => build.onStart(callback),
        onEnd: (callback) => build.onEnd(callback),
        onDispose: (callback) => build.onDispose(callback),
        onResolve(options, callback) {
          registrations.push({
            hook: 'onResolve',
            filter: options.filter,
            namespace: options.namespace,
          })
          build.onResolve(options, async (args: OnResolveArgs) => {
            calls.push(args.path)
            const result = await callback(args)
            if (result !== null && result !== undefined) results.push(result)
            return result
          })
        },
        onLoad(options, callback) {
          registrations.push({
            hook: 'onLoad',
            filter: options.filter,
            namespace: options.namespace,
          })
          build.onLoad(options, (args: OnLoadArgs) => callback(args))
        },
      }
      return plugin.setup(proxy)
    },
  }
}

async function buildFailure(promise: Promise<unknown>): Promise<BuildFailure> {
  const failure: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  return failure as BuildFailure
}

describe('the esbuild plugin', () => {
  it("bypasses unplugin's generic adapter and registers Go-side filters", timeout, async () => {
    const project = await fixture('core-basic')
    const plugin = denoEsbuild()
    expect(Object.keys(plugin).toSorted()).toEqual(['name', 'setup'])
    expect(plugin.name).toBe('unplugin-deno')
    const registrations: Registration[] = []
    const calls: string[] = []
    const results: OnResolveResult[] = []
    const seen: string[] = []
    const options = await prepare(
      project.root,
      project.manifest.entries,
      {},
      {
        platform: 'node',
        write: false,
      },
    )
    options.plugins = [
      recording(denoEsbuild(), registrations, calls, results),
      rawQueryPlugin(seen),
    ]
    const result = await esbuildBuild(options)
    expect(result.errors).toEqual([])
    expect(seen).toEqual(['./message.txt?raw'])
    // No catch-all outside the plugin's own namespace; no onLoad for files at all.
    for (const registration of registrations) {
      if (registration.namespace === 'unplugin-deno') continue
      expect(registration.filter.source).not.toBe('.*')
      expect(registration.hook).toBe('onResolve')
    }
    const main = registrations[0]?.filter
    expect(main?.test('jsr:@std/path')).toBe(true)
    expect(main?.test('@std/path/join')).toBe(true)
    expect(main?.test('kleur')).toBe(true)
    expect(main?.test('@app/greet')).toBe(true)
    expect(main?.test('./util.ts')).toBe(false)
    expect(main?.test('lodash')).toBe(false)
    expect(registrations).toContainEqual({
      hook: 'onLoad',
      filter: /.*/,
      namespace: 'unplugin-deno',
    })
    // Relative imports and `?raw` never reached the plugin.
    expect(calls).not.toContain('./util.ts')
    expect(calls).not.toContain('./message.txt?raw')
    expect(calls).toEqual(
      expect.arrayContaining(['@std/path/posix', 'kleur', 'node:path', '@app/greet']),
    )
    // Owned resolutions carry the config files, so esbuild's watch mode rebuilds when they change.
    expect(results.length).toBeGreaterThan(0)
    for (const resolved of results) {
      expect(resolved.watchFiles).toEqual(
        expect.arrayContaining([project.path('deno.json'), project.path('deno.lock')]),
      )
    }
  })

  it('rejects hosts that are not esbuild with ENGINE_UNAVAILABLE', async () => {
    const plugin = denoEsbuild()
    // Bun's esbuild-like builder: `config` instead of `initialOptions`, no `resolve`.
    const bunLike = { config: {}, onResolve() {}, onLoad() {} } as unknown as PluginBuild
    await expect(Promise.resolve().then(() => plugin.setup(bunLike))).rejects.toMatchObject({
      name: 'DenoPluginError',
      code: 'ENGINE_UNAVAILABLE',
    })
  })

  it(
    'reports failing owned imports as esbuild errors at the import, with code and hint',
    timeout,
    async () => {
      const project = await fixture('core-basic')
      await writeFile(
        project.path('src/broken.ts'),
        "import pad from 'npm:unplugin-deno-test-missing-package@1'\nexport default pad\n",
      )
      const options = await prepare(
        project.root,
        'src/broken.ts',
        { cachedOnly: true },
        {
          write: false,
        },
      )
      const failure = await buildFailure(esbuildBuild(options))
      const [error] = failure.errors
      expect(error?.text).toMatch(
        /is not in the Deno cache and `cachedOnly` is set\. \(CACHED_ONLY_MISS\)$/,
      )
      expect(error?.pluginName).toBe('unplugin-deno')
      expect(error?.location?.file).toBe('src/broken.ts')
      expect(error?.location?.lineText).toContain('npm:unplugin-deno-test-missing-package@1')
      expect(error?.detail).toMatchObject({ name: 'DenoPluginError', code: 'CACHED_ONLY_MISS' })
      expect(error?.notes.some((note) => note.text.startsWith('hint: '))).toBe(true)
    },
  )

  it('reports a broken deno.json once and recovers in a context', timeout, async () => {
    const project = await fixture('esbuild-context-rebuild')
    const config = project.path('deno.json')
    const original = await readFile(config, 'utf8')
    await writeFile(config, '{ "imports": ')
    const options = await prepare(
      project.root,
      project.manifest.entries,
      {},
      { platform: 'browser', write: false },
    )
    const ctx = await esbuildContext(options)
    onTestFinished(() => ctx.dispose())
    // One error from onStart; the owned imports do not add one each.
    const failure = await buildFailure(ctx.rebuild())
    expect(
      failure.errors.map((error) => ({
        text: error.text,
        code: (error.detail as { code?: string } | undefined)?.code,
      })),
    ).toEqual([expect.objectContaining({ code: 'CONFIG_INVALID' })])
    // The filters registered without a project are broad, so the fixed config works in place.
    await writeFile(config, original)
    const fixed = await ctx.rebuild()
    expect(fixed.errors).toEqual([])
    const main = fixed.outputFiles?.find((file) => file.path.endsWith('main.js'))
    expect(main?.text).toContain('"hello"')
  })
})

describe('npm redirects (esbuild)', () => {
  it(
    'uses the file the engine resolved when esbuild cannot resolve a package',
    timeout,
    async () => {
      const project = await fixture('core-npm-node-modules')
      // Refuses the redirected requests (esbuild's resolution from the package's package.json).
      const refuse: Plugin = {
        name: 'test-refuse',
        setup(build) {
          build.onResolve({ filter: /^(?:kleur\/colors|lodash-es)$/ }, (args) =>
            args.importer.endsWith('package.json') ? { errors: [{ text: 'refused' }] } : undefined,
          )
        },
      }
      const out = await bundle(
        project.root,
        project.manifest.entries,
        { platform: 'node', debug: true },
        { platform: 'node', plugins: [refuse] },
      )
      const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
      expect(values).toMatchObject(expectedValues(project))
      const fallbacks = out.logs.filter((log) =>
        /\[esbuild\] \S+ does not resolve/.test(log.message),
      )
      expect(fallbacks.map((log) => /\[esbuild\] (\S+)/.exec(log.message)?.[1]).toSorted()).toEqual(
        ['kleur/colors', 'lodash-es'],
      )
      // The package's `sideEffects: false` still reaches esbuild.
      const lodashBytes = Object.entries(entryChunk(out).moduleSizes)
        .filter(([id]) => /[\\/]lodash-es[\\/]/.test(id))
        .reduce((total, [, size]) => total + size, 0)
      expect(lodashBytes).toBeGreaterThan(0)
      expect(lodashBytes).toBeLessThan(project.manifest.expect?.maxBytes as number)
    },
  )
})

describe('core-basic (esbuild)', () => {
  it('bundles jsr:, npm:, https:, data:, node:, local and aliased imports', timeout, async () => {
    const project = await fixture('core-basic')
    const seen: string[] = []
    const out = await bundle(
      project.root,
      project.manifest.entries,
      { platform: 'node' },
      {
        platform: 'node',
        plugins: [rawQueryPlugin(seen)],
      },
    )
    const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
    expect(values).toMatchObject(expectedValues(project))
    expect(stripVTControlCharacters(String(values.colored))).toBe('x')
    // The ?raw import reached the other plugin untouched.
    expect(seen).toEqual(['./message.txt?raw'])
    const chunk = entryChunk(out)
    expect(chunk.imports.filter((id) => /^(?:jsr|npm|https?|data):/.test(id))).toEqual([])
    expect(chunk.imports).toContain('node:path')
    expect(chunk.moduleIds.some((id) => id.includes('closest_string.ts.js'))).toBe(true)
    // Local, mirror and npm files are in esbuild's file namespace (it loads them itself).
    expect(chunk.moduleIds.filter((id) => id.startsWith('unplugin-deno:'))).toEqual([])
    expect(out.warnings).toEqual([])
  })
})

describe('core-import-map-precedence (esbuild)', () => {
  it('resolves a mapped bare name through the import map, not node_modules', timeout, async () => {
    const project = await fixture('core-import-map-precedence')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      { platform: 'node' },
      { platform: 'node' },
    )
    const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
    expect(values).toMatchObject(expectedValues(project))
    const ids = slashed(entryChunk(out).moduleIds)
    const kleur = ids.filter((id) => id.includes('/kleur/'))
    expect(kleur).toHaveLength(1)
    expect(kleur[0]).toContain('/npm/registry.npmjs.org/kleur/4.1.5/')
    expect(ids.some((id) => id.includes('/node_modules/kleur/'))).toBe(false)
    // An unmapped name stays with esbuild's resolver.
    expect(ids).toContain(project.path('node_modules/stub-only-pkg/index.js').replaceAll('\\', '/'))
  })
})

const npmLocations: Record<string, { ansiRegex: string; installed: boolean }> = {
  // Redirected: esbuild resolved the packages inside node_modules/.deno.
  'core-npm-node-modules': { ansiRegex: '/node_modules/.deno/ansi-regex@6.3.0/', installed: true },
  // Global cache: the engine resolved strip-ansi's import of ansi-regex (no node_modules).
  'core-npm-global-cache': {
    ansiRegex: '/npm/registry.npmjs.org/ansi-regex/6.3.0/',
    installed: false,
  },
}
for (const [name, location] of Object.entries(npmLocations)) {
  describe(`${name} (esbuild)`, () => {
    it('bundles npm subpaths, CommonJS and tree-shaken ES packages', timeout, async () => {
      const project = await fixture(name)
      const out = await bundle(
        project.root,
        project.manifest.entries,
        { platform: 'node' },
        {
          platform: 'node',
        },
      )
      const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
      expect(values).toMatchObject(expectedValues(project))
      const chunk = entryChunk(out)
      // `sideEffects: false` reaches esbuild: only lodash-es's chunk() and its helpers remain.
      const lodash = Object.entries(chunk.moduleSizes).filter(([id]) =>
        /[\\/]lodash-es[\\/]/.test(id),
      )
      const lodashBytes = lodash.reduce((total, [, size]) => total + size, 0)
      expect(lodashBytes).toBeGreaterThan(0)
      expect(lodashBytes).toBeLessThan(project.manifest.expect?.maxBytes as number)
      const ids = slashed(chunk.moduleIds)
      expect(ids.some((id) => id.includes(location.ansiRegex))).toBe(true)
      expect(
        ids.some((id) =>
          /\/kleur(?:@4\.1\.5\/node_modules\/kleur|\/4\.1\.5)\/colors\.mjs$/.test(id),
        ),
      ).toBe(true)
      expect(existsSync(join(project.root, 'node_modules', 'strip-ansi'))).toBe(location.installed)
    })
  })
}

describe('core-remote-mirror (esbuild)', () => {
  it(
    'bundles mirrored remote modules with their source maps and reuses the mirror',
    timeout,
    async () => {
      const project = await fixture('core-remote-mirror')
      const expected = project.manifest.expect as {
        values: Record<string, unknown>
        mirror: { jsrPath: string; closest: string }
      }
      const options: Options = { debug: true }
      const first = await bundle(project.root, project.manifest.entries, options, {
        platform: 'browser',
      })
      expect((await evaluateModule<{ values: unknown }>(first.entry)).values).toEqual(
        expected.values,
      )
      expect(mirrorLoads(first).length).toBeGreaterThan(20)
      const generation = generationDir(project.root)
      const mod = join(generation, ...expected.mirror.jsrPath.split('/'))
      expect(await readFile(mod, 'utf8')).toMatch(/\/\/# sourceMappingURL=mod\.ts\.js\.map\n$/)
      // esbuild read the mirror's linked source maps: the output maps back to the URLs.
      const map = JSON.parse(await readFile(`${first.entry}.map`, 'utf8')) as {
        sources: string[]
        sourcesContent: string[]
      }
      expect(map.sources).toContain('https://jsr.io/@std/path/1.1.6/posix/join.ts')
      expect(map.sources).toContain('https://deno.land/std@0.224.0/text/closest_string.ts')
      const joinSource =
        map.sourcesContent[map.sources.indexOf('https://jsr.io/@std/path/1.1.6/posix/join.ts')]
      expect(joinSource).toContain('export function join(')
      expect(map.sources.some((source) => source.includes('.unplugin-deno'))).toBe(false)
      // The mirror files are in esbuild's file namespace (shown relative to absWorkingDir).
      expect(Object.keys(first.metafile.inputs)).toContain(
        `node_modules/.unplugin-deno/${generation.slice(-8)}/${expected.mirror.closest}`,
      )

      // The next build reads the mirror: no engine loads.
      const second = await bundle(project.root, project.manifest.entries, options, {
        platform: 'browser',
      })
      expect((await evaluateModule<{ values: unknown }>(second.entry)).values).toEqual(
        expected.values,
      )
      expect(mirrorLoads(second)).toEqual([])
      expect(generationDir(project.root)).toBe(generation)
    },
  )
})

describe('core-attributes (esbuild)', () => {
  it(
    'matches Deno for text, bytes, css and json attributes, static and dynamic',
    timeout,
    async () => {
      onTestFinished(installCssStyleSheet())
      const project = await fixture('core-attributes')
      const out = await bundle(project.root, project.manifest.entries)
      const mod = await evaluateModule<{
        values: Record<string, unknown>
        dynamicValues: () => Promise<Record<string, unknown>>
      }>(out.entry)
      const { values } = mod
      expect(values).toMatchObject(expectedValues(project))
      expect(values.bytesType).toBe('Uint8Array')
      expect(values.cssType).toBe('CSSStyleSheet')
      expect(values.license).toBe('The MIT License ')
      expect(values.licenseMatches).toBe(true)
      expect(values.licenseLength).toBeGreaterThan(1000)
      expect(values.normalizeLength).toBeGreaterThan(5000)
      const expected = expectedValues(project)
      expect(await mod.dynamicValues()).toEqual({
        text: expected.text,
        bytes: expected.bytes,
        json: expected.json,
        css: expected.css,
        license: 'The MIT License ',
      })
      for (const chunk of out.chunks) {
        expect(chunk.code).not.toMatch(/type:\s*["'](?:text|bytes|css)["']/)
      }
      const inputs = Object.keys(out.metafile.inputs)
      // Local text and bytes are esbuild's own loaders; local css and remote targets are markers,
      // under paths relative to absWorkingDir.
      expect(inputs).toContain('src/data.txt')
      expect(inputs).toContain('src/data.bin')
      expect(inputs).toContain('unplugin-deno:src/style.css?deno-type=css')
      const markers = inputs.filter((input) => input.startsWith('unplugin-deno:'))
      expect(markers.every((input) => !input.includes(project.root))).toBe(true)
      expect(markers.filter((input) => input.includes('/license?deno-type='))).toHaveLength(2)
      // Remote targets are mirrored raw, under their own names.
      const license = join(
        generationDir(project.root),
        'https',
        'cdn.jsdelivr.net',
        'npm',
        'kleur@4.1.5',
        'license',
      )
      expect((await readFile(license, 'utf8')).startsWith('The MIT License')).toBe(true)
    },
  )
})

describe('core-platform-deno (esbuild)', () => {
  const entries = ['src/server.ts']
  it(
    'keeps npm:, jsr: and node: external and pinned, bundles local and https:',
    timeout,
    async () => {
      const project = await fixture('core-platform-deno')
      const expected = project.manifest.expect as { externals: string[] }
      const out = await bundle(project.root, entries, { platform: 'deno' })
      const chunk = entryChunk(out)
      expect(chunk.imports.toSorted()).toEqual(expected.externals.toSorted())
      expect(chunk.code).toContain('function closestString')
      expect(chunk.code).toContain('42')
    },
  )

  it.each(['node', 'neutral'] as const)(
    'derives the Deno platform from esbuild platform %s and a deno.json',
    timeout,
    async (platform) => {
      const project = await fixture('core-platform-deno')
      const expected = project.manifest.expect as { externals: string[] }
      const out = await bundle(project.root, entries, {}, { platform })
      expect(entryChunk(out).imports.toSorted()).toEqual(expected.externals.toSorted())
    },
  )

  it(
    'treats an unset esbuild platform as browser (jsr: and https: are bundled)',
    timeout,
    async () => {
      // esbuild's own default platform is `browser`; a server fixture would fail on `node:` imports.
      const project = await fixture('core-remote-mirror')
      const out = await bundle(project.root, project.manifest.entries, {}, {})
      const chunk = entryChunk(out)
      expect(chunk.imports.some((id) => id.startsWith('jsr:') || id.startsWith('npm:'))).toBe(false)
      expect(chunk.code).toContain('function closestString')
    },
  )

  it.skipIf(!DENO_AVAILABLE)(
    'runs under `deno run --cached-only` (skipped without a deno binary)',
    timeout,
    async () => {
      const project = await fixture('core-platform-deno')
      const out = await bundle(project.root, entries, {}, { platform: 'node' })
      const runner = join(out.outDir, 'run.mjs')
      await writeFile(
        runner,
        "import { values } from './server.js'\nconsole.log(JSON.stringify(values))\n",
      )
      const env = { ...process.env, DENO_DIR: testDenoDirPath(), NO_COLOR: '1' }
      await execFileAsync('deno', ['cache', '--quiet', 'run.mjs'], { cwd: out.outDir, env })
      const { stdout } = await execFileAsync('deno', ['run', '-A', '--cached-only', 'run.mjs'], {
        cwd: out.outDir,
        env,
      })
      expect(JSON.parse(stdout)).toEqual(expectedValues(project))
    },
  )

  it('bundles what `bundle` names and keeps ranges with pinExternals: false', timeout, async () => {
    const project = await fixture('core-platform-deno')
    const bundled = await bundle(project.root, entries, { platform: 'deno', bundle: ['npm:kleur'] })
    expect(entryChunk(bundled).imports.toSorted()).toEqual(['jsr:@std/path@1.1.6', 'node:fs'])
    expect(slashed(entryChunk(bundled).moduleIds).some((id) => id.includes('/kleur/'))).toBe(true)
    const ranges = await bundle(project.root, entries, { platform: 'deno', pinExternals: false })
    const expected = project.manifest.expect as { ranges: string[] }
    expect(entryChunk(ranges).imports.toSorted()).toEqual(
      [...expected.ranges, 'node:fs'].toSorted(),
    )
  })
})

describe('core-workspace (esbuild)', () => {
  it('resolves members by name and member-scoped aliases', timeout, async () => {
    const project = await fixture('core-workspace')
    const out = await bundle(project.root, project.manifest.entries)
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
  })

  it('finds the workspace root from a member directory (absWorkingDir)', timeout, async () => {
    const project = await fixture('core-workspace')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      {
        absWorkingDir: project.path('packages/app'),
      },
    )
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
  })
})

describe('core-virtual-coexist (esbuild)', () => {
  it("never intercepts another plugin's virtual: modules", timeout, async () => {
    const project = await fixture('core-virtual-coexist')
    const seen: string[] = []
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      {
        plugins: [virtualPlugin(seen)],
      },
    )
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    expect(seen.toSorted()).toEqual(['virtual:answer', 'virtual:greeting'])
    expect(Object.keys(out.metafile.inputs)).toEqual(
      expect.arrayContaining(['test-virtual:virtual:answer', 'test-virtual:virtual:greeting']),
    )
  })
})

describe('esbuild-abs-working-dir', () => {
  it('discovers deno.json, entry points and the mirror from absWorkingDir', timeout, async () => {
    const project = await fixture('esbuild-abs-working-dir')
    // The process runs elsewhere (the package directory, which has a deno.json of its own).
    expect(process.cwd()).not.toBe(project.root)
    const options = await prepare(project.root, [], {}, { platform: 'browser' })
    // A relative entry point, as esbuild resolves it: from absWorkingDir.
    options.entryPoints = project.manifest.entries
    const out = await buildWithOptions(options)
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    expect(generations(project.root)).toHaveLength(1)
  })

  it('resolves an import-map key given as the entry point', timeout, async () => {
    const project = await fixture('esbuild-abs-working-dir')
    const options = await prepare(project.root, [], {}, { platform: 'browser' })
    options.entryPoints = { entry: '#message' }
    const out = await buildWithOptions(options)
    expect(entryChunk(out).fileName).toBe('entry.js')
    const mod = await evaluateModule<{ message: string }>(out.entry)
    expect(mod.message).toBe('found from absWorkingDir')
  })

  it('resolves stdin input from absWorkingDir', timeout, async () => {
    const project = await fixture('esbuild-abs-working-dir')
    const options = await prepare(
      project.root,
      [],
      {},
      {
        platform: 'browser',
        stdin: {
          contents: "export { message } from '#message'\nexport { join } from '@std/path'\n",
          resolveDir: project.root,
          loader: 'ts',
        },
      },
    )
    options.entryPoints = []
    const out = await buildWithOptions(options)
    const mod = await evaluateModule<{ message: string; join: (...parts: string[]) => string }>(
      out.entry,
    )
    expect(mod.message).toBe('found from absWorkingDir')
    expect(mod.join('x', 'y')).toBe('x/y')
  })
})

/** {@link esbuildOptions}; the output directory is removed after the test. */
async function prepare(
  root: string,
  entries: BuildEntries,
  options: Options = {},
  extra: EsbuildBuildOptions = {},
): Promise<Awaited<ReturnType<typeof esbuildOptions>>> {
  const prepared = await esbuildOptions(root, entries, options, extra)
  onTestFinished(() => rm(prepared.outdir, { recursive: true, force: true, maxRetries: 3 }))
  return prepared
}

/** Runs esbuild with prepared options and collects the result. */
async function buildWithOptions(
  options: Awaited<ReturnType<typeof esbuildOptions>>,
): Promise<EsbuildBuildResult> {
  return collectResult(await esbuildBuild(options), options, [], 0)
}

describe('esbuild-packages-external', () => {
  it(
    'keeps npm: and jsr: imports external and pinned with packages: external',
    timeout,
    async () => {
      const project = await fixture('esbuild-packages-external')
      const expected = project.manifest.expect as { externals: string[] }
      const out = await bundle(
        project.root,
        project.manifest.entries,
        {},
        {
          platform: 'browser',
          packages: 'external',
        },
      )
      const chunk = entryChunk(out)
      expect(chunk.imports.toSorted()).toEqual(expected.externals.toSorted())
      // https: and local modules are bundled.
      expect(chunk.code).toContain('function closestString')
      expect(chunk.code).toContain('"bundled"')
    },
  )

  it('leaves the imports esbuild `external` names as written', timeout, async () => {
    const project = await fixture('esbuild-packages-external')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      {
        platform: 'browser',
        external: ['jsr:*', '@app/local', 'unmapped-package', 'npm:kleur@^4/colors'],
      },
    )
    const chunk = entryChunk(out)
    expect(chunk.imports.toSorted()).toEqual(
      [
        '@app/local',
        'jsr:@std/path@^1/basename',
        'npm:kleur@^4/colors',
        'unmapped-package',
      ].toSorted(),
    )
    // Not named by a pattern: resolved and bundled.
    expect(slashed(chunk.moduleIds).some((id) => id.includes('/kleur/4.1.5/index.mjs'))).toBe(true)
    expect(chunk.moduleIds.some((id) => id.includes('join.ts.js'))).toBe(true)
  })
})

describe('esbuild-binary-assets', () => {
  it('leaves binary assets and CSS URLs to esbuild next to Deno imports', timeout, async () => {
    const project = await fixture('esbuild-binary-assets')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      {
        platform: 'browser',
        loader: { '.png': 'file' },
        assetNames: '[name]-[hash]',
      },
    )
    const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
    expect(values).toMatchObject(expectedValues(project))
    // One asset for the direct import and the import-map alias, byte for byte the source.
    const assets = (await readdir(out.outDir)).filter((file) => file.endsWith('.png'))
    expect(assets).toHaveLength(1)
    expect(values.logoUrl).toBe(`./${assets[0]}`)
    expect(values.aliasUrl).toBe(values.logoUrl)
    const source = await readFile(project.path('assets/logo.png'))
    expect(Buffer.compare(await readFile(join(out.outDir, assets[0] ?? '')), source)).toBe(0)
    // Bytes (esbuild's own loader) and text through the import map (a marker) are exact.
    expect(values.bytes).toEqual([...(await readFile(project.path('src/data.bin')))])
    expect(values.jsonText).toBe(await readFile(project.path('src/data.json'), 'utf8'))
    // The plugin claimed nothing but the Deno import and the text marker.
    const inputs = Object.keys(out.metafile.inputs)
    expect(inputs).toContain('assets/logo.png')
    expect(inputs.filter((input) => input.startsWith('unplugin-deno:'))).toEqual([
      'unplugin-deno:src/data.json?deno-type=text',
    ])
    // Remote URLs in CSS stay as written (never fetched); the local url() is esbuild's.
    const css = await readFile(join(out.outDir, 'main.css'), 'utf8')
    expect(css).toContain('@import "https://fonts.googleapis.com/css2?family=Roboto";')
    expect(css).toMatch(/url\("?https:\/\/example\.com\/bg\.png"?\)/)
    expect(css).toContain(`url("./${assets[0]}")`)
  })
})

describe('esbuild-context-rebuild', () => {
  it(
    'reuses the project and mirror across rebuilds and reloads a changed deno.json',
    timeout,
    async () => {
      const project = await fixture('esbuild-context-rebuild')
      const expected = project.manifest.expect as {
        first: Record<string, unknown>
        changed: Record<string, unknown>
      }
      const ctx = await contextWithEsbuild(
        project.root,
        project.manifest.entries,
        { debug: true },
        { platform: 'browser' },
      )
      onTestFinished(() => ctx.dispose())

      const first = await ctx.rebuild()
      expect((await evaluateCopy<{ values: unknown }>(first.entry, 'first')).values).toEqual(
        expected.first,
      )
      expect(mirrorLoads(first).length).toBeGreaterThan(0)
      expect(entrypointsAdded(first)).toBe(1)
      const generation = generationDir(project.root)

      // Nothing changed: no project load, no entry points, no engine loads.
      const second = await ctx.rebuild()
      expect((await evaluateCopy<{ values: unknown }>(second.entry, 'second')).values).toEqual(
        expected.first,
      )
      expect(mirrorLoads(second)).toEqual([])
      expect(entrypointsAdded(second)).toBe(0)
      expect(generationDir(project.root)).toBe(generation)

      // The import map changes between rebuilds: the next rebuild sees it.
      const config = project.path('deno.json')
      const original = await readFile(config, 'utf8')
      await writeFile(config, original.replace('./src/hello.ts', './src/goodbye.ts'))
      const third = await ctx.rebuild()
      expect((await evaluateCopy<{ values: unknown }>(third.entry, 'third')).values).toEqual(
        expected.changed,
      )
      expect(entrypointsAdded(third)).toBe(1)
      expect(generations(project.root)).toContain(generation.slice(-8))
      expect(generations(project.root)).toHaveLength(2)
      expect(third.warnings).toEqual([])

      // A key added while the context runs cannot reach esbuild's filters: a warning says so.
      await writeFile(
        config,
        original.replace('"greeting":', '"extra": "./src/hello.ts",\n    "greeting":'),
      )
      const fourth = await ctx.rebuild()
      expect(fourth.warnings.map((warning) => warning.text)).toEqual([
        expect.stringContaining('`extra` will only be resolved by unplugin-deno in a new context'),
      ])
    },
  )

  it('rebuilds in watch mode when deno.json changes', timeout, async () => {
    const project = await fixture('esbuild-context-rebuild')
    const outputs: string[] = []
    let rebuilt = signal()
    // Records each build's main output (`write: false`).
    const observer: Plugin = {
      name: 'test-observer',
      setup(build) {
        build.onEnd((result) => {
          const main = result.outputFiles?.find((file) => file.path.endsWith('main.js'))
          if (main !== undefined) outputs.push(main.text)
          rebuilt.fire()
        })
      },
    }
    const options = await prepare(
      project.root,
      project.manifest.entries,
      {},
      { platform: 'browser', write: false },
    )
    options.plugins = [...(options.plugins ?? []), observer]
    const ctx = await esbuildContext(options)
    onTestFinished(() => ctx.dispose())
    await ctx.watch()
    await rebuilt.promise
    expect(outputs.at(-1)).toContain('"hello"')
    rebuilt = signal()
    const config = project.path('deno.json')
    await writeFile(
      config,
      (await readFile(config, 'utf8')).replace('./src/hello.ts', './src/goodbye.ts'),
    )
    await rebuilt.promise
    expect(outputs.at(-1)).toContain('"goodbye"')
  })
})

/** The external imports of a build of `project` with `plugin` (an instance reused by builds). */
async function externals(
  project: TempProject,
  plugin: Plugin,
  platform: 'browser' | 'node',
): Promise<string[]> {
  const options = await prepare(project.root, project.manifest.entries, {}, { platform })
  options.plugins = [plugin]
  const out = await buildWithOptions(options)
  return entryChunk(out).imports
}

describe('plugin instances shared by builds', () => {
  it('loads the project again for other settings, one build after the other', timeout, async () => {
    const project = await fixture('core-remote-mirror')
    const plugin = denoEsbuild()
    // Browser: everything bundled; node (Deno platform, deno.json): jsr: external and pinned.
    expect(await externals(project, plugin, 'browser')).toEqual([])
    expect(await externals(project, plugin, 'node')).toEqual(['jsr:@std/path@1.1.6/posix'])
    // A context of the same plugin switches back for each rebuild.
    const options = await prepare(
      project.root,
      project.manifest.entries,
      {},
      {
        platform: 'browser',
      },
    )
    options.plugins = [plugin]
    const ctx = await esbuildContext(options)
    onTestFinished(() => ctx.dispose())
    const imports = async (): Promise<string[]> =>
      entryChunk(await collectResult(await ctx.rebuild(), options, [], 0)).imports
    expect(await imports()).toEqual([])
    expect(await externals(project, plugin, 'node')).toEqual(['jsr:@std/path@1.1.6/posix'])
    expect(await imports()).toEqual([])
  })

  it('serves concurrent builds that agree and rejects one that does not', timeout, async () => {
    const project = await fixture('core-remote-mirror')
    const plugin = denoEsbuild()
    // Holds the first build between onStart and onEnd.
    const running = signal()
    const blocked = signal()
    const gate: Plugin = {
      name: 'test-gate',
      setup(build) {
        build.onStart(async () => {
          running.fire()
          await blocked.promise
        })
      },
    }
    const options = async (platform: 'browser' | 'node', extra: Plugin[] = []) => {
      const prepared = await prepare(project.root, project.manifest.entries, {}, { platform })
      prepared.plugins = [plugin, ...extra]
      return prepared
    }
    const first = esbuildBuild(await options('browser', [gate]))
    await running.promise
    const same = await esbuildBuild(await options('browser'))
    expect(same.errors).toEqual([])
    const other = await buildFailure(esbuildBuild(await options('node')))
    expect(
      other.errors.map((error) => ({
        text: error.text,
        code: (error.detail as { code?: string } | undefined)?.code,
      })),
    ).toEqual([expect.objectContaining({ code: 'OPTIONS_INVALID' })])
    blocked.fire()
    expect((await first).errors).toEqual([])
  })
})
