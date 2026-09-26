/**
 * Every stable error code of {@link DenoPluginError}. Tools may branch on codes; messages may
 * change between releases.
 */
export const ERROR_CODES = [
  /** A plugin option has an invalid value. */
  'OPTIONS_INVALID',
  /** The configured `deno.json(c)` does not exist. */
  'CONFIG_NOT_FOUND',
  /** A `deno.json(c)` or `package.json` cannot be parsed or has an invalid shape. */
  'CONFIG_INVALID',
  /** An import map (`imports`/`scopes` or an `importMap` file) is invalid. */
  'IMPORT_MAP_INVALID',
  /** `deno.lock` cannot be parsed or has an unsupported version. */
  'LOCKFILE_INVALID',
  /** A specifier resolves to a module that does not exist. */
  'RESOLVE_NOT_FOUND',
  /** A package subpath is not exported by the package's `exports`. */
  'RESOLVE_NOT_EXPORTED',
  /** A bare specifier is neither in the import map nor a dependency. */
  'RESOLVE_UNMAPPED_BARE',
  /** No published version satisfies a `jsr:`/`npm:` version constraint. */
  'RESOLVE_CONSTRAINT',
  /** Resolution failed for another reason (the cause has details). */
  'RESOLVE_FAILED',
  /** A dependency is missing from `deno.lock`, so `cachedOnly` cannot resolve it. */
  'NOT_IN_LOCKFILE',
  /**
   * The lockfile is frozen (`lockfile: 'frozen'`, or `'auto'` with `CI` set) and a resolution is
   * missing from `deno.lock` or differs from it.
   */
  'LOCKFILE_FROZEN_DRIFT',
  /** `cachedOnly: true` and a module is not in the cache. */
  'CACHED_ONLY_MISS',
  /** A remote import targets a host that is not in `allowImport`. */
  'DISALLOWED_HOST',
  /** Downloaded content does not match the integrity recorded in `deno.lock`. */
  'INTEGRITY_MISMATCH',
  /** A file cannot be written to the mirror (`cacheDir`). */
  'MIRROR_WRITE_FAILED',
  /** The requested engine (or feature) is not available in this environment or version. */
  'ENGINE_UNAVAILABLE',
  /** A module has a media type the host cannot handle. */
  'UNSUPPORTED_MEDIA_TYPE',
  /**
   * A module uses an API its platform lacks: `Deno.*` in a browser bundle with
   * `denoGlobals: 'error'`.
   */
  'PLATFORM_INCOMPATIBLE',
] as const

/** A stable error code; see {@link ERROR_CODES}. */
export type ErrorCode = (typeof ERROR_CODES)[number]

/** Optional details of a {@link DenoPluginError}. */
export interface DenoPluginErrorOptions {
  /** What the user can do about it, e.g. "run `deno install`". */
  hint?: string | undefined
  /** The specifier being resolved or loaded, when the error is about one. */
  specifier?: string | undefined
  /** The importing module (path or URL), when known. */
  importer?: string | undefined
  /** The underlying error. */
  cause?: unknown
}

/** The error type thrown by unplugin-deno. Branch on {@link DenoPluginError.code}, not on the message. */
export class DenoPluginError extends Error {
  override readonly name = 'DenoPluginError'
  /** Stable error code. */
  readonly code: ErrorCode
  /** What the user can do about it. */
  readonly hint: string | undefined
  /** The specifier being resolved or loaded, when the error is about one. */
  readonly specifier: string | undefined
  /** The importing module (path or URL), when known. */
  readonly importer: string | undefined

  /**
   * @param code Stable error code.
   * @param message One sentence describing what went wrong.
   * @param options Hint, specifier, importer and cause.
   */
  constructor(code: ErrorCode, message: string, options: DenoPluginErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined)
    this.code = code
    this.hint = options.hint
    this.specifier = options.specifier
    this.importer = options.importer
  }

  /** Formats the error the way hosts print it: `[unplugin-deno] <message> (<code>)` plus the hint. */
  format(): string {
    const head = `[unplugin-deno] ${this.message} (${this.code})`
    return this.hint === undefined ? head : `${head}\n  hint: ${this.hint}`
  }
}

const errorCodes: ReadonlySet<string> = new Set(ERROR_CODES)

/**
 * Whether `value` is a {@link DenoPluginError}, also when it comes from another copy of this
 * package (so `instanceof` would fail).
 */
export function isDenoPluginError(value: unknown): value is DenoPluginError {
  if (value instanceof DenoPluginError) return true
  if (!(value instanceof Error) || value.name !== 'DenoPluginError') return false
  const code: unknown = (value as { code?: unknown }).code
  return typeof code === 'string' && errorCodes.has(code)
}
