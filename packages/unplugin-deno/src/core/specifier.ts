import { splitQuery } from './id.js'

/**
 * What an import specifier refers to (docs/architecture.md §2):
 * - a Deno scheme: `jsr:`, `npm:`, `https:`, `http:`, `data:`, `node:`, `bun:`, `cloudflare:`,
 *   `file:`;
 * - `bare`: not URL-like (`react`, `@std/path/join`, `#internal`);
 * - `relative`: `.`, `..`, `./x`, `../x`;
 * - `absolute`: an absolute path (`/x`, `C:\x`, `C:/x`, `\\server\share\x`);
 * - `unknown-scheme`: any other scheme (`virtual:x`, `mailto:x`) and `\0`-prefixed virtual ids.
 */
export type SpecifierKind =
  | 'jsr'
  | 'npm'
  | 'https'
  | 'http'
  | 'data'
  | 'node'
  | 'bun'
  | 'cloudflare'
  | 'file'
  | 'bare'
  | 'relative'
  | 'absolute'
  | 'unknown-scheme'

/** A classified specifier. */
export interface ParsedSpecifier {
  /** The input, unchanged. */
  raw: string
  kind: SpecifierKind
  /** `raw` without {@link ParsedSpecifier.query}. */
  base: string
  /**
   * Everything from the first `?` (including any `#` fragment), verbatim, or `''`. Never split
   * inside a `data:` URL payload (see `splitQuery` in `core/id.ts`). For `https:`/`http:` URLs
   * the query is usually part of the resource (`?target=es2022`); callers resolving remote URLs
   * decide whether to keep it.
   */
  query: string
}

/** A parsed `npm:` specifier. */
export interface NpmSpecifier {
  /** Package name, e.g. `kleur` or `@scope/name`. */
  name: string
  /** Version range or tag as written (`^4`, `latest`), when present. */
  range?: string
  /** `''` or the subpath with its leading slash, e.g. `/colors`. */
  subpath: string
}

/** A parsed `jsr:` specifier; JSR package names are always scoped. */
export interface JsrSpecifier {
  /** Package name, e.g. `@std/path`. */
  name: string
  /** Version range as written (`^1`, `1.1.6`), when present. */
  range?: string
  /** `''` or the subpath with its leading slash, e.g. `/join`. */
  subpath: string
}

const DENO_SCHEME_KINDS: ReadonlySet<SpecifierKind> = new Set<SpecifierKind>([
  'jsr',
  'npm',
  'https',
  'http',
  'data',
  'node',
  'bun',
  'cloudflare',
  'file',
])

const SCHEME = /^([a-zA-Z][a-zA-Z\d+\-.]*):/

/**
 * Classifies an import specifier or module id and splits off its query
 * (docs/architecture.md §2). Never throws.
 */
export function parseSpecifier(raw: string): ParsedSpecifier {
  if (raw.startsWith('\0') || raw.startsWith('virtual:')) {
    return { raw, kind: 'unknown-scheme', base: raw, query: '' }
  }
  const { base, query } = splitQuery(raw)
  return { raw, kind: classify(base), base, query }
}

function classify(base: string): SpecifierKind {
  if (isWindowsAbsolutePath(base) || base.startsWith('/')) return 'absolute'
  if (base === '.' || base === '..' || base.startsWith('./') || base.startsWith('../')) {
    return 'relative'
  }
  const scheme = SCHEME.exec(base)?.[1]
  if (scheme === undefined) return 'bare'
  const kind = scheme.toLowerCase()
  return DENO_SCHEME_KINDS.has(kind as SpecifierKind) ? (kind as SpecifierKind) : 'unknown-scheme'
}

/** `C:\x`, `C:/x`, `C:` alone, `\\server\share\x` and `\\?\C:\x`. */
function isWindowsAbsolutePath(text: string): boolean {
  return /^[a-zA-Z]:(?:[\\/]|$)/.test(text) || text.startsWith('\\\\')
}

/**
 * Whether `kind` is one of the schemes the plugin owns (`jsr:`, `npm:`, `https:`, `http:`,
 * `data:`, `node:`, `bun:`, `cloudflare:`, `file:`), i.e. part of the `resolveId` filter
 * (docs/architecture.md §5.2).
 */
export function isDenoScheme(kind: SpecifierKind): boolean {
  return DENO_SCHEME_KINDS.has(kind)
}

interface PackageParts {
  name: string
  range?: string
  subpath: string
}

/**
 * Splits `[/]name[@range][/subpath]` the way Deno does (`deno_semver`'s
 * `PackageReq::parse_with_path`): an optional leading `/` (from import-map prefix entries such as
 * `npm:/preact@10/`), a scoped or unscoped name, a range after the last `@` of the name segment,
 * and the rest as subpath. Returns `null` for a missing name or an empty range.
 */
function parsePackageParts(input: string): PackageParts | null {
  const text = input.startsWith('/') ? input.slice(1) : input
  const segments = text.split('/')
  const scoped = segments[0]?.startsWith('@') ?? false
  const nameSegments = scoped ? 2 : 1
  const head = segments.slice(0, nameSegments)
  if (head.length < nameSegments || head.some((segment) => segment === '')) return null
  const last = head.at(-1) ?? ''
  const at = last.lastIndexOf('@')
  const hasRange = at >= 0
  const lastName = hasRange ? last.slice(0, at) : last
  const range = hasRange ? last.slice(at + 1) : undefined
  if (lastName === '' || range === '') return null
  const name = scoped ? `${head[0] ?? ''}/${lastName}` : lastName
  const rest = segments.slice(nameSegments).join('/')
  const subpath = rest === '' ? '' : `/${rest}`
  return range === undefined ? { name, subpath } : { name, range, subpath }
}

/**
 * Parses `npm:[/]name[@range][/subpath]` (also `@scope/name`). A `/` alone as subpath counts as
 * none. Returns `null` when `specifier` is not a valid `npm:` specifier.
 */
export function parseNpmSpecifier(specifier: string): NpmSpecifier | null {
  if (!specifier.startsWith('npm:')) return null
  return parsePackageParts(specifier.slice(4))
}

/**
 * Parses `jsr:[/]@scope/name[@range][/subpath]`. Returns `null` when `specifier` is not a valid
 * `jsr:` specifier (JSR package names are always scoped).
 */
export function parseJsrSpecifier(specifier: string): JsrSpecifier | null {
  if (!specifier.startsWith('jsr:')) return null
  const parts = parsePackageParts(specifier.slice(4))
  return parts !== null && parts.name.startsWith('@') ? parts : null
}

/** Formats an {@link NpmSpecifier} as `npm:name[@range][subpath]`. */
export function formatNpmSpecifier(specifier: NpmSpecifier): string {
  return `npm:${formatPackageParts(specifier)}`
}

/** Formats a {@link JsrSpecifier} as `jsr:@scope/name[@range][subpath]`. */
export function formatJsrSpecifier(specifier: JsrSpecifier): string {
  return `jsr:${formatPackageParts(specifier)}`
}

function formatPackageParts({ name, range, subpath }: PackageParts): string {
  const normalizedSubpath = subpath === '/' ? '' : subpath
  const slash = normalizedSubpath === '' || normalizedSubpath.startsWith('/') ? '' : '/'
  return `${name}${range === undefined ? '' : `@${range}`}${slash}${normalizedSubpath}`
}
