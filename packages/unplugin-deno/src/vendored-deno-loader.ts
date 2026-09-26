/**
 * Access to the vendored `@deno/loader` (`vendor/deno-loader/`, see its NOTICE.md).
 *
 * This file must stay directly in `src/` (depth 1): the build keeps `../vendor/…` imports
 * external and emits flat `dist/*.js` files, so the same relative specifier is correct in the
 * sources and in the published output.
 *
 * @module
 */
import { readFile } from 'node:fs/promises'
import type * as DenoLoader from '../vendor/deno-loader/mod.js'
import type { LoaderFetch, LoaderLogger } from '../vendor/deno-loader/hooks.js'
import { setFetch, setLogger } from '../vendor/deno-loader/hooks.js'
import { DenoPluginError } from './diagnostics/errors.js'

export type { LoaderFetch, LoaderLogEvent, LoaderLogger } from '../vendor/deno-loader/hooks.js'
// The loader's classes and response types, for `engine/loader/` (which must not import vendor/).
export type {
  EntrypointDiagnostic,
  Loader,
  LoadResponse,
  ModuleLoadResponse,
  ResolveError,
  Workspace,
  WorkspaceOptions,
} from '../vendor/deno-loader/mod.js'

/** The vendored loader module: `Workspace`, `Loader`, `ResolveError`, `MediaType`, … */
export type VendoredDenoLoader = typeof DenoLoader

let loading: Promise<VendoredDenoLoader> | undefined

/**
 * Imports the vendored loader on first use and returns the same module afterwards. The first call
 * reads and compiles the 5.5 MB wasm synchronously from disk (about 85 ms cold); when Deno runs
 * the package from JSR, it imports the wasm as a module instead (`wasmLoadingPath`, §4.2).
 *
 * @throws {DenoPluginError} `ENGINE_UNAVAILABLE` when the vendored files cannot be loaded.
 */
export function loadVendoredDenoLoader(): Promise<VendoredDenoLoader> {
  loading ??= import('../vendor/deno-loader/mod.js').catch((error: unknown) => {
    loading = undefined
    throw new DenoPluginError('ENGINE_UNAVAILABLE', 'Cannot load the vendored @deno/loader.', {
      hint: 'Reinstall unplugin-deno; its vendor/deno-loader directory is incomplete.',
      cause: error,
    })
  })
  return loading
}

/**
 * Routes the loader's output ("Downloading …", Rust log lines, panics, retries) to `logger`.
 * Process-wide; `null` restores the default, which prints nothing.
 */
export function setLoaderLogger(logger: LoaderLogger | null): void {
  setLogger(logger)
}

/**
 * Makes the loader fetch remote modules and packages with `fetch` (proxies, auth, tests).
 * Process-wide; `null` restores the default, `globalThis.fetch` at call time. Requests are
 * retried up to 3 times on network errors, HTTP 429 and HTTP 5xx either way.
 */
export function setLoaderFetch(fetch: LoaderFetch | null): void {
  setFetch(fetch)
}

let version: Promise<string | undefined> | undefined

/**
 * The version of the vendored `@deno/loader` (`vendor/deno-loader/VERSION`), for debug output;
 * `undefined` when the file cannot be read.
 */
export function vendoredLoaderVersion(): Promise<string | undefined> {
  version ??= readFile(new URL('../vendor/deno-loader/VERSION', import.meta.url), 'utf8').then(
    (text) => text.trim() || undefined,
    () => undefined,
  )
  return version
}
