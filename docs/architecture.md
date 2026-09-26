# Architecture

This is the developer specification of `unplugin-deno`: what each layer does, the algorithms, the id and file
layouts, and the per-host recipes. It is written for contributors and coding agents; users read the
[README](../README.md). Rationale and evidence are in [plan.md](plan.md) and [research/](research/README.md);
the verified host recipes referenced below are in [research/feasibility.md](research/feasibility.md).

The text describes the implementation at the end of M1, verified with Deno 2.9.7, Vite 8.3.1 and 7.3.6, Rolldown
1.2.11, Rollup 4.63.5 and esbuild 0.28.2. Designs for later milestones are marked **(M2)** or **(M3)**: they are not
implemented yet. Where the implementation departs from [plan.md](plan.md), this document is authoritative;
[Appendix A](#appendix-a-deviations-from-planmd) lists the departures. Source comments cite sections
(`docs/architecture.md §5.3`), so keep the numbering stable when editing.

Conventions used here: "host" = the bundler we plug into; "engine" = the component that implements Deno's
resolution and loading semantics; "mirror" = the project-local directory where remote modules are written as files.

---

## 1. Layers and module map

```
src/
├─ index.ts                 `unplugin` (the unplugin instance), `unpluginFactory`, option and error types
├─ vite.ts … farm.ts        host entries: `export default createVitePlugin(unpluginFactory)` etc. (unplugin has no
│                           subpaths); webpack, rspack, rsbuild, bun and farm get an inert plugin until their adapters land
├─ register.ts, api.ts      `unplugin-deno/register` (E1) and `unplugin-deno/api` (E2): throw ENGINE_UNAVAILABLE (M3)
├─ vendored-deno-loader.ts  the only importer of ../vendor/deno-loader: lazy import, VERSION, log and fetch hooks
│                           (must stay at depth 1 so the relative path is the same from src/ and dist/)
├─ core/                    §5
│  ├─ plugin.ts             the UnpluginFactory: generic hooks for the Rollup family plus host hooks under unplugin's
│  │                        escape hatches; only `esbuild.setup` for esbuild; an inert plugin for other hosts
│  ├─ state.ts              PluginState: options, project, platform, engines, and a resolver and mirror per target;
│  │                        the hook implementations (resolve, load, transform, watchChange, flush, close)
│  ├─ options.ts            Options, resolveOptions (every default, §5.1), DEFAULT_ALLOW_IMPORT
│  ├─ specifier.ts          classify specifiers (§2); parse and format `npm:`/`jsr:` specifiers
│  ├─ id.ts                 id scheme: splitQuery, deno-type marker, `\0deno:` virtual ids, mirror paths, filters
│  ├─ resolve.ts            the resolveId algorithm (§5.2) → ResolveOutcome; resolveIdFilter
│  ├─ npm.ts                npm strategy: redirects and global-cache paths (§5.4)
│  ├─ mirror.ts             mirror layout, writing, rewriting, source maps, manifest, integrity, GC (§5.3)
│  ├─ attributes.ts         import-attribute pre-pass and marker modules (§5.5)
│  ├─ platform.ts           platform model, conditions, externals, patterns, pinning (§5.6)
│  ├─ entries.ts            host inputs → engine entrypoints
│  ├─ watch.ts              watch list and invalidation (§5.7)
│  └─ version.ts            the plugin version (part of the mirror generation)
├─ config/                  §3
│  ├─ discover.ts           config folder, workspace root, members (globs), links, external import maps
│  ├─ deno-config.ts        DenoConfig, JSONC parsing and normalisation (nodeModulesDir, workspace, links, exports,
│  │                        lock, JSX settings, minimumDependencyAge)
│  ├─ package-json.ts       package.json reading, dependency classification, catalogs
│  ├─ import-map.ts         the WICG algorithm with Deno's deviations and package expansion; the workspace resolver
│  ├─ version-req.ts        Deno's version requirements (ported from deno_semver)
│  ├─ lockfile.ts           deno.lock v5 reader
│  ├─ node-modules.ts       nodeModulesDir mode and node_modules layout
│  └─ project.ts            loadProject → Project; configGeneration
├─ engine/                  §4
│  ├─ types.ts              Engine, EngineFactory, EngineCreateOptions, ResolvedModule, LoadedModule, MediaType
│  ├─ create.ts             createEngine(kind, options)
│  ├─ errors.ts             EngineResolveError (missing optional npm dependencies)
│  ├─ media-type.ts         MediaType ↔ extension ↔ esbuild loader / Rolldown moduleType
│  ├─ deno-dir.ts           where DENO_DIR is
│  ├─ npm-package.ts        the npm package of a resolved file
│  ├─ package-specifier.ts  `jsr:`/`npm:`/bare specifier parsing
│  ├─ loader/               the `loader` engine: engine.ts, errors.ts (loader errors → codes), hooks.ts (log/fetch)
│  └─ deno-cli/engine.ts    the `deno` engine: a stub that throws ENGINE_UNAVAILABLE (M2)
├─ hosts/                   §6
│  ├─ shared.ts             HostContext, the host-backed logger, toRollupResult
│  ├─ rolldown/index.ts     options (root, platform, inputs, filters), resolveId/load with moduleType, closeBundle
│  ├─ rollup/index.ts       options, attributes → markers in resolveId, load, closeBundle
│  ├─ vite/                 index.ts (hooks), environment.ts, optimizer.ts, optimizer-esbuild.ts, marker.ts
│  └─ esbuild/              index.ts (the whole plugin), options.ts, external.ts, paths.ts, messages.ts, snapshot.ts
│                           (webpack/, rspack/, bun/: M2)
├─ diagnostics/
│  ├─ errors.ts             DenoPluginError { code, message, hint?, specifier?, importer?, cause? }, ERROR_CODES
│  └─ logger.ts             Logger, the console logger, DEBUG=unplugin-deno         (checks.ts: M2)
└─ utils/
   ├─ path.ts               toPath, toFileUrl, normalizeDriveLetter, isSubpath, relativeUrlPath (Windows-safe)
   ├─ url.ts                URL helpers (trailing slashes, dirname, normalisation, percent-decoding)
   ├─ fs.ts                 ensureDir, writeFileAtomic, JSON and JSONC parsing with error positions
   ├─ hash.ts               sha256 helpers
   └─ lexer.ts              import/export scanning (es-module-lexer wrapper) and attribute parsing
vendor/deno-loader/         generated by scripts/vendor-loader.ts: patched @deno/loader 0.5.0 (mod.js, rs_lib_node.js,
                            lib/rs_lib.wasm and its glue), hooks.js, LICENSE, VERSION, NOTICE.md
```

Unit tests sit next to the module they test (`*.test.ts`); `test/` holds fixtures, integration tests and helpers
(§7).

Dependency direction: `hosts → core → engine, config → utils, diagnostics`, with two exceptions: `core/plugin.ts`
composes the adapters of `hosts/`, and `core/state.ts` uses the host logger of `hosts/shared.ts`. `config` imports
only the specifier parsers of `core`; `engine` never imports `core`, `config` or `hosts` (the project arrives as an
`EngineProject`). No module imports a bundler package at runtime (`import type` only).

---

## 2. Data model

```ts
// core/specifier.ts
type SpecifierKind = 'jsr' | 'npm' | 'https' | 'http' | 'data' | 'node' | 'bun' | 'cloudflare' | 'file'
                   | 'bare' | 'relative' | 'absolute' | 'unknown-scheme'  // `virtual:x`, `\0…`, other schemes
interface ParsedSpecifier { raw: string; kind: SpecifierKind; base: string; query: string /* from the first '?' */ }

// engine/types.ts
type ResolvedKind = 'local' | 'npm' | 'remote' | 'data' | 'node' | 'external'
interface ResolvedModule {
  kind: ResolvedKind
  url: string            // file:///…, https://… (JSR resolves to https://jsr.io/…), data:…, node:fs, bun:sqlite
  path?: string          // OS path for 'local' and 'npm' (symlink-free for npm)
  mediaType: MediaType   // from the URL; 'Unknown' for remote URLs without an extension
  npm?: { name: string; version: string; subpath: string; packageDir: string; packageJsonPath: string }
  sideEffects?: boolean | null
}
interface LoadedModule { kind: 'module'; url: string /* after redirects */; mediaType: MediaType; code: string
                         bytes: Uint8Array; map?: EncodedSourceMap }
interface ExternalModule { kind: 'external'; url: string }

// core/resolve.ts: what the core hands back to a host adapter
type ResolveOutcome =
  | { type: 'path'; path: string; sideEffects?: boolean | null }           // the host loads the file itself
  | { type: 'mirror'; path: string; url: string }                          // a mirror file; the plugin loads code + map
  | { type: 'npm-redirect'; request: string; resolveDir: string; packageJsonPath: string; rawSpecifier: string
      fallbackPath: string; query: string; sideEffects?: boolean | null }  // the host resolves `request` (§5.4)
  | { type: 'marker'; path: string; denoType: 'text' | 'bytes' | 'css'; sourceUrl: string }  // synthesised (§5.5)
  | { type: 'host-marker'; request: string; denoType: 'text' | 'bytes' | 'css' }  // host resolves, adapter marks
  | { type: 'external'; id: string }                                       // kept as an import in the output
  | { type: 'virtual'; id: string }                                        // the plugin's own `\0deno:empty`
  | null                                                                   // not ours
```

Media types follow Deno's enum (`JavaScript, Jsx, Mjs, Cjs, TypeScript, Mts, Cts, Dts, Dmts, Dcts, Tsx, Css, Json,
Jsonc, Json5, Html, Markdown, Sql, Wasm, SourceMap, Unknown`). `engine/media-type.ts` also has `deno bundle`'s table
for engine output (TypeScript already transpiled): JavaScript/Mjs/Cjs/Mts → `js`; TypeScript/Cts/Dts/Dmts/Dcts → `ts`;
Jsx/Tsx → `jsx`; Css → `css`; Json → `json`; Jsonc/Json5/Markdown/Html/Sql/SourceMap → `text`; Wasm/Unknown → `binary`
(`esbuildLoaderFor`, `moduleTypeFor`). No M1 adapter needs it: mirror files and marker modules are JavaScript
(`moduleType: 'js'` where the host takes one), and raw assets are loaded by the host.

---

## 3. Config layer (`src/config/`, pure TypeScript, no wasm)

The config layer reproduces Deno 2.9's discovery and import-map behaviour without the engine (verified against Deno
2.9.7): the vendored loader lacks glob members, link globs and other 2.8/2.9 features, and the core needs the import
map before any engine exists (for hook filters, §5.2).

### 3.1 Discovery (`discover.ts`)

Input: the directory `options.cwd` (the host root unless set: Vite `root`, esbuild `absWorkingDir`, Rolldown `cwd`,
otherwise `process.cwd()`), `options.config`, and whether `package.json` files are read (not when
`DENO_NO_PACKAGE_JSON` is set).

1. `config: false` → nothing is read. The project is *disabled* (engine `noConfig`, empty import map), so bare
   specifiers are never ours.
2. Nearest config folder: walk up from the root (never inside `node_modules`). In each directory `deno.json` wins
   over `deno.jsonc`, and a `package.json` makes a directory a config folder too, so the nearest folder can be
   `package.json`-only; a parent `deno.json` without members is then ignored and `configPath` (the file handed to
   the engine: the nearest `deno.json(c)`, or the workspace root's) can be `null`. An explicit `config` path
   replaces the walk: it is treated as found in its directory only when it is the file Deno would pick there,
   otherwise it is used alone. A missing explicit file is `CONFIG_NOT_FOUND`.
3. Workspace root: the first ancestor folder that declares members (`workspace` in `deno.json`, `workspaces` in
   `package.json`) decides. If its expanded members include the nearest folder it is the workspace root; otherwise
   the nearest folder stands alone (with a warning for Deno workspaces). Globs (`tinyglobby`) match
   `<entry>/{deno.json,deno.jsonc,package.json}`; the glob characters are `*` and `?`, `!` excludes, and dot
   directories, `node_modules` and `.git` are skipped. A missing path member is skipped with a warning; a directory
   without a config, a member outside the root, the root itself, a directory listed twice and duplicate `name`s
   are `CONFIG_INVALID`. `package.json` files of the root and the members are read too.
4. `links` (Deno 2.9 stable; the deprecated `patch` is read when `links` is absent): globs, absolute paths and
   `file:` URLs are expanded, and each linked directory becomes a member-like scope whose package (jsr `name` or
   package.json `name`) overrides the registry version. A link into another workspace brings in that whole
   workspace; linking one of our own members is an error. Deno 2.8.3+ also links automatically the `deno.json`
   directory a path value of an import map points into.
5. `importMap` (an external import map file) is read as strict JSON and gets no package expansion; inline
   `imports`/`scopes` win over `importMap` (with a warning).
6. `nodeModulesDir` (`node-modules.ts`): an explicit value wins (`"auto" | "manual" | "none"`; the legacy `true` and
   `false` mean `auto` and `none`); otherwise `"manual"` when the **workspace root** has a `package.json` (a
   member's is not enough), `"auto"` for `vendor: true`, else `"none"`. The actual layout of
   `<workspace root>/node_modules` is detected too: `isolated` (Deno's `.deno/`), `pnpm` (`.pnpm/`), `hoisted` (npm,
   Yarn, Bun, Deno's hoisted linker), and whether `@jsr/` holds packages (Deno 2.9 `jsrDepsInNodeModules`).
7. The settings of §3.4 are read from the root config (JSX settings from the nearest one).

Output: `loadProject` (`project.ts`) returns `Project`: the discovery (`root`, `disabled`, `configPath`,
`workspaceRoot`, `rootFolder`, `members`, `links`, `watchFiles`, `warnings`) plus `config`, `workspaceConfig`,
`nodeModules` (mode and layout), `lockfilePath`, `lockfile`, `unsupportedLockfile`, `lockfileFrozen`, `jsx`,
`unstable`, `vendor`, `jsrDepsInNodeModules`, `minimumDependencyAge` and `importMap` (the resolver of §3.2).
`watchFiles` = every config, external import map and `package.json` read, plus the lockfile. Parsing uses
`jsonc-parser`; errors become `DenoPluginError('CONFIG_INVALID')` with `file:line:column`. `configGeneration(project)`
hashes the contents of the watch files, the input of the mirror generation (§5.3).

### 3.2 Import maps (`import-map.ts`)

Deno semantics = WICG import maps + Deno extensions. The WICG algorithm runs the web-platform-tests data
(`test/data/wpt-import-maps`) and cases adapted from `denoland/import_map` (`test/data/deno-import-map`); see their
`SOURCE.md`.

- Keys are normalised specifiers; a key ending in `/` maps prefixes. Values are resolved against the config file URL.
  After a matched prefix Deno percent-decodes the rest and appends it segment by segment (dropping `.`/`..`), so an
  opaque target such as `jsr:@s/p@1/` cannot take subpaths (`jsr:/@s/p@1/` can); URLs keep `^` unencoded like Deno.
- **Package expansion** (inline `imports`/`scopes` of a `deno.json` only): an entry `"@std/path": "jsr:@std/path@^1"`
  (a `jsr:`/`npm:` value without a trailing slash) also maps `@std/path/<subpath>` → `jsr:@std/path@^1/<subpath>`.
- `scopes`: keys are URL prefixes resolved against the config; the referrer picks the most specific matching scope,
  falling back to less specific ones, then to the top-level `imports`.
- **Workspace members and links**: the `imports` of each member and link become a scope for its directory (their
  `scopes` are ignored, with a warning); root `imports` stay visible. Member and link `exports` (jsr `name` +
  `exports`) make `@scope/name` and `@scope/name/<sub>` resolve to their files, and `jsr:` specifiers naming a member
  or link resolve to its files when its `version` satisfies the range (`version-req.ts`). npm workspace members
  (package.json `name`) map to their directory with the subpath; the caller applies Node rules.
- `package.json` dependencies (Deno's BYONM, `catalog:` entries included) also make bare names resolvable: a bare name
  that is a dependency and not in the import map is **not ours** (the host resolves it from `node_modules`), but it is
  recorded so `platform: 'deno'` can pin it as `npm:name@<version>` (§5.6).

API: `createImportMapResolver(project) → { resolve(specifier, referrerUrl?): ImportMapMatch | null; ownedKeys();
map; warnings }` with `ImportMapMatch = { mapped, kind: 'import-map' | 'workspace-member' | 'link' |
'package-json-dependency', scope?, key, configPath, packageName?, subpath? }`. `mapped` is an absolute URL or a
`jsr:`/`npm:` specifier (`jsr:/`/`npm:/` normalised to `jsr:`/`npm:`). `ownedKeys()` (keys without a trailing `/`,
member and link package names) feeds the `resolveId` filter (§5.2). Errors: `IMPORT_MAP_INVALID` for invalid entries
and backtracking subpaths, `RESOLVE_NOT_EXPORTED` for a missing member export.

### 3.3 Lockfile (`lockfile.ts`)

Reads `deno.lock` version 5: `specifiers` (normalised requirements: `jsr:@std/path@^1` is stored as
`jsr:@std/path@1` → `1.1.6`), `jsr`/`npm` entries (`integrity`, `dependencies`), `remote` (URL → sha256),
`redirects`, and `workspace` (root and member `dependencies`, `packageJson`). Provides `pin(specifier)` (the pinned
specifier with its subpath: `jsr:@std/path@^1/join` → `jsr:@std/path@1.1.6/join`), `has(specifier | url)`,
`hasPackage(kind, name, version)`, `remoteIntegrity(url)` (following `redirects`) and `npmDependencies(nameVersion)`.
Used for `platform: 'deno'` pinning (§5.6) and mirror integrity (§5.3); `lockfile: 'frozen'` drift detection is M2.
An unreadable or invalid file is `LOCKFILE_INVALID`; other versions are reported as unsupported (§3.4).

### 3.4 Settings (`deno-config.ts`, `package-json.ts`, `project.ts`)

- Lockfile: the root `deno.json`'s `lock` (`false`, a path, or `{ path, frozen }`; default `deno.lock` next to it),
  or `deno.lock` next to a root `package.json` when there is no `deno.json`; none for `lockfile: 'off'`. A lockfile
  whose version is not 5 is ignored with a warning ("run `deno install` to upgrade it"). The engine gets the path
  only for an existing version 5 lockfile (`noLock` otherwise, §4.2). `lock.frozen` is read (`lockfileFrozen`) but
  not acted on yet (M2).
- `minimumDependencyAge` (root config; Deno 2.5.5+): minutes (a number or digits), an RFC 3339 date-time, a
  `YYYY-MM-DD` date or an ISO-8601 duration without years or months (`P2D`, `PT12H`); `0`, `"0"` and `false` disable
  it; the object form adds `exclude`. Unset means Deno 2.9's default of 24 h. The result is the
  `newestDependencyDate` handed to the engine (§4.2).
- JSX: `compilerOptions` `jsx`, `jsxImportSource`, `jsxImportSourceTypes`, `jsxFactory`, `jsxFragmentFactory`,
  `jsxPrecompileSkipElements` of the nearest config merged over the root's, with Deno's defaults. Read but not
  applied to local files yet (the `jsx` option is M2; remote modules are transpiled by the engine, §5.1).
- `unstable` (e.g. `raw-imports`, which matters to the loader's graph, §5.5), `vendor`, `jsrDepsInNodeModules` (in
  effect only with a `node_modules` directory mode; the npm route through `@jsr/` is M2, §5.4).
- Root-only fields in a member config (`links`, `lock`, `nodeModulesDir`, …) produce Deno's warnings.

---

## 4. Engine (`src/engine/`)

### 4.1 Interface

```ts
interface Engine extends AsyncDisposable {
  readonly kind: 'loader' | 'deno'
  addEntrypoints(entrypoints: readonly string[]): Promise<EngineDiagnostic[]>  // seeds the graph; never throws for it
  resolve(specifier: string, referrer: string | undefined, mode: 'import' | 'require'): Promise<ResolvedModule>
  resolveSync?(specifier, referrer, mode): ResolvedModule | undefined          // undefined: needs the async path
  load(url: string, type: 'default' | 'json' | 'text' | 'bytes'): Promise<LoadedModule | ExternalModule>
  graph(): unknown                                                            // for diagnostics; shape unstable
  dispose(): Promise<void>                                                    // waits for pending work; idempotent
}
interface EngineFactory { readonly kind: 'loader' | 'deno'; create(options: EngineCreateOptions): Promise<Engine> }
interface EngineCreateOptions {
  project: { root: string; workspaceRoot: string; configPath?: string; lockfilePath?: string
             nodeModulesDir: 'auto' | 'manual' | 'none' }                     // EngineProject
  platform: 'browser' | 'node'; conditions: string[]; cachedOnly: boolean
  newestDependencyDate?: Date; logger: Logger; fetch?: typeof fetch
}
interface EngineDiagnostic { message: string; code?: ErrorCode }
```

Entrypoints are `file:` URLs, absolute or root-relative paths, remote URLs or `jsr:`/`npm:`/mapped specifiers
(`core/entries.ts` normalises host inputs; virtual ids and `node:` are skipped). `resolve` throws `RESOLVE_*` or
`CACHED_ONLY_MISS`; a missing optional dependency of an npm package is an `EngineResolveError` with
`isOptionalDependency` (the core keeps it external, §5.2). `load` throws `RESOLVE_FAILED` for unresolved `jsr:`/`npm:`
specifiers and load failures.

`PluginState` creates engines lazily and keys them by (purpose, engine platform, conditions): purpose `main` for
resolution and code, and `raw` for raw loads the main engine refuses (§5.5). They are disposed at the end of a build
and recreated on config or lockfile change (§5.7). `engine/contract.test.ts` runs the same `test/fixtures/engine-*`
fixtures against every engine factory (only `loader` until M2).

### 4.2 `loader` engine (vendored `@deno/loader` 0.5.0)

Facts that drive the implementation (verified; see research/feasibility.md §7 and multi-and-deno-tooling.md §1):

- Construction: `new Workspace({ configPath | noConfig, noLock, platform, nodeConditions, cachedOnly,
  newestDependencyDate, preserveJsx: false, noTranspile: false })`, then `await workspace.createLoader()`. **Always
  pass `configPath`** (discovery would otherwise start at `process.cwd()`); a project without a config gets
  `noConfig: true`, and `noLock` is set when no lockfile is in use (§3.4). `platform` is `'node' | 'browser'` (the
  `deno` platform uses `node`). There is no `cwd`, `nodeModulesDir`, `vendor`, `lockfile` or `frozen` option: those
  come from `deno.json` or are plugin logic. The wasm deserialises `newestDependencyDate` only as an RFC 3339 string
  (a `Date` fails, although `mod.d.ts` types it `Date`), so `toWasmWorkspaceOptions` converts it. A configuration the
  loader rejects becomes `CONFIG_INVALID`.
- `addEntrypoints(entries)` walks the static graph (`follow_dynamic: false`) and **returns** diagnostics instead of
  throwing (§5.8 decides warn or debug). It rejects the whole batch when an entrypoint itself cannot be resolved (an
  unmapped bare specifier), so the engine retries one by one. Relative entrypoints and an `undefined` referrer
  resolve against `process.cwd()`, and referrers other than `file:`/`http(s):` URLs (e.g. `data:`) are read as file
  paths: the engine passes the project root instead (and rejects relative specifiers from such referrers). It never
  runs lifecycle scripts. npm downloads and installs: §4.4.
- `resolveSync(spec, referrer, mode)` is correct for specifiers already in the graph. Outside the graph it returns
  `jsr:` specifiers unchanged and throws for `npm:`; `resolve()` tries it first and falls back to
  `await loader.resolve(...)` (which mutates the graph and may download) when the result still has a `jsr:`/`npm:`
  scheme or the call throws without a `code`, and in the npm cases of §4.4.
- `await loader.resolve()` **does not throw** for an unresolvable `jsr:` requirement (no matching version, unknown
  package or export): it returns the requirement unchanged and records the reason in the graph, which
  `addEntrypoints([requirement])` returns as a diagnostic; the engine turns it into the error. `npm:` failures throw
  "Could not find constraint …" without a code.
- `load(url, RequestedModuleType)` requires a **resolved** URL (`https:`/`file:`/`data:`); `load('jsr:…')` and
  `load('npm:…')` throw; `node:` and other schemes return `{ kind: 'external' }`. The code (a `Uint8Array`) is
  transpiled JavaScript even when `mediaType` says TypeScript and still ends with an inline
  `//# sourceMappingURL=data:…` comment, which is stripped; `sourceMap` (`sources: [url]`, `sourcesContent`) is the
  map. `LoadedModule.bytes` keeps the raw bytes (for `bytes` and Wasm).
- Errors are `ResolveError { specifier?, code?, isOptionalDependency? }`; `code` is set only for Node-resolution
  failures (`ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`). Graph and import-map failures have no code:
  `loader/errors.ts` classifies them by error class and specifier kind into `RESOLVE_NOT_FOUND`,
  `RESOLVE_NOT_EXPORTED`, `RESOLVE_UNMAPPED_BARE`, `RESOLVE_CONSTRAINT` and `RESOLVE_FAILED`, never by message text
  (only a *hint* may be picked from the message). A `jsr:` subpath failure cannot be told from a constraint failure
  without the message, so it is `RESOLVE_FAILED`.
- `cachedOnly`: the loader itself blocks only npm downloads (`NpmCacheSetting::Only`); remote `https:`/`jsr:` modules
  are still fetched (the HTTP client's `cached_only` is never set). The engine enforces it: while a `cachedOnly`
  engine owns the fetch hook every download is refused (`AbortError`, no retries) and the failures become
  `CACHED_ONLY_MISS`.
- Logging and fetch: the glue calls `console.error('Downloading', url)` and prints Rust log lines and panics. The
  vendored copy is patched (`scripts/vendor-loader.ts`) to report these to `hooks.js` (`setLogger`, `setFetch`,
  reached through `vendored-deno-loader.ts`), and to download through an injectable fetch (default `globalThis.fetch`
  at call time) with 3 jittered retries on network errors, HTTP 429 and 5xx (upstream has none). The wasm module is
  instantiated once per process, so `loader/hooks.ts` routes the hooks to one live engine: the most recently created
  one with an operation in flight, else the most recently created one. With identical options per engine (the
  plugin's case) this only decides which logger prints a line.
- Wasm loading: the Node.js code path (`readFileSync` + synchronous `WebAssembly.Module/Instance`) on Node, Deno and
  Bun alike (verified). The wasm is read relative to the glue (`lib/rs_lib.wasm`), so `vendor/` ships as files next to
  `dist/` (tsdown keeps `../vendor/…` imports external). Cold cost ≈ 85 ms, warm ≈ 15 ms; `Workspace + createLoader`
  ≈ 25 ms, so recreating engines on config change is cheap.
- Local files are **never** loaded through the engine (its file cache goes stale on edits); the host loads them.
- The loader returns canonical paths. Files in `node_modules/.deno` are hard links into `DENO_DIR/npm`, and Bun's
  `realpathSync.native` on macOS may answer with the other link, so the engine realpaths directories and symlinks only.
- `DENO_DIR` (`deno-dir.ts`, computed like the wasm build): `$DENO_DIR`; else `$XDG_CACHE_HOME/deno` on **every**
  platform; else the OS cache directory + `deno` (`$HOME/Library/Caches` on macOS, `%USERPROFILE%\AppData\Local` on
  Windows, `$HOME/.cache` elsewhere). The core uses it to recognise files of the global npm cache.
- Minimum dependency age: `newestDependencyDate = now − minimumDependencyAge` (§3.4), so resolutions without a
  lockfile match `deno install`.

### 4.3 `deno` engine (M2)

Not implemented: `engine: 'deno'` selects `deno-cli/engine.ts`, which throws `ENGINE_UNAVAILABLE`, and `engine: 'auto'`
always uses the loader. The design: use the installed Deno through one `deno info --json --config <configPath>
<entries…>` at `addEntrypoints` (entries passed via a temp file on Windows to avoid argv limits), parsed against a
schema (`modules[*].{specifier,local,mediaType,dependencies}`, `npmPackages[*].{name,version,localPath}` (2.8.3+),
`redirects`, `packages`); later unknown specifiers resolved in bounded batches. Remote files are read from
`modules[*].local` in `DENO_DIR/remote/…` with the trailing `// denoCacheMetadata=…` line stripped, then transpiled
(`deno transpile` per batch or the loader's emit; decided in M2). Selected by `engine: 'deno'` (with `denoBinary`), or
by `engine: 'auto'` when the config uses features the vendored loader lacks (`catalog:`, `jsrDepsInNodeModules`;
glob members handled by our config layer are fine) and `deno` is on `PATH`.

### 4.4 npm packages and the lockfile in the `loader` engine

- The loader downloads npm packages into `DENO_DIR/npm` (`nodeModulesDir: "none"`) or installs them into
  `node_modules/.deno` (`"auto"`) while it adds modules to its graph, and its first installation covers every package
  of the lockfile. With `"manual"` it never installs: the project's `node_modules` is used as it is, and an `npm:`
  requirement it cannot resolve is `RESOLVE_NOT_FOUND` with a hint to install it.
- The loader's Node.js resolution cache (file types and canonical paths, per wasm instance) also records misses and is
  emptied only when a `Loader` is freed. Looking up a file of a package the lockfile names but that is not installed
  yet (`resolveSync` throws `ERR_MODULE_NOT_FOUND` then) leaves a miss that outlives the installation, on every engine
  of the process.
- So until an engine has installed npm packages once, `resolve()` adds an `npm:` requirement to the graph before any
  of its files is looked up, and `resolveSync` leaves such requirements to it (concurrent additions of one requirement
  are shared; a failed one is tried again by the next resolution). Afterwards the synchronous path answers: lockfile
  packages are installed, and other requirements fail it before any file is read (the asynchronous path installs
  them). A "not found" answer that may come from the cache (a bare specifier mapped to a package not installed yet, a
  package the user installed meanwhile) is retried once after emptying the cache (a throwaway `Loader` is created and
  freed). `jsr:` requirements need none of this: the synchronous path returns them unchanged until the asynchronous
  one has added them to the graph.
- Installation therefore needs no seeding by the host: the Vite dev server, whose inputs are HTML files and which
  meets modules one request at a time, installs packages as it resolves them.
- The engine receives the lockfile path only for an existing version 5 lockfile (§3.4) and never creates one.

---

## 5. Core plugin (`src/core/`)

### 5.1 Options, host context and state

`resolveOptions(user, context)` (`core/options.ts`) validates the options (`OPTIONS_INVALID` for wrong types) and
applies every default in one place. It runs when the plugin is created (to fail early) and again against the host
root once the host reports it. Hooks read only the resolved object.

| Option | Default | Status |
|---|---|---|
| `cwd` | host root (Vite `root`, esbuild `absWorkingDir`, Rolldown `cwd`, otherwise `process.cwd()`) | |
| `config` | discovered (§3.1); a path is relative to `cwd`; `false` disables discovery | |
| `cacheDir` | `<workspaceRoot>/node_modules/.unplugin-deno` (like Vite's `node_modules/.vite`); relative to `cwd` | |
| `engine` | `'auto'` → `loader` | `'deno'`: M2 (throws `ENGINE_UNAVAILABLE`) |
| `denoBinary` | `'deno'` | M2 |
| `platform` | `'auto'` (§5.6); a string, or a record of Vite environment names | |
| `conditions` | `[]` (added to the platform's conditions) | |
| `npm` | `'auto'` → `deno-cache` when `nodeModulesDir` is `none`, else `node_modules` (§5.4) | |
| `lockfile` | `'auto'`; `'off'` ignores `deno.lock` | `'frozen'`: M2 (acts like `'auto'`), also the planned default when `CI` is set |
| `cachedOnly` | `false` (§4.2) | |
| `allowImport` | `DEFAULT_ALLOW_IMPORT`: Deno's `--allow-import` hosts (`deno.land`, `jsr.io`, `esm.sh`, `cdn.jsdelivr.net`, `raw.githubusercontent.com`, `gist.githubusercontent.com`); a value replaces the list | M2: not enforced yet (`DISALLOWED_HOST`, plus hosts in the lockfile) |
| `exclude` | `[]`: patterns (§5.6 syntax) matched against the specifier, left to the host | |
| `importers` | `{ include: [], exclude: [] }`: RegExps or path prefixes (relative ones against `cwd`); an empty `include` admits every importer | |
| `external` / `bundle` | `[]` (§5.6) | |
| `pinExternals` | `null` → `true` for the `deno` platform, else `false` (`pinExternalsFor`); esbuild's `packages: 'external'` also defaults it to `true` | |
| `emitDenoConfig` | `false` | M2 (S3) |
| `importAttributes` | `true` | |
| `importMetaMain` | `true` | M2 (L7) |
| `env` | `false` | M2 (L9) |
| `denoGlobals` | `null` → `'warn'` for the browser platform, else `'off'` (`denoGlobalsFor`) | M2 (L10) |
| `jsx` | `'auto'`: the host transpiles local files, the engine remote ones | `'host'`/`'deno'`: M2 (L5) |
| `checks` | all `true` | M2 (X3–X5) |
| `debug` | `true` when `DEBUG` matches `unplugin-deno` (`debug` package conventions) | |
| `resolve` | `undefined`; a hook `(specifier, importer, { host, platform }) → string \| false \| null \| undefined` (§5.2) | |

`HostContext` (`hosts/shared.ts`): `{ framework, root, command: 'build' | 'serve', platformHint?, conditionsHint?,
logger, version? }`. Everything host-specific the core needs arrives through this object or through the outcome types;
the core never imports a host package.

`PluginState` (`core/state.ts`) is the per-instance build state. Adapters feed host facts through `setHints` (root,
platform, conditions, inputs, version, command) and the logging context through `setLogTarget` (in every hook).
`prepare()` loads the project once, until it is invalidated, and `configure(project)` derives the platform,
conditions, npm strategy, `cacheDir`, mirror generation, mirror and `resolveId` filter, collects old mirror generations
and logs the debug summary (§5.8). Hosts that build several platforms at once (Vite environments) resolve with a
`ResolveTarget` (`{ platform, conditions?, bundle? }`): the state keeps a resolver and an engine per target, and a
mirror per generation, shared by targets with equal platform and conditions.

### 5.2 `resolveId` algorithm

Filter: `resolveIdFilter(project, options, platform)` (`core/resolve.ts`) is a RegExp of the owned schemes
(`^(?:jsr|npm|https?|data|node|bun|cloudflare|file):`), the deno-type marker (`[?&]deno-type=`), the escaped
import-map keys and workspace package names (`^(?:@std/path|react)(?:[/?]|$)`), and the `package.json` dependency
names on the Deno platform (they are pinned externals). With the `deno-cache` npm strategy it has every bare specifier
(`^[^./\0]`) instead, because imports inside global-cache npm files must reach the engine. The import-map keys are
known only once the project is loaded, so hosts that fix filters before that use `BROAD_RESOLVE_ID_FILTER` (owned
schemes, the marker and every bare specifier); §5.9 says which filter each host gets.

Handler (`resolveOwned`):

```
resolveOwned(rawId, importer, { kind, isEntry, target }):
  '\0deno:empty' → { type: 'virtual' };  other '\0' and 'virtual:' ids → null
  rawId matches `exclude`, or importer fails the `importers` filter → null
  { base, denoType } = readDenoType(rawId)                     // the ?deno-type= marker, if any
  options.resolve?(base, importer, { host, platform }): false → null; a string replaces base
  context  = importer: none | virtual | url | mirror file | npm-engine (global cache, or node_modules with
             `deno-cache`) | npm-host (node_modules with the `node_modules` strategy) | local
  referrer = mirror file → its source URL (manifest); file → file URL; url → itself; otherwise undefined
  mode     = kind === 'require-call' ? 'require' : 'import'
  query    = kept on the result ('?raw', '?worker&url'), except for https:/http: URLs, where it is part of the resource

  // 1. bare specifiers: the import map is authoritative for its keys, except inside npm packages (Node rules there)
  bare, npm-engine importer → engine.resolve                   // imports of global-cache packages
  bare, npm-host importer   → the host's (host-marker when marked)
  bare → importMap.resolve(base, referrer):
     no match                        → the host's (host-marker when marked)
     package.json dependency         → the host's, except on the Deno platform: external, pinned (§5.6)
     npm workspace member (by name)  → engine.resolve
     otherwise                       → base = mapped (URL, jsr:, npm:, member file); the bare name is kept as a spelling
  relative / absolute:
     from a mirror file   → the rewritten relative path, resolved against the mirror file (path, or marker); a
                            missing file → engine.resolve with the source URL as referrer
     from an npm-engine file → engine.resolve
     otherwise            → the host's (host-marker when marked)
  file: → path;  remaining bare or unknown scheme → null

  // 2. externals policy, before the engine (§5.6)
  node: on the browser platform → null (the host's)
  isExternal(spec, bundle/external, platform, spellings) → external (engine-resolved and pinned when pinExternals)

  // 3. engine
  resolved = engine.resolve(base, referrer, mode)   // missing optional npm dependency → external (fails at runtime,
                                                    // as in Deno)
  local → path (marker when marked)
  npm   → marker when marked; else the npm strategy (§5.4): npm-redirect | path
  remote | data → ensureMirrored(url, marked ? 'asset' : 'module') → mirror (marker when marked)
  node | external → external
```

Never throw for ids we do not own; when the engine fails for an owned id, throw a `DenoPluginError` with a hint and
the importer (hosts show it at the import). A marker whose target is a remote or `data:` URL falls back to the URL
itself when the engine refuses it (§5.5). All string handling of ids goes through `core/id.ts`.

### 5.3 Mirror (`core/mirror.ts`)

Remote (`https:`/`http:`, JSR-resolved) and `data:` modules are materialised as files under `cacheDir` so every host
loads them like ordinary files (Vite prebundles them because the path contains `node_modules`; webpack/Rspack will
need no virtual modules; source maps and output paths are readable; the M3 `register` hook can import them).

Layout: `<cacheDir>/<generation>/<scheme>/<host>/<url path>` where

- `generation` = the first 8 hex of sha256(config generation + plugin version + platform + conditions); the config
  generation hashes the watched files (configs, import maps, package.json files, lockfile). Changing the import map
  or the lockfile changes rewritten specifiers, so it changes the generation. `collectGarbage` (at every project
  load) keeps the current generation and the most recently used other one. A Vite app uses one generation per
  platform (client and server), so concurrent processes building other platforms can remove a generation another
  process still reads (M2: collect by age instead).
- `<url path>` keeps the URL's path segments. Each segment is made safe for Windows: `<>:"|?*`, `\` and control
  characters, and trailing dots and spaces, are percent-encoded; device names (`con`, `nul.js`) get their first
  character encoded; an empty segment (`a//b`, a trailing `/`) is `~e`; a segment longer than 200 characters is
  shortened to 150 + `~h<8 hex>` (extension kept). A query is replaced by `~q<8 hex of sha256("?query")>` before
  the extension.
- Code gets `.js` appended unless its name ends in `.js`/`.mjs`/`.cjs` (`mod.ts → mod.ts.js`, `x.tsx → x.tsx.js`,
  `esm.sh/react → react.js`, `util.mjs → util.mjs`). Assets (targets of `json`/`text`/`bytes`/`css` imports) and
  modules whose media type is not code (Wasm, JSON) are written raw under their own name; a raw copy whose name ends
  in `.js`/`.mjs`/`.cjs` gets `~raw` before the extension so it cannot collide with the code file of the same URL.
  `data:` URLs live under `<generation>/data/<16 hex of sha256(url)><media-type extension>` (plus the code rule).
  Files are named by the final URL after redirects; the manifest records the redirects.
- Each code file has a sibling `.map` (`sources: [url]`, `sourcesContent`) and a `//# sourceMappingURL=<name>.map`
  comment. `load` of a mirror path returns `{ code, map }` with the comment removed, so the map applies on hosts that
  do not read linked maps; esbuild loads mirror files itself and reads the linked map.
- `<generation>/manifest.json`: `{ version: 1, generation, modules: {url → entry}, assets: {url → entry}, redirects }`
  with entries `{ file, mediaType, integrity, deps, assets }`. It is a cache (rebuilt when missing or invalid), merged
  with the file on disk when flushed (at `buildEnd`/`closeBundle`, esbuild `onEnd`), so concurrent processes only
  lose cache entries, never files. Reverse lookups (`urlForMirrorPath`) read the manifest of the path's generation.
  All writes are atomic (temp file + rename).

Writing a module (`ensureMirrored(url, kind)`, `kind: 'module' | 'asset'`):

1. `loaded = await engine.load(url, 'default')` (assets and non-code modules: `'bytes'`); strip the inline source map
   comment.
2. Scan the code with `es-module-lexer` 3 (static imports, re-exports and string-literal dynamic imports; attribute
   clauses parsed by `utils/lexer.ts`). For each specifier `s`:
   - `target = await engine.resolve(s, url, 'import')` (the engine knows the package's own import map and exports);
   - remote/data → `ensureMirrored(target.url)` and rewrite `s` to the **relative path** between the two mirror files
     (`./join.ts.js`, `../fmt/colors.ts.js`), a path with `/` separators and never a URL reference (a `%` in a
     sanitised name stays literal), so hosts resolve it natively;
   - a local target (a JSR package linked into the workspace) → the relative path of the local file;
   - npm → the pinned form `npm:<name>@<version><subpath>` (no absolute paths in the mirror), resolved again by
     `resolveId` when the host imports it;
   - node builtin → `node:<name>`; external (`bun:`, `cloudflare:`) unchanged;
   - `with { type: "text" | "bytes" | "css" }` → `?deno-type=<type>` appended to the rewritten specifier and the clause
     dropped (§5.5); `type: "json"` keeps the clause and points at the raw copy;
   - a dynamic import the engine cannot resolve is left unchanged (it fails at runtime, as in Deno); a static one
     fails the build; non-literal dynamic imports are left untouched.
   Rewrites use `magic-string`; the final map is `remapping(ourMap, loaderMap)` (`@jridgewell/remapping`).
3. Write file and map atomically and record `integrity` = sha256 of the original source (`sourcesContent[0]` of the
   loader's map for transpiled modules, the bytes otherwise), which equals the `deno.lock` `remote` hash: a mismatch
   is `INTEGRITY_MISMATCH`. Deno locks `json` imports but not `text`/`bytes`/`css` ones, so only those are checked.

`resolveId` returns only after the whole dependency closure is written (hosts resolve the relative paths natively);
cycles are fine because writing a module only *loads* its dependencies to compute their paths. Mirror files are
immutable within a generation: files and manifest entries of the current generation are reused without loading
anything. If the mirror directory is not writable, fail with `MIRROR_WRITE_FAILED` and a `cacheDir` hint.

### 5.4 npm strategy (`core/npm.ts`)

The engine resolves `npm:` specifiers (and import-map-mapped bare names) to a real file with its package (`name`,
`version`, `subpath`, `packageDir`, `packageJsonPath`) and `sideEffects`:
`…/node_modules/.deno/<pkg>@<ver>/node_modules/<pkg>/…` (`nodeModulesDir: "auto"`, isolated),
`…/node_modules/<pkg>/…` (`"manual"`: hoisted or pnpm) or `$DENO_DIR/npm/registry.npmjs.org/<pkg>/<ver>/…`
(`"none"`).

`npm: 'auto'` follows `nodeModulesDir`, not whether a layout exists: `none` → `deno-cache`, `auto`/`manual` →
`node_modules`. With `none` the loader uses `DENO_DIR` even when a `node_modules` directory exists.

- **Redirect** (`node_modules` strategy, the file is under a `node_modules` directory and not in the global cache, and
  the specifier names the package, so `name + subpath` resolves from the package directory): `{ type: 'npm-redirect',
  request: name + subpath, resolveDir: packageDir, packageJsonPath, rawSpecifier, fallbackPath, query, sideEffects }`.
  Adapters turn it into their native resolution so the host applies `exports` conditions, the `browser` field,
  `sideEffects` and CommonJS interop:
  - Rollup / Rolldown / Vite: `this.resolve(request, packageJsonPath, { skipSelf: true, kind })` (resolving from the
    package's own `package.json` finds the package itself in every layout); `moduleSideEffects` is forwarded; on
    `null` (Rollup without a node-resolve plugin) `fallbackPath`.
  - esbuild: `build.resolve(request, { kind, resolveDir: packageDir, importer: packageJsonPath, … })` (§6.4).
  - webpack / Rspack (M2): set `resolveData.request = request; resolveData.context = packageDir`.
  - Vite dev server: prebundled, keyed on the specifier as written (§6.1).
- Other npm files (global cache, or a file inside a package that the specifier does not name) are `{ type: 'path' }`.
  Global-cache paths carry `moduleSideEffects: false` for `"sideEffects": false` packages, so tree-shaking matches the
  redirect route (lodash-es `chunk`: under 20 KB either way). Imports inside those files come back to `resolveId`
  (the bare filter is active) and are resolved through the engine with the file's URL as referrer.
- `jsrDepsInNodeModules` layout (`node_modules/@jsr/<scope>__<name>`, M2, R11): detected (§3.1) but not used; `jsr:`
  specifiers always go through the mirror. Planned: when present, `jsr:` specifiers take the redirect route
  (`@jsr/scope__name/<sub>`), never mixing both routes in one build.

### 5.5 Import attributes (`core/attributes.ts`)

Deno's `with { type: "text" | "bytes" | "css" }` imports are represented as an id marker: `<file>?deno-type=<type>`.
`json` is left to the host (it handles JSON natively; marking it would create a second instance).

- Where the marker comes from (§5.9 has the host facts): esbuild passes `args.with` for every import, so the adapter
  adds the marker before resolving and the pre-pass is off (`PluginState.nativeAttributes`). Rolldown and Vite pass no
  attributes to `resolveId` and deduplicate `text`/`bytes` imports of one id, and Rollup reuses one resolution per
  specifier and module, so on the Rollup family a `transform` pre-pass with filter `{ id: { exclude: [/^\0/] }, code:
  /\bwith\s*\{/ }` rewrites static `import … from 'x' with { type: 't' }` and dynamic `import('x', { with: { type:
  't' } })` to `'x?deno-type=t'` and drops the clause (verified: the query reaches `resolveId` intact and stays a
  separate module). Rollup's `resolveId` also turns `attributes.type` into the marker, for code the pre-pass cannot
  read. The pre-pass skips virtual ids, other plugins' ids and mirror files; mirrored code is rewritten while
  mirroring (§5.3). webpack/Rspack `resolveData.attributes` (M2).
- Parsing: es-module-lexer 3's full build (named fields; `attributesStart` points at the `{`); it drops a clause
  with a trailing comma (`with { type: "text", }`), which `utils/lexer.ts` finds itself. JSX and TSX are not lexable:
  the pre-pass then uses the host parser (`this.parse`, oxc with `lang` from the extension).
- Outcomes: `marker` when the plugin resolves the target (mirror file of the raw asset, local file, npm file) and
  `host-marker` for imports the host resolves (local relative paths, unmapped bare names): the adapter resolves
  `request` with the host (`this.resolve(…, { skipSelf: true })`, `build.resolve`) and adds the marker.
- `load` of a marker id reads the target (local path or mirror file) and synthesises `moduleType: 'js'` code: `text`
  → `export default <JSON string>`; `bytes` → `export default new Uint8Array([…])` up to 1 KiB, base64-decoded with
  `atob` at runtime above; `css` → `const sheet = new CSSStyleSheet(); sheet.replaceSync(<JSON string>); export
  default sheet` (Deno 2.9). `text` and `css` targets must be UTF-8 (`UNSUPPORTED_MEDIA_TYPE`).
- Loader facts: the loader's graph records `css` attributes (and `text`/`bytes` without `"unstable": ["raw-imports"]`)
  as errors, after which `resolve` and even `load(url, 'bytes')` of that URL fail on that loader. Attribute targets
  that are relative or absolute URLs therefore resolve by URL arithmetic, and raw loads the main engine refuses go to
  a second, never-seeded engine (`PluginState.engine('raw')`).
- Host ids: Vite resolves markers to `\0deno:<type>:<file>.js` (§6.1), esbuild to its `unplugin-deno` namespace
  (§6.4).

### 5.6 Platform model and externals (`core/platform.ts`)

`platform` is derived from **project shape and explicit options**, never from whether the build process runs on Deno
(Deno Deploy runs every build under Deno). `derivePlatform`: the `platform` option when it names a platform (or its
record entry for a Vite environment); else the host hint when it is `browser` or `deno`; else `deno` when the project
has a `deno.json(c)`, `node` otherwise.

| Host signal | Platform |
|---|---|
| Vite client environments (`consumer === 'client'`) | `browser`, unless a `platform` record names the environment |
| Vite server environments | the `platform` record entry, else a `platform` string, else `deno` with a `deno.json`, else `node` |
| esbuild `platform` | `browser`, also when unset (esbuild's default); `node`/`neutral` → `deno` with a `deno.json`, else `node` |
| Rolldown `platform` | as esbuild; unset counts as `browser` (Rolldown's default for ES output) |
| Rollup (no platform) | `deno` with a `deno.json`, else `node`: browser or Node builds with Rollup set `platform` |
| webpack `compiler.platform` / Rspack `target` (M2) | mapped directly |

Per platform: the engine platform (`browser` → `'browser'`, others → `'node'`); extra conditions (`deno` → `['deno']`,
then the host's conditions and `conditions`); `node:` external except on the browser platform, where it is left to the
host (Vite keeps builtins itself in every environment, §6.1; browser-safety warnings are M2); `bun:`/`cloudflare:`
always external; `neutral` behaves like `node`. The plugin's empty module (`\0deno:empty`) is reserved for `browser:
false` package mappings; nothing produces it yet.

Externals on the `deno` platform (server output for `deno run`/`deno serve`/Deno Deploy): `npm:` and `jsr:` specifiers
(and import-map-mapped bare names, and `package.json` dependencies) are kept external and **pinned** to the version the
engine resolved (`pinSpecifier`: the npm package's version, the version segment of a `https://jsr.io/@scope/name/
<version>/…` URL, else the lockfile's pin): `react` → `npm:react@19.2.0`, `npm:kleur@^4/colors` →
`npm:kleur@4.1.5/colors`, `jsr:@std/path@^1/join` → `jsr:@std/path@1.1.6/join`. The output needs no import map and runs
under `deno run --cached-only` once its externals are cached (tested for every host). `bundle` patterns force
bundling; `external` patterns force externalising on any platform (`https:` is bundled by default). `pinExternals:
false` keeps the *mapped* specifier (`kleur` → `npm:kleur@^4`). A missing optional npm dependency becomes an external
(it fails at runtime, as in Deno). On hosts where unplugin drops `external: true` (webpack/Rspack, M2) the adapter will
inject native externals.

Patterns (`exclude`, `external`, `bundle`) follow `deno bundle`: a RegExp is tested against each spelling of the
import; a string with `*` is a wildcard (`npm:*`, `jsr:@std/*`, `https://esm.sh/*`); any other string matches exactly
or as a package prefix (`npm:kleur` matches `npm:kleur/colors`). `npm:`/`jsr:` specifiers are also tried without their
version (`npm:kleur@^4/colors` as `npm:kleur/colors`), and a mapped bare name is tried in both spellings.

### 5.7 Watch and invalidation (`core/watch.ts`)

- Watched: every file in `Project.watchFiles` (configs, external import maps, `package.json` files, the lockfile).
  Hosts: Rollup/Rolldown `this.addWatchFile` in `buildStart` + `watchChange`; Vite's dev server watcher (§6.1);
  esbuild `watchFiles` on owned results and a content snapshot compared in `onStart` (§6.4).
- On change (`invalidateProject`): flush the mirror manifest, dispose the engines (they cache the old config and
  lockfile), reload the project and `configure` it again (platform, generation, mirror, filter); the mirror is
  rewritten lazily under the new generation. Vite also invalidates every environment's module graph and sends a full
  reload.
- Local source edits need nothing from us (the host loads local files). Marker targets are watched through
  `addWatchFile` in Vite, so edits update their importers. Remote modules change only with the lockfile or the
  generation (the mirror reuses a generation's files), so pinned content is stable.

### 5.8 Diagnostics (`src/diagnostics/`)

`DenoPluginError extends Error { code: ErrorCode; hint?: string; specifier?: string; importer?: string; cause? }`
with the codes of `ERROR_CODES`: `OPTIONS_INVALID`, `CONFIG_NOT_FOUND`, `CONFIG_INVALID`, `IMPORT_MAP_INVALID`,
`LOCKFILE_INVALID`, `RESOLVE_NOT_FOUND`, `RESOLVE_NOT_EXPORTED`, `RESOLVE_UNMAPPED_BARE`, `RESOLVE_CONSTRAINT`,
`RESOLVE_FAILED`, `CACHED_ONLY_MISS`, `INTEGRITY_MISMATCH`, `MIRROR_WRITE_FAILED`, `ENGINE_UNAVAILABLE`,
`UNSUPPORTED_MEDIA_TYPE`, and three reserved for M2 features and not raised yet: `NOT_IN_LOCKFILE`,
`LOCKFILE_FROZEN_DRIFT`, `DISALLOWED_HOST`. Messages are one sentence; `hint` says what to do ("run `deno install`",
"add `X` to `imports`", "set `cacheDir`"). `format()` prints `[unplugin-deno] <message> (<code>)` plus `hint: …`.
`isDenoPluginError` also recognises errors from another copy of the package.

`Logger { debugEnabled, error, warn, info, debug, downloading(url) }`. The host logger (`hosts/shared.ts`) sends
warnings (and `error` lines, logged but never thrown: Rollup's `this.error` throws) through `this.warn`, info and debug
lines through `this.info`, and falls back to stderr without a context; Vite's watcher uses `config.logger`; esbuild
buffers warnings for `onStart`/`onEnd` (§6.4). `debug` is enabled by `options.debug` or `DEBUG=unplugin-deno`; debug
lines are prefixed with the subsystem (`[core]`, `[engine]`, `[mirror]`, `[vite]`, …).

`addEntrypoints` diagnostics with a code (e.g. `CACHED_ONLY_MISS`) are warnings; the others are debug output, because
the graph also holds imports the host owns (`?raw`, packages from `node_modules`, other plugins' virtual ids) that Deno
reports as errors, and failing owned imports fail in `resolveId` with their importer. The debug summary, logged by
`configure`, lists: plugin version and host, engine kind and loader version, config path, workspace root with member
and link counts, lockfile, `nodeModulesDir` + detected layout + npm strategy, platform + conditions, `cacheDir` +
generation.

### 5.9 Host capabilities the core relies on

| | Rolldown | Vite 8 / 7 | Rollup 4 | esbuild |
|---|---|---|---|---|
| Root | `cwd` | `root` (symlinks resolved) | none (`process.cwd()`, or `cwd`) | `absWorkingDir` |
| Platform hint | `platform` (unset = `browser`) | per environment (§6.1) | none | `platform` (unset = `browser`) |
| Conditions hint | `resolve.conditionNames` | none (Vite applies its own) | none | `conditions` |
| `resolveId` filter | narrowed in `options` (broad in watch mode) | broad | none (all ids) | Go-side, fixed at `setup` |
| Attributes in `resolveId` | none | none | `options.attributes`, one resolution per specifier and module | `args.with`, per import |
| Attribute pre-pass | yes | yes | yes | no |
| Host resolution (redirects, host markers) | `this.resolve` + `skipSelf` | `this.resolve` + `skipSelf` | `this.resolve` + `skipSelf` (`null` without node-resolve) | `build.resolve` |
| `moduleType` from `load` | yes (`js`) | returned (`js`) | no | loader `js` for synthesised modules |
| Watching | `addWatchFile`, `watchChange` | dev server watcher; `watchChange` in build watch mode | `addWatchFile`, `watchChange` | `onStart` snapshot, `watchFiles` |

Why: Rolldown (and thus Vite 8) does not pass import attributes to `resolveId` and deduplicates `text`/`bytes` imports
of one id (rolldown#2758); Rollup exposes attributes but resolves each specifier once per module whatever its
attributes (`import a from "x" with { type: "text" }` and `… "bytes"` in one module become one module, with
`INCONSISTENT_IMPORT_ATTRIBUTES`); esbuild keys modules per attribute. Rolldown reads hook filters when it builds its
plugin bindings, after the `options` hook, so its adapter loads the project there. In watch mode, and in Vite (whose
dev server reloads the project in place, §6.1), the import map can change under the same hooks, so those keep the
broad filter. `resolvedBy` is never set by Vite 7/8 or Rolldown (only by Rollup), so the import map is authoritative
for its keys instead of letting other plugins answer first (§5.2).

---

## 6. Host adapters (`src/hosts/`)

The factory (`core/plugin.ts`) receives `meta.framework` first and returns a host-specific object (unplugin 3.4 facts:
`meta.framework ∈ rollup|vite|rolldown|farm|unloader|webpack|rspack|rsbuild|esbuild|bun`; a factory may return an
array; `this.resolve` exists at runtime on Rollup-family hosts but is not typed on unplugin's `resolveId` context, so
Rollup-family specifics sit under the `vite`/`rolldown`/`rollup` escape hatches for native typings; `enforce` is only
honoured by Vite/webpack/Rspack, elsewhere plugin order applies):

- Rollup, Rolldown and Vite get the generic hooks of one `PluginState`, with the host's hooks merged over them:
  `enforce: 'pre'`; `buildStart` (prepare, watch files, `addEntrypoints` with the host inputs); `resolveId` (broad
  filter; marker from `attributes.type`; `state.resolve`; the outcome converted by `toRollupResult`); `load` (filter:
  the mirror directory, marker ids and `\0deno:` ids); `transform` (the attribute pre-pass); `watchChange`; `buildEnd`
  (flush in watch mode, else flush and dispose the engines).
- `toRollupResult` (`hosts/shared.ts`): `path`/`mirror`/`marker`/`virtual` → `{ id }` (`moduleSideEffects: false` for
  `"sideEffects": false` packages); `npm-redirect` → the host's resolution of `request` from `packageJsonPath` (query
  appended, `moduleSideEffects` forwarded), `fallbackPath` when it answers `null`; `host-marker` → the host's
  resolution of `request` from the importer, with the marker; `external` → `{ id, external: true }`.
- esbuild gets only `{ name, esbuild: { setup } }` (§6.4).
- webpack, Rspack, Rsbuild, Bun, Farm and unloader get an inert `{ name }` plugin (options are still validated).

### 6.1 Vite 8 (and 7)

`hosts/vite/`, merged over the generic hooks; tests in `test/integration/vite.test.ts` (builds) and
`vite-dev.test.ts` (dev server), each run on Vite 8 and on Vite 7 (the `vite7` devDependency alias). `vite` is imported
for types only, so other hosts never load it; the version comes from `this.meta.viteVersion`.

- **`config`** resolves the root like Vite (`resolve(root)`, symlinks resolved unless `preserveSymlinks`), sets hints
  (the build's own platform is the client's, `browser`; other environments resolve with a target) and loads the
  project. In the dev server it appends `{ find: /^(https?:\/\/|data:)/, replacement: '$1' }` to the configured
  aliases (never `'$&'`, which breaks Vite 8 builds): dev import analysis skips URLs no alias matches. The hook mutates
  the config because an alias returned from `config` is placed first and would shadow user aliases of remote URLs. For
  a Deno project without a `package.json` between the root and the workspace root it defaults `cacheDir` to
  `<root>/node_modules/.vite` (Vite would pick an ancestor's `node_modules`; denoland/deno-vite-plugin#87).
- **`configEnvironment`**: server environments on the Deno platform get `resolve.conditions` and
  `resolve.externalConditions` with `deno`: Vite's defaults (`defaultServerConditions`, `defaultExternalConditions`,
  equal in 7 and 8) plus `deno` when the environment sets none (a configured list replaces the defaults), else only
  `deno` (Vite concatenates returned arrays). In the dev server every environment's `optimizeDeps` gets the optimizer
  plugin (below).
- **`configResolved`** records host facts and, in the dev server, extends `server.fs.allow` with the mirror and the
  workspace root (real paths too): a `server.fs.allow` returned from `config` would replace Vite's default (the
  searched workspace root) instead of extending it. (Vite ≥ 8.0.9 detects JSON `deno.json` workspaces itself; Vite 7
  and JSONC configs do not.)
- **Platform per environment** (`environment.ts`): §5.6. `resolveId` resolves with the target of `this.environment`
  (`{ platform, conditions: [] }`: Vite's own `resolve.conditions` apply to what Vite resolves).
- **Dev server externals.** Vite's module runner runs server environments inside the dev server's runtime and cannot
  load `npm:`/`jsr:` externals (`fetchModule` node-resolves bare-looking ids; dev import analysis ignores
  `external: true`; vitejs/vite#20828, #20850), so in the dev server Deno server environments resolve with
  `bundle: ['npm:*', 'jsr:*']`: JSR through the mirror, npm through redirects (inlined by the runner, so CommonJS
  packages need `ssr.optimizeDeps`), in the same mirror generation as the build. Builds keep them external and pinned;
  Vite neither re-externalises nor inlines them, and `noExternal` is never set.
- **`node:` builtins** are left to Vite in every environment: its builtin externals are side-effect free, while an
  `external: true` from the plugin kept an unused `import "node:module"` of Rolldown's runtime in Vite 8 SSR output.
- **Markers** resolve to `\0deno:<type>:<file>.js` (`marker.ts`; `/` separators so dev-server URLs round-trip):
  `vite:css` claims every id matching `\.css(?:$|\?)`, `vite:json` `\.json(?:$|\?)` and framework plugins `\.vue`
  plus a query, whatever the query holds. `load` calls `addWatchFile(file)`, so edits of the target update its
  importers.
- **Optimizer** (`optimizer.ts`, `optimizer-esbuild.ts`). The optimizer plugin is added in `configEnvironment` (dev
  server only): to `rolldownOptions.plugins` on Vite 8, and as an esbuild twin to `esbuildOptions.plugins` on Vite 7
  (no `this.meta.rolldownVersion`). Its name, `unplugin-deno:optimizer:<generation>`, makes Vite's optimizer cache key
  change with `deno.json`/`deno.lock`. It resolves what prebundled package files import (pinned `npm:` specifiers in
  mirror files, markers, bare imports in global-cache packages) and loads mirror files and markers. Keys are the
  specifier as written (`kleur`, `npm:kleur@^4/colors`, `@std/path`, `jsr:…`, `https://…`), the dependency scanner's
  key: in the dev server `resolveId` returns `getOptimizedDepId(info)` for `metadata.optimized[key] ??
  metadata.discovered[key]`, registering it with `registerMissingImport(key, file)` when missing, for npm redirects,
  global-cache files and mirror files. Vite runs the optimizer plugins in its scan too, before its own; they act only
  for importers that are package files (`node_modules`, global npm cache, mirror). The scanner records `node_modules`
  paths itself (npm redirects; mirror files, as the mirror is under `node_modules`); global-cache files are registered
  by `resolveId` during the scan and hidden from the scanner (a non-absolute external id); `https:`/`data:` imports
  never reach the scanner's resolver, so the optimizer plugin registers their mirror files during the scan. JSR, npm
  (also CommonJS from the global cache), `https:` and `data:` imports are thus prebundled in one optimizer run on
  Vite 8 and 7; `optimizeDeps.exclude` and `noDiscovery` are honoured (excluded mirror files are served as they are).
  Vite's `vite:pre-alias` also registers `data:` imports (the alias matches them), under the same key.
- **npm installs** (`nodeModulesDir: "auto"`) happen in the engine as packages are resolved (§4.4), so the dev server
  needs no seeding: its inputs are HTML files, and `buildStart` adds module inputs only in builds.
- **Watching and lifecycle.** `configureServer` adds the project's watch files to the watcher; on `add`/`change`/
  `unlink` of one it runs `watchChange` (serialised), then `moduleGraph.invalidateAll()` and
  `hot.send({ type: 'full-reload' })` for every environment; `hotUpdate` returns `[]` for those files. `watchChange`
  reloads only in build watch mode. A prebundled specifier whose mapping changed is rebuilt at the next server start.
  `buildStart` seeds the environment's engine with the build's module inputs (HTML skipped); `buildEnd` flushes in
  build watch mode and closes otherwise (a dev server calls it once, when it closes).
- Not yet: adding the plugin to `worker.plugins` for worker sub-builds (M2, D7) and the opt-in `resolve.builtins`
  experiment (`/^npm:/`, `/^jsr:/` when the dev server runs under Deno; M2, S4).
- Measured (`vite-spa`, fresh fixture copy, warm `DENO_DIR`, macOS): first `transformRequest('/src/main.ts')`
  0.22–0.39 s on Node 26, 0.25–0.39 s on Deno 2.9.7, 0.26–0.42 s on Bun 1.3.14 (the upper bound includes loading the
  wasm); the whole page with its four prebundled dependencies 0.31–0.53 s; one optimizer run.

### 6.2 Rolldown (and tsdown)

- `options(inputOptions)` records the hints (`cwd` as root, `platform` with `undefined` → `browser`,
  `resolve.conditionNames`, `input`, the Rolldown version), loads the project and narrows the `resolveId` filter
  (outside watch mode) and the `load` filter (§5.9).
- `resolveId: { filter, handler(id, importer, { kind, isEntry }) }` (no attributes: the generic pre-pass handles them);
  npm redirects and host markers call `this.resolve(request, importer, { skipSelf: true, kind })`, which returns
  `{ id, external, packageJsonPath, moduleSideEffects, meta }`; `moduleSideEffects` is forwarded.
- `load` returns `{ code, map, moduleType: 'js' }` for mirror files, markers and `\0deno:empty` (Rolldown would
  otherwise pick a module type from `.txt`/`.css`).
- `closeBundle` flushes the manifest and, outside watch mode, disposes the engines; the generic `buildEnd` does the
  same.
- tsdown takes Rolldown plugins. Its default `platform` is `node`, so a project with a `deno.json` builds for Deno
  unless the `platform` option is set (checked by hand with tsdown 0.23; there is no tsdown test yet).
- Optional (M2): an `order: 'post'` terminator with a `custom` probe to detect whether another plugin resolved a
  mapped key first (research/feasibility.md §2).

### 6.3 Rollup 4 (≥ 4.40 for native filters)

- `options(inputOptions)` records the inputs and the Rollup version. Rollup has no root and no platform: the root is
  `process.cwd()` unless `cwd` is set, and the platform follows §5.6.
- `resolveId(source, importer, { attributes, isEntry })` has no id filter: imports carrying attributes (local
  `./data.txt` included) must reach it, and filters only see the id. `attributes.type` becomes the marker; the generic
  pre-pass stays on (§5.5, §5.9).
- `load: { filter, handler }` uses the native filter on Rollup ≥ 4.40 and checks the id again for older versions.
  Rollup has no `moduleType`; mirror output is JavaScript. `closeBundle` as for Rolldown.
- Rollup cannot load TypeScript, JSON or CommonJS and resolves nothing from `node_modules` by itself: users add their
  usual plugins after this one (without a node-resolve plugin, redirects get the engine's `fallbackPath`). The
  integration tests use a small esbuild TypeScript plugin and a JSON plugin (`test/helpers/rollup-ts.ts`) and skip
  the CommonJS fixtures (`SKIPPED` in `test/integration/core-suite.ts`).

### 6.4 esbuild

`hosts/esbuild/`; tests in `test/integration/esbuild.test.ts`.

- When `meta.framework === 'esbuild'` the factory returns **only** `{ name, esbuild: { setup } }`: unplugin's generic
  adapter registers a catch-all `onResolve(/.*/)` before `setup` runs and forces every result into the plugin
  namespace. `setup` throws `ENGINE_UNAVAILABLE` synchronously for a host that is not esbuild (no
  `initialOptions`/`resolve`/`onDispose`, e.g. `Bun.build`).
- **Filters.** `setup` is async and loads the project first (`options.ts`: root `absWorkingDir` or `process.cwd()`,
  platform, `conditions`, entry points), because esbuild takes filters once, at `setup`. The main filter is
  `resolveIdFilter(project, { npm: 'node_modules' }, platform)` (schemes, marker, import-map keys, `package.json`
  dependencies for the Deno platform), also for the global-cache strategy; bare imports then get a separate
  `/^[^./]/` handler, guarded by the *importer* (global npm cache, the mirror, or `node_modules` with
  `npm: 'deno-cache'`). With `importAttributes`, an `onResolve` for `.css` paths handles local `with { type: "css" }`
  imports (below). When the project cannot be loaded at `setup` the broad filter is used and `onStart` reports the
  error. Keys added to the import map while a context runs are not in the filter: the reload warns that a new context
  is needed. There is no `/.*/` filter outside the plugin's own namespace, and no `onLoad` for files.
- **Results.** Local, mirror and global-cache files are `{ path }` in the `file` namespace (esbuild loads them with its
  own loaders and reads the mirror's linked source maps); externals are `{ path, external: true }`; marker modules
  are synthesised by `onLoad({ filter: /.*/, namespace: 'unplugin-deno' })` with `loader: 'js'`, under paths relative
  to `absWorkingDir` (`paths.ts`; the core id travels in `pluginData`), so output comments, source maps and the
  metafile have no machine paths and no `\0`.
- **`external` and `packages`.** esbuild applies `external` and `packages: 'external'` only after the plugins'
  `onResolve` callbacks (verified), and it treats `jsr:…`, `npm:…` and `https://…` as package paths. Imports matching
  `initialOptions.external` (esbuild's rules, `external.ts`: one `*` wildcard, package paths with their subpaths,
  never entry points) are left to esbuild, which keeps them as written. `packages: 'external'` adds `npm:*` and
  `jsr:*` to the plugin's `external` patterns and pins them (`pinExternals` defaults to `true`), so mapped bare names
  become `npm:x@<version>`; unmapped bare names stay esbuild's.
- **Platform.** `browser` → browser, also when `platform` is unset (esbuild's own default); `node` and `neutral` →
  `deno` with a `deno.json`, else `node`.
- **Attributes.** The marker is added from `args.with` before `state.resolve`. Local `text`/`bytes` imports are left
  to esbuild's own loaders (esbuild ≥ 0.28 / 0.25.11; same values as the markers); esbuild rejects
  `with { type: "css" }`, so the `.css` handler turns local css imports into markers (`host-marker` outcome, resolved
  with `build.resolve` without the attribute). A `css` attribute on a non-`.css` local file stays unsupported.
- **Redirects** call `build.resolve(request, { kind, resolveDir: packageDir, importer: packageJsonPath, namespace:
  'file', with, pluginData })`: the `package.json` importer (as on Rollup) keeps the request from re-entering the
  plugin's import-map handler (it resolves bare names from `node_modules` importers to `null`). `sideEffects`,
  `suffix`, `pluginData` and warnings are forwarded; on errors the engine's `fallbackPath` is used. Queries become
  `suffix`.
- **CSS.** esbuild sends `@import` and `url()` references to `onResolve` (kinds `import-rule`, `url-token`,
  `composes-from`); remote and `data:` URLs there are left to esbuild (kept as written / inlined), not mirrored.
- **Lifecycle.** esbuild has no `watchChange`: `onStart` compares the watched files' contents with the last load
  (`snapshot.ts`) and reloads through `watchChange(file)`; it seeds the engine only when the engines lack the build's
  entry points. Owned results carry `watchFiles` (configs, import maps, lockfile) for `ctx.watch()`. `onEnd` flushes
  the manifest; the last `onDispose` disposes the engines. `onDispose` runs after `build()` has resolved (a
  `setTimeout`), so plugin reuse is tracked per *running* build (`onStart`…`onEnd`, which esbuild calls even after
  `onStart` errors and cancellations): builds may reuse an instance one after the other with any settings (the project
  is reloaded) and concurrently with equal settings (`absWorkingDir`, `platform`, `conditions`, `packages`); a
  concurrent build with other settings fails with `OPTIONS_INVALID`. After an `onStart` error esbuild still resolves
  every import; owned imports are then returned as externals so the build fails with that one error.
- **Messages** (`messages.ts`). Errors are returned as esbuild messages (`<message> (<code>)`, the hint as a note, the
  error in `detail`), so esbuild shows them at the import; warnings are buffered and returned from `onStart`/`onEnd`.
  esbuild has no informational channel for plugins, so debug output goes to stderr.

### 6.5 webpack (M2)

Not implemented (inert plugin). Design: `webpack(compiler)`: tap `NormalModuleFactory.hooks.resolveForScheme.for(s)`
and `resolveInScheme.for(s)` for `jsr|npm|https|http|data` (`AsyncSeriesBailHook<[ResourceDataWithData, ResolveData],
true | void>`) → set `resourceData.path/resource` to the mirror/npm path; bare import-map keys through
`nmf.hooks.beforeResolve` (`request`/`context` rewrite); `NormalModule.getCompilationHooks(c).readResource.for(s)`
only for synthesised marker modules (mirror files are real files). Disable `externalsPresets.web`'s scheme externals
inside `apply` (runs before defaults) unless the user wants `target: 'deno'` semantics (option). Inject native
`externals` for the externals policy since unplugin drops `external: true`. Import attributes via `module.rules[].with`.
Persistent cache: mark generated modules with build dependencies on the config files.

### 6.6 Rspack / Rsbuild (M2)

Not implemented (inert plugins). Design: `rspack(compiler)`: `nmf.hooks.resolve` sees scheme requests (with
`attributes`); `resolveForScheme.for(s)` takes one argument; there is no `resolveInScheme`; `readResource` is typed but
never called (rspack#12210) → synthesised modules go through `rspack.experiments.VirtualModulesPlugin` or a
`module.rules[{ scheme, enforce: 'pre' }]` pitching loader. Rsbuild does not call `rspack(compiler)`; provide
`rsbuild.setup(api)` using `api.modifyRspackConfig`.

### 6.7 Bun (M2), unloader / `register` (M3)

Not implemented: `unplugin-deno/bun` is inert, `unplugin-deno/esbuild` refuses `Bun.build` (§6.4), and
`unplugin-deno/register` throws `ENGINE_UNAVAILABLE` on import. Design: Bun through unplugin's Bun target; `onResolve`
has no `with`, so attributes rely on the transform pre-pass. `register`: reuse the factory through unplugin's
`unloader` target (Node `module.registerHooks`, sync) with a worker + `Atomics.wait` bridge around the async engine; Bun
uses `Bun.plugin` with `--preload`.

---

## 7. Testing architecture

- Unit tests are colocated (`src/**/*.test.ts`). Path helpers take an explicit `posix`/`win32` flavour, so Windows
  cases run on every OS.
- `test/fixtures/<name>/`: small projects, each with a `fixture.json` (`title`, `entries`, `hosts`, optional `expect`,
  `issues`, `source`; typed and validated in `test/helpers/fixture.ts`). Prefixes say who uses them: `core-*` (the core
  suite), `engine-*` (the engine contract), `esbuild-*` and `vite-*` (host tests); unprefixed ones serve the config
  tests. Remote fixtures pin versions and ship a `deno.lock`.
- `test/data/`: the web-platform-tests import-map data (`wpt-import-maps/`) and the `denoland/import_map` cases
  (`deno-import-map/`), with their `SOURCE.md`, run by `src/config/import-map.wpt.test.ts`.
- `test/helpers/`: `tempProject(name)` (a copy of a fixture outside the repository), `tempDir(files)`, `denoDir()` /
  `freshDenoDir()` (the shared or an empty test `DENO_DIR`), `normalize(text)` (placeholders for machine paths and
  hashes, also applied to snapshots), `runtime`; builders that run the real bundler into a temporary directory and
  return chunks, module ids, imports and logs: `buildWithRolldown`, `buildWithRollup` (`build.ts`), `buildWithEsbuild`,
  `contextWithEsbuild` (`esbuild.ts`), `buildWithVite`, `startViteDevServer`, `loadVite(7 | 8)` (`vite.ts`);
  `evaluateModule` imports an output file in the current runtime.
- `test/integration/`: `core-suite.ts` holds the core fixture tests, run by `rolldown.test.ts` and `rollup.test.ts`
  (fixtures a host cannot build are skipped with their reason in `SKIPPED`); `esbuild.test.ts`, `vite.test.ts` and
  `vite-dev.test.ts` cover the other hosts with the same fixtures plus their own. Tests that run the output under
  `deno run --cached-only` skip when the `deno` binary is missing.
- Engine contract tests (`src/engine/contract.test.ts`) run the `engine-*` fixtures against every engine factory.
- Runtimes: `pnpm test` (Node), `pnpm test:deno` (`deno run -A npm:vitest run`), `pnpm test:bun`
  (`bun --bun x vitest run`); CI runs them on ubuntu, macOS and Windows (`.github/workflows/ci.yml`).

---

## 8. Glossary

- **Owned specifier**: one `resolveId` must handle: a Deno scheme, an import-map key, a marker id, or an import from
  inside a mirror or global-cache file.
- **Mirror**: `cacheDir/<generation>/…` copies of remote modules as JS files with rewritten specifiers.
- **Generation**: hash of config files + lockfile + plugin version + platform + conditions; namespaces the mirror.
- **Redirect**: handing an npm request back to the host resolver from inside the package directory.
- **Marker**: the `?deno-type=` query encoding an import attribute in the id.
- **Pinning**: rewriting an external `npm:`/`jsr:` specifier to the exact resolved version for Deno runtime output.
- **Target**: the platform (and extra `bundle` patterns) an import is resolved for when a host builds several platforms
  at once (Vite environments).

---

## Appendix A. Deviations from plan.md

The plan's scope is unchanged; these are the places where the implementation chose differently than
[plan.md](plan.md) §3–§6 describe, and why:

- `npm: 'auto'` follows `nodeModulesDir` (`none` → Deno's global cache) instead of "redirect when a `node_modules`
  layout exists": with `none` the loader resolves into `DENO_DIR` even when `node_modules` exists (§5.4).
- The import-attribute pre-pass also runs on Rollup, because Rollup reuses one resolution per specifier and module
  (§5.5, §5.9).
- Vite markers are virtual ids (`\0deno:<type>:<file>.js`) because Vite's CSS, JSON and framework plugins claim ids by
  extension whatever the query holds (§6.1).
- In the Vite dev server, Deno server environments bundle `npm:` and `jsr:` imports instead of keeping them external
  (Vite's module runner cannot load them); builds keep them external and pinned (§6.1). `node:` builtins are left to
  Vite.
- esbuild's own `external` option is left to esbuild (it applies after plugins), and `packages: 'external'` keeps
  `npm:`/`jsr:` imports external and pinned (§6.4).
- Import-map keys are known only once the project is loaded, so Vite and watch builds use a broad `resolveId` filter
  (§5.2, §5.9).
- Deferred although plan.md lists them for M1: the `jsrDepsInNodeModules` route of D2 (§5.4) and the empty module for
  `browser: false` mappings of R6 on the global-cache route (§5.6); plan.md's progress note tracks the other open
  items.
