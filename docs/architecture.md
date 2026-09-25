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
│  │  ├─ vendored.ts        lazy import of ../../vendor/deno-loader, logger/fetch injection
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
  retry (3 attempts, jittered) since upstream has none. `cachedOnly` only blocks remote-module fetches.
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
| esbuild `initialOptions.platform`: `browser` → browser; `node`/`neutral` → `deno` if `deno.json` exists else `node` | |
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
with codes: `CONFIG_NOT_FOUND`, `CONFIG_INVALID`, `IMPORT_MAP_INVALID`, `LOCKFILE_INVALID`, `RESOLVE_NOT_FOUND`,
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
