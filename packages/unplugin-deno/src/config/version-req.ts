// Semver helpers for the version requirements Deno accepts in `jsr:`/`npm:` specifiers, ported
// from `deno_semver` (MIT, https://github.com/denoland/deno_semver, `src/specifier.rs`,
// `src/range.rs`): parsing (`~partial`, `^partial`, `partial` with x-ranges, or a tag), the
// normalised text Deno writes as `deno.lock` `specifiers` keys (`^1` → `1`, `~1.2` → `1.2`,
// `^1.2` → `^1.2.0`), and matching versions against a requirement (workspace members, links).

/** A semantic version. */
export interface SemVer {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers (`1.0.0-rc.1` → `['rc', '1']`). */
  pre: string[]
  /** Build metadata identifiers (ignored when comparing). */
  build: string[]
}

/** One side of a {@link VersionRange}; `null` means unbounded. */
export type RangeBound = { version: SemVer; inclusive: boolean } | null

/** A contiguous range of versions. */
export interface VersionRange {
  start: RangeBound
  end: RangeBound
}

/** A parsed version requirement: a range or a dist-tag such as `latest`. */
export type VersionReq = { type: 'range'; range: VersionRange } | { type: 'tag'; tag: string }

const NR = '0|[1-9]\\d*'
const XR = `[xX*]|${NR}`
const PARTS = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*'
const PARTIAL = new RegExp(
  `^([~^])?(${XR})(?:\\.(${XR})(?:\\.(${XR})(?:-(${PARTS}))?(?:\\+(${PARTS}))?)?)?$`,
)
const PARTIAL_START = new RegExp(`^[~^]?(?:${XR})`)
const VERSION = new RegExp(
  `^=?\\s*v?\\s*(${NR})\\.(${NR})\\.(${NR})(?:-(${PARTS}))?(?:\\+(${PARTS}))?$`,
)

/**
 * Parses a version (`1.2.3`, `1.2.3-rc.1+build`, with an optional leading `=`/`v`, like
 * `deno_semver`'s npm version parsing). Returns `null` for anything else.
 */
export function parseVersion(text: string): SemVer | null {
  const match = VERSION.exec(text.trim())
  if (match === null) return null
  const [, major = '0', minor = '0', patch = '0', pre, build] = match
  const numbers = [major, minor, patch].map(Number)
  if (!numbers.every(Number.isSafeInteger)) return null
  return {
    major: numbers[0] ?? 0,
    minor: numbers[1] ?? 0,
    patch: numbers[2] ?? 0,
    pre: pre === undefined ? [] : pre.split('.'),
    build: build === undefined ? [] : build.split('.'),
  }
}

/** Formats a version as `major.minor.patch[-pre][+build]`. */
export function formatVersion(version: SemVer): string {
  const pre = version.pre.length === 0 ? '' : `-${version.pre.join('.')}`
  const build = version.build.length === 0 ? '' : `+${version.build.join('.')}`
  return `${version.major}.${version.minor}.${version.patch}${pre}${build}`
}

/** Compares two versions by precedence (node-semver rules; build metadata is ignored). */
export function compareVersions(a: SemVer, b: SemVer): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (core !== 0) return Math.sign(core)
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1
  }
  for (let i = 0; ; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined || y === undefined) {
      return x === y ? 0 : x === undefined ? -1 : 1
    }
    const result = compareIdentifiers(x, y)
    if (result !== 0) return result
  }
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b))
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Parses a version requirement as written in a `jsr:`/`npm:` specifier (`deno_semver`'s
 * `parse_version_req_from_specifier`): `~partial`, `^partial`, `partial` (x-ranges such as `1`,
 * `1.x`, `*`), or a dist-tag. Returns `null` when invalid (e.g. `>=1`, `1 || 2`, `01`).
 */
export function parseSpecifierVersionReq(text: string): VersionReq | null {
  const match = PARTIAL.exec(text)
  if (match === null) {
    if (PARTIAL_START.test(text)) return null
    return isValidTag(text) ? { type: 'tag', tag: text } : null
  }
  const [, operator, major, minor, patch, pre, build] = match
  const partial: Partial = {
    major: xrange(major),
    minor: xrange(minor),
    patch: xrange(patch),
    pre: pre === undefined ? [] : pre.split('.'),
    build: build === undefined ? [] : build.split('.'),
  }
  const range =
    operator === '~'
      ? tildeRange(partial)
      : operator === '^'
        ? caretRange(partial)
        : equalRange(partial)
  return { type: 'range', range }
}

/** npm's dist-tag rule: anything that does not get URL-encoded. */
function isValidTag(text: string): boolean {
  return text.trim() !== '' && /^[\p{L}\p{N}\-_.~]+$/u.test(text)
}

/** A version with wildcard (`null`) parts. */
interface Partial {
  major: number | null
  minor: number | null
  patch: number | null
  pre: string[]
  build: string[]
}

function xrange(text: string | undefined): number | null {
  return text === undefined || /^[xX*]$/.test(text) ? null : Number(text)
}

function makeVersion(major: number, minor = 0, patch = 0, pre: string[] = []): SemVer {
  return { major, minor, patch, pre, build: [] }
}

const ALL: VersionRange = { start: null, end: null }

function lowerBound(partial: Partial): RangeBound {
  return {
    version: {
      major: partial.major ?? 0,
      minor: partial.minor ?? 0,
      patch: partial.patch ?? 0,
      pre: partial.pre,
      build: partial.build,
    },
    inclusive: true,
  }
}

function tildeRange(partial: Partial): VersionRange {
  if (partial.major === null) return ALL
  const end =
    partial.minor === null
      ? makeVersion(partial.major + 1)
      : makeVersion(partial.major, partial.minor + 1)
  return { start: lowerBound(partial), end: { version: end, inclusive: false } }
}

function caretRange(partial: Partial): VersionRange {
  const { major, minor, patch } = partial
  if (major === null) return ALL
  let end: SemVer
  if (major > 0 || minor === null) end = makeVersion(major + 1)
  else if (minor > 0 || patch === null) end = makeVersion(0, minor + 1)
  else end = makeVersion(0, 0, patch + 1)
  return { start: lowerBound(partial), end: { version: end, inclusive: false } }
}

function equalRange(partial: Partial): VersionRange {
  const { major, minor, patch } = partial
  if (major === null) return ALL
  if (minor === null || patch === null) {
    // `as_greater_range(Inclusive)`: `1` → [1.0.0, 2.0.0), `1.2` → [1.2.0, 1.3.0),
    // `1.x.3` → [1.0.3, 2.0.3); prerelease and build parts are dropped.
    const start = makeVersion(major, minor ?? 0, patch ?? 0)
    const end =
      minor === null ? makeVersion(major + 1, 0, patch ?? 0) : makeVersion(major, minor + 1, 0)
    return { start: { version: start, inclusive: true }, end: { version: end, inclusive: false } }
  }
  const exact: SemVer = { major, minor, patch, pre: partial.pre, build: partial.build }
  return { start: { version: exact, inclusive: true }, end: { version: exact, inclusive: true } }
}

/**
 * The normalised text of a requirement, as Deno writes it into `deno.lock` `specifiers` keys
 * (`deno_semver`'s `VersionRange` display): `^1` → `1`, `^1.2` → `^1.2.0`, `~1.2` → `1.2`,
 * `~1.2.3` → `~1.2.3`, `^0.1.2` → `~0.1.2`, `*` → `*`, tags unchanged.
 */
export function normalizeVersionReq(req: VersionReq): string {
  return req.type === 'tag' ? req.tag : formatRange(req.range)
}

function formatRange({ start, end }: VersionRange): string {
  if (start === null) {
    if (end === null) return '*'
    return `${end.inclusive ? '<=' : '<'}${formatVersion(end.version)}`
  }
  if (end === null) return `${start.inclusive ? '>=' : '>'}${formatVersion(start.version)}`
  const s = start.version
  const e = end.version
  if (start.inclusive && end.inclusive) {
    if (compareExact(s, e)) return formatVersion(s)
    if (isZero(s)) return `<=${formatVersion(e)}`
    return `>=${formatVersion(s)} <=${formatVersion(e)}`
  }
  if (start.inclusive) {
    const plain =
      s.pre.length === 0 && s.build.length === 0 && e.pre.length === 0 && e.build.length === 0
    if (plain && s.patch === 0 && e.patch === 0) {
      if (s.minor === 0 && e.minor === 0) {
        if (e.major === s.major + 1) return `${s.major}`
      } else if (s.major === e.major && e.minor === s.minor + 1) {
        return `${s.major}.${s.minor}`
      }
    }
    if (matchesTilde(s, e)) return `~${formatVersion(s)}`
    if (matchesCaret(s, e)) return `^${formatVersion(s)}`
    if (isZero(s)) return `<${formatVersion(e)}`
    return `>=${formatVersion(s)} <${formatVersion(e)}`
  }
  return `>${formatVersion(s)} ${end.inclusive ? '<=' : '<'}${formatVersion(e)}`
}

function matchesTilde(s: SemVer, e: SemVer): boolean {
  if (e.build.length > 0 || e.pre.length > 0 || s.major !== e.major) return false
  if (s.minor === e.minor) return e.patch === s.patch && s.pre.length > 0
  return e.minor === s.minor + 1 && e.patch === 0
}

function matchesCaret(s: SemVer, e: SemVer): boolean {
  if (e.build.length > 0 || e.pre.length > 0) return false
  if (s.major === 0) {
    return s.minor === 0 && e.minor === 0 && e.patch === s.patch + 1
  }
  return e.major === s.major + 1 && e.minor === 0 && e.patch === 0
}

function isZero(v: SemVer): boolean {
  return (
    v.major === 0 && v.minor === 0 && v.patch === 0 && v.pre.length === 0 && v.build.length === 0
  )
}

function compareExact(a: SemVer, b: SemVer): boolean {
  return formatVersion(a) === formatVersion(b)
}

/**
 * Whether `version` satisfies `req` (`deno_semver`'s `VersionRange::satisfies`): prerelease
 * versions only match when a bound has a prerelease on the same `major.minor.patch`. Tags never
 * match.
 */
export function satisfies(version: SemVer, req: VersionReq): boolean {
  if (req.type === 'tag') return false
  const { start, end } = req.range
  const aboveStart =
    start === null || compareVersions(version, start.version) > (start.inclusive ? -1 : 0)
  const belowEnd = end === null || compareVersions(version, end.version) < (end.inclusive ? 1 : 0)
  if (!aboveStart || !belowEnd) return false
  if (version.pre.length === 0) return true
  return [start, end].some(
    (bound) =>
      bound !== null &&
      bound.version.pre.length > 0 &&
      bound.version.major === version.major &&
      bound.version.minor === version.minor &&
      bound.version.patch === version.patch,
  )
}
