/**
 * webpack builds (docs/architecture.md §6.5): the core fixtures with the assertions of
 * `core-suite.ts` (webpack output described by its stats), the webpack-specific fixtures
 * (`webpack-*`), and the adapter's own behaviour: native externals, the externals presets it
 * takes over (`target: 'web'`, `target: 'deno'`), `experiments.buildHttp` left to webpack,
 * synthesised marker modules, errors at the import, watch mode and the persistent cache; the
 * source transforms, the `deno.json` JSX settings (esbuild-loader), the checks and Wasm modules.
 */
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { Compiler, Configuration } from 'webpack'
import webpack from 'webpack'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import type { BuildEntries, BuildLog, BuildResult } from '../helpers/build.js'
import { evaluateModule, installCssStyleSheet } from '../helpers/build.js'
import { denoDir } from '../helpers/deno-dir.js'
import type { WebpackBuildOptions } from '../helpers/webpack.js'
import {
  buildWithWebpack,
  ESBUILD_LOADER,
  TYPESCRIPT_RULE,
  webpackConfig,
} from '../helpers/webpack.js'
import {
  emittedCss,
  entryChunk,
  evaluateCopy,
  expectedValues,
  generationDir,
  infoLines,
  mirrorLoads,
  runUnderDeno,
  slashed,
  watchBuilds,
} from '../helpers/webpack-family.js'
import { HostBuildError, outputDir } from '../helpers/webpack-stats.js'
import { DENO_AVAILABLE, fixture, importMetaMainCount, warningsWith } from './core-suite.js'

const timeout = { timeout: 180_000 }

/** webpack's own `?raw` handling (asset/source), for core-basic's `./message.txt?raw`. */
const RAW_RULE = { resourceQuery: /^\?raw$/, type: 'asset/source' } as const

/** Builds with webpack; the output directory is removed after the test. */
async function bundle(
  root: string,
  entries: BuildEntries,
  options: Options = {},
  extra: WebpackBuildOptions = {},
): Promise<BuildResult> {
  const out = await buildWithWebpack(root, entries, options, extra)
  onTestFinished(() => out.dispose())
  return out
}

describe('the webpack plugin', () => {
  it('uses webpack hooks, not unplugin resolver plugins or virtual modules', async () => {
    const logs: BuildLog[] = []
    const compiler = webpack(webpackConfig(tmpdir(), [], tmpdir(), logs, {}, { entry: {} }))
    onTestFinished(() => new Promise<void>((resolve) => compiler.close(() => resolve())))
    expect(compiler.options.resolve.plugins ?? []).toEqual([])
    expect(compiler.options.plugins.map((plugin) => plugin?.constructor.name)).not.toContain(
      'VirtualModulesPlugin',
    )
    expect(compiler.options.module.rules).toContainEqual({
      scheme: 'unplugin-deno',
      type: 'javascript/esm',
    })
  })

  it(
    'reports failing owned imports as webpack errors at the import, with code and hint',
    timeout,
    async () => {
      const project = await fixture('core-basic')
      await writeFile(
        project.path('src/broken.ts'),
        "import pad from 'npm:unplugin-deno-test-missing-package@1'\nexport default pad\n",
      )
      const failure: unknown = await bundle(project.root, 'src/broken.ts', {
        cachedOnly: true,
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(HostBuildError)
      const { errors, modules } = failure as HostBuildError
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('Module not found')
      // The package is in neither the Deno cache nor deno.lock (the code says which the core
      // checks first).
      expect(errors[0]).toMatch(
        /\[unplugin-deno\] .*`cachedOnly`.*\((?:CACHED_ONLY_MISS|NOT_IN_LOCKFILE)\)/,
      )
      expect(errors[0]).toContain('hint: ')
      expect(modules).toEqual(['./src/broken.ts'])
    },
  )

  it("takes over webpack's web preset and says so at info level", timeout, async () => {
    const project = await fixture('core-remote-mirror')
    const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
    const chunk = entryChunk(out)
    // Without the plugin, webpack ≥ 5.102 keeps jsr: and https: imports external.
    expect(chunk.imports).toEqual([])
    expect(chunk.code).toContain('function closestString')
    expect(infoLines(out.logs)).toContainEqual(
      expect.stringContaining(
        '[webpack] externalsPresets.web: unplugin-deno resolves jsr:, npm: and https: imports itself',
      ),
    )
  })

  it('keeps an explicitly enabled web preset, so it runs after the plugin', timeout, async () => {
    const project = await fixture('core-remote-mirror')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      { target: 'web', externalsPresets: { web: true } },
    )
    // webpack's preset keeps the URL external as written; the import-map key is still resolved.
    const chunk = entryChunk(out)
    expect(chunk.imports).toEqual(['https://deno.land/std@0.224.0/text/closest_string.ts'])
    expect(slashed(chunk.moduleIds).some((id) => id.endsWith('/posix/join.ts.js'))).toBe(true)
    expect(infoLines(out.logs)).toContainEqual(
      expect.stringContaining('[webpack] externalsPresets.web is set in the config'),
    )
  })
})

describe('core-basic (webpack)', () => {
  it('bundles jsr:, npm:, https:, data:, node:, local and aliased imports', timeout, async () => {
    const project = await fixture('core-basic')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      { platform: 'node' },
      { target: 'node', module: { rules: [RAW_RULE] } },
    )
    const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
    expect(values).toMatchObject(expectedValues(project))
    expect(stripVTControlCharacters(String(values.colored))).toBe('x')
    const chunk = entryChunk(out)
    expect(chunk.imports).toEqual(['node:path'])
    const ids = slashed(chunk.moduleIds)
    expect(ids.some((id) => id.endsWith('/closest_string.ts.js'))).toBe(true)
    // The ?raw import stayed with webpack's own rules; nothing was synthesised.
    expect(ids).toContain(slashed([project.path('src/message.txt')])[0])
    expect(ids.filter((id) => id.startsWith('unplugin-deno:'))).toEqual([])
  })
})

describe('core-import-map-precedence (webpack)', () => {
  it('resolves a mapped bare name through the import map, not node_modules', timeout, async () => {
    const project = await fixture('core-import-map-precedence')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      { platform: 'node' },
      { target: 'node' },
    )
    const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
    expect(values).toMatchObject(expectedValues(project))
    const ids = slashed(entryChunk(out).moduleIds)
    const kleur = ids.filter((id) => id.includes('/kleur/'))
    expect(kleur).toHaveLength(1)
    expect(kleur[0]).toContain('/npm/registry.npmjs.org/kleur/4.1.5/')
    // An unmapped name stays with webpack's resolver.
    expect(ids).toContain(slashed([project.path('node_modules/stub-only-pkg/index.js')])[0])
  })
})

const npmLocations: Record<string, { ansiRegex: string; installed: boolean }> = {
  // Redirected: webpack resolved the packages inside node_modules/.deno.
  'core-npm-node-modules': { ansiRegex: '/node_modules/.deno/ansi-regex@6.3.0/', installed: true },
  // Global cache: the engine resolved strip-ansi's import of ansi-regex (no node_modules).
  'core-npm-global-cache': {
    ansiRegex: '/npm/registry.npmjs.org/ansi-regex/6.3.0/',
    installed: false,
  },
}
for (const [name, location] of Object.entries(npmLocations)) {
  describe(`${name} (webpack)`, () => {
    it('bundles npm subpaths, CommonJS and tree-shaken ES packages', timeout, async () => {
      const project = await fixture(name)
      const out = await bundle(
        project.root,
        project.manifest.entries,
        { platform: 'node' },
        { target: 'node' },
      )
      const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
      expect(values).toMatchObject(expectedValues(project))
      const chunk = entryChunk(out)
      // `sideEffects: false` reaches webpack: only lodash-es's chunk() and its helpers remain.
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

describe('core-remote-mirror (webpack)', () => {
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
      const first = await bundle(project.root, project.manifest.entries, options, { target: 'web' })
      expect((await evaluateModule<{ values: unknown }>(first.entry)).values).toEqual(
        expected.values,
      )
      expect(mirrorLoads(first).length).toBeGreaterThan(20)
      const generation = generationDir(project.root)
      expect(slashed(entryChunk(first).moduleIds)).toContain(
        slashed([join(generation, ...expected.mirror.closest.split('/'))])[0],
      )
      // The output maps hold the remote sources, named next to their mirror files.
      const map = JSON.parse(await readFile(`${first.entry}.map`, 'utf8')) as {
        sources: string[]
        sourcesContent: string[]
      }
      const mirrored = `webpack:///./node_modules/.unplugin-deno/${generation.slice(-8)}/https/`
      expect(map.sources).toContain(`${mirrored}deno.land/std@0.224.0/text/closest_string.ts`)
      const joinSource =
        map.sourcesContent[map.sources.indexOf(`${mirrored}jsr.io/@std/path/1.1.6/posix/join.ts`)]
      expect(joinSource).toContain('export function join(')
      // Not mangled into paths such as `…/posix/https:/jsr.io/…`.
      expect(map.sources.filter((source) => source.includes('https:'))).toEqual([])

      // The next build reads the mirror: no engine loads.
      const second = await bundle(project.root, project.manifest.entries, options, {
        target: 'web',
      })
      expect((await evaluateCopy<{ values: unknown }>(second.entry, 'second')).values).toEqual(
        expected.values,
      )
      expect(mirrorLoads(second)).toEqual([])
      expect(generationDir(project.root)).toBe(generation)
    },
  )
})

describe('core-attributes (webpack)', () => {
  it(
    'matches Deno for text, bytes, css and json attributes, static and dynamic',
    timeout,
    async () => {
      onTestFinished(installCssStyleSheet())
      const project = await fixture('core-attributes')
      const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
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
      // Markers are `unplugin-deno:` modules named relative to the context; json is webpack's.
      const ids = slashed(out.chunks.flatMap((chunk) => chunk.moduleIds))
      expect(ids).toEqual(
        expect.arrayContaining([
          'unplugin-deno:src/data.txt',
          'unplugin-deno:src/data.bin',
          'unplugin-deno:src/style.css',
        ]),
      )
      const markers = ids.filter((id) => id.startsWith('unplugin-deno:'))
      expect(markers.every((id) => !id.includes(slashed([project.root])[0] ?? ''))).toBe(true)
      expect(markers.filter((id) => id.endsWith('/license'))).toHaveLength(2)
      expect(ids).toContain(slashed([project.path('src/data.json')])[0])
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

describe('core-platform-deno (webpack)', () => {
  const entries = ['src/server.ts']
  it(
    'keeps npm:, jsr: and node: external and pinned, bundles local and https:',
    timeout,
    async () => {
      const project = await fixture('core-platform-deno')
      const expected = project.manifest.expect as { externals: string[] }
      const out = await bundle(project.root, entries, { platform: 'deno' }, { target: 'node' })
      const chunk = entryChunk(out)
      expect(chunk.imports.toSorted()).toEqual(expected.externals.toSorted())
      expect(chunk.code).toContain('function closestString')
      expect(chunk.code).toContain('42')
      expect(chunk.code).toContain('from "npm:kleur@4.1.5"')
    },
  )

  it(
    'writes the sidecar deno.json and deno.lock next to the output (emitDenoConfig)',
    timeout,
    async () => {
      const project = await fixture('core-platform-deno')
      const out = await bundle(
        project.root,
        entries,
        { platform: 'deno', emitDenoConfig: true },
        { target: 'node' },
      )
      expect(JSON.parse(await readFile(join(out.outDir, 'deno.json'), 'utf8'))).toEqual({
        lock: './deno.lock',
        nodeModulesDir: 'none',
      })
      const lock = JSON.parse(await readFile(join(out.outDir, 'deno.lock'), 'utf8')) as {
        specifiers: Record<string, string>
        jsr: Record<string, unknown>
        npm: Record<string, unknown>
      }
      expect(Object.keys(lock.jsr)).toEqual(['@std/internal@1.0.14', '@std/path@1.1.6'])
      expect(Object.keys(lock.npm)).toEqual(['kleur@4.1.5'])
    },
  )

  it('derives the Deno platform from target node and a deno.json', timeout, async () => {
    const project = await fixture('core-platform-deno')
    const expected = project.manifest.expect as { externals: string[] }
    const out = await bundle(project.root, entries, {}, { target: 'node' })
    expect(entryChunk(out).imports.toSorted()).toEqual(expected.externals.toSorted())
  })

  it("keeps them external and pinned with target: 'deno', and says so", timeout, async () => {
    const project = await fixture('core-platform-deno')
    const expected = project.manifest.expect as { externals: string[] }
    const out = await bundle(project.root, entries, {}, { target: 'deno' })
    const chunk = entryChunk(out)
    expect(chunk.imports.toSorted()).toEqual(expected.externals.toSorted())
    expect(chunk.code).toContain('function closestString')
    expect(infoLines(out.logs)).toContainEqual(
      expect.stringContaining('[webpack] target deno: unplugin-deno applies its externals'),
    )
  })

  it.skipIf(!DENO_AVAILABLE)(
    'runs under `deno run --cached-only` (skipped without a deno binary)',
    timeout,
    async () => {
      const project = await fixture('core-platform-deno')
      const out = await bundle(project.root, entries, {}, { target: 'node' })
      expect(await runUnderDeno(out, 'server.js')).toEqual(expectedValues(project))
    },
  )

  it('bundles what `bundle` names and keeps ranges with pinExternals: false', timeout, async () => {
    const project = await fixture('core-platform-deno')
    const bundled = await bundle(
      project.root,
      entries,
      { platform: 'deno', bundle: ['npm:kleur'] },
      { target: 'node' },
    )
    expect(entryChunk(bundled).imports.toSorted()).toEqual(['jsr:@std/path@1.1.6/posix', 'node:fs'])
    expect(slashed(entryChunk(bundled).moduleIds).some((id) => id.includes('/kleur/'))).toBe(true)
    const ranges = await bundle(
      project.root,
      entries,
      { platform: 'deno', pinExternals: false },
      { target: 'node' },
    )
    const expected = project.manifest.expect as { ranges: string[] }
    expect(entryChunk(ranges).imports.toSorted()).toEqual(
      [...expected.ranges, 'node:fs'].toSorted(),
    )
  })
})

describe('core-workspace (webpack)', () => {
  it('resolves members by name and member-scoped aliases', timeout, async () => {
    const project = await fixture('core-workspace')
    const out = await bundle(project.root, project.manifest.entries)
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
  })

  it('finds the workspace root from a member directory (context)', timeout, async () => {
    const project = await fixture('core-workspace')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      { context: project.path('packages/app') },
    )
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
  })
})

describe('core-virtual-coexist (webpack)', () => {
  it("never intercepts another plugin's virtual: modules", timeout, async () => {
    const project = await fixture('core-virtual-coexist')
    const { VirtualUrlPlugin } = webpack.experiments.schemes
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      {
        plugins: [
          new VirtualUrlPlugin({
            answer: 'export default 42',
            greeting:
              'const note = "with { type: \'text\' } stays as it is"\nexport default `hi, ${note}`',
          }),
        ],
      },
    )
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    // webpack's modules (`virtual:answer`, a constant, is inlined into its importer).
    const ids = entryChunk(out).moduleIds
    expect(ids).toContain('virtual:greeting')
    expect(ids.filter((id) => id.startsWith('unplugin-deno:'))).toEqual([])
  })
})

describe('webpack-target-deno', () => {
  it(
    'pins Deno externals and keeps the deno preset for bare Node.js builtins',
    timeout,
    async () => {
      const project = await fixture('webpack-target-deno')
      const expected = project.manifest.expect as { externals: string[] }
      const out = await bundle(project.root, project.manifest.entries, {}, { target: 'deno' })
      const chunk = entryChunk(out)
      expect(chunk.imports.toSorted()).toEqual(expected.externals.toSorted())
      expect(chunk.code).toContain('function closestString')
    },
  )

  it.skipIf(!DENO_AVAILABLE)(
    'runs under `deno run --cached-only` (skipped without a deno binary)',
    timeout,
    async () => {
      const project = await fixture('webpack-target-deno')
      const out = await bundle(project.root, project.manifest.entries, {}, { target: 'deno' })
      expect(await runUnderDeno(out, 'server.js')).toEqual(expectedValues(project))
    },
  )
})

describe('webpack-remote-css', () => {
  it(
    'keeps remote URLs in CSS external, as the web preset it took over does',
    timeout,
    async () => {
      const project = await fixture('webpack-remote-css')
      const expected = project.manifest.expect as { values: Record<string, unknown>; css: string[] }
      const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expected.values)
      const css = await emittedCss(out)
      expect(css).toContain(`@import url("${expected.css[0]}");`)
      expect(css).toContain(`url(${expected.css[1]})`)
      expect(css).toContain(`url(${expected.css[2]})`)
      // Only the module import reached the mirror.
      const mirrored = join(generationDir(project.root), 'https')
      expect(readdirSync(mirrored)).toEqual(['deno.land'])
    },
  )
})

describe('webpack-build-http', () => {
  it('leaves the URLs experiments.buildHttp allows to webpack', timeout, async () => {
    const project = await fixture('webpack-build-http')
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/javascript')
      response.end(
        request.url === '/lib.js' ? 'export const fromWebpack = "fetched by webpack"\n' : '',
      )
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await writeFile(
      project.path('src/allowed.ts'),
      `export { fromWebpack } from '${origin}/lib.js'\n`,
    )
    const lock = await mkdtemp(join(tmpdir(), 'unplugin-deno-webpack-lock-'))
    onTestFinished(() => rm(lock, { recursive: true, force: true, maxRetries: 3 }))
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      {
        target: 'web',
        experiments: {
          buildHttp: {
            allowedUris: [`${origin}/`],
            lockfileLocation: join(lock, 'webpack.lock'),
            cacheLocation: false,
            frozen: false,
          },
        },
      },
    )
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual({ ...expectedValues(project), fromWebpack: 'fetched by webpack' })
    const ids = slashed(entryChunk(out).moduleIds)
    // webpack fetched the allowed URL; the other remote module came from the mirror.
    expect(ids).toContain(`${origin}/lib.js`)
    expect(ids.some((id) => id.endsWith('/closest_string.ts.js'))).toBe(true)
    expect(infoLines(out.logs)).toContainEqual(
      expect.stringContaining('[webpack] experiments.buildHttp is set'),
    )
  })
})

describe('webpack-watch', () => {
  it('reloads a changed deno.json and rebuilds edited marker targets', timeout, async () => {
    const project = await fixture('webpack-watch')
    const expected = project.manifest.expect as Record<'first' | 'mapped' | 'edited', unknown>
    vi.stubEnv('DENO_DIR', await denoDir())
    const outDir = await outputDir()
    onTestFinished(() => rm(outDir, { recursive: true, force: true, maxRetries: 3 }))
    const config: Configuration = webpackConfig(
      project.root,
      project.manifest.entries,
      outDir,
      [],
      {},
      // webpack's dev cache: modules restored from memory still resolve their imports again.
      { mode: 'development', devtool: false, cache: { type: 'memory' } },
    )
    const compiler = webpack(config)
    const builds = watchBuilds(outDir, (handler) => {
      const watching = compiler.watch({ aggregateTimeout: 50 }, (error, stats) =>
        handler(error ?? undefined, stats?.hasErrors() === true ? stats.toString() : undefined),
      )
      return () =>
        new Promise<void>((resolve) => {
          const closeCompiler = (): void => compiler.close(() => resolve())
          if (watching === undefined) closeCompiler()
          else watching.close(closeCompiler)
        })
    })
    onTestFinished(() => builds.close())
    expect(await builds.next(() => true)).toEqual(expected.first)
    const configFile = project.path('deno.json')
    const mapped = await builds.after(
      async () =>
        writeFile(
          configFile,
          (await readFile(configFile, 'utf8')).replace('./src/hello.ts', './src/goodbye.ts'),
        ),
      (values) => values.greeting === 'goodbye',
    )
    expect(mapped).toEqual(expected.mapped)
    const edited = await builds.after(
      () => writeFile(project.path('src/note.txt'), 'second\n'),
      (values) => values.note === 'second\n',
    )
    expect(edited).toEqual(expected.edited)
  })
})

describe('persistent cache (webpack)', () => {
  it(
    'rebuilds from the filesystem cache, with the config files as build dependencies',
    timeout,
    async () => {
      const project = await fixture('core-remote-mirror')
      const cacheDirectory = await mkdtemp(join(tmpdir(), 'unplugin-deno-webpack-cache-'))
      onTestFinished(() => rm(cacheDirectory, { recursive: true, force: true, maxRetries: 3 }))
      const expected = project.manifest.expect as { values: Record<string, unknown> }
      const dependencies: string[][] = []
      const recorder = {
        apply(compiler: Compiler) {
          compiler.hooks.afterCompile.tap('test-recorder', (compilation) => {
            dependencies.push([...compilation.buildDependencies])
          })
        },
      }
      const extra: WebpackBuildOptions = {
        target: 'web',
        cache: { type: 'filesystem', cacheDirectory },
        plugins: [recorder],
      }
      const first = await bundle(project.root, project.manifest.entries, {}, extra)
      expect((await evaluateModule<{ values: unknown }>(first.entry)).values).toEqual(
        expected.values,
      )
      const second = await bundle(project.root, project.manifest.entries, {}, extra)
      expect((await evaluateCopy<{ values: unknown }>(second.entry, 'cached')).values).toEqual(
        expected.values,
      )
      expect(dependencies[0]).toEqual(
        expect.arrayContaining([project.path('deno.json'), project.path('deno.lock')]),
      )
    },
  )
})

/** webpack keeps `import.meta.main` as written (so the plugin's replacements are visible). */
const KEEP_IMPORT_META_MAIN: WebpackBuildOptions = {
  module: { parser: { javascript: { importMeta: { main: false } } } },
}

describe('core-import-meta-main (webpack)', () => {
  it('replaces import.meta.main in modules that are not entries', timeout, async () => {
    const project = await fixture('core-import-meta-main')
    const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    // webpack evaluates import.meta.main per module unless its parser keeps it as written: then
    // the entry keeps its own and the others (local, remote) are false.
    const kept = await bundle(
      project.root,
      project.manifest.entries,
      {},
      { target: 'web', ...KEEP_IMPORT_META_MAIN },
    )
    expect(importMetaMainCount(entryChunk(kept).code)).toBe(1)
    expect((await evaluateModule<{ values: unknown }>(kept.entry)).values).toEqual(
      expectedValues(project),
    )
    const untouched = await bundle(
      project.root,
      project.manifest.entries,
      { importMetaMain: false },
      { target: 'web', ...KEEP_IMPORT_META_MAIN },
    )
    expect(importMetaMainCount(entryChunk(untouched).code)).toBe(3)
  })
})

describe('core-env-inline (webpack)', () => {
  it(
    'inlines allowed variables for the browser from the process and .env files',
    timeout,
    async () => {
      const project = await fixture('core-env-inline')
      const files = project.manifest.expect?.files as Record<string, string>
      for (const [name, text] of Object.entries(files)) await writeFile(project.path(name), text)
      vi.stubEnv('PUBLIC_TARGET', 'from the process')
      const out = await bundle(
        project.root,
        project.manifest.entries,
        { env: { prefix: 'PUBLIC_' }, denoGlobals: 'off' },
        { target: 'web' },
      )
      const mod = await evaluateModule<{ values: unknown; fromFile: () => unknown }>(out.entry)
      expect(mod.values).toEqual(expectedValues(project))
      expect(mod.fromFile()).toBeUndefined()
      const { code } = entryChunk(out)
      expect(code).not.toContain('PUBLIC_')
      expect(code).toMatch(/Deno\.env\.get\(["']SECRET["']\)/)
      expect(code).toContain('Deno.env.toObject()')
      // Listed files replace the defaults.
      const listed = await bundle(
        project.root,
        project.manifest.entries,
        { env: { prefix: ['PUBLIC_'], files: ['app.env'] }, denoGlobals: 'off' },
        { target: 'web' },
      )
      const listedModule = await evaluateModule<{ fromFile: () => unknown }>(listed.entry)
      expect(listedModule.fromFile()).toBe('from app.env')
      // The Deno platform (target node and a deno.json) reads its environment at runtime.
      const server = await bundle(
        project.root,
        project.manifest.entries,
        { env: { prefix: 'PUBLIC_' } },
        { target: 'node' },
      )
      expect(entryChunk(server).code).toMatch(/Deno\.env\.get\(["']PUBLIC_GREETING["']\)/)
    },
  )
})

describe('core-deno-globals (webpack)', () => {
  it(
    'reports Deno globals of local modules in browser bundles once, with the location',
    timeout,
    async () => {
      const project = await fixture('core-deno-globals')
      const expected = project.manifest.expect as { values: object; warning: string }
      const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
      const { values } = await evaluateModule<{ values: object }>(out.entry)
      expect(values).toMatchObject(expected.values)
      expect(warningsWith(out, 'uses `Deno.')).toEqual([expect.stringContaining(expected.warning)])
      const quiet = await bundle(
        project.root,
        project.manifest.entries,
        { denoGlobals: 'off' },
        { target: 'web' },
      )
      expect(warningsWith(quiet, 'uses `Deno.')).toEqual([])
      const server = await bundle(project.root, project.manifest.entries, {}, { target: 'node' })
      expect(warningsWith(server, 'uses `Deno.')).toEqual([])
    },
  )

  it("fails the module's build with denoGlobals: 'error'", timeout, async () => {
    const project = await fixture('core-deno-globals')
    const expected = project.manifest.expect as { warning: string }
    const failure: unknown = await bundle(
      project.root,
      project.manifest.entries,
      { denoGlobals: 'error' },
      { target: 'web' },
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HostBuildError)
    const { errors, modules } = failure as HostBuildError
    expect(errors).toEqual([expect.stringContaining(expected.warning)])
    expect(errors[0]).toContain('(PLATFORM_INCOMPATIBLE)')
    expect(modules).toEqual(['./src/server-only.ts'])
  })
})

describe('core-jsx-preact (webpack)', () => {
  it('gives esbuild-loader the deno.json JSX settings (react-jsx, preact)', timeout, async () => {
    const project = await fixture('core-jsx-preact')
    const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    const chunk = entryChunk(out)
    expect(chunk.imports).toEqual([])
    // `preact/jsx-runtime` resolved through the import map (`preact` → `npm:preact@^10`).
    const ids = slashed(chunk.moduleIds)
    expect(ids.some((id) => /\/preact\/10\.29\.8\/jsx-runtime\/dist\//.test(id))).toBe(true)
    expect(warningsWith(out, 'precompile')).toEqual([])
    // The shared rule object of the test configuration was copied, not changed.
    expect(TYPESCRIPT_RULE.options).toEqual({ target: 'esnext' })
  })

  it('follows react-jsxdev, the classic runtime and precompile', timeout, async () => {
    const project = await fixture('core-jsx-preact')
    const config = JSON.parse(await readFile(project.path('deno.json'), 'utf8')) as object
    // [compilerOptions, whether the preact JSX runtime is bundled, whether it is the development
    // one (its calls pass the source location)]
    const variants = [
      [{ jsx: 'react-jsxdev', jsxImportSource: 'preact' }, true, true],
      [{ jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }, false, false],
      [{ jsx: 'precompile', jsxImportSource: 'preact' }, true, false],
    ] as const
    for (const [compilerOptions, runtime, development] of variants) {
      await writeFile(project.path('deno.json'), JSON.stringify({ ...config, compilerOptions }))
      const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
      const chunk = entryChunk(out)
      // preact's jsx-dev-runtime export is the jsx-runtime file.
      const ids = slashed(chunk.moduleIds)
      expect(ids.some((id) => id.includes('/preact/10.29.8/jsx-runtime/'))).toBe(runtime)
      expect(chunk.code.includes('lineNumber')).toBe(development)
      const precompile = warningsWith(out, '"precompile"')
      expect(precompile).toHaveLength(compilerOptions.jsx === 'precompile' ? 1 : 0)
      for (const warning of precompile) {
        expect(warning).toContain("not supported by esbuild-loader's JSX transform")
      }
    }
  })

  it(
    'leaves JSX that esbuild-loader configures, and every JSX setting with jsx: host',
    timeout,
    async () => {
      const project = await fixture('core-jsx-preact')
      const classic = await bundle(
        project.root,
        project.manifest.entries,
        { debug: true },
        {
          target: 'web',
          typescriptRule: {
            ...TYPESCRIPT_RULE,
            options: {
              target: 'esnext',
              jsx: 'transform',
              jsxFactory: 'h',
              jsxFragment: 'Fragment',
            },
          },
        },
      )
      const { values } = await evaluateModule<{ values: unknown }>(classic.entry)
      expect(values).toEqual(expectedValues(project))
      expect(
        slashed(entryChunk(classic).moduleIds).some((id) => id.includes('/jsx-runtime/')),
      ).toBe(false)
      expect(infoLines(classic.logs)).toContainEqual(
        expect.stringContaining('esbuild-loader configure JSX themselves'),
      )
      // With jsx: 'host' esbuild-loader keeps esbuild's default, React's classic runtime.
      const hostOnly = await bundle(
        project.root,
        project.manifest.entries,
        { jsx: 'host' },
        { target: 'web' },
      )
      const chunk = entryChunk(hostOnly)
      expect(chunk.code).toContain('React.createElement')
      expect(slashed(chunk.moduleIds).some((id) => id.includes('/jsx-runtime/'))).toBe(false)
    },
  )

  it('says what to set when no JSX loader is configured', timeout, async () => {
    const project = await fixture('core-jsx-preact')
    await writeFile(project.path('src/plain.js'), 'export const values = { plain: true }\n')
    const out = await bundle(project.root, 'src/plain.js', {}, { typescriptRule: false })
    expect(infoLines(out.logs)).toContainEqual(
      expect.stringContaining(
        '[webpack] deno.json configures JSX (the automatic runtime with importSource `preact`), but module.rules has no esbuild-loader or swc-loader rule for unplugin-deno to apply it to; configure the loader that compiles your .jsx/.tsx files to match: esbuild-loader `{ jsx: "automatic", jsxImportSource: "preact" }`',
      ),
    )
  })

  it('finds esbuild-loader in use lists and oneOf rules', timeout, async () => {
    const project = await fixture('core-jsx-preact')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      {},
      {
        target: 'web',
        typescriptRule: {
          oneOf: [
            { resourceQuery: /^\?raw$/, type: 'asset/source' },
            {
              test: /\.[cm]?tsx?$/,
              use: [{ loader: ESBUILD_LOADER, options: { target: 'esnext' } }],
            },
          ],
        },
      },
    )
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
  })
})

describe('core-checks (webpack)', () => {
  it(
    'warns about node: builtins in browser bundles and npm packages in two versions',
    timeout,
    async () => {
      const project = await fixture('core-checks')
      const expected = project.manifest.expect as { builtin: string; duplicate: string }
      const extra: WebpackBuildOptions = {
        target: 'web',
        externals: { 'node:path': 'module node:path' },
      }
      const out = await bundle(project.root, project.manifest.entries, {}, extra)
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
      expect(warningsWith(out, expected.builtin)).toHaveLength(1)
      expect(warningsWith(out, expected.duplicate)).toEqual([
        expect.stringContaining('(3.3.19, 5.1.16)'),
      ])
      const quiet = await bundle(project.root, project.manifest.entries, { checks: false }, extra)
      expect(warningsWith(quiet, expected.builtin)).toEqual([])
      expect(warningsWith(quiet, expected.duplicate)).toEqual([])
    },
  )
})

describe('core-wasm (webpack)', () => {
  it('instantiates .wasm module imports like Deno, with their own imports', timeout, async () => {
    const project = await fixture('core-wasm')
    const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    const chunk = entryChunk(out)
    expect(chunk.imports).toEqual([])
    expect(chunk.code).toContain('new WebAssembly.Instance(')
    expect(slashed(chunk.moduleIds)).toContain(slashed([project.path('src/offset.js')])[0])
    // The bytes are inlined: webpack emitted no .wasm file.
    expect(readdirSync(out.outDir).filter((file) => file.endsWith('.wasm'))).toEqual([])
  })

  it("leaves .wasm files to webpack's asyncWebAssembly with wasm: false", timeout, async () => {
    const project = await fixture('core-wasm')
    const out = await bundle(
      project.root,
      project.manifest.entries,
      { wasm: false },
      { target: 'web', experiments: { asyncWebAssembly: true } },
    )
    expect(entryChunk(out).code).not.toContain('new WebAssembly.Instance(')
    expect(readdirSync(out.outDir).filter((file) => file.endsWith('.wasm'))).toHaveLength(1)
  })
})
