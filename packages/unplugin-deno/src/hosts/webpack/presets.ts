/**
 * webpack's and Rspack's scheme externals presets (docs/architecture.md §6.5, §6.6, plan S6).
 * `externalsPresets.web` (webpack's default for web targets; since webpack 5.102 it also covers
 * `jsr:` and `npm:`, Rspack's covers `http(s):`) and webpack ≥ 5.108's `target: 'deno'` preset keep
 * Deno specifiers external before any resolver runs, reading the request as written. The adapters
 * therefore turn off the presets the user did not set explicitly once the host has applied its
 * defaults (the `environment` hook runs before the presets are applied), resolve their own
 * requests first, and apply the presets to every request the plugin leaves to the host, so
 * nothing else changes (CSS `url()` and `@import` of remote URLs, `//` and `std:` imports, bare
 * Node.js builtins on `target: 'deno'`). Presets the user set explicitly are kept, and run after
 * the plugin's externals. The adapters log what they decided at info level.
 *
 * @module
 */
import { isBuiltin } from 'node:module'

/** The webpack (and Rspack) external types the adapters produce. */
export type ExternalType =
  | 'module'
  | 'import'
  | 'module-import'
  | 'node-commonjs'
  | 'asset'
  | 'css-import'

/** A native external: the request kept in the output and its external type. */
export interface ExternalResult {
  request: string
  type: ExternalType
}

/** A host preset the adapter turned off and applies to the requests it leaves to the host. */
export type TakenPreset =
  | {
      /** `externalsPresets.web` / `webAsync`. */
      kind: 'web'
      /** Whether the preset matches `jsr:` and `npm:` too (webpack ≥ 5.102; not Rspack). */
      schemes: boolean
      /** `webAsync`: `import()` externals instead of `import` statements. */
      async: boolean
      /** Whether CSS `@import`s of remote URLs become `css-import` externals. */
      css: boolean
    }
  | {
      /** webpack's `externalsPresets.deno` (`target: 'deno'`). */
      kind: 'deno'
    }

/** The `externalsPresets` fields the adapters read and change. */
export interface ExternalsPresetsOptions {
  web?: boolean | undefined
  webAsync?: boolean | undefined
  deno?: boolean | undefined
}

/** The presets a user set in the config, recorded before the host applies its defaults. */
export type ExplicitPresets = Readonly<ExternalsPresetsOptions>

/** What {@link takeOverPresets} decided. */
export interface PresetDecision {
  /** Presets turned off, in the order the host would apply them. */
  taken: TakenPreset[]
  /** Presets the user enabled explicitly (`web`, `webAsync`, `deno`), which stay on. */
  kept: string[]
}

const CSS_IMPORT = /^css-import/
/** webpack ≥ 5.102's web preset: the requests it looks at, and those kept as modules. */
const WEBPACK_WEB_ANY = /^(?:\/\/|https?:\/\/|#|std:|jsr:|npm:)/
const WEBPACK_WEB_MODULE = /^(?:\/\/|https?:\/\/|std:|jsr:|npm:)/
/** Rspack's `HttpExternalsRspackPlugin`: URLs in CSS and `url()`, modules otherwise. */
const RSPACK_WEB_URL = /^(?:\/\/|https?:\/\/|#)/
const RSPACK_WEB_MODULE = /^(?:\/\/|https?:\/\/|std:)/
const CSS_REQUEST = /\.css(?:\?|$)/
/** webpack's `DenoTargetPlugin`: Deno resolves these protocols at runtime. */
const DENO_PROTOCOLS = /^(?:npm|jsr|https?):/

/**
 * Turns off the presets of `presets` (defaults applied) that would keep the plugin's specifiers
 * external, unless the user set them explicitly (`explicit`, read before the defaults), and
 * returns what to apply after the plugin. `host` selects the host's preset semantics; `css` is
 * whether the host handles CSS `@import` (`experiments.css` on webpack, always on Rspack).
 */
export function takeOverPresets(
  presets: ExternalsPresetsOptions,
  explicit: ExplicitPresets,
  host: 'webpack' | 'rspack',
  css: boolean,
): PresetDecision {
  const decision: PresetDecision = { taken: [], kept: [] }
  if (presets.deno === true) {
    if (explicit.deno === undefined) {
      presets.deno = false
      decision.taken.push({ kind: 'deno' })
    } else {
      decision.kept.push('deno')
    }
  }
  const async = presets.webAsync === true
  if (presets.web === true || async) {
    if (explicit.web === undefined && explicit.webAsync === undefined) {
      presets.web = false
      presets.webAsync = false
      decision.taken.push({ kind: 'web', schemes: host === 'webpack', async, css })
    } else {
      decision.kept.push(async ? 'webAsync' : 'web')
    }
  }
  return decision
}

/**
 * The external a taken-over preset makes of a request the plugin leaves to the host (webpack's
 * `DenoTargetPlugin` first, as webpack applies it before the web preset), or `undefined`.
 */
export function presetExternal(
  presets: readonly TakenPreset[],
  request: string,
  dependencyType: string,
): ExternalResult | undefined {
  for (const preset of presets) {
    const external =
      preset.kind === 'deno'
        ? denoExternal(request, dependencyType)
        : preset.schemes
          ? webpackWebExternal(preset, request, dependencyType)
          : rspackWebExternal(preset, request, dependencyType)
    if (external !== undefined) return external
  }
  return undefined
}

function denoExternal(request: string, dependencyType: string): ExternalResult | undefined {
  const type = dependencyType === 'commonjs' ? 'node-commonjs' : 'module-import'
  if (request.startsWith('node:') || DENO_PROTOCOLS.test(request)) return { request, type }
  // Deno reaches Node.js builtins only through `node:` (`fs` → `node:fs`).
  if (!request.includes(':') && isBuiltin(request)) return { request: `node:${request}`, type }
  return undefined
}

function webpackWebExternal(
  preset: Extract<TakenPreset, { kind: 'web' }>,
  request: string,
  dependencyType: string,
): ExternalResult | undefined {
  if (!WEBPACK_WEB_ANY.test(request)) return undefined
  if (dependencyType === 'url') return { request, type: 'asset' }
  if (preset.css && CSS_IMPORT.test(dependencyType)) return { request, type: 'css-import' }
  if (WEBPACK_WEB_MODULE.test(request)) {
    return { request, type: preset.async ? 'import' : 'module' }
  }
  return undefined
}

function rspackWebExternal(
  preset: Extract<TakenPreset, { kind: 'web' }>,
  request: string,
  dependencyType: string,
): ExternalResult | undefined {
  if (dependencyType === 'url') {
    return RSPACK_WEB_URL.test(request) ? { request, type: 'asset' } : undefined
  }
  if (CSS_IMPORT.test(dependencyType)) {
    return preset.css && RSPACK_WEB_URL.test(request) ? { request, type: 'css-import' } : undefined
  }
  if (!RSPACK_WEB_MODULE.test(request)) return undefined
  if (preset.css && CSS_REQUEST.test(request)) return { request, type: 'css-import' }
  return { request, type: preset.async ? 'import' : 'module' }
}

/**
 * The info lines describing a {@link PresetDecision} (and a `buildHttp` allow-list, which leaves
 * the URLs it allows to the host), prefixed with the host (`[webpack]`, `[rspack]`).
 */
export function presetMessages(
  decision: PresetDecision,
  host: 'webpack' | 'rspack',
  buildHttp: boolean,
): string[] {
  const prefix = `[${host}]`
  const messages: string[] = []
  for (const preset of decision.taken) {
    if (preset.kind === 'deno') {
      messages.push(
        `${prefix} target deno: unplugin-deno applies its externals to Deno specifiers (npm: and jsr: stay external, pinned to the resolved versions; https: is bundled unless the \`external\` option names it); webpack's deno preset still handles the other imports (bare Node.js builtins become node: externals).`,
      )
    } else {
      const schemes = preset.schemes ? 'jsr:, npm: and https:' : 'https:'
      messages.push(
        `${prefix} externalsPresets.${preset.async ? 'webAsync' : 'web'}: unplugin-deno resolves ${schemes} imports itself; the preset still keeps other URLs (CSS url() and @import, // and std: imports) external.`,
      )
    }
  }
  for (const name of decision.kept) {
    messages.push(
      `${prefix} externalsPresets.${name} is set in the config: ${host} keeps the Deno specifiers it matches external as written, except those unplugin-deno keeps external itself (pinned).`,
    )
  }
  if (buildHttp) {
    messages.push(
      `${prefix} experiments.buildHttp is set: ${host} fetches the http(s) imports it allows; unplugin-deno resolves the others.`,
    )
  }
  return messages
}
