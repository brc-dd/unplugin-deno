import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir, freshDenoDir } from '../../../test/helpers/deno-dir.js'
import type { TempProject } from '../../../test/helpers/temp-project.js'
import { tempProject } from '../../../test/helpers/temp-project.js'
import type { ErrorCode } from '../../diagnostics/errors.js'
import { isDenoPluginError } from '../../diagnostics/errors.js'
import type { Logger } from '../../diagnostics/logger.js'
import type { Engine, EngineCreateOptions, EngineProject, LoadedModule } from '../types.js'
import {
  createLoaderEngine,
  loaderWorkspaceOptions,
  parseSourceMap,
  stripInlineSourceMap,
  toWasmWorkspaceOptions,
} from './engine.js'
import { HINTS } from './errors.js'
import { attachedEngineCount } from './hooks.js'

const JSR_PATH = 'https://jsr.io/@std/path/1.1.6/mod.ts'
const STD_COLORS = 'https://deno.land/std@0.224.0/fmt/colors.ts'
const encoder = new TextEncoder()

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
  temp: TempProject,
  nodeModulesDir: EngineProject['nodeModulesDir'] = 'none',
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

function options(
  project: EngineProject,
  overrides: Partial<EngineCreateOptions> = {},
): EngineCreateOptions {
  return {
    project,
    platform: 'browser',
    conditions: [],
    cachedOnly: false,
    logger: recordingLogger(),
    ...overrides,
  }
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

/** A fetch that serves `files` (URL → [content type, body]) and records every request. */
function servingFetch(files: Record<string, [string, string]>, delayMs = 0) {
  return vi.fn<typeof fetch>(async (input) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    const file = files[String(input)]
    if (file === undefined) return new Response('not found', { status: 404 })
    return new Response(file[1], { headers: { 'content-type': file[0] } })
  })
}

describe('loaderWorkspaceOptions', () => {
  const project: EngineProject = {
    root: '/p',
    workspaceRoot: '/p',
    configPath: '/p/deno.json',
    lockfilePath: '/p/deno.lock',
    nodeModulesDir: 'none',
  }

  it('always passes configPath and asks for transpiled output', () => {
    const conditions = ['development']
    const workspace = loaderWorkspaceOptions(options(project, { conditions }))
    expect(workspace).toEqual({
      configPath: '/p/deno.json',
      noLock: false,
      platform: 'browser',
      nodeConditions: ['development'],
      cachedOnly: false,
      preserveJsx: false,
      noTranspile: false,
    })
    expect(workspace.nodeConditions).not.toBe(conditions)
  })

  it('disables config discovery and the lockfile when the project has none', () => {
    const newestDependencyDate = new Date('2026-01-01T00:00:00Z')
    expect(
      loaderWorkspaceOptions(
        options(
          { ...project, configPath: undefined, lockfilePath: undefined },
          { platform: 'node', cachedOnly: true, newestDependencyDate },
        ),
      ),
    ).toEqual({
      noConfig: true,
      noLock: true,
      platform: 'node',
      nodeConditions: [],
      cachedOnly: true,
      newestDependencyDate,
      preserveJsx: false,
      noTranspile: false,
    })
  })
})

describe('toWasmWorkspaceOptions', () => {
  it('passes newestDependencyDate as an RFC 3339 string, the form the wasm accepts', () => {
    const date = new Date('2026-01-01T00:00:00Z')
    expect(toWasmWorkspaceOptions({ platform: 'node', newestDependencyDate: date })).toEqual({
      platform: 'node',
      newestDependencyDate: '2026-01-01T00:00:00.000Z',
    })
    const without = { platform: 'browser' as const }
    expect(toWasmWorkspaceOptions(without)).toBe(without)
  })

  it('lets the loader create a workspace with a minimum dependency age', async () => {
    const temp = await tempProject('engine-basic')
    onTestFinished(() => temp.dispose())
    vi.stubEnv('DENO_DIR', await denoDir())
    const engine = await createLoaderEngine(
      options(projectOf(temp), { newestDependencyDate: new Date('2026-01-01T00:00:00Z') }),
    )
    onTestFinished(() => engine.dispose())
    expect(engine.kind).toBe('loader')
  })
})

describe('stripInlineSourceMap', () => {
  it.each<[string, string]>([
    ['a;\n//# sourceMappingURL=data:application/json;base64,eyJ9', 'a;\n'],
    ['a;\n//# sourceMappingURL=data:application/json;base64,eyJ9\n', 'a;\n'],
    ['//# sourceMappingURL=data:application/json;base64,eyJ9', ''],
    ['a;\n', 'a;\n'],
    ['a;\n//# sourceMappingURL=a.js.map', 'a;\n//# sourceMappingURL=a.js.map'],
    ['a; //# sourceMappingURL=data:x', 'a; //# sourceMappingURL=data:x'],
    ['//# sourceMappingURL=data:x\nb;\n', '//# sourceMappingURL=data:x\nb;\n'],
  ])('%j', (code, expected) => {
    expect(stripInlineSourceMap(code)).toBe(expected)
  })
})

describe('parseSourceMap', () => {
  it('accepts encoded version 3 maps only', () => {
    const map = { version: 3, sources: ['https://x.test/a.ts'], names: [], mappings: 'AAAA' }
    expect(parseSourceMap(encoder.encode(JSON.stringify(map)))).toEqual(map)
    expect(parseSourceMap(encoder.encode('{'))).toBeUndefined()
    expect(parseSourceMap(encoder.encode('null'))).toBeUndefined()
    expect(parseSourceMap(encoder.encode(JSON.stringify({ ...map, version: 2 })))).toBeUndefined()
    expect(parseSourceMap(encoder.encode(JSON.stringify({ ...map, mappings: [] })))).toBeUndefined()
    expect(
      parseSourceMap(encoder.encode(JSON.stringify({ ...map, names: undefined }))),
    ).toBeUndefined()
  })
})

describe('createLoaderEngine', () => {
  it('logs the engine setup and detaches from the hooks on dispose', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    await using temp = await tempProject('engine-no-config')
    const before = attachedEngineCount()
    const logger = recordingLogger()
    const engine = await createLoaderEngine(options(projectOf(temp), { logger, conditions: ['x'] }))
    expect(engine.kind).toBe('loader')
    expect(attachedEngineCount()).toBe(before + 1)
    expect(logger.lines).toEqual([
      expect.stringMatching(
        /^debug \[engine\] loader engine for .+ \(no deno\.json\): platform browser \+ x, nodeModulesDir none, lockfile none, DENO_DIR .+ \(\d+ ms\)$/,
      ),
    ])
    const disposal = engine.dispose()
    expect(engine.dispose()).toBe(disposal)
    await disposal
    await engine[Symbol.asyncDispose]()
    expect(attachedEngineCount()).toBe(before)
  })

  it('rejects an invalid deno.json with CONFIG_INVALID', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    await using temp = await tempProject('engine-no-config')
    await writeFile(temp.path('deno.json'), '{ "imports": ')
    const before = attachedEngineCount()
    const error = await rejection(() => createLoaderEngine(options(projectOf(temp))))
    expectCode(error, 'CONFIG_INVALID')
    expect((error as Error).message).toContain('deno.json')
    expect(attachedEngineCount()).toBe(before)
  })
})

describe('a disposed engine', () => {
  it('refuses every operation with ENGINE_UNAVAILABLE', async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    await using temp = await tempProject('engine-no-config')
    const engine = await createLoaderEngine(options(projectOf(temp)))
    await engine.dispose()
    const main = temp.url('src/main.ts')
    const errors = [
      await rejection(() => engine.resolve('./x.ts', main, 'import')),
      await rejection(() => engine.resolveSync?.('./x.ts', main, 'import')),
      await rejection(() => engine.load(main, 'default')),
      await rejection(() => engine.addEntrypoints([main])),
      await rejection(() => engine.graph()),
    ]
    expect(errors.map((error) => isDenoPluginError(error) && error.code)).toEqual(
      Array(errors.length).fill('ENGINE_UNAVAILABLE'),
    )
  })

  it('waits for pending operations before releasing the loader', async () => {
    const cache = await freshDenoDir()
    onTestFinished(() => cache.dispose())
    vi.stubEnv('DENO_DIR', cache.path)
    await using temp = await tempProject('engine-no-config')
    const url = 'https://example.test/slow.ts'
    const fetch = servingFetch(
      { [url]: ['application/typescript', 'export const slow: number = 1\n'] },
      100,
    )
    const engine = await createLoaderEngine(options(projectOf(temp), { fetch }))
    const events: string[] = []
    const adding = engine.addEntrypoints([url]).then((diagnostics) => {
      events.push('added')
      return diagnostics
    })
    const disposing = engine.dispose().then(() => events.push('disposed'))
    expect(await adding).toEqual([])
    await disposing
    expect(events).toEqual(['added', 'disposed'])
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('downloads', () => {
  it('go through the injected fetch and are reported to the logger', async () => {
    const cache = await freshDenoDir()
    onTestFinished(() => cache.dispose())
    vi.stubEnv('DENO_DIR', cache.path)
    await using temp = await tempProject('engine-no-config')
    const mod = 'https://example.test/lib/mod.ts'
    const dep = 'https://example.test/lib/dep'
    const fetch = servingFetch({
      [mod]: [
        'application/typescript',
        'import { dep } from "./dep"\nexport const value: number = dep * 2\n',
      ],
      [dep]: ['text/javascript', 'export const dep = 21\n'],
    })
    const logger = recordingLogger()
    await using engine = await createLoaderEngine(options(projectOf(temp), { fetch, logger }))
    expect(await engine.addEntrypoints([mod])).toEqual([])
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([mod, dep])
    expect(logger.lines).toEqual(expect.arrayContaining([`download ${mod}`, `download ${dep}`]))

    const loaded = asModule(await engine.load(mod, 'default'))
    expect(loaded.mediaType).toBe('TypeScript')
    expect(loaded.code).toContain('export const value = dep * 2')
    expect(loaded.map?.sources).toEqual([mod])
    // Without an extension, resolution cannot know the media type; loading reads the header.
    expect(await engine.resolve('./dep', mod, 'import')).toEqual({
      kind: 'remote',
      url: dep,
      mediaType: 'Unknown',
    })
    expect(asModule(await engine.load(dep, 'default'))).toMatchObject({
      mediaType: 'JavaScript',
      code: 'export const dep = 21\n',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('npm registry failures', () => {
  it('explain unsatisfiable constraints and unknown packages from the graph', async () => {
    // Deno fetches the package document again when no cached version matches, so the registry is
    // stubbed (with a fresh cache, which the stub would otherwise overwrite).
    const cache = await freshDenoDir()
    onTestFinished(() => cache.dispose())
    vi.stubEnv('DENO_DIR', cache.path)
    await using temp = await tempProject('engine-no-config')
    const packument = {
      name: 'kleur',
      'dist-tags': { latest: '4.1.5' },
      versions: {
        '4.1.5': {
          name: 'kleur',
          version: '4.1.5',
          dist: { tarball: 'https://registry.npmjs.org/kleur/-/kleur-4.1.5.tgz' },
        },
      },
    }
    const registry = servingFetch({
      'https://registry.npmjs.org/kleur': ['application/json', JSON.stringify(packument)],
    })
    await using engine = await createLoaderEngine(options(projectOf(temp), { fetch: registry }))
    const constraint = await rejection(() => engine.resolve('npm:kleur@^99', undefined, 'import'))
    expectCode(constraint, 'RESOLVE_CONSTRAINT')
    expect(constraint).toMatchObject({ hint: HINTS.constraint })
    expect((constraint as Error).message).toBe(
      `Cannot resolve "npm:kleur@^99": Could not find npm package 'kleur' matching '^99'.`,
    )
    const unknown = await rejection(() =>
      engine.resolve('npm:not-a-published-package@1', undefined, 'import'),
    )
    expectCode(unknown, 'RESOLVE_CONSTRAINT')
    expect(unknown).toMatchObject({
      message: expect.stringContaining("npm package 'not-a-published-package' does not exist."),
      hint: 'Check the package name and that it is published to the registry.',
    })
    expect(registry.mock.calls.map(([input]) => String(input))).toEqual([
      'https://registry.npmjs.org/kleur',
      'https://registry.npmjs.org/not-a-published-package',
    ])
  })
})

describe('redirects', () => {
  it('are followed by load, and by resolve once the module is in the graph', async () => {
    const cache = await freshDenoDir()
    onTestFinished(() => cache.dispose())
    vi.stubEnv('DENO_DIR', cache.path)
    await using temp = await tempProject('engine-no-config')
    const latest = 'https://example.test/lib@latest/mod.ts'
    const pinned = 'https://example.test/lib@1.0.0/mod.ts'
    const redirecting = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input) === latest) {
        return new Response(null, { status: 302, headers: { location: '/lib@1.0.0/mod.ts' } })
      }
      return new Response('export const version: string = "1.0.0"\n', {
        headers: { 'content-type': 'application/typescript' },
      })
    })
    await using engine = await createLoaderEngine(options(projectOf(temp), { fetch: redirecting }))
    // Not in the graph yet: resolution does not download, so the URL is returned as given.
    expect((await engine.resolve(latest, undefined, 'import')).url).toBe(latest)
    expect(asModule(await engine.load(latest, 'default')).url).toBe(pinned)
    expect(await engine.addEntrypoints([latest])).toEqual([])
    expect((await engine.resolve(latest, undefined, 'import')).url).toBe(pinned)
  })
})

describe('cachedOnly', () => {
  it('never downloads and reports cache misses', { timeout: 60_000 }, async () => {
    const cache = await freshDenoDir()
    onTestFinished(() => cache.dispose())
    vi.stubEnv('DENO_DIR', cache.path)
    await using temp = await tempProject('engine-basic')
    const fetch = servingFetch({})
    await using engine = await createLoaderEngine(
      options(projectOf(temp), { cachedOnly: true, fetch }),
    )
    const main = temp.url('src/main.ts')
    const diagnostics = await engine.addEntrypoints([main])
    expect(diagnostics.at(-1)).toMatchObject({
      code: 'CACHED_ONLY_MISS',
      message: expect.stringContaining(HINTS.cachedOnly),
    })
    // In the lockfile, not in the cache (the loader itself refuses npm downloads).
    expectCode(await rejection(() => engine.resolve('kleur', main, 'import')), 'CACHED_ONLY_MISS')
    // Not in the lockfile: no cached npm metadata.
    expectCode(
      await rejection(() => engine.resolve('npm:esm-env@1.2.2', main, 'import')),
      'CACHED_ONLY_MISS',
    )
    // Its package metadata download was refused while adding the entrypoint.
    expectCode(
      await rejection(() => engine.resolve('@std/path', main, 'import')),
      'CACHED_ONLY_MISS',
    )
    expectCode(
      await rejection(() => engine.resolve('jsr:@std/fmt@1.0.8/colors', main, 'import')),
      'CACHED_ONLY_MISS',
    )
    expectCode(await rejection(() => engine.load(STD_COLORS, 'default')), 'CACHED_ONLY_MISS')
    expectCode(
      await rejection(() => engine.load('https://deno.land/std@0.224.0/fmt/bytes.ts', 'default')),
      'CACHED_ONLY_MISS',
    )
    // Failures unrelated to the cache keep their codes.
    expectCode(
      await rejection(() => engine.resolve('not-in-the-import-map', main, 'import')),
      'RESOLVE_UNMAPPED_BARE',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serves everything from a warm cache', { timeout: 120_000 }, async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    await using temp = await tempProject('engine-basic')
    {
      // Warm the shared cache first (a no-op when other tests already did).
      await using warm = await createLoaderEngine(options(projectOf(temp)))
      await warm.addEntrypoints([temp.url('src/main.ts')])
    }
    const fetch = servingFetch({})
    await using engine = await createLoaderEngine(
      options(projectOf(temp), { cachedOnly: true, fetch }),
    )
    const main = temp.url('src/main.ts')
    expect(await engine.addEntrypoints([main])).toEqual([])
    expect((await engine.resolve('@std/path', main, 'import')).url).toBe(JSR_PATH)
    expect((await engine.resolve('kleur', main, 'import')).kind).toBe('npm')
    expect(asModule(await engine.load(STD_COLORS, 'default')).code).toContain(
      'export function bold(',
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('referrers and entrypoints', () => {
  let temp: TempProject
  let engine: Engine
  let main: string

  beforeAll(async () => {
    vi.stubEnv('DENO_DIR', await denoDir())
    temp = await tempProject('engine-basic')
    engine = await createLoaderEngine(options(projectOf(temp)))
    main = temp.url('src/main.ts')
  }, 120_000)

  afterAll(async () => {
    await engine?.dispose()
    await temp?.dispose()
  })

  it('accepts entrypoints as URLs, absolute paths, root-relative paths and mapped specifiers', async () => {
    const entries = ['./src/util.ts', 'src/main.ts', temp.path('src/util.ts'), '@std/path']
    expect(await engine.addEntrypoints(entries)).toEqual([])
    const roots = (engine.graph() as { roots: string[] }).roots
    expect(roots).toEqual(expect.arrayContaining([main, temp.url('src/util.ts')]))
    expect(await engine.addEntrypoints([])).toEqual([])
  })

  it('accepts OS paths as referrers', async () => {
    expect((await engine.resolve('./util.ts', temp.path('src/main.ts'), 'import')).path).toBe(
      temp.path('src/util.ts'),
    )
    expect((await engine.resolve('./util.ts', 'src/main.ts', 'import')).path).toBe(
      temp.path('src/util.ts'),
    )
  })

  it('resolves non-relative specifiers from data: importers against the project root', async () => {
    const importer = 'data:text/javascript,import "@std/path"'
    expect((await engine.resolve('@std/path', importer, 'import')).url).toBe(JSR_PATH)
    expect((await engine.resolve('node:fs', importer, 'import')).kind).toBe('node')
    for (const specifier of ['./x.ts', '../x.ts', '/x.ts']) {
      const error = await rejection(() => engine.resolve(specifier, importer, 'import'))
      expectCode(error, 'RESOLVE_FAILED')
      expect(error).toMatchObject({ hint: HINTS.relativeFromNonHierarchical, importer })
    }
    expectCode(
      await rejection(() => engine.resolve('./x.ts', 'npm:kleur@^4', 'import')),
      'RESOLVE_FAILED',
    )
  })

  it('routes the npm install lines of nodeModulesDir "auto" to the debug log', async () => {
    await using auto = await tempProject('engine-node-modules-auto')
    const logger = recordingLogger()
    await using autoEngine = await createLoaderEngine(options(projectOf(auto, 'auto'), { logger }))
    expect(await autoEngine.addEntrypoints([auto.url('src/main.ts')])).toEqual([])
    expect(logger.lines).toContain('debug [engine] Initialize kleur@4.1.5')
  })

  it('keeps working after a failed resolution', async () => {
    expectCode(
      await rejection(() => engine.resolve('not-in-the-import-map', main, 'import')),
      'RESOLVE_UNMAPPED_BARE',
    )
    expect((await engine.resolve('@std/path', main, 'import')).url).toBe(JSR_PATH)
    await mkdir(temp.path('src/extra'), { recursive: true })
    await writeFile(temp.path('src/extra/x.ts'), 'export const x = 1\n')
    expect((await engine.resolve('./extra/x.ts', main, 'import')).kind).toBe('local')
  })
})
