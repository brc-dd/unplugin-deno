import { describe, expect, it } from 'vitest'
import type { Options } from '../../core/options.js'
import { resolveOptions } from '../../core/options.js'
import type { PluginState } from '../../core/state.js'
import { environmentPlatform, environmentTarget, rsbuildHooks } from './index.js'

/** The parts of a plugin state the environment helpers read. */
function stateWith(options: Options, configPath: string | null): PluginState {
  return {
    options: resolveOptions(options, { root: '/root', env: {} }),
    project: { configPath },
  } as unknown as PluginState
}

describe('environmentPlatform', () => {
  it('builds web environments for the browser unless a platform record names them', () => {
    expect(environmentPlatform(stateWith({}, '/root/deno.json'), 'web', 'web')).toBe('browser')
    expect(environmentPlatform(stateWith({}, null), 'worker', 'web-worker')).toBe('browser')
    // A platform string never applies to browser code.
    expect(environmentPlatform(stateWith({ platform: 'deno' }, null), 'web', 'web')).toBe('browser')
    expect(
      environmentPlatform(stateWith({ platform: { web: 'neutral' } }, null), 'web', 'web'),
    ).toBe('neutral')
  })

  it('builds node environments for Deno in Deno projects, else Node.js', () => {
    expect(environmentPlatform(stateWith({}, '/root/deno.json'), 'node', 'node')).toBe('deno')
    expect(environmentPlatform(stateWith({}, null), 'node', 'node')).toBe('node')
    expect(
      environmentPlatform(stateWith({ platform: 'node' }, '/root/deno.json'), 'ssr', 'node'),
    ).toBe('node')
    expect(
      environmentPlatform(
        stateWith({ platform: { ssr: 'node' } }, '/root/deno.json'),
        'ssr',
        'node',
      ),
    ).toBe('node')
  })

  it('resolves with the environment platform and no host conditions', () => {
    expect(environmentTarget(stateWith({}, '/root/deno.json'), 'node', 'node')).toEqual({
      platform: 'deno',
      conditions: [],
    })
  })
})

describe('rsbuildHooks', () => {
  it('provides only setup (unplugin names the plugin and adds its no-op Rspack plugin)', () => {
    expect(Object.keys(rsbuildHooks(stateWith({}, null)))).toEqual(['setup'])
  })
})
