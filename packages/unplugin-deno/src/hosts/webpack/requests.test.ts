import { existsSync } from 'node:fs'
import { utimes, writeFile } from 'node:fs/promises'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import type { ResolveOutcome, ResolveRequest } from '../../core/resolve.js'
import type { PluginState } from '../../core/state.js'
import { DenoPluginError, isDenoPluginError } from '../../diagnostics/errors.js'
import type { MutableRequest, RouterHost } from './requests.js'
import {
  applyOutcome,
  buildHttpMatcher,
  CompilationLog,
  ConfigReloader,
  conditionNames,
  entryInput,
  loadLoader,
  mirrorLoad,
  platformHint,
  requestPath,
  Router,
  toHostError,
} from './requests.js'

/** A plugin state that answers `resolve` from `outcomes` and records the calls. */
function stubState(outcomes: Record<string, ResolveOutcome> = {}) {
  const calls: Array<{ id: string; importer: string | undefined; request: ResolveRequest }> = []
  const debug: string[] = []
  const state = {
    options: { importAttributes: true },
    ready: true,
    platform: 'browser',
    flavor: 'posix',
    resolveIdFilter: () => /^(?:jsr|npm|https?|data|node):|[?&]deno-type=|^@std\/path(?:[/?]|$)/,
    resolve: async (id: string, importer: string | undefined, request: ResolveRequest) => {
      calls.push({ id, importer, request })
      if (id === 'npm:broken') {
        throw new DenoPluginError('RESOLVE_NOT_FOUND', 'npm:broken does not exist.', {
          hint: 'Check the name.',
        })
      }
      return outcomes[id] ?? null
    },
    logger: { debug: (message: string) => debug.push(message) },
    watchFiles: () => ['/root/deno.json', '/root/deno.lock'],
  }
  return { state: state as unknown as PluginState, calls, debug }
}

const info = (request: string, issuer = '/root/src/main.ts') => ({
  request,
  context: '/root/src',
  issuer,
})

function host(
  resolved: Record<string, string | false> = {},
): RouterHost & { synthesised: string[]; dependencies: string[] } {
  const synthesised: string[] = []
  const dependencies: string[] = []
  return {
    synthesised,
    dependencies,
    resolve: async (context, request) => {
      const key = `${context}|${request}`
      if (!(key in resolved)) throw new Error(`Cannot resolve ${request} in ${context}`)
      return resolved[key] ?? false
    },
    synthetic: async (id) => {
      synthesised.push(id)
      return `unplugin-deno:${id}`
    },
    dependOn: (files) => {
      dependencies.push(...files)
    },
  }
}

describe('Router', () => {
  it('resolves owned requests in the externals function, once per attribute type', async () => {
    const { state, calls } = stubState({
      'jsr:@std/path': { type: 'mirror', path: '/root/mirror/mod.ts.js', url: 'https://jsr.io/x' },
      'https://x.test/a.txt?deno-type=text': {
        type: 'marker',
        path: '/root/mirror/a.txt?deno-type=text',
        denoType: 'text',
        sourceUrl: 'https://x.test/a.txt',
      },
    })
    const router = new Router(state, 'webpack')
    router.note(info('jsr:@std/path'), undefined)
    router.note(info('https://x.test/a.txt'), { type: 'text' })
    router.note(info('./local.ts'), undefined)
    expect(await router.external(info('jsr:@std/path'), 'esm')).toBeUndefined()
    expect(await router.external(info('https://x.test/a.txt'), 'esm')).toBeUndefined()
    expect(await router.external(info('./local.ts'), 'esm')).toBeUndefined()
    expect(calls.map((call) => call.id)).toEqual([
      'jsr:@std/path',
      'https://x.test/a.txt?deno-type=text',
    ])
    expect(calls[0]?.importer).toBe('/root/src/main.ts')
    // The importers of owned requests (rebuilt on Rspack after a config reload).
    expect([...router.importers]).toEqual(['/root/src/main.ts'])
    expect(calls[0]?.request).toMatchObject({ kind: 'import-statement', isEntry: false })
    // The resolve hook applies what the externals function resolved; the resolution depends
    // on the config files.
    const data: MutableRequest = { request: 'jsr:@std/path', context: '/root/src' }
    const resolving = host()
    await router.apply(data, '/root/src/main.ts', undefined, resolving)
    expect(data.request).toBe('/root/mirror/mod.ts.js')
    expect(resolving.dependencies).toEqual(['/root/deno.json', '/root/deno.lock'])
    // Requests the plugin did not resolve are left alone.
    const local: MutableRequest = { request: './local.ts', context: '/root/src' }
    const untouched = host()
    await router.apply(local, '/root/src/main.ts', undefined, untouched)
    expect(local.request).toBe('./local.ts')
    expect(untouched.dependencies).toEqual([])
    const marked: MutableRequest = { request: 'https://x.test/a.txt', context: '/root/src' }
    const synthetic = host()
    await router.apply(marked, '/root/src/main.ts', { type: 'text' }, synthetic)
    expect(synthetic.synthesised).toEqual(['/root/mirror/a.txt?deno-type=text'])
    expect(marked.request).toBe('unplugin-deno:/root/mirror/a.txt?deno-type=text')
    // Nothing is resolved again in the same compilation; `clear` starts over.
    await router.external(info('jsr:@std/path'), 'esm')
    expect(calls).toHaveLength(2)
    router.clear()
    await router.external(info('jsr:@std/path'), 'esm')
    expect(calls).toHaveLength(3)
  })

  it('keeps external outcomes as natively external, with the right type', async () => {
    const { state, calls } = stubState({
      'npm:kleur@^4': { type: 'external', id: 'npm:kleur@4.1.5' },
    })
    const router = new Router(state, 'webpack')
    router.note(info('npm:kleur@^4', ''), undefined)
    // Script output: `import()` in browsers.
    expect(await router.external(info('npm:kleur@^4', ''), 'esm')).toEqual({
      request: 'npm:kleur@4.1.5',
      type: 'import',
    })
    // Entries (no issuer) resolve without an importer.
    expect(calls[0]).toMatchObject({ importer: undefined, request: { isEntry: true } })
    // Script output elsewhere (an Rsbuild node environment's target): `require`.
    const server = new Router(state, 'rspack', { platform: 'deno', conditions: [] })
    expect(server.externalType('esm')).toBe('node-commonjs')
    router.settings = { ...router.settings, outputModule: true }
    expect(await router.external(info('npm:kleur@^4', ''), 'esm')).toEqual({
      request: 'npm:kleur@4.1.5',
      type: 'module-import',
    })
    expect(await router.external(info('npm:kleur@^4', ''), 'commonjs')).toEqual({
      request: 'npm:kleur@4.1.5',
      type: 'node-commonjs',
    })
    expect(calls.at(-1)?.request.kind).toBe('require-call')
  })

  it('leaves URL dependencies and buildHttp URLs to the host and its presets', async () => {
    const { state, calls } = stubState()
    const router = new Router(state, 'webpack')
    router.settings = {
      presets: [{ kind: 'web', schemes: true, async: false, css: true }],
      buildHttp: buildHttpMatcher({ allowedUris: ['https://allowed.test/'] }),
      outputModule: true,
    }
    expect(await router.external(info('https://cdn.test/bg.png'), 'url')).toEqual({
      request: 'https://cdn.test/bg.png',
      type: 'asset',
    })
    expect(await router.external(info('https://fonts.test/a.css'), 'css-import')).toEqual({
      request: 'https://fonts.test/a.css',
      type: 'css-import',
    })
    expect(await router.external(info('https://allowed.test/lib.js'), 'esm')).toEqual({
      request: 'https://allowed.test/lib.js',
      type: 'module',
    })
    // An owned request the core leaves to the host (`null`) gets the presets too.
    expect(await router.external(info('jsr:@std/excluded'), 'esm')).toEqual({
      request: 'jsr:@std/excluded',
      type: 'module',
    })
    expect(calls.map((call) => call.id)).toEqual(['jsr:@std/excluded'])
  })

  it('turns failing owned imports into host errors with code and hint', async () => {
    const { state } = stubState()
    const router = new Router(state, 'webpack')
    const failure: unknown = await router.external(info('npm:broken'), 'esm').catch((e) => e)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      '[unplugin-deno] npm:broken does not exist. (RESOLVE_NOT_FOUND)\n  hint: Check the name.',
    )
    expect(isDenoPluginError(failure)).toBe(true)
  })

  it("passes issuers without webpack's `\\0#` escape to the core", async () => {
    const { state, calls } = stubState()
    const router = new Router(state, 'webpack')
    await router.external(info('jsr:@std/path', '/c\0#sharp/src/main.ts'), 'esm')
    expect(calls[0]?.importer).toBe('/c#sharp/src/main.ts')
    expect([...router.importers]).toEqual(['/c#sharp/src/main.ts'])
  })

  it('skips requests the filter does not match in beforeResolve', async () => {
    const { state, calls } = stubState()
    const router = new Router(state, 'webpack')
    // A marker makes a relative import owned.
    router.note(info('./data.txt'), { type: 'text' })
    router.note(info('./other.ts'), { type: 'json' })
    await router.external(info('./data.txt'), 'esm')
    await router.external(info('./other.ts'), 'esm')
    expect(calls.map((call) => call.id)).toEqual(['./data.txt?deno-type=text'])
  })
})

describe('applyOutcome', () => {
  it('rewrites the request to real files, escaping # in the path', async () => {
    const data: MutableRequest = { request: 'x', context: '/root/src' }
    await applyOutcome({ type: 'path', path: '/c#/lib/mod.ts?raw' }, data, host())
    expect(data).toEqual({ request: '/c\0#/lib/mod.ts?raw', context: '/root/src' })
  })

  it('redirects npm packages to the host from the package directory', async () => {
    const redirect: ResolveOutcome = {
      type: 'npm-redirect',
      request: 'kleur/colors',
      resolveDir: '/root/node_modules/kleur',
      packageJsonPath: '/root/node_modules/kleur/package.json',
      rawSpecifier: 'npm:kleur@^4/colors',
      fallbackPath: '/root/node_modules/kleur/colors.mjs',
      query: '',
    }
    const data: MutableRequest = { request: 'npm:kleur@^4/colors', context: '/root/src' }
    await applyOutcome(
      redirect,
      data,
      host({ '/root/node_modules/kleur|kleur/colors': '/root/node_modules/kleur/colors.mjs' }),
    )
    expect(data).toEqual({ request: 'kleur/colors', context: '/root/node_modules/kleur' })
    // The host cannot resolve it: the engine's file.
    const debug: string[] = []
    const fallback: MutableRequest = { request: 'npm:kleur@^4/colors', context: '/root/src' }
    await applyOutcome(redirect, fallback, host(), (message) => debug.push(message))
    expect(fallback).toEqual({
      request: '/root/node_modules/kleur/colors.mjs',
      context: '/root/src',
    })
    expect(debug).toEqual([expect.stringContaining('kleur/colors does not resolve')])
  })

  it("synthesises host-resolved markers and leaves the host's ignored modules alone", async () => {
    const outcome: ResolveOutcome = {
      type: 'host-marker',
      request: './data.txt',
      denoType: 'bytes',
    }
    const data: MutableRequest = { request: './data.txt', context: '/root/src' }
    const synthetic = host({ '/root/src|./data.txt': '/root/src/data.txt' })
    await applyOutcome(outcome, data, synthetic)
    expect(synthetic.synthesised).toEqual(['/root/src/data.txt?deno-type=bytes'])
    const ignored: MutableRequest = { request: './data.txt', context: '/root/src' }
    await applyOutcome(outcome, ignored, host({ '/root/src|./data.txt': false }))
    expect(ignored.request).toBe('./data.txt')
    await expect(applyOutcome(outcome, ignored, host())).rejects.toThrow('Cannot resolve')
  })

  it('leaves externals and foreign ids alone', async () => {
    const data: MutableRequest = { request: 'node:fs', context: '/root/src' }
    await applyOutcome({ type: 'external', id: 'node:fs' }, data, host())
    await applyOutcome(null, data, host())
    expect(data.request).toBe('node:fs')
  })
})

describe('requestPath', () => {
  it('escapes # in the path, not in the query', () => {
    expect(requestPath('/a/b.ts')).toBe('/a/b.ts')
    expect(requestPath('/c#/b#.ts?x#y')).toBe('/c\0#/b\0#.ts?x#y')
    expect(requestPath('C:\\c#\\b.ts')).toBe('C:\\c\0#\\b.ts')
  })
})

describe('toHostError', () => {
  it('formats DenoPluginErrors once and passes other errors through', () => {
    const error = new DenoPluginError('CACHED_ONLY_MISS', 'npm:x is not cached.', {
      hint: 'Run `deno install`.',
      specifier: 'npm:x',
    })
    const hostError = toHostError(error)
    expect(hostError.message).toBe(
      '[unplugin-deno] npm:x is not cached. (CACHED_ONLY_MISS)\n  hint: Run `deno install`.',
    )
    expect(hostError.stack).toBe(`DenoPluginError: ${hostError.message}`)
    expect(hostError).toMatchObject({ code: 'CACHED_ONLY_MISS', specifier: 'npm:x' })
    expect(hostError.cause).toBe(error)
    expect(toHostError(hostError)).toBe(hostError)
    const plain = new TypeError('boom')
    expect(toHostError(plain)).toBe(plain)
    expect(toHostError('text').message).toBe('text')
  })
})

describe('entryInput', () => {
  it('reads normalised entries, resolving relative paths from the context', () => {
    const entry = {
      main: { import: ['./src/main.ts', 'jsr:@std/path', 'raw-loader!./x.txt'] },
      other: { import: ['../shared/a.ts', '/abs/b.ts'] },
    }
    expect(entryInput(entry, '/root', 'posix')).toEqual([
      '/root/src/main.ts',
      'jsr:@std/path',
      '/shared/a.ts',
      '/abs/b.ts',
    ])
    expect(entryInput({ main: { import: ['.\\src\\main.ts'] } }, 'C:\\root', 'win32')).toEqual([
      'C:\\root\\src\\main.ts',
    ])
    expect(entryInput(() => ({}), '/root')).toEqual([])
    expect(entryInput({ main: './a.ts' }, '/root', 'posix')).toEqual(['/root/a.ts'])
  })
})

describe('platformHint', () => {
  it('maps compiler.platform, or the target, to the platform hint', () => {
    expect(platformHint({ web: true, node: true, deno: true }, 'deno')).toBe('deno')
    expect(platformHint({ web: false, node: true, deno: false }, 'node')).toBe('node')
    expect(platformHint({ web: true, browser: true, node: false }, 'web')).toBe('browser')
    expect(platformHint({ webworker: true }, 'webworker')).toBe('browser')
    expect(platformHint(undefined, 'deno2')).toBe('deno')
    expect(platformHint({ web: null, node: null }, ['node18', 'es2022'])).toBe('node')
    expect(platformHint(undefined, 'electron-main')).toBe('node')
    expect(platformHint(undefined, undefined)).toBe('browser')
  })
})

describe('conditionNames', () => {
  it("keeps the user's conditions without webpack's '...'", () => {
    expect(conditionNames({ conditionNames: ['custom', '...'] })).toEqual(['custom'])
    expect(conditionNames({})).toEqual([])
    expect(conditionNames(undefined)).toEqual([])
  })
})

describe('buildHttpMatcher', () => {
  it('matches allowedUris strings (prefixes), RegExps and functions', () => {
    expect(buildHttpMatcher(undefined)).toBeUndefined()
    const allows = buildHttpMatcher({
      allowedUris: ['https://a.test/', /^https:\/\/b\.test\//, (uri: string) => uri.endsWith('.c')],
    })
    expect(allows?.('https://a.test/x.js')).toBe(true)
    expect(allows?.('https://b.test/y.js')).toBe(true)
    expect(allows?.('https://z.test/lib.c')).toBe(true)
    expect(allows?.('https://z.test/lib.js')).toBe(false)
    expect(buildHttpMatcher(['https://a.test/'])?.('https://a.test/q')).toBe(true)
  })
})

describe('CompilationLog', () => {
  it('reports warnings to the current compilation (pending ones first), info to the logger', () => {
    const logger = {
      warn: vi.fn<(message: string) => void>(),
      info: vi.fn<(message: string) => void>(),
    }
    const log = new CompilationLog(logger)
    log.warn('before')
    const reported: string[] = []
    log.attach((message) => reported.push(message))
    log.warn('during')
    log.info('note')
    log.detach()
    log.warn('after')
    log.flush()
    expect(reported).toEqual(['before', 'during'])
    expect(logger.info).toHaveBeenCalledWith('note')
    expect(logger.warn).toHaveBeenCalledWith('after')
  })
})

describe('ConfigReloader', () => {
  it('reloads once per change of a watched file, for every compiler reporting it', async () => {
    const dir = await tempDir({ 'deno.json': '{}' })
    onTestFinished(() => dir.dispose())
    const config = dir.path('deno.json')
    const changes: string[] = []
    const state = {
      watchChange: async (file: string) => {
        if (file !== config) return false
        changes.push(file)
        return true
      },
      watchFiles: () => [config],
    } as unknown as PluginState
    const reloader = new ConfigReloader(state)
    expect(reloader.generation).toBe(0)
    expect(await reloader.reload([dir.path('src/main.ts'), config])).toBe(true)
    // Another compiler reports the same change; the generation tells it about the reload.
    expect(await reloader.reload([config])).toBe(false)
    expect(changes).toEqual([config])
    expect(reloader.generation).toBe(1)
    await writeFile(config, '{ "imports": {} }')
    const later = new Date(Date.now() + 5000)
    await utimes(config, later, later)
    expect(await reloader.reload([config])).toBe(true)
    expect(changes).toHaveLength(2)
    expect(reloader.generation).toBe(2)
  })

  it('reloads again when a file changes while the project loads', async () => {
    const dir = await tempDir({ 'deno.json': '{}' })
    onTestFinished(() => dir.dispose())
    const config = dir.path('deno.json')
    let reloads = 0
    const state = {
      watchChange: async () => {
        reloads++
        // Written after the reload read the times, before it ends.
        if (reloads === 1) {
          const later = new Date(Date.now() + 5000)
          await utimes(config, later, later)
        }
        return true
      },
      watchFiles: () => [config],
    } as unknown as PluginState
    const reloader = new ConfigReloader(state)
    expect(await reloader.reload([config])).toBe(true)
    expect(await reloader.reload([config])).toBe(true)
    expect(reloads).toBe(2)
  })
})

describe('mirrorLoad', () => {
  it('names mirrored sources by absolute path next to the mirror file', async () => {
    const state = {
      flavor: 'posix',
      load: async (id: string) =>
        id === '/m/https/jsr.io/x/mod.ts.js'
          ? {
              code: 'export {}',
              map: {
                version: 3,
                sources: ['mod.ts', 'https://jsr.io/y.ts'],
                names: [],
                mappings: '',
              },
            }
          : null,
    } as unknown as PluginState
    const load = mirrorLoad(state)
    const context = { addWatchFile: () => {} }
    expect(await load.call(context, '/m/https/jsr.io/x/mod.ts.js')).toEqual({
      code: 'export {}',
      map: {
        version: 3,
        sources: ['/m/https/jsr.io/x/mod.ts', 'https://jsr.io/y.ts'],
        names: [],
        mappings: '',
      },
    })
    expect(await load.call(context, '/other.js')).toBeNull()
  })
})

/** A `load` hook that loads nothing. */
async function loadNothing(): Promise<null> {
  return null
}

describe('loadLoader', () => {
  it("points at unplugin's load loaders", () => {
    for (const hostName of ['webpack', 'rspack'] as const) {
      const use = loadLoader(hostName, loadNothing)
      expect(existsSync(use.loader)).toBe(true)
      expect(use.loader.replaceAll('\\', '/')).toMatch(
        new RegExp(`unplugin/dist/${hostName}/loaders/load\\.mjs$`),
      )
      expect(use.options.plugin).toEqual({ name: 'unplugin-deno', load: loadNothing })
    }
  })
})
