import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { denoDir } from '../../../test/helpers/deno-dir.js'
import { tempProject } from '../../../test/helpers/temp-project.js'
import { PluginState } from '../../core/state.js'
import { packageInstaller } from './install.js'

async function state(fixtureName: string): Promise<{ state: PluginState; importer: string }> {
  vi.stubEnv('DENO_DIR', await denoDir())
  const project = await tempProject(fixtureName)
  onTestFinished(() => project.dispose())
  const plugin = new PluginState({ cwd: project.root, platform: 'browser' }, 'vite')
  onTestFinished(() => plugin.close())
  await plugin.prepare()
  return { state: plugin, importer: project.path('src/main.ts') }
}

describe('packageInstaller', () => {
  it('installs npm packages of nodeModulesDir "auto" before they are resolved', async () => {
    const { state: plugin, importer } = await state('vite-spa')
    const add = vi.spyOn(plugin, 'addEntrypoints')
    const install = packageInstaller(plugin)
    const target = { platform: 'browser' as const, conditions: [] }
    // Requirements met in one tick are added together.
    await Promise.all([
      install('npm:kleur@^4/colors', importer, target),
      install('npm:kleur@^4/colors', importer, target),
      install('@std/path', importer, target),
      install('./util.ts', importer, target),
    ])
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith(target, ['npm:kleur@^4/colors'])
    const outcome = await plugin.resolve('npm:kleur@^4/colors', importer, { target })
    expect(outcome?.type).toBe('npm-redirect')
    // Added once per target.
    await install('npm:kleur@^4/colors', importer, target)
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('maps import-map keys to their npm requirement', async () => {
    const { state: plugin, importer } = await state('core-npm-node-modules')
    const add = vi.spyOn(plugin, 'addEntrypoints')
    await packageInstaller(plugin)('kleur', importer, undefined)
    expect(add).toHaveBeenCalledWith(undefined, ['npm:kleur@^4'])
    // Bare imports inside node_modules are the host's.
    add.mockClear()
    await packageInstaller(plugin)(
      'kleur',
      join(plugin.project.root, 'node_modules', 'x', 'index.js'),
      undefined,
    )
    expect(add).not.toHaveBeenCalled()
  })

  it('does nothing when Deno does not install into node_modules', async () => {
    const { state: plugin, importer } = await state('vite-no-package-json')
    const add = vi.spyOn(plugin, 'addEntrypoints')
    await packageInstaller(plugin)('kleur', importer, undefined)
    expect(add).not.toHaveBeenCalled()
  })
})
