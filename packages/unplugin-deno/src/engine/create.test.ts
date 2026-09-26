import { describe, expect, it, vi } from 'vitest'
import { denoBinary } from '../../test/helpers/deno-binary.js'
import { denoDir } from '../../test/helpers/deno-dir.js'
import { tempProject } from '../../test/helpers/temp-project.js'
import { isDenoPluginError } from '../diagnostics/errors.js'
import { createSilentLogger } from '../diagnostics/logger.js'
import { createEngine, ENGINE_FACTORIES } from './create.js'
import type { EngineCreateOptions } from './types.js'

async function engineOptions(root: string): Promise<EngineCreateOptions> {
  vi.stubEnv('DENO_DIR', await denoDir())
  return {
    project: {
      root,
      workspaceRoot: root,
      configPath: undefined,
      lockfilePath: undefined,
      nodeModulesDir: 'none',
    },
    platform: 'node',
    conditions: [],
    cachedOnly: false,
    logger: createSilentLogger(),
  }
}

describe('createEngine', () => {
  it('has a factory per engine kind', () => {
    expect(Object.keys(ENGINE_FACTORIES)).toEqual(['loader', 'deno'])
    for (const [kind, factory] of Object.entries(ENGINE_FACTORIES)) expect(factory.kind).toBe(kind)
  })

  it('creates loader engines', async () => {
    await using temp = await tempProject('engine-no-config')
    await using engine = await createEngine('loader', await engineOptions(temp.root))
    expect(engine.kind).toBe('loader')
    expect((await engine.resolve('./src/main.ts', undefined, 'import')).path).toBe(
      temp.path('src/main.ts'),
    )
  })

  it.skipIf(denoBinary.skipReason !== undefined)(
    `creates deno engines${denoBinary.skipReason === undefined ? '' : ` (skipped: ${denoBinary.skipReason})`}`,
    async () => {
      await using temp = await tempProject('engine-no-config')
      await using engine = await createEngine('deno', {
        ...(await engineOptions(temp.root)),
        denoBinary: denoBinary.binary,
      })
      expect(engine.kind).toBe('deno')
      expect((await engine.resolve('./src/main.ts', undefined, 'import')).path).toBe(
        temp.path('src/main.ts'),
      )
    },
  )

  it('reports the deno engine as unavailable without a Deno binary', async () => {
    await using temp = await tempProject('engine-no-config')
    const error = await createEngine('deno', {
      ...(await engineOptions(temp.root)),
      denoBinary: 'unplugin-deno-test-missing-deno',
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(isDenoPluginError(error)).toBe(true)
    expect(error).toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      message: expect.stringContaining('unplugin-deno-test-missing-deno'),
      hint: expect.stringContaining("engine: 'loader'"),
    })
  })
})
