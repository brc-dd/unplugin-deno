/**
 * Maps failures of the vendored `@deno/loader` to {@link DenoPluginError}s
 * (docs/architecture.md §4.2). Codes come from structured data only: `ResolveError.code` (set for
 * Node.js resolution failures), the error class and the kind of specifier. Message text selects at
 * most a hint, as a last resort ({@link lastResortHint}).
 *
 * @module
 */
import { stripVTControlCharacters } from 'node:util'
import type { DenoPluginErrorOptions, ErrorCode } from '../../diagnostics/errors.js'
import { DenoPluginError, isDenoPluginError } from '../../diagnostics/errors.js'
import { EngineResolveError } from '../errors.js'
import { isPackageRequirement, parsePackageSpecifier } from '../package-specifier.js'

/** A class to test errors against with `instanceof` (the vendored loader's `ResolveError`). */
export type ErrorClass = abstract new (...args: never) => Error

/** What {@link toDenoPluginError} knows about the failed operation. */
export interface LoaderErrorContext {
  /** The specifier being resolved, or the URL being loaded. */
  specifier: string
  /** The referrer passed to `resolve`, when there was one. */
  referrer?: string | undefined
  /** The failed operation; default `resolve`. */
  operation?: 'resolve' | 'load' | undefined
  /**
   * The `jsr:`/`npm:` requirement the loader's synchronous resolution produced for `specifier`
   * (the import map target of a bare specifier), used to classify errors without a code.
   */
  mapped?: string | undefined
  /** The vendored loader's `ResolveError`; other errors are generic failures. */
  resolveErrorClass?: ErrorClass | undefined
  /** A better explanation than the error message: the graph diagnostic of the failed root. */
  detail?: string | undefined
  /** The module is missing from the Deno cache and downloads are disabled (`cachedOnly`). */
  cachedOnlyMiss?: boolean | undefined
}

/** Hints shown with each error code (the message says what failed; the hint says what to do). */
export const HINTS = {
  notFound:
    'Check the import path. For npm packages, run `deno install` (or set `"nodeModulesDir": "auto"` in deno.json).',
  optionalDependency:
    'It is an optional dependency of the importing package and is not installed; install it or mark it external.',
  notExported:
    'The package does not export this subpath; import one of the entry points listed in its `exports`.',
  constraint:
    'No published version satisfies the version constraint; check the version range (and `minimumDependencyAge` in deno.json).',
  cachedOnly: 'Run `deno install` to download it into the Deno cache, or turn off `cachedOnly`.',
  resolveFirst: 'Resolve the specifier first and load the URL it resolves to.',
  relativeFromNonHierarchical:
    'Relative imports need a `file:` or `http(s):` importer; use an absolute URL or a mapped specifier.',
} as const

/**
 * Converts an error thrown by the loader into a {@link DenoPluginError}:
 *
 * | Error | Code |
 * | --- | --- |
 * | already a `DenoPluginError` | unchanged |
 * | `context.cachedOnlyMiss` | `CACHED_ONLY_MISS` |
 * | `ResolveError` with `code: 'ERR_MODULE_NOT_FOUND'` | `RESOLVE_NOT_FOUND` ({@link EngineResolveError}, `isOptionalDependency` kept) |
 * | `ResolveError` with `code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'` | `RESOLVE_NOT_EXPORTED` |
 * | `ResolveError` with another code | `RESOLVE_FAILED` |
 * | `ResolveError` without a code | by specifier, see {@link classifyUnresolved} |
 * | anything else (load failures, panics) | `RESOLVE_FAILED` |
 */
export function toDenoPluginError(error: unknown, context: LoaderErrorContext): DenoPluginError {
  if (isDenoPluginError(error)) return error
  const cause = errorFields(error)
  const detail = clean(context.detail ?? cause.message)
  const options: DenoPluginErrorOptions = {
    specifier: context.specifier,
    importer: context.referrer,
    cause: error,
  }
  if (context.cachedOnlyMiss === true) {
    return new DenoPluginError('CACHED_ONLY_MISS', cachedOnlyMessage(context), {
      ...options,
      hint: HINTS.cachedOnly,
    })
  }
  const message = `${subject(context)}: ${detail}`
  const isResolveError =
    context.resolveErrorClass !== undefined && error instanceof context.resolveErrorClass
  if (!isResolveError) {
    return new DenoPluginError('RESOLVE_FAILED', message, {
      ...options,
      hint: lastResortHint(detail),
    })
  }
  switch (cause.code) {
    case 'ERR_MODULE_NOT_FOUND':
      return new EngineResolveError('RESOLVE_NOT_FOUND', message, {
        ...options,
        hint: cause.isOptionalDependency ? HINTS.optionalDependency : HINTS.notFound,
        isOptionalDependency: cause.isOptionalDependency,
      })
    case 'ERR_PACKAGE_PATH_NOT_EXPORTED':
      return new DenoPluginError('RESOLVE_NOT_EXPORTED', message, {
        ...options,
        hint: HINTS.notExported,
      })
    case undefined: {
      const target =
        (cause.specifier !== undefined && isPackageRequirement(cause.specifier)
          ? cause.specifier
          : undefined) ??
        context.mapped ??
        context.specifier
      return codelessError(target, message, detail, options)
    }
    default:
      return new DenoPluginError('RESOLVE_FAILED', message, {
        ...options,
        hint: lastResortHint(detail),
      })
  }
}

/**
 * The error for a specifier the loader returned unresolved: its asynchronous `resolve()` yields
 * the `jsr:`/`npm:` requirement itself when the package cannot be resolved (no version matches,
 * unknown package or export), recording the reason only in the graph (`context.detail`).
 */
export function unresolvedRequirementError(
  requirement: string,
  context: LoaderErrorContext,
): DenoPluginError {
  const options: DenoPluginErrorOptions = {
    specifier: context.specifier,
    importer: context.referrer,
  }
  if (context.cachedOnlyMiss === true) {
    return new DenoPluginError('CACHED_ONLY_MISS', cachedOnlyMessage(context), {
      ...options,
      hint: HINTS.cachedOnly,
    })
  }
  const detail = clean(context.detail ?? `the loader could not resolve ${requirement}.`)
  return codelessError(requirement, `${subject(context)}: ${detail}`, detail, options)
}

/**
 * The code for a resolution failure without a Node.js error code, from the kind of `target` (the
 * specifier, or the `jsr:`/`npm:` requirement it maps to):
 *
 * - a bare specifier (not in the import map, not a dependency) → `RESOLVE_UNMAPPED_BARE`;
 * - an `npm:` requirement with a version constraint, or a `jsr:` one with a constraint and no
 *   subpath → `RESOLVE_CONSTRAINT` (npm subpath failures always carry a Node.js code; a `jsr:`
 *   subpath failure may also be an unknown export, which only the message tells apart);
 * - anything else → `RESOLVE_FAILED`.
 */
export function classifyUnresolved(target: string): ErrorCode {
  const parsed = parsePackageSpecifier(target)
  if (parsed === undefined) return 'RESOLVE_FAILED'
  if (parsed.scheme === 'bare') return 'RESOLVE_UNMAPPED_BARE'
  if (parsed.version !== undefined && (parsed.scheme === 'npm' || parsed.subpath === '')) {
    return 'RESOLVE_CONSTRAINT'
  }
  return 'RESOLVE_FAILED'
}

function codelessError(
  target: string,
  message: string,
  detail: string,
  options: DenoPluginErrorOptions,
): DenoPluginError {
  const code = classifyUnresolved(target)
  switch (code) {
    case 'RESOLVE_UNMAPPED_BARE': {
      const name = parsePackageSpecifier(target)?.name ?? target
      return new DenoPluginError(code, message, {
        ...options,
        hint: `Add "${name}" to \`imports\` in deno.json (\`deno add jsr:${name}\` or \`deno add npm:${name}\`), or import it with a \`jsr:\`/\`npm:\` specifier.`,
      })
    }
    case 'RESOLVE_CONSTRAINT':
      // The registry may not know the package at all; only the message tells.
      return new DenoPluginError(code, message, {
        ...options,
        hint: lastResortHint(detail) ?? HINTS.constraint,
      })
    default:
      return new DenoPluginError(code, message, { ...options, hint: lastResortHint(detail) })
  }
}

/**
 * LAST RESORT, hint only: picks a hint for a `RESOLVE_FAILED` (or `RESOLVE_CONSTRAINT`) error
 * from the loader's message. Codes never depend on message text; if upstream rewords a message,
 * only the hint is lost.
 */
const MESSAGE_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bUnknown export\b/i, HINTS.notExported],
  [/\bversion constraint\b|\bmatching '/i, HINTS.constraint],
  [
    /\bpackage not found\b|\bdoes not exist\b/i,
    'Check the package name and that it is published to the registry.',
  ],
  [/\bnode_modules\b/i, HINTS.notFound],
  [
    /\bnot prefixed with\b/i,
    'Relative imports must start with `./` or `../`; bare names must be mapped in deno.json `imports`.',
  ],
  [/\bUnsupported scheme\b/i, 'Deno cannot load this scheme; mark the import as external.'],
  [
    /\berror sending request\b|\bfetch failed\b|\bnetwork\b|\bECONN\w*|\bENOTFOUND\b|\btimed? ?out\b/i,
    'Check the network connection and proxy settings (a custom `fetch` can be passed to the plugin).',
  ],
  [/\bnot found\b/i, 'Check that the module exists at that path or URL.'],
]

/**
 * The hint for a message, chosen by {@link MESSAGE_HINTS} (the last resort described there), or
 * `undefined` when nothing matches.
 */
export function lastResortHint(message: string): string | undefined {
  return MESSAGE_HINTS.find(([pattern]) => pattern.test(message))?.[1]
}

function subject(context: LoaderErrorContext): string {
  if (context.operation === 'load') return `Cannot load "${context.specifier}"`
  const from = context.referrer === undefined ? '' : ` from "${context.referrer}"`
  return `Cannot resolve "${context.specifier}"${from}`
}

function cachedOnlyMessage(context: LoaderErrorContext): string {
  return `${subject(context)}: it is not in the Deno cache and \`cachedOnly\` is set.`
}

/** Message text without terminal colors or trailing whitespace. */
function clean(text: string): string {
  return stripVTControlCharacters(text).trim()
}

interface ErrorFields {
  message: string
  code: string | undefined
  specifier: string | undefined
  isOptionalDependency: boolean
}

function errorFields(error: unknown): ErrorFields {
  if (typeof error !== 'object' || error === null) {
    return {
      message: String(error),
      code: undefined,
      specifier: undefined,
      isOptionalDependency: false,
    }
  }
  const record = error as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : String(error)
  return {
    message,
    code: typeof record.code === 'string' ? record.code : undefined,
    specifier: typeof record.specifier === 'string' ? record.specifier : undefined,
    isOptionalDependency: record.isOptionalDependency === true,
  }
}
