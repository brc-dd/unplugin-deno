# Multi-bundler Deno plugins + Deno's own loader/bundling tooling — research report

Scope: `@jeiea/unplugin-deno`, `unplugin-jsr`, `@deno/loader`, `deno bundle`, `Deno.bundle()`, Deno 2.5 → 2.9 changes, `deno info --json` / `deno.lock` v5 / `DENO_DIR` layout, `@deno/emit` (+ `@kingsword/deno-emit`), other Deno crates/wasm packages exposed to JS.

Research date 2026-09-25. Environment: macOS arm64, Deno 2.9.7 (V8 15.0, TS 6.0.3), Node 26.8.1, Bun 1.3.14, pnpm 12.5.1.
`$SCRATCH` = `/private/tmp/claude-501/-Users-divyansh-unplugin-deno/1a551bae-bee4-41ac-ba89-ea42b9e7cb9a/scratchpad`.

Everything marked **(verified)** was run locally. Evidence lives in:
- `$SCRATCH/tarballs/deno-loader-0.5.0/package/` — `@deno/loader` 0.5.0, unpacked from `npm pack @jsr/deno__loader@0.5.0 --registry https://npm.jsr.io`. It is not on npmjs.org (see §1.1).
- `$SCRATCH/tarballs/unplugin-jsr/package/`: the unpublished `unplugin-jsr@0.0.0`, recovered from the npmmirror.com cache.
- `$SCRATCH/tarballs/deno-graph/package/`: `@deno/graph` 0.111.0, taken from npm.jsr.io.
- `$SCRATCH/repos/jeiea-unplugin-deno/` (my clone). `$SCRATCH/repos/deno-js-loader/` is another agent's clone of denoland/deno-js-loader, which I only read.
- `$SCRATCH/denosrc/`: Deno v2.9.7 sources from raw.githubusercontent. It holds `cli/tools/bundle/*.rs`, `ext/bundle/*`, `cli/tsc/dts/lib.deno.unstable.d.ts`, and `pinned/*`, which is `libs/resolver/file_fetcher.rs` at the Deno commit that `@deno/loader` pins.
- `$SCRATCH/data/`: `deno-bundle-help.txt`, `deno-info-help.txt`, `deno-transpile-help.txt`, `sample-info.json`, `sample-deno.lock`, and `releases/v2.5.0.md … v2.9.7.md` (the GitHub release notes).
- `$SCRATCH/looptest/test-loader.mjs` is the `@deno/loader` probe script. `$SCRATCH/sample*` are the test projects: `sample`, `sample-cold`, `sample-nm`, `sample-byonm`, `sample-kinds`, `sample-eager`, `sample-jsrnm`, `sample-im`, `sample-hmr`.

---

## 0. TL;DR for unplugin-deno

1. **`@deno/loader` is the only viable "real Deno semantics" engine that runs in Node.**
   - It is published on JSR only (`jsr:@deno/loader`, 0.5.0, 2026-03-29). Node users get it as `@jsr/deno__loader` from npm.jsr.io.
   - It is Deno's own Rust stack compiled to one 5.49 MB wasm: `deno_resolver`, `deno_graph`, `deno_npm_installer`, `node_resolver`, `deno_config`, `deno_cache_dir` and `deno_ast` emit.
   - Since 0.4.0 it runs under Node. I verified it under Node 26, Bun 1.3 and Deno 2.9.
   - It downloads by itself: remote modules and npm tarballs come through global `fetch`, into the normal `DENO_DIR` in the same cache format as the CLI.
   - It installs npm packages into `node_modules/.deno` when `nodeModulesDir: "auto"`. It never runs lifecycle scripts.
   - It is **stale**. It pins Deno `main` from 2026-03-28 (≈2.7.9) and has not been released since. Missing features: 2.8/2.9 CSS imports, link globs, `catalog:`, hoisted linker, the default 24 h min-dependency-age, and `jsrDepsInNodeModules`.
2. **`@jeiea/unplugin-deno` is a one-day toy.** It is 8 commits on 2025-03-28, with 0 stars, 0 issues and 0.1.1 on JSR only. It runs on Deno only: it shells out to `deno info --no-config --json` per specifier and reads cache files with `Deno.readTextFile`. It has no `npm:` support, no import-map support and no options. It gained no traction because it is minimal, Deno-only and slow, and the official `@deno/loader` plugins arrived 2–3 months later.
3. **`unplugin-jsr` never existed as working code.** sxzz published a starter-template placeholder `0.0.0` on 2024-03-03. Its only hook is `transform`, which does `console.log(code, id)`. It was unpublished on 2025-08-05 and its GitHub repo (`unplugin/unplugin-jsr`) is gone. It maps `jsr:` to nothing.
4. **`deno bundle` / `Deno.bundle()` run the real Deno resolver as one esbuild plugin.**
   - The esbuild binary is 0.25.5, downloaded from npm at first use into `DENO_DIR/dl/esbuild-0.25.5-1/`. Deno talks to it through the `esbuild_client` crate over stdio.
   - That plugin is named `"deno"` and uses `onResolve`/`onLoad` with filter `.*`.
   - `Deno.bundle()` has **no plugin API** as of 2.9.7.
   - Open PR denoland/deno#34345 (bartlomieju, 2026-05-25, unmerged, CI red) swaps the backend to **rolldown 1.2** and adds `Deno.bundle({ plugins: [{ name, setup(build){ build.onResolve/onLoad/onTransform } }] })`.
   - The bundle plugin source (`cli/tools/bundle/mod.rs`) is the best available catalogue of edge cases a Deno bundler plugin must handle (§4.3).
5. **Deno 2.8.3 added `npmPackages[*].localPath` to `deno info --json`** (#34806), explicitly "so tooling (e.g. a Rollup plugin) can locate npm packages cached by Deno". **Deno 2.9 added `jsrDepsInNodeModules`** (#35029, opt-in): it installs `jsr:` deps into `node_modules` as `@jsr/scope__name`, symlinked back to `@scope/name`, and writes `.npmrc`. Both open a "no-wasm" path for Node bundlers.

---

## 1. `@deno/loader` (denoland/deno-js-loader)

### 1.1 Identity, distribution, maintenance

| Item | Value |
|---|---|
| Registry | **JSR only**: `jsr:@deno/loader`. `npm view @deno/loader` returns 404. npm compat: `@jsr/deno__loader` on `https://npm.jsr.io` |
| Repo | https://github.com/denoland/deno-js-loader: 28★, 8 forks, created 2025-06-05, last push 2026-04-16 |
| Latest | **0.5.0 (2026-03-29)**. 31 versions from 0.0.1 (2025-06-05) to 0.5.0. None since then |
| JSR metadata | score 94. `runtimeCompat: {deno: true, node: false, bun: false}`. The node/bun flags are **stale**: Node works since 0.4.0 |
| Build | `deno run -A jsr:@deno/wasmbuild@0.20.0 --out ../lib` (wasm-bindgen 0.2.105), `opt-level="z"`, LTO |
| Rust deps | `deno_graph =0.107.1` and `deno_ast =0.53.1` (transpiling) come from crates.io. `deno_resolver`, `deno_config`, `deno_npm`, `deno_npm_cache`, `deno_npm_installer`, `deno_npmrc`, `node_resolver` and `deno_cache_dir` are **path deps into a `deno` git submodule** (shallow, to avoid Windows long paths) |
| Pinned Deno | submodule commit `26d17b93e5` = "chore: upgrade sys_traits 0.1.27 (#33040)", **2026-03-28**, between Deno 2.7.9 and 2.7.10. An automated "chore: Deno <sha>" bot bumped it almost daily until March 2026 and then stopped (last commit is "ci: change cron schedule" #85, 2026-04-16) |
| JSR dependents | 32, including `@deno/esbuild-plugin`, `@deno/rolldown-plugin`, `@fresh/plugin-vite`, `@bureaudouble/*`, `@ggpwnkthx/esbuild*`, `@str4ngemd/deno-vite-plugin` and `systeminit/si`. `@deno/vite-plugin` 2.0.4 on npm depends on `"@deno/loader": "npm:@jsr/deno__loader@^0.5.0"` |

Tarball (`jsr-deno__loader-0.5.0.tgz`, 2,216,691 bytes):
```
src/lib/rs_lib.wasm            5,488,465   # the engine
src/lib/rs_lib.internal.js        33,278   # wasm-bindgen glue (imports node:fs, node:process)
src/lib/rs_lib.js                    395   # Deno entry: `import * as wasm from "./rs_lib.wasm"`
src/rs_lib_node.js                   924   # Node/Bun entry: readFileSync + new WebAssembly.Module/Instance
src/lib/snippets/rs_lib-*/helpers.js 1,052 # fetch_specifier() (network), client-cert via Deno.createHttpClient
src/lib/snippets/sys_traits-*/inline0.js 86
src/mod.ts / src/mod.js (8,368) / _dist/src/mod.d.ts (7,138)
src/rs_lib/{lib.rs 35,855, http_client.rs 7,592, Cargo.toml, Cargo.lock}
```
`package.json` (npm-compat): `{"name":"@jsr/deno__loader","type":"module","exports":{".":{"types":"./_dist/src/mod.d.ts","default":"./src/mod.js"}}}`

### 1.2 Complete public API (0.5.0, verbatim from `_dist/src/mod.d.ts`)

```ts
export interface WorkspaceOptions {
  noConfig?: boolean;            // Do not do config file discovery.
  noLock?: boolean;              // Do not respect the lockfile.
  configPath?: string;           // Path or file: URL to the config file (skips discovery).
  nodeConditions?: string[];     // Node resolution conditions for package.json exports.
  newestDependencyDate?: Date;   // Date for the newest allowed dependency.
  platform?: "node" | "browser"; // @default "node"   (Rust also accepts "deno" = node)
  cachedOnly?: boolean;          // "Whether to force using the cache." (see bug §1.6)
  debug?: boolean;               // Rust debug logs are global; only the FIRST workspace can enable them
  preserveJsx?: boolean;         // Keep JSX syntax in loaded output.
  noTranspile?: boolean;         // Skip transpiling TS/JSX.
}
export declare class ResolveError extends Error {
  specifier?: string;            // what it *would* resolve to (for import.meta.resolve-like use)
  code?: string;                 // Node.js error code
  isOptionalDependency?: boolean;// only when code === "ERR_MODULE_NOT_FOUND"
}
export declare enum MediaType { JavaScript=0, Jsx=1, Mjs=2, Cjs=3, TypeScript=4, Mts=5, Cts=6, Dts=7,
  Dmts=8, Dcts=9, Tsx=10, Css=11, Json=12, Jsonc=13, Json5=14, Html=15, Markdown=16, Sql=17,
  Wasm=18, SourceMap=19, Unknown=20 }
export type LoadResponse = ModuleLoadResponse | ExternalLoadResponse;
export interface ExternalLoadResponse { kind: "external"; specifier: string; }   // e.g. node:*
export interface ModuleLoadResponse {
  kind: "module";
  specifier: string;       // final URL after redirects
  mediaType: MediaType;    // media type of the SOURCE (TypeScript even though `code` is transpiled JS!)
  code: Uint8Array;
  sourceMap?: Uint8Array;  // decoded JSON source map (0.5.0+); inline comment still present in `code`
}
export declare enum ResolutionMode { Import = 0, Require = 1 }
export declare class Workspace implements Disposable {
  constructor(options?: WorkspaceOptions);
  createLoader(): Promise<Loader>;
}
export declare enum RequestedModuleType { Default = 0, Json = 1, Text = 2, Bytes = 3 }  // no Css
export interface EntrypointDiagnostic { message: string; }
export declare class Loader implements Disposable {
  addEntrypoints(entrypoints: string[]): Promise<EntrypointDiagnostic[]>;
  resolveSync(specifier: string, referrer: string | undefined, resolutionMode: ResolutionMode): string; // @throws ResolveError
  resolve(specifier: string, referrer: string | undefined, resolutionMode: ResolutionMode): Promise<string>; // @throws ResolveError
  load(specifier: string, requestedModuleType: RequestedModuleType): Promise<LoadResponse>;
  getGraphUnstable(): unknown;   // serialized deno_graph ModuleGraph {roots, modules, redirects, packages}
}
```

Options the task brief listed that **do not exist** (checked against the d.ts and the Rust `DenoWorkspaceOptions` serde struct):
- `entrypoints`: removed in 0.3.0 by #42 "refactor(BREAKING): remove entrypoints option". Use `loader.addEntrypoints()` instead.
- `nodeModulesDir`, `vendor`, `lockfile`/`lock` path, `frozen`, `links`, `patch`: `lib.rs` passes `node_modules_dir: None, // provide this via config`, and the same for `vendor`, `frozen_lockfile` and `lock_arg`. They can only come from `deno.json`.
- **`cwd`**: there is none. `RealSys.env_current_dir()` means `process.cwd()` drives config discovery, relative entrypoints and undefined referrers. Vite's `root` ≠ cwd must go through `configPath`; `@deno/vite-plugin` has its own `findDenoConfig(root)`.
- `sloppyImports`: hard-wired `unstable_sloppy_imports: true`.
- `importMap`: no option. It is read from config.

Hard-wired behaviours in `src/rs_lib/lib.rs` (0.5.0):
- `node_resolver` gets `bundle_mode: true`, `is_browser_platform` from `platform`, and `conditions` from `nodeConditions`. There are no import/require condition overrides.
- `NodeCodeTranslatorMode::Disabled`: **no CJS→ESM wrapping**. CJS code comes back as-is and the bundler must handle CJS.
- `is_cjs_resolution_mode: ExplicitTypeCommonJs`, `bare_node_builtins: true` (`fs` → `node:fs`), `allow_json_imports: Always`, `require_modules: []`.
- The graph build uses `unstable_text_imports: true` and `unstable_bytes_imports: true`. The pinned `deno_graph` knows nothing about `css`.
- npm: `NullLifecycleScriptsExecutor` with `PackagesAllowedScripts::None`, so **lifecycle scripts never run**. `NpmCachingStrategy::Eager` (see §1.5). `cache_setting` is `Only` when `cachedOnly`, otherwise `Use`.
- `PermissionedFileFetcher{ allow_remote: true, cache_setting: CacheSetting::Use }` and `WasmHttpClient::default()` (`cached_only: false`), so remote fetching is always allowed.
- Lockfile: read via `workspace_factory.maybe_lockfile()`, and `lockfile.fill_graph()` seeds the first graph (#47). `lockfile_skip_write: false` is set, but **no write was observed**: a fresh project got no `deno.lock` created (verified).
- `add_entrypoints` walks the graph with `follow_dynamic: false` and `kind: CodeOnly`. Errors come back as diagnostics (`to_string_with_range()`) and are not thrown.
- Only one graph mutation runs at a time (`deno_unsync::TaskQueue`). `resolve()` calls `add_entrypoint_urls([resolved])` when the result is still `npm:`/`jsr:`, so an async resolve can mutate the graph (and install npm packages).

### 1.3 Runtime support (Node vs Deno vs Bun)

- `mod.ts` checks `typeof Deno !== "undefined"`. Under Deno it does `await import("./lib/rs_lib.js")`, which is a wasm ESM import. Otherwise it does `await import("./rs_lib_node.js")`, which runs `readFileSync(rs_lib.wasm)` → `new WebAssembly.Module` → `new WebAssembly.Instance(..., {"./rs_lib.internal.js": internal, "node:tty": {isatty}})`. Instantiation is sync, top-level-await ESM.
- The glue imports `closeSync, copyFileSync, fchmodSync, fdatasyncSync, fstatSync, fsyncSync, ftruncateSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync` from `node:fs`, and `cwd, env, platform` from `node:process`. It also reads the `process` global for `platform`/`arch` (npm `os`/`cpu` filtering).
  - **All file IO is synchronous** and blocks the event loop.
  - It also uses `SharedArrayBuffer` + `Atomics.wait` (sys_traits' sleep, e.g. lock polling), `crypto.getRandomValues`, and `new Function(...)`.
- History: issue #57 "wasm import not recognized by node" (Node `ERR_UNKNOWN_FILE_EXTENSION ".wasm"`). It was fixed by #82 in 0.4.0 plus sys_traits 0.1.27 (#83). The issue is still open.
- Verified (`$SCRATCH/looptest/test-loader.mjs` on `$SCRATCH/sample`):

| Runtime | import wasm | `createLoader` | `addEntrypoints` (warm cache, 110 modules) | Result |
|---|---|---|---|---|
| Node 26.8.1 | 14–35 ms | 15–19 ms | 95–101 ms | all APIs OK |
| Bun 1.3.14 | 92 ms | 28 ms | 73 ms | all APIs OK |
| Deno 2.9.7 (`jsr:@deno/loader@0.5.0` or the local file) | 23 ms | 22 ms | 83 ms | all APIs OK |
| Node, **cold** `DENO_DIR` | 14 ms | 15 ms | **3,237 ms** | downloaded everything itself |

- The docs say "Works in both Deno and Node.js. For Node.js, install from JSR (`npx jsr add @deno/loader`) which provides pre-transpiled JavaScript."
- **Install friction (verified).** `npm install @deno/vite-plugin@2.0.4` fails with `404 GET registry.npmjs.org/@jsr%2fdeno__loader`. So does `bun install`. Both fail **unless `.npmrc` has `@jsr:registry=https://npm.jsr.io`**. pnpm 12 resolves `@jsr/*` to npm.jsr.io out of the box, and so does Deno (≥2.6.7, #31925). A Node-published plugin that depends on `@deno/loader` must vendor it or document the `.npmrc` line.

### 1.4 Network and caching

- **It downloads by itself** through the global `fetch` in `helpers.js::fetch_specifier(specifier, headers, clientCertConfig)` with `redirect: "manual"`. Rust follows redirects and parses 304/3xx/404. Every download prints `console.error("Downloading", specifier)`. **This cannot be turned off**, which makes it noisy in dev servers.
- The npm path (`download_with_retries_on_any_tokio_runtime`) has "todo: implement retrying", so there are **no retries**. It sends `authorization` (from `.npmrc`) and `if-none-match`. mTLS `certfile`/`keyfile` from `.npmrc` works **only under Deno**, via `Deno.createHttpClient`. Under Node it is silently ignored.
- `DENO_DIR` is honoured, and the cache layout is identical to the CLI's, so `deno install` and the loader share one cache. I verified this with `DENO_DIR=$SCRATCH/denodir-cold`, which got `remote/`, `npm/` and `gen/`.
- `DENO_AUTH_TOKENS` is honoured: `AuthTokens::new_from_sys(&sys)` in `libs/resolver/file_fetcher.rs` reads `process.env` through sys_traits.
- **Bug (verified):** `cachedOnly: true` only sets the npm cache to `Only`. Remote `https:`/`jsr:` modules are still downloaded; I saw 110 "Downloading" lines on a cold DENO_DIR. npm then fails with `Failed loading https://registry.npmjs.org/kleur for package "kleur"`.
- **No `deno install`/`deno cache` step is needed first.** An empty DENO_DIR works if the network is up.

### 1.5 npm handling (verified with `$SCRATCH/sample*`)

| Project setup | What the loader does |
|---|---|
| `deno.json` without `nodeModulesDir`, no `package.json` (= `"none"`) | npm packages are downloaded into the **global cache** `DENO_DIR/npm/registry.npmjs.org/<name>/<ver>/`. `resolveSync("npm:kleur@^4")` → `file:///…/Caches/deno/npm/registry.npmjs.org/kleur/4.1.5/index.mjs` (the Require mode gives `index.js`) |
| `{"nodeModulesDir":"auto"}` | **The loader runs the npm install itself.** It prints `Initialize kleur@4.1.5`, creates `node_modules/.deno/kleur@4.1.5/node_modules/kleur` plus a top-level `node_modules/kleur` symlink and `.deno/.setup-cache.bin`, and resolves to the `node_modules/.deno/...` path. No lifecycle scripts run |
| `package.json` + pnpm `node_modules` (= BYONM/`manual`) | Resolves bare `kleur` and `npm:kleur@^4` to `node_modules/.pnpm/kleur@4.1.5/node_modules/kleur/index.mjs` (realpath). **It never installs.** A missing package errors with "Could not find a matching package for 'npm:left-pad@1' in the node_modules directory… run `deno install`… Alternatively… `"nodeModulesDir": "auto"`" |
| Lockfile present | **Eager download of every npm package in the lockfile** (`NpmCachingStrategy::Eager`). An entry importing only `kleur` also downloaded `left-pad` (verified in `sample-eager`). JSR packages are **not** eagerly fetched |
| `resolveSync` on an npm req not in the graph | `ResolveError: Could not find constraint 'left-pad@1' in the list of packages.` (no `code`) |
| async `resolve` on the same | adds it as a graph root, installs it (prints "Downloading …left-pad-1.3.0.tgz") and resolves. As documented, this can make "multiple npm installs" and resolve differently from Deno |

`newestDependencyDate` exists and `minimumDependencyAge` in `deno.json` is read (#63/#65). The loader predates Deno 2.8 `.npmrc min-release-age` (#33983) and the **Deno 2.9 default 24 h minimum dependency age** (#35458). So **without a lockfile, `@deno/loader` can pick newer npm versions than `deno install` 2.9 would** (inferred from code dates).

### 1.6 Resolution and load semantics (verified)

- **Referrer** may be `undefined` (resolved against `process.cwd()`), an absolute path, or a `file:`/`http(s):` URL. Other strings are treated as paths via `wasm_string_to_path`. An empty string counts as none.
- **Results:**
  - `jsr:@std/path@^1` → `https://jsr.io/@std/path/1.1.6/mod.ts`. Remote modules keep their `https:` URL and must be loaded via the loader.
  - `npm:` → a `file:` URL (global cache or node_modules).
  - `node:fs` and bare `fs` → `node:fs`.
  - `./helper` and `./helper.js` → `…/helper.ts` (sloppy imports).
  - A missing relative file **still resolves** (no existence check). `load` then throws a plain `Error: Import 'file:///…/missing.ts' failed, not found.`
- **Error codes seen on `ResolveError.code`:**
  - `ERR_PACKAGE_PATH_NOT_EXPORTED` for `npm:kleur@^4/nope`.
  - `ERR_MODULE_NOT_FOUND` for a missing file inside a package, with `specifier` set. Also for a bare import of an undeclared dependency inside an npm package: "Could not find package 'x' from referrer …".
  - `ERR_PACKAGE_IMPORT_NOT_DEFINED` for `#internal`.
  - `code` is undefined for `Import "kleur" not a dependency` (bare specifier without an import map) and for jsr/npm constraint errors.
- **`load()`:**
  - TS/TSX/JSX/MTS/CTS are **transpiled to JS** unless `noTranspile`, but `mediaType` still says `TypeScript`. The code keeps the inline `//# sourceMappingURL=data:…` and `sourceMap` holds the decoded bytes. JSX is transformed per the deno.json `compilerOptions` (`jsx`, `jsxImportSource`, `precompile`…) unless `preserveJsx`.
  - JS/MJS/CJS come back untouched, with no source map.
  - `node:*` → `{kind:"external"}`.
  - `data:` URLs → a module (JavaScript).
  - `jsr:` throws "jsr: specifiers must be resolved to an https: specifier before being loaded."
  - `npm:` throws "Resolve the npm: specifier to a file: specifier before providing it to the loader."
  - JSON with `RequestedModuleType.Json` → raw bytes, `mediaType Json`. Text/Bytes → raw bytes, `mediaType Unknown`.
  - `.wasm` → **raw wasm bytes, `mediaType Wasm`**. The plugin must generate the instantiate/re-export JS itself (as `deno bundle` does, §4.3).
  - `with { type: "css" }` → diagnostic "The import attribute type of "css" is unsupported." (pre-2.9 graph).
- **Staleness (verified, `sample-hmr`), a critical pitfall for watch/HMR:**
  - Once a local file is in the graph, `load()` keeps returning the **old content after the file changes**. Calling `addEntrypoints([entry])` again does not refresh it.
  - Local files **not** in the graph are re-read on every `load`.
  - Fix: `await workspace.createLoader()` again (12 ms) plus `addEntrypoints`. Or better, let the bundler read `file:` modules itself and use the loader only for `https:`/`jsr:`/`npm:` code. There is no invalidate API.
- `getGraphUnstable()` returns `{roots, modules, redirects, packages}`, the deno_graph JSON (same shape as `deno info --json` modules).

### 1.7 Threading and async model

- One single-threaded wasm instance per JS realm (no wasm threads, `Rc`/`RefCell` everywhere). Async works through wasm-bindgen-futures on JS promises. FS is sync, network is async `fetch`, and sleeping uses `Atomics.wait` (blocking).
- A `Loader` cannot be shared across worker threads. Each worker must load its own 5.5 MB wasm and Workspace.
- The Rust logger is global (`OnceLock`), so the first Workspace's `debug` wins.
- Dropping a Workspace or Loader clears thread-local `PackageJsonThreadLocalCache` / `NodeResolutionThreadLocalCache`, which are **shared by every Workspace in that wasm instance**. `@deno/vite-plugin` keeps one Workspace per Vite environment (ssr: node, client: browser) in one instance.
- `Workspace` and `Loader` implement `[Symbol.dispose]` (they call `free()`).

### 1.8 Changelog (JSR publish dates; features mapped from merged PRs by date)

| Version | Date | Notable |
|---|---|---|
| 0.0.1–0.0.8 | 2025-06-05…06-10 | initial. #1 undefined options, #2 npm entrypoints |
| 0.1.0–0.1.2 | 06-11…06-17 | #3 **transpile loaded files**, #8 cached headers, #10 npm exports not in graph, #12 map entrypoints |
| 0.1.3 | 07-04 | Deno upgrade |
| 0.2.0/0.2.1 | 07-09/07-14 | #18/#19 **bytes & text imports** (incl. npm), #22 detached ArrayBuffer fix |
| 0.3.0 | 07-31 | #34/#35 `addEntrypoints` (was `addRoots`), #36 graph errors → diagnostics, #37 **async `resolve` of npm/jsr on demand**, #39 `configPath` as file: URL, #40 resolution-mode fix, #41 **`platform: "browser"`**, **#42 BREAKING: removed `entrypoints` option**, #31 `getGraphUnstable`, #32 jsr load error message, #26 redirects |
| 0.3.1–0.3.4 | 08-01…08-06 | #43 ESM directory import when bundling, #45 error objects, #46 Rust debug logs, #47 **fill graph from lockfile** |
| 0.3.5 | 08-15 | #50 enhanced `ResolveError`, #52 `isOptionalDependency` |
| 0.3.6 | 09-19 | #58 Deno upgrade, #59 reuse JSR metadata store (perf) |
| 0.3.7/0.3.8 | 10-15/10-22 | #63 `newestDependencyDate`, #65 read it from config |
| 0.3.9/0.3.10 | 10-28/11-19 | #68 wasm-bindgen 0.2.105 |
| 0.3.11 | 2026-01-09 | #70 **added `Jsonc`/`Json5` to `MediaType`**. This shifted the numeric values of `Html`…`Unknown`, so always use the enum from the same version |
| 0.3.12 | 02-05 | #74 `jsr:` specifiers in package.json |
| 0.3.13/0.3.14 | 02-24/03-05 | Deno upgrades |
| **0.4.0** | 03-28 | #82 **Node.js runtime support**, #83 sys_traits 0.1.27 |
| **0.5.0** | 03-29 | #84 **`sourceMap` on `ModuleLoadResponse`** (for deno-vite-plugin #92) |

### 1.9 Issues and PRs (https://github.com/denoland/deno-js-loader)

Open issues:
- **#86** "Update to deno 7.9" (2026-07-01). The user needs link **globs** (denoland/deno#34849) for the Vite plugin, and asks for an update to Deno 2.9. The loader has had no Deno bump since March.
- **#72** "deno loader 0.3.10 failed reading lockfile during vite build": `Unsupported lockfile version ''` in Docker after `deno install --allow-scripts`. dsherret: "keep the deno.lock during deployment".
- **#66** "Node browser field `false` not supported". Neither the object form nor `false` of `browser` works, because `deno_package_json` models `browser` as a string. Deno 2.8.1 fixed it in `deno bundle` only (#34407), and the pinned loader predates that.
- **#57** "wasm import not recognized by node": effectively fixed in 0.4.0, still open.
- **#56** "Allow to override JSX transform options": per-`load()` JSX options, for Fresh's client-vs-server loaders.

Closed issues worth knowing:
- #60 node conditions order ignored.
- #55 detached ArrayBuffer.
- #44 debug logged `[object Promise]`.
- #38 add browser platform.
- #30 `nodeConditions: ["browser",…]` resolved fflate wrongly.
- #29 Unsupported scheme "jsr".
- #28 access to the inner graph.
- #23 ERR_UNSUPPORTED_DIR_IMPORT.
- #21, #20 npm resolution bugs.
- #17 missing optional peer dep.
- #16 can't create a loader when entrypoint deps are unresolvable.
- #15 workspace member import map.
- #14 bytes/text.
- #6 mapped entrypoint.
- #5 https specifiers.

Open PRs:
- **#61** "perf: negative cache package.json" (lucacasonato). It depends on denoland/deno#30792.
- #87 "support minimumDependencyAge in deno.json (Deno 2.9)" by kuboon was *closed* because the author thought 0.3.14 was the latest.

### 1.10 How the official plugins consume it (import surface only)

- **`@deno/esbuild-plugin` 1.2.1** (JSR, 2025-12-03; `"@deno/loader": "jsr:@deno/loader@^0.3.10"`)
  - Imports: `import { MediaType, RequestedModuleType, ResolutionMode, Workspace, type WorkspaceOptions } from "@deno/loader"`.
  - `setup()` builds `new Workspace({debug, configPath, nodeConditions: ctx.initialOptions.conditions, noTranspile, preserveJsx, platform})` and then `createLoader()`. It **never calls `addEntrypoints`**. Every `onResolve` does `await loader.resolve(path, importer, kind)`.
  - Errors matching `/not a dependency and not in import map|Relative import path ".*?" not prefixed with/` are turned into `null`.
  - Namespaces are `file|http|https|npm|jsr`, plus `onDispose → loader[Symbol.dispose]`.
  - `publicEnvVarPrefix` text-replaces `Deno.env.get()`/`process.env` using `Deno.env`, so that option is Deno-only.
- **`@deno/rolldown-plugin` 0.0.10** (JSR, 2025-07-31; `jsr:@deno/loader@^0.3.0`)
  - Imports: `type Loader, type LoadResponse, MediaType, RequestedModuleType, ResolutionMode, Workspace, type WorkspaceOptions`.
  - `buildStart` runs `addEntrypoints(inputs)`. `resolveId` runs `await loader.resolve`. `load` dedupes promises and uses `RequestedModuleType.Default`.
- **`@deno/vite-plugin` 2.0.4** (npm, 2026-09-24; `"@deno/loader": "npm:@jsr/deno__loader@^0.5.0"`, `"@std/jsonc": "npm:@jsr/std__jsonc@^1"`, repo `.npmrc` has `@jsr:registry=https://npm.jsr.io`)
  - Imports: `type Loader, type MediaType, Workspace, type WorkspaceOptions` (index.ts); `type Loader, MediaType, RequestedModuleType, ResolutionMode, ResolveError` (resolver.ts); `type Loader, RequestedModuleType` (resolvePlugin.ts).
  - One loader per environment (`environments: Record<string, Omit<WorkspaceOptions,"configPath">>`, `workspaceOptions`).
  - `configPath` comes from `findDenoConfig(root)`.
  - It calls `resolveSync(id, undefined, Import)` and falls back to `addEntrypoints([resolved])`.
  - It has a post-transpile hook option.

---

## 2. `@jeiea/unplugin-deno` (the closest prior art in name only)

- **Where:** JSR `@jeiea/unplugin-deno` (0.1.0 and 0.1.1, created 2025-03-27, JSR score 94, runtimeCompat `{deno:true}` only). Not on npm. Repo https://github.com/jeiea/unplugin-deno: 0★, 0 forks, 0 issues/PRs, **8 commits, all on 2025-03-28**, never touched again. MIT.
- **README:** "deno unplugin. Simplified version of [@bureaudouble/rolldown-deno-loader-plugin] … Not extensively tested." The lineage is nestarz's `@bureaudouble/rolldown-deno-loader-plugin` 0.1.x (Jan 2025, single `mod.ts`). nestarz later filed many `@deno/loader` issues (#15, #20, #21, #23, #28, #30, #31).
- **Exports** (`deno.json`): `./esbuild`, `./rolldown`, `./vite`, `./unplugin`. Each wraps `createEsbuildPlugin`/`createRolldownPlugin`/`createVitePlugin`/`createUnplugin` from `npm:unplugin@^2` (2.2.2) around one factory.
- **Architecture** (`src/internal/factory.ts`, `src/internal/deno_loader.ts`, 216 LOC):
  - `Options = object | undefined`, so there are **no options at all**.
  - Hooks: **only `resolveId(id, importer)` and `load(id)`**. No `enforce`, no `transform`, no `loadInclude`/filters, no `buildStart`, no watch or HMR hooks.
  - `resolveId`:
    - Skips anything whose importer path contains `node_modules`.
    - Absolutizes relative specifiers against the importer with `new URL`.
    - Bare specifiers go through `#resolveFromImportMap`, which is misnamed. It only does `new URL(id, importer)` and returns `id` on failure, so **there is no import-map support**.
    - `node:` → external. `file:` → `fromFileUrl`.
    - `jsr:` → runs `deno info` and returns the redirected `https://jsr.io/...` URL.
    - `http(s):` → returns the URL as id. `npm:` is **not handled** (falls through to undefined).
  - `load(id)`: for `jsr:`/`http(s):` ids, runs `#denoResolve(id)`, which spawns `Deno.Command(Deno.execPath(), ["info", "--no-config", "--quiet", "--json", specifier])`. It caches every module from the JSON (`specifier → {localPath: local, redirected, moduleType}`) plus redirects. Then it does `Deno.readTextFile(local)` and wraps JSON as `export default …`.
  - Because of `--no-config`, **deno.json imports, lockfile, nodeModulesDir and compilerOptions are all ignored**. TS/JSX transpilation is left to the host bundler, keyed off the URL extension.
  - Bugs:
    - It checks `"npm_package" in details`, but the real field is `npmPackage`.
    - `mapMediaType` uses the names "JSX"/"TSX", but Deno emits `Jsx`/`Tsx`.
    - Cache keys are built with `specifier.replace("file://","")`.
    - An https module whose extension doesn't match its content type (e.g. esm.sh URLs without `.js`) gets no loader hint.
- **Tests:** a single test (`test/basic.test.ts`). It runs rolldown `1.0.0-beta.6` on `import { delay } from "https://deno.land/std@0.224.0/async/delay.ts"` and snapshot-compares the output. CI runs `deno task ci` (fmt/lint/check/test/publish --dry-run) on ubuntu and windows, and publishes to JSR from the `release` branch.
- **Why no traction:**
  1. It runs on Deno only (it uses `Deno.Command`, `Deno.readTextFile`, `npm:`/`jsr:` import specifiers in its own source), so Node users of Vite/esbuild/Rolldown can't install it.
  2. It covers a tiny slice of Deno semantics: no npm, no import maps, no config, no lockfile, no workspaces.
  3. It spawns `deno info` subprocesses: slow, with a cold start per root.
  4. It was published once, is undocumented, and says it's untested.
  5. Deno shipped `@deno/loader`, `@deno/rolldown-plugin` (June 2025) and `@deno/esbuild-plugin`, and `@deno/vite-plugin` moved onto the loader, 2–3 months later.
  6. It sits under a personal JSR scope and not on npm, where unplugin users look. **Note: the npm name `unplugin-deno` is unregistered (404)** as of 2026-09-25.

## 3. `unplugin-jsr`

- It is on npm only as a placeholder. `unplugin-jsr@0.0.0` was published 2024-03-03T19:04Z, two days after the JSR public beta, by **sxzz** (Kevin Deng). The repo was `git+https://github.com/unplugin/unplugin-jsr.git` and the description "Native support for JSR."
- It was **unpublished on 2025-08-05**. The registry now returns `404 Unpublished`, and GitHub `unplugin/unplugin-jsr` (and `sxzz/unplugin-jsr`) return 404.
- I recovered the tarball from `registry.npmmirror.com`; it is at `$SCRATCH/tarballs/unplugin-jsr/package`. Its deps are `unplugin ^1.7.1`, `@rollup/pluginutils ^5.1.0` and `magic-string ^0.30.7`. Exports: `.`, `./vite`, `./rollup`, `./esbuild`, `./webpack`, `./api`.
- The whole implementation is sxzz's starter template:
  ```js
  // dist/chunk-I62M4VVG.js
  var src_default = createUnplugin((rawOptions = {}) => {
    const options = resolveOptions(rawOptions); // include [/\.[cm]?[jt]sx?$/], exclude [/node_modules/], enforce "pre"
    const filter = createFilter(options.include, options.exclude);
    return { name: "unplugin-jsr", enforce: options.enforce,
      transformInclude(id) { return filter(id); },
      transform(code, id) { console.log(code, id); return void 0; } };
  });
  ```
  **It never mapped `jsr:` to anything.** No `npm.jsr.io`, no `node_modules/@jsr`, no direct fetch. There are no issues to report, since the repo is gone.
- **How JSR actually reaches Node bundlers today** (for our design):
  - Every JSR package is mirrored as an npm package `@jsr/<scope>__<name>` on `https://npm.jsr.io` (tarball `https://npm.jsr.io/~/11/@jsr/std__fmt/1.0.10.tgz`). It holds **transpiled `.js` + `.js.map` + `_dist/*.d.ts` alongside the original `.ts`**, with `exports` in `package.json`.
  - Package managers:
    - `npx jsr add` writes `.npmrc` `@jsr:registry=https://npm.jsr.io`.
    - pnpm ≥10.9 and yarn ≥4.9 support the `jsr:` protocol, and pnpm 12 resolved `@jsr/*` with no `.npmrc` (verified).
    - Deno ≥2.6.7 maps the `@jsr` scope to npm.jsr.io by default (#31925, override with `JSR_NPM_URL`).
    - Deno 2.6.8 accepts `jsr:` in package.json (#31938).
    - Deno 2.8 `deno pack` rewrites `jsr:@std/path` → `@jsr/std__path`.
    - Deno 2.9 has `jsrDepsInNodeModules` (§6.6).

---
## 4. `deno bundle` (CLI; revived in 2.4, still "⚠️ experimental" in 2.9.7)

### 4.1 `deno bundle --help` (Deno 2.9.7, verbatim; also in `$SCRATCH/data/deno-bundle-help.txt`)
```
Output a single JavaScript file with all dependencies

Usage: deno bundle [OPTIONS] <FILE>...

Options:
  -o, --output <VALUE>    Output path`
      --outdir <VALUE>    Output directory for bundled files
      --format <VALUE>    
      --packages <VALUE>  How to handle packages. Accepted values are 'bundle' or 'external'
      --platform <VALUE>  Platform to bundle for. Accepted values are 'browser' or 'deno'
      --sourcemap[=<VALUE>]  Generate source map. Accepted values are 'linked', 'inline', or 'external'
      --external [VALUE...]  
      --watch             Watch and rebuild on changes
      --minify            Minify the output
      --keep-names        Keep function and class names
      --code-splitting    Enable code splitting
      --inline-imports[=<VALUE>]  Whether to inline imported modules into the importing file [default: true]
      --declaration       Generate .d.ts declaration files alongside the bundle
      --check[=<VALUE>]   Enable type-checking. This subcommand does not type-check by default; pass --check=all to also type-check remote modules. Alternatively, use the 'deno check' subcommand.
      --no-check[=<VALUE>]  Skip type-checking. If the value of "remote" is supplied, diagnostic errors from remote modules will be ignored
      --import-map <VALUE>  Load import map file from local file or remote URL
                            Docs: https://docs.deno.com/runtime/manual/basics/import_maps
      --no-remote         Do not resolve remote modules
      --no-npm            Do not resolve npm modules
      --node-modules-dir[=<VALUE>]  Selects the node_modules directory mode for npm packages (not a path). One of: auto (create a local node_modules directory and install npm packages into it), manual (use the existing local node_modules directory, do not modify it), none (do not use a local node_modules directory; resolve npm packages from the global cache). Defaults to auto when the flag is passed without a value.
      --vendor[=<VALUE>]  Toggles local vendor folder usage for remote modules and a node_modules folder for npm packages
      --node-modules-linker <VALUE>  Sets the linker mode for npm packages (isolated or hoisted)
  -c, --config <VALUE>    Configure different aspects of deno including TypeScript, linting, and code formatting.
                            Typically the configuration file will be called `deno.json` or `deno.jsonc` and
                            automatically detected; in that case this flag is not necessary.
                            Docs: https://docs.deno.com/go/config
      --no-config         Disable automatic loading of the configuration file
  -r, --reload[=VALUE...]  Reload source code cache (recompile TypeScript). With no value, reloads everything. Pass a comma-separated list of specifiers to reload only those modules; npm: reloads all npm modules; npm:chalk reloads a single npm module; jsr:@std/http/file-server,jsr:@std/assert/assert-equals reloads specific modules.
      --lock [<VALUE>]    Check the specified lock file. (If value is not provided, defaults to "./deno.lock")
      --no-lock           Disable auto discovery of the lock file
      --frozen-lockfile[=<VALUE>]  Error out if lockfile is out of date
      --cert <VALUE>      Load certificate authority from PEM encoded file
      --unsafely-ignore-certificate-errors[=VALUE...]  DANGER: Disables verification of TLS certificates
      --min-dep-age <VALUE>  (Unstable) The age in minutes, ISO-8601 duration or RFC3339 absolute timestamp (e.g. '120' for two hours, 'P2D' for two days, '2025-09-16' for cutoff date, '2025-09-16T12:00:00+00:00' for cutoff time, '0' to disable)
  -I, --allow-import[=VALUE...]  Allow importing from remote hosts. Optionally specify allowed IP addresses and host names, with ports as necessary. Default value: deno.land:443,jsr.io:443,esm.sh:443,raw.esm.sh:443,cdn.jsdelivr.net:443,raw.githubusercontent.com:443,gist.githubusercontent.com:443
      --deny-import[=VALUE...]  Deny importing from remote hosts. Optionally specify denied IP addresses and host names, with ports as necessary.
      --allow-scripts[=VALUE...]  Allow running npm lifecycle scripts for the given packages
                            Note: Scripts will only be executed when using a node_modules directory (`--node-modules-dir`)
```
Notes on the flags:
- `--format` takes `esm` (default), `cjs` or `iife`. Its help text is empty.
- `--platform` takes `deno` (default) or `browser`. With `deno`, esbuild gets **no** `--platform` flag, so esbuild falls back to its own default, which is browser. Deno then post-patches the require shim (see §4.3).
- `--inline-imports` maps to esbuild `--bundle`. `--inline-imports=false` means transpile only, and it leaves `jsr:`/`npm:`/`./x.ts` specifiers untouched (verified).
- `--declaration` arrived in 2.9.0. It rolls up `.d.ts` files.
- `--keep-names` arrived in 2.7.0 (#32285).
- `--check` is honoured since 2.8.3 (#33514).
- HTML entrypoints require `--outdir` (2.5.0, #29856).
- Hidden behaviour:
  - Sloppy imports are forced on (`flags.unstable_config.sloppy_imports = true`).
  - The `NO_DENO_BUNDLE_HACK` env var disables the require-shim rewrite.
  - Metafile is always on.
  - Tree shaking is always on.
- **CLI pitfall (verified):** `--external [VALUE...]` is variadic. `deno bundle --external 'npm:*' main.ts` swallows `main.ts` and prints "Bundled 0 modules". Use `--external='npm:*'`.

### 4.2 How it uses esbuild (`cli/tools/bundle/esbuild.rs`, `mod.rs`)
- It is **not** a fork and not in-process. `ESBUILD_VERSION = "0.25.5"` and `ESBUILD_CACHE_VERSION = 1`.
- `ensure_esbuild()` downloads the npm package `@esbuild/<platform>` (e.g. `darwin-arm64`, `linux-x64`, `win32-arm64`, `android-arm64`) through Deno's npm registry client and tarball cache. It copies `bin/esbuild` atomically (tmp + rename, to avoid ETXTBSY races) to **`DENO_DIR/dl/esbuild-0.25.5-1/esbuild-<platform>`**, then deletes the extracted npm folder. I verified this: the file appeared on first `deno bundle`.
  - Since 2.9.6 (#36467) this uses the **home** `.npmrc` only, "isolate esbuild downloads from workspace registries".
  - In an offline first run, bundling cannot work.
- Deno drives the binary through **`esbuild_client`** (crate 0.7.2, https://github.com/denoland/esbuild_client, "A Rust implementation of a client for communicating with esbuild's service API over stdio").
- It sends one `BuildRequest` with `plugins: [{ name: "deno", on_resolve: [{filter: ".*", namespace: ""}], on_load: [{filter: ".*", namespace: ""}], on_end: watch }]` and `write: false`. Watch mode uses esbuild **context/rebuild**, and changed paths come from `metafile.inputs`.
- The flags come from `EsbuildFlagsBuilder`: `bundle(inline_imports)`, `minify`, `splitting`, `externals`, `tree_shaking(true)`, `format`, `packages`, `--keep-names`, `sourcemap`, `outdir|outfile`, and `metafile(true)`. HTML adds `platform=browser`, `splitting`, and `[dir]/[name]-[hash]` for entry, chunk and asset names.
- `Deno.bundle()` and `deno bundle` share `bundle_init()`. The runtime API goes through `CliBundleProvider`, which starts a new thread with its own tokio runtime. There, permissions are the **caller's** (`is_runtime_api`), reads are permission-checked (#36107, 2.9.5), and type-check is forced off.
- Output files get `hash` = base64(xxhash64). In-memory output (no outputPath/outputDir) has `path: "<stdout>"` (verified).

### 4.3 What the `"deno"` esbuild plugin does: an edge-case checklist for any Deno bundler plugin

The code references are `cli/tools/bundle/mod.rs` @ v2.9.7.
1. **Resolution** goes through `resolver.resolve_with_graph(graph, path, referrer, …, maintain_npm_specifiers: false)`, with the esbuild import kind mapped to Import or Require.
   - Referrer = importer, or `resolve_dir`, or the initial cwd. A directory referrer gets a trailing separator.
   - Results: `file:` → an OS path. `jsr:`/`https:`/`http:`/`data:` → **namespace `"deno"`**. The output comments show `// deno:https://jsr.io/...`.
   - Fallback: a bare specifier that fails is retried through `resolve_bare_specifier_in_npm_snapshot`. This covers sources reached through `new Worker(new URL(...))` outside the package scope.
   - Ignorable errors are **deferred**, and `None` is returned so esbuild can tolerate fallible `try { require("x") }` or `import().catch`. Ignorable means package-not-found, or an import-map `UnmappedBareSpecifier`. This dates from 2.5.0 (#30522).
2. **Externals:** `ExternalsMatcher` has pre-resolve patterns (one `*` wildcard, prefix/suffix) and post-resolve patterns (relative ones are absolutized against cwd).
   - Always external: `node:*`, `bun:*` (2.5.7/2.6.0, #31411), and **`*.node` native addons** (esbuild has no loader for them). The 2.6 blog post says `cloudflare:` is external too, **but on 2.9.7 `import { connect } from "cloudflare:sockets"` fails with `Plugin "deno" returned a non-absolute path: cloudflare:sockets (set a namespace if this is not a file path)`** (verified). Only `bun:` and `node:` are hard-coded.
   - CSS `url(#frag)` and `@import "#…"` are external (2.7.14, #33492).
3. **`browser` field**: `platform browser` understands the object form (2.8.1, #34407). A `false` mapping (`BrowserMapDisabled`) resolves to the sentinel `"\0deno-browser-disabled:<spec>"`, which loads as `module.exports = {};`.
4. **`sideEffects`** (2.8.1, #34406). For local file paths the plugin reads the closest `package.json` `sideEffects`: `false` → `side_effects: Some(false)`. It supports webpack-style patterns, where a pattern with no `./`, `/` or `*` prefix means `**/<pattern>`, matched with glob.
5. **Load** runs `module_loader.load(graph, specifier, requested_type)`. The esbuild loaders come from `media_type_to_loader`:

   | Media type | esbuild loader |
   |---|---|
   | JS, Cjs, Mjs, **Mts** | `js` |
   | TS, Cts, Dts, Dmts, Dcts | `ts` |
   | Jsx, Tsx | `jsx` |
   | Css | `css` |
   | Json | `json` |
   | Jsonc, Json5, Markdown, SourceMap, Html, Sql | `text` |
   | Wasm, Unknown | `binary` |

   Unprepared modules are fetched and transpiled when emittable. An unsupported media type returns `None`, which lets esbuild decide.
6. **Import attributes:**
   - `type: "text"` → loader `text`. `"bytes"` → `binary`. `"json"` → `json`.
   - **`"css"` → a synthesized JS module** `const sheet = new CSSStyleSheet(); sheet.replaceSync(<json>); export default sheet;` (2.9.1, #35598).
   - Raw imports are also preserved across watch rebuilds (2.9.3, #36040).
7. **Wasm** (2.8.3, #34923): `wasm::render_js_wasm_module` parses imports and exports with `wasm_dep_analyzer`. It emits `import {…} from "<module>"` for each wasm import, inlines the bytes as **base64**, and compiles and instantiates **synchronously**, then re-exports the instance exports. The source comment says "Async compilation isn't an option here because esbuild can't consume the source-phase `import source … from` form".
8. **`import.meta.main`** (`transform.rs`, `BundleImportMetaMainTransform`): the transform leaves it as-is in entrypoints and **rewrites it to `false` in every other module**. It is fixed for jsr entrypoints (2.5.7, #31415). This runs as an extra SWC parse and emit per non-root JS/TS module on a blocking thread. Its `Cjs` input is parsed as JavaScript so that CJS→ESM facades parse.
9. **CJS interop hacks** (post-processing of esbuild output):
   - `replace_require_shim()` runs only for `platform: deno`. It regex-replaces esbuild's `__require` Proxy shim with `import { createRequire as __deno_internal_createRequire } from "node:module"; var __require = __deno_internal_createRequire(import.meta.url);`. It has minified and non-minified variants and is disabled by `NO_DENO_BUNDLE_HACK`. It is not applied for browser (2.6.0).
   - `force_node_cjs_interop()` exists because esbuild can't learn a module's type when a plugin owns resolution: "esbuild's plugin protocol has no way to communicate a module's type". So esbuild emits browser-mode `__toESM`, which breaks tslib-style `__esModule` CJS default imports. Deno regex-rewrites `<isNodeMode> || !mod || !mod.__esModule ?` to `1 ?` **for all platforms** (2.8.2, #34533; 2.8.3, #34939; issues #34524 and #34837). **Any esbuild plugin that owns resolution has this problem.**
10. **HTML entrypoints** (`html.rs`, 2.5.0):
    - Parses only `<script src>` tags. `type=module`, classic and unquoted forms are handled, and `deno-ignore` / `vite-ignore` attributes skip a tag.
    - Each HTML file becomes a virtual JS entry in the `deno` namespace. CSS imported from JS is emitted and injected as `<link rel="stylesheet">`. Scripts are hashed (`index-ALM56MBJ.js`, with `crossorigin`).
    - **Existing `<link href="style.css">` tags are left untouched and not copied** (verified).
    - HTML is re-parsed on watch (2.5.2). Source maps for HTML entrypoints are renamed (2.8.3).
11. **Declarations** (2.9.0 `--declaration`): `emit_bundle_declarations` runs the TS emitter and then `flatten_declarations`/`inline_declarations` to roll re-export chains into one `.d.ts` per entry (verified: `helper.d.ts`).
12. `data:` URLs are left to esbuild (2.7.0, #32213). **Observed:** `data:application/javascript,...` stays as an external `import * as dataMod from "data:..."` in the output. esbuild only inlines `text/javascript`-style MIME types.
13. **Observed bug (2.9.7):** `--packages=external` has **no effect** on `npm:`/`jsr:`/import-mapped packages. The kleur code was still bundled from `…/Caches/deno/npm/registry.npmjs.org/kleur/4.1.5/index.mjs`, because the `deno` plugin resolves everything to paths before esbuild's package check. `--external='npm:*'` and `--external='jsr:*'` do work and leave `npm:kleur@^4` in the output, which then runs only on Deno. I found no matching issue.

### 4.4 Related issues and PRs (denoland/deno)
- **PR #34345 (open, 2026-05-25, +4734/−2460, CI 55 failing, no human review)**: "refactor(bundle): swap esbuild backend for rolldown 1.2, add Deno.bundle() plugin API".
  - It links `rolldown =1.2.0` as a crate, so there is no binary download.
  - It uses `resolve_id` + `load` hooks.
  - For CJS interop it reports a **synthetic `{"type":"module"}` package.json** for files outside node_modules.
  - Raw imports are rewritten to `?deno-raw-*` query ids, because rolldown dedupes by id.
  - `.cjs`/`.cts` files that use `import.meta` get `?deno-cjs`.
  - CSS is concatenated, because rolldown 1.2 dropped CSS bundling.
  - Plugin API: `plugins: [{ name, setup(build) { build.onResolve({filter}, cb); build.onLoad(...); build.onTransform(...) } }]`, with hook results like `{ id: "\0env" }` and `{ code, loader: "js" }`. The hooks run over ops `op_bundle_plugin_next/respond/start/finish`, and it is "deliberately not a drop-in for the Vite or esbuild plugin ecosystems".
  - Errors come back as `{success:false, errors}` instead of throwing.
- Open issues on the runtime API:
  - #31753 in-memory or stdin entrypoints.
  - #31421 `importMap`/`imports` option.
  - #32257 esbuild `--pure`.
  - #30721 `--outbase`.
  - #36560 `import defer` fails to bundle.
  - #36545 wrong source maps with stage-3 decorators.
  - #31597 not available in `deno compile` binaries. The error text reads "Deno.bundle() is not available in compiled binaries".
  - #31517 aarch64 android.
  - #34394 inconsistent paths.
  - #36540 `deno compile --bundle` has no `--keep-names`.
  - #32157 feature request for a Bun-like plugin for imports.
- Closed: #30750 "Deno.bundle Error: channel closed", #31524 "Deno.bundle does not match CLI platform behavior", #36417 esbuild service deadlock under CPU starvation (fixed in 2.9.5 by #36427).

## 5. `Deno.bundle()` runtime API

- **Added in 2.5.0** (#29949). It **requires `--unstable-bundle`**, or `"unstable": ["bundle"]` in deno.json. Without it, `typeof Deno.bundle === "undefined"` (verified).
- Permissions: read access to local entrypoints and their dependency tree, **import permission** for remote modules, and **write** when output goes to disk.
- It works in Workers since 2.6.0 (#31316) and **fails in `deno compile` output** (the no-op `BundleProvider`). The first call downloads esbuild.
- Types (`cli/tsc/dts/lib.deno.unstable.d.ts` @ v2.9.7, verbatim apart from comments):
```ts
declare namespace Deno {
  export namespace bundle {
    export type Platform = "browser" | "deno";
    export type Format = "esm" | "cjs" | "iife";
    export type SourceMapType = "linked" | "inline" | "external";
    export type PackageHandling = "bundle" | "external";
    export interface Options {
      entrypoints: string[];
      outputPath?: string;
      outputDir?: string;
      external?: string[];
      format?: Format;
      minify?: boolean;
      keepNames?: boolean;
      codeSplitting?: boolean;
      inlineImports?: boolean;
      packages?: PackageHandling;
      sourcemap?: SourceMapType;
      platform?: Platform;
      /** @default true if outputDir or outputPath is set, false otherwise */
      write?: boolean;
    }
    export interface MessageLocation { file: string; namespace?: string; line: number; column: number; length: number; suggestion?: string; }
    export interface MessageNote { text: string; location?: MessageLocation; }
    export interface Message { text: string; location?: MessageLocation; notes?: MessageNote[]; }
    export interface OutputFile { path: string; contents?: Uint8Array<ArrayBuffer>; hash: string; text(): string; }
    export interface Result { errors: Message[]; warnings: Message[]; success: boolean; outputFiles?: OutputFile[]; }
  }
  export function bundle(options: Deno.bundle.Options): Promise<Deno.bundle.Result>;
}
```
- **There is no `plugins` option** and no importMap, stdin or virtual entry. `ext/bundle/src/lib.rs` already defines unused `OnResolveOptions{filter: Regex, namespace}` / `OnLoadOptions` structs, which hints at the plugin API in PR #34345.
- The Rust `BundleOptions` defaults are `inline_imports = true`, `write = true`, `format = Esm`, `platform = Deno` and `packages = Bundle`. `CliBundleProvider` writes only if `write && (outputDir || outputPath)`.
- `bundle.ts` sets `success = errors.length === 0`, adds `text()` to each output file, and deletes empty `contents`/`outputFiles`.
- Relation to the CLI: the options map onto `BundleFlags`, and both run the same `bundle_init` + esbuild path. The runtime API **cannot** use `--declaration`, `--watch`, `--check` or HTML-in-memory. HTML patching runs on the write path only.
- A verified in-memory call with `platform: "browser"` and `sourcemap: "inline"` gave `{success: true, outputFiles: [{path: "<stdout>", hash: "SMr4eCyxuKM", bytes: 134469}]}`. `node:fs` stayed an external import even for browser.

## 6. Deno 2.5 → 2.9: what matters for bundlers, loaders and resolution

Sources: the deno.com blog posts for v2.5–v2.9 and the GitHub release notes, which are saved in `$SCRATCH/data/releases/`. PR numbers are denoland/deno.

### 6.1 By version
- **2.5.0 (2025-09-10)**
  - `Deno.bundle()` runtime API behind `--unstable-bundle` (#29949).
  - `deno bundle` HTML entrypoints (#29856).
  - Fallible dynamic `import()`/`require` no longer error in bundles (#30522).
  - npm entrypoints without a bin (fix).
  - npm `bundleDependencies` support (#30521).
  - `compilerOptions.moduleResolution: "bundler"` (#30603) and `rootDirs`.
  - Config `permissions` sets (`-P`).
  - Lint rules `no-unversioned-import` (recommended) and `no-import-prefix` (workspace set).
  - Refreshed `deno install` report.
- **2.5.1–2.5.7**
  - `outputFile` typed `Uint8Array<ArrayBuffer>` (#30716).
  - HTML reload in watch (#30790). `--frozen` respected by bundle (#30825).
  - **Unstable min-dependency-age** in 2.5.5: deno.json `minimumDependencyAge`, exclude list, "only install deps older than date", `--minimum-dependency-age`.
  - `deno audit` (unstable).
  - npm dedupe pass. Lockfile purge fixes. Unstable tsgo check.
  - 2.5.7: `bun:` specifiers external (#31411), `import.meta.main` transform for jsr entrypoints (#31415).
- **2.6.0 (2025-12-10)**
  - `Deno.bundle` works in a Worker (#31316).
  - No `createRequire` shim when targeting browser.
  - Bundle on Android (#31521).
  - **Wasm source-phase imports** `import source m from "./x.wasm"` (#31486).
  - `--lockfile-only` for install (#31376).
  - `deno approve-scripts` + `allowScripts` in config (#31472).
  - `#/` subpath imports (#31520).
  - tsconfig `paths` resolution, `skipLibCheck`, `isolatedDeclarations`.
  - `publish: false`. `@types/node` included by default (#31502). `--require` for CJS preload.
  - `deno x`/`dx`. Native source maps (#31268). Node timers by default.
  - Resolver falls back to execution when types can't resolve (#31507).
  - `minimumDependencyAge` documented (minutes, ISO-8601 or RFC3339).
- **2.6.x**
  - **`@jsr` npm scope → npm.jsr.io by default** (2.6.7, #31925; `JSR_NPM_URL` overrides).
  - **`jsr:` in `package.json`** (2.6.8, #31938).
  - `deno info` npm subpath fix (2.6.9, #32056).
  - `raw.esm.sh` added to the default `--allow-import` list (2.6.9, #32030).
  - `npm:`/`jsr:` inside `require()`d ESM (2.6.9).
  - Deploy bypasses minimumDependencyAge (2.6.10).
- **2.7.0 (2026-02-25)**
  - `--keep-names` for bundle (#32285).
  - Bundle lets esbuild handle `data:` URLs (#32213).
  - **npm `overrides`** (#32073).
  - `deno add --save-exact/--exact`. `deno create`. `deno install -g --node-modules-dir`. `deno install --compile`.
  - Temporal stable.
- **2.7.x**
  - BYONM resolver fixes: prefer exact version (#32977), fall through to `.deno/` (2.7.8), packages shadowing builtin names (2.7.10).
  - `file:`/`link:` deps inside npm packages are skipped (2.7.8, #32876).
  - Linked packages that aren't on npm (2.7.10). Linked packages with peer deps from lockfile (2.7.12).
  - Main path must stay inside the package dir (2.7.12, security).
  - CSS fragment URLs external in bundle (2.7.14). Clear `Deno.bundle` error in compiled binaries.
- **2.8.0 (2026-05-22)**
  - `deno pack`, which builds npm tarballs and rewrites `jsr:@std/path` → `@jsr/std__path` and `npm:express@4` → `express` (#32139).
  - **`deno transpile`** strips types with `--outdir`, `--source-map none|inline|separate` and `--declaration` (#32691). `$SCRATCH/data/deno-transpile-help.txt` has the help. It leaves specifiers unrewritten (verified).
  - `deno ci`, `deno why`, `deno bump-version`, `deno audit --fix`.
  - **Text imports stable** (#34238). Bytes imports are still `--unstable-raw-imports`.
  - `import defer` (unstable, #32360).
  - **`module.registerHooks()`** Node loader hooks, incl. CJS and ESM `import()` and inside `deno compile` (#33733, #33763, #33853). Deno's resolver is applied inside `defaultResolve`.
  - **`catalog:` protocol** (#32947, merged 2026-05-02) and `catalogs`.
  - **`nodeModulesLinker: "isolated" | "hoisted"`**, i.e. the `--node-modules-linker` flag (#32788).
  - `.npmrc` `min-release-age` (#33983), `certfile`/`keyfile`, `NPM_CONFIG_REGISTRY`.
  - `--os`/`--arch` for cross-platform installs, `--prod`, `--package-json`.
  - Unprefixed `deno add express` = npm.
  - TypeScript 6.0.3. `lib.node` in type-check by default.
  - Abbreviated packuments and parallel npm resolution ("cold npm install 3.66× faster").
- **2.8.1–2.8.3**
  - Bundle: **`browser` field map** (#34407), **`sideEffects`** (#34406), decorator pass skipped when not needed, **node-style CJS interop** (#34533, #34939), **`.wasm` imports instantiated** (#34923), `--check` honoured (#33514), no panic when the esbuild binary is busy (#34845).
  - Unstable `deno compile --bundle` (+ `--minify`) (#34527 ff).
  - Config: **globs in `links`** (2.8.3, #34849).
  - **Auto-discovery of external deno.json import maps** (#34803). A path-mapped import into another deno.json dir is linked automatically.
  - `deno info`: **`localPath` on `npmPackages`** (#34806) and `--minimum-dependency-age` (#34762).
  - Resolver: prefer deno JSX options over tsconfig (#34141), collapse `//` in file specifiers (#34713), don't treat a linked deno.json package as an npm link (#34841), resolve a local file when the folder name matches an import-mapped package.
  - Lockfile written through symlinks.
  - `allow-import` for `deno add`.
- **2.9.0 (2026-06-25)**
  - **`deno bundle --declaration`**.
  - **CSS module imports `with { type: "css" }` → `CSSStyleSheet`**, behind `--unstable-raw-imports` (#35093).
  - **`links` stable** (#34996), plus `deno link`/`deno unlink` (#34359). Linked packages resolve by bare specifier (#35228).
  - **Bare node builtins stable**: `import "fs"` means `node:fs` (#33316).
  - **Default minimum dependency age = 1440 min (24 h)** (#35458). Precedence: CLI flag > deno.json `minimumDependencyAge` > `.npmrc min-release-age` > `NPM_CONFIG_MIN_RELEASE_AGE` > default. `0`/`false` disables it.
  - **`jsrDepsInNodeModules`** (#35029, opt-in; §6.6).
  - **`preferPackageJson`** (#35392).
  - Lockfile seeding from `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock` (#35330, #35346, #35350, #35394). Auto-resolution of git merge conflicts in `deno.lock` (#34726).
  - `deno list`, `deno watch`. `node_modules` for each workspace member (#34970).
  - pnpm-workspace.yaml auto-migration.
  - **A `node` shim on PATH** (`DENO_DISABLE_NODE_SHIM=1` opts out). Tools that spawn `node` run through Deno.
  - Trust policy `trust-policy=no-downgrade`.
  - `deno compile --include-as-is`, `--bundle --minify`, `--watch`.
  - Unstable `import defer`. Node 26 compat (`process.version` v26.3.0).
- **2.9.1–2.9.7**
  - CSSStyleSheet for CSS raw imports in bundle (2.9.1).
  - Wildcards in `minimumDependencyAge.exclude` (2.9.2).
  - `--min-dep-age` alias (2.9.3). Raw imports preserved in bundle watch (2.9.3).
  - Config discovery for `jsr:` entrypoints (2.9.4).
  - Esbuild protocol deadlock fix (#36427). Bundle respects runtime file permissions (2.9.5).
  - esbuild downloads isolated from workspace registries (2.9.6). Bare npm specifier resolves when latest is too new for min-dep-age (2.9.6).
  - Lockfile tarball origin validation (#36430, #36473). `--sourcemap` optional-value semantics restored (2.9.7).
- **Grep of the 2.5–2.9 release notes for auth, vendor, compilerOptions and allow-import:**
  - compilerOptions: `rootDirs` (#30495), `moduleResolution: "bundler"` (#30603), `paths` (2.5.2, #30766), `skipLibCheck` for graph errors (2.5.5, #30989), deno JSX options preferred over tsconfig (2.8.3, #34141).
  - Registries and auth: raw.esm.sh added to the default `--allow-import` (2.6.9), scoped-registry auth applied to same-origin tarballs (2.8.2, #34698), scoped-registry auth hint on tarball 404 (2.9.1, #35514).
  - Vendoring: type-only imports vendored during `deno ci` (2.8.2, #34459).
  - **There were no `DENO_AUTH_TOKENS` changes.** It is still the `token@host;user:pass@host` env var, which `@deno/loader` honours via `AuthTokens::new_from_sys`.

### 6.2 `deno info --help` (2.9.7)
```
Show info about cache or info related to source file

Usage: deno info [OPTIONS] [FILE]

Options:
      --json              UNSTABLE: Outputs the information in JSON format
      --location <VALUE>  Show files used for origin bound APIs like the Web Storage API when running a script with --location=<HREF>
      --no-check[=<VALUE>]  Skip type-checking. If the value of "remote" is supplied, diagnostic errors from remote modules will be ignored
      --import-map <VALUE>  Load import map file from local file or remote URL
                            Docs: https://docs.deno.com/runtime/manual/basics/import_maps
      --no-remote         Do not resolve remote modules
      --no-npm            Do not resolve npm modules
      --node-modules-dir[=<VALUE>]  Selects the node_modules directory mode for npm packages (not a path). One of: auto (create a local node_modules directory and install npm packages into it), manual (use the existing local node_modules directory, do not modify it), none (do not use a local node_modules directory; resolve npm packages from the global cache). Defaults to auto when the flag is passed without a value.
      --vendor[=<VALUE>]  Toggles local vendor folder usage for remote modules and a node_modules folder for npm packages
      --node-modules-linker <VALUE>  Sets the linker mode for npm packages (isolated or hoisted)
  -c, --config <VALUE>    Configure different aspects of deno including TypeScript, linting, and code formatting.
                            Typically the configuration file will be called `deno.json` or `deno.jsonc` and
                            automatically detected; in that case this flag is not necessary.
                            Docs: https://docs.deno.com/go/config
      --no-config         Disable automatic loading of the configuration file
  -r, --reload[=VALUE...]  Reload source code cache (recompile TypeScript). With no value, reloads everything. Pass a comma-separated list of specifiers to reload only those modules; npm: reloads all npm modules; npm:chalk reloads a single npm module; jsr:@std/http/file-server,jsr:@std/assert/assert-equals reloads specific modules.
      --lock [<VALUE>]    Check the specified lock file. (If value is not provided, defaults to "./deno.lock")
      --no-lock           Disable auto discovery of the lock file
      --frozen-lockfile[=<VALUE>]  Error out if lockfile is out of date
      --cert <VALUE>      Load certificate authority from PEM encoded file
      --unsafely-ignore-certificate-errors[=VALUE...]  DANGER: Disables verification of TLS certificates
      --min-dep-age <VALUE>  (Unstable) The age in minutes, ISO-8601 duration or RFC3339 absolute timestamp (e.g. '120' for two hours, 'P2D' for two days, '2025-09-16' for cutoff date, '2025-09-16T12:00:00+00:00' for cutoff time, '0' to disable)
  -I, --allow-import[=VALUE...]  Allow importing from remote hosts. Optionally specify allowed IP addresses and host names, with ports as necessary. Default value: deno.land:443,jsr.io:443,esm.sh:443,raw.esm.sh:443,cdn.jsdelivr.net:443,raw.githubusercontent.com:443,gist.githubusercontent.com:443
      --deny-import[=VALUE...]  Deny importing from remote hosts. Optionally specify denied IP addresses and host names, with ports as necessary.
```

### 6.3 `deno info --json` schema (sample `$SCRATCH/sample/main.ts`; full output in `$SCRATCH/data/sample-info.json`)
The sample imports `jsr:@std/path@^1`, `npm:kleur@^4`, `https://deno.land/std@0.224.0/assert/mod.ts`, `node:fs`, `data:application/javascript,export const answer = 42;` and `./helper.ts`. It has an empty `deno.json` (needed so a lockfile gets written). Trimmed output, with spans collapsed:
```jsonc
{
  "version": 1,
  "roots": ["file:///…/sample/main.ts"],
  "modules": [
    { "kind": "esm", "specifier": "file:///…/sample/main.ts", "local": "/…/sample/main.ts", "size": 427, "mediaType": "TypeScript",
      "dependencies": [
        { "specifier": "jsr:@std/path@^1", "code": { "specifier": "jsr:@std/path@^1", "span": {…} } },
        { "specifier": "npm:kleur@^4", "code": { "specifier": "npm:kleur@^4", "span": {…} }, "npmPackage": "kleur@4.1.5" },
        { "specifier": "./helper.ts", "code": { "specifier": "file:///…/sample/helper.ts", "span": {…} } }
        // also https://deno.land/…, node:fs, data:… entries; optional "type": {…} for types deps
      ] },
    { "kind": "esm", "specifier": "https://jsr.io/@std/path/1.1.6/mod.ts", "mediaType": "TypeScript", "size": 7621,
      "local": "~/Library/Caches/deno/remote/https/jsr.io/03afb101fa60…e11c9", "dependencies": [ … ] },
    { "kind": "npm",  "specifier": "npm:/kleur@4.1.5", "npmPackage": "kleur@4.1.5" },
    { "kind": "node", "specifier": "node:fs", "moduleName": "fs" },
    { "kind": "esm",  "specifier": "data:application/javascript,export const answer = 42;", "size": 25, "mediaType": "JavaScript" } // no "local"
  ],
  "redirects": {
    "jsr:@std/internal@^1.0.14/os": "https://jsr.io/@std/internal/1.0.14/os.ts",
    "jsr:@std/path@^1": "https://jsr.io/@std/path/1.1.6/mod.ts",
    "npm:kleur@^4": "npm:/kleur@4.1.5"
  },
  "packages": { "@std/internal@^1.0.14": "@std/internal@1.0.14", "@std/path@1": "@std/path@1.1.6" },   // JSR req -> nv
  "npmPackages": {
    "kleur@4.1.5": { "name": "kleur", "version": "4.1.5", "dependencies": [], "registryUrl": "https://registry.npmjs.org/",
                     "localPath": "~/Library/Caches/deno/npm/registry.npmjs.org/kleur/4.1.5" }   // localPath: 2.8.3+
  }
}
```
Module `kind` values:
- `esm` (JS/TS; also `data:`), `npm`, `node`.
- `asserted` for JSON imported `with {type:"json"}`.
- `wasm` for `.wasm` (it has `local` but `mediaType: null`).
- `external`: raw text, bytes and css imports, plus in BYONM every `node_modules` file (see below).
- Error entries look like `{specifier, error}`, e.g. `"The import attribute type of \"css\" is unsupported."` without `--unstable-raw-imports`.

Dependency objects carry `assertionType` (`json`/`text`/`bytes`/`css`) and `code`/`type` sub-objects: `{specifier, resolutionMode?, span}`.

Behaviour differs by node_modules mode (verified):
- `nodeModulesDir:"auto"`: `localPath` points into `node_modules/.deno/kleur@4.1.5/node_modules/kleur`.
- **BYONM** (package.json + pnpm): `npmPackages` is **absent**, and npm files show up as `{"kind":"external","specifier":"file:///…/node_modules/.pnpm/kleur@4.1.5/node_modules/kleur/index.mjs","local":…}`. The `.d.ts` files are listed as well.

Other notes:
- `deno info --json` with no argument prints `{version:1, denoVersion, denoDir, modulesCache, npmCache, typescriptCache, registryCache, originStorage, webCacheStorage}`.
- A single specifier works too: `deno info --json jsr:@std/path@^1` gives roots, redirects, packages and 73 modules, and `deno info --json npm:kleur@^4` gives npmPackages and localPath. That makes it usable as a "resolve this bare req" CLI.

### 6.4 `deno.lock` v5 (from the sample; verbatim, remote list trimmed)
```json
{
  "version": "5",
  "specifiers": { "jsr:@std/internal@^1.0.14": "1.0.14", "jsr:@std/path@1": "1.1.6", "npm:kleur@4": "4.1.5" },
  "jsr": {
    "@std/internal@1.0.14": { "integrity": "291516b3…fdf7" },
    "@std/path@1.1.6": { "integrity": "c68485c2…cbe", "dependencies": ["jsr:@std/internal"] }
  },
  "npm": { "kleur@4.1.5": { "integrity": "sha512-o+NO+8Wr…uQQ==" } },
  "remote": { "https://deno.land/std@0.224.0/assert/mod.ts": "48b8cb8a…d6f3", "…": "…" }
}
```
Field reference, from this sample plus the v5 locks of 18 cloned repos:
- `specifiers` maps the **normalized** req (`jsr:@std/path@1`, where `^1` became `1`) to a version.
- `jsr.<nv>` has `{integrity, dependencies?}`.
- `npm.<id>` has `{integrity, dependencies?, optionalDependencies?, optionalPeers?, os?, cpu?, bin?, scripts?, deprecated?, tarball?}`. `tarball` appears for non-npmjs registries such as `https://npm.jsr.io/~/11/@jsr/std__fmt/1.0.10.tgz`.
- `remote` maps URL to sha256. `redirects` maps URL to URL (e.g. esm.sh).
- `workspace` has `{dependencies: [...import-map/deno.json reqs], packageJson: {dependencies: [...]}, members: {"packages/x": {dependencies, packageJson}}}`.
- The loader reads it. `deno info` wrote it only because a `deno.json` existed. No lockfile is auto-discovered without a config.

### 6.5 `DENO_DIR` layout (macOS default `~/Library/Caches/deno`; `DENO_DIR` env overrides)
```
remote/<scheme>/<host>[_PORT<n>]/<sha256(path+query)>   # body + trailing "\n// denoCacheMetadata={"headers":{…},"url":"…","time":…}"
                                                           # verified: sha256("/@std/path/1.1.6/mod.ts") == 03afb101…e11c9
npm/<registry-host>/<name>/registry.json                 # cached packument
npm/<registry-host>/<name>/<version>/                    # extracted package (flat: NO nested node_modules)
gen/{file,https}/…                                       # emit (transpile) cache
registries/                                              # LSP registry cache
location_data/<hash>/ (+ web_cache)                      # origin storage for --location
dl/esbuild-0.25.5-1/esbuild-<platform>                   # deno bundle's esbuild
dl/release/vX.Y.Z/deno-<target>.zip                      # deno upgrade downloads
*_cache_v2 (+ -shm/-wal) SQLite: check_cache_v2, dep_analysis_cache_v2, fast_check_cache_v2,
  node_analysis_cache_v2 (CJS export analysis), v8_code_cache_v2, fmt/lint_incremental_cache_v2
latest.txt (upgrade check), deno_history.txt (REPL)
deno_esbuild/, deno_esbuild_tmp/   # NOT Deno: created by @luca/esbuild-deno-loader's native loader (see §8.3)
```
Note that the global npm cache is **flat**: packages have no `node_modules`. That is why tools that point a normal Node resolver at it need their own dependency mapping.

### 6.6 `jsrDepsInNodeModules` (Deno 2.9, verified in `$SCRATCH/sample-jsrnm`)
The config is `{"nodeModulesDir":"auto","jsrDepsInNodeModules":true,"imports":{"@std/fmt":"jsr:@std/fmt@^1","kleur":"npm:kleur@^4"}}` followed by `deno install`. The result:
```
node_modules/.deno/@jsr+std__fmt@1.0.10/node_modules/@jsr/std__fmt   # real package from npm.jsr.io (transpiled .js + .js.map + _dist/*.d.ts + original .ts)
node_modules/@jsr/std__fmt -> ../.deno/@jsr+std__fmt@1.0.10/node_modules/@jsr/std__fmt
node_modules/@std/fmt      -> ../.deno/@jsr+std__fmt@1.0.10/node_modules/@jsr/std__fmt   # original name alias
.npmrc: @jsr:registry=https://npm.jsr.io
deno.lock: specifiers {"npm:@jsr/std__fmt@1": "1.0.10"}, npm["@jsr/std__fmt@1.0.10"].tarball = https://npm.jsr.io/~/11/…; workspace.dependencies still ["jsr:@std/fmt@1", …]
```
- **Bug observed on 2.9.7:** in this mode `import { red } from "@std/fmt/colors"` (import-map subpath) fails to run. The error is `Failed to resolve the specifier "@std/fmt/colors" as its after-prefix portion "colors" could not be URL-parsed relative to the URL prefix "npm:@jsr/std__fmt@^1/" mapped to by the prefix "@std/fmt/"`.
- `jsr:@std/fmt@^1/colors` and `npm:@jsr/std__fmt@^1/colors` do work. I found no issue filed.
- For Node bundlers this mode means plain node_modules resolution handles jsr deps, **by either name**.

### 6.7 Other "resolve this specifier" options in Deno (verified in `$SCRATCH/sample-im`)
- `import.meta.resolve()` inside Deno resolves import-map entries and jsr/npm to final URLs **only if they are already in the loaded graph**:
  - `@std/path` → `https://jsr.io/@std/path/1.1.6/mod.ts`. `kleur` / `npm:kleur@^4` → `file:///…/deno/npm/…/kleur/4.1.5/index.mjs`. `fs` → `node:fs`.
  - An unloaded subpath like `@std/path/join` → `jsr:/@std/path@^1/join` (unresolved).
  - `./src/x` (sloppy) is returned unchanged. It is not usable as a general resolver.
- `deno info --json <specifier-or-file>` (§6.3) resolves the whole graph, plus `npmPackages.localPath` since 2.8.3.
- `@deno/loader` `resolve`/`resolveSync` (§1).
- `Deno.bundle()` does its resolution internally and exposes none of it.
- `deno eval` can host a long-lived resolver process via `import.meta.resolve`, with the same graph caveat.

## 7. `@deno/emit` and `@kingsword/deno-emit`

- **`@deno/emit`** (denoland/deno_emit, 232★): JSR `@deno/emit` 0.46.0, published 2024-10-29. It is wasm (`emit_bg.wasm` 4.36 MB) over `deno_graph`/`deno_ast`, plus `jsr:@deno/cache-dir@0.13.2`. It replaced `Deno.emit()`.
  - API:
    - `bundle(root: string | URL, { allowRemote?, cacheRoot?, cacheSetting?, compilerOptions?, importMap?, load?, minify?, type?: "module" | "classic" }): Promise<{ code: string; map?: string }>`
    - `transpile(root, { allowRemote?, cacheRoot?, cacheSetting?, compilerOptions?, importMap?, load? }): Promise<Map<string /*url*/, string /*code*/>>`
  - `compilerOptions`: `checkJs`, `experimentalDecorators`, `emitDecoratorMetadata`, `importsNotUsedAsValues`, `inlineSourceMap`, `inlineSources`, **`jsx: "precompile" | "preserve" | "react-jsx" | "react-jsxdev" | "react-native" | "react"`**, `jsxFactory`, `jsxFragmentFactory`, `jsxImportSource`, `sourceMap`.
  - **Deprecated.** A README warning was added 2025-09-09 (#201): "`deno emit` is deprecated and not recommended anymore". Issue #200 "Archiving `deno_emit`" (open) gives the reasons: `deno bundle` is back, deno_emit misses config discovery "and a whole lot more", and `deno-js-loader` "uses almost the exact same code as the Deno CLI". Commenters note the loader has no bundling, and at the time had no transpiling either; transpiling was added later.
  - Relevance: none as a dependency. It has no npm resolution, no deno.json discovery and is stale. `@deno/loader` now covers "Deno-flavored TS/JSX transpile including `precompile`", driven from deno.json `compilerOptions`. `deno transpile` (2.8) covers the CLI side.
- **`@kingsword/deno-emit`** 0.0.1–0.0.4 (2025-05-07…09): a fork of deno_emit (kingsword09/deno_emit, 0★) with the wasm rebuilt (`emit.wasm` 4.39 MB) and `@std/path` utils. JSR runtimeCompat is deno/node/bun, and its purpose is running `transpile`/`bundle` outside Deno; there is a `fix-node-specifier` branch. The commit history is identical to upstream 0.46.0. It is abandoned after 3 days. Use it only as a reference for a Node-runnable deno_ast transpile. It is not a dependency candidate.

## 8. Other Deno crates and wasm packages exposed to JS

### 8.1 JS/wasm packages (JSR `@deno/*`)

| Package | Latest (published) | What | Node-runnable? |
|---|---|---|---|
| `@deno/loader` | 0.5.0 (2026-03-29) | full resolver+loader (§1) | **Yes**, since 0.4.0 (verified). Needs `@jsr` registry config for npm/bun installs |
| `@deno/graph` | 0.111.0 (2026-08-26) | `createGraph(roots, {load, resolve, resolveTypes, cacheInfo, kind, imports, jsxImportSourceModule…})`, `parseModule`, `load`, `withResolvingRedirects`, `MediaType`. wasm 2.55 MB | **Partly** (verified on Node 26). The wasm ESM import `./deno_graph_wasm.wasm` loads **unflagged in Node 26**, but the glue reads `Deno.build.os`, so a `globalThis.Deno = {build:{os}}` shim is needed. The default `load` uses `Deno.readTextFile`/`Deno.permissions`, so you must supply `load`. **No npm, node_modules, config or lockfile logic**: `npm:` stays `external`, and jsr needs your loader to serve `jsr.io/meta.json` |
| `@deno/cache-dir` | 0.27.0 (2026-01-30) | `createCache({root, cacheSetting, allowRemote, readOnly, vendorRoot})` → `{load, cacheInfo}`, `DenoDir`, `HttpCache`, `DiskCache`, `FileFetcher`, `DENO_AUTH_TOKENS` support (≈1 MB wasm-in-JS) | **No**. It uses `Deno.readFile`, `Deno.permissions`, `Deno.env` and `Deno.errors` throughout |
| `@deno/doc` | 0.207.0 (2026-08-26) | deno_doc wasm | not relevant |
| `@deno/dnt` | 0.43.2 (2026-08-03) | Deno→npm build tool (deno_graph transforms) | Deno-hosted tool |
| `@deno/emit` | 0.46.0 (2024-10-29) | §7 | deprecated |
| `@deno/esbuild-plugin` 1.2.1, `@deno/rolldown-plugin` 0.0.10, `@deno/vite-plugin` 2.0.4 (npm) | | built on `@deno/loader` | covered by other reports |

### 8.2 Rust crates (crates.io, as of 2026-09-25): usable only by building your own wasm
- `deno_resolver` 0.90.0 (2026-09-16), `deno_graph` 0.111.0, `deno_npm` 0.71.0, `deno_npm_cache` 0.78.0, `deno_npm_installer` 0.54.0, `node_resolver` 0.97.0, `deno_config` 0.109.0, `deno_package_json` 0.61.0, `deno_lockfile` 0.61.0, `deno_cache_dir` 0.51.0, `deno_ast` 0.53.3, `deno_media_type` 0.4.0, `deno_semver` 0.10.1, `import_map` 0.25.0, `deno_path_util` 0.6.4, `sys_traits` 0.1.29 (it has the `wasm` feature that `@deno/loader` uses to reach `node:fs`), and `esbuild_client` 0.7.2.
- **None has its own JS binding.** Most of them are published on crates.io straight from the `denoland/deno` monorepo. So a third party *could* build an up-to-date `@deno/loader` equivalent with wasm-bindgen + `sys_traits/wasm`, tracking Deno 2.9, **without** the git-submodule trick. The cost is ~5.5 MB of wasm and a heavy maintenance burden.
- For semver, `jsr:@std/semver` (pure TS) exists. There is no JS binding for `deno_media_type`, `deno_package_json` or `deno_config`.

### 8.3 `@luca/esbuild-deno-loader` notes (context only; other agents cover it in depth)
- It has two loaders.
  - **"native"** shells out to `deno info --json`. For npm it **hard-links each package from the flat global cache into `DENO_DIR/deno_esbuild/<registry-host>/<npmPackageId>/node_modules/<name>`**, built in `deno_esbuild_tmp/` and then renamed. Uppercase names are base32-encoded. Bare imports inside packages map to the right dependency via `deno info` `npmPackages[*].dependencies` (`packageIdFromNameInPackage`). This explains the `deno_esbuild*` dirs in DENO_DIR.
  - **"portable"** re-downloads remote specifiers on every run, needs pre-installed `node_modules` for npm, and needs a lockfile for `jsr:`.
- The README warns that `npm:` specifiers don't work with esbuild-wasm because of FS access limits (evanw/esbuild#2968).
- There is **no Deno-maintained esbuild fork**. The "fork" is really `denoland/esbuild_client`, a Rust client for esbuild's stdio service protocol that drives an unmodified npm `@esbuild/*` binary.

---

## 9. Implications for `unplugin-deno`: best ideas, worst pitfalls, surprises

### 9.1 Best ideas
1. **Engine = `@deno/loader`, loaded lazily.** Only pay the 5.5 MB wasm and 15–35 ms instantiate cost when a `deno.json`, lockfile or Deno-style specifier (`jsr:`, `npm:`, `https:`, import-map key) is present.
   - Ship it **vendored**, or as an optional dependency with a documented `.npmrc`. npm and bun fail to install `npm:@jsr/deno__loader` without `@jsr:registry=https://npm.jsr.io` (verified). The package is MIT.
   - Vendoring also lets us patch `helpers.js`: route "Downloading …" into the bundler logger, add retries, pass a custom `fetch` (proxy/auth), and fix the `cachedOnly` bug.
2. **Call `addEntrypoints(inputs)` in `buildStart`/`options`**, as `@deno/rolldown-plugin` does, so npm/jsr versions match `deno` with or without a lockfile. Then use `resolveSync` in `resolveId`, and fall back to async `resolve` only for specifiers outside the graph (dynamic imports, virtual modules, HMR-added files).
3. **Split ownership.**
   - `file:` results become real absolute paths, and the **host bundler loads them itself**. This avoids loader staleness and keeps native TS/JSX, HMR, watch and sourcemaps.
   - `https:`/`jsr:`-resolved remote modules and `data:` go through `loader.load()` as virtual ids with a stable, readable prefix: `\0deno:https://…` in Rollup/Vite, and a `deno` namespace in esbuild, which is what `deno bundle` uses. Return `code` plus `sourceMap` and remember that the code is **already JS** even when `mediaType` says TS.
   - npm files resolve to the global cache or node_modules paths and the bundler loads them natively.
4. **Port `deno bundle`'s checklist (§4.3) to the unplugin hooks:**
   - `node:`/`bun:`/`.node` external. `cloudflare:` should also be external: Deno's own bundler claims to externalize it but fails on 2.9.7.
   - `browser` field (`false` → empty module), which the loader lacks (#66). `sideEffects` → Rollup `moduleSideEffects` / esbuild `sideEffects`.
   - Wasm → a JS instantiate wrapper, or source-phase handling where the bundler supports it.
   - Text/bytes/json per import attributes. `type: "css"` → a `CSSStyleSheet` module.
   - `import.meta.main` → `false` outside entries.
   - esbuild: node-mode `__toESM` and a `createRequire` shim for Deno/Node targets. rolldown: report module format through a synthetic `package.json` `type`, as PR #34345 does.
5. **Alternative no-wasm backends** behind a strategy option:
   - (a) `deno info --json` graph plus `npmPackages[*].localPath` (2.8.3+) and `modules[*].local` for remote cache files. It is cheap for a CLI-present setup.
   - (b) With `jsrDepsInNodeModules` + `nodeModulesDir: auto` (2.9), map `jsr:@s/n@r/sub` → `@s/n/sub` and let the bundler's node resolution do the rest.
   - (c) `nodeModulesDir: "manual"`/BYONM projects are almost "just Node". Only import maps, `jsr:` and `https:` need the plugin.
6. **One Workspace per environment/platform** (browser vs node conditions), as `@deno/vite-plugin` does. Keep a single wasm instance, and remember that the thread-local caches are shared.
7. **Watch mode:** on `watchChange` of anything in the graph, recreate the Loader (12 ms) and re-add entrypoints. Also watch `deno.json`, `deno.lock`, `package.json` and import-map files.
8. Keep **`Deno.bundle` plugins (PR #34345)** in mind as a possible future unplugin target, and track `@deno/loader` staleness. Consider asking Deno to publish a refreshed loader (issue #86).

### 9.2 Worst pitfalls
- **Stale local files in `loader.load()`** after edits (verified). There is no invalidate API.
- **The loader is frozen at Deno 2.7.9-era semantics.** No default 24 h min-dependency-age (so resolution can differ from `deno install` 2.9 without a lockfile), no `catalog:`, no hoisted linker, no link globs, no external-import-map auto-discovery, no CSS imports, no `jsrDepsInNodeModules`, no `.npmrc min-release-age`.
- **Eager npm downloads**: with a lockfile, *every* npm package in it is fetched at `addEntrypoints` (verified). A cold run also blocks on sequential fetches (3.2 s for 110 small modules).
- Sync `node:fs` IO and `Atomics.wait` block the event loop, which hurts dev servers. There are no retries on npm downloads. Stderr gets unconditional "Downloading"/"Initialize" logs.
- `cachedOnly` doesn't stop remote fetches (bug).
- `process.cwd()` is the implicit root, and there is no `cwd` option.
- `MediaType` numbers shifted in 0.3.11.
- `mediaType` describes the source, not the emitted code.
- No CJS→ESM translation: the host bundler must handle CJS in npm packages (Vite dev / Rollup need commonjs handling). In esbuild, plugin-owned resolution loses Node's `__esModule` interop mode.
- `deno bundle` pitfalls: `--packages=external` doesn't externalize npm/jsr, `--external` is variadic, `data:` imports can leak into output, HTML `<link>` tags are not processed, it needs network for the esbuild binary on first run, and it has no plugin API.
- JSR npm-compat (`@jsr/*`) packages contain **transpiled JS**, while the `https://jsr.io` route yields TS source. The same package loaded both ways appears twice with different ids. Pick one route per build.

### 9.3 Surprises
- `unplugin-jsr` was never implemented (only a `console.log` transform) and is unpublished. `@jeiea/unplugin-deno` is a one-day, Deno-only toy. **The npm name `unplugin-deno` is free.**
- `@deno/loader`'s JSR metadata still says `node: false` although Node works. It has been unreleased for six months while Deno shipped 2.8 and 2.9.
- `deno bundle` downloads a stock esbuild **0.25.5** binary from npm into `DENO_DIR/dl` and drives it over stdio with a single catch-all plugin. Deno is actively trying to replace it with rolldown and add a JS plugin API (PR #34345, open).
- Deno 2.8.3 added `npmPackages.localPath` to `deno info --json` specifically for "a Rollup plugin".
- In Deno 2.9.7, `jsrDepsInNodeModules` breaks import-map subpath imports such as `@std/fmt/colors`.
- Node 26 imports `.wasm` ES modules without a flag, so `@deno/graph` almost works in Node given a one-line `Deno.build.os` shim.
