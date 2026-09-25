/**
 * The engine interface (docs/architecture.md §4.1): the component that implements Deno's
 * resolution and loading semantics for the core plugin. Engines never import `core/`, `config/`
 * or `hosts/`; they receive the project through {@link EngineProject}.
 *
 * @module
 */
import type { ErrorCode } from '../diagnostics/errors.js'
import type { Logger } from '../diagnostics/logger.js'

/**
 * Deno's media types (`deno_media_type`), by name. A module's media type describes its source:
 * `load()` of a `TypeScript` module returns transpiled JavaScript.
 */
export type MediaType =
  | 'JavaScript'
  | 'Jsx'
  | 'Mjs'
  | 'Cjs'
  | 'TypeScript'
  | 'Mts'
  | 'Cts'
  | 'Dts'
  | 'Dmts'
  | 'Dcts'
  | 'Tsx'
  | 'Css'
  | 'Json'
  | 'Jsonc'
  | 'Json5'
  | 'Html'
  | 'Markdown'
  | 'Sql'
  | 'Wasm'
  | 'SourceMap'
  | 'Unknown'

/** Whether a specifier is resolved for an ES module (`import`) or a CommonJS module (`require`). */
export type ResolutionMode = 'import' | 'require'

/** How a module is loaded: as code, or as the target of `with { type: "json" | "text" | "bytes" }`. */
export type LoadType = 'default' | 'json' | 'text' | 'bytes'

/** The engine implementations: the vendored `@deno/loader` and the Deno CLI (M2). */
export type EngineKind = 'loader' | 'deno'

/**
 * What a resolved URL points at:
 * - `local`: a `file:` module that is not part of an npm package (the host loads it);
 * - `npm`: a file inside an npm package (`node_modules`, or `DENO_DIR/npm/` for `nodeModulesDir: "none"`);
 * - `remote`: an `https:`/`http:` module (JSR modules resolve to `https://jsr.io/…`);
 * - `data`: a `data:` URL module;
 * - `node`: a Node.js builtin (`node:fs`; bare `fs` resolves to it too);
 * - `external`: any other scheme the engine passes through (`bun:`, `cloudflare:`, …).
 */
export type ResolvedKind = 'local' | 'npm' | 'remote' | 'data' | 'node' | 'external'

/** The npm package that contains a {@link ResolvedModule} of kind `npm`. */
export interface NpmPackageInfo {
  /** Package name from its `package.json`, e.g. `kleur` or `@scope/name`. */
  name: string
  /** Package version from its `package.json` (`''` when it has none). */
  version: string
  /**
   * The subpath the specifier requested, `''` for the package root or `/colors` for
   * `npm:kleur@^4/colors`, so `name + subpath` is a request the host can resolve from
   * {@link NpmPackageInfo.packageDir}. When the specifier does not name the package (a relative
   * or absolute import from inside it), this is the file's path inside the package instead
   * (`/lib/x.js`); prefer {@link ResolvedModule.path} then.
   */
  subpath: string
  /** Absolute, symlink-free path of the package directory (the one containing `package.json`). */
  packageDir: string
  /** Absolute path of the package's `package.json`. */
  packageJsonPath: string
}

/** The result of resolving a specifier. */
export interface ResolvedModule {
  kind: ResolvedKind
  /**
   * The resolved URL: `file:///…`, `https://…` (JSR modules resolve to `https://jsr.io/…`),
   * `data:…`, `node:fs`, `bun:sqlite`. Redirects are applied for modules already in the graph;
   * a remote URL the engine has not fetched yet is returned as given (resolving does not
   * download it), and {@link LoadedModule.url} reports where it ends up.
   */
  url: string
  /** OS path for `local` and `npm` modules; symlink-free for `npm`. */
  path?: string
  /**
   * Media type derived from the URL (file extension, or the MIME type of a `data:` URL). For a
   * remote URL without an extension this is `Unknown`; {@link Engine.load} reports the media type
   * from the response headers.
   */
  mediaType: MediaType
  /** The containing npm package, for `npm` modules. */
  npm?: NpmPackageInfo
  /**
   * The package's `sideEffects` flag for `npm` modules when it is a boolean; `null` when the
   * package lists side-effect globs or does not say (hosts then keep their default).
   */
  sideEffects?: boolean | null
}

/** A version 3 source map with encoded mappings (compatible with `@jridgewell/remapping`). */
export interface EncodedSourceMap {
  version: 3
  file?: string | null
  sourceRoot?: string
  sources: (string | null)[]
  sourcesContent?: (string | null)[]
  names: string[]
  mappings: string
  ignoreList?: number[]
}

/** A loaded module. */
export interface LoadedModule {
  kind: 'module'
  /** The final URL after redirects. */
  url: string
  /** Media type of the source (a `TypeScript` module's {@link LoadedModule.code} is JavaScript). */
  mediaType: MediaType
  /**
   * UTF-8 text of the module. For load type `default`, TypeScript and JSX are transpiled to
   * JavaScript and the engine's inline `//# sourceMappingURL=data:` comment is removed (the map is
   * in {@link LoadedModule.map}); other files are returned unchanged. For `json`, `text` and
   * `bytes` this is the file as it is.
   */
  code: string
  /** The raw bytes behind {@link LoadedModule.code} (use these for `bytes` and `Wasm`). */
  bytes: Uint8Array
  /** Source map of the transpiled code (`sources: [url]`, with `sourcesContent`). */
  map?: EncodedSourceMap
}

/** A module the engine does not load (`node:` builtins and other external schemes). */
export interface ExternalModule {
  kind: 'external'
  url: string
}

/** A problem found while adding entrypoints; hosts report these as warnings. */
export interface EngineDiagnostic {
  /** The engine's explanation, including the location of the import when known. */
  message: string
  /** Set when the problem maps to a stable error code, e.g. `CACHED_ONLY_MISS`. */
  code?: ErrorCode
}

/**
 * The part of the config layer's `Project` an engine needs (the config layer's type satisfies it
 * structurally).
 */
export interface EngineProject {
  /** Absolute project root; resolves relative entrypoints and referrer-less specifiers. */
  root: string
  /** Absolute workspace root. */
  workspaceRoot: string
  /** Absolute path of the `deno.json(c)`, or `undefined` for a project without one. */
  configPath: string | undefined
  /** Absolute path of the `deno.lock` in use, or `undefined` when there is none or it is disabled. */
  lockfilePath: string | undefined
  /** Where npm packages live (from `deno.json` `nodeModulesDir` or the project shape). */
  nodeModulesDir: 'auto' | 'manual' | 'none'
}

/** Options for creating an engine; one engine exists per (`configPath`, `platform`, `conditions`). */
export interface EngineCreateOptions {
  project: EngineProject
  /** Resolution platform: `browser` adds the `browser` condition and honours `browser` fields. */
  platform: 'browser' | 'node'
  /** Extra export conditions, added to the platform's defaults. */
  conditions: string[]
  /** Never download; modules that are not in the Deno cache fail with `CACHED_ONLY_MISS`. */
  cachedOnly: boolean
  /** Ignore package versions published after this date (minimum dependency age). */
  newestDependencyDate?: Date
  logger: Logger
  /** Fetch used for downloads (proxies, auth, tests). Default: `globalThis.fetch` at call time. */
  fetch?: typeof fetch
}

/** Deno's resolution and loading, behind one interface for every engine implementation. */
export interface Engine extends AsyncDisposable {
  readonly kind: EngineKind
  /**
   * Seeds the module graph (downloads, npm installs for `nodeModulesDir: "auto"`) from the given
   * entrypoints: `file:` URLs, absolute paths, paths relative to the project root, remote URLs or
   * `jsr:`/`npm:`/mapped specifiers. Never throws for problems in the graph; returns them.
   */
  addEntrypoints(entrypoints: readonly string[]): Promise<EngineDiagnostic[]>
  /**
   * Resolves `specifier` imported by `referrer` (a URL or absolute path; `undefined` means the
   * project root). May download and mutate the graph.
   *
   * @throws {DenoPluginError} `RESOLVE_*` or `CACHED_ONLY_MISS`.
   */
  resolve(
    specifier: string,
    referrer: string | undefined,
    mode: ResolutionMode,
  ): Promise<ResolvedModule>
  /**
   * The synchronous fast path of {@link Engine.resolve}: returns `undefined` when the answer needs
   * the asynchronous path (the specifier is not in the graph yet, or a package is not downloaded).
   *
   * @throws {DenoPluginError} For failures the asynchronous path would report as well.
   */
  resolveSync?(
    specifier: string,
    referrer: string | undefined,
    mode: ResolutionMode,
  ): ResolvedModule | undefined
  /**
   * Loads a resolved URL (`https:`, `http:`, `file:`, `data:`). `node:` and other external
   * schemes return `{ kind: 'external' }`.
   *
   * @throws {DenoPluginError} `RESOLVE_FAILED` for unresolved `jsr:`/`npm:` specifiers and load
   *   failures, `CACHED_ONLY_MISS` when a download was blocked.
   */
  load(url: string, type: LoadType): Promise<LoadedModule | ExternalModule>
  /** The module graph, serialized, for diagnostics (shape is engine-specific and unstable). */
  graph(): unknown
  /** Waits for pending operations, then releases the engine. Idempotent. */
  dispose(): Promise<void>
}

/** Creates engines of one kind. */
export interface EngineFactory {
  readonly kind: EngineKind
  create(options: EngineCreateOptions): Promise<Engine>
}
