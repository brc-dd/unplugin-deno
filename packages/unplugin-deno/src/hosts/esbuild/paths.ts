/**
 * esbuild paths of the modules the plugin synthesises in its namespace. esbuild prints them in
 * output comments, source maps and the metafile as `unplugin-deno:<path>`, so they are relative to
 * the root (like esbuild's own paths of files) with `/` separators, and never contain `\0`.
 *
 * @module
 */
import { posix, win32 } from 'node:path'
import { DENO_VIRTUAL_PREFIX, isDenoVirtualId, splitQuery } from '../../core/id.js'
import type { PathFlavor } from '../../utils/path.js'
import { HOST_PATH_FLAVOR } from '../../utils/path.js'

/**
 * The esbuild path of a marker id (`/root/src/data.txt?deno-type=text` →
 * `src/data.txt?deno-type=text`): the file relative to `root`, `/`-separated, with the query.
 */
export function displayPath(
  root: string,
  id: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): string {
  const syntax = flavor === 'win32' ? win32 : posix
  const { base, query } = splitQuery(id)
  const relative = syntax.relative(root, base)
  return `${flavor === 'win32' ? relative.replaceAll('\\', '/') : relative}${query}`
}

/** The esbuild path of one of the plugin's virtual ids (`\0deno:empty` → `empty`). */
export function virtualDisplayPath(id: string): string {
  return isDenoVirtualId(id) ? id.slice(DENO_VIRTUAL_PREFIX.length) : id
}
