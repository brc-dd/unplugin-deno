import type { UnpluginContextMeta } from 'unplugin'
import { describe, expect, it } from 'vitest'
import { PLUGIN_NAME, unpluginFactory } from './plugin.js'

const frameworks = [
  'rollup',
  'vite',
  'rolldown',
  'farm',
  'unloader',
  'webpack',
  'rspack',
  'rsbuild',
  'esbuild',
  'bun',
] as const

function meta(framework: (typeof frameworks)[number]): UnpluginContextMeta {
  return { framework, versions: {} } as UnpluginContextMeta
}

describe('unpluginFactory', () => {
  it.each(frameworks)('returns a named plugin for %s', (framework) => {
    expect(unpluginFactory(undefined, meta(framework)).name).toBe(PLUGIN_NAME)
  })

  it('returns only esbuild.setup for esbuild, so unplugin registers no catch-all hooks', () => {
    const plugin = unpluginFactory({}, meta('esbuild'))
    expect(Object.keys(plugin).toSorted()).toEqual(['esbuild', 'name'])
    expect(Object.keys(plugin.esbuild ?? {})).toEqual(['setup'])
  })

  it('reports that the esbuild adapter is not available yet', () => {
    const setup = unpluginFactory({}, meta('esbuild')).esbuild?.setup
    expect(() => setup?.({} as never)).toThrow(
      expect.objectContaining({ name: 'DenoPluginError', code: 'ENGINE_UNAVAILABLE' }),
    )
  })

  it('gives the Rollup family the generic hooks, with host specifics under the escape hatches', () => {
    const generic = [
      'buildEnd',
      'buildStart',
      'enforce',
      'load',
      'name',
      'resolveId',
      'transform',
      'watchChange',
    ]
    expect(Object.keys(unpluginFactory({}, meta('vite'))).toSorted()).toEqual(
      [...generic, 'vite'].toSorted(),
    )
    const rolldown = unpluginFactory({}, meta('rolldown'))
    expect(Object.keys(rolldown).toSorted()).toEqual([...generic, 'rolldown'].toSorted())
    expect(Object.keys(rolldown.rolldown ?? {}).toSorted()).toEqual([
      'closeBundle',
      'load',
      'options',
      'resolveId',
    ])
    const rollup = unpluginFactory({}, meta('rollup'))
    expect(Object.keys(rollup.rollup ?? {}).toSorted()).toEqual([
      'closeBundle',
      'load',
      'options',
      'resolveId',
    ])
  })

  it('uses native filters: owned ids for resolveId, mirror files and markers for load', () => {
    const plugin = unpluginFactory({}, meta('vite'))
    const resolveId = plugin.resolveId
    const filter = typeof resolveId === 'object' ? resolveId.filter?.id : undefined
    expect(filter?.test('jsr:@std/path')).toBe(true)
    expect(filter?.test('./local.ts')).toBe(false)
    const load = plugin.load
    const ids = typeof load === 'object' ? load.filter?.id : undefined
    expect(
      Array.isArray(ids) &&
        ids.some(
          (pattern) =>
            pattern instanceof RegExp && pattern.test('/p/node_modules/.unplugin-deno/abc/x.js'),
        ),
    ).toBe(true)
    expect(
      Array.isArray(ids) &&
        ids.some((pattern) => pattern instanceof RegExp && pattern.test('/p/a.txt?deno-type=text')),
    ).toBe(true)
  })

  it('keeps the other hosts inert until their adapters land', () => {
    for (const framework of ['webpack', 'rspack', 'rsbuild', 'farm', 'bun', 'unloader'] as const) {
      expect(unpluginFactory({}, meta(framework))).toEqual({ name: PLUGIN_NAME })
    }
  })

  it('validates options when the plugin is created', () => {
    for (const framework of ['rolldown', 'esbuild', 'webpack'] as const) {
      expect(() => unpluginFactory({ npm: 'yarn' } as never, meta(framework))).toThrow(
        expect.objectContaining({ code: 'OPTIONS_INVALID' }),
      )
    }
  })
})
