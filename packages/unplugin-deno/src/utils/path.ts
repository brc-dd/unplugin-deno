import { posix, win32 } from 'node:path'

/**
 * Which path syntax to use: `win32` (`C:\dir\file`, `\\server\share\file`) or `posix`.
 * Every helper defaults to the flavour of the current OS; tests pass both explicitly.
 */
export type PathFlavor = 'posix' | 'win32'

/** The path flavour of the current OS. */
export const HOST_PATH_FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix'

/**
 * Upper-cases a Windows drive letter in a path or file URL (`c:\x`, `c:/x`, `/c:/x`,
 * `file:///c:/x`, `\\?\c:\x`), the one place drive-letter case is normalised. Other input is
 * returned unchanged.
 */
export function normalizeDriveLetter(pathOrUrl: string): string {
  return pathOrUrl.replace(
    /^(file:\/\/\/|\/|\\\\\?\\)?([a-z])(?=:(?:[\\/]|$))/,
    (_match: string, prefix: string | undefined, letter: string) =>
      `${prefix ?? ''}${letter.toUpperCase()}`,
  )
}

/**
 * Converts a `file:` URL to an OS path (like `url.fileURLToPath`, with explicit flavour and
 * normalised drive-letter case).
 *
 * @throws {TypeError} For non-`file:` URLs, encoded path separators, a host on POSIX, or a
 *   Windows URL without a drive letter or host.
 */
export function toPath(url: string | URL, flavor: PathFlavor = HOST_PATH_FLAVOR): string {
  const parsed = typeof url === 'string' ? new URL(url) : url
  if (parsed.protocol !== 'file:') {
    throw new TypeError(`Expected a file: URL, got ${parsed.href}`)
  }
  const { hostname, pathname } = parsed
  if (flavor === 'win32') {
    if (/%2f|%5c/i.test(pathname)) {
      throw new TypeError(
        `File URL path must not include encoded \\ or / characters: ${parsed.href}`,
      )
    }
    const path = decodeURIComponent(pathname).replaceAll('/', '\\')
    if (hostname !== '') return `\\\\${hostname}${path}`
    if (!/^\\[a-zA-Z]:/.test(path)) {
      throw new TypeError(`File URL path must be absolute (with a drive letter): ${parsed.href}`)
    }
    return normalizeDriveLetter(path.slice(1))
  }
  if (hostname !== '') {
    throw new TypeError(`File URL host must be empty or "localhost" on POSIX: ${parsed.href}`)
  }
  if (/%2f/i.test(pathname)) {
    throw new TypeError(`File URL path must not include encoded / characters: ${parsed.href}`)
  }
  return decodeURIComponent(pathname)
}

/**
 * Converts an absolute OS path to a `file:` URL string (like `url.pathToFileURL`, with explicit
 * flavour). Windows drive letters are upper-cased; `\\?\` long-path prefixes are removed.
 *
 * @throws {TypeError} For relative paths (and drive-relative or rootless Windows paths).
 */
export function toFileUrl(path: string, flavor: PathFlavor = HOST_PATH_FLAVOR): string {
  const url = new URL('file://')
  if (flavor === 'win32') {
    let input = path
    if (input.startsWith('\\\\?\\UNC\\')) input = `\\\\${input.slice(8)}`
    else if (input.startsWith('\\\\?\\')) input = input.slice(4)
    input = input.replaceAll('/', '\\')
    const unc = /^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/.exec(input)
    if (unc) {
      url.hostname = unc[1] ?? ''
      const rest = win32.normalize(`\\${unc[2] ?? ''}${unc[3] ?? ''}`)
      url.pathname = encodePathChars(rest.replaceAll('\\', '/'), flavor)
      return url.href
    }
    if (!/^[a-zA-Z]:\\/.test(input)) {
      throw new TypeError(`Expected an absolute Windows path with a drive letter, got ${path}`)
    }
    const normalized = normalizeDriveLetter(win32.normalize(input))
    url.pathname = encodePathChars(`/${normalized.replaceAll('\\', '/')}`, flavor)
    return url.href
  }
  if (!posix.isAbsolute(path)) {
    throw new TypeError(`Expected an absolute path, got ${path}`)
  }
  url.pathname = encodePathChars(posix.normalize(path), flavor)
  return url.href
}

/** Pre-encodes the characters the URL `pathname` setter would drop or misread. */
function encodePathChars(path: string, flavor: PathFlavor): string {
  let result = path.replaceAll('%', '%25')
  if (flavor === 'posix') result = result.replaceAll('\\', '%5C')
  return result.replaceAll('\n', '%0A').replaceAll('\r', '%0D').replaceAll('\t', '%09')
}

/**
 * Whether `child` is `parent` itself or inside it. Both must be absolute paths of the given
 * flavour. Segment-aware (`/a/bc` is not inside `/a/b`); case-insensitive on Windows.
 */
export function isSubpath(
  parent: string,
  child: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): boolean {
  const path = flavor === 'win32' ? win32 : posix
  const relative = path.relative(parent, child)
  if (relative === '') return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/**
 * The relative URL reference from the module at `from` to `to`, starting with `./` or `../`,
 * such that `new URL(result, from).href === new URL(to).href`. Used for import specifiers
 * between mirror files. Percent-encoding, query and hash of `to` are kept. When no relative
 * reference exists (different scheme, host or Windows drive), `to` is returned as an absolute URL.
 */
export function relativeUrlPath(from: string | URL, to: string | URL): string {
  const source = new URL(from)
  const target = new URL(to)
  if (
    source.protocol !== target.protocol ||
    source.host !== target.host ||
    source.username !== target.username ||
    source.password !== target.password
  ) {
    return target.href
  }
  const fromDir = source.pathname.split('/').slice(1, -1)
  const toSegments = target.pathname.split('/').slice(1)
  if (source.protocol === 'file:' && driveOf(fromDir[0]) !== driveOf(toSegments[0])) {
    return target.href
  }
  let common = 0
  while (
    common < fromDir.length &&
    common < toSegments.length - 1 &&
    sameSegment(fromDir[common], toSegments[common], common === 0 && source.protocol === 'file:')
  ) {
    common++
  }
  const up = fromDir.length - common
  const prefix = up === 0 ? './' : '../'.repeat(up)
  return `${prefix}${toSegments.slice(common).join('/')}${target.search}${target.hash}`
}

/** The upper-cased drive letter of a Windows drive segment (`C:`), or `undefined`. */
function driveOf(segment: string | undefined): string | undefined {
  return segment !== undefined && /^[a-zA-Z]:$/.test(segment) ? segment.toUpperCase() : undefined
}

function sameSegment(a: string | undefined, b: string | undefined, maybeDrive: boolean): boolean {
  if (a === b) return true
  if (!maybeDrive || a === undefined || b === undefined) return false
  const drive = driveOf(a)
  return drive !== undefined && drive === driveOf(b)
}

/**
 * Converts an absolute directory path to a `file:` URL string that ends with `/`, the form used
 * for import-map scopes and workspace member directories (`/a/b` → `file:///a/b/`).
 *
 * @throws {TypeError} For relative paths, like {@link toFileUrl}.
 */
export function toDirUrl(path: string, flavor: PathFlavor = HOST_PATH_FLAVOR): string {
  const url = toFileUrl(path, flavor)
  return url.endsWith('/') ? url : `${url}/`
}
