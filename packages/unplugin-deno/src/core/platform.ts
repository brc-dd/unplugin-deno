/**
 * The platform model and the externals policy (docs/architecture.md §5.6): which platform the
 * output runs on, the export conditions and engine platform that follow from it, `deno bundle`
 * style `external`/`bundle` patterns, and pinning of external `npm:`/`jsr:` specifiers.
 *
 * @module
 */
import type { Lockfile, Project } from '../config/project.js'
import type { ResolvedModule } from '../engine/types.js'
import type { Pattern, Platform, ResolvedOptions } from './options.js'
import { pinExternalsFor } from './options.js'
import type { ParsedSpecifier } from './specifier.js'
import {
  formatJsrSpecifier,
  formatNpmSpecifier,
  parseJsrSpecifier,
  parseNpmSpecifier,
} from './specifier.js'

/** The platform hints a host adapter reports (`HostContext.platformHint`). */
export type PlatformHint = 'browser' | 'node' | 'neutral' | 'deno'

/**
 * The platform of a build (§5.6), from explicit options first and the project shape second, never
 * from the runtime executing the build:
 *
 * 1. `options.platform` when it names a platform, or its entry for `environmentName` (Vite);
 * 2. the host's hint: `browser` and `deno` are taken as they are;
 * 3. otherwise (`node`/`neutral` hints, or hosts without one such as Rollup): `deno` when the
 *    project has a `deno.json(c)`, else `node`.
 */
export function derivePlatform(
  options: Pick<ResolvedOptions, 'platform'>,
  host: { platformHint?: PlatformHint | undefined },
  project: Pick<Project, 'configPath'>,
  environmentName?: string,
): Platform {
  const configured = options.platform
  if (typeof configured === 'string') {
    if (configured !== 'auto') return configured
  } else if (environmentName !== undefined) {
    const platform = configured[environmentName]
    if (platform !== undefined) return platform
  }
  const hint = host.platformHint
  if (hint === 'browser' || hint === 'deno') return hint
  return project.configPath === null ? 'node' : 'deno'
}

/**
 * The export conditions the engine adds for `platform` (its own defaults cover `import`,
 * `default`, and `browser` for the browser platform): `deno` for the Deno platform, then `extra`
 * (host conditions and the `conditions` option), without duplicates.
 */
export function conditionsFor(platform: Platform, extra: readonly string[]): string[] {
  return [...new Set([...(platform === 'deno' ? ['deno'] : []), ...extra])]
}

/** The engine platform: `browser` for the browser, `node` for everything else (§5.6). */
export function enginePlatformFor(platform: Platform): 'browser' | 'node' {
  return platform === 'browser' ? 'browser' : 'node'
}

/**
 * Whether `specifier` (or any of several spellings of one import, e.g. the bare name and its
 * import-map target) matches one of `patterns`, with `deno bundle`'s rules:
 *
 * - a RegExp is tested against each spelling;
 * - a string with `*` is a wildcard pattern (`npm:*`, `jsr:@std/*`, `https://esm.sh/*`);
 * - any other string matches exactly, or as a package prefix (`npm:kleur` matches
 *   `npm:kleur/colors`).
 *
 * `npm:`/`jsr:` specifiers also match without their version: `npm:kleur@^4/colors` is tried as
 * `npm:kleur/colors` too, so `bundle: ['npm:kleur']` covers every range and subpath.
 */
export function matchPattern(
  patterns: readonly Pattern[],
  specifier: string | readonly string[],
): boolean {
  if (patterns.length === 0) return false
  const candidates = specifierForms(typeof specifier === 'string' ? [specifier] : specifier)
  return patterns.some((pattern) => candidates.some((candidate) => matchOne(pattern, candidate)))
}

function specifierForms(specifiers: readonly string[]): string[] {
  const result = new Set<string>()
  for (const specifier of specifiers) {
    result.add(specifier)
    const npm = parseNpmSpecifier(specifier)
    if (npm !== null) result.add(formatNpmSpecifier({ name: npm.name, subpath: npm.subpath }))
    const jsr = parseJsrSpecifier(specifier)
    if (jsr !== null) result.add(formatJsrSpecifier({ name: jsr.name, subpath: jsr.subpath }))
  }
  return [...result]
}

function matchOne(pattern: Pattern, candidate: string): boolean {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0
    return pattern.test(candidate)
  }
  if (pattern.includes('*')) return wildcard(pattern).test(candidate)
  if (candidate === pattern) return true
  return candidate.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`)
}

const wildcards = new Map<string, RegExp>()

function wildcard(pattern: string): RegExp {
  let regex = wildcards.get(pattern)
  if (regex === undefined) {
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    regex = new RegExp(`^${source}$`)
    wildcards.set(pattern, regex)
  }
  return regex
}

/**
 * The exact-version form of an external `npm:`/`jsr:` specifier (§5.6): `npm:<name>@<version>
 * <subpath>` from the npm package the engine resolved, `jsr:@scope/name@<version><subpath>` from the
 * JSR module URL (`https://jsr.io/@scope/name/<version>/…`), and otherwise the version pinned in
 * `deno.lock`. `original` is the specifier handed to the engine (after import-map mapping); its
 * subpath is kept. Returns `null` when no version is known or `original` is not a package
 * specifier.
 */
export function pinSpecifier(
  resolved: ResolvedModule,
  original: string,
  lockfile?: Pick<Lockfile, 'pin'> | null,
): string | null {
  const npm = parseNpmSpecifier(original)
  const jsr = npm === null ? parseJsrSpecifier(original) : null
  const info = resolved.npm
  if (resolved.kind === 'npm' && info !== undefined && info.version !== '') {
    const subpath = npm !== null && npm.name === info.name ? npm.subpath : info.subpath
    return formatNpmSpecifier({ name: info.name, range: info.version, subpath })
  }
  if (jsr !== null && resolved.kind === 'remote') {
    const version = jsrVersion(resolved.url, jsr.name)
    if (version !== undefined) {
      return formatJsrSpecifier({ name: jsr.name, range: version, subpath: jsr.subpath })
    }
  }
  if (npm === null && jsr === null) return null
  return lockfile?.pin(original) ?? null
}

/** The version segment of a JSR module URL (`<registry>/@scope/name/<version>/<file>`). */
function jsrVersion(url: string, name: string): string | undefined {
  const parsed = URL.parse(url)
  if (parsed === null) return undefined
  const [scope, packageName, version] = parsed.pathname.split('/').slice(1)
  if (`${scope}/${packageName}` !== name || version === undefined || version === '') {
    return undefined
  }
  return decodeURIComponent(version)
}

/** An external module, kept as an import in the output. */
export interface ExternalOutcome {
  type: 'external'
  id: string
}

/**
 * Whether the externals policy keeps an import external (§5.2 step 2, §5.6): `bun:`/`cloudflare:`
 * always; `node:` except for the browser platform (left to the host); patterns in `bundle` never;
 * patterns in `external` always; and `npm:`/`jsr:` specifiers (bare names mapped to them included)
 * on the Deno platform. `spellings` are other forms of the same import (the bare name before
 * import-map mapping) matched against the patterns.
 */
export function isExternal(
  spec: ParsedSpecifier,
  options: Pick<ResolvedOptions, 'bundle' | 'external'>,
  platform: Platform,
  spellings: readonly string[] = [],
): boolean {
  if (spec.kind === 'bun' || spec.kind === 'cloudflare') return true
  if (spec.kind === 'node') return platform !== 'browser'
  const candidates = [spec.base, ...spellings]
  if (matchPattern(options.bundle, candidates)) return false
  if (matchPattern(options.external, candidates)) return true
  return platform === 'deno' && (spec.kind === 'npm' || spec.kind === 'jsr')
}

/**
 * The external outcome of an import (§5.6), or `null` when it is bundled. `resolved` is the
 * engine's resolution of `spec`, needed to pin `npm:`/`jsr:` specifiers when `pinExternals`
 * applies; without it (or without a known version) the specifier is kept as written.
 */
export function externalOutcomeFor(
  spec: ParsedSpecifier,
  resolved: ResolvedModule | undefined,
  options: Pick<ResolvedOptions, 'bundle' | 'external' | 'pinExternals'>,
  platform: Platform,
  lockfile?: Pick<Lockfile, 'pin'> | null,
  spellings: readonly string[] = [],
): ExternalOutcome | null {
  if (!isExternal(spec, options, platform, spellings)) return null
  if (spec.kind === 'node') return { type: 'external', id: spec.base }
  const pin =
    (spec.kind === 'npm' || spec.kind === 'jsr') &&
    resolved !== undefined &&
    pinExternalsFor(options, platform)
  return { type: 'external', id: (pin && pinSpecifier(resolved, spec.base, lockfile)) || spec.base }
}
