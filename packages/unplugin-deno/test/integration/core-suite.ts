/**
 * The core fixtures (`test/fixtures/core-*`) built with a real host and asserted on the output.
 * `rolldown.test.ts` and `rollup.test.ts` run it for their host; fixtures whose `hosts` do not
 * list the host are skipped there (with the reason in `SKIPPED`).
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { Options } from '../../src/core/options.js'
import type { BuildEntries, BuildResult } from '../helpers/build.js'
import {
  buildWithRolldown,
  buildWithRollup,
  evaluateModule,
  installCssStyleSheet,
} from '../helpers/build.js'
import { testDenoDirPath } from '../helpers/deno-dir.js'
import type { HostName } from '../helpers/fixture.js'
import type { TempProject } from '../helpers/temp-project.js'
import { tempProject } from '../helpers/temp-project.js'

/** The hosts this suite covers. */
export type SuiteHost = Extract<HostName, 'rolldown' | 'rollup'>

/** Why a fixture does not run on a host. */
export const SKIPPED: Readonly<Record<SuiteHost, Readonly<Record<string, string>>>> = {
  rolldown: {},
  rollup: {
    'core-npm-node-modules':
      'Rollup needs @rollup/plugin-commonjs for the CommonJS package (ms) and @rollup/plugin-node-resolve for redirects',
    'core-npm-global-cache': 'Rollup needs @rollup/plugin-commonjs for the CommonJS package (ms)',
  },
}

const execFileAsync = promisify(execFile)

/** Host-specific build options (Rolldown input options or Rollup input options). */
interface HostOptions {
  plugins?: unknown[]
  /** Rolldown's `platform` (ignored for Rollup). */
  platform?: 'node' | 'browser' | 'neutral'
  cwd?: string
}

/** Builds with `host`; the output directory is removed after the test. */
export async function build(
  host: SuiteHost,
  root: string,
  entries: BuildEntries,
  options: Options = {},
  hostOptions: HostOptions = {},
): Promise<BuildResult> {
  const { plugins = [], platform, cwd } = hostOptions
  const out =
    host === 'rolldown'
      ? await buildWithRolldown(root, entries, options, {
          plugins: plugins as never,
          ...(platform === undefined ? {} : { platform }),
          ...(cwd === undefined ? {} : { cwd }),
        })
      : await buildWithRollup(root, entries, cwd === undefined ? options : { cwd, ...options }, {
          plugins: plugins as never,
        })
  onTestFinished(() => out.dispose())
  return out
}

/** A temporary copy of a fixture, removed after the test. */
export async function fixture(name: string): Promise<TempProject> {
  const project = await tempProject(name)
  onTestFinished(() => project.dispose())
  return project
}

function entryChunk(out: BuildResult): BuildResult['chunks'][number] {
  const chunk = out.chunks.find((item) => item.isEntry)
  if (chunk === undefined) throw new Error('no entry chunk')
  return chunk
}

function expectedValues(project: TempProject): Record<string, unknown> {
  return (project.manifest.expect?.values ?? {}) as Record<string, unknown>
}

/** The single mirror generation directory of a project (default `cacheDir`). */
function generationDir(root: string): string {
  const cacheDir = join(root, 'node_modules', '.unplugin-deno')
  const generations = readdirSync(cacheDir).filter((name) => /^[0-9a-f]{8}$/.test(name))
  expect(generations).toHaveLength(1)
  return join(cacheDir, generations[0] ?? '')
}

function mirrorLoads(out: BuildResult): string[] {
  return out.logs
    .map((log) => log.message)
    .filter((message) => message.includes('[mirror] loading '))
}

/** A test plugin that serves `?raw` imports and records the ids it was asked for. */
function rawQueryPlugin(seen: string[]): object {
  return {
    name: 'test-raw-query',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('?raw') || importer === undefined) return null
      seen.push(source)
      return `\0raw:${resolve(dirname(importer), source.slice(0, -'?raw'.length))}`
    },
    load(id: string) {
      if (!id.startsWith('\0raw:')) return null
      const text = readFileSync(id.slice('\0raw:'.length), 'utf8')
      // `moduleType` for Rolldown, which would read a `.txt` id as text; Rollup ignores it.
      return { code: `export default ${JSON.stringify(text)}`, moduleType: 'js' }
    },
  }
}

/** A companion plugin with `virtual:` and `\0` modules; records what reaches it. */
function virtualPlugin(seen: string[]): object {
  return {
    name: 'test-virtual',
    resolveId(source: string) {
      if (!source.startsWith('virtual:')) return null
      seen.push(source)
      return source === 'virtual:answer' ? '\0virtual:answer' : '\0greeting'
    },
    load(id: string) {
      if (id === '\0virtual:answer') return 'export default 42'
      if (id === '\0greeting') {
        // Code that matches the attribute pre-pass filter; it must stay as it is.
        return 'const note = "with { type: \'text\' } stays as it is"\nexport default `hi, ${note}`'
      }
      return null
    },
  }
}

/** Whether the `deno` binary can be run (CI has it only on the `deno` matrix rows). */
export const DENO_AVAILABLE: boolean = (() => {
  try {
    execFileSync('deno', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Module ids with `/` separators, for assertions that hold on Windows too. */
function slashed(ids: readonly string[]): string[] {
  return ids.map((id) => id.replaceAll('\\', '/'))
}

/** Defines the core fixture tests for `host`. */
export function coreSuite(host: SuiteHost): void {
  const runs = (name: string): boolean => SKIPPED[host][name] === undefined
  const timeout = { timeout: 180_000 }

  describe.runIf(runs('core-basic'))(`core-basic (${host})`, () => {
    it('bundles jsr:, npm:, https:, data:, node:, local and aliased imports', timeout, async () => {
      const project = await fixture('core-basic')
      const seen: string[] = []
      const out = await build(
        host,
        project.root,
        project.manifest.entries,
        { platform: 'node' },
        { plugins: [rawQueryPlugin(seen)], platform: 'node' },
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
    })
  })

  describe.runIf(runs('core-import-map-precedence'))(`core-import-map-precedence (${host})`, () => {
    it(
      'resolves a mapped bare name through the import map, not node_modules',
      timeout,
      async () => {
        const project = await fixture('core-import-map-precedence')
        const out = await build(host, project.root, project.manifest.entries, { platform: 'node' })
        const ids = slashed(entryChunk(out).moduleIds)
        const kleur = ids.filter((id) => id.includes('/kleur/'))
        expect(kleur).toHaveLength(1)
        expect(kleur[0]).toContain('/npm/registry.npmjs.org/kleur/4.1.5/')
        expect(ids.some((id) => id.includes('/node_modules/kleur/'))).toBe(false)
      },
    )

    it.runIf(host === 'rolldown')(
      'leaves unmapped names to the host (node_modules)',
      timeout,
      async () => {
        const project = await fixture('core-import-map-precedence')
        const out = await build(host, project.root, project.manifest.entries, { platform: 'node' })
        const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
        expect(values).toMatchObject(expectedValues(project))
        expect(slashed(entryChunk(out).moduleIds)).toContain(
          project.path('node_modules/stub-only-pkg/index.js').replaceAll('\\', '/'),
        )
      },
    )

    // Rollup resolves nothing from node_modules without @rollup/plugin-node-resolve.
    it.runIf(host === 'rollup')(
      'leaves unmapped names to the host (unresolved)',
      timeout,
      async () => {
        const project = await fixture('core-import-map-precedence')
        const out = await build(host, project.root, project.manifest.entries, { platform: 'node' })
        expect(entryChunk(out).imports).toContain('stub-only-pkg')
        expect(out.logs.map((log) => log.code)).toContain('UNRESOLVED_IMPORT')
      },
    )
  })

  const npmLocations: Record<string, { ansiRegex: string; installed: boolean }> = {
    // Redirected: the host resolved the packages inside node_modules/.deno.
    'core-npm-node-modules': {
      ansiRegex: '/node_modules/.deno/ansi-regex@6.3.0/',
      installed: true,
    },
    // Global cache: the engine resolved strip-ansi's import of ansi-regex (no node_modules).
    'core-npm-global-cache': {
      ansiRegex: '/npm/registry.npmjs.org/ansi-regex/6.3.0/',
      installed: false,
    },
  }
  for (const [name, location] of Object.entries(npmLocations)) {
    describe.runIf(runs(name))(`${name} (${host})`, () => {
      it('bundles npm subpaths, CommonJS and tree-shaken ES packages', timeout, async () => {
        const project = await fixture(name)
        const out = await build(
          host,
          project.root,
          project.manifest.entries,
          { platform: 'node' },
          { platform: 'node' },
        )
        const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
        expect(values).toMatchObject(expectedValues(project))
        const chunk = entryChunk(out)
        // `sideEffects: false` reaches the host: only lodash-es's chunk() and its helpers remain.
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
        expect(existsSync(join(project.root, 'node_modules', 'strip-ansi'))).toBe(
          location.installed,
        )
      })
    })
  }

  describe.runIf(runs('core-remote-mirror'))(`core-remote-mirror (${host})`, () => {
    it('mirrors remote modules as files and reuses them in the next build', timeout, async () => {
      const project = await fixture('core-remote-mirror')
      const expected = project.manifest.expect as {
        values: Record<string, unknown>
        mirror: { jsrPath: string; closest: string }
      }
      // An explicit platform: Rollup has no platform of its own and would derive `deno` (§5.6).
      const options: Options = { debug: true, platform: 'browser' }
      const first = await build(host, project.root, project.manifest.entries, options)
      expect((await evaluateModule<{ values: unknown }>(first.entry)).values).toEqual(
        expected.values,
      )
      expect(mirrorLoads(first).length).toBeGreaterThan(20)

      const generation = generationDir(project.root)
      const mod = join(generation, ...expected.mirror.jsrPath.split('/'))
      const code = await readFile(mod, 'utf8')
      expect(code).toContain('export * from "./join.ts.js"')
      expect(code).toMatch(/\/\/# sourceMappingURL=mod\.ts\.js\.map\n$/)
      const joinCode = await readFile(join(dirname(mod), 'join.ts.js'), 'utf8')
      // Relative imports are rewritten to sibling mirror files (posix/join.ts → _common/…).
      expect(joinCode).toContain('from "../_common/assert_path.ts.js"')
      const closest = await readFile(
        join(generation, ...expected.mirror.closest.split('/')),
        'utf8',
      )
      expect(closest).toContain('from "./levenshtein_distance.ts.js"')
      expect(closest).toContain('from "../assert/assert.ts.js"')

      const map = JSON.parse(await readFile(`${mod}.map`, 'utf8')) as {
        sources: string[]
        sourcesContent: string[]
        file: string
      }
      expect(map.sources).toEqual(['https://jsr.io/@std/path/1.1.6/posix/mod.ts'])
      expect(map.file).toBe('mod.ts.js')
      expect(map.sourcesContent[0]).toContain('export * from "./join.ts";')

      const manifest = JSON.parse(await readFile(join(generation, 'manifest.json'), 'utf8')) as {
        modules: Record<string, { file: string; integrity: string; deps: string[] }>
      }
      expect(manifest.modules['https://jsr.io/@std/path/1.1.6/posix/mod.ts']?.file).toBe(
        expected.mirror.jsrPath,
      )
      expect(manifest.modules['https://jsr.io/@std/path/1.1.6/posix/mod.ts']?.deps).toContain(
        'https://jsr.io/@std/path/1.1.6/posix/join.ts',
      )
      const lock = JSON.parse(await readFile(project.path('deno.lock'), 'utf8')) as {
        remote: Record<string, string>
      }
      for (const [url, integrity] of Object.entries(lock.remote)) {
        expect(manifest.modules[url]?.integrity).toBe(integrity)
      }

      // The second build reads the mirror: no engine loads.
      const second = await build(host, project.root, project.manifest.entries, options)
      expect((await evaluateModule<{ values: unknown }>(second.entry)).values).toEqual(
        expected.values,
      )
      expect(mirrorLoads(second)).toEqual([])
      expect(generationDir(project.root)).toBe(generation)
    })
  })

  describe.runIf(runs('core-attributes'))(`core-attributes (${host})`, () => {
    it(
      'turns text, bytes and css attributes into marker modules; json stays native',
      timeout,
      async () => {
        onTestFinished(installCssStyleSheet())
        const project = await fixture('core-attributes')
        const out = await build(host, project.root, project.manifest.entries)
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

  describe.runIf(runs('core-platform-deno'))(`core-platform-deno (${host})`, () => {
    const entries = ['src/server.ts']
    it(
      'keeps npm:, jsr: and node: external and pinned, bundles local and https:',
      timeout,
      async () => {
        const project = await fixture('core-platform-deno')
        const out = await build(host, project.root, entries, { platform: 'deno' })
        const chunk = entryChunk(out)
        const expected = project.manifest.expect as { externals: string[] }
        expect(chunk.imports.toSorted()).toEqual(expected.externals.toSorted())
        expect(chunk.code).toContain('function closestString')
        expect(chunk.code).toContain('42')
        expect(chunk.imports.some((id) => id.includes('answer'))).toBe(false)
      },
    )

    it.skipIf(!DENO_AVAILABLE)(
      'runs under `deno run --cached-only` (skipped without a deno binary)',
      timeout,
      async () => {
        const project = await fixture('core-platform-deno')
        const out = await build(host, project.root, entries, { platform: 'deno' })
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

    it(
      'bundles what `bundle` names and keeps ranges with pinExternals: false',
      timeout,
      async () => {
        const project = await fixture('core-platform-deno')
        const bundled = await build(host, project.root, entries, {
          platform: 'deno',
          bundle: ['npm:kleur'],
        })
        expect(entryChunk(bundled).imports.toSorted()).toEqual(['jsr:@std/path@1.1.6', 'node:fs'])
        expect(slashed(entryChunk(bundled).moduleIds).some((id) => id.includes('/kleur/'))).toBe(
          true,
        )
        const ranges = await build(host, project.root, entries, {
          platform: 'deno',
          pinExternals: false,
        })
        const expected = project.manifest.expect as { ranges: string[] }
        expect(entryChunk(ranges).imports.toSorted()).toEqual(
          [...expected.ranges, 'node:fs'].toSorted(),
        )
      },
    )
  })

  describe.runIf(runs('core-workspace'))(`core-workspace (${host})`, () => {
    it('resolves members by name and member-scoped aliases', timeout, async () => {
      const project = await fixture('core-workspace')
      const out = await build(host, project.root, project.manifest.entries)
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
    })

    it('finds the workspace root from a member directory', timeout, async () => {
      const project = await fixture('core-workspace')
      const out = await build(
        host,
        project.root,
        project.manifest.entries,
        {},
        {
          cwd: project.path('packages/app'),
        },
      )
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
    })
  })

  describe.runIf(runs('core-virtual-coexist'))(`core-virtual-coexist (${host})`, () => {
    it("never intercepts other plugins' virtual: and \\0 ids", timeout, async () => {
      const project = await fixture('core-virtual-coexist')
      const seen: string[] = []
      const out = await build(
        host,
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
    })
  })
}
