/**
 * The core fixtures (`test/fixtures/core-*`) built with a real host and asserted on the output.
 * `rolldown.test.ts` and `rollup.test.ts` run it for their host; fixtures whose `hosts` do not
 * list the host are skipped there (with the reason in `SKIPPED`).
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Options } from '../../src/core/options.js'
import { DEFAULT_ALLOW_IMPORT } from '../../src/core/options.js'
import type { BuildEntries, BuildResult } from '../helpers/build.js'
import {
  buildWithRolldown,
  buildWithRollup,
  evaluateModule,
  installCssStyleSheet,
} from '../helpers/build.js'
import { denoBinary } from '../helpers/deno-binary.js'
import { freshDenoDir, TEST_DENO_DIR_ENV, testDenoDirPath } from '../helpers/deno-dir.js'
import type { HostName } from '../helpers/fixture.js'
import { startMockRegistry } from '../helpers/mock-registry.js'
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
    'core-jsr-node-modules':
      'Rollup needs @rollup/plugin-node-resolve for the imports inside the @jsr/* packages',
  },
}

const execFileAsync = promisify(execFile)

/** Host-specific build options (Rolldown input options or Rollup input options). */
interface HostOptions {
  plugins?: unknown[]
  /** Rolldown's `platform` (ignored for Rollup). */
  platform?: 'node' | 'browser' | 'neutral'
  cwd?: string
  /** Write source maps next to the output. */
  sourcemap?: boolean
  /** More input options of the host (e.g. Rolldown `transform`, Rollup `jsx`). */
  input?: Record<string, unknown>
}

/** Builds with `host`; the output directory is removed after the test. */
export async function build(
  host: SuiteHost,
  root: string,
  entries: BuildEntries,
  options: Options = {},
  hostOptions: HostOptions = {},
): Promise<BuildResult> {
  const { plugins = [], platform, cwd, sourcemap, input = {} } = hostOptions
  const output = sourcemap === true ? { output: { sourcemap: true } } : {}
  const out =
    host === 'rolldown'
      ? await buildWithRolldown(root, entries, options, {
          plugins: plugins as never,
          ...(platform === undefined ? {} : { platform }),
          ...(cwd === undefined ? {} : { cwd }),
          ...output,
          ...input,
        })
      : await buildWithRollup(root, entries, cwd === undefined ? options : { cwd, ...options }, {
          plugins: plugins as never,
          ...output,
          ...input,
        })
  onTestFinished(() => out.dispose())
  return out
}

/** A plugin placed after unplugin-deno that keeps `node:` builtins external (for browser builds). */
export function nodeExternalPlugin(): object {
  return {
    name: 'test-node-external',
    resolveId(source: string) {
      return source.startsWith('node:') ? { id: source, external: true } : null
    },
  }
}

/**
 * Whether `text` contains the absolute path `path`, compared with `/` separators (Windows-safe,
 * JSON-escaped backslashes included). A relative path that climbs to it from the process's working
 * directory (`../../tmp/x`, as Rolldown's region comments in Vite do) does not count.
 */
export function containsAbsolutePath(text: string, path: string): boolean {
  // Rolldown's `//#region <path>` comments are relative to its cwd, which is impossible across
  // Windows drives (CI checks out on D: and creates temp projects on C:); they are not ours.
  const haystack = slashAll(text.replace(/^\/\/#(?:end)?region .*$/gm, ''))
  const needle = slashAll(path)
  for (let index = haystack.indexOf(needle); index !== -1;) {
    if (haystack.slice(Math.max(0, index - 2), index) !== '..') return true
    index = haystack.indexOf(needle, index + 1)
  }
  return false
}

/** `text` with `/` for `\` and JSON-escaped `\\`. */
function slashAll(text: string): string {
  return text.replaceAll('\\\\', '/').replaceAll('\\', '/')
}

/** The messages of the warnings a build logged whose text contains `part`. */
export function warningsWith(out: { logs: Array<{ message: string }> }, part: string): string[] {
  return out.logs.map((log) => log.message).filter((message) => message.includes(part))
}

/** The number of `import.meta.main` expressions in `code`. */
export function importMetaMainCount(code: string): number {
  return code.match(/import\.meta\.main/g)?.length ?? 0
}

/**
 * The messages, hints and codes of a build error, of its causes and of the errors it aggregates
 * (hosts wrap plugin errors differently), one per line.
 */
export function errorText(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    const record = value as Record<string, unknown>
    for (const key of ['message', 'hint', 'code', 'pluginCode', 'text']) {
      const field = record[key]
      if (typeof field === 'string') parts.push(field)
    }
    walk(record.cause)
    walk(record.detail)
    if (Array.isArray(record.errors)) for (const item of record.errors) walk(item)
    if (Array.isArray(record.notes)) for (const item of record.notes) walk(item)
  }
  walk(error)
  return parts.join('\n')
}

/** The {@link errorText} of the error a build fails with. */
export async function buildError(pending: Promise<unknown>): Promise<string> {
  try {
    await pending
  } catch (error) {
    return errorText(error)
  }
  throw new Error('expected the build to fail')
}

/** Whether `a` and `b` are the same JSON document. */
function sameJson(a: string, b: string): boolean {
  return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b))
}

/**
 * Runs the Deno platform output in `outDir` like Deno Deploy: `deno cache` (in a fresh
 * `DENO_DIR`, which must leave the sidecar deno.lock unchanged), then
 * `deno run --frozen --cached-only`. Returns the values the entry exports.
 */
export async function runWithSidecar(outDir: string, entry = 'server.js'): Promise<unknown> {
  await writeFile(
    join(outDir, 'run.mjs'),
    `import { values } from './${entry}'\nconsole.log(JSON.stringify(values))\n`,
  )
  const cache = await freshDenoDir()
  onTestFinished(() => cache.dispose())
  const env = { ...process.env, DENO_DIR: cache.path, NO_COLOR: '1' }
  const lock = await readFile(join(outDir, 'deno.lock'), 'utf8')
  await execFileAsync('deno', ['cache', '--quiet', 'run.mjs'], { cwd: outDir, env })
  expect(sameJson(await readFile(join(outDir, 'deno.lock'), 'utf8'), lock)).toBe(true)
  const { stdout } = await execFileAsync(
    'deno',
    ['run', '-A', '--frozen', '--cached-only', 'run.mjs'],
    { cwd: outDir, env },
  )
  return JSON.parse(stdout) as unknown
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

    it.skipIf(denoBinary.skipReason !== undefined)(
      `builds the same output with the \`deno\` engine (${denoBinary.skipReason ?? 'Deno found'})`,
      timeout,
      async () => {
        const project = await fixture('core-basic')
        const out = await build(
          host,
          project.root,
          project.manifest.entries,
          { platform: 'node', engine: 'deno', denoBinary: denoBinary.binary },
          { plugins: [rawQueryPlugin([])], platform: 'node' },
        )
        const { values } = await evaluateModule<{ values: Record<string, unknown> }>(out.entry)
        expect(values).toMatchObject(expectedValues(project))
        const chunk = entryChunk(out)
        expect(chunk.imports.filter((id) => /^(?:jsr|npm|https?|data):/.test(id))).toEqual([])
        expect(chunk.moduleIds.some((id) => id.includes('closest_string.ts.js'))).toBe(true)
      },
    )
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
        sourceRoot: string
        sourcesContent: string[]
        file: string
      }
      // The URL as sourceRoot + sources (esbuild and other readers see the URL).
      expect(map.sourceRoot).toBe('https://jsr.io/@std/path/1.1.6/posix/')
      expect(map.sources).toEqual(['mod.ts'])
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

    it(
      'names mirrored sources next to the mirror file in output source maps',
      timeout,
      async () => {
        const project = await fixture('core-remote-mirror')
        const out = await build(
          host,
          project.root,
          project.manifest.entries,
          { platform: 'browser' },
          { sourcemap: true },
        )
        const map = JSON.parse(await readFile(`${out.entry}.map`, 'utf8')) as {
          sources: string[]
          sourcesContent: string[]
        }
        const sources = map.sources.map((source) => source.replaceAll('\\', '/'))
        const generation = generationDir(project.root).slice(-8)
        const joinSource = sources.findIndex((source) =>
          source.endsWith(
            `node_modules/.unplugin-deno/${generation}/https/jsr.io/@std/path/1.1.6/posix/join.ts`,
          ),
        )
        expect(joinSource).toBeGreaterThanOrEqual(0)
        expect(map.sourcesContent[joinSource]).toContain('export function join(')
        expect(
          sources.some((source) =>
            source.endsWith(`${generation}/https/deno.land/std@0.224.0/text/closest_string.ts`),
          ),
        ).toBe(true)
        // Not mangled into paths such as `…/posix/https:/jsr.io/…`.
        expect(sources.filter((source) => source.includes('https:'))).toEqual([])
      },
    )
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
        // No machine path in the output (region comments, chunk names).
        for (const chunk of out.chunks) {
          expect(containsAbsolutePath(chunk.code, project.root)).toBe(false)
        }
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
      'writes a sidecar deno.json and deno.lock of the externals next to the entry (emitDenoConfig)',
      timeout,
      async () => {
        const project = await fixture('core-platform-deno')
        const out = await build(host, project.root, entries, {
          platform: 'deno',
          emitDenoConfig: true,
        })
        expect(JSON.parse(await readFile(join(out.outDir, 'deno.json'), 'utf8'))).toEqual({
          lock: './deno.lock',
          nodeModulesDir: 'none',
        })
        const lock = JSON.parse(await readFile(join(out.outDir, 'deno.lock'), 'utf8')) as {
          specifiers: Record<string, string>
          jsr: Record<string, unknown>
          npm: Record<string, unknown>
          remote?: unknown
        }
        expect(Object.keys(lock.jsr)).toEqual(['@std/internal@1.0.14', '@std/path@1.1.6'])
        expect(Object.keys(lock.npm)).toEqual(['kleur@4.1.5'])
        expect(lock.specifiers).toMatchObject({
          'jsr:@std/path@1.1.6': '1.1.6',
          'npm:kleur@4.1.5': '4.1.5',
        })
        // The https: module is bundled: no remote entries.
        expect(lock.remote).toBeUndefined()
        // Other platforms write nothing.
        const browser = await build(host, project.root, ['src/answer.ts'], {
          platform: 'browser',
          emitDenoConfig: true,
        })
        expect(existsSync(join(browser.outDir, 'deno.json'))).toBe(false)
      },
    )

    it.skipIf(!DENO_AVAILABLE)(
      'runs with the sidecar under `deno run --frozen --cached-only`, with and without a project lockfile (skipped without a deno binary)',
      timeout,
      async () => {
        const project = await fixture('core-platform-deno')
        const out = await build(host, project.root, entries, {
          platform: 'deno',
          emitDenoConfig: true,
        })
        expect(await runWithSidecar(out.outDir)).toEqual(expectedValues(project))
        // Without deno.lock the sidecar comes from Deno's cache and the engine's resolutions.
        const unlocked = await fixture('core-platform-deno')
        await rm(unlocked.path('deno.lock'))
        const fromCache = await build(host, unlocked.root, entries, {
          platform: 'deno',
          emitDenoConfig: true,
        })
        expect(warningsWith(fromCache, 'sidecar deno.lock')).toEqual([])
        expect(await runWithSidecar(fromCache.outDir)).toEqual(expectedValues(project))
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
        expect(entryChunk(bundled).imports.toSorted()).toEqual([
          'jsr:@std/path@1.1.6/posix',
          'node:fs',
        ])
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

  describe.runIf(runs('core-jsx-preact'))(`core-jsx-preact (${host})`, () => {
    it('compiles local JSX with the deno.json settings (react-jsx, preact)', timeout, async () => {
      const project = await fixture('core-jsx-preact')
      const out = await build(host, project.root, project.manifest.entries, { platform: 'browser' })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
      const chunk = entryChunk(out)
      expect(chunk.imports).toEqual([])
      // `preact/jsx-runtime` resolved through the import map (`preact` → `npm:preact@^10`).
      const ids = slashed(chunk.moduleIds)
      expect(ids.some((id) => /\/preact\/10\.29\.8\/jsx-runtime\/dist\//.test(id))).toBe(true)
      expect(warningsWith(out, 'precompile')).toEqual([])
    })

    it('follows react-jsxdev, the classic runtime and precompile', timeout, async () => {
      const project = await fixture('core-jsx-preact')
      const config = JSON.parse(await readFile(project.path('deno.json'), 'utf8')) as object
      // [compilerOptions, whether the preact JSX runtime is bundled, whether it is the development
      // one (its calls pass the source location)]
      const variants = [
        // Rollup has no development runtime: it compiles react-jsxdev like react-jsx.
        [{ jsx: 'react-jsxdev', jsxImportSource: 'preact' }, true, host !== 'rollup'],
        [{ jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }, false, false],
        [{ jsx: 'precompile', jsxImportSource: 'preact' }, true, false],
      ] as const
      for (const [compilerOptions, runtime, development] of variants) {
        await writeFile(project.path('deno.json'), JSON.stringify({ ...config, compilerOptions }))
        const out = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
        })
        const { values } = await evaluateModule<{ values: unknown }>(out.entry)
        expect(values).toEqual(expectedValues(project))
        const chunk = entryChunk(out)
        // preact's jsx-dev-runtime export is the jsx-runtime file.
        const ids = slashed(chunk.moduleIds)
        expect(ids.some((id) => id.includes('/preact/10.29.8/jsx-runtime/'))).toBe(runtime)
        expect(chunk.code.includes('lineNumber')).toBe(development)
        expect(warningsWith(out, '"precompile"')).toHaveLength(
          compilerOptions.jsx === 'precompile' ? 1 : 0,
        )
      }
    })

    it(
      'leaves JSX the host config sets, and every JSX setting with jsx: host',
      timeout,
      async () => {
        const project = await fixture('core-jsx-preact')
        const classic =
          host === 'rolldown'
            ? { transform: { jsx: { runtime: 'classic', pragma: 'h', pragmaFrag: 'Fragment' } } }
            : { jsx: { mode: 'classic', factory: 'h', fragment: 'Fragment' } }
        const out = await build(
          host,
          project.root,
          project.manifest.entries,
          { platform: 'browser' },
          { input: classic },
        )
        const { values } = await evaluateModule<{ values: unknown }>(out.entry)
        expect(values).toEqual(expectedValues(project))
        expect(slashed(entryChunk(out).moduleIds).some((id) => id.includes('/jsx-runtime/'))).toBe(
          false,
        )
        // With jsx: 'host' the deno.json settings are not applied: Rolldown uses React's runtime,
        // and Rollup has no JSX option, so the JSX the TypeScript plugin preserved fails to parse.
        const hostOnly = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
          jsx: 'host',
        }).then(
          (result) => entryChunk(result).imports.join(' '),
          (error: unknown) => String(error),
        )
        expect(hostOnly).toMatch(host === 'rolldown' ? /react\/jsx-runtime/ : /Error/)
      },
    )
  })

  describe.runIf(runs('core-import-meta-main'))(`core-import-meta-main (${host})`, () => {
    it('replaces import.meta.main in modules that are not entries', timeout, async () => {
      const project = await fixture('core-import-meta-main')
      const out = await build(host, project.root, project.manifest.entries, { platform: 'browser' })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
      // The entry's own import.meta.main is kept.
      expect(importMetaMainCount(entryChunk(out).code)).toBe(1)
      const kept = await build(host, project.root, project.manifest.entries, {
        platform: 'browser',
        importMetaMain: false,
      })
      expect(importMetaMainCount(entryChunk(kept).code)).toBe(3)
    })
  })

  describe.runIf(runs('core-env-inline'))(`core-env-inline (${host})`, () => {
    it(
      'inlines allowed variables for the browser from the process and .env files',
      timeout,
      async () => {
        const project = await fixture('core-env-inline')
        const files = project.manifest.expect?.files as Record<string, string>
        for (const [name, text] of Object.entries(files)) await writeFile(project.path(name), text)
        vi.stubEnv('PUBLIC_TARGET', 'from the process')
        const out = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
          env: { prefix: 'PUBLIC_' },
          denoGlobals: 'off',
        })
        const mod = await evaluateModule<{ values: unknown; fromFile: () => unknown }>(out.entry)
        expect(mod.values).toEqual(expectedValues(project))
        expect(mod.fromFile()).toBeUndefined()
        const { code } = entryChunk(out)
        expect(code).not.toContain('PUBLIC_')
        expect(code).toMatch(/Deno\.env\.get\(["']SECRET["']\)/)
        expect(code).toContain('Deno.env.toObject()')
        // Listed files replace the defaults.
        const listed = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
          env: { prefix: ['PUBLIC_'], files: ['app.env'] },
          denoGlobals: 'off',
        })
        const listedModule = await evaluateModule<{ fromFile: () => unknown }>(listed.entry)
        expect(listedModule.fromFile()).toBe('from app.env')
        // Server platforms read their environment at runtime.
        const server = await build(host, project.root, project.manifest.entries, {
          platform: 'deno',
          env: { prefix: 'PUBLIC_' },
        })
        expect(entryChunk(server).code).toMatch(/Deno\.env\.get\(["']PUBLIC_GREETING["']\)/)
      },
    )
  })

  describe.runIf(runs('core-deno-globals'))(`core-deno-globals (${host})`, () => {
    it(
      'reports Deno globals of local modules in browser bundles once, with the location',
      timeout,
      async () => {
        const project = await fixture('core-deno-globals')
        const expected = project.manifest.expect as { values: object; warning: string }
        const out = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
        })
        const { values } = await evaluateModule<{ values: object }>(out.entry)
        expect(values).toMatchObject(expected.values)
        expect(warningsWith(out, 'uses `Deno.')).toEqual([
          expect.stringContaining(expected.warning),
        ])
        const quiet = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
          denoGlobals: 'off',
        })
        expect(warningsWith(quiet, 'uses `Deno.')).toEqual([])
        const server = await build(host, project.root, project.manifest.entries, {
          platform: 'deno',
        })
        expect(warningsWith(server, 'uses `Deno.')).toEqual([])
      },
    )

    it("fails the build with denoGlobals: 'error'", timeout, async () => {
      const project = await fixture('core-deno-globals')
      const expected = project.manifest.expect as { warning: string }
      await expect(
        build(host, project.root, project.manifest.entries, {
          platform: 'browser',
          denoGlobals: 'error',
        }),
      ).rejects.toThrow(expected.warning)
    })
  })

  describe.runIf(runs('core-checks'))(`core-checks (${host})`, () => {
    it(
      'warns about node: builtins in browser bundles and npm packages in two versions',
      timeout,
      async () => {
        const project = await fixture('core-checks')
        const expected = project.manifest.expect as { builtin: string; duplicate: string }
        const out = await build(
          host,
          project.root,
          project.manifest.entries,
          { platform: 'browser' },
          { plugins: [nodeExternalPlugin()], platform: 'browser' },
        )
        const { values } = await evaluateModule<{ values: unknown }>(out.entry)
        expect(values).toEqual(expectedValues(project))
        expect(warningsWith(out, expected.builtin)).toHaveLength(1)
        expect(warningsWith(out, expected.duplicate)).toEqual([
          expect.stringContaining('(3.3.19, 5.1.16)'),
        ])
        const quiet = await build(
          host,
          project.root,
          project.manifest.entries,
          { platform: 'browser', checks: false },
          { plugins: [nodeExternalPlugin()], platform: 'browser' },
        )
        expect(warningsWith(quiet, expected.builtin)).toEqual([])
        expect(warningsWith(quiet, expected.duplicate)).toEqual([])
      },
    )
  })

  describe.runIf(runs('core-wasm'))(`core-wasm (${host})`, () => {
    it('instantiates .wasm module imports like Deno, with their own imports', timeout, async () => {
      const project = await fixture('core-wasm')
      const out = await build(host, project.root, project.manifest.entries, { platform: 'browser' })
      const { values } = await evaluateModule<{ values: unknown }>(out.entry)
      expect(values).toEqual(expectedValues(project))
      const chunk = entryChunk(out)
      expect(chunk.imports).toEqual([])
      expect(chunk.code).toContain('new WebAssembly.Instance(')
      expect(slashed(chunk.moduleIds)).toContain(
        project.path('src/offset.js').replaceAll('\\', '/'),
      )
    })
  })

  describe.runIf(runs('core-basic'))(`node_modules of another package manager (${host})`, () => {
    it('warns when Deno manages a node_modules pnpm installed', timeout, async () => {
      const project = await fixture('core-basic')
      const config = JSON.parse(await readFile(project.path('deno.json'), 'utf8')) as object
      await writeFile(
        project.path('deno.json'),
        JSON.stringify({ ...config, nodeModulesDir: 'auto' }),
      )
      await mkdir(project.path('node_modules'), { recursive: true })
      await writeFile(project.path('node_modules/.modules.yaml'), 'layoutVersion: 5\n')
      const out = await build(
        host,
        project.root,
        project.manifest.entries,
        { platform: 'node' },
        { plugins: [rawQueryPlugin([])], platform: 'node' },
      )
      expect(warningsWith(out, 'was installed by pnpm')).toHaveLength(1)
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

  describe.runIf(runs('core-lockfile-frozen'))(`core-lockfile-frozen (${host})`, () => {
    it(
      "fails on drift from deno.lock when frozen (also 'auto' with CI set), builds in auto mode",
      timeout,
      async () => {
        vi.stubEnv('CI', '')
        const project = await fixture('core-lockfile-frozen')
        const expected = project.manifest.expect as { drift: string; bundled: string }
        const lockText = await readFile(project.path('deno.lock'), 'utf8')
        const frozen = await buildError(
          build(host, project.root, project.manifest.entries, {
            platform: 'browser',
            lockfile: 'frozen',
          }),
        )
        expect(frozen).toContain(expected.drift)
        expect(frozen).toContain('Run `deno install` to update deno.lock')
        const auto = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
          debug: true,
        })
        expect((await evaluateModule<{ values: unknown }>(auto.entry)).values).toEqual(
          expectedValues(project),
        )
        expect(
          slashed(entryChunk(auto).moduleIds).some((id) => id.includes(expected.bundled)),
        ).toBe(true)
        expect(auto.logs.some((log) => log.message.includes('(NOT_IN_LOCKFILE); allowed by'))).toBe(
          true,
        )
        vi.stubEnv('CI', 'true')
        expect(
          await buildError(
            build(host, project.root, project.manifest.entries, { platform: 'browser' }),
          ),
        ).toContain(expected.drift)
        // `lockfile: 'off'` ignores it; the plugin never writes it.
        const off = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
          lockfile: 'off',
        })
        expect((await evaluateModule<{ values: unknown }>(off.entry)).values).toEqual(
          expectedValues(project),
        )
        expect(await readFile(project.path('deno.lock'), 'utf8')).toBe(lockText)
      },
    )
  })

  describe.runIf(runs('core-allow-import'))(`core-allow-import (${host})`, () => {
    it(
      'allows the hosts deno.json and deno.lock name, refuses others before downloading them',
      timeout,
      async () => {
        vi.stubEnv('CI', '')
        const project = await fixture('core-allow-import')
        const expected = project.manifest.expect as {
          otherHost: string
          disallowed: string
          host: string
        }
        const out = await build(host, project.root, project.manifest.entries, {
          platform: 'browser',
        })
        expect((await evaluateModule<{ values: unknown }>(out.entry)).values).toEqual(
          expectedValues(project),
        )
        const refused = await buildError(
          build(host, project.root, [expected.otherHost], { platform: 'browser' }),
        )
        expect(refused).toContain(expected.disallowed)
        expect(refused).toContain(`Add "${expected.host}" to allowImport`)
        // Nothing of the refused host reached the mirror.
        const cacheDir = project.path('node_modules', '.unplugin-deno')
        const mirrored = readdirSync(cacheDir, { recursive: true }).map(String)
        expect(mirrored.filter((file) => file.includes(expected.host))).toEqual([])
        for (const allowImport of [[...DEFAULT_ALLOW_IMPORT, expected.host], ['*']]) {
          const allowed = await build(host, project.root, [expected.otherHost], {
            platform: 'browser',
            allowImport,
          })
          expect((await evaluateModule<{ values: unknown }>(allowed.entry)).values).toEqual(
            expectedValues(project),
          )
        }
      },
    )
  })

  describe.runIf(runs('core-jsr-node-modules'))(`core-jsr-node-modules (${host})`, () => {
    for (const engine of ['loader', 'deno'] as const) {
      const skip = engine === 'deno' ? denoBinary.skipReason : undefined
      it.skipIf(skip !== undefined)(
        `resolves jsr: through node_modules/@jsr, never the JSR registry (${engine} engine${skip === undefined ? '' : `, skipped: ${skip}`})`,
        timeout,
        async () => {
          const project = await fixture('core-jsr-node-modules')
          const expected = project.manifest.expect as { packageDir: string }
          const out = await build(
            host,
            project.root,
            project.manifest.entries,
            { platform: 'browser', engine, denoBinary: denoBinary.binary, debug: true },
            { platform: 'browser' },
          )
          expect((await evaluateModule<{ values: unknown }>(out.entry)).values).toEqual(
            expectedValues(project),
          )
          const ids = slashed(entryChunk(out).moduleIds)
          expect(ids.some((id) => id.includes(`/${expected.packageDir}/posix/join.js`))).toBe(true)
          expect(
            ids.filter((id) => id.includes('.unplugin-deno') || id.includes('jsr.io')),
          ).toEqual([])
          expect(
            out.logs.some((log) =>
              log.message.includes(
                '[resolve] jsr:@std/path@^1/posix/join → npm:@jsr/std__path@^1/posix/join (node_modules/@jsr)',
              ),
            ),
          ).toBe(true)
        },
      )
    }
  })

  describe(`cachedOnly (${host})`, () => {
    it(
      'fails offline with CACHED_ONLY_MISS naming the import and `deno cache <entry>`',
      timeout,
      async () => {
        const cache = await freshDenoDir()
        onTestFinished(() => cache.dispose())
        vi.stubEnv(TEST_DENO_DIR_ENV, cache.path)
        const project = await fixture('core-remote-mirror')
        const text = await buildError(
          build(host, project.root, project.manifest.entries, {
            platform: 'browser',
            cachedOnly: true,
          }),
        )
        expect(text).toContain('`cachedOnly` is set')
        expect(text).toContain(
          'Run `deno cache src/main.ts` (or `deno install`) with network access',
        )
        // Nothing was downloaded.
        const remote = join(cache.path, 'remote')
        expect(existsSync(remote) ? readdirSync(remote, { recursive: true }) : []).toEqual([])
      },
    )

    it('builds from a warm cache without downloading', timeout, async () => {
      const warm = await fixture('core-remote-mirror')
      await build(host, warm.root, warm.manifest.entries, { platform: 'browser' })
      // A new copy has an empty mirror: every remote module comes from Deno's cache.
      const project = await fixture('core-remote-mirror')
      const out = await build(host, project.root, project.manifest.entries, {
        platform: 'browser',
        cachedOnly: true,
        debug: true,
      })
      expect((await evaluateModule<{ values: unknown }>(out.entry)).values).toEqual(
        expectedValues(project),
      )
      expect(mirrorLoads(out).length).toBeGreaterThan(0)
      expect(out.logs.filter((log) => log.message.includes('Downloading'))).toEqual([])
    })
  })

  describe(`core-private-registry (${host})`, () => {
    it(
      'installs npm packages from NPM_CONFIG_REGISTRY with the .npmrc auth token',
      timeout,
      async () => {
        await using registry = await startMockRegistry()
        const cache = await freshDenoDir()
        onTestFinished(() => cache.dispose())
        vi.stubEnv(TEST_DENO_DIR_ENV, cache.path)
        const project = await fixture('core-private-registry')
        // No .npmrc of the user's home directory.
        vi.stubEnv('HOME', project.root)
        vi.stubEnv('USERPROFILE', project.root)
        vi.stubEnv('NPM_CONFIG_REGISTRY', registry.url)
        await writeFile(
          project.path('.npmrc'),
          `//127.0.0.1:${registry.port}/:_authToken=secret-token\n`,
        )
        const out = await build(host, project.root, ['src/npm.ts'], {
          platform: 'browser',
          engine: 'loader',
        })
        const expected = project.manifest.expect as { npm: unknown }
        expect((await evaluateModule<{ values: unknown }>(out.entry)).values).toEqual(expected.npm)
        expect(registry.requests).toContainEqual({
          path: '/mock-pkg',
          authorization: 'Bearer secret-token',
        })
        expect(registry.requests).toContainEqual({
          path: '/mock-pkg/-/mock-pkg-1.0.0.tgz',
          authorization: 'Bearer secret-token',
        })
      },
    )

    it(
      'loads JSR packages from a private registry through the fetch option (loader engine)',
      timeout,
      async () => {
        await using registry = await startMockRegistry()
        const cache = await freshDenoDir()
        onTestFinished(() => cache.dispose())
        vi.stubEnv(TEST_DENO_DIR_ENV, cache.path)
        const project = await fixture('core-private-registry')
        // The vendored loader always asks https://jsr.io/: a fetch sends it to the registry.
        const fetchImpl: typeof fetch = (input, init) =>
          globalThis.fetch(
            String(input instanceof Request ? input.url : input).replace(
              'https://jsr.io/',
              registry.url,
            ),
            {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers)),
                authorization: 'Bearer jsr-token',
              },
            },
          )
        const out = await build(host, project.root, ['src/jsr.ts'], {
          platform: 'browser',
          engine: 'loader',
          fetch: fetchImpl,
        })
        const expected = project.manifest.expect as { jsr: unknown }
        expect((await evaluateModule<{ values: unknown }>(out.entry)).values).toEqual(expected.jsr)
        expect(registry.requests).toContainEqual({
          path: '/@mock/pkg/1.0.0/mod.ts',
          authorization: 'Bearer jsr-token',
        })
      },
    )

    it.skipIf(denoBinary.skipReason !== undefined)(
      `loads JSR packages from JSR_URL with DENO_AUTH_TOKENS (deno engine${denoBinary.skipReason === undefined ? '' : `, skipped: ${denoBinary.skipReason}`})`,
      timeout,
      async () => {
        await using registry = await startMockRegistry()
        const cache = await freshDenoDir()
        onTestFinished(() => cache.dispose())
        vi.stubEnv(TEST_DENO_DIR_ENV, cache.path)
        vi.stubEnv('JSR_URL', registry.url)
        vi.stubEnv('DENO_AUTH_TOKENS', `jsr-token@127.0.0.1:${registry.port}`)
        const project = await fixture('core-private-registry')
        const out = await build(host, project.root, ['src/jsr.ts'], {
          platform: 'browser',
          engine: 'deno',
          denoBinary: denoBinary.binary,
        })
        const expected = project.manifest.expect as { jsr: unknown }
        expect((await evaluateModule<{ values: unknown }>(out.entry)).values).toEqual(expected.jsr)
        expect(registry.requests).toContainEqual({
          path: '/@mock/pkg/1.0.0/mod.ts',
          authorization: 'Bearer jsr-token',
        })
      },
    )
  })
}
