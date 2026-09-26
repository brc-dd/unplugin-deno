import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../../test/helpers/temp-dir.js'
import type { TempFiles } from '../../test/helpers/temp-dir.js'
import { createSilentLogger } from '../diagnostics/logger.js'
import type { ResolvedEnvOptions } from './env.js'
import { DEFAULT_ENV_FILES, inlinesEnv, loadEnv } from './env.js'

async function load(
  files: TempFiles,
  options: Partial<ResolvedEnvOptions>,
  processEnv: Record<string, string | undefined> = {},
): Promise<{ env: Awaited<ReturnType<typeof loadEnv>>; warnings: string[]; root: string }> {
  const dir = await tempDir(files)
  onTestFinished(() => dir.dispose())
  const warnings: string[] = []
  const logger = { ...createSilentLogger(), warn: (message: string) => warnings.push(message) }
  const resolved: ResolvedEnvOptions = {
    prefix: [],
    allow: [],
    files: null,
    server: false,
    ...options,
  }
  return { env: await loadEnv(resolved, dir.root, processEnv, logger), warnings, root: dir.root }
}

describe('loadEnv', () => {
  it('reads .env and .env.local by default; later files and the process win', async () => {
    const { env, warnings, root } = await load(
      {
        '.env': 'PUBLIC_A=from .env\nPUBLIC_B=from .env\nPUBLIC_C=from .env\nSECRET=s\n',
        '.env.local': 'PUBLIC_B=from .env.local\n# a comment\nexport PUBLIC_D="quoted value"\n',
      },
      { prefix: ['PUBLIC_'] },
      { PUBLIC_C: 'from the process', PUBLIC_E: '' },
    )
    expect(DEFAULT_ENV_FILES).toEqual(['.env', '.env.local'])
    expect(env.files.map((file) => file.slice(root.length + 1))).toEqual(['.env', '.env.local'])
    expect(env.value('PUBLIC_A')).toBe('from .env')
    expect(env.value('PUBLIC_B')).toBe('from .env.local')
    expect(env.value('PUBLIC_C')).toBe('from the process')
    expect(env.value('PUBLIC_D')).toBe('quoted value')
    expect(env.value('PUBLIC_E')).toBe('')
    expect(env.value('PUBLIC_MISSING')).toBeUndefined()
    // Not allowed: left in the code.
    expect(env.value('SECRET')).toBeNull()
    expect(env.allowed('SECRET')).toBe(false)
    expect(env.entries()).toEqual([
      ['PUBLIC_A', 'from .env'],
      ['PUBLIC_B', 'from .env.local'],
      ['PUBLIC_C', 'from the process'],
      ['PUBLIC_D', 'quoted value'],
      ['PUBLIC_E', ''],
    ])
    expect(warnings).toEqual([])
  })

  it('skips missing default files and warns about missing listed ones', async () => {
    const quiet = await load({}, { allow: ['MODE'] }, { MODE: 'test' })
    expect(quiet.env.files).toEqual([])
    expect(quiet.env.value('MODE')).toBe('test')
    expect(quiet.warnings).toEqual([])
    const listed = await load(
      { 'config/app.env': 'API_URL=https://x.test\n' },
      { allow: ['API_URL'], files: ['config/app.env', 'missing.env'] },
    )
    expect(listed.env.value('API_URL')).toBe('https://x.test')
    expect(listed.warnings).toEqual([expect.stringContaining('missing.env')])
  })

  it('allows exact names and several prefixes', async () => {
    const { env } = await load({}, { prefix: ['VITE_', 'PUBLIC_'], allow: ['NODE_ENV'] }, {})
    expect(['VITE_X', 'PUBLIC_Y', 'NODE_ENV', 'NODE_ENVX', 'X'].map(env.allowed)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ])
  })
})

describe('inlinesEnv', () => {
  it('inlines for the browser, and for servers only with env.server', () => {
    const env = { prefix: ['PUBLIC_'], allow: [], files: null, server: false }
    expect(inlinesEnv({ env }, 'browser')).toBe(true)
    expect(inlinesEnv({ env }, 'deno')).toBe(false)
    expect(inlinesEnv({ env: { ...env, server: true } }, 'node')).toBe(true)
    expect(inlinesEnv({ env: false }, 'browser')).toBe(false)
  })
})
