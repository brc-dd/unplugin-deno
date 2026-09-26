/**
 * Resolver and loader for Deno code.
 *
 * This can be used to create bundler plugins or libraries that use deno resolution.
 *
 * Works in both Deno and Node.js. For Node.js, install from JSR
 * (`npx jsr add @deno/loader`) which provides pre-transpiled JavaScript.
 *
 * @example
 * ```ts
 * import { Workspace, ResolutionMode, type LoadResponse, RequestedModuleType } from "@deno/loader";
 *
 * const workspace = new Workspace({
 *   // optional options
 * });
 * const loader = await workspace.createLoader();
 * const diagnostics = await loader.addEntrypoints(["./mod.ts"])
 * if (diagnostics.length > 0) {
 *   throw new Error(diagnostics[0].message);
 * }
 * // alternatively use resolve to resolve npm/jsr specifiers not found
 * // in the entrypoints or if not being able to provide entrypoints
 * const resolvedUrl = loader.resolveSync(
 *   "./mod.test.ts",
 *   "https://deno.land/mod.ts", // referrer
 *   ResolutionMode.Import,
 * );
 * const response = await loader.load(resolvedUrl, RequestedModuleType.Default);
 * if (response.kind === "module") {
 *   console.log(response.specifier);
 *   console.log(response.code);
 *   console.log(response.mediaType);
 * } else if (response.kind === "external") {
 *   console.log(response.specifier)
 * } else {
 *   const _assertNever = response;
 *   throw new Error(`Unhandled kind: ${(response as LoadResponse).kind}`);
 * }
 * ```
 * @module
 */ import type { DenoLoader as WasmLoaderClass } from "./lib/rs_lib.d.ts";
type WasmLoader = WasmLoaderClass;
declare const WasmLoader: typeof WasmLoaderClass;
/** Options for creating a workspace. */ export interface WorkspaceOptions {
  /** Do not do config file discovery. */ noConfig?: boolean;
  /** Do not respect the lockfile. */ noLock?: boolean;
  /** Path or file: URL to the config file if you do not want to do config file discovery. */ configPath?: string;
  /** Node resolution conditions to use for resolving package.json exports. */ nodeConditions?: string[];
  /** Date for the newest allowed dependency. */ newestDependencyDate?: Date;
  /**
   * Platform to bundle for.
   * @default "node"
   */ platform?: "node" | "browser";
  /** Whether to force using the cache. */ cachedOnly?: boolean;
  /**
   * Enable debug logs.
   *
   * @remarks Note that the Rust debug logs are enabled globally
   * and can only be enabled by the first workspace that gets
   * created. This is a limitation of how the Rust logging works.
   */ debug?: boolean;
  /** Whether to preserve JSX syntax in the loaded output. */ preserveJsx?: boolean;
  /** Skip transpiling TypeScript and JSX. */ noTranspile?: boolean;
}
export declare class ResolveError extends Error {
  /**
   * Possible specifier this would resolve to if the error did not occur.
   *
   * This is useful for implementing something like `import.meta.resolve` where
   * you want the resolution to always occur and not error.
   */ specifier?: string;
  /** Node.js error code. */ code?: string;
  /**
   * If the specifier being resolved was an optional npm dependency.
   *
   * @remarks This will only be true when the error code is
   * `ERR_MODULE_NOT_FOUND`.
   */ isOptionalDependency?: boolean;
}
/** File type. */ export declare enum MediaType {
  JavaScript = 0,
  Jsx = 1,
  Mjs = 2,
  Cjs = 3,
  TypeScript = 4,
  Mts = 5,
  Cts = 6,
  Dts = 7,
  Dmts = 8,
  Dcts = 9,
  Tsx = 10,
  Css = 11,
  Json = 12,
  Jsonc = 13,
  Json5 = 14,
  Html = 15,
  Markdown = 16,
  Sql = 17,
  Wasm = 18,
  SourceMap = 19,
  Unknown = 20
}
/** A response received from a load. */ export type LoadResponse = ModuleLoadResponse | ExternalLoadResponse;
/** A response that indicates the module is external.
 *
 * This will occur for `node:` specifiers for example.
 */ export interface ExternalLoadResponse {
  /** Kind of response. */ kind: "external";
  /**
   * Fully resolved URL.
   *
   * This may be different than the provided specifier. For example, during loading
   * it may encounter redirects and this specifier is the redirected to final specifier.
   */ specifier: string;
}
/** A response that loads a module. */ export interface ModuleLoadResponse {
  /** Kind of response. */ kind: "module";
  /**
   * Fully resolved URL.
   *
   * This may be different than the provided specifier. For example, during loading
   * it may encounter redirects and this specifier is the redirected to final specifier.
   */ specifier: string;
  /** Content that was loaded. */ mediaType: MediaType;
  /** Code that was loaded. */ code: Uint8Array;
  /**
   * Source map for the loaded code, if available.
   *
   * This is the decoded JSON source map extracted from inline source maps
   * that are generated during transpilation. It will be `undefined` for
   * non-transpiled files (e.g. JavaScript, JSON, CSS) or when transpilation
   * is disabled via `noTranspile`.
   */ sourceMap?: Uint8Array;
}
/** Kind of resolution. */ export declare enum ResolutionMode {
  /** Resolving from an ESM file. */ Import = 0,
  /** Resolving from a CJS file. */ Require = 1
}
/** Resolves the workspace. */ export declare class Workspace implements Disposable {
  /** Creates a `DenoWorkspace` with the provided options. */ constructor(options?: WorkspaceOptions);
  [Symbol.dispose](): void;
  /** Creates a loader that uses this this workspace. */ createLoader(): Promise<Loader>;
}
export declare enum RequestedModuleType {
  Default = 0,
  Json = 1,
  Text = 2,
  Bytes = 3
}
export interface EntrypointDiagnostic {
  message: string;
}
/** A loader for resolving and loading urls. */ export declare class Loader implements Disposable {
  /** @internal */ constructor(loader: WasmLoader, debug: boolean);
  [Symbol.dispose](): void;
  /** Adds entrypoints to the loader.
   *
   * It's useful to specify entrypoints so that the loader can resolve
   * npm: and jsr: specifiers the same way that Deno does when not using
   * a lockfile.
   */ addEntrypoints(entrypoints: string[]): Promise<EntrypointDiagnostic[]>;
  /** Synchronously resolves a specifier using the given referrer and resolution mode.
   * @throws {ResolveError}
   */ resolveSync(specifier: string, referrer: string | undefined, resolutionMode: ResolutionMode): string;
  /** Asynchronously resolves a specifier using the given referrer and resolution mode.
   *
   * This is useful for resolving `jsr:` and `npm:` specifiers on the fly when they can't
   * be figured out from entrypoints, but it may cause multiple "npm install"s and different
   * npm or jsr resolution than Deno. For that reason it's better to provide the list of
   * entrypoints up front so the loader can create the npm and jsr graph, and then after use
   * synchronous resolution to resolve jsr and npm specifiers.
   *
   * @throws {ResolveError}
   */ resolve(specifier: string, referrer: string | undefined, resolutionMode: ResolutionMode): Promise<string>;
  /** Loads a specifier. */ load(specifier: string, requestedModuleType: RequestedModuleType): Promise<LoadResponse>;
  /** Gets the module graph.
   *
   * WARNING: This function is very unstable and the output may change between
   * patch releases.
   */ getGraphUnstable(): unknown;
}
/**
 * How this copy loaded its wasm (added by unplugin-deno, see NOTICE.md): `"node"` when `mod.js`
 * has a `file:` URL (`rs_lib_node.js`: `readFileSync` and synchronous instantiation), `"esm"`
 * for any other URL, such as Deno loading the package from JSR (`lib/rs_lib.js` imports the
 * wasm as a module).
 */
export declare const wasmLoadingPath: "node" | "esm";
