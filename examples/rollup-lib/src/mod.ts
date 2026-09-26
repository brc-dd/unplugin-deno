/**
 * Formats file sizes as an aligned table:
 *
 * ```
 * app.js     12.3 kB
 * vendor.js   4.1 kB
 * ```
 *
 * @module
 */
import { sortBy } from '@std/collections/sort-by'
import { format as formatBytes } from '@std/fmt/bytes'
import stringWidth from 'string-width'

/** A file and its size. */
export interface FileSize {
  name: string
  bytes: number
}

/** Formats `files` as a table, largest first, with names aligned on screen (CJK and emoji too). */
export function sizeTable(files: readonly FileSize[]): string {
  const rows = sortBy(files, (file) => file.bytes, { order: 'desc' })
  const width = Math.max(0, ...rows.map((row) => stringWidth(row.name)))
  const sizes = rows.map((row) => formatBytes(row.bytes))
  const sizeWidth = Math.max(0, ...sizes.map((size) => size.length))
  return rows
    .map((row, index) => {
      const padding = ' '.repeat(width - stringWidth(row.name))
      return `${row.name}${padding}  ${sizes[index]!.padStart(sizeWidth)}`
    })
    .join('\n')
}
