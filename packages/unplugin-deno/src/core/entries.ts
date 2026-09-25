/**
 * Entrypoints for `engine.addEntrypoints` (docs/architecture.md §4.1): host inputs (a string, an
 * array or a name → module record; absolute or root-relative paths, or specifiers) normalised to
 * `file:` URLs and specifiers the engine accepts.
 *
 * @module
 */
import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR, toFileUrl } from '../utils/path.js'
import { isForeignId, isVirtualId } from './id.js'
import { parseSpecifier } from './specifier.js'

/** The input shapes hosts use (Rollup/Rolldown `input`, esbuild `entryPoints`, …). */
export type HostInput =
  | string
  | readonly string[]
  | Readonly<Record<string, string>>
  | null
  | undefined

/** Options of {@link normalizeEntries}. */
export interface NormalizeEntriesOptions {
  /** Whether a path is a file (tests inject one); default: a synchronous `stat`. */
  isFile?: (path: string) => boolean
  flavor?: PathFlavor
}

/**
 * Normalises host inputs for the engine, without duplicates and in input order:
 *
 * - absolute paths and paths starting with `./`/`../` → `file:` URLs (relative to `root`);
 * - `file:`, `jsr:`, `npm:`, `http(s):` and `data:` specifiers → as they are;
 * - other bare values → a `file:` URL when `<root>/<value>` is a file (`src/main.ts`), otherwise
 *   the value (an import-map key the engine maps);
 * - virtual ids, `virtual:` specifiers and `node:`/`bun:`/other schemes → skipped.
 */
export function normalizeEntries(
  input: HostInput,
  root: string,
  options: NormalizeEntriesOptions = {},
): string[] {
  const values: readonly string[] =
    input === null || input === undefined
      ? []
      : typeof input === 'string'
        ? [input]
        : Array.isArray(input)
          ? (input as readonly string[])
          : Object.values(input)
  const result: string[] = []
  for (const value of values) {
    const entry = normalizeEntry(value, root, options)
    if (entry !== undefined && !result.includes(entry)) result.push(entry)
  }
  return result
}

function normalizeEntry(
  value: string,
  root: string,
  options: NormalizeEntriesOptions,
): string | undefined {
  if (value === '' || isVirtualId(value) || isForeignId(value)) return undefined
  const flavor = options.flavor ?? HOST_PATH_FLAVOR
  const syntax = flavor === 'win32' ? win32 : posix
  // `.\x.ts` is a relative path on Windows (specifiers only use `/`).
  if (flavor === 'win32' && /^\.{1,2}\\/.test(value)) {
    return toFileUrl(syntax.resolve(root, value), flavor)
  }
  const spec = parseSpecifier(value)
  switch (spec.kind) {
    case 'absolute':
      return toFileUrl(syntax.resolve(spec.base), flavor)
    case 'relative':
      return toFileUrl(syntax.resolve(root, spec.base), flavor)
    case 'file':
    case 'jsr':
    case 'npm':
    case 'https':
    case 'http':
    case 'data':
      return value
    case 'bare': {
      const candidate = syntax.resolve(root, spec.base)
      return (options.isFile ?? isFile)(candidate) ? toFileUrl(candidate, flavor) : spec.base
    }
    default:
      return undefined
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
