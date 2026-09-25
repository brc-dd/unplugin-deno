import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { runtime } from '../test/helpers/runtime.js'
import bun from './bun.js'
import { PLUGIN_NAME } from './core/plugin.js'
import esbuild from './esbuild.js'
import farm from './farm.js'
import rolldown from './rolldown.js'
import rollup from './rollup.js'
import rsbuild from './rsbuild.js'
import rspack from './rspack.js'
import vite from './vite.js'
import webpack from './webpack.js'

function names(plugin: unknown): string[] {
  const plugins: unknown[] = Array.isArray(plugin) ? plugin : [plugin]
  return plugins.map((item) => (item as { name?: string }).name ?? '')
}

describe('host entries', () => {
  it.each([
    ['vite', vite],
    ['rolldown', rolldown],
    ['rollup', rollup],
    ['esbuild', esbuild],
    ['rsbuild', rsbuild],
    ['farm', farm],
  ] as const)('%s returns a plugin named unplugin-deno', (_host, create) => {
    expect(names(create())).toContain(PLUGIN_NAME)
    expect(names(create({ debug: false }))).toContain(PLUGIN_NAME)
  })

  it.each([
    ['webpack', webpack],
    ['rspack', rspack],
  ] as const)('%s returns a compiler plugin', (_host, create) => {
    expect(typeof create().apply).toBe('function')
  })

  it.runIf(runtime === 'bun')('bun returns a Bun plugin', () => {
    expect(names(bun())).toContain(PLUGIN_NAME)
  })

  it('leaves esbuild builds untouched (no catch-all onResolve)', async () => {
    const result = await build({
      stdin: { contents: 'import { join } from "node:path"; export const x = join("a", "b")' },
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      logLevel: 'silent',
      plugins: [esbuild()],
    })
    const [output] = result.outputFiles
    expect(output?.text).toContain('from "node:path"')
    expect(output?.text).toContain('join("a", "b")')
  })
})
