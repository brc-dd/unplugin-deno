/**
 * Spells out durations: `humanize('90m')` is `'1h 30m'`.
 *
 * @module
 */
import { format } from '@std/fmt/duration'
import ms from 'ms'

/**
 * Parses a duration such as `'90m'` or `'1.5 days'` and spells it out (`'1h 30m'`).
 *
 * @throws {RangeError} when the text is not a duration.
 */
export function humanize(duration: string): string {
  const milliseconds: number | undefined = ms(duration)
  if (milliseconds === undefined) throw new RangeError(`Not a duration: ${duration}`)
  return format(milliseconds, { ignoreZero: true }) || '0ms'
}
