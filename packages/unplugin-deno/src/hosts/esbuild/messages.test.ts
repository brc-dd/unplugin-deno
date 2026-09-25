import { describe, expect, it } from 'vitest'
import { DenoPluginError } from '../../diagnostics/errors.js'
import { toMessage, WarningBuffer } from './messages.js'

describe('toMessage', () => {
  it('shows the code and the hint of a DenoPluginError, and keeps the error', () => {
    const error = new DenoPluginError('CACHED_ONLY_MISS', 'Not cached.', {
      hint: 'Run `deno install`.',
    })
    expect(toMessage(error)).toEqual({
      text: 'Not cached. (CACHED_ONLY_MISS)',
      notes: [{ text: 'hint: Run `deno install`.' }],
      detail: error,
    })
    expect(toMessage(new DenoPluginError('RESOLVE_FAILED', 'Failed.')).notes).toEqual([])
  })

  it('shows other errors and values as they are', () => {
    const error = new TypeError('boom')
    expect(toMessage(error)).toEqual({ text: 'boom', detail: error })
    expect(toMessage('plain')).toEqual({ text: 'plain', detail: 'plain' })
  })
})

describe('WarningBuffer', () => {
  it('keeps warnings until they are drained', () => {
    const buffer = new WarningBuffer()
    buffer.warn('first')
    const { warn } = buffer
    warn('second')
    expect(buffer.drain()).toEqual([{ text: 'first' }, { text: 'second' }])
    expect(buffer.drain()).toEqual([])
    expect('info' in buffer).toBe(false)
  })
})
