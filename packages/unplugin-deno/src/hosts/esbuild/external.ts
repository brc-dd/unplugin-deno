/**
 * esbuild's own `external` option (docs/architecture.md §6.4). esbuild checks `external` and
 * `packages: 'external'` only when no plugin's `onResolve` callback resolved an import (verified
 * with esbuild 0.28.2), so the adapter leaves the import paths the user marked external alone and
 * esbuild keeps them as written.
 *
 * @module
 */
import type { ImportKind } from 'esbuild'

/** A pattern with esbuild's single `*` wildcard. */
interface Wildcard {
  prefix: string
  suffix: string
}

/**
 * Whether esbuild calls `path` a package path: anything that does not start with `/`, `./` or
 * `../` (so `jsr:@std/path` and `https://x` are package paths too).
 */
function isPackagePath(path: string): boolean {
  return (
    !path.startsWith('/') &&
    !path.startsWith('./') &&
    !path.startsWith('../') &&
    path !== '.' &&
    path !== '..'
  )
}

/**
 * A predicate for the import paths esbuild's `external` patterns mark external before resolution:
 * a pattern with a `*` wildcard matches by prefix and suffix; a package path matches itself and
 * its subpaths (`jsr:@std` matches `jsr:@std/path`). Entry points are never external. Patterns
 * esbuild applies to resolved absolute paths (`./x.js`, `/abs/*.png`) do not concern the plugin:
 * it never resolves relative imports of local files.
 */
export function externalMatcher(
  patterns: readonly string[] | undefined,
): (path: string, kind: ImportKind) => boolean {
  const exact = new Set<string>()
  const wildcards: Wildcard[] = []
  for (const pattern of patterns ?? []) {
    const star = pattern.indexOf('*')
    if (star !== -1) {
      wildcards.push({ prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1) })
    } else if (isPackagePath(pattern)) {
      exact.add(pattern)
    }
  }
  if (exact.size === 0 && wildcards.length === 0) return () => false
  return (path, kind) => {
    if (kind === 'entry-point') return false
    for (const { prefix, suffix } of wildcards) {
      if (
        path.length >= prefix.length + suffix.length &&
        path.startsWith(prefix) &&
        path.endsWith(suffix)
      ) {
        return true
      }
    }
    if (!isPackagePath(path)) return false
    for (let candidate = path; ;) {
      if (exact.has(candidate)) return true
      const slash = candidate.lastIndexOf('/')
      if (slash === -1) return false
      candidate = candidate.slice(0, slash)
    }
  }
}
