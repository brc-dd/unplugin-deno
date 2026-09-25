import { normalizeDriveLetter } from './path.js'

/** `url` with a trailing `/` added when missing (a directory URL). */
export function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/**
 * The directory URL (with a trailing `/`) of a file or directory URL:
 * `file:///a/b.ts` → `file:///a/`, `file:///a/b/` → `file:///a/b/`. Query and hash are dropped.
 */
export function urlDirname(url: string | URL): string {
  const parsed = new URL(url)
  parsed.search = ''
  parsed.hash = ''
  return new URL('./', parsed).href
}

/**
 * Normalises a URL the way Deno serialises it, for comparisons and results that must be equal
 * on every runtime: parses and re-serialises it, keeps `^` unencoded in hierarchical URLs (the
 * current WHATWG URL standard, followed by Node.js and Bun, encodes it as `%5E`; Deno's resolver
 * uses the `url` crate, which does not), and upper-cases a Windows drive letter in `file:` URLs
 * (`file:///c:/x` → `file:///C:/x`). Returns `undefined` for strings that are not absolute URLs.
 */
export function normalizeUrl(url: string | URL): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const href = hasOpaquePath(parsed) ? parsed.href : parsed.href.replace(/%5E/gi, '^')
  return parsed.protocol === 'file:' ? normalizeDriveLetter(href) : href
}

/**
 * Whether `url` has an opaque path, i.e. cannot be a base URL for relative references:
 * `jsr:@std/path@^1/`, `npm:preact/`, `data:text/plain,x` (but not `jsr:/@std/path@^1/`).
 */
export function hasOpaquePath(url: URL): boolean {
  return url.host === '' && !url.pathname.startsWith('/') && !isSpecialScheme(url.protocol)
}

const SPECIAL_SCHEMES: ReadonlySet<string> = new Set([
  'ftp:',
  'file:',
  'http:',
  'https:',
  'ws:',
  'wss:',
])

/**
 * Whether `protocol` (with the trailing `:`) is a WHATWG "special" scheme (`ftp`, `file`, `http`,
 * `https`, `ws`, `wss`).
 */
export function isSpecialScheme(protocol: string): boolean {
  return SPECIAL_SCHEMES.has(protocol)
}

/**
 * Percent-decodes `text`, replacing invalid UTF-8 byte sequences with U+FFFD (like Rust's
 * `percent_decode_str(..).decode_utf8_lossy()`). Malformed `%` escapes are kept verbatim.
 */
export function percentDecodeLossy(text: string): string {
  if (!text.includes('%')) return text
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let i = 0; i < text.length;) {
    const hex = text.slice(i + 1, i + 3)
    if (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16))
      i += 3
      continue
    }
    const codePoint = text.codePointAt(i) ?? 0
    const char = String.fromCodePoint(codePoint)
    bytes.push(...encoder.encode(char))
    i += char.length
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes))
}
