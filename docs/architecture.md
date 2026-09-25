# Architecture

This is the developer specification of `unplugin-deno`: what each layer does, the algorithms, the id and file
layouts, and the per-host recipes. It is written for contributors and coding agents; users read the
[README](../README.md). Rationale and evidence are in [plan.md](plan.md) and [research/](research/README.md);
the verified host recipes referenced below are in [research/feasibility.md](research/feasibility.md).

Conventions used here: "host" = the bundler we plug into; "engine" = the component that implements Deno's
resolution and loading semantics; "mirror" = the project-local directory where remote modules are written as files.

---

## 1. Layers and module map

```
src/
├─ index.ts                 createUnplugin factory (`unplugin`), public types, `createDenoResolver` (M3)
├─ vite.ts … farm.ts        host entries: `export default createVitePlugin(factory)` etc. (unplugin has no subpaths)
├─ vendored-deno-loader.ts  lazy import of ../vendor/deno-loader (must stay at depth 1 so the relative path is the
│                           same from src/ and dist/; tsdown keeps the import external), logger/fetch injection
├─ core/
│  ├─ plugin.ts             the UnpluginFactory: wires options → config → engine → hooks; branches on meta.framework
│  ├─ options.ts            Options type, `resolveOptions(user, hostContext)` → ResolvedOptions (all defaults here)
│  ├─ specifier.ts          classify specifiers (jsr/npm/https/http/data/node/bun/cloudflare/file/bare/relative)
│  ├─ id.ts                 id scheme: splitQuery, deno-type marker, mirror-path detection, virtual ids
│  ├─ resolve.ts            the resolveId algorithm (§5.2) → ResolveOutcome
│  ├─ npm.ts                npm strategy: package dir/name/subpath derivation, redirect requests (§5.4)
│  ├─ mirror.ts             mirror layout, writing, manifest, specifier rewriting, sourcemaps (§5.3)
│  ├─ attributes.ts         import-attribute marker: transform pre-pass + module synthesis (§5.5)
│  ├─ platform.ts           platform model, conditions, externals policy, pinning (§5.6)
│  ├─ entries.ts            entrypoint discovery per host for engine.addEntrypoints
│  └─ watch.ts              watch list + invalidation orchestration (§5.7)
├─ config/
│  ├─ discover.ts           find deno.json(c) / workspace root / members / package.json from a root dir
│  ├─ deno-config.ts        DenoConfig type + JSONC parsing + normalisation (imports, scopes, workspace, links, …)
│  ├─ import-map.ts         WICG import map + Deno extensions: build per-scope maps, resolve(specifier, referrer)
│  ├─ lockfile.ts           deno.lock v5 reader: pins, integrity, membership checks
│  ├─ node-modules.ts       nodeModulesDir mode detection + node_modules layout probing (.deno/, hoisted, @jsr/)
│  └─ project.ts            Project = the assembled view (root, configs, maps, lock, watch files, jsx settings)
├─ engine/
│  ├─ types.ts              Engine interface (§4.1), ResolvedModule, LoadedModule, MediaType
│  ├─ media-type.ts         MediaType ↔ extension ↔ host moduleType / esbuild loader
│  ├─ loader/               `loader` engine over the vendored @deno/loader (§4.2)
│  │  ├─ engine.ts
│  │  └─ errors.ts          ResolveError → DenoPluginError mapping
│  └─ deno-cli/             `deno` engine (M2): deno info --json graph, localPath, DENO_DIR files
├─ hosts/
│  ├─ vite/                 config/configEnvironment/configResolved/configureServer hooks, depsOptimizer wiring, HMR
│  ├─ rolldown/             filters, moduleType, platform
│  ├─ rollup/               attributes → markers
│  ├─ esbuild/              esbuild.setup implementation (the only thing returned for esbuild)
│  ├─ webpack/ rspack/ rsbuild/ bun/   (M2)
│  └─ shared.ts             HostContext abstraction: root, platform hints, logger, resolveThroughHost()
├─ diagnostics/
│  ├─ errors.ts             DenoPluginError { code, message, hint?, cause? } + error codes
│  ├─ logger.ts             Logger interface + host-backed implementations + DEBUG=unplugin-deno
│  └─ checks.ts             browser-safety / duplicates / lockfile checks (M2)
└─ utils/
   ├─ path.ts               toPath/toFileUrl/normalizeDriveLetter/relativeUrlPath (Windows-safe)
   ├─ fs.ts                 atomic write, mkdirp, readJsonc
   ├─ hash.ts               sha256 helpers
   └─ lexer.ts              import/export specifier scanning (es-module-lexer wrapper)
vendor/deno-loader/         vendored @deno/loader (mod.js, rs_lib_node.js, rs_lib.wasm, helpers.js, LICENSE, VERSION)
```

Dependency direction: `hosts → core → engine, config → utils, diagnostics`. `config` and `engine` never import `core`
or `hosts`. `core` never imports a host package.

---

## 2. Data model

```ts
// core/specifier.ts
type SpecifierKind = 'jsr' | 'npm' | 'https' | 'http' | 'data' | 'node' | 'bun' | 'cloudflare' | 'file'
                   | 'bare' | 'relative' | 'absolute' | 'unknown-scheme'
interface ParsedSpecifier { raw: string; kind: SpecifierKind; base: string; query: string /* incl. '?' or '' */ }

// engine/types.ts
type ResolvedKind = 'local' | 'npm' | 'remote' | 'data' | 'node' | 'external'
interface ResolvedModule {
  kind: ResolvedKind
  url: string            // final URL after redirects: file:///…, https://…, data:…, node:fs, npm:pkg@1.2.3/sub
  path?: string          // OS path for 'local' and 'npm' (realpath into node_modules or DENO_DIR/npm/…)
  mediaType: MediaType
  npm?: { name: string; version: string; subpath: string; packageDir: string; packageJsonPath: string }
  sideEffects?: boolean | null
}
interface LoadedModule { code: string; map?: SourceMap; mediaType: MediaType }

// core/resolve.ts — what the core hands back to a host adapter
type ResolveOutcome =
  | { type: 'path'; path: string; sideEffects?: boolean | null }                  // host loads the file itself
  | { type: 'mirror'; path: string; url: string }                                 // real file in the mirror; we load (code+map)
  | { type: 'npm-redirect'; request: string; resolveDir: string; packageJsonPath: string; rawSpecifier: string; fallbackPath: string }
  | { type: 'marker'; path: string; denoType: 'text' | 'bytes' | 'css'; sourceUrl: string }   // synthesised module
  | { type: 'external'; id: string }                                              // keep as import in output
  | null                                                                          // not ours
```

Media types follow Deno's enum (`JavaScript, Jsx, Mjs, Cjs, TypeScript, Mts, Cts, Dts, Dmts, Dcts, Tsx, Css, Json,
Jsonc, Json5, Html, Markdown, Sql, Wasm, SourceMap, Unknown`). Mapping to hosts (`engine/media-type.ts`), after
`deno bundle`: JS/Mjs/Cjs/Mts → `js`; TS/Cts/Dts/Dmts/Dcts → `ts`; Jsx/Tsx → `jsx`; Css → `css`; Json → `json`;
Jsonc/Json5/Markdown/Html/Sql/SourceMap → `text`; Wasm/Unknown → `binary`. Mirrored code is already JS, so hosts see
`js` for it; the table matters for esbuild loaders, Rolldown `moduleType`, and marker modules.

---

## 3. Config layer (`src/config/`, pure TypeScript, no wasm)

### 3.1 Discovery (`discover.ts`)

Input: `root` (host root: Vite `root`, esbuild `absWorkingDir`, otherwise `process.cwd()`), `options.config`.

1. If `options.config === false` → no config (engine `noConfig`); bare specifiers are never ours.
2. If `options.config` is a path → use it; otherwise walk up from `root` looking for `deno.json` then `deno.jsonc`
   in each directory (Deno's order), stopping at the filesystem root. Record `configPath`.
3. Workspace root: continue walking up; a config whose `workspace` array (after glob expansion with `tinyglobby`)
   contains the directory of the config found in step 2 is the workspace root. Members = expanded `workspace`
   entries that contain a `deno.json(c)` or `package.json`. Also collect `package.json` at root and in members.
4. `links` (Deno 2.9 stable; formerly `patch`): expand globs; each linked directory's config becomes a member-like
   scope whose package name (jsr `name` or package.json `name`) overrides the registry version.
5. `importMap` field (external import map file) is loaded and treated as the config's `imports`/`scopes`.
6. `nodeModulesDir` (`node-modules.ts`): explicit value wins (`"auto" | "manual" | "none"`, legacy booleans mapped);
   otherwise `"manual"` when any `package.json` exists in the workspace, else `"none"`. Also detect the actual
   `node_modules` layout: `.deno/` (isolated), hoisted, pnpm (`.pnpm/`), and `@jsr/` (Deno 2.9 `jsrDepsInNodeModules`).
7. `compilerOptions`: `jsx`, `jsxImportSource`, `jsxImportSourceTypes`, `jsxFactory`, `jsxFragmentFactory`,
   `jsxPrecompileSkipElements`. `unstable` array (e.g. `raw-imports`). `lock` (`false` | path) and whether `deno.lock`
   exists at the workspace root. `vendor` boolean.

Output: `Project { root, workspaceRoot, configPath, workspaceConfig, members: Scope[], nodeModulesDir, nodeModules:
Layout | null, lockfile: Lockfile | null, jsx, watchFiles: string[] }`. `watchFiles` = every config, import map,
lockfile and package.json read. Parsing uses `jsonc-parser`; errors become `DenoPluginError('CONFIG_INVALID')`
with file + position.

### 3.2 Import maps (`import-map.ts`)

Deno semantics = WICG import maps + Deno extensions:

- Keys are normalised specifiers; a key ending in `/` maps prefixes. Values are resolved against the config file URL.
- **Package expansion**: an entry `"@std/path": "jsr:@std/path@^1"` (value is `jsr:`/`npm:` without a trailing slash)
  also maps `@std/path/<subpath>` → `jsr:@std/path@^1/<subpath>`. Same for `npm:`.
- `scopes`: keys are URL prefixes resolved against the config; the referrer picks the longest matching scope, whose
  entries take precedence over top-level `imports`.
- **Workspace members**: a member's `imports` apply to referrers under the member directory (Deno merges member
  maps under a scope for the member directory; root `imports` remain visible). Member `exports` (jsr package
  `name` + `exports`) make `@scope/name` and `@scope/name/<sub>` resolve to member files. `links` behave the same.
- `package.json` `dependencies` alongside `deno.json` also make bare names resolvable (Deno's byonm): a bare name that
  is a package.json dependency and not in the import map is **not ours** (the host resolves it from `node_modules`),
  but it is recorded so `platform: 'deno'` pinning can rewrite it to `npm:name@<installed version>`.

API: `createImportMapResolver(project) → { resolve(specifier, referrerUrl): { mapped: string; entry: {scope, key} } | null;
ownedKeys(): string[] }`. `ownedKeys()` feeds the `resolveId` hook filter (§5.2). Tested against the WICG reference
test suite (credited) and Deno-specific cases.

### 3.3 Lockfile (`lockfile.ts`)

Reads `deno.lock` version 5: `specifiers` (`jsr:@std/path@^1` → `1.0.8`, `npm:kleur@^4` → `4.1.5`), `jsr`/`npm` entries
(`integrity`, `dependencies`), `remote` (`url` → sha256), `workspace` (root/member `dependencies`, `packageJson`).
Provides `pin(specifier)`, `has(specifier | url)`, `remoteIntegrity(url)`. Used for `platform: 'deno'` pinning,
`lockfile: 'frozen'` drift detection (M2), and mirror integrity (§5.3). Older lockfile versions → warning, treated as
absent.

### 3.4 Corrections from the implementation (verified with Deno 2.9.7)

- §3.1 step 2: Deno's nearest *config folder* can be a `package.json`-only directory; a parent `deno.json` without
  members is then ignored, so `configPath` can be `null`. An explicit `config` path is treated as found in its
  directory only when it is the file Deno would pick there; otherwise it is used alone.
- Step 3: the first ancestor declaring members (`workspace`, or package.json `workspaces`) decides; when the nearest
  folder is not one of them it stands alone (a warning for deno workspaces). Globs match
  `<entry>/{deno.json,deno.jsonc,package.json}` (glob characters are only `*` and `?`, `!` excludes; dot directories,
  `node_modules` and `.git` are skipped). A missing path member is skipped with a warning; a directory without a
  config, a member outside the root, the root itself, a directory listed twice and duplicate `name`s are errors.
- Step 4: a link into another workspace brings in that whole workspace; linking one of our own members is an error.
  Deno 2.8.3+ also links automatically the `deno.json` directory a path value of an import map points into.
- Step 5: external import map files are strict JSON and get no package expansion; inline `imports`/`scopes` win over
  `importMap` (warning).
- Step 6: without an explicit `nodeModulesDir`, the mode is `manual` only when the **workspace root** has a
  `package.json` (a member's is not enough), `auto` for `vendor: true`, else `none`.
- §3.2: only the `imports` of members and links become a scope for their directory (their `scopes` are ignored, with a
  warning). `jsr:` specifiers naming a member or link resolve to its files when its `version` satisfies the range.
  After a matched prefix Deno percent-decodes the rest and appends it segment by segment (dropping `.`/`..`), so an
  opaque target such as `jsr:@s/p@1/` cannot take subpaths (`jsr:/@s/p@1/` can). `mapped` normalises `jsr:/`/`npm:/`
  to `jsr:`/`npm:`, URLs keep `^` unencoded like Deno, and package.json-based matches also carry `packageName` and
  `subpath` (npm workspace members map to their directory; the caller applies Node rules).
- §3.3: `specifiers` keys are normalised requirements (`jsr:@std/path@^1` is stored as `jsr:@std/path@1`); `pin()`
  returns the pinned specifier with its subpath (`jsr:@std/path@1.1.6/join`).

---

## 4. Engine (`src/engine/`)

### 4.1 Interface

```ts
interface Engine extends AsyncDisposable {
  readonly kind: 'loader' | 'deno'
  addEntrypoints(urls: string[]): Promise<EngineDiagnostic[]>       // seeds the graph; returned diagnostics → warnings
  resolve(specifier: string, referrer: string | undefined, mode: 'import' | 'require'): Promise<ResolvedModule>
  resolveSync?(specifier: string, referrer: string | undefined, mode: 'import' | 'require'): ResolvedModule | undefined
  load(url: string, type: 'default' | 'json' | 'text' | 'bytes'): Promise<LoadedModule | { kind: 'external' }>
  graph(): unknown                                                   // serialized graph for diagnostics
}
interface EngineFactory {
  create(opts: { project: Project; platform: 'browser' | 'node'; conditions: string[]; cachedOnly: boolean;
                 newestDependencyDate?: Date; logger: Logger; fetch?: typeof fetch }): Promise<Engine>
}
```

One engine per (`configPath`, `platform`, `conditions`) — i.e. per Vite environment class. Engines are created lazily
on first owned specifier and disposed/recreated on config or lockfile change (§5.7). A contract test suite runs the
same fixtures against every engine implementation.

### 4.2 `loader` engine (vendored `@deno/loader` 0.5.x)

Facts that drive the implementation (verified; see research/feasibility.md §7 and multi-and-deno-tooling.md §1):

- Construction: `new Workspace({ configPath, platform, nodeConditions, cachedOnly, newestDependencyDate, noLock?,
  preserveJsx: false, noTranspile: false })` then `await workspace.createLoader()`. **Always pass `configPath`**
  (config discovery otherwise uses `process.cwd()`). `platform` is `'node' | 'browser'` (`'deno'` = node). There is no
  `cwd`, `nodeModulesDir`, `vendor`, `lockfile` or `frozen` option; those come from `deno.json`.
- `addEntrypoints(entries)` walks the static graph (`follow_dynamic: false`) and **returns** diagnostics instead of
  throwing; surface them as warnings. It also installs npm packages (`nodeModulesDir: "auto"`) and downloads every npm
  package listed in the lockfile eagerly. Never runs lifecycle scripts.
- `resolveSync(spec, referrer, mode)` is correct for specifiers already in the graph. Outside the graph it returns
  `jsr:` specifiers unchanged and throws for `npm:` → when the result still has a `jsr:`/`npm:` scheme or throws with no
  `code`, fall back to `await loader.resolve(...)` (which mutates the graph and may download).
- `load(url, RequestedModuleType)` requires a **resolved** URL (`https:`/`file:`/`data:`); `load('jsr:…')` and
  `load('npm:…')` throw; `node:` returns `{ kind: 'external' }`. The result `code` (Uint8Array) is transpiled JS (even
  when `mediaType` says TypeScript) and still contains an inline `//# sourceMappingURL=data:…` comment → strip it;
  `sourceMap` (Uint8Array JSON, `sources: [url]`, `sourcesContent`) is the map to use.
- Errors are `ResolveError { specifier?, code?, isOptionalDependency? }`; `code` is set only for Node-resolution
  failures (`ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`). Graph/import-map failures have no code; classify
  them by the error class and the specifier kind, never by message text. Map to `DenoPluginError` codes:
  `RESOLVE_NOT_FOUND`, `RESOLVE_NOT_EXPORTED`, `RESOLVE_UNMAPPED_BARE`, `RESOLVE_CONSTRAINT`, `RESOLVE_FAILED`.
- Logging: the glue calls `console.error('Downloading', url)` and prints Rust log lines. The vendored `helpers.js` is
  patched so these go to an injectable logger (`vendored.ts` sets it per process). `fetch` is read from
  `globalThis.fetch` at call time; the vendored glue is patched to use an injectable fetch (for proxies/auth/tests) with
  3 jittered retries (4 attempts) on network errors, 429 and 5xx, since upstream has none. `cachedOnly` only blocks remote-module fetches.
- Wasm loading: use the Node code path (`readFileSync` + synchronous `WebAssembly.Module/Instance`) on Node, Deno and
  Bun alike (verified). Cold cost ≈ 85 ms, warm ≈ 15 ms; `Workspace + createLoader` ≈ 25 ms; recreate on config
  change is cheap. The wasm is read from `new URL('./rs_lib.wasm', import.meta.url)`, so the vendor directory must be
  shipped as files, not bundled (tsdown `copy`/external).
- Local files are **never** loaded through the engine (its file cache goes stale on edits); the host loads them.
- Minimum dependency age: pass `newestDependencyDate = now − minimumDependencyAge` (Deno 2.9 default 24 h; read the
  project's setting when present) so resolutions without a lockfile match `deno install`.

### 4.3 `deno` engine (M2)

Uses the installed Deno: one `deno info --json --config <configPath> <entries…>` at `addEntrypoints` (entries passed
via a temp file on Windows to avoid argv limits), parsed against a schema (`modules[*].{specifier,local,mediaType,
dependencies}`, `npmPackages[*].{name,version,localPath}` (2.8.3+), `redirects`, `packages`); later unknown specifiers
resolved in bounded batches. Remote files are read from `modules[*].local` in `DENO_DIR/remote/…` with the trailing
`// denoCacheMetadata=…` line stripped, then transpiled through `deno transpile`-equivalent (M2 decides: `deno
transpile` per batch or the loader's emit). Selected by `engine: 'deno'`, or by `engine: 'auto'` when the config uses
features the vendored loader lacks (`catalog:`, `jsrDepsInNodeModules`, glob members handled by our config layer are
fine) and `deno` is on PATH.

### 4.4 `loader` engine: verified behaviour (M1 corrections)

Found while implementing `src/engine/` (each point has a test in `engine/**/*.test.ts`):

- **`cachedOnly` blocks only npm downloads** (`NpmCacheSetting::Only`); remote `https:`/`jsr:` modules are still fetched
  (the HTTP client's `cached_only` is never set). The engine enforces it: while a `cachedOnly` engine owns the fetch
  hook every download is refused (`AbortError`, no retries) and the failures become `CACHED_ONLY_MISS`.
- **Fallback rule, extended**: `resolveSync` also throws `ERR_MODULE_NOT_FOUND` (with a code) for a package known from
  the lockfile but not yet downloaded (`DENO_DIR/npm`) or installed (`node_modules/.deno`); the engine falls back to
  `resolve()` for those as well.
- `await loader.resolve()` **does not throw** for an unresolvable `jsr:` requirement (no matching version, unknown
  package or export): it returns the requirement unchanged and records the reason in the graph, which
  `addEntrypoints([requirement])` returns as a diagnostic. A `jsr:` subpath failure cannot be told from a constraint
  failure without message text, so it is `RESOLVE_FAILED` (hint picked from the message). `npm:` failures throw
  "Could not find constraint …" without a code.
- `addEntrypoints` rejects the whole batch when an entrypoint itself cannot be resolved (unmapped bare specifier); the
  engine retries one by one. Relative entrypoints and an `undefined` referrer resolve against `process.cwd()`, and
  referrers other than `file:`/`http(s):` URLs (e.g. `data:`) are read as file paths: the engine passes the project
  root (and rejects relative specifiers from such referrers).
- `DENO_DIR` default: `$XDG_CACHE_HOME/deno` on **every** platform, then the OS cache dir (`%USERPROFILE%\AppData\Local`
  in the wasm build on Windows) + `/deno` (`engine/deno-dir.ts`).
- The loader returns canonical paths. Files in `node_modules/.deno` are hard links into `DENO_DIR/npm`, and Bun's
  `realpathSync.native` on macOS may answer with the other link, so the engine realpaths directories and symlinks only.
- Interface additions: `Engine.dispose()`, `LoadedModule.{kind, url, bytes}` (raw bytes for `bytes`/Wasm),
  `EngineDiagnostic.code`, `EngineResolveError.isOptionalDependency`. The §2 loader table is `deno bundle`'s and
  applies to engine output (TypeScript already transpiled), not raw sources.

---

## 5. Core plugin (`src/core/`)

### 5.1 Options and host context

`resolveOptions(user, hostContext)` applies every default in one place:

| Option | Default |
|---|---|
| `cwd` | host root |
| `config` | discovered |
| `cacheDir` | `<workspaceRoot>/node_modules/.unplugin-deno` (like Vite's `node_modules/.vite`) |
| `engine` | `'auto'` → `loader` |
| `platform` | `'auto'` (§5.6) |
| `conditions` | `[]` (added to the platform set) |
| `npm` | `'auto'` → redirect when a `node_modules` layout exists, else `deno-cache` |
| `lockfile` | `'auto'` (`'frozen'` when `process.env.CI` is truthy, M2) |
| `cachedOnly` | `false` |
| `allowImport` | Deno's default hosts (`deno.land`, `jsr.io`, `esm.sh`, `cdn.jsdelivr.net`, `raw.githubusercontent.com`, `gist.githubusercontent.com`) plus hosts present in the lockfile (M2) |
| `external` / `bundle` | `[]` |
| `pinExternals` | `true` when platform is `deno` |
| `importAttributes` | `true` |
| `importMetaMain` | `true` (M2) |
| `denoGlobals` | `'warn'` for browser platform (M2) |
| `jsx` | `'auto'` (host transpiles local files; engine transpiles remote) |
| `importers` | `{ include?, exclude? }` filter on importer paths; unset = act on every importer |
| `debug` | `process.env.DEBUG` matches `unplugin-deno` |

`HostContext` (from `hosts/shared.ts`): `{ framework, root, command: 'build' | 'serve', platformHint, logger,
version }`. Everything host-specific the core needs is passed in through this object or through the outcome types;
the core never imports a host.

### 5.2 `resolveId` algorithm

Filter (hosts with native filters — Rolldown, Vite ≥ 7, Rollup ≥ 4.40): `id` RegExp built from the owned schemes
(`^(jsr|npm|https?|data|node|bun|cloudflare|file):`), the escaped import-map keys (`^(@std/path|react)(/|$)`),
the deno-type marker (`[?&]deno-type=`), and — only when `npm === 'deno-cache'` — bare specifiers (`^[^./\0]`)
because imports inside global-cache npm files must go through the engine.

Handler:

```
resolveId(rawId, importer, opts):
  if rawId starts with '\0' and is not our marker/virtual prefix → null
  if rawId starts with 'virtual:' → null
  { base, query } = splitQuery(rawId)                     // query preserved verbatim, e.g. '?raw', '?worker&url'
  spec = classify(base)
  referrer = importer ? toUrl(importer /* mirror path → its source URL */) : undefined

  // 1. import map (authoritative for its keys)
  if spec.kind is 'bare':
     mapped = importMap.resolve(base, referrer)
     if !mapped:
        if importer is inside DENO_DIR/npm cache → engine.resolve(base, referrer)   // deps of global-cache packages
        else → null                                                                  // host resolves (node_modules)
     else base = mapped; spec = classify(base)
  if spec.kind is 'relative' | 'absolute':
     if importer is a mirror file or a global-cache npm file → resolve via engine with referrer
     else → null                                                                     // local relative imports are the host's

  // 2. externals policy (before touching the engine)
  if spec.kind in ('node','bun','cloudflare') → { type:'external', id: normalised }   // 'node:' prefix added
  if platform is 'deno' and spec.kind in ('npm','jsr') and not matched by `bundle` → pin + external (§5.6)
  if matched by `external` patterns → external (pinned when possible)

  // 3. engine
  resolved = engine.resolveSync(...) ?? await engine.resolve(...)                    // §4.2 fallback rule
  switch resolved.kind:
    'local'  → { type:'path', path: resolved.path + query }
    'npm'    → npm strategy (§5.4) → 'npm-redirect' | 'path'
    'remote' | 'data' → ensure mirrored (§5.3) → { type:'mirror', path: mirrorPath + query, url }
    'node'   → external
  // 4. deno-type marker: if query has deno-type=… → { type:'marker', … } wrapping the outcome above
```

Never throw for ids we do not own; when the engine fails for an owned id, throw `DenoPluginError` with a hint
(host logs it with the import chain). All string handling of ids goes through `core/id.ts`.

### 5.3 Mirror (`core/mirror.ts`)

Remote (`https:`/`http:`, JSR-resolved) and `data:` modules are materialised as files under `cacheDir` so every host
loads them like ordinary files (Vite prebundles them because the path contains `node_modules`; webpack/Rspack need no
virtual modules; sourcemaps and output paths are readable; the Node `register` hook can import them).

Layout: `<cacheDir>/<generation>/<scheme>/<host>/<url path>` where

- `generation` = first 8 hex of sha256(workspace config files + lockfile + plugin version + platform + conditions).
  Changing the import map or lockfile changes rewritten specifiers, so it changes the generation; stale generations
  are removed on startup (keep the current and previous one).
- `<url path>` keeps the URL's path segments. Each segment is sanitised for Windows (`<>:"|?*`, trailing dots/spaces
  → percent-encoded). A query string is replaced by `~q<8 hex of sha256(query)>` before the extension.
- Transpiled output gets `.js` appended unless the source already ends in `.js`/`.mjs`/`.cjs`
  (`mod.ts → mod.ts.js`, `x.tsx → x.tsx.js`, `esm.sh/react → react.js`, `util.mjs → util.mjs`). Non-code
  files (`json`, `wasm`, text/bytes targets, css) keep their exact name and raw bytes. `data:` URLs live under
  `<generation>/data/<16 hex sha256>.<ext>`.
- Each code file has a sibling `.map` (`sources: [url]`, `sourcesContent`) and a `//# sourceMappingURL=<name>.map`
  comment. Our `load` hook returns `{ code, map }` for mirror paths so the map is applied even on hosts that do not
  read linked maps; esbuild reads them itself.
- `<generation>/manifest.json` maps `url → { file, integrity, deps }` for diagnostics and fast startup; it is a cache
  and is rebuilt when missing or invalid. Writes are atomic (temp file + rename) so concurrent processes are safe.

Writing a module (`ensureMirrored(url)`):

1. `loaded = await engine.load(url, 'default')`; strip the inline sourcemap comment; `code` as UTF-8.
2. Scan `code` with `es-module-lexer` (static imports/exports/re-exports and string-literal dynamic imports).
   For each specifier `s` (with attributes when present):
   - `target = await engine.resolve(s, url, 'import')` (the engine knows the package's own import map/exports).
   - remote/data → `ensureMirrored(target.url)` and rewrite `s` to the **relative path** between the two mirror files
     (`./join.ts.js`, `../fmt/colors.ts.js`), so hosts resolve them natively with no plugin involvement.
   - npm → rewrite to the pinned form `npm:<name>@<version><subpath>` (no absolute paths in the mirror); it is resolved
     again by `resolveId` when the host imports it.
   - node builtin → `node:<name>`; external (bun/cloudflare) unchanged.
   - `with { type: "text" | "bytes" | "css" }` → append `?deno-type=<type>` to the rewritten specifier and drop the
     clause (§5.5). `type: "json"` keeps the clause and the specifier.
   - non-literal dynamic imports are left untouched (a debug log notes them).
   Rewrites use `magic-string`; the final map is `remapping(ourMap, loaderMap)` (`@ampproject/remapping`).
3. Write file + map atomically; record `{ integrity: sha256(source bytes) }` (compared against `deno.lock` `remote`
   entries when present; mismatch → `DenoPluginError('INTEGRITY_MISMATCH')`).

Mirror files are immutable within a generation; a `load` of a mirror path only reads the two files. If the mirror
directory is not writable, fail with `MIRROR_WRITE_FAILED` and a `cacheDir` hint.

### 5.4 npm strategy (`core/npm.ts`)

The engine resolves `npm:` specifiers (and import-map-mapped bare names) to a real file:
`…/node_modules/.deno/<pkg>@<ver>/node_modules/<pkg>/dist/x.js` (isolated), `…/node_modules/<pkg>/…` (hoisted/pnpm),
or `$DENO_DIR/npm/registry.npmjs.org/<pkg>/<ver>/…` (`nodeModulesDir: "none"`). From that path derive
`packageDir` (nearest ancestor with a `package.json` whose `name` matches), `name`, `version`, `subpath`.

- **Redirect (default when the file is under a `node_modules`)**: return
  `{ type: 'npm-redirect', request: name + subpath, resolveDir: packageDir, packageJsonPath, rawSpecifier, fallbackPath }`.
  Host adapters turn this into their native resolution so the host applies `exports` conditions, the `browser` field,
  `sideEffects` and CJS interop:
  - Rollup / Rolldown / Vite: `this.resolve(request, packageJsonPath, { ...opts, skipSelf: true })` (resolving from
    inside the package finds the package itself in every layout); on `null` use `fallbackPath`.
  - esbuild: `build.resolve(request, { kind: args.kind, resolveDir: packageDir, importer: args.importer, with: args.with })`
    — `kind` is required; forward `sideEffects`, `suffix`, `pluginData` from the result.
  - webpack / Rspack (M2): set `resolveData.request = request; resolveData.context = packageDir`.
  - **Vite dev** (not during `opts.scan`): key everything on `rawSpecifier` through
    `this.environment.depsOptimizer`: `metadata.optimized[raw] ?? metadata.discovered[raw]`, else
    `registerMissingImport(raw, resolvedFile)`, then return `getOptimizedDepId(info)`. During scan return the plain
    resolved path. This keeps prebundling on and results in one optimizer run (verified).
- **Global cache (`nodeModulesDir: "none"`)**: return `{ type: 'path', path }` and let the host load it; imports inside
  those files come back to `resolveId` (bare filter active) and are resolved through the engine with the file's URL as
  referrer. In Vite dev, register the package with the optimizer the same way (`registerMissingImport(raw, path)`) so
  CommonJS packages are prebundled; if the optimizer is disabled, serve the file and warn when it is CJS.
- `jsrDepsInNodeModules` layout (`node_modules/@jsr/<scope>__<name>`): when present, `jsr:` specifiers take the npm
  redirect path (`@jsr/scope__name/<sub>`), and the mirror is not used for them. Never mix both routes in one build.

### 5.5 Import attributes (`core/attributes.ts`)

Deno's `with { type: "text" | "bytes" | "css" }` are represented as an id marker: `<file>?deno-type=<type>`. `json`
is left to the host (it handles JSON natively; marking it would create a second instance).

- Hosts that expose attributes to `resolveId` (Rollup `options.attributes`, esbuild `args.with`, webpack/Rspack
  `resolveData.attributes`) → the marker is added in `resolveId`.
- Rolldown / Vite (no attributes in `resolveId`; `text`/`bytes` imports of one id are deduplicated) → a `transform`
  pre-pass with filter `{ code: /\bwith\s*\{/ }` rewrites static `import … from 'x' with { type: 't' }` and dynamic
  `import('x', { with: { type: 't' } })` to `'x?deno-type=t'` and drops the clause (parse with `this.parse`/oxc
  on Rolldown-family hosts; verified that the query reaches `resolveId` intact and stays a separate module).
- Mirrored code is rewritten the same way while mirroring (§5.3).
- `load` for a marker id reads the target (local path or mirror file) and synthesises:
  `text` → `export default <JSON string>`; `bytes` → `export default new Uint8Array([…])` (base64-decoded at runtime for
  large files); `css` → `const s = new CSSStyleSheet(); s.replaceSync(<JSON string>); export default s` (Deno 2.9).
  `moduleType: 'js'` where the host accepts it.

### 5.6 Platform model and externals (`core/platform.ts`)

`platform` is derived from **project shape and explicit options**, never from whether the build process runs on Deno
(Deno Deploy runs every build under Deno).

| Host signal | Platform |
|---|---|
| Vite `environment.config.consumer === 'client'` | `browser` |
| Vite server environments | `options.platform` (per-environment record allowed) → else `deno` when the project has a `deno.json`, else `node` |
| esbuild `initialOptions.platform`: `browser` (also when unset, esbuild's default) → browser; `node`/`neutral` → `deno` if `deno.json` exists else `node` | |
| Rolldown `platform`: same mapping as esbuild | |
| Rollup (no platform) | `options.platform` → else `deno` if `deno.json` exists else `node` |
| webpack `compiler.platform.{web,node,deno}` / Rspack `target` (M2) | mapped directly |

Per platform: engine `platform` (`browser` → `'browser'`, others → `'node'`), extra `nodeConditions`
(`deno` → `['deno']`), `node:` handling (browser: leave to the host and warn via checks (M2); node/deno: external),
`bun:`/`cloudflare:`/`*.node` always external, `browser` field `false` → empty module (`\0deno:empty`).

Externals in `platform: 'deno'` (server output that runs under `deno run`/`deno serve`/Deno Deploy):
`npm:` and `jsr:` specifiers (and import-map-mapped bare names, and package.json dependencies) are kept external and
**pinned** to the version the engine resolved: `react` → `npm:react@19.2.0`, `npm:kleur@^4/colors` →
`npm:kleur@4.1.5/colors`, `jsr:@std/path@^1/join` → `jsr:@std/path@1.0.8/join`. `bundle` patterns force bundling;
`external` patterns force externalising other specifiers (`https:` is bundled by default). Patterns use `deno
bundle`'s syntax (`npm:*`, `jsr:@std/*`, exact specifiers). `pinExternals: false` keeps the original specifier. On
hosts where unplugin drops `external: true` (webpack/Rspack, M2) the adapter injects native externals.

### 5.7 Watch and invalidation (`core/watch.ts`)

- Watched: every file in `Project.watchFiles` (configs, import map, lockfile, package.json files). Hosts: Vite
  `server.watcher.add` + `hotUpdate`/`handleHotUpdate`; Rollup/Rolldown `this.addWatchFile` + `watchChange`; esbuild
  `watchFiles` on results of owned resolutions.
- On change: re-run discovery; dispose and recreate engines; recompute the generation (the mirror rewrites lazily on
  next load); in Vite send a full reload and invalidate the module graph of every environment.
- Local source edits need nothing from us (the host loads local files). Remote modules change only with the lockfile
  or when unpinned `https:` URLs are re-fetched (the engine re-fetches when not cached; the mirror generation includes
  the lockfile so pinned content is stable).

### 5.8 Diagnostics (`src/diagnostics/`)

`DenoPluginError extends Error { code: ErrorCode; hint?: string; specifier?: string; importer?: string; cause? }`
with codes: `OPTIONS_INVALID`, `CONFIG_NOT_FOUND`, `CONFIG_INVALID`, `IMPORT_MAP_INVALID`, `LOCKFILE_INVALID`, `RESOLVE_NOT_FOUND`,
`RESOLVE_NOT_EXPORTED`, `RESOLVE_UNMAPPED_BARE`, `RESOLVE_CONSTRAINT`, `RESOLVE_FAILED`, `NOT_IN_LOCKFILE`,
`LOCKFILE_FROZEN_DRIFT`, `CACHED_ONLY_MISS`, `DISALLOWED_HOST`, `INTEGRITY_MISMATCH`, `MIRROR_WRITE_FAILED`,
`ENGINE_UNAVAILABLE`, `UNSUPPORTED_MEDIA_TYPE`. Messages are one sentence; `hint` says what to do
("run `deno install`", "add `X` to `imports`", "set `cacheDir`"). Hosts print `[unplugin-deno] <message> (<code>)`
plus the hint.

`Logger { error, warn, info, debug, downloading(url) }`; the host adapter supplies an implementation
(Vite `config.logger`, esbuild warnings via `onEnd`, Rollup `this.warn`/`this.error`); `debug` is enabled by
`options.debug` or `DEBUG=unplugin-deno`. Debug output on startup lists: engine kind and version, config path,
workspace root, members, lockfile presence, `nodeModulesDir` + detected layout, platform + conditions per
environment, `cacheDir`/generation.

### 5.9 Corrections from the implementation (M1, verified with Rolldown 1.2.11 and Rollup 4.63.5)

Found while implementing `src/core/` (each point has a test in `core/**/*.test.ts` or `test/integration/`):

- **State.** The per-build state is `core/state.ts` (`PluginState`): options are resolved at plugin creation (to fail
  early) and again against the host root once the host reports it (Rolldown `cwd`); adapters feed host facts through
  `setHints` and the logging context through `setLogTarget`. `HostContext` gained `conditionsHint`.
- **§5.1 `npm: 'auto'`** follows `nodeModulesDir`, not whether a layout exists: `none` → `deno-cache`, `auto`/`manual`
  → `node_modules`. `auto` installs into `node_modules/.deno` only on the first resolution, and with `none` the loader
  uses `DENO_DIR` even when a `node_modules` directory exists.
- **§5.2 filter.** The import-map keys are known only once the project is loaded. Rolldown reads hook filters when it
  builds its plugin bindings, which happens after the `options` hook, so the Rolldown adapter loads the project there and
  narrows the filter; watch mode (the import map can change) and the generic hooks (Vite) keep a broad filter: owned
  schemes, the marker and every bare specifier. With the `deno-cache` strategy the broad filter is the precise one. For
  the Deno platform the `package.json` dependency names are added (they are pinned as externals).
- **§5.2 algorithm.** `exclude`, the `importers` filter and the `resolve` option hook run first. The import map is not
  applied inside npm packages (Deno uses Node resolution there): bare imports from `node_modules` files are the host's
  (`node_modules` strategy), from global-cache files the engine's. Relative specifiers from mirror files are rewritten
  paths, so they resolve as paths relative to the mirror file; only a missing file goes to the engine with the source
  URL as referrer. A remote URL keeps its query (part of the resource); other queries (`?raw`) are appended to the
  result. Two outcomes were added: `host-marker` (a marker on an import the host resolves: local relative paths and
  unmapped bare names; the adapter resolves `request` with `this.resolve(…, { skipSelf: true })` and adds the marker)
  and `virtual` (`\0deno:empty`). A missing optional npm dependency becomes an external (it fails at runtime, as in
  Deno). `pinExternals: false` keeps the *mapped* specifier (`kleur` → `npm:kleur@^4`), so the output needs no import
  map. `bundle`/`external` patterns also match the version-less spelling (`npm:kleur` covers `npm:kleur@^4/colors`)
  and, like esbuild, a package prefix.
- **§5.3 layout details.** An empty path segment (`a//b`, a trailing `/`) is `~e`; Windows device names (`con`,
  `nul.js`) get their first character percent-encoded; segments longer than 200 characters are shortened to
  150 + `~h<8 hex>` (extension kept); the query hash is sha256 of `?query` (with the `?`); `data:` names are
  `<16 hex><media-type extension>` plus the code rule (`.ts` → `.ts.js`). A raw copy whose name ends in `.js`/`.mjs`/`.cjs`
  gets `~raw` before the extension so it cannot collide with the code file of the same URL. `ensureMirrored(url, kind)`
  takes `kind: 'module' | 'asset'`; assets (targets of `json`/`text`/`bytes`/`css` imports) and modules whose media type
  is not code (Wasm, JSON) are written raw from a `bytes` load. Files are named by the final URL after redirects; the
  manifest records `redirects`.
- **§5.3 rewriting.** Rewritten specifiers are relative *paths* with `/` separators (`./join.ts.js`), never URL
  references: hosts resolve them as file paths (`%` in a sanitised name stays literal). A local target (a JSR package
  linked into the workspace) is rewritten to the relative path of the local file. A dynamic import the engine cannot
  resolve is left unchanged (it fails at runtime, like in Deno); a static one fails the build. `resolveId` returns only
  after the whole dependency closure is written (hosts resolve the relative paths natively); cycles are fine because
  writing a module only *loads* its dependencies to compute their paths.
- **§5.3 loader facts.** The loader's graph records `css` import attributes (and `text`/`bytes` without
  `"unstable": ["raw-imports"]`) as errors, after which `resolve` and even `load(url, 'bytes')` of that URL fail on that
  loader. Attribute targets that are relative or absolute URLs therefore resolve by URL arithmetic, and raw loads the
  main engine refuses go to a second, never-seeded engine (`PluginState.engine('raw')`). The integrity is sha256 of the
  original source: `sourcesContent[0]` of the loader's map for transpiled modules, the bytes otherwise; it equals the
  `deno.lock` `remote` hash. Deno locks `json` imports but not `text`/`bytes`/`css` ones, so only those are checked.
  (Engine fix: the wasm deserialises `newestDependencyDate` only as an RFC 3339 string, not as a `Date`;
  `engine/loader/engine.ts` converts it.)
- **§5.3 manifest.** `{ version: 1, generation, modules: {url → entry}, assets: {url → entry}, redirects }` with entries
  `{ file, mediaType, integrity, deps, assets }`; it is merged with the file on disk when flushed (at `buildEnd`, and in
  `closeBundle`), so concurrent processes only lose cache entries, never files. Reverse lookups (`urlForMirrorPath`)
  read the manifest of the path's generation.
- **§5.4.** A redirect is produced only when the specifier names the package (so `name + subpath` resolves from the
  package directory); other npm files are paths. Rollup without a node-resolve plugin answers `this.resolve` with `null`
  and gets `fallbackPath`. Global-cache paths carry `moduleSideEffects: false` for `"sideEffects": false` packages, so
  tree-shaking matches the redirect route (lodash-es `chunk`: under 20 KB either way).
- **§5.5.** The lexer is es-module-lexer 3's full build (named fields; `attributesStart` points at the `{`); it drops a
  clause with a trailing comma (`with { type: "text", }`), which `utils/lexer.ts` finds itself. JSX and TSX are not
  lexable: the pre-pass then uses the host parser (`this.parse`, oxc with `lang` from the extension). Rollup resolves each
  specifier once per module whatever its attributes (`import a from "x" with { type: "text" }` and `… "bytes"` in one
  module become one module, with `INCONSISTENT_IMPORT_ATTRIBUTES`), so the pre-pass runs on Rollup too; Rollup's
  `resolveId` still turns `attributes.type` into the marker for code the pre-pass cannot read. `text` and `css` targets
  must be UTF-8 (`UNSUPPORTED_MEDIA_TYPE`); `bytes` above 1 KiB are base64-decoded with `atob` at runtime.
- **§5.6.** A Rolldown build without `platform` counts as `browser` (Rolldown's default for ES output). Rollup has no
  platform: with a `deno.json` it derives `deno`, so browser or Node builds with Rollup set `platform`.
- **§5.8.** `addEntrypoints` diagnostics with a code (e.g. `CACHED_ONLY_MISS`) are warnings; the others are debug
  output, because the graph also holds imports the host owns (`?raw`, packages from `node_modules`, other plugins'
  virtual ids) that Deno reports as errors, and failing owned imports fail in `resolveId` with their importer. The host
  logger sends warnings (and `error` lines, never thrown: Rollup's `this.error` throws) through `this.warn`, info and
  debug lines through `this.info`, and falls back to stderr. The debug summary is logged by `configure`.

---

## 6. Host adapters (`src/hosts/`)

The factory receives `meta.framework` first and returns a host-specific object (unplugin 3.4 facts:
`meta.framework ∈ rollup|vite|rolldown|farm|unloader|webpack|rspack|rsbuild|esbuild|bun`; a factory may return an
array; `this.resolve` exists at runtime on Rollup-family hosts but is not typed on unplugin's `resolveId` context, so
Rollup-family hooks are placed under the `vite`/`rolldown`/`rollup` escape hatches for native typings;
`enforce` is only honoured by Vite/webpack/Rspack, elsewhere plugin order applies).

### 6.1 Vite 8 (and 7)

- `enforce: 'pre'`. Generic `resolveId` with the §5.2 filter; `load` with filter `{ id: [mirrorPrefix, /[?&]deno-type=/] }`;
  `transform` with `{ code: /\bwith\s*\{/ }` (attributes) — declared under the `vite` escape hatch for typings.
- `config(userConfig, env)`: when `env.command === 'serve'` add `resolve.alias: [{ find: /^(https?:\/\/|data:)/,
  replacement: '$1' }]` (never `'$&'`); add our optimizer plugin to `optimizeDeps.rolldownOptions.plugins` (Vite 8) or
  `optimizeDeps.esbuildOptions.plugins` (Vite 7, auto-converted); `server.fs.allow` += `cacheDir` and workspace root
  (Vite ≥ 8.0.9 detects JSON `deno.json` workspaces itself; keep for Vite 7 and JSONC); set `cacheDir` to
  `<root>/node_modules/.vite` when the project has no `package.json` (Vite would otherwise pick an ancestor).
- `configEnvironment(name, cfg)`: server environments get `resolve.conditions` += `['deno']` and
  `resolve.externalConditions` += `['deno']` when their platform is `deno`; per-environment `optimizeDeps` receives the
  same plugin.
- `configResolved(config)`: record `root`, `command`, `mode`, Vite version (`import('vite').then(m => m.version)`),
  logger; build `HostContext`.
- `configureServer(server)`: watch `Project.watchFiles`; on change run §5.7 and `server.ws.send({ type: 'full-reload' })`.
  `hotUpdate` (Vite 6+ API) also handles config files.
- `resolveId(id, importer, { scan, isEntry })` uses `this.environment` to pick the engine (platform per environment)
  and the `depsOptimizer` wiring in §5.4 for npm redirects and mirror files when not scanning.
- Worker sub-builds: add ourselves to `worker.plugins` (M2, D7).
- SSR: never set `noExternal: true`; the pinned-external policy is applied per server environment. The
  `resolve.builtins` experiment (`/^npm:/`, `/^jsr:/` when the dev server runs under Deno) is opt-in (M2).

**Corrections from the implementation (Vite 8.3.1 and 7.3.6; `src/hosts/vite/`; tests in
`test/integration/vite.test.ts` and `vite-dev.test.ts`, run on Vite 8 and 7; supersedes the Vite bullet of §6.8):**

- **Platform per environment.** Client environments build for `browser` unless a `platform` *record* names them (a
  `platform` string applies to server environments only); server environments take the record entry, the string,
  else `deno` with a `deno.json`, else `node`. The core resolves per call through `ResolveRequest.target`
  (`{ platform, conditions?, bundle? }`): `PluginState` keeps a resolver, an engine and a mirror generation per target
  (one mirror per generation, shared by targets with equal platform and conditions; `flush` writes every manifest),
  and `addEntrypoints(target, input)` seeds a target's engine. The build's own platform (the hint) is `browser`.
- **Dev server externals.** Vite's module runner runs server environments inside the dev server's runtime and cannot
  load `npm:`/`jsr:` externals (`fetchModule` node-resolves bare-looking ids; dev import analysis ignores
  `external: true`; vitejs/vite#20828, #20850), so in the dev server Deno server environments resolve with
  `bundle: ['npm:*', 'jsr:*']`: JSR through the mirror, npm through redirects (inlined by the runner, so CommonJS
  packages need `ssr.optimizeDeps`), in the same mirror generation as the build. Builds keep them external and pinned;
  Vite neither re-externalises nor inlines them, and `noExternal` is never set.
- **`node:` builtins** are left to Vite in every environment: its builtin externals are side-effect free, while an
  `external: true` from the plugin kept an unused `import "node:module"` of Rolldown's runtime in Vite 8 SSR output.
- **Conditions.** `configEnvironment` returns `resolve.conditions`/`externalConditions` as Vite's defaults
  (`defaultServerConditions`, `defaultExternalConditions`, equal in 7 and 8) plus `deno` when the environment sets
  none (a configured list replaces the defaults), else only `deno` (Vite concatenates returned arrays).
- **`config` and `configResolved`.** The root is resolved like Vite's (`resolve(root)`, symlinks resolved unless
  `preserveSymlinks`) and the project is loaded in `config`. The `https:`/`data:` alias is appended to the configured
  aliases (the hook mutates the config: an alias returned from `config` is placed first and would shadow user aliases
  of remote URLs). `server.fs.allow` is extended in `configResolved` (mirror and workspace root, real paths too): a
  `server.fs.allow` returned from `config` replaces Vite's default (the searched workspace root) instead of extending
  it. `vite` is imported for types only, so other hosts never load it; the version comes from `this.meta.viteVersion`.
- **Optimizer.** The optimizer plugin is added to each environment's `optimizeDeps` in `configEnvironment` (dev
  server only): `rolldownOptions.plugins` on Vite 8, an esbuild twin (`optimizer-esbuild.ts`) in
  `esbuildOptions.plugins` on Vite 7 (no `this.meta.rolldownVersion`). Its name, `unplugin-deno:optimizer:<generation>`,
  makes Vite's optimizer cache key change with `deno.json`/`deno.lock`. Vite runs these plugins in its dependency
  *scan* too, before its own; they act only for importers that are package files (`node_modules`, global npm cache,
  mirror). Keys are the specifier as written (`kleur`, `npm:kleur@^4/colors`, `@std/path`, `jsr:…`, `https://…`), the
  scanner's key. The scanner records `node_modules` paths itself (npm redirects; mirror files, as the mirror is under
  `node_modules`); global-cache files are registered by `resolveId` during the scan and hidden from the scanner (a
  non-absolute external id); `https:`/`data:` imports never reach the scanner's resolver, so the optimizer plugin
  registers their mirror files during the scan. JSR, npm (also CommonJS from the global cache), `https:` and `data:`
  imports are thus prebundled in one optimizer run on Vite 8 and 7; `optimizeDeps.exclude` and `noDiscovery` are
  honoured. Vite's `vite:pre-alias` also registers `data:` imports (the alias matches them), under the same key.
- **Markers** resolve to `\0deno:<type>:<file>.js` in Vite: `vite:css` claims every id matching `\.css(?:$|\?)`,
  `vite:json` `\.json(?:$|\?)` and framework plugins `\.vue` plus a query, whatever the query holds. `load` calls
  `addWatchFile(file)`, so edits of the target update its importers.
- **npm installs (`nodeModulesDir: "auto"`).** The engine installs packages into `node_modules/.deno` only when
  entrypoints are added, and a resolution that failed for an uninstalled package keeps failing on that engine. A Vite
  app's inputs are HTML files, so `install.ts` adds each `npm:` requirement (or the `npm:` target of an import-map
  key) as an entrypoint before its first resolution, batched per tick and serialised. This belongs in the engine
  (`resolve()` should install); only Vite needs it, because the other hosts seed the engine with module inputs.
- **Watching and lifecycle.** `configureServer` adds the project's watch files to the watcher; on `add`/`change`/
  `unlink` of one it runs `watchChange` (serialised), then `moduleGraph.invalidateAll()` and
  `hot.send({ type: 'full-reload' })` for every environment; `hotUpdate` returns `[]` for those files. `watchChange`
  reloads only in build watch mode. A prebundled specifier whose mapping changed is rebuilt at the next server start.
  `buildStart` seeds the environment's engine with the build's module inputs (HTML skipped); `buildEnd` flushes in
  build watch mode and closes otherwise (a dev server calls it once, when it closes).
- **Mirror generations.** A Vite app uses one generation per platform (client and server), and `collectGarbage` keeps
  the current generation and the most recently used other one, so concurrent processes building other platforms can
  remove a generation another process is still reading (M2: collect by age instead).
- Measured (`vite-spa`, fresh fixture copy, warm `DENO_DIR`, macOS): first `transformRequest('/src/main.ts')`
  0.22–0.39 s on Node 26, 0.25–0.39 s on Deno 2.9.7, 0.26–0.42 s on Bun 1.3.14 (the upper bound includes loading
  the wasm); the whole page with its four prebundled dependencies 0.31–0.53 s; one optimizer run.

### 6.2 Rolldown (and tsdown)

- `resolveId: { filter: { id: <RegExp> }, handler }` (Rust-side filter); options are `{ kind, isEntry, custom }` (no
  attributes). `load` returns `{ code, map, moduleType: 'js' }` for mirror files and markers. `transform` pre-pass with
  a `code` filter for attributes. `options(inputOptions)` reads `platform` and `input` (entries → `addEntrypoints`).
  `this.resolve` returns `{ id, external, packageJsonPath, moduleSideEffects, meta }`; forward `moduleSideEffects`.
- Optional (M2): an `order: 'post'` terminator with a `custom` probe to detect whether another plugin resolved a
  mapped key first (research/feasibility.md §2).

### 6.3 Rollup 4 (≥ 4.40 for native filters)

- `resolveId(source, importer, { attributes, isEntry, custom })` → attributes become the marker in `resolveId`, so no
  transform pre-pass is needed for local files (mirrored code is rewritten at mirror time). `load(id)` for mirror/marker.
  Rollup has no `moduleType`; mirror output is JS so this is fine. Local `.ts` files are the user's TS plugin's job.

### 6.4 esbuild

- When `meta.framework === 'esbuild'` the factory returns **only** `{ name, esbuild: { setup } }` — unplugin's generic
  adapter registers a catch-all `onResolve(/.*/)` before `setup` runs and forces every result into the plugin namespace.
- `setup(build)`: `onStart` → init project/engine, `addEntrypoints` from `initialOptions.entryPoints`;
  `onResolve({ filter: ownedRegex })` (Go-side; built like §5.2, import-map keys included) → returns `{ path }` for
  local/mirror files (namespace `file`, esbuild loads them and reads their linked sourcemaps), `build.resolve(...)` for
  npm redirects, `{ path, external: true }` for externals, `{ path, namespace: 'deno-type', pluginData }` for markers;
  `onLoad({ filter: /.*/, namespace: 'deno-type' })` synthesises marker modules with `loader: 'js'`;
  `onResolve({ filter: /^[^./]/ })` only when `npm === 'deno-cache'` (deps of global-cache packages, matched on
  `args.resolveDir` under `DENO_DIR`); `onEnd` → flush warnings. Import attributes arrive as `args.with`. Platform from
  `initialOptions.platform`, conditions from `initialOptions.conditions`. Honour `initialOptions.external` and
  `packages: 'external'`.

**Corrections from the implementation (esbuild 0.28.2; `src/hosts/esbuild/`, tests in `test/integration/esbuild.test.ts`;
supersedes the esbuild bullet of §6.8):**

- **Filters.** `setup` is async and loads the project first (hints from `initialOptions`), because esbuild takes filters
  once, at `setup`. The main filter is `resolveIdFilter(project, { npm: 'node_modules' }, platform)` (schemes, marker,
  import-map keys, `package.json` dependencies for the Deno platform) also for the global-cache strategy; bare imports
  then get the separate `/^[^./]/` handler, guarded by the *importer* (global npm cache, the mirror, or `node_modules`
  with `npm: 'deno-cache'`). When the project cannot be loaded at `setup` the broad filter is used and `onStart`
  reports the error. Keys added to the import map while a context runs are not in the filter: the reload warns that a
  new context is needed. There is no `/.*/` filter outside the plugin's own namespace, and no `onLoad` for files.
- **esbuild applies `external` and `packages: 'external'` only after the plugins' `onResolve` callbacks** (verified), and
  it treats `jsr:…`, `npm:…` and `https://…` as package paths. Imports matching `initialOptions.external` (esbuild's
  rules: one `*` wildcard, package paths with their subpaths, never entry points) are left to esbuild, which keeps them
  as written. `packages: 'external'` adds `npm:*` and `jsr:*` to the plugin's `external` patterns and pins them
  (`pinExternals` defaults to `true`), so mapped bare names become `npm:x@<version>`; unmapped bare names stay esbuild's.
- **Platform.** `browser` → browser, also when `platform` is unset (esbuild's own default); `node` and `neutral` →
  `deno` with a `deno.json`, else `node`.
- **Attributes.** The marker is added from `args.with` before `state.resolve`. Local `text`/`bytes` imports are left to
  esbuild's own loaders (esbuild ≥ 0.28 / 0.25.11; same values as the markers); esbuild rejects `with { type: "css" }`,
  so an extra `onResolve` for `.css` paths turns local css imports into markers (`host-marker` outcome, resolved with
  `build.resolve` without the attribute). A `css` attribute on a non-`.css` local file stays unsupported. Marker
  modules live in the `unplugin-deno` namespace under paths relative to `absWorkingDir` (the core id travels in
  `pluginData`), so output comments, source maps and the metafile have no machine paths and no `\0`.
- **Redirects** call `build.resolve(request, { kind, resolveDir: packageDir, importer: packageJsonPath, namespace: 'file',
  with, pluginData })`: the `package.json` importer (as on Rollup) keeps the request from re-entering the plugin's
  import-map handler (it resolves bare names from `node_modules` importers to `null`). `sideEffects`, `suffix`,
  `pluginData` and warnings are forwarded; on errors the engine's `fallbackPath` is used. Queries become `suffix`.
- **CSS.** esbuild sends `@import` and `url()` references to `onResolve` (kinds `import-rule`, `url-token`,
  `composes-from`); remote and `data:` URLs there are left to esbuild (kept as written / inlined), not mirrored.
- **Lifecycle.** esbuild has no `watchChange`: `onStart` compares the watched files' contents with the last load and
  reloads through `watchChange(file)`; it seeds the engine only when the engines lack the build's entry points. Owned
  results carry `watchFiles` (configs, import maps, lockfile) for `ctx.watch()`. `onDispose` runs after `build()` has
  resolved (a `setTimeout`), so plugin reuse is tracked per *running* build (`onStart`…`onEnd`, which esbuild calls even
  after `onStart` errors and cancellations): builds may reuse an instance one after the other with any settings (the
  project is reloaded) and concurrently with equal settings; a concurrent build with other settings fails with
  `OPTIONS_INVALID`. After an `onStart` error esbuild still resolves every import; owned imports are then returned as
  externals so the build fails with that one error.
- **Messages.** Errors are returned as esbuild messages (`<message> (<code>)`, the hint as a note, the error in
  `detail`), so esbuild shows them at the import; warnings are buffered and returned from `onStart`/`onEnd`. esbuild has
  no informational channel for plugins, so debug output goes to stderr.
- `setup` rejects a host that is not esbuild (no `initialOptions`/`resolve`, e.g. `Bun.build`) with `ENGINE_UNAVAILABLE`.

### 6.5 webpack (M2)

`webpack(compiler)`: tap `NormalModuleFactory.hooks.resolveForScheme.for(s)` and `resolveInScheme.for(s)` for
`jsr|npm|https|http|data` (`AsyncSeriesBailHook<[ResourceDataWithData, ResolveData], true | void>`) → set
`resourceData.path/resource` to the mirror/npm path; bare import-map keys through `nmf.hooks.beforeResolve`
(`request`/`context` rewrite); `NormalModule.getCompilationHooks(c).readResource.for(s)` only for synthesised marker
modules (mirror files are real files). Disable `externalsPresets.web`'s scheme externals inside `apply` (runs before
defaults) unless the user wants `target: 'deno'` semantics (option). Inject native `externals` for the externals
policy since unplugin drops `external: true`. Import attributes via `module.rules[].with`. Persistent cache: mark
generated modules with build dependencies on the config files.

### 6.6 Rspack / Rsbuild (M2)

`rspack(compiler)`: `nmf.hooks.resolve` sees scheme requests (with `attributes`); `resolveForScheme.for(s)` takes one
argument; there is no `resolveInScheme`; `readResource` is typed but never called (rspack#12210) → synthesised modules
go through `rspack.experiments.VirtualModulesPlugin` or a `module.rules[{ scheme, enforce: 'pre' }]` pitching loader.
Rsbuild does not call `rspack(compiler)`; provide `rsbuild.setup(api)` using `api.modifyRspackConfig`.

### 6.7 Bun (M2), unloader / `register` (M3)

Bun: unplugin's Bun target; `onResolve` has no `with`, so attributes rely on the transform pre-pass. `register`:
reuse the factory through unplugin's `unloader` target (Node `module.registerHooks`, sync) with a worker +
`Atomics.wait` bridge around the async engine; Bun uses `Bun.plugin` with `--preload`.

### 6.8 Corrections from the implementation (Rolldown 1.2.11, Rollup 4.63.5)

- **Rolldown.** `options(inputOptions)` records `cwd` (host root), `platform` (`undefined` → `browser`),
  `resolve.conditionNames` and `input`, loads the project and narrows the `resolveId` and `load` filters (see §5.9).
  `resolveId: { filter, handler(id, importer, { kind, isEntry }) }`; npm redirects and host markers call
  `this.resolve(request, importer, { skipSelf: true, kind })` and forward `moduleSideEffects`. `load` returns
  `moduleType: 'js'` for mirror files, markers and `\0deno:empty` (Rolldown would otherwise pick a module type from
  `.txt`/`.css`). `closeBundle` flushes the manifest and, outside watch mode, disposes the engines; the generic
  `buildEnd` does the same.
- **Rollup.** `resolveId(source, importer, { attributes, isEntry })` has no id filter: imports carrying attributes
  (local `./data.txt` included) must reach it, and filters only see the id. `load: { filter, handler }` uses the native
  filter on Rollup ≥ 4.40 and checks the id again for older versions. The transform pre-pass is on (§5.9, §5.5). Rollup
  cannot load TypeScript, JSON or CommonJS and resolves nothing from `node_modules` by itself: users add their usual
  plugins; the integration tests use a small esbuild TypeScript plugin and a JSON plugin (`test/helpers/rollup-ts.ts`)
  and skip the CommonJS fixtures.
- **Vite (generic hooks only, M1 next phase).** A Vite 8 build of `core-basic` and `core-remote-mirror` works with the
  generic hooks when `cwd` is set (the Vite adapter will take `root` from `configResolved`); `css` markers collide with
  `vite:css`, which claims `*.css?…` ids, and need the Vite adapter.
- **esbuild.** Until its adapter lands, `esbuild.setup` throws `ENGINE_UNAVAILABLE`.

---

## 7. Testing architecture

- `test/fixtures/<name>/` + `fixture.json` (`title`, `entries`, `hosts`, `expect`, `issues`, `source`).
- `test/helpers/`: `buildWith(host, fixture, options)` runs the real bundler in a temp copy of the fixture with a
  per-run `DENO_DIR` and `cacheDir`; `evaluate(output)` executes the bundle under the current runtime and returns its
  exports; `normalize(text)` strips paths/hashes for snapshots.
- Unit tests colocated. Engine contract tests in `src/engine/contract.test.ts` run against every engine.
- Integration tests per host in `test/integration/<host>.test.ts` iterate fixtures whose `hosts` include that host.
- Runtimes: `pnpm test` (Node), `pnpm test:deno` (`deno run -A npm:vitest`), `pnpm test:bun` (`bun x vitest`); CI matrix
  ubuntu/macos/windows.

---

## 8. Glossary

- **Owned specifier**: one `resolveId` must handle — a Deno scheme, an import-map key, a marker id, or an import from
  inside a mirror/global-cache file.
- **Mirror**: `cacheDir/<generation>/…` copies of remote modules as JS files with rewritten specifiers.
- **Generation**: hash of config + lockfile + plugin version + platform + conditions; namespaces the mirror.
- **Redirect**: handing an npm request back to the host resolver from inside the package directory.
- **Marker**: the `?deno-type=` query encoding an import attribute in the id.
- **Pinning**: rewriting an external `npm:`/`jsr:` specifier to the exact resolved version for Deno runtime output.
