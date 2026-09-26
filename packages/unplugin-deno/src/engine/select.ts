/**
 * Choosing the engine for `engine: 'auto' | 'loader' | 'deno'` (docs/architecture.md §4.3). The
 * vendored loader is the default; `auto` picks the Deno CLI only when the project uses a Deno
 * feature the loader (0.5.0, Deno ≈ 2.7.9) lacks **and** a usable Deno (2.8.3+) is installed.
 *
 * Features that decide (each verified against the vendored loader and Deno 2.9.7):
 *
 * - `catalog:` versions in `package.json` dependencies (Deno 2.8): the loader fails with
 *   "Not implemented scheme 'catalog'", so it can neither install nor resolve them.
 * - `catalog:` values in `deno.json` `imports`: the loader maps them to the bare `catalog:` (the
 *   plugin's import map expands them, but the loader's graph and installs do not).
 * - Globs in `links` (Deno 2.8.3): the loader cannot create a workspace ("Could not find link
 *   member"), so every build fails with `CONFIG_INVALID`.
 * - `jsrDepsInNodeModules` (Deno 2.9): Deno maps `jsr:` import-map entries to `npm:@jsr/…`
 *   packages installed in `node_modules`; the loader resolves them to `https://jsr.io`.
 * - `JSR_URL` naming another registry: the loader ignores it and fetches JSR packages from
 *   `https://jsr.io` (verified with a local registry); the Deno CLI honours it.
 *
 * Not deciding: glob workspace members (the loader handles them), `nodeModulesLinker: "hoisted"`
 * (Deno requires `nodeModulesDir: "manual"` with it, where no engine installs), CSS, text and
 * bytes imports (handled by the plugin for both engines, §5.5), the 24 h minimum dependency age
 * (the plugin passes the date) and external import-map links (the config layer resolves them).
 *
 * @module
 */
import { DEFAULT_DENO_BINARY, MIN_DENO_VERSION, probeDeno } from './deno-cli/process.js'
import type { EngineKind } from './types.js'

/** The `deno.json(c)` and `package.json` of a config folder, as far as the selection reads them. */
export interface EngineSelectionFolder {
  denoJson: {
    path: string
    config: { imports?: Record<string, unknown>; links?: string[]; patch?: string[] }
  } | null
  packageJson: {
    path: string
    json: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  } | null
}

/**
 * The parts of the config layer's `Project` the selection reads (the engine does not import the
 * config layer; its `Project` satisfies this structurally).
 */
export interface EngineSelectionProject {
  /** The workspace root's config folder, or `null` without a config. */
  rootFolder: EngineSelectionFolder | null
  members: readonly EngineSelectionFolder[]
  links: readonly EngineSelectionFolder[]
  /** `jsrDepsInNodeModules` in effect (it requires a `node_modules` directory mode). */
  jsrDepsInNodeModules: boolean
}

/** A Deno feature the vendored loader lacks, found in the project. */
export interface DenoOnlyFeature {
  feature: 'catalog' | 'link-globs' | 'jsr-deps-in-node-modules' | 'jsr-url'
  /** What was found, for messages (`catalog: in package.json dependencies of …`). */
  description: string
  /** The config file it is in. */
  file: string | undefined
}

/**
 * The Deno features of `project` (and of the environment `env`: `JSR_URL`) that the vendored
 * loader lacks (see the module comment), in discovery order, at most one per feature and file.
 */
export function denoOnlyFeatures(
  project: EngineSelectionProject,
  env: Readonly<Record<string, string | undefined>> = {},
): DenoOnlyFeature[] {
  const found: DenoOnlyFeature[] = []
  const add = (feature: DenoOnlyFeature): void => {
    if (!found.some((item) => item.feature === feature.feature && item.file === feature.file)) {
      found.push(feature)
    }
  }
  const folders = [project.rootFolder, ...project.members, ...project.links].filter(
    (folder) => folder !== null,
  )
  for (const folder of folders) {
    const denoJson = folder.denoJson
    if (denoJson !== null && Object.values(denoJson.config.imports ?? {}).some(isCatalog)) {
      add({
        feature: 'catalog',
        description: `\`catalog:\` in the imports of ${denoJson.path}`,
        file: denoJson.path,
      })
    }
    const packageJson = folder.packageJson
    if (packageJson !== null) {
      const { dependencies = {}, devDependencies = {} } = packageJson.json
      if ([...Object.values(dependencies), ...Object.values(devDependencies)].some(isCatalog)) {
        add({
          feature: 'catalog',
          description: `\`catalog:\` in the dependencies of ${packageJson.path}`,
          file: packageJson.path,
        })
      }
    }
  }
  const root = project.rootFolder?.denoJson ?? undefined
  const links = root?.config.links ?? root?.config.patch ?? []
  if (root !== undefined && links.some((link) => /[*?]/.test(link) || link.startsWith('!'))) {
    add({
      feature: 'link-globs',
      description: `globs in the links of ${root.path}`,
      file: root.path,
    })
  }
  if (project.jsrDepsInNodeModules) {
    add({
      feature: 'jsr-deps-in-node-modules',
      description: '`jsrDepsInNodeModules`',
      file: root?.path,
    })
  }
  const jsrUrl = env.JSR_URL
  if (jsrUrl !== undefined && jsrUrl !== '' && !/^https:\/\/jsr\.io\/?$/.test(jsrUrl)) {
    add({ feature: 'jsr-url', description: `\`JSR_URL=${jsrUrl}\``, file: undefined })
  }
  return found
}

function isCatalog(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('catalog:')
}

/** Input of {@link selectEngineKind}. */
export interface EngineSelectionInput {
  /** The `engine` option. */
  engine: 'auto' | 'loader' | 'deno'
  /** The loaded project; `null` when there is none (then `auto` means the loader). */
  project: EngineSelectionProject | null
  /** The `denoBinary` option (default `deno`). */
  denoBinary?: string | undefined
  /** The environment used to find and run Deno (default `process.env`). */
  env?: NodeJS.ProcessEnv | undefined
}

/** The engine to use and why. */
export interface EngineSelection {
  kind: EngineKind
  /** One sentence, for the debug summary. */
  reason: string
  /** The Deno-only features found (empty unless `engine` is `auto`). */
  features: readonly DenoOnlyFeature[]
  /**
   * Set when `auto` fell back to the loader although the project needs Deno (missing or too old):
   * the plugin should warn, because the build may fail or resolve differently from Deno.
   */
  warning?: string | undefined
}

/**
 * Picks the engine: the loader unless `engine` is `'deno'`, or `'auto'` finds a Deno-only feature
 * ({@link denoOnlyFeatures}) and a usable Deno (2.8.3+; probed once per binary and process).
 * Never rejects; `engine: 'deno'` is returned even without Deno (creating it then fails with
 * `ENGINE_UNAVAILABLE`).
 */
export async function selectEngineKind(input: EngineSelectionInput): Promise<EngineSelection> {
  if (input.engine === 'loader') {
    return { kind: 'loader', reason: "`engine: 'loader'`", features: [] }
  }
  if (input.engine === 'deno') {
    return { kind: 'deno', reason: "`engine: 'deno'`", features: [] }
  }
  const features =
    input.project === null ? [] : denoOnlyFeatures(input.project, input.env ?? process.env)
  if (features.length === 0) {
    return {
      kind: 'loader',
      reason: '`engine: "auto"`: the project uses no Deno feature the vendored loader lacks',
      features,
    }
  }
  const uses = features.map((feature) => feature.description).join(', ')
  const probe = await probeDeno(input.denoBinary ?? DEFAULT_DENO_BINARY, input.env ?? process.env)
  if (probe.ok) {
    return {
      kind: 'deno',
      reason: `\`engine: "auto"\`: the project uses ${uses}, which the vendored loader lacks; using Deno ${probe.version}`,
      features,
    }
  }
  const warning =
    `The project uses ${uses}, which the vendored @deno/loader does not support, and no usable ` +
    `Deno ${MIN_DENO_VERSION}+ was found (${probe.message}); using the loader anyway. Install ` +
    "Deno or set `denoBinary` to use the `deno` engine (or set `engine: 'loader'` to silence this)."
  return {
    kind: 'loader',
    reason: `\`engine: "auto"\`: the project needs Deno, which is unavailable (${probe.message})`,
    features,
    warning,
  }
}
