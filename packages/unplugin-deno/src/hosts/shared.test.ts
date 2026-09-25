import { describe, expect, it, vi } from 'vitest'
import type { HostResolve, HostResolvedId } from './shared.js'
import { createHostLogger, toRollupResult } from './shared.js'

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
