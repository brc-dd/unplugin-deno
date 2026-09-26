import { chmod, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { denoBinary } from '../../../test/helpers/deno-binary.js'
import { tempDir } from '../../../test/helpers/temp-dir.js'
import { isDenoPluginError } from '../../diagnostics/errors.js'
import {
  clearDenoProbes,
  compareVersions,
  denoCacheDirs,
  denoEnv,
  DenoSpawnError,
  isSupportedDenoVersion,
  MIN_DENO_VERSION,
  parseDenoVersion,
  probeDeno,
  requireDeno,
  runDeno,
} from './process.js'

const onWindows = process.platform === 'win32'

describe('Deno versions', () => {
  it('parses `deno --version` output, canary builds included', () => {
    expect(
      parseDenoVersion(
        'deno 2.9.7 (stable, release, aarch64-apple-darwin)\nv8 15.0\ntypescript 6.0.3\n',
      ),
    ).toBe('2.9.7')
    expect(
      parseDenoVersion('deno 2.10.0+1a2b3c4 (canary, release, x86_64-unknown-linux-gnu)'),
    ).toBe('2.10.0')
    expect(parseDenoVersion('node v26.0.0')).toBeUndefined()
  })

  it('compares versions numerically against the minimum', () => {
    expect(MIN_DENO_VERSION).toBe('2.8.3')
    expect(compareVersions('2.10.0', '2.9.7')).toBe(1)
    expect(compareVersions('2.8.3', '2.8.3')).toBe(0)
    expect(compareVersions('2.8.2', '2.8.3')).toBe(-1)
    expect(isSupportedDenoVersion('2.8.3')).toBe(true)
    expect(isSupportedDenoVersion('2.9.7')).toBe(true)
    expect(isSupportedDenoVersion('2.8.2')).toBe(false)
    expect(isSupportedDenoVersion('1.46.3')).toBe(false)
  })
})

describe('probeDeno', () => {
  it('reports a missing binary once per process, and requireDeno turns it into ENGINE_UNAVAILABLE', async () => {
    const binary = 'unplugin-deno-test-missing-deno'
    const probe = await probeDeno(binary)
    expect(probe).toMatchObject({ ok: false, problem: 'missing', binary })
    expect(await probeDeno(binary)).toBe(probe)
    const error = await requireDeno(binary).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(isDenoPluginError(error)).toBe(true)
    expect(error).toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      hint: expect.stringContaining("engine: 'loader'"),
    })
  })

  it.skipIf(onWindows)('refuses a Deno older than 2.8.3', async () => {
    await using temp = await tempDir()
    const fake = temp.path('old-deno')
    await writeFile(
      fake,
      '#!/bin/sh\necho "deno 2.7.14 (stable, release, x86_64-unknown-linux-gnu)"\n',
    )
    await chmod(fake, 0o755)
    clearDenoProbes()
    expect(await probeDeno(fake)).toMatchObject({
      ok: false,
      problem: 'too-old',
      version: '2.7.14',
    })
    await expect(requireDeno(fake)).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE',
      message: expect.stringContaining('2.7.14'),
      hint: expect.stringContaining('deno upgrade'),
    })
  })

  it.skipIf(denoBinary.skipReason !== undefined)(
    `accepts the installed Deno${denoBinary.skipReason === undefined ? '' : ` (skipped: ${denoBinary.skipReason})`}`,
    async () => {
      const probe = await probeDeno(denoBinary.binary)
      expect(probe).toMatchObject({ ok: true, version: denoBinary.version })
      const dirs = await denoCacheDirs(
        denoBinary.binary,
        { ...process.env, DENO_DIR: '/tmp/x' },
        '/',
      )
      expect(dirs.npmCache?.replaceAll('\\', '/')).toMatch(/\/npm$/)
    },
  )
})

describe('runDeno', () => {
  it('rejects with DenoSpawnError when the binary does not exist', async () => {
    await expect(runDeno('unplugin-deno-test-missing-deno', ['--version'])).rejects.toBeInstanceOf(
      DenoSpawnError,
    )
  })

  it.skipIf(onWindows)('kills a process that outlives its timeout or is aborted', async () => {
    const started = performance.now()
    const timedOut = await runDeno('sh', ['-c', 'sleep 30'], { timeoutMs: 100 })
    expect(timedOut).toMatchObject({ timedOut: true, aborted: false })
    const controller = new AbortController()
    const running = runDeno('sh', ['-c', 'sleep 30'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    expect(await running).toMatchObject({ timedOut: false, aborted: true })
    expect(performance.now() - started).toBeLessThan(10_000)
  })

  it.skipIf(onWindows)('collects stdout as bytes and stderr as text without colors', async () => {
    const result = await runDeno('sh', [
      '-c',
      'printf out; printf "\\033[31merr\\033[0m" >&2; exit 3',
    ])
    expect(result.exitCode).toBe(3)
    expect(result.stdout.toString('utf8')).toBe('out')
    expect(result.stderr).toBe('err')
  })
})

describe('denoEnv', () => {
  it('turns off colors, update checks and prompts and keeps the rest', () => {
    const env = denoEnv({ DENO_DIR: '/d', FORCE_COLOR: '1', PATH: '/bin' })
    expect(env).toEqual({
      DENO_DIR: '/d',
      PATH: '/bin',
      NO_COLOR: '1',
      DENO_NO_UPDATE_CHECK: '1',
      DENO_NO_PROMPT: '1',
    })
  })
})
