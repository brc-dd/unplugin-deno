# Prior-art research: esbuild Deno plugins (for `unplugin-deno`)

Research date: 2026-09-25. Environment: macOS, Deno 2.9.7, esbuild 0.28.2 (npm latest), unplugin 3.4.0.
Scope: `@deno/esbuild-plugin` (+ its engine `@deno/loader`), `@luca/esbuild-deno-loader` (+ forks `@kylejune/…`, `@bureaudouble-forks/…`, `@duesabati/esbuild-deno-plugin`), `@oazmi/esbuild-plugin-deno`, `@ggpwnkthx/esbuild-plugin-deno`, `@miyauci/esbuild-deno-specifier`, `@miyauci/esbuild-import-map`, `esbuild-plugin-cache-deno` (archived), plus the esbuild plugin API itself (0.19 → 0.28).

Method: shallow clones (paths at the end), full source reading, `gh` issue/PR/fork mining, JSR/npm registry APIs, and **hands-on experiments** (esbuild 0.28.2 under Deno 2.9.7) against `@deno/esbuild-plugin@1.2.1`, `@luca/esbuild-deno-loader@0.11.1` and `@ggpwnkthx/esbuild-plugin-deno@0.2.12` (scripts in `$SCRATCH/exp/proj/`).

Note: `@deno/esbuild-plugin` is **not on npm** (`npm view` → 404). It is JSR-only (`jsr:@deno/esbuild-plugin`), repo `denoland/deno-esbuild-plugin`.

---

## 0. Executive summary

### Three architectural families

1. **Shell out to the Deno CLI** (`deno info --json`) and read Deno's global cache (DENO_DIR):
   `@luca/esbuild-deno-loader` "native" loader, `@miyauci/esbuild-deno-specifier`, `esbuild-plugin-cache-deno` (reads DENO_DIR layout + `deno.lock` by hand).
   Exact Deno semantics for remote/jsr/npm version selection, but it needs `--allow-run`, is Deno-only, is slow (a subprocess per batch) and is brittle (argv length on Windows, cache format changes, `--no-config` pitfalls).
2. **Embed Deno's own Rust resolver as WASM**:
   `@luca` uses `deno_config` 0.37 only for workspace/import-map/`nodeModulesDir`/lockfile parsing (~2.3 MB base64 WASM). `@deno/esbuild-plugin` and `@ggpwnkthx` use **`@deno/loader`** (~5.5 MB WASM), which bundles `deno_resolver`, `deno_graph`, `deno_npm_installer`, `deno_config`, `node_resolver` and `deno_ast`. It resolves, downloads, installs npm packages, checks the lockfile and **transpiles** (TS/JSX according to deno.json), so it is the closest to "what `deno run` does".
3. **Pure-TS reimplementation, runtime-agnostic** (fetch-based):
   `@oazmi/esbuild-plugin-deno` (works under Deno, Node, Bun and the browser; jsr via registry metadata plus its own semver; npm via `node_modules` plus optional auto-install), `@luca` "portable" loader (fetch plus a lockfile for jsr; npm needs a pre-populated `node_modules`), `@miyauci/esbuild-import-map` (import maps only).

### Best ideas worth stealing

- **Two-phase resolve with `build.resolve()` re-entry** (@luca). Phase 1 absolutizes the specifier and applies the import map. It then re-enters esbuild's resolver in a namespace named after the URL scheme, so other plugins can claim `https:`/`jsr:`/custom schemes, and user plugins can sit between the resolver and the loader.
- **Hand npm resolution back to esbuild's native Node resolver with a correct `resolveDir`** (@luca): real `node_modules`, or a hard-linked `node_modules` farm built from the global cache under `$DENO_DIR/deno_esbuild/...`. esbuild then applies `exports`/`conditions`/`mainFields`/`browser` **and package.json `sideEffects`**. Verified: `import { chunk } from "lodash-es"` bundles to **10.4 KB with @luca vs 321.9 KB with @deno/esbuild-plugin and @ggpwnkthx**, a 31x difference caused by losing `sideEffects: false`.
- **Precise `onResolve` filters built from import-map keys** (@miyauci/esbuild-import-map: `^key$` or `^prefix/`). This avoids a Go→JS round trip for every import. Every other plugin here uses a `/.*/` catch-all.
- **Honor esbuild's `initialOptions`** (@miyauci/esbuild-deno-specifier): `platform`, `mainFields`, `conditions`, `resolveExtensions`, `loader`, `packages: "external"`, `logLevel`. It also returns `sideEffects` computed from package.json, `errors` with `notes` (for example "node: builtin used on the browser platform"), and maps the `browser` field value `false` to an empty module.
- **Batch `deno info` calls**: a 5 ms debounce collects specifiers into one synthetic `data:application/javascript,import "a";import "b";` root (@luca `InfoCache`).
- Strip the Deno 2 cache trailer `\n// denoCacheMetadata=` when reading DENO_DIR files directly (@luca).
- **Asset passthrough**: never `onLoad` CSS, fonts or images; let esbuild's native loaders handle them. Examples: @ggpwnkthx `SKIP_ASSET_PATTERN`; KyleJune's fork uses `EXTENSION_FILTER`, skips CSS import kinds `import-rule|composes-from|url-token`, and forwards `pluginData`/`resolveDir`/`importer` on re-entry.
- **A long-lived "handle"** that owns the workspace and loader and exposes `resolve()` and `build()` for dev servers (@ggpwnkthx `createDenoPlugin()`). This also satisfies @luca issue #153, which asks for the resolver as a plain function.
- A runtime-agnostic design with a weakly typed plugin interface, so there is **no hard dependency on a specific `esbuild` version**. @luca PR #120 dropped `npm:esbuild` in favour of a local `esbuild_types.ts`; @oazmi uses `EsbuildPluginCompatible`. This avoids @deno/esbuild-plugin issue #36 (two esbuild versions installed).
- Workspace members' import maps emulated as synthesized `scopes` (the `@duesabati/esbuild-deno-plugin` rewrite). Per-package import-map scoping carried in `pluginData`, with `pluginData` inheritance from the importer (@oazmi).
- A side esbuild instance used purely as a Node resolver (@oazmi `EsbuildNativeResolver`). It is a dummy build whose `onLoad` blocks, which captures that build's `build.resolve`.

### Worst pitfalls seen

- A catch-all `onLoad({filter:/.*/, namespace:"file"})` that intercepts CSS, fonts and images. It breaks other plugins (@luca #77/#129/#151/#159) and corrupts binaries (@deno #35).
- The loader is chosen from the media type and ignores import attributes. Verified: `import t from "./data.json" with { type: "text" }` yields an **object** in @deno and @ggpwnkthx (correct string in @luca and in plain esbuild ≥0.28).
- `data:` imports are broken in @deno and @ggpwnkthx (verified): `Plugin "deno" returned a non-absolute path: data:… (set a namespace…)`.
- Config discovery uses `process.cwd()` instead of esbuild `absWorkingDir` (@deno #29). @luca uses `join(cwd,"node_modules")` rather than the workspace root, and runs `deno info --no-config` when `configPath` isn't given (#162), so the lockfile and deno.json are ignored and duplicate React copies result.
- An import-time top-level `await Deno.permissions.query({name:"run"})` (@luca `DEFAULT_LOADER`), which forces the Deno runtime and a side effect at import time.
- Stale caches in watch mode:
  - @deno/esbuild-plugin creates the loader once in `setup`, and its module graph is never invalidated (issue #6).
  - @luca goes the other way and rebuilds everything on every `onStart`; the portable loader **re-downloads every remote module on every rebuild**.
- The Windows argv limit: @luca passes the whole batched `data:` URL on the `deno info` command line, which causes "os error 206" (#168). Long hard-link directory names from peer-dependency suffixes cause "File name too long" (#103).
- Control flow built on regex matching of error messages (`/not a dependency and not in import map|Relative import path…/`, @deno). It broke when @deno/loader 0.3.7 changed its wording (@deno #30).
- Outright typos:
  - @luca portable `if (resp.status < 200 && resp.status >= 400)` can never be true, so HTTP errors are never rejected.
  - @miyauci's filter `/^npm:|^jsr:|^https?:^node:/` is missing a `|`, so `http(s):`/`node:` never match.
  - @luca's hard-coded builtin list is misused (PR #170).
- Non-discriminating tests: @deno's "plugins can participate in resolution" and "with text" tests pass even when the feature is broken. @luca's CI matrix claims `canary` but `setup-deno` is pinned to `1.x`, so the Deno-2-only jsr tests never ran in CI.

### Most-demanded features (from issues)

Ordered by frequency and reactions:

1. Coexistence with other plugins and non-JS assets: CSS, fonts, SVG, data URLs, PostCSS, React Compiler, resolver/loader split. @luca #77 (+4), #129, #151, #159, #134; @deno #28, #31, PR #34, #35, #6-comment. This is also @oazmi's reason to exist.
2. `external` / `packages: "external"` semantics: @luca #31 (6 comments, 6 reactions, the oldest open issue), #137, PR #95; @deno #7.
3. Workspaces, including glob members and `links`/`patch`: @luca #156 (+4), #169, #135 (+2, a member's `name`/`exports` usable as a bare specifier); @oazmi #7; @deno/loader #15.
4. npm correctness (peer deps, overrides/dedupe, CJS `require("node:url")`, optional deps, `browser: false`): @luca #124, #127, #161, #162, #93; @deno/loader #17, #66.
5. Import attributes (`json`/`text`/`bytes`) through import-mapped paths: @luca #164; @deno #28 plus the verified text bug.
6. Watch/rebuild correctness and caching: @deno #6; @luca #62, #132 ("reload" of cached remote modules), #91.
7. Honor `absWorkingDir`/`stdin`/restricted `--allow-read`: @deno #29; @luca #125, #165; @oazmi #8.
8. Windows: @luca #168, #103, #155; @deno #37 (machine-specific absolute paths in output).
9. Misc:
   - vendoring (#152)
   - remote deno.json (#114/PR #144)
   - fetch options and user-agent (PR #75)
   - `--quiet` (PR #122, carried by the bureaudouble fork)
   - expose the resolver as a function (#153)
   - rewrite `new URL("./worker.ts", import.meta.url)` (#154)
   - honor deno.json `jsxImportSource` (#136)
   - `.d.ts` output (#158)
   - public env-var inlining (@deno PR #26)

### Surprising discoveries

- The Deno team now tells users of @luca to switch to `denoland/deno-esbuild-plugin` (dsherret in @luca #171 and #169). Yet @luca still gets **~127k JSR downloads per ~90 days vs ~34k** for @deno/esbuild-plugin (api.jsr.io, 2026-06-28→2026-09-25), and @luca has had no release since 2024-12-06.
- `@deno/esbuild-plugin@1.2.1` (last release 2025-12-03) pins `@deno/loader@^0.3.10`, so it can't pick up `@deno/loader` **0.4.0 (Node.js support, 2026-03-28)** or **0.5.0 (`sourceMap` in load responses, 2026-03-29)**. Only the community `@ggpwnkthx` port uses 0.5. `@deno/loader` itself is actively auto-updated by denobot, and `@fresh/plugin-vite` and `@deno/rolldown-plugin` are among its dependents.
- esbuild ≥0.25.11 natively supports `with {type:"bytes"}` and ≥0.28.0 supports `with {type:"text"}`. esbuild ≥0.21.4 passes `with` to `onResolve` and accepts it in `build.resolve()`. esbuild has stopped publishing to `deno.land/x/esbuild` (Unreleased section), yet @luca's README and tests still use `deno.land/x/esbuild@v0.20.2`.
- `@deno/loader` may **write `deno.lock`** (`lockfile_skip_write: false`), installs npm packages itself with lifecycle scripts disabled, and always prints `Downloading <url>` to stderr (`helpers.js`).
- unplugin 3.4.0's esbuild adapter puts every `resolveId` result into `namespace: plugin.name`, so esbuild cannot natively load the file afterwards. It does not expose `args.with`, `sideEffects` or `pluginData`, and its `external` check is an exact `includes()`. A Deno plugin built on unplugin therefore **needs the `esbuild.setup` escape hatch** for correct esbuild behavior (see §8).

---

## 1. `@luca/esbuild-deno-loader` (the de-facto standard; now in maintenance)

### 1.1 Identity

| Field | Value |
|---|---|
| Repo | https://github.com/lucacasonato/esbuild_deno_loader (created 2021-04-24) |
| Registry | JSR `jsr:@luca/esbuild-deno-loader` (previously deno.land/x/esbuild_deno_loader) |
| Latest | **0.11.1** (2024-12-06); 0.11.0 (2024-10-14); 0.10.3 (2024-03-15) |
| Maintainers | Luca Casonato; contributions from Marvin Hagemeister, David Sherret, Yoshiya Hinosawa (kt3k), Reed von Redwitz |
| License | MIT |
| Stars/forks | 197 ★ / 49 forks; 32 open issues + 10 open PRs |
| Last commit | 2024-12-06 (`2bc9a9d 0.11.1`) |
| Activity | **Stale / maintenance only.** The Deno team redirects users to `@deno/esbuild-plugin` (#171, #169). |
| JSR | score 100, runtimeCompat: Deno only, 81 dependents (Fresh 2 alphas up to alpha.18, danet, goatdb, @bureaudouble/*, …), ~127k downloads per ~90 days |
| Size | 2.44 MB published, of which 2.34 MB is `src/wasm/loader.generated.js` (base64-inlined WASM) |

### 1.2 Bundler versions and how it plugs in

- No runtime dependency on esbuild. It ships its own structural types (`src/esbuild_types.ts`, also exported as `./esbuild_types`); PR #120 was titled "don't depend on npm:esbuild". Tests use `deno.land/x/esbuild@v0.20.2` in **both native and WASM** builds; users report it working with 0.24, and my run with esbuild **0.28.2** works.
- Two plugins, combined by `denoPlugins(opts) => [denoResolverPlugin(opts), denoLoaderPlugin(opts)]` (`mod.ts`). The README tells users to place custom plugins *between* them.
- **`deno-resolver`** (`src/plugin_deno_resolver.ts`):
  - `onStart` (L58–81): `findWorkspace(cwd, entryPoints, configPath)` discovers the workspace via WASM `WasmWorkspace.discover(...)`. It optionally `fetch()`es `importMapURL` (which can be a `data:` URL), then creates a `WasmWorkspaceResolver`. The workspace and resolver are rebuilt on every build.
  - `onResolve({filter:/.*/})` with no namespace, so it sees everything (L83–133). Order of operations:
    1. Skip anything inside `node_modules` (`isNodeModulesResolution`).
    2. Compute the referrer `new URL(`${namespace}:${importer}`)` or a `resolveDir` URL. It throws `[assert] namespace is empty` for `stdin` (#125).
    3. Test `initialOptions.external` converted to regexes (`*`→`.*`, L47–56).
    4. `resolver.resolve(path, referrer)`, which applies import map, workspace and package.json deps.
    5. **`build.resolve(path, { namespace: <url scheme>, kind })`** (L128–131). The path is the URL without its scheme (for `file`, a filesystem path).

    The re-entry **drops** `importer`, `resolveDir`, `pluginData` and `with`; KyleJune's fork fixes this.
- **`deno-loader`** (`src/plugin_deno_loader.ts`):
  - `onStart` (L208–264) picks `nodeModulesDir` and `lockPath` (from options or via the WASM workspace) and instantiates `NativeLoader` or `PortableLoader`.
  - `onResolve` for namespaces `file`, `http`, `https`, `data`, `npm`, `jsr`, `node` (L376–382).
  - `onLoad` for `file` (**catch-all `/.*/`**, with a TODO referencing esbuild PR #2968), `http`, `https`, `data` (L384–398).
  - Paths use the convention `namespace = URL scheme, path = rest of URL`, via `urlToEsbuildResolution` and `esbuildResolutionToURL` (exported).

### 1.3 Resolution and loading architecture

**Workspace, config and import-map layer** (both loaders; `src/wasm/src/lib.rs`, Rust `deno_config` 0.37.1, `deno_lockfile` 0.23.1, `deno_package_json` 0.1.2, `deno_semver` 0.5.13):

- `WasmWorkspace.discover(entrypoints, is_config_file)` starts from the **directories of file entry points**, or `cwd` (`absWorkingDir ?? Deno.cwd()`) for non-file entries, or `[configPath]`. It walks up to find the workspace root and also discovers package.json (`discover_pkg_json: true`).
- `node_modules_dir()` returns deno.json `nodeModulesDir`. Otherwise it returns `manual` when a root package.json exists, and `none` if not; the TS doc comment wrongly says `auto`.
- `lock_path()` is the config's lockfile path.
- `resolver(importMapURL, value)` calls `Workspace::create_resolver(... PackageJsonDepResolution::Enabled)`. It maps `MappedResolution::{Normal, ImportMap, WorkspaceJsrPackage}` to specifiers, and package.json deps to `npm:name@range/sub`. **`WorkspaceNpmPackage` and package.json `workspace:` deps throw** "not supported".
- deno.json `imports`/`scopes`, `importMap` references, and inline import-map expansion (#111) are handled by `deno_config`. `compilerOptions` are **ignored**, so JSX config must be duplicated into esbuild options (#136).
- `deno_config` 0.37.1 is frozen at October 2024. Glob workspace members fail (#156, "Resolve error for globstar workspaces"), Deno 2.4 `links` break the native loader (#169), and JSR `name`/`exports` self-mapping is missing (#135).
- The FS bridge (`src/wasm/fs.js`) uses `Deno.statSync`, `readTextFileSync` and `readDirSync`. It walks parent directories, which needs unrestricted `--allow-read` (#165).

**Native loader** (`src/loader_native.ts` + `src/deno.ts`):

- `InfoCache.get(specifier)` debounces 5 ms (`#queueLoad`, L217–240). It batches all pending specifiers into **one** `deno info --json` call on a synthetic root `data:application/javascript,import "a";import "b";…` (`#populate`, L255–282), then caches `modules`, `redirects` and `npmPackages`. Calls are serialized (#116).
- The subprocess is `Deno.execPath() info --json [--allow-import (Deno 2)] [--config X | --no-config] [--import-map X] [--lock X] [--node-modules-dir=<mode>]`. It runs with `env DENO_NO_PACKAGE_JSON=true`, `cwd=absWorkingDir` and stderr inherited (L111–168). Note:
  - **`--no-config` is used whenever `configPath` isn't passed**, even though the resolver auto-discovered one (#162). The lockfile and deno.json npm overrides are then ignored.
  - The loader passes `lock: options.lockPath` (L250–254), never the discovered lockfile.
  - A large batch becomes one enormous argv element, which explains the **Windows "os error 206"** (#168).
- **https/jsr**: `deno info` downloads the module into DENO_DIR (respecting `DENO_DIR`, `DENO_AUTH_TOKENS`, lockfile integrity and `--cached-only` semantics as the CLI would). The loader then `Deno.readFile(entry.local)` and **strips the trailing `\n// denoCacheMetadata=` block** (Deno 2 cache format, L101–105). Redirects follow `info.redirects` (max 10 hops).
- **npm (global cache, `nodeModulesDir: none`)**:
  - `deno info` returns `kind:"npm"` + `npmPackage` id plus an `npmPackages` graph (name, version, dependencies, `registryUrl`, the last added for private registries in #143).
  - `nodeModulesDirForPackage(id)` builds a **hard-link farm** (`Deno.link`) from `$npmCache/<registry-host>/<name>/<version>` into `$DENO_DIR/deno_esbuild/<registry-host>/<npmPackageId>/node_modules/<name>`. It works in a temp directory and then `rename`s for atomicity; package names containing upper case are base32-escaped (`_`+base32) (L128–191). The resolver then calls `build.resolve("<name>/<subpath>", {resolveDir: linkDir})`, so **esbuild's native Node resolver** handles `exports`, conditions, mainFields, the browser field and sideEffects.
  - Bare imports inside a package walk up `packageIdByNodeModules` to find the parent package id, then `packageIdFromNameInPackage(name, parentId)` looks it up in the parent's `dependencies` (L193–206), then link and resolve.
  - Pitfalls:
    - Long package ids with peer suffixes cause "File name too long (os error 63)" (#103).
    - Cross-device links needed tmp to be on the same filesystem (#76, fixed by #79).
    - Rename races produce "Directory not empty" (#82/#84).
    - Undeclared or peer deps fail (#124).
- **npm with `nodeModulesDir: auto|manual`**: `resolveDir = join(cwd, "node_modules")` (L243). This uses **`cwd`, not the workspace root**. `manual` works around denoland/deno#25903 by skipping `deno info` for `npm:` (L37–46).
- **node:** is returned as external (`kind:"node"`). For resolutions *inside* `node_modules`, a hard-coded `BUILTIN_NODE_MODULES` list (L97–148) marks bare builtins external. The list is incomplete (no `inspector`, `sqlite`, `readline/promises`, …), and the `"node:"+path` membership test is dead code (PR #170).
- **data:** is `fetch()`ed directly, never cached (#54).
- **Unknown media types**: `mediaTypeToLoader` covers only JS/JSX/TS/TSX/JSON; Cjs, Cts and Wasm map to `null`, so the plugin returns `undefined` and esbuild falls back. Local non-JS files still go through `deno info`, which yields errors such as "[unreachable] Not an ESM module." (#129/#159).

**Portable loader** (`src/loader_portable.ts`): Web APIs plus WASM only.

- file: `Deno.readFile`, with the media type from the extension.
- http/https/data: `fetch(redirect:"manual")`, with an in-memory map per build and manual redirect handling of up to 10 hops.
  - **Bug:** the status check at L200 is `resp.status < 200 && resp.status >= 400`, which is never true, so 4xx/5xx bodies are treated as module source.
  - No disk cache, so everything is re-downloaded on every build and every rebuild.
- jsr: **requires a lockfile**. `WasmLockfile.package_version("jsr:@s/p@range")` gives the exact version; then `fetch https://jsr.io/@s/p/<v>_meta.json` (`JSR_URL` env overrides the host) looks up `exports["."+subpath]` and resolves to `https://jsr.io/@s/p/<v>/<path>`. There are no integrity checks ("integrity checks are not performed for ESM modules").
- npm: always behaves like `nodeModulesDir: "manual"` (needs a pre-populated `node_modules`).
- node: external.
- `DEFAULT_LOADER` is `portable` unless `--allow-run` is granted. It is computed with **top-level await** at module import time (L91–95).

### 1.4 Feature matrix

| Feature | Status |
|---|---|
| TS/TSX/JSX transpile | Delegated to esbuild (loader chosen from media type). deno.json `compilerOptions` ignored (#136). |
| Import attributes | Not read. `with` is dropped on the `build.resolve` re-entry. JSON through an import-mapped path fails in the native loader (#164). The batched synthetic root imports without attributes, so `deno info` rejects JSON. The `text` attribute worked in my test only because @luca's `onLoad` returned `undefined` for `data.json` (instrumented in `probe_luca.ts`), so esbuild loaded it natively. |
| WASM imports | No (media type `Wasm` maps to `null`). |
| Sourcemaps | esbuild's own (source is TS). |
| Caching / perf | Native: DENO_DIR plus an in-memory `InfoCache`, re-created each `onStart`, with batched `deno info`. Portable: no cache. |
| Watch | Returns `watchFiles` for local modules. Does not watch deno.json, deno.lock or import maps; they are re-read each build anyway. |
| Errors | `deno info` messages passed through verbatim, plus custom `[unreachable]`/assert strings. Uses thrown errors, never `errors`/`notes`. |
| deno.lock integrity | Native: only if `lockPath`/`configPath` is passed explicitly. Portable: used for jsr version pinning only. Lockfile v3 and v4 supported (#140). |
| Private registries / `DENO_AUTH_TOKENS` | Native: yes (Deno CLI; `.npmrc`/`registryUrl` since 0.11.0, #143). Portable: no. |
| `DENO_DIR` | Native respects it (via `deno info` output `denoDir`/`npmCache`). `DENO_NO_PACKAGE_JSON=true` is forced for subprocesses. |
| Vendoring | No (#152). |
| Externals | Own glob→regex over `initialOptions.external`, tested against the raw specifier before import-map resolution. The bare-specifier case (#137) was probably fixed by #157. |
| Side effects / tree-shaking | **Good**, because npm packages are resolved by esbuild natively. Verified: lodash-es `chunk` bundles to 10.4 KB. |
| `platform: "neutral"` | npm resolution **fails** ("Could not resolve lodash-es", verified; #127) because esbuild's neutral platform has empty `mainFields`. |
| `.d.ts` | No (#158). |
| Windows | CI runs on Windows; still os error 206 (#168), path normalization (#155), long names (#103). |
| Runtime | **Deno only** (`Deno.*`, `Deno.Command`, TLA permission query). WASM esbuild works for everything except `npm:` (esbuild PR #2968). |

### 1.5 Configuration surface (from source)

`DenoPluginsOptions` (mod.ts) = union of:

- `loader?: "native" | "portable"`. Default `DEFAULT_LOADER`: `native` if `Deno.permissions.query({name:"run"})` is granted, else `portable`.
- `configPath?: string`, absolute. Default: auto-discover from entry-point dirs or `absWorkingDir` up to the workspace root.
- `importMapURL?: string`. Fetched with `fetch`, so it can be `data:`/`https:`/`file:`. Default: taken from deno.json.
- `lockPath?: string`, absolute. Default: the deno.json lockfile, but **only for portable**; native uses only the explicit option.
- `nodeModulesDir?: "auto" | "manual" | "none"`. Default from deno.json; otherwise `manual` if a package.json exists, else `none`. Ignored by portable, which is always `manual`.

`DenoResolverPluginOptions` = {`configPath`, `importMapURL`}. `DenoLoaderPluginOptions` = {`loader`, `configPath`, `importMapURL`, `lockPath`, `nodeModulesDir`}.

Other exports: `DEFAULT_LOADER`, `esbuildResolutionToURL`, `urlToEsbuildResolution`, `EsbuildResolution`. Environment used: `JSR_URL` (portable), `DENO_DIR` (via `deno info`).

### 1.6 Quality

- Tests: `mod_test.ts` has 45 `Deno.test`s. Each runs a matrix of `[native, portable] × [esbuild native, esbuild wasm]` (WASM skipped on Windows). Coverage:
  - remote and local ts/mts/js/mjs/jsx/tsx and json
  - npm via the global cache (preact, react, @preact/signals, is-number, @oramacloud/client, typo-js, express, alternative registry via `.npmrc`)
  - npm local `auto`/`manual`
  - http redirect dedupe, workspaces
  - explicit, inline and referenced import maps, including expansion
  - custom scheme plugins, the txt plugin, uncached data URLs, externals
  - jsr with an auto-discovered lockfile, a referenced lockfile, lockfile v3 and no lockfile

  `src/shared_test.ts` covers the specifier parsers. Tests hit the real network (deno.land, esm.sh, npm, jsr).
- **CI bug**: the matrix declares `deno: [v1.x, canary]`, but the step is `setup-deno@main with deno-version: "1.x"` regardless. Tests marked `ignore: Deno.version.deno.startsWith("1.")` (jsr with an auto-discovered lockfile or referenced lock) have therefore **never run in CI**.
- Types: its own esbuild types; publishes a `jsdoc` readme. The WASM is built via `jsr:@deno/wasmbuild@0.17.2`.

### 1.7 Issues and PRs (open, curated)

- #171 "Since Deno 2.6.6 getting 'Too many redirects for npm:/…'" (2026-01). Caused by a `deno_graph` upgrade producing circular `redirects` in `deno info` output. dsherret: "I recommend using denoland/deno-esbuild-plugin… as it's up to date with the latest Deno". https://github.com/lucacasonato/esbuild_deno_loader/issues/171
- #169 "Linked workspace modules fail to load in deno 2.4" (`links`; namespace becomes `jsr`). https://github.com/lucacasonato/esbuild_deno_loader/issues/169
- #168 "Build fails on Windows with 'os error 206' when project is at OS root". https://github.com/lucacasonato/esbuild_deno_loader/issues/168
- #164 "Import attribute `{type:"json"}` not working when importing with a path specifier defined in import map". https://github.com/lucacasonato/esbuild_deno_loader/issues/164
- #162 "Auto resolve deno.json doesn't work right for denoLoaderPlugin". NativeLoader runs `--no-config`, which produces duplicate React versions; also references denoland/deno#26841. https://github.com/lucacasonato/esbuild_deno_loader/issues/162
- #161 "Could not resolve 'node:url'" (from `require("node:url")` in tough-cookie inside `node_modules`). https://github.com/lucacasonato/esbuild_deno_loader/issues/161
- #159 "Unusable with other plugins and non ts/js default loaders" (PostCSS, `url()` data URLs; points at the `/.*/` filter). Fixed in KyleJune's PR #160. https://github.com/lucacasonato/esbuild_deno_loader/issues/159
- #158 "esbuild vs. deno_emit" (d.ts). #156 "Resolve error for globstar workspaces" (+4). #155 "Wrong path normalization" (double slash). #154 "Packages using workers causing 'Module not found ../worker.ts'" (asks for `new URL('./worker.ts', import.meta.url)` rewriting to remote URLs, as `deno bundle` did). #153 "expose function independently of esbuild plugin". #152 "Add vendoring support". #151 "don't try to resolve css files". #150 "Resolver dies on `try { require() } catch {}`" (optional `require("canvas")` in jsdom). #137 "external option does not work with plain specifier". #135 "JSR exports not added to importmap" (+2). #132 "Reload Cached Modules". #125 "Loader doesn't work with esbuild's stdin option" (also esbuild#3726). #124 "Could not resolve react in @react-three/drei" (peer deps). #114 "Allow Remote Config File". #106 "Failing to treeshake dead imports…". #103 "File name too long" (+3). #92 "Document minimum deno version". #91 "Module parse failure make the file unwatchable". #89/#88 (relative paths; Deno Deploy). #82 "Renaming temp folder errors on GitHub Actions". #77 "Conflicts with other loaders" (+4). #74 "cannot resolve module specifier starts with special character". #62 "Cache imports". #31 "'external' config option in esbuild broken" (+6, 2022).
- Open PRs:
  - #170 "Improve/fix node-namespace loading" (inverted builtin check)
  - #166 docs
  - **#160 "feat: Support default loaders and plugins"** (KyleJune, +223/−22)
  - #144 "read Deno config from remote"
  - #133 docs
  - **#122 "quiet option on deno info"** (nestarz)
  - #112, #97
  - **#75 "set fetch options"** (user-agent for esm.sh targets, auth)
  - #51 "esbuild on stdin fails because referrer…" (nestarz, +488)
- Recurring closed themes:
  - npm specifier breakage (#29, #81, #93, #127, #139 "NPM packages are incorrectly assumed to have downloaded into the registry.npmjs.org cache")
  - JSON imports (#46, #147 "JSON does not support comments" for `@std/cli/_data.json`)
  - import-map support (#10, #34, #35, #45, #86, #94)
  - externals (#31)
  - stdin (#18)
  - `deno compile` (#26)
  - DENO_AUTH_TOKENS (#55)
  - version conflicts (#37)
  - **#138 "Forks of this repo"** (points to twosaturdayscode→duesabati's rewrite)

### 1.8 Forks

- `gh api repos/lucacasonato/esbuild_deno_loader/forks` returns ~49 forks, most with 0–2 stars. No GitHub fork's `main` is meaningfully ahead: KyleJune, ngasull, AlexJeffcott, happy5214 and omar-azmi are all ahead=0 because their work lives on PR branches. eibens is +1 (a test for #137). `gjsify/esbuild-plugin-deno-loader` is +48/−58 (a 2023 divergence for GJS: yarn workspace, deepkit reflection, `ext:deno_node/*` imports).
- **`@kylejune/esbuild-deno-loader` 0.12.0/0.12.1** (JSR, 2024-12-19 / 2025-03-15, by Kyle June; no GitHub link in JSR; source equals PR #160). Diff vs 0.11.1:
  - `onResolve` returns `undefined` for CSS import kinds `/^(import-rule|composes-from|url-token)$/`.
  - `onLoad` for the `file` namespace is limited to `EXTENSION_FILTER = /\.(ts|tsx|js|jsx|mts|mjs|json|wasm)$/`.
  - It adds a `data` loader with `DATA_FILTER` (JS/TS/JSON/wasm MIME types only). The old `/.*/` data `onLoad` was left in place, so the new filter is shadowed for loads, but non-JS data URLs now fall through at resolve time.
  - The resolver re-entry spreads the original args (`...resolveArgs`, keeping `importer`/`resolveDir`/`kind`/`with`) and marks `pluginData.denoResolverPlugin = true` to avoid infinite recursion. `pluginData` is forwarded in the npm `build.resolve` calls.

  Why: to make `@udibo/esbuild-plugin-postcss` (CSS entry points, `url()` data URLs) work alongside the Deno plugins. KyleJune later moved to `@deno/esbuild-plugin` (#31/PR #34). JSR: 51 downloads per ~90 days.
- **`@bureaudouble-forks/esbuild-deno-loader`** (Elias Rhouzlane = GitHub `nestarz`). Versions 0.10.3+nestarz.quiet(.0.0.2/.0.0.3), 0.10.3+pr0.0.4, 0.10.4 (2024-09-09), 0.10.5 (2024-11-06). Based on the **0.10.x line** (pre-WASM, vendored `x/importmap` TS import-map resolver, `nodeModulesDir?: boolean`). Changes:
  - `quiet?: boolean`, which adds `--quiet` to `deno info` (= PR #122)
  - bumps `@std/*` from 0.213 to 1.x

  Why: to keep a WASM-free, quiet version for his RSC/islands framework (`@bureaudouble/islet`, `@bureaudouble/rsc-engine` are the dependents). ~2k JSR downloads per ~90 days. The same scope also forks other packages (`deno-loader`, `importmap`, …).
- **`@duesabati/esbuild-deno-plugin`** (GitHub `duesabati/esbuild-deno-plugin`, formerly twosaturdayscode; 10 ★; last push 2025-02-28; JSR 0.2.6). A full TS rewrite that **drops the portable loader**. Workspace support works by synthesizing `scopes` from each member's `imports` into the root import map; it resolves multiple `exports` of members. "Vendoring coming soon". Still `deno info`-based.

### 1.9 Verdict

Good: the two-phase design and composability via `build.resolve`; the batched `deno info`; the hard-link farm, which lets esbuild do Node resolution (correct tree shaking and conditions); the scheme-as-namespace convention; `watchFiles`; tests across native/portable × native/WASM esbuild; and no esbuild dependency.

Bad:
- `/.*/` everywhere and a `file` onLoad catch-all
- `--no-config` and `cwd` pitfalls
- no deno.json `compilerOptions`
- import attributes lost
- Deno-only with TLA side effects
- Windows argv overflow and long link paths
- the portable loader has no cache, an HTTP status bug and requires a lockfile for jsr
- frozen `deno_config` 0.37, so no globs, `links` or newer Deno features
- a CI that never exercised Deno 2


---

## 2. `@deno/esbuild-plugin` (official) and its engine `@deno/loader`

### 2.1 Identity

| Field | Value |
|---|---|
| Repo | https://github.com/denoland/deno-esbuild-plugin (created 2025-06-12) |
| Registry | **JSR only**: `jsr:@deno/esbuild-plugin` (npm `@deno/esbuild-plugin` → 404) |
| Latest | **1.2.1** (2025-12-03). History: 1.0.0 (2025-06-12) … 1.1.0 (2025-07-14, text/bytes) … 1.2.0 (2025-08-12, env inlining) |
| Maintainer | Marvin Hagemeister (every release); @deno/loader by David Sherret, Bartek Iwańczuk, Luca Casonato |
| License | MIT |
| Stars/forks | 14 ★ / 1 fork (KyleJune); 7 open issues + 1 open PR |
| Activity | **Semi-stale.** No release for ~10 months. PR #34 (2025-12-05) is unreviewed. `@deno/loader` is active (daily denobot bumps; 0.5.0 on 2026-03-29). |
| JSR | score 88; 20 dependents (Fresh 2.0 alphas up to `@fresh/core 2.0.0-alpha.43`, `@eser/bundler`, goatdb, `@udibo/juniper`, …); ~34k downloads per ~90 days |
| Size | Plugin 20 KB. `@deno/loader` 0.3.14 is 5.6 MB (`rs_lib.wasm` 5.47 MB) |
| Deps | `jsr:@deno/loader@^0.3.10`, `jsr:@std/path@^1.1.1`, `npm:esbuild@^0.25.5` (types only, but it still installs a second esbuild; issue #36) |

### 2.2 How it plugs in (`src/plugin.ts`, 262 lines; `src/mod.ts` re-exports)

- A single plugin, `denoPlugin(options)`, named `"deno"`. `setup` is **async**:
  - `new Workspace({debug, configPath, nodeConditions: initialOptions.conditions, noTranspile, preserveJsx, platform: getPlatform(initialOptions.platform)})` and `await workspace.createLoader()` (L43–53).
  - `ctx.onDispose(() => loader[Symbol.dispose]())` (L55–57).
  - The loader is created **once per plugin instance**. No `onStart`, so there is no per-build invalidation.
- `onResolve` (L63–113) is registered 7 times: once with no namespace (`/.*/`, which already matches everything) and for `file`, `http`, `https`, `data`, `npm`, `jsr`. The extra registrations are redundant. Steps:
  1. `isBuiltin(args.path)` (from `node:module`) **or** any `initialOptions.external` regex matches → `{path, external:true}`. Bare `fs`, `path`, … are externalized regardless of `platform`.
  2. `ResolutionMode.Require` for `require-call`/`require-resolve`, else `Import`.
  3. `await loader.resolve(args.path, args.importer, kind)`. The async resolve adds npm/jsr requirements to the graph on the fly.
  4. The result URL is mapped to a namespace by prefix (`file`→path via `fromFileUrl`; `http`, `https`, `npm`, `jsr` keep the full URL as `path`). `data:` and other schemes get **no namespace**, which makes esbuild reject the non-absolute path (verified).
  5. Errors matching `/not a dependency and not in import map|Relative import path ".*?" not prefixed with/` return `null` so other plugins and esbuild can try. This is fragile: #30 broke when @deno/loader 0.3.7 changed its messages.
- `onLoad` (L125–181) is registered for `file` (catch-all), `jsr`, `npm`, `http`, `https`, `data`:
  - URL = `args.path` if it starts with `http(s):`/`npm:`/`jsr:`, else `toFileUrl(args.path)`.
  - `getModuleType(path, args.with)`: `text`/`bytes`/`json` attributes, or a `.json` extension → Json (PR #24, so JSON can be `require`d without an attribute).
  - `await loader.load(url, moduleType)`. `kind:"external"` → `null`.
  - `loader = mediaToLoader(res.mediaType)`. **It ignores the requested type**, so a text/bytes import of `.json`/`.css` gets the `json`/`css` loader (the verified bug; #28).
  - Optional env inlining by regex (below).
  - No `resolveDir` and no `watchFiles` (esbuild auto-watches `file`-namespace paths only).
- `mediaToLoader`:
  - Jsx→jsx; JS/Mjs/Cjs→js; TS/Mts/Dmts/Dcts→ts; Tsx→tsx; Css→css; Json/SourceMap→json; Wasm→`binary`.
  - Html, Sql, Unknown and others (Jsonc/Json5/Markdown, Cts) → `"default"`, meaning esbuild picks by extension.

### 2.3 Resolution and loading architecture (`@deno/loader`, `src/mod.ts` + `src/rs_lib/lib.rs`)

- `Workspace` wraps Rust `DenoWorkspace::new_inner` (lib.rs L213–331):
  - `WorkspaceFactory` with `ConfigDiscoveryOption::DiscoverCwd`, i.e. **process cwd** (not esbuild `absWorkingDir`; #29). Alternatives are `Path(configPath)` or `Disabled` (`noConfig`).
  - `no_lock` option.
  - `lockfile_skip_write: false`, so it may write deno.lock.
  - `node_modules_dir`/`vendor` are taken from config.
- `ResolverFactory` settings:
  - `allow_json_imports: Always`, `unstable_sloppy_imports: true` (extension-less imports "just work"), `bare_node_builtins: true`
  - `NodeResolverOptions{ is_browser_platform, bundle_mode: true, conditions }`
  - `NodeCodeTranslatorMode::Disabled` (CJS is left for the bundler)
  - `is_cjs_resolution_mode: ExplicitTypeCommonJs`
  - `newest_dependency_date` (minimumDependencyAge support)
  - `CompilerOptionsOverrides{ no_transpile, preserve_jsx, source_map_base: workspace root }`
- `NpmInstallerFactory` installs npm packages **itself** into the global cache or `node_modules` per the config's `nodeModulesDir`:
  - HTTP goes through `WasmHttpClient` → JS `fetch`.
  - `.npmrc` registries are supported via `deno_npmrc`, with auth headers and client certificates (`Deno.createHttpClient`).
  - **Lifecycle scripts are never run** (`NullLifecycleScriptsExecutor`, `PackagesAllowedScripts::None`).
  - `cachedOnly` maps to `NpmCacheSetting::Only`.
- `DenoLoader`:
  - Holds a `deno_graph::ModuleGraph` (`GraphKind::CodeOnly`).
  - `addEntrypoints(urls)` builds the graph with lockfile `fill_graph`, a `locker` (integrity checks), JSR version resolution, the npm resolver, and bytes/text imports enabled.
  - `resolveSync` uses `resolve_with_graph` on the existing graph.
  - `resolve` (async) additionally, when the result is an `npm:`/`jsr:` requirement, **adds it as a graph entrypoint** (a potential mini "npm install" per new package) and then resolves synchronously (L627–656). The docs warn this "may cause multiple npm installs and different npm or jsr resolution than Deno".
  - `load(url, requestedModuleType)` (L705–785):
    - `node:` → `{kind:"external"}`
    - `jsr:` → error (must be resolved first)
    - otherwise `ModuleLoader.load(graph, url)`
    - for modules not in the graph, `file_fetcher.fetch_bypass_permissions`: Text/Bytes → raw bytes; else, if emittable, **transpile via `deno_ast` Emitter** (honors deno.json `compilerOptions`: jsx, jsxImportSource, jsxFactory, decorators, …)
    - responses include `mediaType` and `code`; from 0.5.0 also an extracted `sourceMap` (inline maps remain in `code`)
- `ResolveError` carries `code` (Node error code), `specifier` (the would-be resolution) and `isOptionalDependency` (from `optionalDependencies`/`peerDependenciesMeta.optional`). This is a nice primitive for "ignore missing optional deps", e.g. jsdom `require("canvas")` (@luca #150).
- Runtime: 0.3.x is Deno-only (`import wasm from "./rs_lib.wasm"`). **0.4.0 added Node.js support** (`src/rs_lib_node.js` reads and instantiates the WASM with `node:fs`). HTTP uses `fetch`; client certificates need `Deno.createHttpClient`. It always logs `Downloading <url>` via `console.error` (`helpers.js`).
- Other `WorkspaceOptions` the esbuild plugin does **not** expose: `noConfig`, `noLock`, `newestDependencyDate`, `cachedOnly`. `getGraphUnstable()` gives access to the module graph.
- Relevant `@deno/loader` issues:
  - #72 "deno loader 0.3.10 failed reading lockfile during vite build"
  - #66 "Node browser field `false` not supported"
  - #57 "wasm import not recognized by node"
  - #56 "Allow to override JSX transform options"
  - closed: #60 "Node conditions order ignored", #30 (fflate browser condition), #17 "Resolution error on missing optional peerDependency", #16 "Unable to create a loader if entrypoint dependencies not resolvable", #15 "Workspace loader fails to resolve entrypoint from member's import map", #55 "detached ArrayBuffer"

### 2.4 Feature matrix (`@deno/esbuild-plugin` 1.2.1)

| Feature | Status |
|---|---|
| jsr / npm / https / node / file | Yes, with exact Deno semantics (deno_resolver + deno_graph + lockfile + workspaces + `links` + package.json + sloppy imports). |
| data: | **Broken** (verified: "returned a non-absolute path"). |
| TS/JSX transpile | Done by Deno (`deno_ast`) using deno.json `compilerOptions`. esbuild's `jsx*` options are effectively ignored unless `preserveJsx`/`noTranspile`. Inline source maps are preserved in `code`, so esbuild can chain them. |
| Import attributes | `json`/`text`/`bytes` are requested from the loader, but the esbuild loader is chosen from the media type, so **text/bytes of JSON/CSS are wrong** (verified; #28). |
| WASM | `Wasm` media type → `binary` loader (bytes), not WASM ESM. |
| CSS / assets | Loaded through `loader.load`. CSS gets the `css` loader; binary assets go through the loader path and have been reported **corrupted** (fonts, #35). |
| Tree-shaking / sideEffects | **Lost**, because npm files are returned as plain paths with no `sideEffects`. Verified: lodash-es `chunk` bundles to 321.9 KB (vs 10.4 KB with @luca). |
| Watch / rebuild | One loader for the plugin lifetime and no invalidation. Stale content reported in #6; my local-file test did pick up the change, so staleness likely affects graph-held modules. |
| Lockfile | Honored (read and integrity checked; may be written). |
| Private registries / auth | `.npmrc` (npm). `DENO_AUTH_TOKENS` for https is likely honored via `deno_cache_dir`, not verified. |
| DENO_DIR | Respected via `deno_cache_dir`/`deno_resolver` factories (env-based). |
| Externals | Own glob→regex over `initialOptions.external`, plus `isBuiltin` for bare builtins. `packages:"external"` is not honored (all bare specifiers are resolved by the plugin first). |
| `platform` / `conditions` | Mapped (`neutral` → default "node"). `mainFields`, `resolveExtensions`, `alias`, `tsconfigRaw` are ignored. |
| Output paths | Machine-specific `../../Library/Caches/deno/npm/...` (or `C:/Users/...` on Windows) in comments and `__commonJS` keys (#37); workaround `nodeModulesDir: "auto"`. |
| Env inlining | `publicEnvVarPrefix`: regex replacement of `Deno.env.get("P_X")` and `process.env.P_X` in raw source (also inside strings and comments). `define` isn't used because keys can't contain `(` (PR #26). |
| Runtime | Deno only (`Deno.env`, @deno/loader 0.3 is Deno-only); runtimeCompat `{deno:true}`. |

### 2.5 Configuration surface (`DenoPluginOptions`)

- `debug?: boolean` (Rust and JS debug logs; the global logger is set only once)
- `configPath?: string` (default: discover from **process cwd**)
- `noTranspile?: boolean` (default false)
- `preserveJsx?: boolean` (default false)
- `publicEnvVarPrefix?: string` (default none, i.e. no inlining)

Implicit inputs: `initialOptions.conditions` → `nodeConditions`, `initialOptions.platform` → `platform`, `initialOptions.external`.

### 2.6 Quality

- Tests: `tests/bundle.test.ts` (20 tests) and `tests/external.test.ts` (1). Coverage: entry-point shapes, import map, https (esm.sh), npm, jsr, node:, `file:` URLs, tsx, "plugins can participate", jsx import source, `with` json/text/bytes, externals, "ignore modules it cannot resolve", `platform: browser`, JSON `require` in an npm module, env vars. They depend on the network.
- Several tests are **non-discriminating**:
  - "plugins can participate in resolution": the mapped specifier is resolved by `denoPlugin` first, and the fixture already logs "hey" (acknowledged in PR #34).
  - "with text": the JSON object's text also contains "it works".
  - "jsx import source": the repo's deno.json already sets preact.
- CI: Linux, macOS and Windows on Deno 2.x; fmt, lint, `deno check`, typos, tests. A publish workflow exists.

### 2.7 Issues and PRs (all)

- Open:
  - #37 "absolute vs relative paths" (machine-specific output) https://github.com/denoland/deno-esbuild-plugin/issues/37
  - #36 "ESBuild minor version: Installs two versions" (`^0.25.5` on 0.x) https://github.com/denoland/deno-esbuild-plugin/issues/36
  - #35 "Files get corrupted in build output" (woff/woff2 via `file` loader) https://github.com/denoland/deno-esbuild-plugin/issues/35
  - #31 "Add loader and resolver plugins to support injecting plugins like react compiler in between them", with open **PR #34** "feat: Add ability to split deno plugin into a resolver and loader plugin" (KyleJune; `denoPlugins()` sharing one workspace) https://github.com/denoland/deno-esbuild-plugin/pull/34
  - #29 "absWorkingDir not used for entryPoints when using denoPlugin" https://github.com/denoland/deno-esbuild-plugin/issues/29
  - #28 "Raw Import with `{ type: "text" }` still triggers module resolution for CSS files"; also `.d.ts` as text becomes `{}` https://github.com/denoland/deno-esbuild-plugin/issues/28
  - #6 "Old file contents on rebuilds" (a commenter also lists no .css/.svg/.wasm support, the awkward `deno:` namespace, and slowness) https://github.com/denoland/deno-esbuild-plugin/issues/6
- Closed:
  - #30 "Test case for 'ignore modules it cannot resolve' is failing" (broken by @deno/loader 0.3.7)
  - #7 "Adding denoPlugin breaks external" (fixed by PR #15)
  - #5 "Glob-style entry points not working" (fixed by PR #14, which stopped pre-passing entrypoints)
  - PR #9 "support virtual entrypoints" (closed as unnecessary)
- Cross-project: oazmi's author advertises `@oazmi/esbuild-plugin-deno` in #28 and #6.

### 2.8 Forks

`KyleJune/deno-esbuild-plugin` (branch for PR #34; `main` identical to upstream).

### 2.9 Verdict

Good:
- Exact Deno resolution semantics with almost no code: jsr, npm, workspaces, links, lockfile, `.npmrc`, sloppy imports, Deno's transpile using deno.json.
- `ResolveError.code`/`isOptionalDependency`.
- `onDispose` cleanup.
- Maps esbuild `platform`/`conditions`.
- Import attributes are at least passed to the loader.

Bad:
- Single monolithic plugin with a catch-all `onLoad` (no asset passthrough, corrupt binaries, CSS-as-text bug).
- Loses `sideEffects` (bundle bloat).
- `data:` broken.
- cwd-based discovery.
- Regex-on-error-message control flow.
- No per-build invalidation.
- Deno-only (it pinned itself out of @deno/loader 0.4's Node support).
- Env inlining by regex.
- Pulls a second esbuild.
- 5.5 MB WASM cold start.

### 2.10 Hands-on verification (esbuild 0.28.2, Deno 2.9.7)

Script: `$SCRATCH/exp/proj/build.ts` (argument `deno`|`luca`) and `build_gg.ts` (ggpwnkthx). Outputs:

| Case | @deno/esbuild-plugin 1.2.1 | @luca 0.11.1 (native, configPath) | @ggpwnkthx 0.2.12 |
|---|---|---|---|
| `import t from "./data.json" with {type:"text"}` | ❌ object `{foo:"it works"}` | ✅ string (by accident: @luca returns `undefined`, esbuild loads it natively) | ❌ object |
| import-mapped `"mapped-data" with {type:"json"}` | ✅ | ✅ | ✅ |
| `import {chunk} from "lodash-es"` (npm:, sideEffects:false) | ❌ **321,928 B** | ✅ **10,379 B** | ❌ 321,928 B |
| `import v from "data:text/javascript,export default 42"` | ❌ "returned a non-absolute path" | ✅ | ❌ same error |
| same lodash import with `platform:"neutral"` | ✅ | ❌ "Could not resolve lodash-es" | ✅ |
| `esbuild.context().rebuild()` after editing a local file | ✅ picked up | ✅ | ✅ |

Plain esbuild 0.28 with a plugin that returns `loader:"json"` for a `with {type:"text"}` import also yields an object (`probe.ts`). So **the plugin must choose the loader from `args.with`**; esbuild obeys the loader the plugin returns.


---

## 3. `@oazmi/esbuild-plugin-deno` (portable, fetch-based, cooperative)

### 3.1 Identity

| Field | Value |
|---|---|
| Repo | https://github.com/oazmi/esbuild-plugin-deno (created 2025-01-19; 132 commits) |
| Registry | JSR `jsr:@oazmi/esbuild-plugin-deno` and npm `@oazmi/esbuild-plugin-deno` (dnt build; 2.0 MB unpacked; 88 npm downloads last month) |
| Latest | **0.4.6** (2026-07-12). 0.4.0 (2025-04-04), 0.4.2–0.4.4 (2025-08, workspaces), 0.4.5 (2025-11) |
| Maintainer | Omar Azmi (solo) |
| License | Apache-2.0 since 2026-03 (GitHub shows NOASSERTION) |
| Stars | 4 ★, 0 forks, 2 open issues |
| Activity | Active but sporadic. JSR score 94; runtimeCompat browser/deno/node/bun; ~450 JSR downloads per ~90 days; 3 dependents |
| Deps | `@oazmi/kitchensink` (utils, own JSONC, own semver), `@oazmi/esbuild-types` (loose esbuild types, no esbuild dependency) |

### 3.2 How it plugs in

`denoPlugins(config)` returns **5 plugins in order** (`src/plugins/mod.ts`):

1. **`oazmi-entry`** (`src/plugins/filters/entry.ts`). For every `onResolve({filter:/.*/})` in the accepted namespaces (default `[undefined, "", "file"]`) it chains:
   - (a) `initialPluginDataInjector`: entry points get `initialPluginData` (import map, `runtimePackage` = deno.json, `resolverConfig`)
   - (b) `inheritPluginDataInjector`: a resource whose `pluginData` was stripped (esbuild's native loader drops it) inherits the importer's recorded `pluginData` from a `Map<resolvedPath, pluginData>`
   - (c) `absolutePathResolver`: `build.resolve(path, {namespace:"oazmi-resolver-pipeline"})`, then **re-resolves the absolute result in the original namespace** so that other plugins or esbuild's native loaders can take over

   Each step marks `pluginData` with unique **symbols** (`ALREADY_CAPTURED_BY_*`) to prevent recursion. `stdin` is handled in `onStart`.
2. **`oazmi-http-plugin`** (`http.ts`):
   - resolves `^https?://` into namespace `oazmi-loader-http`
   - `file://` URLs are converted to local paths and re-resolved (so esbuild loads them natively)
   - the loader does `fetch(url)`, then **guesses the esbuild loader from the response content-type and extension** (`src/loadermap/mimes.json`, `extensions.json`), with fallback `defaultLoader: "copy"`; `pluginData` is forwarded
3. **`oazmi-jsr-plugin`** (`jsr.ts`):
   - `jsr:` → `DenoPackage.fromUrl()`: fetches `https://jsr.io/@s/p/meta.json`, then **its own semver** picks the max satisfying unyanked version (the code comment admits it can't distinguish prereleases)
   - then **HEAD-scans `deno.json`, `deno.jsonc`, `jsr.json`, `jsr.jsonc` in the published package** (#4: deno.jsonc was missed before)
   - `resolveExport(subpath)` → https URL → handed to the http plugin
   - it resets the scope's import map to the jsr package's own (`runtimePackage`) and disables node_modules resolution inside jsr scope
4. **`oazmi-npm-plugin`** (`npm.ts`):
   - strips `npm:` and finds a `resolveDir` containing `node_modules/<pkg>` among `nodeModulesDirs` (default `[absWorkingDir]`)
   - node_modules resolution goes through **`EsbuildNativeResolver`** (`src/misc/esbuild_native_resolver.ts`): a *second* `build.esbuild.build()` with a never-finishing dummy entry whose plugin captures `build.resolve`, giving access to esbuild's native resolver with custom `resolveDir`/`platform`/`conditions`/`mainFields`
   - if the package is missing and `autoInstall` is set, packages are installed by CLI (`deno cache --node-modules-dir=auto --allow-scripts --no-config npm:x`, `npm install --no-save --no-package-lock x`, `bun install --no-save`, `pnpm install`) or **"dynamic"** (in Deno/Bun, `import()` a Blob URL `export * as myLib from "npm:x"`, which **executes package code**)
   - `peerDependencies` can be pre-installed in `onStart` (aliases supported)
   - `sideEffects` option can force `result.sideEffects`
5. **`oazmi-resolver-pipeline`** (`resolvers.ts`): a namespaced pipeline of resolvers, each individually disableable via `pluginData.resolverConfig` (`useImportMap`, `useRuntimePackage`, `useNodeModules`, `useRelativePath`, `useInheritPluginData`):
   - global import map (`globalImportMap`)
   - the scope's `pluginData.importMap`
   - runtime package (deno.json imports/exports, workspace members)
   - node_modules
   - relative→absolute path

   It also respects `initialOptions.external` for pluginData-driven resolution (0.4.4).

### 3.3 Architecture notes

- deno.json handling (`src/packageman/deno.ts`): `imports` (with automatic trailing-slash directory variants), `exports`, `workspace` members (0.4.2+ with `scanAncestralWorkspaces`). **No `scopes`** (todo: "I haven't got a clue as to what it does"), no `compilerOptions`, no `nodeModulesDir` semantics, **no lockfile**, no integrity, no cache (re-fetches every build), no `DENO_DIR`, no auth tokens.
- TS is transpiled by esbuild. There are no import-attribute handlers (a todo). Being non-invasive, CSS, SVG and other assets from http, jsr or npm work via esbuild's native loaders.
- Portable: `Deno.cwd()`/`process.cwd()` fallback; the web uses `location.href`. `node:child_process` is only for auto-install.

### 3.4 Configuration surface

`DenoPluginsConfig`, with defaults:

- `initialPluginData`: `undefined`. Shape `{importMap?, runtimePackage?: WorkspacePackage|URL|string, resolverConfig?}`.
- `scanAncestralWorkspaces: false`
- `log: false`; `logFor: ["npm","resolver"]`
- `autoInstall: true` (`boolean | "auto-cli" | "auto" | "dynamic" | "npm" | "deno" | "deno-noscript" | "bun" | "pnpm" | {dir, command(pkgs)=>({process,args}), log}`)
- `peerDependencies: {}` (import-map-like or entry-point array)
- `nodeModulesDirs: [DIRECTORY.ABS_WORKING_DIR]`
- `globalImportMap: {}`
- `getCwd: defaultGetCwd` (function or string)
- `acceptNamespaces: [undefined, "", "file"]`

Per-plugin configs:

- entry: `filters [/.*/]`, `forceInitialPluginData: false | "merge" | "overwrite"`, `enableInheritPluginData: true`
- http: `filters [/^https?:\/\//, /^file:\/\//]`, `namespace "oazmi-loader-http"`, `defaultLoader "copy"`, `acceptLoaders`, `convertFileUriToLocalPath {enabled:true, resolveAgain:true}`
- jsr: `filters [/^jsr:/]`
- npm: `specifiers ["npm:"]`, `sideEffects "auto"`

### 3.5 Quality, issues and verdict

- Quality: 4 integration test files (`test/1` entries and aliases, `test/2` workspaces, `test/3`), network-dependent; run via the `build-docs` CI action. Doc tests exist in source. Many TODOs in `todo.md` (path-resolution cache, `with`-based loader selection, `jsr-local:` specifiers, a stub `PluginBuild` for unit tests).
- Issues:
  - #7 "Unable to resolve workspace imports" (open; partly addressed in 0.4.2)
  - #4 "Not checking for deno.jsonc when retrieving JSR packages" (open)
  - #8 "globalImportMap is ignored when using stdin" (closed)

  The author promotes the plugin in @luca #159 and @deno #6/#28.
- **Good:**
  - Runtime-agnostic (Deno, Node, Bun, browser).
  - Cooperative: it re-resolves in the original namespace, so native loaders and other plugins work.
  - `pluginData` scoping and inheritance for per-package import maps.
  - `EsbuildNativeResolver` trick.
  - Auto-install with peer-dependency preinstall.
  - `acceptNamespaces` to opt custom namespaces into Deno resolution.
- **Bad:**
  - Deno semantics are only approximated: own semver, no lockfile, no dedupe, fetches JSR package config instead of `<ver>_meta.json` exports.
  - No caching.
  - Symbols in `pluginData`.
  - A 5-plugin setup with a complex mental model (the author's README TODO admits the description is outdated).
  - "dynamic" install executes code.

---

## 4. `@ggpwnkthx/esbuild-plugin-deno` (a community port of the official plugin onto @deno/loader 0.5)

### 4.1 Identity

| Field | Value |
|---|---|
| Repo | https://github.com/ggpwnkthx/deno-esbuild, a monorepo: `packages/plugins/deno` (created 2026-03-26; 95 commits; 0 ★) |
| Registry | JSR `jsr:@ggpwnkthx/esbuild-plugin-deno` |
| Latest | **0.2.12** (2026-08-13); 0.3.0 (2026-07-25, **yanked**); first release 2026-05-05 |
| Maintainer | Isaac Jessup |
| License | MIT |
| Activity | Active (mid 2026). JSR score 100; runtimeCompat Deno; 0 dependents; ~140 downloads per ~90 days |
| Siblings | `@ggpwnkthx/esbuild` (a Deno-first re-implementation of esbuild's JS API: stdio protocol, native-binary installer and WASM), `esbuild-plugin-css`, `esbuild-plugin-commonjs` (CJS→ESM), wrappers for Hono and Oak (dev-server transforms) |

### 4.2 Design (`packages/plugins/deno/mod.ts`, `resolve.ts`, `utils.ts`, `env.ts`, `workspace.ts`)

It is essentially `@deno/esbuild-plugin` with these differences:

- Depends on `@deno/loader@^0.5.0` (Node-capable loader, `sourceMap` field) and `@ggpwnkthx/esbuild` for types.
- `SKIP_ASSET_PATTERN` (L107) returns `null` from `onResolve` for css/images/fonts/audio/video/3D/pdf/wasm/sqlite/… so esbuild's native loaders handle assets.
- Only `node:`-prefixed specifiers become external (not bare `fs`).
- `resolveImporter()` (resolve.ts): if the importer is outside the workspace root, it substitutes a **synthetic referrer** `<root>/.deno-resolver-referrer` so the import map applies. Managed paths (`/node_modules/`, `/deno/`) are passed through so CJS relative requires stay correct.
- `onLoad` sets `resolveDir = dirname(path)` for file paths.
- `createDenoPlugin(options)` returns a **long-lived `DenoPluginHandle`** `{plugin, resolve(spec, importer?) → {url, absPath}, build(entry, opts) → {code}, [Symbol.dispose]}` for dev servers. It shares one `Workspace`+`Loader` across many small builds, with defaults `format:esm`, `platform:browser`, `target:es2022`, `jsx:automatic`, `jsxImportSource:react`, `sourcemap:inline`.
- Env inlining is extended to `import.meta.env.P_X` and `const { P_A, P_B } = Deno.env` destructuring. Unset values become the string `"null"`.
- Options: `debug`, `configPath`, `platform` (override), `noTranspile`, `preserveJsx`, `publicEnvVarPrefix`.

### 4.3 Quality and verdict

- 32 test cases (`tests/mod.test.ts` 17, `resolve.test.ts` 7, `utils.test.ts` 8). CI runs each package's `deno task ci` (fmt, lint, check, test) and publishes with provenance.
- Verified: it inherits the text-import, `data:` and **sideEffects** bugs of the official plugin (table in §2.10).
- Good ideas: asset skip-list, handle API, synthetic referrer, and upgrading to 0.5.
- Bad: still `/.*/` resolution, regex error matching, still Deno-only, 0.3.0 was yanked within days.

---

## 5. `@miyauci/esbuild-deno-specifier` and `@miyauci/esbuild-import-map`

### 5.1 `@miyauci/esbuild-deno-specifier`

| Field | Value |
|---|---|
| Repo | https://github.com/TomokiMiyauci/esbuild-deno-specifier. **Code lives on the `beta` branch** (tag 1.0.0-beta.14); `main` stops at 2024-05-21 |
| Registry | JSR `jsr:@miyauci/esbuild-deno-specifier`. **Only prereleases**: 1.0.0-beta.1…beta.14 (2024-05-23 → 2024-07-02); JSR `latest` = null |
| Maintainer | Tomoki Miyauchi (JSR publisher shows as "Satoshi") |
| License | MIT |
| Stars | 0 ★ |
| Activity | **Abandoned since 2024-07.** ~20 JSR downloads per ~90 days; 1 dependent |
| Runtime | Deno only (runs `deno info` via `jsr:@deno/info`; uses `@deno/cache-dir` for DENO_DIR) |

Design (`src/plugin.ts`, `resolve.ts`, `strategy.ts`, `npm/cjs/*`, `browser.ts`, `side_effects.ts`, `option.ts`):

- `denoSpecifierPlugin({nodeModulesDir?: boolean = false, denoDir?: string = DENO_DIR, lock?: string})`, composed of sub-plugins `fileURLResolverPlugin`, `denoDataURLSpecifierPlugin` and `denoRemoteSpecifierPlugin`.
- The remote resolver's filter is `/^npm:|^jsr:|^https?:^node:/`. **Bug: a missing `|`**, so `https?:` and `node:` never match (only `npm:`/`jsr:` do).
- For each root specifier it runs `deno info --json --no-config [--lock] [--node-modules-dir]` (memoized), with `env DENO_DIR` and `cwd=absWorkingDir`. It stores `{module, source(=info output), mediaType}` in `pluginData` in namespace `deno-url`. **Dependencies of remote modules are resolved from the `deno info` graph** (`resolveModuleDependency`) instead of re-implementing jsr or import-map logic.
- Remote module code is read from `module.local` in DENO_DIR, with `resolveDir = dirname(local)`.
- npm packages are read **directly from the global cache** (`GlobalStrategy`: `DENO_DIR/npm/registry.npmjs.org/<name>/<version>`) or from `absWorkingDir/node_modules` (`LocalStrategy`, walking parents and resolving symlinks).
- A full Node resolver is **re-implemented** in TS: CJS `require` algorithm, `exports`, `imports`, `browser` map (value `false` → namespace `disabled` → empty module). The README's FAQ explains why: `build.resolve` can't do *only* node_modules resolution, which recurses with import maps.
- It honors esbuild's `platform` (default browser), `mainFields` (esbuild's per-platform defaults), `conditions`, `resolveExtensions`, the `loader` map, `packages: "external"` (all Deno specifiers external) and **`logLevel`** (drives `@std/log`).
- It computes **`sideEffects` from package.json** (booleans or globs via `globToRegExp`) and returns it in `OnResolveResult`.
- `node:` on non-node platforms returns `{errors:[{text:"… not found", notes:[{text:"… is a built-in node module"}]}]}`. On the node platform it is external.
- `data:` is loaded via `fetch`, with the media type from a bundled `deno_media_type` WASM (212 KB); JSON data URLs are rejected. `file:` URLs are `build.resolve`d as paths, **forwarding `with`**.
- **No import maps** by design. Pair it with `@miyauci/esbuild-import-map`.

Quality: 103 unit-test cases (`*_test.ts` for CJS algorithms, browser map, side effects, options, plugin). semantic-release plus a publish workflow. Good docs (README FAQ and `docs/`).

Verdict:
- Good: the most esbuild-faithful option handling; `sideEffects`; `errors`+`notes`; browser `false`; graph-based dependency resolution.
- Bad: Deno-only (`deno info` per root, slow); a reimplemented Node resolver; the filter typo; beta forever; `--no-config` (ignores deno.json npm resolution); no transpile config.

### 5.2 `@miyauci/esbuild-import-map`

| Field | Value |
|---|---|
| Repo | https://github.com/TomokiMiyauci/esbuild-import-map |
| Registry | JSR `jsr:@miyauci/esbuild-import-map` **1.2.0** (2024-07-08) |
| License / stars | MIT / 0 ★ |
| Activity | Dormant since 2024-07; ~17 JSR downloads per ~90 days |
| Runtime | Deno/Node/browser (WASM `deno.land/x/import_map@v0.19.1`, vendored) |

- API: `importMapPlugin({ url: URL|string, importMap: ImportMap })`.
- **Filter = a regex compiled from all import-map keys** (`imports` plus every `scopes` key): `^key$` for exact keys, `^prefix` for trailing-slash keys (`src/regexp.ts`). Non-mapped specifiers never cross into JS.
- `onResolve`: `importMap.resolve(path, referrer)` (a spec-compliant WASM import map, scopes included), then `build.resolve(specifier, {kind, importer, resolveDir, with: args.with, pluginData: done})`. A `done` symbol sentinel prevents recursion, but it **overwrites the user's `pluginData`**.
- Referrer: a `file` importer becomes a file URL; URL importers are parsed; otherwise it is built from `resolveDir` + basename. `stdin` requires an absolute `resolveDir` (clear error message).
- 19 test cases; codecov badge.
- Verdict: a tiny, correct, fast (precise filter) and runtime-agnostic reference implementation of import maps for esbuild. Missing: deno.json discovery, workspaces, `compilerOptions`.

---

## 6. `esbuild-plugin-cache-deno` (Tsukina-7mochi; **archived**) — skim

- Repo https://github.com/Tsukina-7mochi/esbuild-plugin-cache-deno (archived; last push 2024-06-10; 2 ★; MIT). Distributed via `deno.land/x/esbuild_plugin_cache_deno`.
- Requires `lockMap` (parsed `deno.lock`) and `denoCacheDirectory` (from `deno info`; `util.getDenoDir()` needs `--allow-run`). Optional: `importMap`, `importMapBasePath`, `loaderRules` (regex → loader; `empty` to drop modules such as `node:util`).
- Resolves `http(s)` by **re-implementing the DENO_DIR layout**: `deps/<scheme>/<host>/<sha256(pathname)>` (`src/http.ts`). That **ignores query strings and ports**, and Deno 2 appends a `denoCacheMetadata` trailer. npm resolves to `npm/registry.npmjs.org/<name>/<version-from-lock>/<path>` with a partial `exports` implementation (no `*` patterns, alternatives, user conditions or subpath imports, per its README table).
- Lesson: re-implementing Deno's cache layout and lockfile interpretation by hand is brittle. Open issues: #4 "some node modules are not loaded", #3 "Example lock.json is not updated".


---

## 7. The esbuild plugin API (0.14 → 0.28) and what the existing plugins use

Latest esbuild is **0.28.2**; the Unreleased section says it stops publishing to deno.land/x. Relevant capabilities, with the version that introduced them:

| Capability | Since | @luca | @deno | @ggp | @oazmi | @miyauci-spec | @miyauci-im |
|---|---|---|---|---|---|---|---|
| `build.resolve(path, {kind, importer, namespace, resolveDir, pluginData, with})` | 0.14.8 (`with` 0.21.4) | ✅ re-entry (drops importer, resolveDir, pluginData, with) | ❌ | ❌ | ✅ heavy | ✅ (file:, forwards `with`) | ✅ (forwards `with`) |
| `onStart` (blocks resolve/load until done, 0.14.22) | old | ✅ re-inits workspace and loader every build | ❌ | ❌ | ✅ (deno.json, peer deps, stdin) | ❌ | ❌ |
| `onEnd` | old | ❌ | ❌ | ❌ | ✅ (stops side resolver) | ❌ | ❌ |
| `onDispose` | 0.17.2 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `esbuild.context()` / `rebuild()` / `watch()` (+`delay` 0.25.6) | 0.17.0 | fresh state per build (correct, no reuse) | shared loader, never invalidated | same as @deno (+ handle) | refetches everything | memo per setup (stale across rebuilds) | n/a |
| `watchFiles` / `watchDirs` in results | old | `watchFiles` for local modules only | ❌ (relies on file-namespace auto-watch) | ❌ | ❌ | ❌ | ❌ |
| `args.with` in `onLoad` | 0.19.7 | ❌ | ✅ passed to loader, **loader choice ignores it** | same | ❌ | ❌ | n/a |
| `args.with` in `onResolve` | 0.21.4 | ❌ | ❌ | ❌ | ❌ | forwards | forwards |
| Native `with {type:"bytes"}` / `"text"` | 0.25.11 / 0.28.0 | benefits when falling back to native | overrides wrongly | overrides wrongly | native | native | native |
| Unknown attributes allowed with `copy` loader | 0.21.5 | — | — | — | — | — | — |
| `pluginData` | old (leak fixed 0.23.1) | ❌ (KyleJune fork ✅) | ❌ | ❌ | ✅ (symbols) | ✅ (module graph) | sentinel only |
| `sideEffects` in `OnResolveResult` | old | via esbuild native npm resolution ✅ | ❌ | ❌ | forced option | ✅ from package.json | n/a |
| `errors` / `warnings` / `notes` in results | old | ❌ (throws) | ❌ (throws) | ❌ | ❌ | ✅ | ❌ |
| `suffix` (`?query#hash` of file paths) | old | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `build.esbuild` (API instance) | old | ❌ | ❌ | ❌ | ✅ (side resolver) | ❌ | ❌ |
| Regex flags in `filter` | 0.25.2 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Precise (non-`/.*/`) filters | — | ❌ | ❌ | ❌ | partial (jsr/npm/http) | partial | ✅ from import-map keys |
| Reads `initialOptions.external` | — | ✅ own glob | ✅ own glob | ✅ | ✅ | via packages | ❌ |
| Reads `packages: "external"` | 0.17 (default for node 0.22, reverted 0.23) | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Reads `platform` / `conditions` | — | implicit (native npm) | ✅ / ✅ | ✅ / ✅ | via side resolver | ✅ / ✅ | ❌ |
| Reads `mainFields` / `resolveExtensions` / `loader` / `logLevel` | — | implicit | ❌ | ❌ | partial | ✅ | ❌ |
| `platform: "neutral"` | — | ❌ npm fails (#127) | treated as node | same | ? | ✅ (mainFields []) | n/a |
| `alias` / `tsconfigRaw` / `jsx*` from deno.json | — | ❌ (#136) | Deno transpiles itself | same | ❌ | ❌ | ❌ |
| Mutating `build.initialOptions` in setup | — | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `absPaths` (code/log/metafile) | 0.25.7 | — | related to #37 | — | — | — | — |
| `absWorkingDir` honored | — | ✅ | ❌ (#29) | partial (`configPath` dir) | ✅ | ✅ | via resolveDir |
| `stdin` | — | ❌ (#125) | ? | ? | ✅ | ✅ | ✅ |

Opportunities no one uses:

- Map deno.json `compilerOptions` (`jsx`, `jsxImportSource`, `jsxFactory`, `jsxFragmentFactory`, `experimentalDecorators`, …) into `initialOptions` or `tsconfigRaw` when not transpiling with Deno.
- Use `define` for `process.env.X` and `import.meta.env.X`.
- Return `errors` with `notes` and `detail` instead of throwing.
- Return `watchFiles` for deno.json, deno.lock, import maps and package.json.
- Honor `packages:"external"` and `alias`.
- Use `suffix` for `?raw`-style queries.
- Use regex flags and precise filters.
- Use esbuild's native `text`/`bytes` handling by returning the right loader from `with`.

### 7.1 unplugin 3.4.0's esbuild adapter (read from `dist/index.mjs` `buildSetup`) and why it matters

- `resolveId` → `onResolve({filter: plugin.esbuild?.onResolveFilter ?? /.*/})`.
  - It skips if `initialOptions.external?.includes(id)`, an **exact match with no wildcard or `packages`** handling.
  - It calls `resolveId(id, isEntry ? undefined : importer, {isEntry})`, so there is **no `with`, `kind`, `resolveDir`, `namespace` or `pluginData`**.
  - It returns `{path, namespace: plugin.name, external}`: **always the plugin's namespace, never `file`, and no `sideEffects`**. esbuild then cannot natively load resolved files (CSS, assets, npm files) or apply package.json `sideEffects`.
- `load` → `onLoad({filter: onLoadFilter})` with no namespace filter. It returns `{contents: code, loader: esbuild.loader ?? guessLoader(ext), resolveDir: dirname(path)}`. The code is a string, so binary assets are at risk, and the loader function `(code, id)` never sees `with`. `transform` reads files as `utf8`.
- Escape hatches: `esbuild.setup(build)` (raw `PluginBuild`), `esbuild.config(initialOptions)` (mutation), `esbuild.onResolveFilter`/`onLoadFilter`, `esbuild.loader`.
- **Implication:** unplugin-deno should implement the esbuild path mostly via `esbuild.setup`. That means:
  - return `namespace:"file"` for local and cached files
  - return `sideEffects`, or hand npm resolution to esbuild via `build.resolve` with a `resolveDir`
  - honor `with`
  - use precise filters
  - re-enter `build.resolve` for interop
  - keep the generic hooks for the other bundlers

---

## 8. Synthesis for unplugin-deno

### 8.1 Ideas to steal (ranked)

1. **Use `@deno/loader` (deno_resolver/deno_graph WASM) as the resolution engine**, optionally with a `deno info`/pure-TS fallback. It gives exact Deno semantics (jsr, npm, workspaces, `links`, package.json, sloppy imports, lockfile integrity, `.npmrc`, `newestDependencyDate`, `cachedOnly`) and works on Node since 0.4.0. Expose the options the official plugin hides: `noLock`, `cachedOnly`, `newestDependencyDate`, `noConfig`. Pin a compatible range so you can upgrade, and treat esbuild as a peer dependency or types only. The alternative, `deno info` batching (@luca), should be kept only as an optional "use the installed Deno CLI" mode, and must avoid argv overflow (write the synthetic root to a temp file or use stdin).
2. **Don't load npm files yourself when the bundler can.** Resolve `npm:` to a package directory and let esbuild's native resolver run with `resolveDir` (the @luca farm, or real `node_modules`), or at minimum return `sideEffects` computed from package.json (@miyauci). This preserves tree-shaking (a verified 31x difference), the browser field (`false`), `mainFields` and conditions.
3. **Loader selection from `with.type`**: `text`→`text`, `bytes`→`binary`, `json`→`json`. Otherwise use the media type, but **pass through non-JS media** (CSS, fonts, images, wasm) to esbuild's native loaders (@ggpwnkthx skip-list, KyleJune `EXTENSION_FILTER`, CSS import kinds).
4. **Composable split**: a resolver phase and a loader phase that can be ordered independently (@luca API; @deno PR #34), with `build.resolve()` re-entry that **preserves `importer`, `resolveDir`, `kind`, `with` and `pluginData`** plus a recursion marker (KyleJune fork).
5. **Precise filters** derived from the import map, the workspace member names and the schemes (`^(jsr|npm|node|https?|data):`), instead of `/.*/` (@miyauci/esbuild-import-map).
6. **Honor esbuild options**: `absWorkingDir` (discovery root), `stdin`, `external` (proper glob semantics), `packages: "external"`, `platform` including `neutral`, `conditions`, `mainFields`, `resolveExtensions`, `loader`, `logLevel` (@miyauci); map deno.json `compilerOptions` to esbuild jsx and `tsconfigRaw` when esbuild transpiles.
7. **Diagnostics**: return `errors` with `notes` (for example, "`node:fs` used with `platform: browser`", "missing optional peer dependency", "not in import map", "did you mean …"). Expose `ResolveError.code`/`isOptionalDependency`; treat optional dependencies (`try { require("canvas") }`) as empty modules or externals (@luca #150).
8. **Watch correctness**: invalidate per build in `onStart` only for changed inputs, so module/graph caches are reused across rebuilds. Add `watchFiles` for deno.json, deno.lock, import maps and package.json, and `watchDirs` for `node_modules` when relevant (@deno #6; @luca #62/#132).
9. **Long-lived handle and standalone API** (`createDenoPlugin`/`resolve()`), usable by dev servers and other tools (@ggpwnkthx; @luca #153).
10. Workspace member scoping (@duesabati `scopes` synthesis) and per-package `pluginData` scoping (@oazmi) when not using `@deno/loader`.
11. Env inlining through esbuild `define` (`process.env.X`, `import.meta.env.X`) plus an AST-safe rewrite for `Deno.env.get("X")` (@deno PR #26, @ggpwnkthx destructuring).
12. Rewriting worker and asset URLs (`new URL("./worker.ts", import.meta.url)`) for remote modules (@luca #154). Vendoring (`vendor: true`) and `DENO_DIR` awareness (@luca #152).

### 8.2 Pitfalls to avoid

- `/.*/` catch-alls, especially a `file`-namespace `onLoad` catch-all; returning non-absolute paths without a namespace (`data:`); regexes over error messages; hard-coded builtin lists (use `node:module` `builtinModules` plus `platform` awareness, without externalizing bare `fs` on the browser platform).
- `process.cwd()` instead of `absWorkingDir`; `--no-config`; lockfile paths only honored when explicit; `join(cwd, "node_modules")` instead of the workspace root.
- Import-time side effects (TLA permission queries, WASM instantiation at import); prefer lazy init in `setup`/`onStart`.
- Creating one loader forever (stale) *or* recreating everything each build (slow; the portable loader re-downloads).
- Windows: argv length (os error 206), long path segments (hash package ids), path normalization, machine-specific absolute paths in output. Keep npm files under project-relative paths or virtual ids when possible; note esbuild `absPaths`.
- Reimplementing DENO_DIR's cache layout or Node resolution by hand (cache-deno, @miyauci): brittle across Deno releases.
- Fetching JSR packages' `deno.json` to compute exports (@oazmi #4). Use `<version>_meta.json` (as @luca portable does) or `@deno/loader`.
- Executing package code to install it (@oazmi "dynamic" auto-install).
- Hard dependency on a specific esbuild version (@deno #36).
- Non-discriminating tests; CI matrices that don't test what they claim; network-dependent tests without fixtures or offline caches.
- Noisy stderr (`Downloading …` from `@deno/loader`); offer a `logLevel`-aware logger.

### 8.3 Most-demanded features to prioritize

1. Asset and plugin interop (CSS, fonts, data URLs, resolver/loader split).
2. externals / `packages: "external"`.
3. Workspaces (globs, `links`, member name/exports).
4. npm correctness (peer deps, overrides/dedupe via lockfile, browser field, optional deps, CJS `node:` requires).
5. Import attributes.
6. Watch/rebuild correctness and caching.
7. `absWorkingDir`/`stdin`/permissions.
8. Windows robustness.
9. Env inlining, vendoring, remote config, worker URL rewriting, `.d.ts`.

---

## 9. Comparison table

| | @deno/esbuild-plugin | @luca/esbuild-deno-loader | @oazmi/esbuild-plugin-deno | @ggpwnkthx/esbuild-plugin-deno | @miyauci/esbuild-deno-specifier | @miyauci/esbuild-import-map | esbuild-plugin-cache-deno |
|---|---|---|---|---|---|---|---|
| Registry / latest | JSR 1.2.1 (2025-12-03) | JSR 0.11.1 (2024-12-06) | JSR+npm 0.4.6 (2026-07-12) | JSR 0.2.12 (2026-08-13) | JSR 1.0.0-beta.14 (2024-07-02) | JSR 1.2.0 (2024-07-08) | deno.land/x (archived 2024) |
| Status | semi-stale official | maintenance; Deno team redirects away | active, solo | active, solo, new | abandoned beta | dormant | archived |
| ★ / ~90-day JSR downloads | 14 / ~34k | 197 / ~127k | 4 / ~450 | 0 / ~140 | 0 / ~20 | 0 / ~17 | 2 / – |
| License | MIT | MIT | Apache-2.0 | MIT | MIT | MIT | MIT |
| Runtime needed | Deno | Deno (+`--allow-run` for native) | Deno/Node/Bun/browser | Deno | Deno (+run) | any | Deno (+run for DENO_DIR) |
| Engine | @deno/loader WASM (deno_resolver, deno_graph) | deno_config WASM + `deno info` (native) or fetch (portable) | pure TS + fetch + esbuild side resolver | @deno/loader 0.5 WASM | `deno info` + TS Node resolver | import_map WASM | hand-rolled DENO_DIR + lock |
| jsr: | ✅ exact | ✅ native / lockfile-only portable | ✅ own semver (no lock) | ✅ | ✅ via deno info | – | ❌ |
| npm: | ✅ installs itself; plugin loads files (sideEffects lost) | ✅ esbuild-native via link farm or node_modules | node_modules + auto-install | as @deno | global cache or node_modules, own resolver | – | global cache via lock |
| https: cache | DENO_DIR | DENO_DIR (native) / none (portable) | none | DENO_DIR | DENO_DIR | – | DENO_DIR (read-only) |
| deno.json / import map / scopes | ✅ / ✅ / ✅ | ✅ / ✅ / ✅ (deno_config 0.37) | ✅ imports+exports / ✅ / ❌ | ✅ | ❌ (by design) | ✅ / ✅ / ✅ | import map only |
| Workspaces / links | ✅ / ✅ | ✅ (no globs) / ❌ | ✅ (0.4.2+) / ❌ | ✅ / ✅ | ❌ | ❌ | ❌ |
| deno.lock | ✅ read + integrity (+write) | native: only if explicit; portable: jsr versions | ❌ | ✅ | `lock` option | ❌ | required input |
| TS transpile | Deno (deno.json compilerOptions) | esbuild | esbuild | Deno | esbuild | esbuild | esbuild |
| Import attributes | passed on, loader wrong for text/bytes | ignored (dropped on re-entry) | ignored | same as @deno | forwarded | forwarded | ❌ |
| Non-JS assets / other plugins | ❌ catch-all (binary corruption) | ❌ file catch-all (fixed in KyleJune fork) | ✅ cooperative | ✅ skip-list | ✅ scoped filters | ✅ | loaderRules |
| Watch / rebuild | ⚠️ never invalidated | ✅ re-init per build (slow) | ✅ (refetch) | ⚠️ | ⚠️ memo per setup | ✅ | ? |
| Honors external / packages | ✅ / ❌ | ✅ / ❌ | ✅ / ❌ | ✅ / ❌ | – / ✅ | ❌ | – |
| Notable verified bugs | text attr, data:, sideEffects, cwd discovery | neutral platform npm, `--no-config`, Win argv, HTTP status typo | JSR config fetch, no lock | inherits @deno bugs | filter typo | pluginData overwrite | query/port ignored |
| Tests | 21 (some non-discriminating) | 45 × 4-way matrix (CI never ran Deno 2) | 4 integration files | 32 | 103 unit | 19 | examples + units |

---

## 10. Clone paths and artifacts

All under `SCRATCH=/private/tmp/claude-501/-Users-divyansh-unplugin-deno/1a551bae-bee4-41ac-ba89-ea42b9e7cb9a/scratchpad`:

- `$SCRATCH/repos/deno-esbuild-plugin`: denoland/deno-esbuild-plugin (@deno/esbuild-plugin)
- `$SCRATCH/repos/deno-js-loader`: denoland/deno-js-loader (@deno/loader; `deno` submodule not fetched)
- `$SCRATCH/repos/esbuild_deno_loader`: lucacasonato/esbuild_deno_loader (@luca)
- `$SCRATCH/repos/duesabati-esbuild-deno-plugin`: duesabati/esbuild-deno-plugin (rewrite fork)
- `$SCRATCH/repos/esbuild-plugin-deno`: oazmi/esbuild-plugin-deno
- `$SCRATCH/repos/deno-esbuild`: ggpwnkthx/deno-esbuild (plugin at `packages/plugins/deno`)
- `$SCRATCH/repos/esbuild-deno-specifier`: TomokiMiyauci/esbuild-deno-specifier (**checked out at `beta` = 1.0.0-beta.14**)
- `$SCRATCH/repos/esbuild-import-map`: TomokiMiyauci/esbuild-import-map
- `$SCRATCH/repos/esbuild-plugin-cache-deno`: Tsukina-7mochi/esbuild-plugin-cache-deno (archived)
- JSR source snapshots used for fork diffs: `$SCRATCH/jsr/luca-0.11.1`, `luca-0.10.3`, `kylejune-0.12.1`, `bureaudouble-0.10.5`, `bureaudouble-0.10.3pr004`
- esbuild changelogs: `$SCRATCH/esbuild-CHANGELOG*.md`; unplugin 3.4.0 tarball: `$SCRATCH/tarballs/unplugin-3.4.0/`
- Experiments: `$SCRATCH/exp/proj/` (`build.ts <deno|luca>`, `build_gg.ts gg`, `probe.ts` = esbuild obeys the plugin loader over `with`, `probe_luca.ts` = @luca falls back to native loading for .json)
