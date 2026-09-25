import { createHash } from 'node:crypto'

/** Hex SHA-256 of a string (hashed as UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The first `length` hex characters of {@link sha256Hex}: 8 for mirror generations, 16 for
 * `data:` URL file names (see docs/architecture.md §5.3).
 */
export function shortHash(data: string | Uint8Array, length = 8): string {
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new RangeError(`shortHash length must be an integer between 1 and 64, got ${length}`)
  }
  return sha256Hex(data).slice(0, length)
}
