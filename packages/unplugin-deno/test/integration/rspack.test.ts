/**
 * Rspack builds (docs/architecture.md §6.6): the core fixtures with the assertions of
 * `core-suite.ts` (Rspack output described by its stats), and the adapter's own behaviour: native
 * externals, the web preset it takes over, synthesised marker modules (virtual files loaded
 * through unplugin's loader), errors at the import, coexistence with unplugin-based plugins and
 * watch mode. TypeScript is Rspack's `builtin:swc-loader` (`SWC_RULE`).
 */
import { existsSync, readdirSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { Compiler } from '@rspack/core'
import { rspack } from '@rspack/core'
import { createUnplugin } from 'unplugin'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import type { BuildEntries, BuildResult } from '../helpers/build.js'
import { evaluateModule, installCssStyleSheet } from '../helpers/build.js'
import { denoDir } from '../helpers/deno-dir.js'
import type { RspackBuildOptions } from '../helpers/rspack.js'
import { buildWithRspack, rspackConfig } from '../helpers/rspack.js'
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
import { DENO_AVAILABLE, fixture } from './core-suite.js'

const timeout = { timeout: 180_000 }

/** Rspack's own `?raw` handling (asset/source), for core-basic's `./message.txt?raw`. */
const RAW_RULE = { resourceQuery: /^\?raw$/, type: 'asset/source' } as const

/** Builds with Rspack; the output directory is removed after the test. */
async function bundle(
  root: string,
  entries: BuildEntries,
  options: Options = {},
  extra: RspackBuildOptions = {},
): Promise<BuildResult> {
  const out = await buildWithRspack(root, entries, options, extra)
  onTestFinished(() => out.dispose())
  return out
}

describe('the Rspack plugin', () => {
  it(
    'reports failing owned imports as Rspack errors at the import, with code and hint',
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
      expect(errors[0]).toMatch(
        /is not in the Deno cache and `cachedOnly` is set\. \(CACHED_ONLY_MISS\)/,
      )
      expect(errors[0]).toContain('hint: ')
      // The message, not the plugin's stack.
      expect(errors[0]).not.toMatch(/\bat .*requests\.(?:ts|js)/)
      expect(modules).toEqual(['./src/broken.ts'])
    },
  )

  it("takes over Rspack's web preset and says so at info level", timeout, async () => {
    const project = await fixture('core-remote-mirror')
    const out = await bundle(project.root, project.manifest.entries, {}, { target: 'web' })
    const chunk = entryChunk(out)
    // Without the plugin, Rspack keeps https: imports external.
    expect(chunk.imports).toEqual([])
    expect(chunk.code).toContain('function closestString')
    expect(infoLines(out.logs)).toContainEqual(
      expect.stringContaining(
        '[rspack] externalsPresets.web: unplugin-deno resolves https: imports itself',
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
    expect(entryChunk(out).imports).toEqual([
      'https://deno.land/std@0.224.0/text/closest_string.ts',
    ])
  })
})

describe('core-basic (rspack)', () => {
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
    // The ?raw import stayed with Rspack's own rules; nothing was synthesised.
    expect(ids).toContain(slashed([project.path('src/message.txt')])[0])
    expect(ids.filter((id) => id.includes('/.virtual/unplugin-deno/'))).toEqual([])
  })
})

describe('core-import-map-precedence (rspack)', () => {
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
    // An unmapped name stays with Rspack's resolver.
    expect(ids).toContain(slashed([project.path('node_modules/stub-only-pkg/index.js')])[0])
  })
})

const npmLocations: Record<string, { ansiRegex: string; installed: boolean }> = {
  // Redirected: Rspack resolved the packages inside node_modules/.deno.
  'core-npm-node-modules': { ansiRegex: '/node_modules/.deno/ansi-regex@6.3.0/', installed: true },
  // Global cache: the engine resolved strip-ansi's import of ansi-regex (no node_modules).
  'core-npm-global-cache': {
    ansiRegex: '/npm/registry.npmjs.org/ansi-regex/6.3.0/',
    installed: false,
  },
}
for (const [name, location] of Object.entries(npmLocations)) {
  describe(`${name} (rspack)`, () => {
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
      // `sideEffects: false` reaches Rspack: only lodash-es's chunk() and its helpers remain.
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

describe('core-remote-mirror (rspack)', () => {
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

describe('core-attributes (rspack)', () => {
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
      // Markers are virtual `.js` files named after their target; json is Rspack's.
      const ids = slashed(out.chunks.flatMap((chunk) => chunk.moduleIds))
      const markers = ids
        .filter((id) => id.includes('/node_modules/.virtual/unplugin-deno/'))
        .map((id) => id.slice(id.lastIndexOf('/') + 1))
      expect(markers.toSorted()).toEqual(
        [
          'data.bin.bytes.js',
          'data.txt.text.js',
          'license.bytes.js',
          'license.text.js',
          'normalize.css.css.js',
          'style.css.css.js',
        ].toSorted(),
      )
      expect(ids).toContain(slashed([project.path('src/data.json')])[0])
    },
  )
})

describe('core-platform-deno (rspack)', () => {
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

  it('derives the Deno platform from target node and a deno.json', timeout, async () => {
    const project = await fixture('core-platform-deno')
    const expected = project.manifest.expect as { externals: string[] }
    const out = await bundle(project.root, entries, {}, { target: 'node' })
    expect(entryChunk(out).imports.toSorted()).toEqual(expected.externals.toSorted())
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

describe('core-workspace (rspack)', () => {
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

describe('core-virtual-coexist (rspack)', () => {
  it("never intercepts an unplugin-based plugin's virtual: and \\0 ids", timeout, async () => {
    const project = await fixture('core-virtual-coexist')
    const seen: string[] = []
    const companion = createUnplugin(() => ({
      name: 'test-virtual',
      resolveId(source: string) {
        if (!source.startsWith('virtual:')) return null
        seen.push(source)
        return source === 'virtual:answer' ? '\0virtual:answer' : '\0greeting'
      },
      load(id: string) {
        if (id === '\0virtual:answer') return 'export default 42'
        if (id === '\0greeting') {
          return 'const note = "with { type: \'text\' } stays as it is"\nexport default `hi, ${note}`'
        }
        return null
      },
    })).rspack()
    const out = await bundle(project.root, project.manifest.entries, {}, { plugins: [companion] })
    const { values } = await evaluateModule<{ values: unknown }>(out.entry)
    expect(values).toEqual(expectedValues(project))
    expect(seen.toSorted()).toEqual(['virtual:answer', 'virtual:greeting'])
  })
})

describe('webpack-remote-css (rspack)', () => {
  it(
    'keeps remote URLs in CSS external, as the web preset it took over does',
    timeout,
    async () => {
      const project = await fixture('webpack-remote-css')
      const expected = project.manifest.expect as { values: Record<string, unknown>; css: string[] }
      const out = await bundle(
        project.root,
        project.manifest.entries,
        {},
        { target: 'web', module: { rules: [{ test: /\.css$/, type: 'css/auto' }] } },
      )
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expected.values)
      const css = await emittedCss(out)
      expect(css).toContain(`@import url("${expected.css[0]}");`)
      expect(css).toContain(`url("${expected.css[1]}")`)
      expect(css).toContain(`url('${expected.css[2]}')`)
      // Only the module import reached the mirror.
      expect(readdirSync(join(generationDir(project.root), 'https'))).toEqual(['deno.land'])
    },
  )
})

describe('webpack-watch (rspack)', () => {
  it('reloads a changed deno.json and rebuilds edited marker targets', timeout, async () => {
    const project = await fixture('webpack-watch')
    const expected = project.manifest.expect as Record<'first' | 'mapped' | 'edited', unknown>
    vi.stubEnv('DENO_DIR', await denoDir())
    const outDir = await outputDir()
    onTestFinished(() => rm(outDir, { recursive: true, force: true, maxRetries: 3 }))
    const compiler: Compiler = rspack(
      rspackConfig(
        project.root,
        project.manifest.entries,
        outDir,
        [],
        {},
        {
          mode: 'development',
          devtool: false,
        },
      ),
    )
    const builds = watchBuilds(outDir, (handler) => {
      const watching = compiler.watch({ aggregateTimeout: 50 }, (error, stats) =>
        handler(error ?? undefined, stats?.hasErrors() === true ? stats.toString() : undefined),
      )
      return () =>
        new Promise<void>((resolve) => {
          watching.close(() => compiler.close(() => resolve()))
        })
    })
    onTestFinished(() => builds.close())
    expect(await builds.next(() => true)).toEqual(expected.first)
    const configFile = project.path('deno.json')
    await writeFile(
      configFile,
      (await readFile(configFile, 'utf8')).replace('./src/hello.ts', './src/goodbye.ts'),
    )
    expect(await builds.next((values) => values.greeting === 'goodbye')).toEqual(expected.mapped)
    await writeFile(project.path('src/note.txt'), 'second\n')
    expect(await builds.next((values) => values.note === 'second\n')).toEqual(expected.edited)
  })
})
