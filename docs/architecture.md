# Architecture

This is the developer specification of `unplugin-deno`: what each layer does, the algorithms, the id and file
layouts, and the per-host recipes. It is written for contributors and coding agents; users read the
[README](../README.md). Rationale is in [plan.md](plan.md).

The text describes the implementation after the M2 work on the P0/P1 set, verified with Deno 2.9.7, Vite 8.3.1 and
7.3.6, Rolldown 1.2.11, Rollup 4.63.5, esbuild 0.28.2, webpack 5.111.1, Rspack 2.2.7 and Rsbuild 2.2.9. What is not
implemented yet is marked **(planned)** (M3 items as **(M3)**). Where the implementation departs from
[plan.md](plan.md), this document is authoritative; [Appendix A](#appendix-a-deviations-from-planmd) lists the
departures. Source comments cite sections (`docs/architecture.md §5.3`), so keep the numbering stable when editing.

Conventions used here: "host" = the bundler we plug into; "engine" = the component that implements Deno's
resolution and loading semantics; "mirror" = the project-local directory where remote modules are written as files.

---

## 1. Layers and module map

```
src/
├─ index.ts                 `unplugin` (the unplugin instance), `unpluginFactory`, option and error types,
│                           DEFAULT_ALLOW_IMPORT
├─ vite.ts rolldown.ts rollup.ts esbuild.ts webpack.ts rspack.ts rsbuild.ts bun.ts farm.ts
│                           host entries: `export default create<Host>Plugin(unpluginFactory)` (unplugin has no
│                           subpaths); bun and farm get an inert plugin
├─ register.ts, api.ts      `unplugin-deno/register` (E1) and `unplugin-deno/api` (E2): throw ENGINE_UNAVAILABLE (M3)
├─ vendored-deno-loader.ts  the only importer of ../vendor/deno-loader: lazy import, VERSION, log and fetch hooks
│                           (must stay at depth 1 so the relative path is the same from src/ and dist/)
├─ core/                    §5
│  ├─ plugin.ts             the UnpluginFactory: generic hooks for the Rollup family (and a second Vite instance for
│  │                        `worker.plugins`), host hooks under unplugin's escape hatches; only `esbuild.setup` for
│  │                        esbuild; the webpack, Rspack and Rsbuild adapters; an inert plugin for other hosts
│  ├─ state.ts              PluginState: options, project, platform, engine selection and engines, a resolver and
│  │                        mirror per target, allow-list, lockfile policy, `jsr:` route; the hook implementations
│  │                        (resolve, load, transform, watchChange, flush, close); once-only warnings, npm versions and
│  │                        externals recorded for the checks and the sidecar
│  ├─ options.ts            Options, resolveOptions (every default, §5.1), DEFAULT_ALLOW_IMPORT
│  ├─ specifier.ts          classify specifiers (§2); parse and format `npm:`/`jsr:` specifiers
│  ├─ id.ts                 id scheme: splitQuery, deno-type marker, `\0deno:` virtual ids, mirror paths, filters
│  ├─ resolve.ts            the resolveId algorithm (§5.2) → ResolveOutcome; resolveIdFilter
│  ├─ allow-import.ts       the remote-import allow-list (§5.2)
│  ├─ npm.ts                npm strategy: redirects and global-cache paths (§5.4)
│  ├─ jsr-npm.ts            the `jsrDepsInNodeModules` route (§5.4)
│  ├─ mirror.ts             mirror layout, writing, rewriting, source maps, manifest, integrity, GC (§5.3)
│  ├─ attributes.ts         import-attribute pre-pass and marker modules (§5.5)
│  ├─ platform.ts           platform model, conditions, externals, patterns, pinning (§5.6)
│  ├─ sidecar.ts            the sidecar deno.json and deno.lock of Deno platform output (§5.6)
│  ├─ entries.ts            host inputs → engine entrypoints
│  ├─ watch.ts              watch list and invalidation (§5.7)
│  ├─ checks.ts             diagnostics messages; npm versions per platform (§5.8, §5.10)
│  ├─ source.ts             one scan per module: import.meta.main, env reads, `Deno.*` references (§5.10)
│  ├─ env.ts                the variables `env` inlines and their values (§5.10)
│  ├─ jsx.ts                deno.json JSX settings as a host-neutral transform (§5.11)
│  ├─ wasm.ts               `.wasm` module imports as synthesised instantiating modules (§5.12)
│  ├─ lockfile-policy.ts    the `lockfile` modes, drift, explanations (§5.13)
│  ├─ registry-cache.ts     npm packuments and JSR metadata read from DENO_DIR (§5.6, §5.13)
│  └─ version.ts            the plugin version (part of the mirror generation)
├─ config/                  §3
│  ├─ discover.ts           config folder, workspace root, members (globs), links, external import maps
│  ├─ deno-config.ts        DenoConfig, JSONC parsing and normalisation (nodeModulesDir, workspace, links, exports,
│  │                        lock, JSX settings, minimumDependencyAge)
│  ├─ package-json.ts       package.json reading, dependency classification, catalogs
│  ├─ import-map.ts         the WICG algorithm with Deno's deviations and package expansion; the workspace resolver
│  ├─ version-req.ts        Deno's version requirements (ported from deno_semver)
│  ├─ lockfile.ts           deno.lock v5 reader
│  ├─ node-modules.ts       nodeModulesDir mode, node_modules layout, another package manager's markers
│  └─ project.ts            loadProject → Project; configGeneration
├─ engine/                  §4
│  ├─ types.ts              Engine, EngineFactory, EngineCreateOptions, ResolvedModule, LoadedModule, MediaType
│  ├─ select.ts             selectEngineKind, denoOnlyFeatures (§4.3)
│  ├─ create.ts             createEngine(kind, options) over ENGINE_FACTORIES
│  ├─ errors.ts             EngineResolveError (missing optional npm dependencies)
│  ├─ media-type.ts         MediaType ↔ extension ↔ esbuild loader / Rolldown moduleType
│  ├─ deno-dir.ts           where DENO_DIR is
│  ├─ npm-package.ts        the npm package of a resolved file
│  ├─ package-specifier.ts  `jsr:`/`npm:`/bare specifier parsing
│  ├─ loader/               the `loader` engine (§4.2): engine.ts, errors.ts (loader errors → codes, shared hints),
│  │                        hooks.ts (log and fetch routing, cachedOnly)
│  └─ deno-cli/             the `deno` engine (§4.3): engine.ts, graph.ts (the union of `deno info` outputs), info.ts
│                           (output guards, stderr, cache files), node-resolver.ts (Node.js resolution, ported from
│                           node_resolver), process.ts (spawning, version gate), transpile.ts (`deno transpile`)
├─ hosts/                   §6
│  ├─ shared.ts             HostContext, the host-backed logger, toRollupResult, transformContext, JSX options per
│  │                        host, rollupEntryDirectory
│  ├─ rolldown/index.ts     options (root, platform, inputs, filters, `transform.jsx`), resolveId/load with moduleType
│  ├─ rollup/index.ts       options (`jsx`), attributes → markers in resolveId, load, closeBundle
│  ├─ vite/                 index.ts (hooks), environment.ts, marker.ts, optimizer.ts, optimizer-esbuild.ts
│  ├─ esbuild/              index.ts (the whole plugin), options.ts, external.ts, mirror.ts, paths.ts, messages.ts,
│  │                        snapshot.ts
│  ├─ webpack/              index.ts (the webpack adapter), requests.ts (Router, shared with Rspack/Rsbuild),
│  │                        presets.ts, synthetic.ts, transforms.ts, jsx.ts
│  ├─ rspack/               index.ts, plugin.ts (the Rspack plugin, also used by Rsbuild), synthetic.ts
│  └─ rsbuild/index.ts      rsbuild.setup(api): the Rspack plugin per environment
├─ diagnostics/
│  ├─ errors.ts             DenoPluginError { code, message, hint?, specifier?, importer?, cause? }, ERROR_CODES
│  └─ logger.ts             Logger, the console logger, DEBUG=unplugin-deno
└─ utils/
   ├─ path.ts               toPath, toFileUrl, normalizeDriveLetter, isSubpath, relativeUrlPath (Windows-safe)
   ├─ url.ts                URL helpers (trailing slashes, dirname, normalisation, percent-decoding)
   ├─ fs.ts                 ensureDir, writeFileAtomic, JSON and JSONC parsing with error positions
   ├─ hash.ts               sha256 helpers
   ├─ lexer.ts              import/export scanning (es-module-lexer wrapper) and attribute parsing
   └─ js-tokens.ts          a forgiving JavaScript/TypeScript tokenizer (the source scan's fallback, §5.10)
vendor/deno-loader/         generated by scripts/vendor-loader.ts: patched @deno/loader 0.5.0 (mod.js, rs_lib_node.js,
                            lib/rs_lib.js, lib/rs_lib.wasm and its glue), hooks.js, LICENSE, VERSION, NOTICE.md
```

`config/`, `core/`, `engine/` and `hosts/` each have a `README.md` with the same map in more detail. Unit tests sit
next to the module they test (`*.test.ts`; `src/entries.test.ts` covers the host entries); `test/` holds fixtures,
integration tests and helpers (§7).

Dependency direction: `hosts → core → engine, config → utils, diagnostics`, with two exceptions: `core/plugin.ts`
composes the adapters of `hosts/`, and `core/state.ts` uses the host logger of `hosts/shared.ts`. `config` imports
only the specifier parsers of `core`; `engine` never imports `core`, `config` or `hosts` (the project arrives as an
`EngineProject`, and `select.ts` reads the project structurally). No module imports a bundler package at runtime
(`import type` only; the webpack and Rspack adapters use `compiler.webpack`/`compiler.rspack`).

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
(`esbuildLoaderFor`, `moduleTypeFor`). No adapter uses it yet: mirror files, marker modules and Wasm modules are
JavaScript (`moduleType: 'js'` where the host takes one), and raw assets are loaded by the host.

---

## 3. Config layer (`src/config/`, pure TypeScript, no wasm)

The config layer reproduces Deno 2.9's discovery and import-map behaviour without the engine (verified against Deno
2.9.7): the vendored loader lacks glob members, link globs and other 2.8/2.9 features, and the core needs the import
map before any engine exists (for hook filters, §5.2).

### 3.1 Discovery (`discover.ts`)

Input: the directory `options.cwd` (the host root unless set: Vite `root`, esbuild `absWorkingDir`, Rolldown `cwd`,
webpack and Rspack `compiler.context`, Rsbuild's `rootPath`, otherwise `process.cwd()`), `options.config`, and
whether `package.json` files are read (not when `DENO_NO_PACKAGE_JSON` is set).

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
   directory a path value of an import map points into. (The vendored loader rejects link globs; `engine: 'auto'`
   then uses the `deno` engine, §4.3.)
5. `importMap` (an external import map file) is read as strict JSON and gets no package expansion; inline
   `imports`/`scopes` win over `importMap` (with a warning).
6. `nodeModulesDir` (`node-modules.ts`): an explicit value wins (`"auto" | "manual" | "none"`; the legacy `true` and
   `false` mean `auto` and `none`); otherwise `"manual"` when the **workspace root** has a `package.json` (a
   member's is not enough), `"auto"` for `vendor: true`, else `"none"`. The actual layout of
   `<workspace root>/node_modules` is detected too: `isolated` (Deno's `.deno/`), `pnpm` (`.pnpm/`), `hoisted` (npm,
   Yarn, Bun, Deno's hoisted linker), whether `@jsr/` holds packages (Deno 2.9 `jsrDepsInNodeModules`, §5.4), and
   the markers another package manager leaves at its top (`.pnpm/`, `.modules.yaml`, `.package-lock.json`,
   `.yarn-integrity`, `.yarn-state.yml` → `foreignManager`). With `"auto"`, Deno installs into the same directory
   and re-links the top-level packages, so the core warns once about a foreign `node_modules` (§5.10).
7. The settings of §3.4 are read from the root config (JSX settings from the nearest one).

Output: `loadProject` (`project.ts`) returns `Project`: the discovery (`root`, `disabled`, `configPath`,
`workspaceRoot`, `rootFolder`, `members`, `links`, `watchFiles`, `warnings`) plus `config`, `workspaceConfig`,
`nodeModules` (mode, layout, `hasJsrDeps`, `foreignManager`), `lockfilePath`, `lockfile`, `unsupportedLockfile`,
`lockfileFrozen`, `jsx`, `unstable`, `vendor`, `jsrDepsInNodeModules`, `minimumDependencyAge` and `importMap` (the
resolver of §3.2). `watchFiles` = every config, external import map and `package.json` read, plus the lockfile.
Parsing uses `jsonc-parser`; errors become `DenoPluginError('CONFIG_INVALID')` with `file:line:column`.
`configGeneration(project)` hashes the contents of the watch files, the input of the mirror generation (§5.3).

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
member and link package names) feeds the `resolveId` filter (§5.2); `map` (the root `imports` and the scopes) also
gives the Vite adapter its path-like aliases (§6.1) and the allow-list its project URLs (§5.2). Errors:
`IMPORT_MAP_INVALID` for invalid entries and backtracking subpaths, `RESOLVE_NOT_EXPORTED` for a missing member
export.

### 3.3 Lockfile (`lockfile.ts`)

Reads `deno.lock` version 5: `specifiers` (normalised requirements: `jsr:@std/path@^1` is stored as
`jsr:@std/path@1` → `1.1.6`), `jsr`/`npm` entries (`integrity`, `dependencies`, `optionalDependencies`,
`optionalPeers`, `tarball`), `remote` (URL → sha256), `redirects`, and `workspace` (root and member `dependencies`,
`packageJson`). Provides `pin(specifier)` (the pinned specifier with its subpath: `jsr:@std/path@^1/join` →
`jsr:@std/path@1.1.6/join`), `has(specifier | url)`, `hasPackage(kind, name, version)`, `remoteIntegrity(url)`
(following `redirects`) and `npmDependencies(nameVersion)`. Used for `platform: 'deno'` pinning (§5.6), mirror
integrity (§5.3), the lockfile policy (§5.13) and the sidecar lockfile (§5.6). An unreadable or invalid file is
`LOCKFILE_INVALID`; other versions are reported as unsupported (§3.4). The plugin never writes a lockfile.

### 3.4 Settings (`deno-config.ts`, `package-json.ts`, `project.ts`)

- Lockfile: the root `deno.json`'s `lock` (`false`, a path, or `{ path, frozen }`; default `deno.lock` next to it),
  or `deno.lock` next to a root `package.json` when there is no `deno.json`; none for `lockfile: 'off'`. A lockfile
  whose version is not 5 is ignored with a warning ("run `deno install` to upgrade it"). The engines get the path
  only for an existing version 5 lockfile (`noLock`/`--no-lock` otherwise, §4.2, §4.3). `lock.frozen`
  (`lockfileFrozen`) freezes `lockfile: 'auto'` (§5.13).
- `minimumDependencyAge` (root config; Deno 2.5.5+): minutes (a number or digits), an RFC 3339 date-time, a
  `YYYY-MM-DD` date or an ISO-8601 duration without years or months (`P2D`, `PT12H`); `0`, `"0"` and `false` disable
  it; the object form adds `exclude`. Unset means Deno 2.9's default of 24 h. The result is the
  `newestDependencyDate` handed to the `loader` engine (§4.2); the `deno` engine lets Deno apply it (§4.3).
- JSX: `compilerOptions` `jsx`, `jsxImportSource`, `jsxImportSourceTypes`, `jsxFactory`, `jsxFragmentFactory`,
  `jsxPrecompileSkipElements` of the nearest config merged over the root's, with Deno's defaults. Applied to local
  files through the host's JSX transform (§5.11); remote modules are transpiled by the engine.
- `unstable` (e.g. `raw-imports`, which matters to the loader's graph, §5.5), `vendor`, `jsrDepsInNodeModules` (in
  effect only with a `node_modules` directory mode; the npm route through `@jsr/`, §5.4).
- `package.json` dependencies with `catalog:` versions (Deno 2.8) are classified like other dependencies; the vendored
  loader cannot install them, so `engine: 'auto'` uses the `deno` engine for such projects (§4.3).
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
  newestDependencyDate?: Date                                                 // the `deno` engine ignores it
  logger: Logger
  fetch?: typeof fetch                                                        // the `deno` engine ignores it
  denoBinary?: string                                                         // the `loader` engine ignores it
}
interface EngineDiagnostic { message: string; code?: ErrorCode }
```

Entrypoints are `file:` URLs, absolute or root-relative paths, remote URLs or `jsr:`/`npm:`/mapped specifiers
(`core/entries.ts` normalises host inputs; virtual ids and `node:` are skipped). `resolve` throws `RESOLVE_*` or
`CACHED_ONLY_MISS`; a missing optional dependency of an npm package is an `EngineResolveError` with
`isOptionalDependency` (the core keeps it external, §5.2). `load` throws `RESOLVE_FAILED` for unresolved `jsr:`/`npm:`
specifiers and load failures.

`PluginState` selects the engine kind once per loaded project (`selectEngineKind`, §4.3; the reason goes to the debug
output, a fallback to the loader despite a Deno-only feature is a warning), creates engines lazily and keys them by
(purpose, engine platform, conditions): purpose `main` for resolution and code, and `raw` for raw loads the main
engine refuses (§5.5). They are disposed at the end of a build and recreated on config or lockfile change (§5.7).
`engine/contract.test.ts` runs the same `test/fixtures/engine-*` fixtures against both engine factories (the `deno`
run is skipped when no Deno 2.8.3+ is found); the `engine-cli-*` fixtures cover what only the `deno` engine supports
(`deno-cli/engine.test.ts`).

### 4.2 `loader` engine (vendored `@deno/loader` 0.5.0)

Facts that drive the implementation (verified against @deno/loader 0.5.0):

- Construction: `new Workspace({ configPath | noConfig, noLock, platform, nodeConditions, cachedOnly,
  newestDependencyDate, preserveJsx: false, noTranspile: false })`, then `await workspace.createLoader()`. **Always
  pass `configPath`** (discovery would otherwise start at `process.cwd()`); a project without a config gets
  `noConfig: true`, and `noLock` is set when no lockfile is in use (§3.4). `platform` is `'node' | 'browser'` (the
  `deno` platform uses `node`). There is no `cwd`, `nodeModulesDir`, `vendor`, `lockfile` or `frozen` option: those
  come from `deno.json` or are plugin logic. The wasm deserialises `newestDependencyDate` only as an RFC 3339 string
  (a `Date` fails, although `mod.d.ts` types it `Date`), so `toWasmWorkspaceOptions` converts it. A configuration the
  loader rejects (link globs, for example) becomes `CONFIG_INVALID`.
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
  without the message, so it is `RESOLVE_FAILED`. The `deno` engine reuses these hints and classifiers.
- `cachedOnly`: the loader itself blocks only npm downloads (`NpmCacheSetting::Only`); remote `https:`/`jsr:` modules
  are still fetched (the HTTP client's `cached_only` is never set). The engine enforces it: while a `cachedOnly`
  engine owns the fetch hook every download is refused (`AbortError`, no retries) and the failures become
  `CACHED_ONLY_MISS` (the core adds the command that fills the cache and `NOT_IN_LOCKFILE`, §5.2, §5.13).
- Logging and fetch: the glue calls `console.error('Downloading', url)` and prints Rust log lines and panics. The
  vendored copy is patched (`scripts/vendor-loader.ts`) to report these to `hooks.js` (`setLogger`, `setFetch`,
  reached through `vendored-deno-loader.ts`), and to download through an injectable fetch (the `fetch` option, else
  `globalThis.fetch` at call time) with 3 jittered retries on network errors, HTTP 429 and 5xx (upstream has none).
  The wasm module is instantiated once per process, so `loader/hooks.ts` routes the hooks to one live engine: the
  most recently created one with an operation in flight, else the most recently created one. With identical options
  per engine (the plugin's case) this only decides which logger prints a line.
- Registries: the loader reads `NPM_CONFIG_REGISTRY`, `.npmrc` (registries, scoped registries, auth tokens) and
  `DENO_AUTH_TOKENS` like Deno (the first two are tested with a mock registry), but **ignores `JSR_URL`**: JSR
  packages always come from `https://jsr.io/` (verified with a local registry). A `fetch` that rewrites those
  requests serves a private JSR registry; otherwise a `JSR_URL` naming another registry makes `engine: 'auto'` pick
  the `deno` engine (§4.3).
- Wasm loading: the patched `mod.js` picks its glue by the scheme of its own URL, not by runtime (upstream tests
  `typeof Deno`). From a `file:` URL (Node.js, Bun, and Deno running the package from disk or `node_modules`) it
  imports `rs_lib_node.js`: `readFileSync` + synchronous `WebAssembly.Module/Instance`, the same code on every runtime.
  From any other URL, which means Deno loading the JSR package from `https://jsr.io/…` where `readFileSync` cannot read
  the wasm, it imports `lib/rs_lib.js`, which imports `./rs_lib.wasm` as a module (Wasm ESM integration; Deno 2.9.7
  rejects a `type: "wasm"` attribute, and needs none). Deno fetches the wasm like any module (`deno cache` prefetches
  it, so `--cached-only` runs work) and resolves its imports, `./rs_lib.internal.js` and `node:tty`, through the module
  graph, so both paths bind it to the same patched glue and hooks. `mod.js` exports the choice as `wasmLoadingPath`
  (`'node'` or `'esm'`); `vendored-deno-loader.test.ts` checks the `file:` path on each runtime, and
  `vendored-deno-loader.remote.test.ts` runs the other one in a child `deno run` that imports `vendor/deno-loader/` from
  a local HTTP server. The wasm is read relative to the glue (`lib/rs_lib.wasm`), so `vendor/` ships as files next to
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

### 4.3 `deno` engine and engine selection

**Selection** (`select.ts`). `engine: 'loader'` and `engine: 'deno'` are taken as they are (`'deno'` without a usable
Deno fails when the engine is created, with `ENGINE_UNAVAILABLE`). `engine: 'auto'` uses the loader unless
`denoOnlyFeatures(project, env)` finds a Deno feature the vendored loader (0.5.0, about Deno 2.7.9) lacks, each
verified against the loader and Deno 2.9.7:

- `catalog:` versions in the `imports` of any `deno.json` or the `dependencies`/`devDependencies` of any
  `package.json` of the workspace (root, members, links): the loader fails with "Not implemented scheme 'catalog'";
- globs in the root's `links` (or `patch`): the loader cannot create a workspace ("Could not find link member");
- `jsrDepsInNodeModules` in effect: Deno maps `jsr:` import-map entries to `npm:@jsr/…`; the loader resolves them to
  `https://jsr.io` (the plugin's `@jsr` route works with either engine, §5.4);
- `JSR_URL` naming a registry other than `https://jsr.io`: the loader ignores it (§4.2).

Then Deno is probed (`probeDeno`, once per binary and process): `denoBinary` (default `deno` on `PATH`), version
2.8.3 or later (2.8.3 added `npmPackages[*].localPath` to `deno info --json`, denoland/deno#34806; 2.8.0 added
`deno transpile`). Without a usable Deno, `auto` falls back to the loader with a warning naming the feature. Glob
workspace members, `nodeModulesLinker: "hoisted"`, CSS/text/bytes imports, the minimum dependency age and external
import-map links do not decide (the plugin handles them for both engines).

**Graph** (`engine.ts`, `graph.ts`, `info.ts`). One `deno info --json --allow-import --config <configPath>
--lock <copy> --node-modules-dir=<mode> --unstable-sloppy-imports --unstable-raw-imports <root>` per batch, where
`<root>` is a synthetic module in the engine's private temporary directory that imports every entrypoint (or every
pending specifier, up to 2,000 per run): `deno info` takes one module, and a file keeps long entry lists off the
command line (Windows argv limits). `--no-config` replaces `--config` without a config, and `--no-lock` replaces
`--lock` without a lockfile (`lockfile: 'off'`). The lockfile is a **private copy**, because `deno info` adds entries
to the lockfile it is given and the plugin never writes `deno.lock`. `--node-modules-dir` is the project's mode, so
`"auto"` installs into `node_modules/.deno` and `"manual"` never installs. Import maps, scopes, workspaces, `links`,
`catalog:`, lockfile pins, `minimumDependencyAge` and `JSR_URL` are applied by Deno itself. The output is validated by
hand-written guards (the format is marked unstable); an unknown shape is `ENGINE_UNAVAILABLE` naming the Deno
version. The engine's graph is the union of the outputs; a later output replaces the modules it contains, so an
edited local file gets its new imports when it is queried again. stderr's `Download <url>` lines go to the logger.

**Resolution.** A specifier imported by a module of the graph resolves through that module's recorded dependency,
then `redirects` (at most 10). Other specifiers wait 5 ms for company and are resolved by one `deno info` per batch;
runs are serialised, never one per import, and a resolution takes at most three rounds (an npm package of the
referrer, then its file). `deno info` names npm packages (`npmPackages[*].localPath`) but not files, so npm subpaths
and the imports inside npm packages are resolved by `node-resolver.ts`, a port of Deno's `node_resolver` 0.80.0 (the
version inside the vendored loader) in bundle mode with the engine's platform and conditions; its tests compare it
with the loader on many package shapes. With `nodeModulesDir: "manual"`, packages come from the project's
`node_modules` like in the loader (§4.4).

**Loading.** Remote modules are read from their `DENO_DIR/remote/…` cache file with the trailing
`// denoCacheMetadata=` line removed (modules not downloaded yet are queried first; `bytes`/`json` loads are imported
with that attribute, so Deno downloads them without parsing). TypeScript and JSX are transpiled by `transpile.ts`:
the sources are copied to a private directory next to a `deno.json` holding the workspace root's `compilerOptions`
(Deno applies a config's JSX settings only to files inside its directory), and one `deno transpile --outdir …
--source-map separate` runs per batch, which includes the not yet transpiled dependencies of the loaded module (up
to 1,000), so a module and its dependency tree are transpiled in one run. The output equals the loader's emit (same
`deno_ast` transform and maps). A syntax error fails the whole call, so a failed batch is split in halves until the
failing modules are isolated. `data:` URLs are decoded in process.

**Offline and errors.** `deno info` has no `--cached-only`: for `cachedOnly`, the `HTTP_PROXY`, `HTTPS_PROXY` and
`ALL_PROXY` of the subprocess point at a closed local port (`127.0.0.1:1`, `NO_PROXY` removed), so every download
fails at once and the `Download` lines name the missing modules (`CACHED_ONLY_MISS`). Exit code 10 (observed with
2.9.7 for a module that does not match `deno.lock`) is `INTEGRITY_MISMATCH`. `deno info` is killed after 10 minutes,
`deno transpile` after 2 (never `spawnSync`; SIGTERM, then SIGKILL, and the child's pipes are destroyed). The
environment (`DENO_DIR`, proxies, `DENO_AUTH_TOKENS`, `JSR_URL`) is captured when the engine is created; the `fetch`
option and `newestDependencyDate` do not apply (Deno downloads and applies the age itself). Performance numbers are
in `src/engine/README.md`. The root module is passed as a `file:` URL: on Windows `deno info` reads an absolute
path's drive letter as a URL scheme and reports the root as an external module without dependencies.

### 4.4 npm packages and the lockfile in the `loader` engine

- The loader downloads npm packages into `DENO_DIR/npm` (`nodeModulesDir: "none"`) or installs them into
  `node_modules/.deno` (`"auto"`) while it adds modules to its graph, and its first installation covers every package
  of the lockfile. With `"manual"` it never installs: the project's `node_modules` is used as it is, and an `npm:`
  requirement it cannot resolve is `RESOLVE_NOT_FOUND` with a hint to install it (the core replaces the hint when the
  package is not a `package.json` dependency, §5.2).
- The loader's Node.js resolution cache (file types and canonical paths, per wasm instance) also records misses and is
  emptied only when a `Loader` is freed. Looking up a file of a package the lockfile names but that is not installed
  yet (`resolveSync` throws `ERR_MODULE_NOT_FOUND` then) leaves a miss that outlives the installation, on every engine
  of the process.
- So until an engine has installed npm packages once, `resolve()` adds an `npm:` requirement to the graph before any
  of its files is looked up, and `resolveSync` leaves such requirements to it (concurrent additions of one requirement
  are shared; a failed one is tried again by the next resolution). Afterwards the synchronous path answers: lockfile
  packages are installed, and other requirements fail it before any file is read (the asynchronous path installs
  them). A non-optional `ERR_MODULE_NOT_FOUND` that may come from the cache (a bare specifier mapped to a package not
  installed yet, a package the user installed meanwhile) goes to the asynchronous path and is retried once after
  emptying the cache (a throwaway `Loader` is created and freed). `jsr:` requirements need none of this: the
  synchronous path returns them unchanged until the asynchronous one has added them to the graph.
- Installation therefore needs no seeding by the host: the Vite dev server, whose inputs are HTML files and which
  meets modules one request at a time, installs packages as it resolves them.
- The engine receives the lockfile path only for an existing version 5 lockfile (§3.4) and never creates one.

---

## 5. Core plugin (`src/core/`)

### 5.1 Options, host context and state

`resolveOptions(user, context)` (`core/options.ts`) validates the options (`OPTIONS_INVALID` for wrong types) and
applies every default in one place. It runs when the plugin is created (to fail early) and again against the host
root once the host reports it. Hooks read only the resolved object.

| Option | Default | Notes |
|---|---|---|
| `cwd` | host root (Vite `root`, esbuild `absWorkingDir`, Rolldown `cwd`, webpack/Rspack `context`, Rsbuild root, otherwise `process.cwd()`) | |
| `config` | discovered (§3.1); a path is relative to `cwd`; `false` disables discovery | |
| `cacheDir` | `<workspaceRoot>/node_modules/.unplugin-deno` (like Vite's `node_modules/.vite`); relative to `cwd` | |
| `engine` | `'auto'` (§4.3) | |
| `denoBinary` | `'deno'` | the `deno` engine's executable |
| `platform` | `'auto'` (§5.6); a string, or a record of Vite or Rsbuild environment names | |
| `conditions` | `[]` (added to the platform's conditions) | |
| `npm` | `'auto'` → `deno-cache` when `nodeModulesDir` is `none`, else `node_modules` (§5.4) | |
| `lockfile` | `'auto'`; `'frozen'`; `'off'` ignores `deno.lock` (§5.13) | `'auto'` acts as `'frozen'` with `CI` set or `lock.frozen` |
| `cachedOnly` | `false` (§4.2, §4.3) | |
| `allowImport` | `DEFAULT_ALLOW_IMPORT`: Deno 2.9.7's `--allow-import` hosts in `host:443` form (`deno.land`, `jsr.io`, `esm.sh`, `raw.esm.sh`, `cdn.jsdelivr.net`, `raw.githubusercontent.com`, `gist.githubusercontent.com`); a value replaces the list (§5.2) | `host`, `host:port`, `*.domain`, IPs, `'*'` |
| `fetch` | `undefined` (`globalThis.fetch` at call time) | `loader` engine only (§4.2) |
| `exclude` | `[]`: patterns (§5.6 syntax) matched against the specifier, left to the host | |
| `importers` | `{ include: [], exclude: [] }`: RegExps or path prefixes (relative ones against `cwd`); an empty `include` admits every importer | |
| `external` / `bundle` | `[]` (§5.6) | |
| `pinExternals` | `null` → `true` for the `deno` platform, else `false` (`pinExternalsFor`); esbuild's `packages: 'external'` also defaults it to `true` | |
| `emitDenoConfig` | `false`; `true` = next to the entry chunk, a string = that directory (relative to `cwd`) (§5.6) | |
| `importAttributes` | `true` (§5.5) | |
| `wasm` | `true` (§5.12) | |
| `importMetaMain` | `true` (§5.10) | |
| `env` | `false`; `{ prefix, allow, files, server }` (§5.10) | an empty prefix or name is `OPTIONS_INVALID` |
| `denoGlobals` | `null` → `'warn'` for the browser platform, else `'off'` (`denoGlobalsFor`) (§5.10) | |
| `jsx` | `'auto'` (§5.11); `'host'` never touches the host config | `'deno'` **(planned)**: accepted, acts like `'auto'` |
| `checks` | `{ browserSafety, duplicates, lockfile }`, all `true`; a boolean sets all three (§5.10, §5.13) | |
| `debug` | `true` when `DEBUG` matches `unplugin-deno` (`debug` package conventions) | |
| `resolve` | `undefined`; a hook `(specifier, importer, { host, platform }) → string \| false \| null \| undefined` (§5.2) | |

`HostContext` (`hosts/shared.ts`): `{ framework, root, command: 'build' | 'serve', platformHint?, conditionsHint?,
logger, version? }`. Everything host-specific the core needs arrives through this object or through the outcome types;
the core never imports a host package.

`PluginState` (`core/state.ts`) is the per-instance build state. Adapters feed host facts through `setHints` (root,
platform, conditions, inputs, version, command) and the logging context through `setLogTarget` (in every hook).
`prepare()` loads the project once, until it is invalidated, and `configure(project)` warns about config problems and
a foreign `node_modules`, derives the platform, conditions, npm strategy, `cacheDir`, mirror generation, allow-list
(§5.2), lockfile policy (§5.13), `jsr:` route (§5.4), mirror and `resolveId` filter, collects old mirror generations
and logs the debug summary (§5.8). Hosts that build several platforms at once (Vite and Rsbuild environments) resolve
with a `ResolveTarget` (`{ platform, conditions?, bundle? }`): the state keeps a resolver and an engine per target,
and a mirror per generation, shared by targets with equal platform and conditions. The state also keeps what spans a
build: `warnOnce` keys, the npm versions bundled per platform (§5.10), the externals per platform (§5.6), the lazily
read `env` values, and `nativeAttributes` (set by adapters whose host passes attributes with every import, §5.5).

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
  node: on the browser platform → warn once (local and mirror importers, §5.10), then null (the host's)
  isExternal(spec, bundle/external, platform, spellings) → external (engine-resolved and pinned when pinExternals),
                                                           recorded for the sidecar (§5.6)

  // 3. engine
  https:/http: → allowImport.check(url) before anything is downloaded
  jsr: on the node_modules route → engine.resolve(npm:@jsr/<scope>__<name>…) (§5.4)
  resolved = engine.resolve(base, referrer, mode)   // missing optional npm dependency → external (fails at runtime,
                                                    // as in Deno); then lockfilePolicy.check (§5.13), except for
                                                    // text/bytes/css targets of remote URLs
  local → path (marker when marked)
  npm   → marker when marked; a `.node` file → external with a warning (§5.10); else record the package version
          (§5.10) and apply the npm strategy (§5.4): npm-redirect | path
  remote | data → allowImport.check(final URL) for remote; ensureMirrored(url, marked ? 'asset' : 'module') → mirror
          (marker when marked)
  node | external → external
```

Never throw for ids we do not own; when the engine fails for an owned id, throw a `DenoPluginError` with a hint and
the importer (hosts show it at the import). Failures are explained on the way out: the lockfile policy turns a
`CACHED_ONLY_MISS` of a requirement `deno.lock` lacks into `NOT_IN_LOCKFILE` and adds the minimum dependency age to a
`RESOLVE_CONSTRAINT` hint (§5.13); a `CACHED_ONLY_MISS` hint names the import and the command that fills Deno's cache
for the build (`deno cache <entries relative to cwd>`, else `deno install`); with `nodeModulesDir: "manual"` a
`RESOLVE_NOT_FOUND` for an `npm:` package that is not a `package.json` dependency says to add it there (or to move it
to `deno.json` with `"auto"` or `"none"`). A marker whose target is a remote or `data:` URL falls back to the URL
itself when the engine refuses it (§5.5). All string handling of ids goes through `core/id.ts`.

**Remote-import allow-list** (`allow-import.ts`, R15). Deno's `--allow-import` for the `https:`/`http:` modules the
plugin downloads. The rules are the `allowImport` option (Deno's defaults unless set) plus hosts that are always
allowed because the project already depends on them: the `remote` entries and `redirects` of `deno.lock`, the
`http(s):` targets of every import map (root, members, links, scopes), and the JSR registries (`https://jsr.io/` and
`JSR_URL`). Entry syntax as Deno 2.9.7 matches it: `host` (any port), `host:port`, `*.domain` (the domain and its
subdomains), IPv4 addresses, bracketed IPv6 addresses (`[::1]:8000`), `*` (everything); host names compare
case-insensitively (IDNs as punycode); a URL without a port has its scheme's default port, so the `host:443` defaults
allow HTTPS only. Checked before anything is downloaded: the resolver checks the URLs it is asked for and the final
URL of an engine resolution (a redirect, or `jsr:` mapped to another registry), the mirror checks the imports of
remote modules before loading them, the final URL of each redirect, and the recorded imports of files it reuses from
an earlier build of the generation (§5.3). A refusal is `DISALLOWED_HOST` naming the host and the importer, with a
hint (`allowImport: [...DEFAULT_ALLOW_IMPORT, '<host>']`, and Deno's `--allow-import=<host>` for running the output);
a disallowed dynamic import inside a remote module is left unchanged (it fails at runtime, as in Deno).

### 5.3 Mirror (`core/mirror.ts`)

Remote (`https:`/`http:`, JSR-resolved) and `data:` modules are materialised as files under `cacheDir` so every host
loads them like ordinary files (Vite prebundles them because the path contains `node_modules`; webpack and Rspack load
them with the user's rules and need no virtual modules; source maps and output paths are readable; the M3 `register`
hook can import them).

Layout: `<cacheDir>/<generation>/<scheme>/<host>/<url path>` where

- `generation` = the first 8 hex of sha256(config generation + plugin version + platform + conditions); the config
  generation hashes the watched files (configs, import maps, package.json files, lockfile). Changing the import map
  or the lockfile changes rewritten specifiers, so it changes the generation. `collectGarbage` (at every project
  load) keeps the current generation and the most recently used other one. A Vite app uses one generation per
  platform (client and server), so concurrent processes building other platforms can remove a generation another
  process still reads (**planned**: collect by age instead).
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
- Each code file has a sibling `.map` and a `//# sourceMappingURL=<name>.map` comment. On disk the map names the
  original as `sourceRoot` + `sources`, which together are the URL (`sourceRoot: "https://jsr.io/@std/path/1.1.6/
  posix/"`, `sources: ["join.ts"]`; `data:` and directory URLs keep `sources: [url]`), with `sourcesContent`: esbuild
  loads mirror files itself and reads the linked map, so its output names the URL. Rollup, Rolldown and Vite resolve
  `sources` against the module's directory as paths, which mangled a URL (`…/posix/https:/jsr.io/…`), so the
  plugin's `load` returns `{ code, map }` with the comment removed and the map's `sources` set to the file name next
  to the mirror file without the appended `.js` (`hostMirrorMap`: `join.ts.js` → `join.ts`) and no `sourceRoot`;
  their output maps then name `node_modules/.unplugin-deno/<generation>/https/jsr.io/…/join.ts`. webpack and Rspack
  load mirror files through the same `load` (§6.5). npm files of Deno's global cache are not mirrored and keep their
  `DENO_DIR` paths.
- `<generation>/manifest.json`: `{ version: 1, generation, modules: {url → entry}, assets: {url → entry}, redirects }`
  with entries `{ file, mediaType, integrity, deps, assets }`. It is a cache (rebuilt when missing or invalid), merged
  with the file on disk when flushed (at `buildEnd`/`closeBundle`, esbuild `onEnd`, webpack/Rspack `done`), so
  concurrent processes only lose cache entries, never files. Reverse lookups (`urlForMirrorPath`) read the manifest
  of the path's generation. All writes are atomic (temp file + rename).

Writing a module (`ensureMirrored(url, kind)`, `kind: 'module' | 'asset'`):

1. `loaded = await engine.load(url, 'default')` (assets and non-code modules: `'bytes'`, from the separate raw
   engine when the main one refuses, §5.5); strip the inline source map comment. A redirect to another host must pass
   the allow-list.
2. Scan the code with `es-module-lexer` 3 (static imports, re-exports and string-literal dynamic imports; attribute
   clauses parsed by `utils/lexer.ts`). For each specifier `s`:
   - on the `node_modules` `jsr:` route (§5.4), a `jsr:` specifier is kept for `resolveId`;
   - `target = await engine.resolve(s, url, 'import')` (the engine knows the package's own import map and exports),
     compared with the lockfile (§5.13; code and JSON imports only);
   - remote/data → allow-list check, `ensureMirrored(target.url)` and rewrite `s` to the **relative path** between
     the two mirror files (`./join.ts.js`, `../fmt/colors.ts.js`), a path with `/` separators and never a URL
     reference (a `%` in a sanitised name stays literal), so hosts resolve it natively;
   - a local target (a JSR package linked into the workspace) → the relative path of the local file;
   - npm → the pinned form `npm:<name>@<version><subpath>` (no absolute paths in the mirror), resolved again by
     `resolveId` when the host imports it;
   - node builtin → `node:<name>`; external (`bun:`, `cloudflare:`) unchanged;
   - `with { type: "text" | "bytes" | "css" }` → `?deno-type=<type>` appended to the rewritten specifier and the clause
     dropped (§5.5); `type: "json"` keeps the clause and points at the raw copy;
   - a dynamic import the engine cannot resolve (or the allow-list refuses) is left unchanged (it fails at runtime, as
     in Deno); a static one fails the build, as does `LOCKFILE_FROZEN_DRIFT`; non-literal dynamic imports are left
     untouched.
   Rewrites use `magic-string`; the final map is `remapping(ourMap, loaderMap)` (`@jridgewell/remapping`).
3. Write file and map atomically and record `integrity` = sha256 of the original source (`sourcesContent[0]` of the
   engine's map for transpiled modules, the bytes otherwise), which equals the `deno.lock` `remote` hash: a mismatch
   is `INTEGRITY_MISMATCH`. Deno locks `json` imports but not `text`/`bytes`/`css` ones, so only those are checked.

`resolveId` returns only after the whole dependency closure is written (hosts resolve the relative paths natively);
cycles are fine because writing a module only *loads* its dependencies to compute their paths. Mirror files are
immutable within a generation: files and manifest entries of the current generation are reused without loading
anything, but their recorded imports are checked against the allow-list and the lockfile's `remote` entries again
(the file may come from a build with other options). If the mirror directory is not writable, fail with
`MIRROR_WRITE_FAILED` and a `cacheDir` hint.

### 5.4 npm strategy (`core/npm.ts`, `core/jsr-npm.ts`)

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
  - webpack / Rspack: the `resolve` hook sets `request = name + subpath` and `context = packageDir` when the host's
    resolver can resolve it from there, else the engine's file (§6.5).
  - Vite dev server: prebundled, keyed on the specifier as written (§6.1).
- Other npm files (global cache, or a file inside a package that the specifier does not name) are `{ type: 'path' }`.
  Global-cache paths carry `moduleSideEffects: false` for `"sideEffects": false` packages, so tree-shaking matches the
  redirect route (lodash-es `chunk`: under 20 KB either way). Imports inside those files come back to `resolveId`
  (the bare filter is active) and are resolved through the engine with the file's URL as referrer.
- **`jsr:` through `node_modules/@jsr`** (R11, `jsr-npm.ts`). Deno 2.9's `"jsrDepsInNodeModules": true` installs
  `jsr:` dependencies from JSR's npm registry (`npm.jsr.io`) into `node_modules/@jsr/<scope>__<name>` and maps
  `jsr:@scope/name@range` import-map entries to `npm:@jsr/scope__name@range` (verified with Deno 2.9.7; both engines
  know the `@jsr` scope's registry). `jsrRouteFor(project, npmStrategy)` picks the `node_modules` route when npm
  packages come from `node_modules` and the project installs JSR packages there (`jsrDepsInNodeModules` in the root
  config, or packages in `node_modules/@jsr/`); otherwise `mirror`. On that route every `jsr:` specifier of the build
  (import-map targets and `jsr:` written in code, subpaths included) becomes `npm:@jsr/<scope>__<name>@<range><sub>`
  and takes the npm strategy, so the host resolves `@jsr/scope__name/<sub>` like any npm package; the mirror keeps
  `jsr:` imports of remote modules for `resolveId`, and JSR sources are never mirrored in the same build (two copies
  of one package). Unlike Deno 2.9.7, subpaths of import-map keys (`@std/path/posix/join`) work. The debug summary
  says which route applies and why.

### 5.5 Import attributes (`core/attributes.ts`)

Deno's `with { type: "text" | "bytes" | "css" }` imports are represented as an id marker: `<file>?deno-type=<type>`.
`json` is left to the host (it handles JSON natively; marking it would create a second instance).

- Where the marker comes from (§5.9 has the host facts): esbuild passes `args.with` for every import, and webpack and
  Rspack pass `attributes` to their `beforeResolve` hook, so those adapters add the marker before resolving and the
  pre-pass is off (`PluginState.nativeAttributes`). Rolldown and Vite pass no attributes to `resolveId` and
  deduplicate `text`/`bytes` imports of one id, and Rollup reuses one resolution per specifier and module, so on the
  Rollup family a `transform` pre-pass with filter `{ id: { exclude: [/^\0/] }, code: /\bwith\s*\{/ }` (joined with
  the source-transform filters of §5.10) rewrites static `import … from 'x' with { type: 't' }` and dynamic
  `import('x', { with: { type: 't' } })` to `'x?deno-type=t'` and drops the clause (verified: the query reaches
  `resolveId` intact and stays a separate module). Rollup's `resolveId` also turns `attributes.type` into the marker,
  for code the pre-pass cannot read. The pre-pass skips virtual ids, other plugins' ids and mirror files; mirrored
  code is rewritten while mirroring (§5.3).
- Parsing: es-module-lexer 3's full build (named fields; `attributesStart` points at the `{`); it drops a clause
  with a trailing comma (`with { type: "text", }`), which `utils/lexer.ts` finds itself. JSX and TSX are not lexable:
  the pre-pass then uses the host parser (`this.parse`, oxc with `lang` from the extension).
- Outcomes: `marker` when the plugin resolves the target (mirror file of the raw asset, local file, npm file) and
  `host-marker` for imports the host resolves (local relative paths, unmapped bare names): the adapter resolves
  `request` with the host (`this.resolve(…, { skipSelf: true })`, `build.resolve`, the webpack/Rspack resolver) and
  adds the marker.
- `load` of a marker id reads the target (local path or mirror file) and synthesises `moduleType: 'js'` code: `text`
  → `export default <JSON string>`; `bytes` → `export default new Uint8Array([…])` up to 1 KiB, base64-decoded with
  `atob` at runtime above; `css` → `const sheet = new CSSStyleSheet(); sheet.replaceSync(<JSON string>); export
  default sheet` (Deno 2.9). `text` and `css` targets must be UTF-8 (`UNSUPPORTED_MEDIA_TYPE`).
- Loader facts: the loader's graph records `css` attributes (and `text`/`bytes` without `"unstable": ["raw-imports"]`)
  as errors, after which `resolve` and even `load(url, 'bytes')` of that URL fail on that loader. Attribute targets
  that are relative or absolute URLs therefore resolve by URL arithmetic, and raw loads the main engine refuses go to
  a second, never-seeded engine (`PluginState.engine('raw')`). The `deno` engine runs `deno info` with
  `--unstable-raw-imports`.
- Host ids (none holds a machine path): Vite resolves markers to `\0deno:<type>:<path>.js` with `<path>` relative to
  the Vite root, `/`-separated, each leading `..` written `~u`, and another drive as `~abs/<path>` (§6.1); esbuild to
  its `unplugin-deno` namespace under paths relative to `absWorkingDir` (§6.4); webpack to `unplugin-deno:<path
  relative to the compiler context>?deno-type=<type>` scheme modules (§6.5); Rspack to empty virtual files under
  `node_modules/.virtual/unplugin-deno/` (§6.6).

### 5.6 Platform model, externals and the sidecar (`core/platform.ts`, `core/sidecar.ts`)

`platform` is derived from **project shape and explicit options**, never from whether the build process runs on Deno
(Deno Deploy runs every build under Deno). `derivePlatform`: the `platform` option when it names a platform (or its
record entry for a Vite or Rsbuild environment); else the host hint when it is `browser` or `deno`; else `deno` when
the project has a `deno.json(c)`, `node` otherwise.

| Host signal | Platform |
|---|---|
| Vite client environments (`consumer === 'client'`) | `browser`, unless a `platform` record names the environment |
| Vite server environments | the `platform` record entry, else a `platform` string, else `deno` with a `deno.json`, else `node` |
| esbuild `platform` | `browser`, also when unset (esbuild's default); `node`/`neutral` → `deno` with a `deno.json`, else `node` |
| Rolldown `platform` | as esbuild; unset counts as `browser` (Rolldown's default for ES output) |
| Rollup (no platform) | `deno` with a `deno.json`, else `node`: browser or Node builds with Rollup set `platform` |
| webpack / Rspack `compiler.platform` (then `target`) | `deno` (webpack `target: 'deno'`) → `deno`; Node.js targets → `deno` with a `deno.json`, else `node`; others → `browser` |
| Rsbuild environment `target` | `web`/`web-worker` → `browser` unless a record names it; `node` → as Vite server environments |

Per platform: the engine platform (`browser` → `'browser'`, others → `'node'`); extra conditions (`deno` → `['deno']`,
then the host's conditions and `conditions`); `node:` external except on the browser platform, where it is left to
the host with a warning (§5.10; Vite keeps builtins itself in every environment, §6.1); `bun:`/`cloudflare:` always
external; `neutral` behaves like `node`. The plugin's empty module (`\0deno:empty`) is reserved for `browser: false`
package mappings; nothing produces it yet (**planned**, R6).

Externals on the `deno` platform (server output for `deno run`/`deno serve`/Deno Deploy): `npm:` and `jsr:` specifiers
(and import-map-mapped bare names, and `package.json` dependencies) are kept external and **pinned** to the version the
engine resolved (`pinSpecifier`: the npm package's version, the version segment of a `https://jsr.io/@scope/name/
<version>/…` URL, else the lockfile's pin): `react` → `npm:react@19.2.0`, `npm:kleur@^4/colors` →
`npm:kleur@4.1.5/colors`, `jsr:@std/path@^1/join` → `jsr:@std/path@1.1.6/join`. The output needs no import map and runs
under `deno run --cached-only` once its externals are cached (tested for every host). `bundle` patterns force
bundling; `external` patterns force externalising on any platform (`https:` is bundled by default). `pinExternals:
false` keeps the *mapped* specifier (`kleur` → `npm:kleur@^4`). A missing optional npm dependency becomes an external
(it fails at runtime, as in Deno). webpack and Rspack drop unplugin's `external: true`, so their adapters return the
externals from an externals function instead (§6.5).

Patterns (`exclude`, `external`, `bundle`) follow `deno bundle`: a RegExp is tested against each spelling of the
import; a string with `*` is a wildcard (`npm:*`, `jsr:@std/*`, `https://esm.sh/*`); any other string matches exactly
or as a package prefix (`npm:kleur` matches `npm:kleur/colors`). `npm:`/`jsr:` specifiers are also tried without their
version (`npm:kleur@^4/colors` as `npm:kleur/colors`), and a mapped bare name is tried in both spellings.

**Sidecar `deno.json` and `deno.lock`** (S3, `sidecar.ts`). A lockfile generated from the sources does not record the
pinned externals, so `deno run --frozen --cached-only` of the output fails without one. The resolver records every
external per platform (`ExternalRecorder`, with the engine's resolution for pinned ones); with `emitDenoConfig`, a
build for the `deno` platform then writes (`writeSidecar`):

- `deno.json`: `{ "lock": "./deno.lock", "nodeModulesDir": "none" }` (without `nodeModulesDir` when the output
  imports bare specifiers, which need a `node_modules` directory; a warning says so);
- `deno.lock` (version 5): the external packages and their dependency closure, copied from the project's lockfile
  (`specifiers`, `jsr`, `npm`, and `remote`/`redirects` when a remote URL is external); packages the project's
  lockfile lacks (or all, without one) are read from Deno's cache (`registry-cache.ts`: JSR `<version>_meta.json`,
  whose sha256 is the integrity, and its module graph for the requirements; npm packuments with `dist.integrity`),
  with the engine resolving their dependencies. Extra entries are harmless to `deno cache --frozen` and `deno run
  --frozen` (verified with Deno 2.9.7). What cannot be described is listed in a warning.

The files go into the `emitDenoConfig` directory (a string, relative to `cwd`) or, for `true`, next to the first
entry chunk: Rollup-family `writeBundle` (`rollupEntryDirectory`: `output.dir` or the `output.file` directory, plus
the entry chunk's directory), Vite `writeBundle` per environment (only environments on the Deno platform), esbuild
`onEnd` (the directory of the first entry output of the metafile, else `outdir` or the `outfile` directory; nothing
with `write: false` or errors), webpack and Rspack `done` (`output.path`). Other platforms write nothing, and a
directory where the file would overwrite the project's own config or lockfile gets a warning instead. The integration
tests run the output with the sidecar in a fresh `DENO_DIR` (`deno cache`, which must leave the lockfile unchanged,
then `deno run --frozen --cached-only`) for Rollup, Rolldown, Vite and esbuild, with and without a project lockfile.

### 5.7 Watch and invalidation (`core/watch.ts`)

- Watched: every file in `Project.watchFiles` (configs, external import maps, `package.json` files, the lockfile).
  Hosts: Rollup/Rolldown `this.addWatchFile` in `buildStart` + `watchChange`; Vite's dev server watcher (§6.1);
  esbuild `watchFiles` on owned results and a content snapshot compared in `onStart` (§6.4); webpack and Rspack
  `fileDependencies` (a lockfile not created yet as a `missingDependencies` entry), `buildDependencies` for the
  persistent cache, and a reload in `watchRun` for the changed files (§6.5, §6.6).
- On change (`invalidateProject`): flush the mirror manifest, dispose the engines (they cache the old config and
  lockfile), reload the project and `configure` it again (platform, generation, mirror, filter); the mirror is
  rewritten lazily under the new generation. Vite also invalidates every environment's module graph and sends a full
  reload; Rspack, which keeps its module graph between rebuilds, rebuilds the importers of the plugin's requests.
- Local source edits need nothing from us (the host loads local files). Marker targets are watched (Vite
  `addWatchFile`, webpack `addDependency`, Rspack through unplugin's `load` loader), so edits update their importers.
  Remote modules change only with the lockfile or the generation (the mirror reuses a generation's files), so pinned
  content is stable.

### 5.8 Diagnostics (`src/diagnostics/`, `core/checks.ts`)

`DenoPluginError extends Error { code: ErrorCode; hint?: string; specifier?: string; importer?: string; cause? }`
with the codes of `ERROR_CODES`, all raised: `OPTIONS_INVALID`, `CONFIG_NOT_FOUND`, `CONFIG_INVALID`,
`IMPORT_MAP_INVALID`, `LOCKFILE_INVALID`, `RESOLVE_NOT_FOUND`, `RESOLVE_NOT_EXPORTED`, `RESOLVE_UNMAPPED_BARE`,
`RESOLVE_CONSTRAINT`, `RESOLVE_FAILED`, `NOT_IN_LOCKFILE` (§5.13), `LOCKFILE_FROZEN_DRIFT` (§5.13),
`CACHED_ONLY_MISS`, `DISALLOWED_HOST` (§5.2), `INTEGRITY_MISMATCH`, `MIRROR_WRITE_FAILED`, `ENGINE_UNAVAILABLE`,
`UNSUPPORTED_MEDIA_TYPE`, `PLATFORM_INCOMPATIBLE` (`Deno.*` in a browser bundle with `denoGlobals: 'error'`, §5.10).
Messages are one sentence; `hint` says what to do ("run `deno install`", "add `X` to `imports`", "set `cacheDir`").
`format()` prints `[unplugin-deno] <message> (<code>)` plus `hint: …`. `isDenoPluginError` also recognises errors
from another copy of the package.

`Logger { debugEnabled, error, warn, info, debug, downloading(url) }`. The host logger (`hosts/shared.ts`) sends
warnings (and `error` lines, logged but never thrown: Rollup's `this.error` throws) through `this.warn`, info and debug
lines through `this.info`, and falls back to stderr without a context; Vite's watcher uses `config.logger`; esbuild
buffers warnings for `onStart`/`onEnd` (§6.4); webpack and Rspack push warnings into the current compilation's
warnings and send info and debug lines to the infrastructure logger (`CompilationLog`). `debug` is enabled by
`options.debug` or `DEBUG=unplugin-deno`; debug lines are prefixed with the subsystem (`[core]`, `[engine]`,
`[mirror]`, `[lockfile]`, `[resolve]`, `[sidecar]`, `[vite]`, `[webpack]`, …). `PluginState.warnOnce(key, message)`
keeps repeated warnings (browser-safety, `Deno.*`, precompile, foreign `node_modules`) to one per plugin instance.

`addEntrypoints` diagnostics with a code (e.g. `CACHED_ONLY_MISS`, `INTEGRITY_MISMATCH`) are warnings; the others are
debug output, because the graph also holds imports the host owns (`?raw`, packages from `node_modules`, other plugins'
virtual ids) that Deno reports as errors, and failing owned imports fail in `resolveId` with their importer. The debug
summary, logged by `configure`, lists: plugin version and host, engine kind (the selection reason follows as an
`[engine]` line), config path, workspace root with member and link counts, lockfile and its mode (§5.13),
`nodeModulesDir` + detected layout + npm strategy, the `jsr:` route (§5.4), platform + conditions, the allow-list
(§5.2), `cacheDir` + generation.

### 5.9 Host capabilities the core relies on

| | Rolldown | Vite 8 / 7 | Rollup 4 | esbuild | webpack 5 / Rspack 2 |
|---|---|---|---|---|---|
| Root | `cwd` | `root` (symlinks resolved) | none (`process.cwd()`, or `cwd`) | `absWorkingDir` | `compiler.context` (Rsbuild: `rootPath`) |
| Platform hint | `platform` (unset = `browser`) | per environment (§6.1) | none | `platform` (unset = `browser`) | `compiler.platform`, else `target`; Rsbuild per environment |
| Conditions hint | `resolve.conditionNames` | none (Vite applies its own) | none | `conditions` | the user's `resolve.conditionNames` |
| `resolveId` filter | narrowed in `options` (broad in watch mode) | broad | none (all ids) | Go-side, fixed at `setup` | precise once loaded (per target in Rsbuild) |
| Attributes | none in `resolveId` | none in `resolveId` | `options.attributes`, one resolution per specifier and module | `args.with`, per import | `beforeResolve` `attributes`, per import |
| Attribute pre-pass | yes | yes | yes | no | no |
| Host resolution (redirects, host markers) | `this.resolve` + `skipSelf` | `this.resolve` + `skipSelf` | `this.resolve` + `skipSelf` (`null` without node-resolve) | `build.resolve` | the normal resolver from the package directory |
| `moduleType` from `load` | yes (`js`) | returned (`js`) | no | loader `js` for synthesised modules | `javascript/esm` rules for synthesised modules |
| Source transforms (§5.10) | `transform` (oxc `this.parse`) | `transform` (oxc on Vite 8) | `transform` (token scanner for TS) | none: `define` and `onLoad` | a `pre` loader rule |
| Watching | `addWatchFile`, `watchChange` | dev server watcher; `watchChange` in build watch mode | `addWatchFile`, `watchChange` | `onStart` snapshot, `watchFiles` | `fileDependencies`, `watchRun` |

Why: Rolldown (and thus Vite 8) does not pass import attributes to `resolveId` and deduplicates `text`/`bytes` imports
of one id (rolldown#2758); Rollup exposes attributes but resolves each specifier once per module whatever its
attributes (`import a from "x" with { type: "text" }` and `… "bytes"` in one module become one module, with
`INCONSISTENT_IMPORT_ATTRIBUTES`); esbuild, webpack and Rspack key modules per attribute. Rolldown reads hook filters
when it builds its plugin bindings, after the `options` hook, so its adapter loads the project there. In watch mode,
and in Vite (whose dev server reloads the project in place, §6.1), the import map can change under the same hooks, so
those keep the broad filter. `resolvedBy` is never set by Vite 7/8 or Rolldown (only by Rollup), so the import map is
authoritative for its keys instead of letting other plugins answer first (§5.2).

### 5.10 Source transforms and checks (`core/source.ts`, `core/env.ts`, `core/checks.ts`)

The `transform` hook (`PluginState.transform`) applies, after the import-attribute pre-pass (§5.5), the parts of
Deno's semantics that hosts do not know, to script modules only (`.[cm]?[jt]sx?` files and framework script blocks
with a `lang.<ext>` query; not CSS, HTML or framework files):

- **`import.meta.main`** (L7, `importMetaMain`) becomes `false` outside entry modules: bundled into an entry chunk, a
  module would otherwise see the entry's `import.meta.main`. Entries keep theirs (Rollup family:
  `this.getModuleInfo(id).isEntry`; webpack and Rspack: the resources resolved for dependencies without an issuer, or
  for workers on webpack). Applies to local files, mirror files and npm package files; not in Vite's dev server,
  which serves modules unbundled; assignments (`import.meta.main = …`) are left alone.
- **Environment variables** (L9, `env`): reads with a literal key, `Deno.env.get("X")`, `process.env.X` and
  `process.env["X"]`, of allowed variables (a name starting with one of `env.prefix`, or listed in `env.allow`)
  become JSON literals (`undefined` for an allowed variable that is not set). Values come from `process.env` over the
  `.env` files (`env.files`, by default `.env` and `.env.local` where they exist; a later file wins; a listed file
  that is missing is a warning), parsed with `node:util`'s `parseEnv` and read once per project load. Only for the
  browser platform unless `env.server`, in local and mirror files (not npm packages). `Deno.env.toObject()` and other
  reads stay as they are.
- **`Deno.*` in browser bundles** (L10, `denoGlobals`): local modules of a browser bundle that reference `Deno.<member>`
  are reported once per file with the first location and up to three members (`src/server-only.ts:3:10` and
  `Deno.cwd`, say); `'error'` throws `PLATFORM_INCOMPATIBLE` instead. Inlined env reads do not count.

One scan finds all three (`scanSource`): with the host's parser when it can parse the module (Rolldown and Vite 8 parse
TypeScript and JSX with oxc; Rollup's `this.parse` reads only JavaScript), otherwise with `utils/js-tokens.ts`, a
forgiving tokenizer that skips strings, comments, template text and regular expressions. The token scanner cannot tell
TypeScript types from values, so it counts `Deno.<member>` as a runtime reference only when the member starts in lower
case (`Deno.cwd`, `Deno.env`), follows `new`, or is itself called or accessed (`Deno.Command(`, `Deno.X.y`): types such
as `Deno.Kv` are PascalCase. JSX text is not understood by it, which can only hide references, never invent them. The
hook's `code` filter (`transformCodeFilter`) joins the patterns of the enabled features (`\bwith\s*\{`,
`import\.meta\.main`, `Deno\.env\.get|process\.env`, `\bDeno\.`); with none enabled there is no `transform` hook.
Host specifics: esbuild has no transform hook (inlined `process.env` keys become `define` entries, `import.meta.main`
is replaced only in mirror files it loads, no `Deno.*` check, §6.4); webpack and Rspack run the hook as a `pre` loader
on local files and in the mirror files' `load` (§6.5).

Checks (X3, X4, S5; `checks.browserSafety`, `checks.duplicates`), all warnings logged once:

- a local or remote module of a browser bundle importing a `node:` builtin, with the importer (`src/main.ts →
  node:path`); imports inside npm packages are the package's business;
- an npm package resolving to a native addon (`.node`, any platform): kept external (it cannot be bundled);
- npm packages bundled in several versions, per platform, recorded by the resolver and reported when a build ends
  (Rollup family `buildEnd`, per environment in Vite; esbuild `onEnd`; webpack/Rspack `finishModules`);
- with `nodeModulesDir: "auto"`, a `node_modules` another package manager installed (§3.1): Deno will re-link its
  packages; the warning suggests `"manual"` or a Deno-only `node_modules`.

Not implemented (**planned**): CommonJS-only packages reaching a browser bundle and the full import chain of X3,
`import.meta.filename`/`dirname` for the browser (L7), DCE-friendly constants such as `IS_BROWSER` (L9).

### 5.11 JSX (`core/jsx.ts`)

Local files are transpiled by the host, so the `compilerOptions.jsx*` settings of the nearest `deno.json` (merged over
the workspace root's, §3.4) become host options (`jsxTransformFor`). Nothing is changed with `jsx: 'host'`, for a
disabled project, when neither config sets `jsx`, `jsxImportSource`, `jsxFactory` or `jsxFragmentFactory` (Deno's
default, the classic `React.createElement`, would override the host's own default), and for the `preserve` and
`react-native` modes. Deno's modes map to a host-neutral `JsxTransform`: `react` → the classic runtime with
`jsxFactory`/`jsxFragmentFactory` (globals, as in Deno); `react-jsx` → the automatic runtime with `jsxImportSource`
(default `react`); `react-jsxdev` → the automatic runtime in development mode; `precompile` → the automatic runtime
and a warning once per plugin instance (no host precompiles JSX; `jsx: 'deno'`, which would precompile local files
with Deno, is **planned** and acts like `'auto'`). `jsxImportSource` stays a specifier (`preact`, `npm:preact@10`):
the host imports `<source>/jsx-runtime`, which the plugin resolves through the import map like any other import.

The adapters apply the transform only when the host config sets no JSX itself:

- Vite (`config`): `oxc.jsx` on Vite 8; `esbuild.jsx*` on Vite 7, and on Vite 8 configs that set `esbuild` options
  without `oxc` (Vite converts them and would ignore them next to `oxc`); nothing when the config sets `oxc.jsx` or an
  `esbuild.jsx*` key, or turns the transform off (`oxc: false`, `esbuild: false`). The classic runtime turns Oxc's
  development mode off (Vite enables it outside production and it would pass `__source`/`__self` to the factory).
- Rolldown (`options`): `transform.jsx` unless set.
- Rollup (`options`): the `jsx` option unless set, for the JSX a TypeScript plugin preserves; the automatic runtime
  becomes `{ mode: 'automatic', factory: 'createElement', importSource, jsxImportSource: '<source>/jsx-runtime' }`.
  Rollup has no development runtime (`react-jsxdev` compiles like `react-jsx`).
- esbuild (`setup`): `jsx`, `jsxImportSource`, `jsxDev` or `jsxFactory`/`jsxFragment` unless the build sets one.
- webpack, Rspack, Rsbuild (`hosts/webpack/jsx.ts`): the options of the JSX loaders in `module.rules` that do not
  configure JSX: `esbuild-loader` (`jsx`, `jsxImportSource`, `jsxDev`/`jsxFactory`, `jsxFragment`; configured when one
  of esbuild's JSX options or `tsconfigRaw.compilerOptions.jsx*` is set) and `builtin:swc-loader`/`swc-loader`
  (`jsc.transform.react` with `runtime`, `importSource`, `development`/`pragma`, `pragmaFrag`; configured when
  `runtime`, `importSource`, `pragma` or `pragmaFrag` is set), found by package name or path in `loader`, `use`
  (strings, objects, arrays; not functions), `oneOf` and nested `rules`; changed rules are copies. An info line says
  what to set when no such loader exists (webpack's `experiments.typescript` cannot compile JSX). Rsbuild sees the final
  Rspack rules, after `tools.swc` and plugins such as `@rsbuild/plugin-react`.

### 5.12 Wasm (`core/wasm.ts`)

`import { add } from "./add.wasm"` (no attribute, no query) instantiates the module and exposes its exports, as in
Deno and `deno bundle` (L6, `wasm`, default `true`). The plugin's `load` synthesises JavaScript for such ids
(`WASM_MODULE_ID_FILTER` = `/\.wasm$/i`, no query; `?init`/`?url` stay the host's): the bytes inlined as base64 and
decoded with `atob` (no `Uint8Array.fromBase64` needed), a synchronous `new WebAssembly.Module`/`new
WebAssembly.Instance`, one namespace import per module the Wasm imports from (read with `WebAssembly.Module.imports`
at build time; names starting with `./` or `../` resolve against the `.wasm` file as absolute paths, other names such
as `env` or `npm:x` are imported as written), and one export per instance export (`export const <name>`, or an
aliased export for names that are not identifiers). Invalid bytes are `UNSUPPORTED_MEDIA_TYPE`. Browsers limit
synchronous compilation on the main thread to small modules (4 KB in Chromium); workers and server runtimes have no
such limit. Remote `.wasm` modules are mirrored as raw assets (§5.3).

Hosts: the Rollup family and Vite through the generic `load` filter; esbuild with an `onLoad` for `.wasm` unless the
build gives `.wasm` a loader of its own; webpack and Rspack with a rule for `.wasm` module imports (no query, no import
attribute, not `new URL()`) of local and mirror files, while the `.wasm` files of npm packages keep the host's own Wasm
support (`experiments.asyncWebAssembly`, asynchronous instantiation). `wasm: false` leaves every `.wasm` file to the
host (Vite `?init`, `@rollup/plugin-wasm`, webpack's `asyncWebAssembly`). Source-phase imports are not supported
(**planned**).

### 5.13 Lockfile policy (`core/lockfile-policy.ts`, `core/registry-cache.ts`)

`lockfileModeFor(option, project, env)` decides a build's mode and why: `lockfile: 'off'` → `off` (the project is
loaded without a lockfile, so the engines get `noLock`/`--no-lock`); `'frozen'` → `frozen`; `'auto'` → `auto` without a
lockfile, else `frozen` when `CI` is set (to anything but `''`, `0`, `false`, `no`, `off`) or `deno.json` sets
`"lock": { "frozen": true }`, else `auto`. The engines honour the lockfile's pins themselves; the policy compares their
resolutions with it (`lockfileDrift`):

- `npm` resolutions: the package version must be locked, and for a top-level requirement (`npm:kleur@^4.1.5`) the
  lockfile's pin must name that version; imports inside npm packages check the package only; not with
  `nodeModulesDir: "manual"`, where the project's package manager installs;
- JSR modules (a registry URL `<registry>/@scope/name/<version>/…` requested as `jsr:@scope/name…`): the same for the
  JSR package; relative imports between files of one JSR package are locked with the package;
- other remote URLs: a `remote` entry must exist (following `redirects`); local files, `data:` URLs, builtins and the
  `text`/`bytes`/`css` targets of remote URLs are not locked.

Checked in the resolver after every engine resolution (§5.2) and in the mirror for the imports of remote modules,
including files it reuses (§5.3). In `frozen` mode a drift throws `LOCKFILE_FROZEN_DRIFT` (`deno.lock is out of date:
npm:kleur@^4.1.5 resolved to 4.1.5, but deno.lock has no entry for it (it locks kleur 4.1.4).`, hint: run
`deno install` and commit the lockfile; without a lockfile every locked kind drifts). In `auto` mode, with
`checks.lockfile` and a lockfile, it is a debug line (`[lockfile] … (NOT_IN_LOCKFILE); allowed by lockfile: 'auto'`).
`off` checks nothing.

Explanations (X5, `checks.lockfile`): `explainFailure` turns a `CACHED_ONLY_MISS` of a requirement the lockfile lacks
into `NOT_IN_LOCKFILE` (run `deno install` with network access), and adds to a `RESOLVE_CONSTRAINT` whose matching
versions are all younger than the minimum dependency age a hint that lists them with their publish times and names the
cutoff and its source (Deno's 24 h default or `minimumDependencyAge`). With debug output on, a newly resolved
requirement whose newer matching versions the age held back gets a debug line. The metadata comes from Deno's cache
only (`registry-cache.ts`: npm packuments `npm/<registry>/<name>/registry.json` with `time` and `dist.integrity`, JSR
`meta.json`/`<version>_meta.json` under `remote/<scheme>/<host>[_PORT<port>]/<sha256 of path and query>`, as
`deno_cache_dir` names them); nothing is downloaded, and missing metadata means no explanation.

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
  the mirror directory, marker ids, `\0deno:` ids and, with `wasm`, `.wasm` ids); `transform` (the attribute pre-pass
  and the source transforms, §5.10, with `transformContext`: the host parser and `getModuleInfo(id).isEntry`);
  `watchChange`; `buildEnd` (duplicate report, then flush in watch mode, else flush and dispose the engines);
  `writeBundle` (the sidecar, §5.6).
- `toRollupResult` (`hosts/shared.ts`): `path`/`mirror`/`marker`/`virtual` → `{ id }` (`moduleSideEffects: false` for
  `"sideEffects": false` packages); `npm-redirect` → the host's resolution of `request` from `packageJsonPath` (query
  appended, `moduleSideEffects` forwarded), `fallbackPath` when it answers `null`; `host-marker` → the host's
  resolution of `request` from the importer, with the marker; `external` → `{ id, external: true }`.
- esbuild gets only `{ name, esbuild: { setup } }` (§6.4).
- webpack gets `webpack(compiler)`, Rspack `rspack(compiler)` and Rsbuild `rsbuild.setup(api)` (§6.5, §6.6).
- Bun, Farm and unloader get an inert `{ name }` plugin (options are still validated) (**planned**, §6.7).

### 6.1 Vite 8 (and 7)

`hosts/vite/`, merged over the generic hooks; tests in `test/integration/vite.test.ts` (builds) and
`vite-dev.test.ts` (dev server), each run on Vite 8 and on Vite 7 (the `vite7` devDependency alias). `vite` is imported
for types only, so other hosts never load it; the version comes from `this.meta.viteVersion`.

- **`config`** resolves the root like Vite (`resolve(root)`, symlinks resolved unless `preserveSymlinks`), sets hints
  (the build's own platform is the client's, `browser`; other environments resolve with a target) and loads the
  project. It applies the `deno.json` JSX settings (§5.11). It appends to the configured aliases (which win) the
  path-like import-map entries (D4, `importMapAliases`): bare keys whose target is a local file or directory
  (`"@styles/": "./src/styles/"`, `"@app/theme": "./theme.css"`) from the root `imports` with the scope containing
  the Vite root (a member-rooted app) over it, never `jsr:`/`npm:`/URL targets, keys other scopes redefine or keys
  matched by `exclude`, so what Vite resolves without user plugins sees them (tested with CSS `@import`). In the dev
  server it also appends `{ find: /^(https?:\/\/|data:)/, replacement: '$1' }` (never `'$&'`, which breaks Vite 8
  builds): dev import analysis skips URLs no alias matches. The hook mutates `resolve.alias` because an alias
  returned from `config` is placed first and would shadow user aliases. It registers a second plugin instance (its
  own state) in `worker.plugins` (D7), so Vite's worker bundles resolve Deno specifiers (tested with a `?worker`
  import); that instance does not register itself again. For a Deno project without a `package.json` between the
  root and the workspace root it defaults `cacheDir` to `<root>/node_modules/.vite` (Vite would pick an ancestor's
  `node_modules`; denoland/deno-vite-plugin#87).
- **`configEnvironment`**: server environments on the Deno platform get `resolve.conditions` and
  `resolve.externalConditions` with `deno`: Vite's defaults (`defaultServerConditions`, `defaultExternalConditions`,
  equal in 7 and 8) plus `deno` when the environment sets none (a configured list replaces the defaults), else only
  `deno` (Vite concatenates returned arrays). In the dev server every environment's `optimizeDeps` gets the optimizer
  plugin (below).
- **`configResolved`** records host facts and, in the dev server, extends `server.fs.allow` with the mirror and the
  workspace root (real paths too): a `server.fs.allow` returned from `config` would replace Vite's default (the
  searched workspace root) instead of extending it. (Vite ≥ 8.0.9 detects JSON `deno.json` workspaces itself; Vite 7
  and JSONC configs do not.)
- **Platform per environment** (`environment.ts`): §5.6. `resolveId` and `transform` use the target of
  `this.environment` (`{ platform, conditions: [] }`: Vite's own `resolve.conditions` apply to what Vite resolves).
- **Dev server externals.** Vite's module runner runs server environments inside the dev server's runtime and cannot
  load `npm:`/`jsr:` externals (`fetchModule` node-resolves bare-looking ids; dev import analysis ignores
  `external: true`; vitejs/vite#20828, #20850), so in the dev server Deno server environments resolve with
  `bundle: ['npm:*', 'jsr:*']`: JSR through the mirror, npm through redirects (inlined by the runner, so CommonJS
  packages need `ssr.optimizeDeps`), in the same mirror generation as the build. Builds keep them external and pinned;
  Vite neither re-externalises nor inlines them, and `noExternal` is never set.
- **`node:` builtins** are left to Vite in every environment: its builtin externals are side-effect free, while an
  `external: true` from the plugin kept an unused `import "node:module"` of Rolldown's runtime in Vite 8 SSR output.
- **Markers** resolve to `\0deno:<type>:<path>.js` (`marker.ts`, §5.5): `vite:css` claims every id matching
  `\.css(?:$|\?)`, `vite:json` `\.json(?:$|\?)` and framework plugins `\.vue` plus a query, whatever the query holds,
  so the extension is hidden. `<path>` is relative to the Vite root with `/` separators so dev-server URLs round-trip
  (`/@id/__x00__deno:text:src/…`); a leading `..` (which the browser would collapse) is `~u`, and a target on another
  drive (or whose relative path starts with `~`) is `~abs/<absolute path>`. `load` calls `addWatchFile(file)`, so edits
  of the target update its importers. `load` also serves mirror files and `.wasm` modules (§5.12).
- **`transform`** runs the pre-pass and the source transforms (§5.10) for the platform of `this.environment`;
  `import.meta.main` is replaced only in builds.
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
  `buildStart` seeds the environment's engine with the build's module inputs (HTML skipped); `buildEnd` reports
  duplicate npm packages for the environment's platform, then flushes in build watch mode and closes otherwise (a dev
  server calls it once, when it closes); `writeBundle` writes the sidecar of an environment on the Deno platform
  (§5.6).
- Not done: the opt-in `resolve.builtins` experiment (`/^npm:/`, `/^jsr:/` when the dev server runs under Deno; S4,
  **planned**).
- Measured (`vite-spa`, fresh fixture copy, warm `DENO_DIR`, macOS, at the end of M1): first
  `transformRequest('/src/main.ts')` 0.22–0.39 s on Node 26, 0.25–0.39 s on Deno 2.9.7, 0.26–0.42 s on Bun 1.3.14
  (the upper bound includes loading the wasm); the whole page with its four prebundled dependencies 0.31–0.53 s; one
  optimizer run.

### 6.2 Rolldown (and tsdown)

- `options(inputOptions)` records the hints (`cwd` as root, `platform` with `undefined` → `browser`,
  `resolve.conditionNames`, `input`, the Rolldown version), loads the project, narrows the `resolveId` filter
  (outside watch mode) and the `load` filter (§5.9), and sets `transform.jsx` from `deno.json` unless it is set
  (§5.11).
- `resolveId: { filter, handler(id, importer, { kind, isEntry }) }` (no attributes: the generic pre-pass handles them);
  npm redirects and host markers call `this.resolve(request, importer, { skipSelf: true, kind })`, which returns
  `{ id, external, packageJsonPath, moduleSideEffects, meta }`; `moduleSideEffects` is forwarded.
- `load` returns `{ code, map, moduleType: 'js' }` for mirror files, markers, `.wasm` modules and `\0deno:empty`
  (Rolldown would otherwise pick a module type from `.txt`/`.css`).
- `closeBundle` flushes the manifest and, outside watch mode, disposes the engines; the generic `buildEnd` does the
  same.
- tsdown takes Rolldown plugins. Its default `platform` is `node`, so a project with a `deno.json` builds for Deno
  unless the `platform` option is set. `examples/tsdown-lib` (tsdown 0.23, run by the CI examples job) builds a Deno
  output and a browser output; the package's own suite has no tsdown test.
- Optional, not done: an `order: 'post'` terminator with a `custom` probe to detect whether another plugin resolved a
  mapped key first.

### 6.3 Rollup 4 (≥ 4.40 for native filters)

- `options(inputOptions)` records the inputs and the Rollup version, and sets Rollup's `jsx` option from `deno.json`
  unless it is set (§5.11). Rollup has no root and no platform: the root is `process.cwd()` unless `cwd` is set, and
  the platform follows §5.6.
- `resolveId(source, importer, { attributes, isEntry })` has no id filter: imports carrying attributes (local
  `./data.txt` included) must reach it, and filters only see the id. `attributes.type` becomes the marker; the generic
  pre-pass stays on (§5.5, §5.9).
- `load: { filter, handler }` uses the native filter on Rollup ≥ 4.40 and checks the id again for older versions.
  Rollup has no `moduleType`; mirror output is JavaScript. `closeBundle` as for Rolldown. Rollup's `this.parse` reads
  only JavaScript, so the source scan of TypeScript uses the token scanner (§5.10).
- Rollup cannot load TypeScript, JSON or CommonJS and resolves nothing from `node_modules` by itself: users add their
  usual plugins after this one (without a node-resolve plugin, redirects get the engine's `fallbackPath`). The
  integration tests use a small esbuild TypeScript plugin that preserves JSX and a JSON plugin
  (`test/helpers/rollup-ts.ts`) and skip the CommonJS and `@jsr` fixtures (`SKIPPED` in
  `test/integration/core-suite.ts`).

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
  is needed. There is no `/.*/` filter outside the plugin's own namespace.
- **Results.** Local, mirror and global-cache files are `{ path }` in the `file` namespace (esbuild loads them with its
  own loaders and reads the mirror's linked source maps); externals are `{ path, external: true }`; marker modules
  are synthesised by `onLoad({ filter: /.*/, namespace: 'unplugin-deno' })` with `loader: 'js'`, under paths relative
  to `absWorkingDir` (`paths.ts`; the core id travels in `pluginData`), so output comments, source maps and the
  metafile have no machine paths and no `\0`.
- **`onLoad` for files**: `.wasm` modules (§5.12) unless the build has a `.wasm` loader, and the mirror files that
  contain `import.meta.main` and are not entry points (`mirror.ts`: replaced with `false`, the mirror's map composed
  with that edit and inlined). Everything else is loaded by esbuild.
- **Build options** set in `setup` (a context keeps them for its rebuilds): the `deno.json` JSX settings unless the
  build sets JSX (§5.11), and, when `env` inlines for the build's platform, one `define` entry per allowed variable
  with a value (`process.env.<KEY>` → its JSON string, §5.10). `Deno.env.get()` reads are not inlined and `Deno.*` is
  not checked: esbuild has no transform hook.
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
  the manifest, reports duplicate npm packages, writes the sidecar (§5.6) and returns the buffered warnings; the last
  `onDispose` disposes the engines. `onDispose` runs after `build()` has resolved (a `setTimeout`), so plugin reuse is
  tracked per *running* build (`onStart`…`onEnd`, which esbuild calls even after `onStart` errors and cancellations):
  builds may reuse an instance one after the other with any settings (the project is reloaded) and concurrently with
  equal settings (`absWorkingDir`, `platform`, `conditions`, `packages`); a concurrent build with other settings fails
  with `OPTIONS_INVALID`. After an `onStart` error esbuild still resolves every import; owned imports are then
  returned as externals so the build fails with that one error.
- **Messages** (`messages.ts`). Errors are returned as esbuild messages (`<message> (<code>)`, the hint as a note, the
  error in `detail`), so esbuild shows them at the import; warnings are buffered and returned from `onStart`/`onEnd`.
  esbuild has no informational channel for plugins, so debug output goes to stderr.

### 6.5 webpack (5.108+)

`hosts/webpack/`, under unplugin's `webpack(compiler)` escape hatch; tests in `test/integration/webpack.test.ts`
(webpack 5.111, TypeScript through `esbuild-loader` with `target: 'esnext'`). unplugin's generic `resolveId` never
sees scheme requests on webpack (`jsr:`, `npm:` and `https:` take the `resolveForScheme` path, or a preset keeps them
external first) and its `external: true` is ignored, so the adapter uses webpack's own hooks. `requests.ts`,
`presets.ts`, `transforms.ts` and `jsx.ts` are shared with the Rspack and Rsbuild adapters (§6.6).

- **Request routing** (`requests.ts`, `Router`). webpack decides externals (in `factorize`) before it resolves, only
  `beforeResolve` sees import attributes and only the externals function sees the dependency type. So the router
  notes the attribute type of every request in `beforeResolve`; an `ExternalsPlugin` applied in `apply` (before the
  config's externals and presets) resolves the requests the plugin owns (the precise filter, §5.2) once per attribute
  type and import mode, and returns external outcomes as native externals: `module-import` in ES module output
  (`output.module`), `node-commonjs` for `require()`, `import` for browser scripts; the `normalModuleFactory.hooks
  .resolve` hook then applies the other outcomes by rewriting `resolveData.request` (local, npm and mirror files: the
  absolute path, `#` escaped as `\0#`; npm redirects: `name + subpath` with the package directory as `context` when
  webpack's normal resolver resolves it from there, else the engine's file) and adds the config files to the
  resolution's dependencies. URL-like dependencies (CSS `url()`, `new URL()`, HTML) are never the plugin's. Errors
  become webpack errors at the import (`[unplugin-deno] <message> (<code>)` and the hint, `toHostError`).
- **Synthesised modules** (`synthetic.ts`): markers and the plugin's virtual ids are `unplugin-deno:` scheme requests
  (`unplugin-deno:src/data.txt?deno-type=text`, relative to the compiler context): `resolveForScheme` gives them a
  JavaScript mimetype, a `{ scheme, type: 'javascript/esm' }` rule (after webpack's `with { type }` rules, which would
  make them assets) types them, and `NormalModule.getCompilationHooks(compilation).readResource` reads them from
  `state.load`, adding the marker's target as a dependency. Mirror files and local files are real files.
- **Presets** (`presets.ts`, S6). `externalsPresets.web` (webpack's default for web targets; since 5.102 it also covers
  `jsr:` and `npm:`) and 5.108's `target: 'deno'` preset keep Deno specifiers external before any resolver runs. In
  the `environment` hook (after webpack applied its defaults, before the presets are applied) the adapter turns off
  the presets the config did not set explicitly, applies their behaviour itself to every request the plugin leaves to
  webpack (CSS `url()` and `@import` of remote URLs, `//` and `std:` imports, bare Node.js builtins as `node:`
  externals on `target: 'deno'`), and logs what it decided at info level. Presets set explicitly stay on and run after
  the plugin's externals. `target: 'deno'` gives the Deno platform, so `npm:`/`jsr:` stay external and pinned.
  `experiments.buildHttp`: the `http(s):` URLs its `allowedUris` allow are left to webpack; the others come from the
  mirror.
- **Setup.** The project is loaded in `beforeRun`/`watchRun` (before webpack compiles `module.rules`;
  `beforeCompile` as a fallback, which also seeds the engine with the entries once), where the rules of
  `transforms.ts` are appended and `jsx.ts` configures the JSX loaders (§5.11). Host facts: `compiler.platform`
  (`platformHint`), `compiler.context`, `compiler.options.entry` (relative entries resolved from the context, requests
  with inline loaders and entry functions skipped), the user's `resolve.conditionNames`.
- **Rules** (`transforms.ts`): a `pre` rule runs `state.transform` through unplugin's public `transform` loader on
  local script modules (`.[cm][jt]sx?` outside `node_modules`, the mirror and Deno's npm cache; not `?raw` or `new
  URL()` assets) before the user's TypeScript loader, on the source as written (the token scanner); `afterResolve`
  records the entry modules (no issuer, or a worker) that keep `import.meta.main`; the `.env` files become module
  dependencies. Mirror files are loaded through unplugin's `load` loader (`state.load`: the code without its
  `sourceMappingURL` comment and the map, so output maps hold the remote sources named next to the mirror file) and
  transformed in the same hook, the edit's map composed over the mirror's. `.wasm` module imports of local and mirror
  files are loaded as the core's instantiating module (§5.12). Loader idents hash the transform settings (platform,
  options, inlined values) for the persistent cache. npm package files are not transformed: webpack evaluates their
  `import.meta.main` per module.
- **Lifecycle.** `thisCompilation` clears the router, attaches the log to the compilation's warnings, and adds the
  watch files as `fileDependencies` (a lockfile not created yet as a `missingDependencies` entry, which some watchers
  would otherwise report as removed) and `buildDependencies` (persistent cache invalidation); `finishModules` reports
  duplicate npm packages. `watchRun` reloads the project for changed config files (`ConfigReloader`, one reload per
  change for compilers sharing a state; webpack factorizes every import again, so nothing else is needed). `done`
  writes the sidecar into `output.path` (§5.6), flushes the manifest and, outside watch mode, disposes the engines;
  `watchClose` and `shutdown` dispose them.
- Users configure a TypeScript loader that keeps import attributes, a JSX loader for `.jsx`/`.tsx`, and ES module
  output for the Deno platform (`output.module: true`; with script output the externals become `require()` calls).
  webpack-dev-server has no tests yet.

### 6.6 Rspack 2 and Rsbuild 2

`hosts/rspack/` and `hosts/rsbuild/`; tests in `test/integration/rspack.test.ts` (Rspack 2.2.7, `builtin:swc-loader`
with `jsc.experimental.keepImportAttributes: true`) and `rsbuild.test.ts` (Rsbuild 2.2.9, default SWC settings, one or
more environments). unplugin's generic hooks cannot express externals on Rspack (`external: true` becomes an empty
virtual module) and give virtual modules a wrong importer, so `plugin.ts` (`applyRspack`) taps Rspack's own hooks with
the webpack flow of §6.5:

- Rspack runs `beforeResolve`, `factorize` (externals) and `resolve` like webpack and passes scheme requests to them
  with their import attributes (`resolveData.attributes`), so the `Router`, the externals function (Rspack's callback
  takes the request and the type as separate arguments) and the `resolve` hook are the same; its `resolve` hook does
  not say whether a request is a `require()`, so an import's outcome is taken first. `resolveForScheme` takes one
  argument and there is no `resolveInScheme`; neither is used.
- **Synthesised modules** (`synthetic.ts`): Rspack types `readResource` but never calls it (rspack#12210), so markers
  are empty files of Rspack's native `experiments.VirtualModulesPlugin` under
  `<context>/node_modules/.virtual/unplugin-deno/<hash>/<name>.<type>.js` (unplugin's own layout), whose code comes
  from unplugin's Rspack `load` loader calling `state.load`; the loader registers the marker's target as a
  dependency, so edits rebuild the module in watch mode (rewriting the virtual file would not). A `.js` path keeps the
  user's rules for the target's extension away from it.
- **Presets**: Rspack's `externalsPresets.web` covers `http(s):`, `//` and `std:` (not `jsr:`/`npm:`); it is taken
  over as on webpack. Rspack has no Deno target: Node.js targets give the Deno platform for projects with a
  `deno.json`.
- **Rules and JSX** as on webpack; Rspack's native compiler reads `module.rules` when it creates the compiler at the
  first build, after `beforeRun`. `builtin:swc-loader` rules get the `deno.json` JSX settings (§5.11).
- **Watch.** Rspack keeps the module graph between rebuilds and resolves again only the imports of the modules it
  rebuilds (it reads `modifiedFiles` after `watchRun`), so after a config reload `watchRun` adds the importers of the
  plugin's requests (`Router.importers`) to `modifiedFiles`, and every applied resolution depends on the config files.
- Entries come from `afterResolve` (no issuer; Rspack does not say which dependencies are workers); duplicates are
  reported per compiler platform in `finishModules`; `done` writes the sidecar into `output.path`. Standalone
  compilers (`rspack(compiler)`, `index.ts`) set the host hints and dispose the engines when done.

**Rsbuild** (`rsbuild/index.ts`) does not call unplugin's `rspack(compiler)`, so the plugin provides
`rsbuild.setup(api)`: it sets the root (`api.context.rootPath`), the command and the version, and in
`api.modifyRspackConfig` loads the project and appends the Rspack plugin to each environment's config with the
environment's resolve target (§5.6: `web` and `web-worker` → browser unless a `platform` record names the environment;
`node` → the record entry, a `platform` string, or `deno` with a `deno.json`, else `node`). The environments share one
state (project, engines per target, mirror generations) and one `ConfigReloader`; the source transforms, checks and
Wasm modules follow each environment's platform, and the JSX settings reach the final Rspack rules, after `tools.swc`
and plugins such as `@rsbuild/plugin-react`. `onAfterBuild`/`onAfterDevCompile` flush the manifest;
`onCloseBuild`/`onCloseDevServer` dispose the engines. The Rspack and Rsbuild dev servers have no tests yet.

### 6.7 Bun, Farm (planned), unloader / `register` (M3)

Not implemented: `unplugin-deno/bun` and `unplugin-deno/farm` are inert, `unplugin-deno/esbuild` refuses `Bun.build`
(§6.4), and `unplugin-deno/register` throws `ENGINE_UNAVAILABLE` on import (`createDenoResolver` of
`unplugin-deno/api` when called). Design: Bun through unplugin's Bun target; `onResolve` has no `with`, so attributes
rely on the transform pre-pass. `register`: reuse the factory through unplugin's `unloader` target (Node
`module.registerHooks`, sync) with a worker + `Atomics.wait` bridge around the async engine; Bun uses `Bun.plugin`
with `--preload`.

---

## 7. Testing architecture

- Unit tests are colocated (`src/**/*.test.ts`). Path helpers take an explicit `posix`/`win32` flavour, so Windows
  cases run on every OS.
- `test/fixtures/<name>/`: small projects, each with a `fixture.json` (`title`, `entries`, `hosts`, optional `expect`,
  `issues`, `source`; typed and validated in `test/helpers/fixture.ts`; `hosts` documents which hosts' integration
  tests build the fixture and is not read by the suites). Prefixes say who uses them: `core-*` (the core suite and
  every host's integration tests), `engine-*` (the engine contract; `engine-cli-*` only the `deno` engine),
  `esbuild-*`, `vite-*` and `webpack-*` (host tests; `webpack-*` also run on Rspack); unprefixed ones serve the config
  tests. Remote fixtures pin versions and ship a `deno.lock`.
- `test/data/`: the web-platform-tests import-map data (`wpt-import-maps/`) and the `denoland/import_map` cases
  (`deno-import-map/`), with their `SOURCE.md`, run by `src/config/import-map.wpt.test.ts`.
- `test/helpers/`: `tempProject(name)` (a copy of a fixture outside the repository), `tempDir(files)`, `denoDir()` /
  `freshDenoDir()` (the shared or an empty test `DENO_DIR`), `normalize(text)` (placeholders for machine paths and
  hashes, also applied to snapshots), `runtime`; builders that run the real bundler into a temporary directory and
  return chunks, module ids, imports and logs: `buildWithRolldown`, `buildWithRollup` (`build.ts`), `buildWithEsbuild`,
  `contextWithEsbuild` (`esbuild.ts`), `buildWithVite`, `startViteDevServer`, `loadVite(7 | 8)` (`vite.ts`),
  `buildWithWebpack` (`webpack.ts`), `buildWithRspack` (`rspack.ts`), `buildWithRsbuild` (`rsbuild.ts`, one result per
  environment), with the stats conversion in `webpack-stats.ts` and shared assertions and runners (entry chunk, mirror
  generations, info lines, `runUnderDeno`, watch builds) in `webpack-family.ts`; `evaluateModule` imports an output
  file in the current runtime; `startMockRegistry()` (`mock-registry.ts`) serves an npm package and a JSR package on
  `127.0.0.1` and records the requests with their `authorization` headers; `denoBinary` (`deno-binary.ts`) is the
  Deno the `deno` engine tests use (`UNPLUGIN_DENO_TEST_DENO_BINARY`, default `deno`), with a `skipReason` when it is
  missing or older than 2.8.3.
- `test/integration/`: `core-suite.ts` holds the core fixture tests, run by `rolldown.test.ts` and `rollup.test.ts`
  (fixtures a host cannot build are skipped with their reason in `SKIPPED`); `esbuild.test.ts`, `vite.test.ts`,
  `vite-dev.test.ts`, `webpack.test.ts`, `rspack.test.ts` and `rsbuild.test.ts` cover the other hosts with the same
  fixtures plus their own. Tests that run the output under `deno run --cached-only` (and with the sidecar,
  `--frozen`) skip when the `deno` binary is missing (`DENO_AVAILABLE`); tests of the `deno` engine skip on
  `denoBinary.skipReason`.
- Engine contract tests (`src/engine/contract.test.ts`) run the `engine-*` fixtures against both engine factories.
- Runtimes: `pnpm test` (Node), `pnpm test:deno` (`deno run -A npm:vitest run`), `pnpm test:bun`
  (`bun --bun x vitest run`); CI runs them on ubuntu, macOS and Windows (`.github/workflows/ci.yml`), and only the
  `deno` rows have a Deno binary.

---

## 8. Glossary

- **Owned specifier**: one `resolveId` must handle: a Deno scheme, an import-map key, a marker id, or an import from
  inside a mirror or global-cache file.
- **Mirror**: `cacheDir/<generation>/…` copies of remote modules as JS files with rewritten specifiers.
- **Generation**: hash of config files + lockfile + plugin version + platform + conditions; namespaces the mirror.
- **Redirect**: handing an npm request back to the host resolver from inside the package directory.
- **Marker**: the `?deno-type=` query encoding an import attribute in the id.
- **Pinning**: rewriting an external `npm:`/`jsr:` specifier to the exact resolved version for Deno runtime output.
- **Sidecar**: the `deno.json` and `deno.lock` written next to Deno platform output (`emitDenoConfig`).
- **Target**: the platform (and extra `bundle` patterns) an import is resolved for when a host builds several platforms
  at once (Vite and Rsbuild environments).
- **Route** (`jsr:`): where JSR packages come from in a build, the mirror or `node_modules/@jsr`.

---

## Appendix A. Deviations from plan.md

The plan's scope is unchanged; these are the places where the implementation chose differently than
[plan.md](plan.md) §2–§6 describe, and why:

- `npm: 'auto'` follows `nodeModulesDir` (`none` → Deno's global cache) instead of "redirect when a `node_modules`
  layout exists": with `none` the loader resolves into `DENO_DIR` even when `node_modules` exists (§5.4).
- plan.md §2 item 2 says the loader's `cachedOnly` blocks only remote modules; verified, it is the reverse (it blocks
  only npm downloads), so the engine refuses every download itself (§4.2).
- The import-attribute pre-pass also runs on Rollup, because Rollup reuses one resolution per specifier and module
  (§5.5, §5.9).
- Vite markers are virtual ids (`\0deno:<type>:<path>.js`) because Vite's CSS, JSON and framework plugins claim ids by
  extension whatever the query holds (§6.1).
- In the Vite dev server, Deno server environments bundle `npm:` and `jsr:` imports instead of keeping them external
  (Vite's module runner cannot load them); builds keep them external and pinned (§6.1). `node:` builtins are left to
  Vite.
- esbuild's own `external` option is left to esbuild (it applies after plugins), and `packages: 'external'` keeps
  `npm:`/`jsr:` imports external and pinned (§6.4).
- Import-map keys are known only once the project is loaded, so Vite and watch builds use a broad `resolveId` filter
  (§5.2, §5.9).
- The `deno` engine (plan §3, §4.3 design) runs `deno info` over a synthetic root module on every OS (not the entries
  on the command line), transpiles with `deno transpile` (the plan left `deno transpile` or the loader's emit open),
  resolves npm files with a port of `node_resolver` because `deno info` names packages but not files, and copies the
  lockfile so Deno cannot write it (§4.3). `engine: 'auto'` also picks it for link globs and a `JSR_URL` naming another
  registry (R10: the loader ignores `JSR_URL`).
- webpack (plan §5): scheme requests are resolved in an externals function applied before the presets and applied in
  `normalModuleFactory.hooks.resolve`, rather than in `resolveForScheme`/`resolveInScheme`; `resolveForScheme` and
  `readResource` serve only the plugin's own `unplugin-deno:` scheme (markers), and attributes are read in
  `beforeResolve` rather than through `module.rules[].with` (§6.5). Rspack uses `experiments.VirtualModulesPlugin`,
  not a pitching loader (§6.6).
- S6: webpack's and Rspack's scheme externals presets are taken over automatically unless the config sets them
  explicitly, with info lines, instead of through an option (§6.5).
- S3: the sidecar `deno.json` holds `lock` and `nodeModulesDir`, not an `imports` map: the externals are pinned, so the
  output needs no import map (§5.6).
- R5: `'auto'` freezes the lockfile when `CI` is set to anything but `''`, `0`, `false`, `no` or `off` (not only
  `CI=true`) or `deno.json` sets `lock.frozen`, and only when a lockfile exists (§5.13).
- R15: besides Deno's defaults and the option, the hosts `deno.lock` and the import maps name and the JSR registries
  are always allowed (§5.2).
- L5: `precompile` compiles with the automatic runtime and a warning; `jsx: 'deno'` is accepted but acts like
  `'auto'` (§5.11).
- L6: `.wasm` modules are instantiated synchronously with the bytes inlined; no source-phase imports (§5.12).
- Partly done, the rest **planned**: L7 without `import.meta.filename`/`dirname` handling for the browser, L9 without
  DCE constants (`IS_BROWSER`), X3 without CommonJS-only packages and the full import chain, S5 without CommonJS-only
  detection (§5.10); L8 (CommonJS interop helpers for Deno/Node output) is not implemented.
- Deferred although plan.md lists it for M1: the empty module for `browser: false` mappings of R6 on the global-cache
  route (§5.6); plan.md's progress note tracks the other open items.
