import { describe, expect, it } from 'vitest'
import { DenoPluginError, ERROR_CODES, isDenoPluginError } from './errors.js'

describe('DenoPluginError', () => {
  it('carries code, message, hint, specifier, importer and cause', () => {
    const cause = new Error('boom')
    const error = new DenoPluginError('RESOLVE_NOT_FOUND', 'Cannot find module "x".', {
      hint: 'run `deno install`',
      specifier: 'npm:x',
      importer: 'file:///project/main.ts',
      cause,
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('DenoPluginError')
    expect(error.code).toBe('RESOLVE_NOT_FOUND')
    expect(error.message).toBe('Cannot find module "x".')
    expect(error.hint).toBe('run `deno install`')
    expect(error.specifier).toBe('npm:x')
    expect(error.importer).toBe('file:///project/main.ts')
    expect(error.cause).toBe(cause)
    expect(error.stack).toContain('Cannot find module')
  })

  it('omits cause when none is given', () => {
    const error = new DenoPluginError('CONFIG_INVALID', 'Bad config.')
    expect('cause' in error).toBe(false)
    expect(error.hint).toBeUndefined()
  })

  it('formats like hosts print it', () => {
    expect(new DenoPluginError('CACHED_ONLY_MISS', 'Not cached.').format()).toBe(
      '[unplugin-deno] Not cached. (CACHED_ONLY_MISS)',
    )
    expect(
      new DenoPluginError('NOT_IN_LOCKFILE', 'Missing from deno.lock.', {
        hint: 'run `deno install`',
      }).format(),
    ).toBe('[unplugin-deno] Missing from deno.lock. (NOT_IN_LOCKFILE)\n  hint: run `deno install`')
  })

  it('lists the architecture error codes', () => {
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining([
        'CONFIG_NOT_FOUND',
        'CONFIG_INVALID',
        'IMPORT_MAP_INVALID',
        'LOCKFILE_INVALID',
        'RESOLVE_NOT_FOUND',
        'RESOLVE_NOT_EXPORTED',
        'RESOLVE_UNMAPPED_BARE',
        'RESOLVE_CONSTRAINT',
        'RESOLVE_FAILED',
        'NOT_IN_LOCKFILE',
        'LOCKFILE_FROZEN_DRIFT',
        'CACHED_ONLY_MISS',
        'DISALLOWED_HOST',
        'INTEGRITY_MISMATCH',
        'MIRROR_WRITE_FAILED',
        'ENGINE_UNAVAILABLE',
        'UNSUPPORTED_MEDIA_TYPE',
      ]),
    )
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})

describe('isDenoPluginError', () => {
  it('accepts instances and structurally equal errors from another copy', () => {
    expect(isDenoPluginError(new DenoPluginError('RESOLVE_FAILED', 'x'))).toBe(true)
    const foreign = Object.assign(new Error('x'), {
      name: 'DenoPluginError',
      code: 'RESOLVE_FAILED',
    })
    expect(isDenoPluginError(foreign)).toBe(true)
  })

  it('rejects other values', () => {
    expect(isDenoPluginError(new Error('x'))).toBe(false)
    expect(isDenoPluginError({ name: 'DenoPluginError', code: 'RESOLVE_FAILED' })).toBe(false)
    const unknownCode = Object.assign(new Error('x'), { name: 'DenoPluginError', code: 'NOPE' })
    expect(isDenoPluginError(unknownCode)).toBe(false)
    expect(isDenoPluginError(undefined)).toBe(false)
  })
})
