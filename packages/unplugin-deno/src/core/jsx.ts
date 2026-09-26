/**
 * JSX settings of `deno.json` for the hosts' own JSX transforms (docs/architecture.md §5.11, L5).
 * Local files are transpiled by the host, so the `compilerOptions.jsx*` settings of the nearest
 * `deno.json` (merged over the workspace root's) become host options when the user has not
 * configured JSX on the host: Vite `oxc.jsx` (Vite 8) or `esbuild.jsx*` (Vite 7), Rolldown
 * `transform.jsx`, Rollup `jsx`, esbuild `jsx*`. The adapters map the neutral
 * {@link JsxTransform} to their host's shape. `jsxImportSource` stays a specifier
 * (`preact`, `npm:preact@10`): the host imports `<source>/jsx-runtime`, which the plugin resolves
 * through the import map like any other import.
 *
 * Deno's modes: `react` → the classic runtime (`jsxFactory`, `jsxFragmentFactory`, globals as in
 * Deno); `react-jsx` → the automatic runtime; `react-jsxdev` → the automatic runtime in
 * development mode; `precompile` → the automatic runtime with a warning (no host precompiles JSX);
 * `preserve` and `react-native` → the host's own settings (the plugin changes nothing).
 *
 * @module
 */
import type { DenoConfig, JsxSettings, Project } from '../config/project.js'
import type { ResolvedOptions } from './options.js'

/** A JSX transform in host-neutral terms. */
export type JsxTransform =
  | {
      runtime: 'automatic'
      /** The `jsxImportSource` (default `react`): the host imports `<importSource>/jsx-runtime`. */
      importSource: string
      /** `react-jsxdev`: `jsxDEV` from `<importSource>/jsx-dev-runtime`. */
      development: boolean
    }
  | {
      runtime: 'classic'
      /** `jsxFactory` (default `React.createElement`). */
      factory: string
      /** `jsxFragmentFactory` (default `React.Fragment`). */
      fragment: string
    }

/** The result of {@link jsxTransformFor}. */
export interface JsxDecision {
  transform: JsxTransform
  /** `jsx: "precompile"` in `deno.json`, compiled with the automatic runtime instead. */
  precompile: boolean
}

/** The `compilerOptions` keys that configure JSX (a `deno.json` without them uses host defaults). */
const JSX_KEYS = ['jsx', 'jsxImportSource', 'jsxFactory', 'jsxFragmentFactory'] as const

/**
 * The JSX transform the host should apply to local files, or `null` to leave the host alone: the
 * `jsx: 'host'` option, a disabled project, a `deno.json` that sets no JSX option (Deno's default,
 * the classic `React.createElement`, would override the host's own default), and the `preserve`
 * and `react-native` modes.
 */
export function jsxTransformFor(
  project: Pick<Project, 'disabled' | 'jsx' | 'config' | 'workspaceConfig'>,
  options: Pick<ResolvedOptions, 'jsx'>,
): JsxDecision | null {
  if (options.jsx === 'host' || project.disabled) return null
  if (!configuresJsx(project.config) && !configuresJsx(project.workspaceConfig)) return null
  return jsxDecision(project.jsx)
}

/** The {@link JsxDecision} for Deno's JSX settings (see the module documentation). */
export function jsxDecision(settings: JsxSettings): JsxDecision | null {
  const importSource = settings.importSource ?? 'react'
  switch (settings.jsx) {
    case 'react':
      return {
        transform: {
          runtime: 'classic',
          factory: settings.factory,
          fragment: settings.fragmentFactory,
        },
        precompile: false,
      }
    case 'react-jsx':
    case 'react-jsxdev':
      return {
        transform: {
          runtime: 'automatic',
          importSource,
          development: settings.jsx === 'react-jsxdev',
        },
        precompile: false,
      }
    case 'precompile':
      return {
        transform: { runtime: 'automatic', importSource, development: false },
        precompile: true,
      }
    case 'preserve':
    case 'react-native':
      return null
  }
}

function configuresJsx(config: DenoConfig | null): boolean {
  const options = config?.compilerOptions
  return options !== undefined && JSX_KEYS.some((key) => options[key] !== undefined)
}

/** The warning for `jsx: "precompile"` (shown once per plugin instance). */
export function precompileWarning(host: string, importSource: string): string {
  return `\`compilerOptions.jsx: "precompile"\` in deno.json is not supported by ${host}'s JSX transform; local JSX is compiled with the automatic runtime (\`${importSource}/jsx-runtime\`) instead. Hint: use \`"jsx": "react-jsx"\` for bundled code, or wait for the \`jsx: 'deno'\` option (planned), which will precompile local files with Deno.`
}
