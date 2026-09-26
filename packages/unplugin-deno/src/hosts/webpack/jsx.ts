/**
 * The `deno.json` JSX settings on the webpack-family hosts (docs/architecture.md §5.11, §6.5,
 * §6.6). webpack and Rspack compile local TypeScript and JSX with the user's loaders (webpack's
 * own `experiments.typescript` strips types but cannot compile JSX), so when the project
 * configures JSX (and the `jsx` option is not `'host'`) the adapters give the settings to the JSX
 * loaders they recognise in `module.rules`, unless a loader configures JSX itself:
 *
 * - `esbuild-loader` (by package name or path): esbuild's `jsx`, `jsxImportSource` and `jsxDev`,
 *   or `jsxFactory` and `jsxFragment`; the loader configures JSX when its options set one of them
 *   or `tsconfigRaw.compilerOptions.jsx*` (a `tsconfig.json` next to the file still wins per key,
 *   as in esbuild's transform API);
 * - Rspack's `builtin:swc-loader` (Rsbuild's too) and the `swc-loader` package:
 *   `jsc.transform.react` with `runtime`, `importSource` and `development`, or `pragma` and
 *   `pragmaFrag`; the loader configures JSX when `jsc.transform.react` sets `runtime`,
 *   `importSource`, `pragma` or `pragmaFrag` (as `@rsbuild/plugin-react` does).
 *
 * Loaders are found in `loader`/`options`, in `use` (strings, objects and arrays; a `use`
 * function is not inspected) and in nested `oneOf` and `rules`. Options given as strings or
 * inline queries count as configured. Rules and options are copied, never changed in place
 * (configs share rule objects). When no such loader is found, an info line says what to set.
 *
 * @module
 */
import type { BuildOptions } from 'esbuild'
import type { JsxTransform } from '../../core/jsx.js'
import { jsxTransformFor } from '../../core/jsx.js'
import type { PluginState } from '../../core/state.js'
import { configuresJsx } from '../esbuild/options.js'
import { esbuildJsxOptions } from '../shared.js'

/** The JSX loaders the adapters configure. */
export type JsxLoader = 'esbuild-loader' | 'builtin:swc-loader' | 'swc-loader'

/** What {@link applyJsxToRules} did. */
export interface JsxRulesReport {
  /** Loaders that received the settings (each once). */
  applied: JsxLoader[]
  /** Loaders left alone because they configure JSX themselves (each once). */
  configured: JsxLoader[]
}

/** The `jsc.transform.react` keys that configure SWC's JSX transform. */
const SWC_JSX_KEYS = ['runtime', 'importSource', 'pragma', 'pragmaFrag'] as const

/** The JSX loader a `loader` string names (by package name or path), if any. */
export function jsxLoaderOf(loader: string): JsxLoader | undefined {
  const name = loader.split('?', 1)[0] ?? ''
  if (name === 'builtin:swc-loader') return 'builtin:swc-loader'
  if (/(?:^|[\\/])esbuild-loader(?:[\\/]|$)/.test(name)) return 'esbuild-loader'
  if (/(?:^|[\\/])swc-loader(?:[\\/]|$)/.test(name)) return 'swc-loader'
  return undefined
}

/**
 * SWC's `jsc.transform.react` options for a {@link JsxTransform}: the automatic runtime with
 * `importSource` (and `development` for `react-jsxdev`), or the classic one with `pragma` and
 * `pragmaFrag` (global factories, as in Deno).
 */
export function swcJsxOptions(transform: JsxTransform): Record<string, string | boolean> {
  if (transform.runtime === 'classic') {
    return { runtime: 'classic', pragma: transform.factory, pragmaFrag: transform.fragment }
  }
  return {
    runtime: 'automatic',
    importSource: transform.importSource,
    ...(transform.development ? { development: true } : {}),
  }
}

type Options = Record<string, unknown>

function isRecord(value: unknown): value is Options {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The options of `loader` with `transform` applied, or `undefined` when the loader is not one of
 * the JSX loaders or configures JSX itself (recorded in `report`).
 */
function optionsWithJsx(
  loader: string,
  options: unknown,
  transform: JsxTransform,
  report: { applied: Set<JsxLoader>; configured: Set<JsxLoader> },
): Options | undefined {
  const kind = jsxLoaderOf(loader)
  if (kind === undefined) return undefined
  if (loader.includes('?') || (options !== undefined && options !== null && !isRecord(options))) {
    report.configured.add(kind)
    return undefined
  }
  const current: Options = isRecord(options) ? options : {}
  if (kind === 'esbuild-loader') {
    if (configuresJsx(current as BuildOptions)) {
      report.configured.add(kind)
      return undefined
    }
    report.applied.add(kind)
    return { ...current, ...esbuildJsxOptions(transform) }
  }
  const jsc = isRecord(current.jsc) ? current.jsc : {}
  const transforms = isRecord(jsc.transform) ? jsc.transform : {}
  const react = isRecord(transforms.react) ? transforms.react : {}
  if (SWC_JSX_KEYS.some((key) => react[key] !== undefined)) {
    report.configured.add(kind)
    return undefined
  }
  report.applied.add(kind)
  return {
    ...current,
    jsc: {
      ...jsc,
      transform: { ...transforms, react: { ...react, ...swcJsxOptions(transform) } },
    },
  }
}

type Edit = (loader: string, options: unknown) => Options | undefined

/** A `use` item with the edit applied (the same item when unchanged). */
function useItemWithJsx(item: unknown, edit: Edit): unknown {
  if (typeof item === 'string') {
    const options = edit(item, undefined)
    return options === undefined ? item : { loader: item, options }
  }
  if (isRecord(item) && typeof item.loader === 'string') {
    const options = edit(item.loader, item.options)
    return options === undefined ? item : { ...item, options }
  }
  return item
}

/** A rule's `use` with the edit applied (functions are left alone). */
function useWithJsx(use: unknown, edit: Edit): unknown {
  if (!Array.isArray(use)) return useItemWithJsx(use, edit)
  const items = use.map((item) => useItemWithJsx(item, edit))
  return items.every((item, index) => item === use[index]) ? use : items
}

/** A rule with the edit applied to its loaders and nested rules (the same rule when unchanged). */
function ruleWithJsx(rule: unknown, edit: Edit): unknown {
  if (!isRecord(rule)) return rule
  let next = rule
  const set = (key: string, value: unknown): void => {
    if (next === rule) next = { ...rule }
    next[key] = value
  }
  if (typeof rule.loader === 'string') {
    const options = edit(rule.loader, rule.options)
    if (options !== undefined) set('options', options)
  }
  if (rule.use !== undefined) {
    const use = useWithJsx(rule.use, edit)
    if (use !== rule.use) set('use', use)
  }
  for (const key of ['oneOf', 'rules']) {
    const nested: unknown = rule[key]
    if (!Array.isArray(nested)) continue
    const rules = nested.map((item: unknown) => ruleWithJsx(item, edit))
    if (rules.some((item, index) => item !== nested[index])) set(key, rules)
  }
  return next
}

/**
 * Applies `transform` to the JSX loaders of `rules` (a host's `module.rules`, whose changed
 * entries are replaced with copies) that do not configure JSX themselves.
 */
export function applyJsxToRules(rules: unknown[], transform: JsxTransform): JsxRulesReport {
  const report = { applied: new Set<JsxLoader>(), configured: new Set<JsxLoader>() }
  const edit: Edit = (loader, options) => optionsWithJsx(loader, options, transform, report)
  rules.forEach((rule, index) => {
    const next = ruleWithJsx(rule, edit)
    if (next !== rule) rules[index] = next
  })
  return { applied: [...report.applied], configured: [...report.configured] }
}

/** A short description of a {@link JsxTransform} for messages. */
export function describeJsx(transform: JsxTransform): string {
  if (transform.runtime === 'classic') {
    return `the classic runtime with factory \`${transform.factory}\` and fragment \`${transform.fragment}\``
  }
  const mode = transform.development ? 'automatic runtime in development mode' : 'automatic runtime'
  return `the ${mode} with importSource \`${transform.importSource}\``
}

/** The loader options to set by hand for a {@link JsxTransform}, for messages. */
export function jsxHint(transform: JsxTransform): string {
  const esbuild = Object.entries(esbuildJsxOptions(transform))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ')
  const swc = Object.entries(swcJsxOptions(transform))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ')
  return `esbuild-loader \`{ ${esbuild} }\`, swc-loader \`jsc.transform.react: { ${swc} }\``
}

/**
 * Applies the `deno.json` JSX settings to the JSX loaders of `rules` (see the module
 * documentation) and logs what happened: which loaders got them (debug), which configure JSX
 * themselves (debug), or, when none was found, what to set (info). `jsx: "precompile"` warns once
 * (compiled with the automatic runtime). The project must be loaded.
 */
export function configureJsx(
  state: PluginState,
  rules: unknown[],
  host: 'webpack' | 'rspack',
): JsxRulesReport | null {
  const decision = jsxTransformFor(state.project, state.options)
  if (decision === null) return null
  const { transform } = decision
  const report = applyJsxToRules(rules, transform)
  const prefix = `[${host}]`
  const [first] = report.applied
  if (first !== undefined) {
    // Warns once for `precompile` (the JSX is compiled with the automatic runtime).
    state.jsxTransform(first === 'esbuild-loader' ? 'esbuild-loader' : 'SWC')
    state.logger.debug(
      `${prefix} deno.json JSX settings (${describeJsx(transform)}) applied to ${report.applied.join(', ')}`,
    )
  }
  if (report.configured.length > 0) {
    state.logger.debug(
      `${prefix} ${report.configured.join(', ')} configure JSX themselves; the deno.json JSX settings are not applied to them`,
    )
  }
  if (report.applied.length === 0 && report.configured.length === 0) {
    state.logger.info(
      `${prefix} deno.json configures JSX (${describeJsx(transform)}), but module.rules has no esbuild-loader or swc-loader rule for unplugin-deno to apply it to; configure the loader that compiles your .jsx/.tsx files to match: ${jsxHint(transform)}.${host === 'webpack' ? " webpack's experiments.typescript does not compile JSX." : ''}`,
    )
  }
  return report
}
