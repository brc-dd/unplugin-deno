import { describe, expect, it, vi } from 'vitest'
import type { HostResolve, HostResolvedId } from './shared.js'
import {
  createHostLogger,
  esbuildJsxOptions,
  oxcJsxOptions,
  rollupJsxOptions,
  toRollupResult,
  transformContext,
} from './shared.js'

type LogMethod = (message: string) => void

const unresolvable: HostResolve = async () => null

describe('createHostLogger', () => {
  it('reports through the current host context', () => {
    const warn = vi.fn<LogMethod>()
    const info = vi.fn<LogMethod>()
    let target: { warn: typeof warn; info: typeof info } | undefined = { warn, info }
    const logger = createHostLogger(() => target, { debug: true })
    logger.warn('w')
    logger.error('e')
    logger.info('i')
    logger.debug('[core] d')
    logger.downloading('https://x.test/a.ts')
    expect(warn.mock.calls).toEqual([['w'], ['error: e']])
    expect(info.mock.calls).toEqual([
      ['i'],
      ['[core] d'],
      ['[engine] Downloading https://x.test/a.ts'],
    ])
    expect(logger.debugEnabled).toBe(true)
    target = undefined
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logger.warn('fallback')
    expect(consoleWarn).toHaveBeenCalledWith('[unplugin-deno] fallback')
  })

  it('drops debug output unless enabled', () => {
    const info = vi.fn<LogMethod>()
    const logger = createHostLogger(() => ({ info }), { debug: false })
    logger.debug('hidden')
    logger.downloading('https://x.test')
    expect(info).not.toHaveBeenCalled()
    expect(logger.debugEnabled).toBe(false)
  })
})

describe('toRollupResult', () => {
  const redirect = {
    type: 'npm-redirect' as const,
    request: 'kleur/colors',
    resolveDir: '/p/node_modules/kleur',
    packageJsonPath: '/p/node_modules/kleur/package.json',
    rawSpecifier: 'npm:kleur@^4/colors',
    fallbackPath: '/p/node_modules/kleur/colors.mjs',
    query: '?raw',
    sideEffects: false,
  }

  it('maps plain outcomes', async () => {
    expect(await toRollupResult(null, undefined, undefined)).toBeNull()
    expect(await toRollupResult({ type: 'path', path: '/a.ts' }, undefined, undefined)).toEqual({
      id: '/a.ts',
    })
    expect(
      await toRollupResult(
        { type: 'path', path: '/a.js', sideEffects: false },
        undefined,
        undefined,
      ),
    ).toEqual({
      id: '/a.js',
      moduleSideEffects: false,
    })
    expect(
      await toRollupResult(
        { type: 'path', path: '/a.js', sideEffects: true },
        undefined,
        undefined,
      ),
    ).toEqual({ id: '/a.js' })
    expect(
      await toRollupResult(
        { type: 'mirror', path: '/m/a.ts.js', url: 'https://x' },
        undefined,
        undefined,
      ),
    ).toEqual({ id: '/m/a.ts.js' })
    expect(
      await toRollupResult(
        {
          type: 'marker',
          path: '/a.txt?deno-type=text',
          denoType: 'text',
          sourceUrl: 'file:///a.txt',
        },
        undefined,
        undefined,
      ),
    ).toEqual({ id: '/a.txt?deno-type=text' })
    expect(await toRollupResult({ type: 'external', id: 'node:fs' }, undefined, undefined)).toEqual(
      { id: 'node:fs', external: true },
    )
    expect(
      await toRollupResult({ type: 'virtual', id: '\0deno:empty' }, undefined, undefined),
    ).toEqual({ id: '\0deno:empty' })
  })

  it('redirects npm requests through the host, from the package.json', async () => {
    const resolve = vi.fn<HostResolve>(async () => ({
      id: '/p/node_modules/kleur/colors.mjs',
      external: false,
      moduleSideEffects: null,
    }))
    expect(await toRollupResult(redirect, '/p/src/main.ts', resolve)).toEqual({
      id: '/p/node_modules/kleur/colors.mjs?raw',
    })
    expect(resolve).toHaveBeenCalledWith('kleur/colors', '/p/node_modules/kleur/package.json')
    resolve.mockResolvedValueOnce({ id: '/x.js', moduleSideEffects: false })
    expect(await toRollupResult(redirect, undefined, resolve)).toEqual({
      id: '/x.js?raw',
      moduleSideEffects: false,
    })
    resolve.mockResolvedValueOnce({ id: 'kleur', external: true })
    expect(await toRollupResult(redirect, undefined, resolve)).toEqual({
      id: 'kleur',
      external: true,
    })
  })

  it('falls back to the engine path when the host cannot resolve the request', async () => {
    expect(await toRollupResult(redirect, undefined, unresolvable)).toEqual({
      id: '/p/node_modules/kleur/colors.mjs?raw',
      moduleSideEffects: false,
    })
    expect(await toRollupResult({ ...redirect, sideEffects: null }, undefined, undefined)).toEqual({
      id: '/p/node_modules/kleur/colors.mjs?raw',
    })
  })

  it('adds the marker to what the host resolves for host markers', async () => {
    const resolved: HostResolvedId = { id: '/p/src/data.txt' }
    const resolve = vi.fn<HostResolve>(async () => resolved)
    const outcome = {
      type: 'host-marker' as const,
      request: './data.txt',
      denoType: 'text' as const,
    }
    expect(await toRollupResult(outcome, '/p/src/main.ts', resolve)).toEqual({
      id: '/p/src/data.txt?deno-type=text',
    })
    expect(resolve).toHaveBeenCalledWith('./data.txt', '/p/src/main.ts')
    resolve.mockResolvedValueOnce(null)
    expect(await toRollupResult(outcome, '/p/src/main.ts', resolve)).toBeNull()
    resolve.mockResolvedValueOnce({ id: 'x', external: true })
    expect(await toRollupResult(outcome, '/p/src/main.ts', resolve)).toBeNull()
    expect(await toRollupResult(outcome, '/p/src/main.ts', undefined)).toBeNull()
  })
})

describe('JSX options per host (§5.11)', () => {
  const automatic = { runtime: 'automatic', importSource: 'preact', development: false } as const
  const development = { ...automatic, development: true }
  const classic = { runtime: 'classic', factory: 'h', fragment: 'Fragment' } as const

  it('maps to Oxc (Vite 8, Rolldown)', () => {
    expect(oxcJsxOptions(automatic)).toEqual({ runtime: 'automatic', importSource: 'preact' })
    expect(oxcJsxOptions(development)).toEqual({
      runtime: 'automatic',
      importSource: 'preact',
      development: true,
    })
    // No `__source`/`__self` props for a classic factory, even where Vite enables development.
    expect(oxcJsxOptions(classic)).toEqual({
      runtime: 'classic',
      pragma: 'h',
      pragmaFrag: 'Fragment',
      development: false,
    })
  })

  it('maps to esbuild (Vite 7, esbuild)', () => {
    expect(esbuildJsxOptions(automatic)).toEqual({ jsx: 'automatic', jsxImportSource: 'preact' })
    expect(esbuildJsxOptions(development)).toMatchObject({ jsxDev: true })
    expect(esbuildJsxOptions(classic)).toEqual({
      jsx: 'transform',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
    })
  })

  it('maps to Rollup, whose jsxImportSource is the runtime module', () => {
    expect(rollupJsxOptions(automatic)).toEqual({
      mode: 'automatic',
      factory: 'createElement',
      importSource: 'preact',
      jsxImportSource: 'preact/jsx-runtime',
    })
    // No development runtime in Rollup.
    expect(rollupJsxOptions(development)).toEqual(rollupJsxOptions(automatic))
    expect(rollupJsxOptions(classic)).toEqual({
      mode: 'classic',
      factory: 'h',
      fragment: 'Fragment',
    })
  })
})

describe('transformContext', () => {
  it('wraps the host parser and asks the host whether a module is an entry', () => {
    const parse = vi.fn<(code: string, options: { lang: string }) => unknown>((code, options) => ({
      code,
      ...options,
    }))
    const context = {
      parse,
      getModuleInfo: (id: string) => ({ isEntry: id === '/p/main.ts' }),
    }
    const main = transformContext(context, '/p/main.ts')
    expect(main.isEntry?.()).toBe(true)
    expect(transformContext(context, '/p/lib.ts').isEntry?.()).toBe(false)
    expect(main.parse?.('x', 'tsx')).toEqual({ code: 'x', lang: 'tsx' })
    const bare = transformContext({}, '/p/main.ts')
    expect(bare.parse).toBeUndefined()
    expect(bare.isEntry?.()).toBe(false)
    const throwing = transformContext(
      {
        getModuleInfo: () => {
          throw new Error('not available')
        },
      },
      '/p/main.ts',
    )
    expect(throwing.isEntry?.()).toBe(false)
  })
})
