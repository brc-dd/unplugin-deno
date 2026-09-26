/**
 * Host facts from esbuild's build options (docs/architecture.md §6.4): the root (`absWorkingDir`),
 * the platform hint, the export conditions and the entry points, plus the plugin options esbuild's
 * `packages: 'external'` implies.
 *
 * @module
 */
import type { BuildOptions } from 'esbuild'
import type { JsxTransform } from '../../core/jsx.js'
import type { ResolvedOptions } from '../../core/options.js'
import type { StateHints } from '../../core/state.js'

/** The `external` patterns `packages: 'external'` adds (Deno packages stay imports). */
const PACKAGE_PATTERNS = ['npm:*', 'jsr:*'] as const

/** The entry points of a build as the core reads them: the `in` path of `{ in, out }` entries. */
export function entryInput(
  entryPoints: BuildOptions['entryPoints'],
): string[] | Record<string, string> {
  if (entryPoints === undefined) return []
  if (Array.isArray(entryPoints)) {
    return entryPoints.map((entry) => (typeof entry === 'string' ? entry : entry.in))
  }
  return { ...entryPoints }
}

/** The entry point paths of a build (the values of {@link entryInput}). */
export function entryList(entryPoints: BuildOptions['entryPoints']): string[] {
  const input = entryInput(entryPoints)
  return Array.isArray(input) ? input : Object.values(input)
}

/**
 * The state hints of a build: the root is `absWorkingDir` (esbuild's default is the process's
 * working directory); esbuild's `platform` is the platform hint — `browser` (esbuild's default
 * when unset) gives the browser platform, `node` and `neutral` give `deno` for projects with a
 * `deno.json` and `node` otherwise (docs/architecture.md §5.6; the `platform` option wins).
 */
export function hintsFor(options: BuildOptions, version: string | undefined): StateHints {
  return {
    root: options.absWorkingDir ?? process.cwd(),
    platform: options.platform ?? 'browser',
    conditions: options.conditions,
    input: entryInput(options.entryPoints),
    version,
    command: 'build',
  }
}

/**
 * Identifies the build options a loaded project depends on: the root, the platform, the
 * conditions and `packages`. Builds sharing one plugin instance must agree on them.
 */
export function settingsKey(options: BuildOptions): string {
  return JSON.stringify([
    options.absWorkingDir ?? process.cwd(),
    options.platform ?? null,
    options.conditions ?? null,
    options.packages === 'external',
  ])
}

/**
 * The plugin options for a build: with `packages: 'external'`, `npm:` and `jsr:` specifiers (and
 * bare names the import map maps to them) are kept external and pinned, as for the Deno platform
 * (§5.6); explicit `pinExternals` wins. `base` is the core's resolution of the user options.
 */
export function buildOptions(base: ResolvedOptions, packagesExternal: boolean): ResolvedOptions {
  if (!packagesExternal) return base
  const external = [...base.external]
  for (const pattern of PACKAGE_PATTERNS) if (!external.includes(pattern)) external.push(pattern)
  return { ...base, external, pinExternals: base.pinExternals ?? true }
}

/** esbuild's JSX options; any of them set (or in `tsconfigRaw`) means JSX is configured. */
const JSX_OPTIONS = ['jsx', 'jsxFactory', 'jsxFragment', 'jsxImportSource', 'jsxDev'] as const

/** The `tsconfig` JSX keys esbuild reads. */
const TSCONFIG_JSX_KEYS = ['jsx', 'jsxFactory', 'jsxFragmentFactory', 'jsxImportSource'] as const

/** Whether the build options configure JSX (then the `deno.json` settings are not applied). */
export function configuresJsx(options: BuildOptions): boolean {
  if (JSX_OPTIONS.some((key) => options[key] !== undefined)) return true
  const raw = options.tsconfigRaw
  const tsconfig: unknown = typeof raw === 'string' ? parseJsonObject(raw) : raw
  const compilerOptions: unknown =
    typeof tsconfig === 'object' && tsconfig !== null
      ? (tsconfig as { compilerOptions?: unknown }).compilerOptions
      : undefined
  return (
    typeof compilerOptions === 'object' &&
    compilerOptions !== null &&
    TSCONFIG_JSX_KEYS.some((key) => (compilerOptions as Record<string, unknown>)[key] !== undefined)
  )
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/**
 * Applies a JSX transform of `deno.json` to esbuild's build options (docs/architecture.md §5.11):
 * `jsx: 'automatic'` with `jsxImportSource` (and `jsxDev` for `react-jsxdev`), or
 * `jsx: 'transform'` with `jsxFactory` and `jsxFragment`. esbuild reads build options changed in a
 * plugin's `setup`.
 */
export function applyJsx(options: BuildOptions, transform: JsxTransform): void {
  if (transform.runtime === 'classic') {
    options.jsx = 'transform'
    options.jsxFactory = transform.factory
    options.jsxFragment = transform.fragment
    return
  }
  options.jsx = 'automatic'
  options.jsxImportSource = transform.importSource
  if (transform.development) options.jsxDev = true
}

/**
 * Adds `process.env.<KEY>` entries for the inlined environment variables to esbuild's `define`
 * (L9: esbuild has no transform hook, so `Deno.env.get()` reads are not inlined), keeping the
 * entries the build defines itself. Keys that are not identifiers cannot be `define` keys.
 */
export function defineEnv(options: BuildOptions, entries: ReadonlyArray<[string, string]>): void {
  const define = { ...options.define }
  let changed = false
  for (const [key, value] of entries) {
    const name = `process.env.${key}`
    if (!/^[A-Za-z_$][\w$]*$/.test(key) || define[name] !== undefined) continue
    define[name] = JSON.stringify(value)
    changed = true
  }
  if (changed) options.define = define
}
