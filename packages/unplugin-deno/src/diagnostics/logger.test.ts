import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LogLevel } from './logger.js'
import { createConsoleLogger, createSilentLogger, isDebugEnabled } from './logger.js'

function capture(): {
  lines: Array<[LogLevel, string]>
  sink: (level: LogLevel, line: string) => void
} {
  const lines: Array<[LogLevel, string]> = []
  return { lines, sink: (level, line) => lines.push([level, line]) }
}

describe('isDebugEnabled', () => {
  it.each([
    ['unplugin-deno', true],
    ['unplugin-deno:*', true],
    ['unplugin-*', true],
    ['*', true],
    ['vite:*,unplugin-deno', true],
    ['vite:* unplugin-deno', true],
    ['*,-unplugin-deno', false],
    ['-unplugin-deno,unplugin-deno', false],
    ['vite:*', false],
    ['unplugin-denox', false],
    ['unplugin', false],
    ['', false],
  ])('DEBUG=%j -> %s', (value, expected) => {
    expect(isDebugEnabled({ DEBUG: value })).toBe(expected)
  })

  it('is off without DEBUG', () => {
    expect(isDebugEnabled({})).toBe(false)
  })
})

describe('createConsoleLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prefixes lines and hides debug output unless enabled', () => {
    const { lines, sink } = capture()
    const logger = createConsoleLogger({ debug: false, sink })
    logger.error('e')
    logger.warn('w')
    logger.info('i')
    logger.debug('[config] d')
    logger.downloading('https://jsr.io/x')
    expect(logger.debugEnabled).toBe(false)
    expect(lines).toEqual([
      ['error', '[unplugin-deno] e'],
      ['warn', '[unplugin-deno] w'],
      ['info', '[unplugin-deno] i'],
    ])
  })

  it('emits debug and download lines when enabled', () => {
    const { lines, sink } = capture()
    const logger = createConsoleLogger({ debug: true, sink })
    logger.debug('[config] found deno.json')
    logger.downloading('https://jsr.io/@std/path/meta.json')
    expect(lines).toEqual([
      ['debug', '[unplugin-deno] [config] found deno.json'],
      ['debug', '[unplugin-deno] [engine] Downloading https://jsr.io/@std/path/meta.json'],
    ])
  })

  it('writes to stderr through console.error and console.warn by default', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = createConsoleLogger({ debug: true })
    logger.error('e')
    logger.info('i')
    logger.debug('d')
    expect(error.mock.calls).toEqual([['[unplugin-deno] e']])
    expect(warn.mock.calls).toEqual([['[unplugin-deno] i'], ['[unplugin-deno] d']])
  })

  it('reads DEBUG when debug is not given', () => {
    vi.stubEnv('DEBUG', 'unplugin-deno')
    expect(createConsoleLogger({ sink: () => {} }).debugEnabled).toBe(true)
    vi.stubEnv('DEBUG', '')
    expect(createConsoleLogger({ sink: () => {} }).debugEnabled).toBe(false)
  })
})

describe('createSilentLogger', () => {
  it('discards everything', () => {
    const error = vi.spyOn(console, 'error')
    const warn = vi.spyOn(console, 'warn')
    const logger = createSilentLogger()
    logger.error('e')
    logger.warn('w')
    logger.info('i')
    logger.debug('d')
    logger.downloading('u')
    expect(logger.debugEnabled).toBe(false)
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})
