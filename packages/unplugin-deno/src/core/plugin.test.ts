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

  it('declares no generic hooks yet', () => {
    const plugin = unpluginFactory({}, meta('vite'))
    expect(plugin).toEqual({ name: PLUGIN_NAME })
  })
})
