import { describe, expect, it } from 'vitest'
import { sha256Hex, shortHash } from './hash.js'

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes strings as UTF-8 and bytes as-is', () => {
    expect(sha256Hex('✓')).toBe(sha256Hex(new TextEncoder().encode('✓')))
  })
})

describe('shortHash', () => {
  it('returns a prefix of the full hash', () => {
    expect(shortHash('abc')).toBe('ba7816bf')
    expect(shortHash('abc', 16)).toBe('ba7816bf8f01cfea')
  })

  it('rejects invalid lengths', () => {
    expect(() => shortHash('abc', 0)).toThrow(RangeError)
    expect(() => shortHash('abc', 65)).toThrow(RangeError)
    expect(() => shortHash('abc', 1.5)).toThrow(RangeError)
  })
})
