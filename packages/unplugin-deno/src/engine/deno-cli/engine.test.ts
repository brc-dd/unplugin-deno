/**
 * Behaviour of the `deno` engine beyond the shared contract (`../contract.test.ts`). Skipped, with
 * the reason in the suite name, when the `deno` binary is missing or older than 2.8.3.
 */
import { existsSync, readdirSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoBinary } from '../../../test/helpers/deno-binary.js'
import { denoDir, freshDenoDir } from '../../../test/helpers/deno-dir.js'
import { normalize } from '../../../test/helpers/normalize.js'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import type { TempProject } from '../../../test/helpers/temp-project.js'
import { tempProject } from '../../../test/helpers/temp-project.js'
import type { ErrorCode } from '../../diagnostics/errors.js'
import { isDenoPluginError } from '../../diagnostics/errors.js'
import type { Logger } from '../../diagnostics/logger.js'
import { createSilentLogger } from '../../diagnostics/logger.js'
import { toFileUrl } from '../../utils/path.js'
import { HINTS } from '../loader/errors.js'
import { loaderEngineFactory } from '../loader/engine.js'
import type { Engine, EngineCreateOptions, EngineProject, LoadedModule } from '../types.js'
import { createDenoCliEngine, decodeDataUrl } from './engine.js'
import { clearDenoProbes } from './process.js'

const JSR_PATH = 'https://jsr.io/@std/path/1.1.6/mod.ts'
const STD_COLORS = 'https://deno.land/std@0.224.0/fmt/colors.ts'
const skip = denoBinary.skipReason

interface RecordingLogger extends Logger {
  readonly lines: string[]
}

function recordingLogger(): RecordingLogger {
  const lines: string[] = []
  return {
    lines,
    debugEnabled: true,
    error: (message) => lines.push(`error ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    info: (message) => lines.push(`info ${message}`),
    debug: (message) => lines.push(`debug ${message}`),
    downloading: (url) => lines.push(`download ${url}`),
  }
}

function projectOf(
  root: string,
  nodeModulesDir: EngineProject['nodeModulesDir'] = 'none',
): EngineProject {
  const configPath = join(root, 'deno.json')
  const lockfilePath = join(root, 'deno.lock')
  return {
    root,
    workspaceRoot: root,
    configPath: existsSync(configPath) ? configPath : undefined,
    lockfilePath: existsSync(lockfilePath) ? lockfilePath : undefined,
    nodeModulesDir,
  }
}

function options(
  project: EngineProject,
  overrides: Partial<EngineCreateOptions> = {},
): EngineCreateOptions {
  return {
    project,
    platform: 'browser',
    conditions: [],
    cachedOnly: false,
    logger: createSilentLogger(),
    denoBinary: denoBinary.binary,
    ...overrides,
  }
}

async function engineFor(project: EngineProject, overrides: Partial<EngineCreateOptions> = {}) {
  vi.stubEnv('DENO_DIR', await denoDir())
  return createDenoCliEngine(options(project, overrides))
}

async function rejection(run: () => unknown): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected an error')
}

function expectCode(error: unknown, code: ErrorCode): void {
  expect(isDenoPluginError(error)).toBe(true)
  expect(error).toMatchObject({ code })
}

function asModule(loaded: Awaited<ReturnType<Engine['load']>>): LoadedModule {
  if (loaded.kind !== 'module') throw new Error(`expected a module, got ${loaded.kind}`)
  return loaded
}

/** How many `deno info` runs a recording logger saw. */
function infoRuns(logger: RecordingLogger): number {
  return logger.lines.filter((line) => line.startsWith('debug [engine] deno info:')).length
}

let evaluatedModules = 0

/**
 * What an import-free module exports, evaluated from a file in `dir` (Bun refuses long `data:`
 * imports): values as they are, functions by what calling them without arguments returns or
 * throws.
 */
async function exportsOf(code: string, dir: string): Promise<Record<string, unknown>> {
  const file = join(dir, `module-${++evaluatedModules}.mjs`)
  await writeFile(file, code)
  const namespace = (await import(toFileUrl(file))) as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(namespace)) {
    if (typeof value !== 'function') {
      result[name] = value
      continue
    }
    try {
      result[name] = { returns: (value as () => unknown)() }
    } catch (error) {
      result[name] = { throws: error instanceof Error ? `${error.name}: ${error.message}` : error }
    }
  }
  return result
}

/** {@link decodeDataUrl} as text. */
function decode(url: string): string | undefined {
  const bytes = decodeDataUrl(url)
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
}

describe('decodeDataUrl', () => {
  it('decodes percent-encoded and base64 data, without the fragment', () => {
    expect(decode('data:text/javascript,export default 42')).toBe('export default 42')
    expect(decode('data:text/javascript,a%20b%zz')).toBe('a b%zz')
    expect(decode(`data:text/plain;base64,${btoa('hello')}`)).toBe('hello')
    expect(decode('data:text/plain,a#fragment')).toBe('a')
    expect(decode('data:text/plain;base64,***')).toBeUndefined()
    expect(decode('data:no-comma')).toBeUndefined()
  })
})

describe.skipIf(skip !== undefined)(
  `deno engine${skip === undefined ? '' : ` (skipped: ${skip})`}`,
  () => {
    describe('Deno features the vendored loader lacks', () => {
      it(
        'resolves catalog: versions of deno.json imports and package.json dependencies',
        {
          timeout: 120_000,
        },
        async () => {
          await using temp = await tempProject('engine-cli-catalog')
          const expected = temp.manifest.expect as { packageDirs: Record<string, string> }
          const lockfile = await readFile(temp.path('deno.lock'), 'utf8')
          await using engine = await engineFor(projectOf(temp.root, 'auto'))
          const main = temp.url('src/main.ts')
          expect(await engine.addEntrypoints([main])).toEqual([])
          const kleur = await engine.resolve('kleur', main, 'import')
          expect(kleur).toMatchObject({
            kind: 'npm',
            path: temp.path(expected.packageDirs.kleur ?? '', 'index.mjs'),
            npm: { name: 'kleur', version: '4.1.5', subpath: '' },
          })
          const colors = await engine.resolve('kleur/colors', main, 'import')
          expect(colors.path).toBe(temp.path(expected.packageDirs.kleur ?? '', 'colors.mjs'))
          const esmEnv = await engine.resolve('esm-env/browser', main, 'import')
          expect(esmEnv).toMatchObject({
            kind: 'npm',
            path: temp.path(expected.packageDirs['esm-env'] ?? '', 'true.js'),
            npm: { name: 'esm-env', version: '1.2.2', subpath: '/browser' },
          })
          // Deno read the lockfile but wrote only its private copy.
          expect(await readFile(temp.path('deno.lock'), 'utf8')).toBe(lockfile)
          // The vendored loader cannot install the package.json catalog dependency.
          await using temp2 = await tempProject('engine-cli-catalog')
          vi.stubEnv('DENO_DIR', await denoDir())
          await using loader = await loaderEngineFactory.create(
            options(projectOf(temp2.root, 'auto')),
          )
          const loaderDiagnostics = await loader.addEntrypoints([temp2.url('src/main.ts')])
          expect(loaderDiagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(
            'catalog',
          )
        },
      )

      it('resolves packages linked through a links glob', { timeout: 60_000 }, async () => {
        await using temp = await tempProject('engine-cli-link-globs')
        const expected = temp.manifest.expect as { resolve: Record<string, string> }
        await using engine = await engineFor(projectOf(temp.root))
        const main = temp.url('src/main.ts')
        expect(await engine.addEntrypoints([main])).toEqual([])
        for (const [specifier, file] of Object.entries(expected.resolve)) {
          expect(await engine.resolve(specifier, main, 'import')).toEqual({
            kind: 'local',
            url: temp.url(file),
            path: temp.path(file),
            mediaType: 'TypeScript',
          })
        }
        // A linked package the entrypoint does not import resolves too.
        expect((await engine.resolve('jsr:@fixture/greet@1.2.0', main, 'import')).path).toBe(
          temp.path('libs/greet/mod.ts'),
        )
        // The vendored loader rejects the configuration.
        vi.stubEnv('DENO_DIR', await denoDir())
        expectCode(
          await rejection(() => loaderEngineFactory.create(options(projectOf(temp.root)))),
          'CONFIG_INVALID',
        )
      })
    })

    describe('engine-basic', () => {
      let temp: TempProject
      let engine: Engine
      let logger: RecordingLogger
      let main: string
      let diagnostics: unknown

      beforeAll(async () => {
        temp = await tempProject('engine-basic')
        logger = recordingLogger()
        engine = await engineFor(projectOf(temp.root), { logger })
        main = temp.url('src/main.ts')
        diagnostics = await engine.addEntrypoints([main])
      }, 120_000)

      afterAll(async () => {
        await engine?.dispose()
        await temp?.dispose()
      })

      it('resolves concurrent cache misses with one deno info run', async () => {
        expect(diagnostics).toEqual([])
        const before = infoRuns(logger)
        const specifiers = [
          ...['basename', 'dirname', 'extname', 'join', 'normalize', 'relative', 'resolve'].map(
            (name) => `jsr:@std/path@^1/${name}`,
          ),
          ...['posix', 'windows', 'common', 'format', 'parse'].map((name) => `@std/path/${name}`),
          'kleur/colors',
          'fs',
          'node:path',
          './util',
        ]
        const results = await Promise.all(
          specifiers.map((specifier) => engine.resolve(specifier, main, 'import')),
        )
        expect(results.every((result) => result.kind !== 'external')).toBe(true)
        expect(infoRuns(logger) - before).toBe(1)
        // Answered from the graph afterwards.
        for (const specifier of specifiers) {
          expect(engine.resolveSync?.(specifier, main, 'import')).toEqual(
            results[specifiers.indexOf(specifier)],
          )
        }
      })

      it('accepts entrypoints as URLs, absolute paths, root-relative paths and mapped specifiers', async () => {
        const entries = ['./src/util.ts', 'src/main.ts', temp.path('src/util.ts'), '@std/path']
        expect(await engine.addEntrypoints(entries)).toEqual([])
        const roots = (engine.graph() as { roots: string[] }).roots
        expect(roots).toEqual(expect.arrayContaining([main, temp.url('src/util.ts'), JSR_PATH]))
        expect(await engine.addEntrypoints([])).toEqual([])
      })

      it('accepts OS paths as referrers and resolves from data: importers against the root', async () => {
        expect((await engine.resolve('./util.ts', temp.path('src/main.ts'), 'import')).path).toBe(
          temp.path('src/util.ts'),
        )
        const importer = 'data:text/javascript,import "@std/path"'
        expect((await engine.resolve('@std/path', importer, 'import')).url).toBe(JSR_PATH)
        for (const specifier of ['./x.ts', '/x.ts']) {
          const error = await rejection(() => engine.resolve(specifier, importer, 'import'))
          expectCode(error, 'RESOLVE_FAILED')
          expect(error).toMatchObject({ hint: HINTS.relativeFromNonHierarchical, importer })
        }
      })

      it('sees new imports of an edited local file', async () => {
        await writeFile(temp.path('src/extra.ts'), 'import "npm:kleur@4.1.5/colors"\n')
        const extra = temp.url('src/extra.ts')
        expect((await engine.resolve('./util.ts', extra, 'import')).kind).toBe('local')
        await writeFile(temp.path('src/extra.ts'), 'import "@std/path/join"\n')
        expect((await engine.resolve('@std/path/join', extra, 'import')).url).toBe(
          'https://jsr.io/@std/path/1.1.6/join.ts',
        )
      })

      it('loads remote modules that are not in the graph yet, and raw contents', async () => {
        const bytes = 'https://deno.land/std@0.224.0/fmt/bytes.ts'
        const loaded = asModule(await engine.load(bytes, 'default'))
        expect(loaded).toMatchObject({ url: bytes, mediaType: 'TypeScript' })
        expect(loaded.code).toContain('export function format(')
        expect(loaded.map?.sources).toEqual([bytes])
        const raw = asModule(await engine.load(bytes, 'bytes'))
        expect(new TextDecoder().decode(raw.bytes)).toContain('options: FormatOptions = {}')
        expect(raw.map).toBeUndefined()
        const meta = asModule(await engine.load('https://jsr.io/@std/path/1.1.6_meta.json', 'json'))
        expect(meta.mediaType).toBe('Json')
        expect(JSON.parse(meta.code)).toHaveProperty('exports')
      })

      it('transpiles the dependencies of a loaded module in the same deno transpile run', async () => {
        const lines = logger.lines.length
        await engine.load(JSR_PATH, 'default')
        const runs = logger.lines
          .slice(lines)
          .filter((line) => line.startsWith('debug [engine] deno transpile:'))
        expect(runs).toHaveLength(1)
        expect(runs[0]).toMatch(/: [1-9]\d+ module\(s\)/)
        const before = logger.lines.length
        await engine.load('https://jsr.io/@std/path/1.1.6/join.ts', 'default')
        expect(
          logger.lines
            .slice(before)
            .some((line) => line.startsWith('debug [engine] deno transpile:')),
        ).toBe(false)
      })

      it('loads JSR modules that behave like the loader’s', async () => {
        await using loader = await loaderEngineFactory.create(options(projectOf(temp.root)))
        await using scratch = await tempDir()
        // Modules without imports, so they evaluate on their own.
        for (const url of [
          'https://jsr.io/@std/path/1.1.6/_common/constants.ts',
          'https://jsr.io/@std/path/1.1.6/_common/assert_path.ts',
        ]) {
          const [ours, theirs] = [
            asModule(await engine.load(url, 'default')),
            asModule(await loader.load(url, 'default')),
          ]
          expect(ours.map?.sources).toEqual(theirs.map?.sources)
          expect(ours.map?.sourcesContent).toEqual(theirs.map?.sourcesContent)
          expect(await exportsOf(ours.code, scratch.root)).toEqual(
            await exportsOf(theirs.code, scratch.root),
          )
        }
      })

      it('loads data: TypeScript as JavaScript that evaluates', async () => {
        const loaded = asModule(
          await engine.load(
            'data:application/typescript,export const x: number = 21 * 2',
            'default',
          ),
        )
        expect(loaded.mediaType).toBe('TypeScript')
        const evaluated = (await import(
          `data:text/javascript;base64,${Buffer.from(loaded.code).toString('base64')}`
        )) as { x: number }
        expect(evaluated.x).toBe(42)
      })

      it('reports syntax errors of one module without failing the others', async () => {
        const [broken, fine] = await Promise.allSettled([
          engine.load('data:application/typescript,export const x: = 1', 'default'),
          engine.load('data:application/typescript,export const y: number = 2', 'default'),
        ])
        expect(broken.status).toBe('rejected')
        expectCode(broken.status === 'rejected' ? broken.reason : undefined, 'RESOLVE_FAILED')
        expect(fine.status === 'fulfilled' && asModule(fine.value).code).toContain(
          'export const y = 2',
        )
      })

      it('keeps working after failures, and rejects work once disposed', async () => {
        expectCode(
          await rejection(() => engine.resolve('not-in-the-import-map', main, 'import')),
          'RESOLVE_UNMAPPED_BARE',
        )
        expect((await engine.resolve('@std/path', main, 'import')).url).toBe(JSR_PATH)
        await using disposable = await engineFor(projectOf(temp.root))
        const pending = disposable.resolve('jsr:@std/path@1.1.6/basename', main, 'import')
        const disposal = disposable.dispose()
        expect(disposable.dispose()).toBe(disposal)
        expect((await pending).url).toBe('https://jsr.io/@std/path/1.1.6/basename.ts')
        await disposal
        expectCode(
          await rejection(() => disposable.resolve('fs', main, 'import')),
          'ENGINE_UNAVAILABLE',
        )
        expectCode(
          await rejection(() => disposable.load(JSR_PATH, 'default')),
          'ENGINE_UNAVAILABLE',
        )
      })
    })

    describe('cachedOnly', () => {
      it('never downloads and reports cache misses', { timeout: 60_000 }, async () => {
        const cache = await freshDenoDir()
        onTestFinished(() => cache.dispose())
        await using temp = await tempProject('engine-basic')
        vi.stubEnv('DENO_DIR', cache.path)
        await using engine = await createDenoCliEngine(
          options(projectOf(temp.root), { cachedOnly: true }),
        )
        const main = temp.url('src/main.ts')
        const diagnostics = await engine.addEntrypoints([main])
        expect(diagnostics.at(-1)).toMatchObject({
          code: 'CACHED_ONLY_MISS',
          message: expect.stringContaining(HINTS.cachedOnly),
        })
        for (const specifier of [
          'kleur',
          'npm:esm-env@1.2.2',
          '@std/path',
          'jsr:@std/fmt@1.0.8/colors',
        ]) {
          expectCode(
            await rejection(() => engine.resolve(specifier, main, 'import')),
            'CACHED_ONLY_MISS',
          )
        }
        expectCode(await rejection(() => engine.load(STD_COLORS, 'default')), 'CACHED_ONLY_MISS')
        // Failures unrelated to the cache keep their codes.
        expectCode(
          await rejection(() => engine.resolve('not-in-the-import-map', main, 'import')),
          'RESOLVE_UNMAPPED_BARE',
        )
        // Nothing was downloaded.
        const remote = join(cache.path, 'remote')
        expect(existsSync(remote) ? readdirSync(remote, { recursive: true }) : []).toEqual([])
      })

      it('serves everything from a warm cache', { timeout: 120_000 }, async () => {
        await using temp = await tempProject('engine-basic')
        {
          await using warm = await engineFor(projectOf(temp.root))
          await warm.addEntrypoints([temp.url('src/main.ts')])
        }
        await using engine = await engineFor(projectOf(temp.root), { cachedOnly: true })
        const main = temp.url('src/main.ts')
        expect(await engine.addEntrypoints([main])).toEqual([])
        expect((await engine.resolve('@std/path', main, 'import')).url).toBe(JSR_PATH)
        expect((await engine.resolve('kleur', main, 'import')).kind).toBe('npm')
        expect(asModule(await engine.load(STD_COLORS, 'default')).code).toContain(
          'export function bold(',
        )
      })
    })

    describe('errors', () => {
      it(
        'reports a module that does not match deno.lock as INTEGRITY_MISMATCH',
        {
          timeout: 60_000,
        },
        async () => {
          await using temp = await tempProject('engine-basic')
          const lockfile = await readFile(temp.path('deno.lock'), 'utf8')
          await writeFile(
            temp.path('deno.lock'),
            lockfile.replace(
              /"(https:\/\/deno\.land\/[^"]+)": "[0-9a-f]+"/,
              `"$1": "${'0'.repeat(64)}"`,
            ),
          )
          await using engine = await engineFor(projectOf(temp.root))
          const diagnostics = await engine.addEntrypoints([temp.url('src/main.ts')])
          expect(diagnostics).toEqual([
            {
              code: 'INTEGRITY_MISMATCH',
              message: expect.stringContaining('https://deno.land/std@0.224.0/fmt/colors.ts'),
            },
          ])
        },
      )

      it.skipIf(process.platform === 'win32')(
        'reports deno info output it does not understand as ENGINE_UNAVAILABLE',
        async () => {
          await using temp = await tempDir({ 'src/main.ts': 'export {}\n' })
          const fake = temp.path('fake-deno')
          await writeFile(
            fake,
            [
              '#!/bin/sh',
              'if [ "$1" = "--version" ]; then echo "deno 2.9.7 (stable, release, test)"; exit 0; fi',
              'if [ "$3" = "--no-config" ] && [ "$#" = 3 ]; then echo "{}"; exit 0; fi',
              'echo \'{"version":2,"roots":[],"modules":[]}\'',
              '',
            ].join('\n'),
          )
          await chmod(fake, 0o755)
          clearDenoProbes()
          await using engine = await createDenoCliEngine(
            options(projectOf(temp.root), { denoBinary: fake }),
          )
          const [diagnostic] = await engine.addEntrypoints([temp.url('src/main.ts')])
          expect(diagnostic).toMatchObject({
            code: 'ENGINE_UNAVAILABLE',
            message: expect.stringMatching(/Deno 2\.9\.7 printed .*unsupported "version" 2/),
          })
          expectCode(
            await rejection(() => engine.resolve('jsr:@std/path@1', undefined, 'import')),
            'ENGINE_UNAVAILABLE',
          )
        },
      )
    })

    describe('npm packages', () => {
      it(
        'describes a cached package it has not seen before when resolving its imports',
        {
          timeout: 120_000,
        },
        async () => {
          await using temp = await tempProject('engine-npm-dependencies')
          const main = temp.url('src/main.ts')
          let common: string
          {
            await using seed = await engineFor(projectOf(temp.root))
            common = (
              await seed.resolve(
                './common',
                (await seed.resolve('debug', main, 'import')).url,
                'require',
              )
            ).url
          }
          const logger = recordingLogger()
          await using engine = await engineFor(projectOf(temp.root), { logger })
          const ms = await engine.resolve('ms', common, 'require')
          expect(ms).toMatchObject({ kind: 'npm', npm: { name: 'ms', version: '2.1.3' } })
          expect(infoRuns(logger)).toBe(1)
        },
      )

      it('resolves node_modules packages with the engine platform (nodeModulesDir "manual")', async () => {
        await using temp = await tempDir({
          'deno.json': { nodeModulesDir: 'manual' },
          'package.json': { name: 'app', private: true, dependencies: { 'cond-pkg': '*' } },
          'node_modules/cond-pkg/package.json': {
            name: 'cond-pkg',
            version: '1.0.0',
            exports: {
              '.': { browser: './browser.js', node: './node.js', default: './default.js' },
              './feature': { browser: './feature-browser.js', default: './feature.js' },
            },
          },
          'node_modules/cond-pkg/browser.js': 'export default "browser"\n',
          'node_modules/cond-pkg/node.js': 'export default "node"\n',
          'node_modules/cond-pkg/default.js': 'export default "default"\n',
          'node_modules/cond-pkg/feature-browser.js': 'export default 1\n',
          'node_modules/cond-pkg/feature.js': 'export default 2\n',
          'src/main.ts': 'import value from "cond-pkg"\nexport default value\n',
        })
        const main = temp.url('src/main.ts')
        for (const [platform, file, feature] of [
          ['browser', 'browser.js', 'feature-browser.js'],
          ['node', 'node.js', 'feature.js'],
        ] as const) {
          await using engine = await engineFor(projectOf(temp.root, 'manual'), { platform })
          expect(await engine.addEntrypoints([main])).toEqual([])
          expect(await engine.resolve('cond-pkg', main, 'import')).toMatchObject({
            kind: 'npm',
            path: temp.path('node_modules/cond-pkg', file),
            npm: { name: 'cond-pkg', version: '1.0.0', subpath: '' },
          })
          expect((await engine.resolve('npm:cond-pkg@1/feature', main, 'import')).path).toBe(
            temp.path('node_modules/cond-pkg', feature),
          )
        }
      })
    })

    describe('JSX', () => {
      it('transpiles remote TSX with the project compilerOptions', async () => {
        await using temp = await tempDir({
          'deno.json': { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'npm:preact@10' } },
        })
        await using engine = await engineFor(projectOf(temp.root))
        const loaded = asModule(
          await engine.load('data:text/tsx,export const a = <b>hi</b>', 'default'),
        )
        expect(normalize(loaded.code)).toContain('from "npm:preact@10/jsx-runtime"')
      })
    })
  },
)
