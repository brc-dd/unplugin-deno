# unplugin-deno — feasibility review of PLAN.md core mechanisms

Date: 2026-09-25. Versions checked with `npm view`: unplugin 3.4.0, vite 8.3.1 (vite 7.3.6 for comparison),
rolldown 1.2.11, rollup 4.63.5, esbuild 0.28.2, webpack 5.111.1, @rspack/core 2.2.7, oxc-parser 0.151.0,
synckit 0.11.13; runtimes Node 26.8.1, Deno 2.9.7, Bun 1.3.14. @deno/loader 0.5.0 from the JSR tarball.

Paths: `S=/private/tmp/claude-501/-Users-divyansh-unplugin-deno/1a551bae-bee4-41ac-ba89-ea42b9e7cb9a/scratchpad`,
`F=$S/feasibility` (experiments; packages installed only there). Source clones: `$S/repos/{unplugin,vite,fresh,…}`
(unplugin clone = 3.4.0, vite clone = 8.3.1; both cross-checked against the published dist).

| # | Mechanism | Verdict |
|---|---|---|
| 1 | unplugin 3.4.0 factory surface | FEASIBLE WITH CAVEATS |
| 2 | Fresh's ordering trick (`this.resolve` + ignore built-in resolver) | NOT FEASIBLE as specified on Vite 7/8 and Rolldown (`resolvedBy` does not exist there); portable variants exist → **redesign rule 3.1-3** |
| 3 | npm "redirect to host resolver" | FEASIBLE WITH CAVEATS (build: yes; Vite dev: needs explicit depsOptimizer wiring) |
| 4 | Import-attribute rewrite pre-pass (Rolldown/Vite 8) | FEASIBLE (verified end-to-end) |
| 5 | Vite 8 dev: TS for virtual ids + alias for remote URLs | FEASIBLE WITH CAVEATS |
| 6 | Vite optimizer injection / prebundling JSR+remote | FEASIBLE WITH CAVEATS (as written in D2: not viable) → **redesign D2** |
| 7 | @deno/loader in-process facts | FEASIBLE WITH CAVEATS |
| 8 | webpack scheme hooks / Rspack pitching loader | FEASIBLE (names/signatures confirmed; Rspack has no `resolveInScheme`) |
| 9 | Node `module.registerHooks` sync bridge | FEASIBLE on Node 26 + Deno 2.9.7; NOT on Bun 1.3 |
| 10 | Vendoring @deno/loader | FEASIBLE |

---

## 1. unplugin 3.4.0 factory surface — FEASIBLE WITH CAVEATS

Evidence: `$S/repos/unplugin/src` (identical to published `dist/index.mjs`/`index.d.mts`); runtime probe `$F/exp1/run.mjs`.

**Entry points.** `package.json#exports` = `.`, `./rspack/loaders/{load,transform}`, `./webpack/loaders/{load,transform}`,
`./package.json`. There is **no `unplugin/vite`**. Use `createUnplugin(factory).vite` or `createVitePlugin(factory)`
(also `createRolldownPlugin/createRollupPlugin/createEsbuildPlugin/createWebpackPlugin/createRspackPlugin/
createRsbuildPlugin/createFarmPlugin/createBunPlugin/createUnloaderPlugin`, `src/define.ts:13-111`).
`setParseImpl` is exported (`src/index.ts:7`); `this.parse` on esbuild/webpack/rspack/bun throws until it is called
(`src/utils/parse.ts:3-8`). Do **not** inline unplugin into our dist: the webpack/rspack adapters locate their loader
files via `import.meta.dirname` (`src/webpack/index.ts:13-23`, `src/rspack/index.ts:19-29`).

**Hooks (types.ts:93-160).** `buildStart`, `buildEnd`, `transform`/`load` (object form with `filter`), `resolveId`
(object form, `ResolveIdHookFilter { id?: RegExp }` — RegExp only, types.ts:75-77), `writeBundle`, `watchChange`
(types.ts:122), `enforce: 'pre'|'post'`, deprecated `loadInclude`/`transformInclude`. Escape hatches: `rollup`, `vite`,
`rolldown`, `unloader` (`Partial<Plugin>`, `Object.assign`ed over the generic object, rollup/index.ts:82-83),
`webpack(compiler)`, `rspack(compiler)`, `rsbuild: Partial<RsbuildPlugin>`, `farm: Partial<JsPlugin>`,
`esbuild: { onResolveFilter, onLoadFilter, loader, setup, config }`, `bun: { loader, setup }`.

**Typing gaps (runtime OK on Rollup-family):** `resolveId`'s `this` is `UnpluginBuildContext & UnpluginContext`
(no `resolve`, no `environment`) and its options are typed `{ isEntry }` only (types.ts:100-105); `load` result type
has no `moduleType` (types.ts:50). On vite/rolldown/rollup/unloader the plugin object is handed to the host verbatim,
so `this.resolve`, `this.environment`, `options.attributes`/`kind`/`custom`, `moduleType`, `moduleSideEffects`,
`external:'absolute'` all work at runtime — put Rollup-family hooks in the `vite`/`rolldown`/`rollup` escape hatches to
get native typings.

**`meta.framework`:** `'rollup' | 'vite' | 'rolldown' | 'farm' | 'unloader' | 'webpack' | 'rspack' | 'rsbuild' |
'esbuild' | 'bun'` (types.ts:191, 205-223). `unloader` = sxzz's Node loader on `module.registerHooks` (see §9).

**Arrays.** `UnpluginFactory<Opts, Nested>` may return `UnpluginOptions[]` (types.ts:169-172). vite/rollup/rolldown/
rsbuild/unloader return an **array of host plugins** (vite/index.ts:14-21); esbuild and bun merge all into **one**
host plugin (esbuild/index.ts:60-143); webpack/rspack apply each. Runtime: `vitePluginIsArray: true`,
`esbuildPluginIsArray: false`. Companion behaviour (alias, `fs.allow`, optimizer injection, SSR conditions) does not
need separate plugins — they are `config`/`configEnvironment`/`configResolved` hooks under `vite:`.

**`this.resolve` per host** (runtime, `$F/exp1`): vite ✓ (+`this.environment`), rolldown ✓, rollup ✓; esbuild ✗
(`this.getNativeBuildContext()` → `{framework:'esbuild', build}` → use `build.resolve`, esbuild/utils.ts:112-138);
rspack ✗ (`{framework:'rspack', compiler, compilation, loaderContext, inputSourceMap}`, rspack/context.ts:7-43);
webpack ✗ (`{framework:'webpack', compiler, compilation, loaderContext, inputSourceMap}`, webpack/context.ts:33-57) —
and on webpack the hook was **never called** for `jsr:@x/y`: default target externalised it ("external type 'module'"
error), with `externalsPresets.web:false` → `UnhandledSchemeError`; with `target:'deno'` it is silently externalised
(`$F/exp1/wp2.mjs`).

**`external: true` mapping:** rollup-family verbatim; esbuild `{path, external, namespace: plugin.name}`
(esbuild/index.ts:198-216 — every result is forced into the plugin namespace, confirming the plan); bun `{path,
external}` (namespace only for non-absolute ids); farm `external: Boolean(...)` (farm/index.ts:126-131);
**webpack: dropped** — `externalModules.add()` only suppresses `load`, the request is still redirected to a (virtual)
module (webpack/index.ts:129-158); **rspack: dropped** likewise (rspack/index.ts:143-179).

**Other caveats.**
- `esbuild.setup(rawBuild)` runs **after** the generic `onResolve({filter: onResolveFilter ?? /.*/})` is registered
  (esbuild/index.ts:152, 171, 320-321), so the generic handler wins → when `meta.framework === 'esbuild'` return an
  object with *only* `esbuild.setup` (the factory receives `meta` first, so this is easy). Bun is the opposite:
  `bun.setup` runs first (bun/index.ts:41-43). The generic `resolveId.filter.id` is tested in JS on esbuild; set
  `esbuild.onResolveFilter` for a Go-side filter.
- `rspack(compiler)` is **not called under Rsbuild** (`if (meta.framework === 'rspack' && plugin.rspack)`,
  rspack/index.ts:223); Rsbuild needs `rsbuild.setup(api)` (`api.modifyRspackConfig`/`onAfterCreateCompiler`).
- `watchChange`: native on rollup-family; webpack/rspack emulate `update`/`delete` only, from `compiler.modifiedFiles/
  removedFiles` at `make` (webpack/index.ts:197-218); **not wired on esbuild or bun**.
- `enforce` is ignored on esbuild, bun, rollup, rolldown (array order); on webpack/rspack it only sets rule `enforce`.
- Rspack virtual importer bug confirmed: importer = `decodeURIComponent(importer.slice(prefix.length))` keeps a leading
  `/` (rspack/index.ts:115-116) while ids are encoded as `resolve(prefix, encodeURIComponent(id))` (rspack/utils.ts:6-8).

## 2. Fresh's ordering trick — NOT FEASIBLE as specified; redesign

Source: `$S/repos/fresh/packages/plugin-vite/src/plugins/deno.ts` (commit 86d6cde, June 2026; @fresh/plugin-vite 1.1.2,
pins `@deno/loader@^0.4.0` and `vite@^7.1.4`).

- (a) Ordering: `sharedDuringBuild: true` (l.32), `enforce: "pre"` with the comment "We must be first … before Vite's
  own `vite:resolve`" (l.33-36), `applyToEnvironment() { return true }` (l.53-55). Node builtins → `{id:'node:x',
  external:true}` (l.57-66).
- (b) `const tmp = await this.resolve(id, importer, options)` (l.92; `skipSelf` defaults to true) and
  `if (tmp && tmp.resolvedBy !== "vite:resolve")` → accept other plugins' external/`\0` answers or reuse `tmp.id`
  (l.88-104). **`resolvedBy` is never set by Vite**: `grep resolvedBy` returns nothing in vite 8.3.1 `src/` nor in
  vite 7.3.6 `dist/`; the dev container returns `{id, …pluginResult}` only (server/pluginContainer.ts:390-470, 778-820).
  It is also absent from Rolldown's `ResolvedId` (`{external, id} & ModuleOptions`, rolldown d.ts l.2799-2802). Only
  Rollup has it (`rollup.d.ts:295,303`). Additionally the Vite 8 resolver is named **`vite:resolve-builtin`** (native
  `viteResolvePlugin`, plugins/resolve.ts:222-383) plus `vite:resolve-dev` in dev — not `vite:resolve`. Result: Fresh's
  check is a no-op in Vite dev (any version) and in Vite 8 build; it only works in Vite ≤7 build (Rollup).
  Measured (`$F/exp2/vite-probe.mjs`): dev result keys `['id']`; build keys `['id','external','packageJsonPath',
  'moduleSideEffects','meta']`.
- (c) `\0`: another plugin's `\0` result is returned untouched (l.99-101); a `\0` importer is dropped
  (l.113-116); `load` strips `\0` and looks up `getModuleInfo(id).meta.deno` (l.201-210). Its own ids are
  `\0deno::<type>::<url>` (l.325-327) and the parser repairs `https:/` → `https://` (l.336-346). No `virtual:` handling
  and **no query handling** (only `?commonjs-es-import` stripped in `transform`, l.260) — `path.fromFileUrl` drops
  queries (l.154-156), which is the `?raw` bug class.
- (d) Two loaders, not one per environment: `ssrLoader` (`platform:'node', cachedOnly:true`) and `browserLoader`
  (`platform:'browser', preserveJsx:true, cachedOnly:true`) created in `configResolved` (l.40-52) and chosen per call by
  `this.environment.config.consumer === "server"` (l.67-69, 171-173).
- (e) Dev transpile: `loader.load()` output (TS already stripped; JSX preserved for the browser) → Babel
  (`@babel/preset-react` automatic, `importSource:'preact'`) + `httpAbsolute` plugin that rewrites `/x` and
  `https://…` specifiers inside remote modules to `deno-http::…` so import analysis does not skip them (l.185-199,
  229-242, 371-417; `patches/http_absolute.ts:9-22`). SSR JSX files are re-loaded through `ssrLoader` in `transform`
  to reuse Deno's precompile (l.244-288). mod.ts forces `resolve.noExternal: true` (l.125) and
  `optimizeDeps.noDiscovery: true` (l.130).

**Portable variants (tested, `$F/exp2/probe.mjs`, `vite-probe.mjs`):**
- Rollup: `resolvedBy` works (`'rollup'` for core resolution, plugin name otherwise).
- Rolldown: call `this.resolve(id, importer, {...opts, skipSelf:true, custom:{...opts.custom, 'unplugin-deno:probe':
  true}})` and add a terminator plugin with `resolveId: {order:'post', handler}` that returns
  `{id:'\0deno-probe-miss:'+id, external:true}` when the probe flag is set. `custom` propagates through
  `this.resolve`, `order:'post'` runs after all plugins and **before** the built-in resolver → sentinel ⇒ "no plugin
  answered". Verified (virtual plugin answered; `fakepkg` and `./local.js` came back as sentinel).
  `packageJsonPath` is not a usable signal (set for local files too).
- Vite 7/8: not achievable declaratively — `vite:resolve-builtin` is a normal-order plugin placed right after the pre
  plugins (plugins/index.ts:57-145), so an `order:'post'` terminator is never reached, and a pre terminator hides
  normal plugins (both verified). Note that in Vite *normal* user plugins run after the built-in resolver anyway; only
  alias (runs first) and other pre plugins can pre-empt it. Options: (i) compare `this.resolve(...)` with
  `createIdResolver(config)(env, id, importer)` (public in vite 8 d.ts l.3131) — equal ⇒ built-in answer; or
  (ii) **recommended default everywhere:** the import map is authoritative for its keys — resolve mapped bare
  specifiers directly without `this.resolve`, keep an `exclude` option; users override via `resolve.alias`, which in
  Vite runs before pre plugins.

## 3. npm redirect to the host resolver — FEASIBLE WITH CAVEATS

Setup `$F/denoproj`, `$F/exp3` (`deno.json` `nodeModulesDir:"auto"`, `deno install` → isolated layout
`node_modules/kleur -> .deno/kleur@4.1.5/node_modules/kleur`). @deno/loader resolves `npm:kleur@^4` to the realpath
`…/node_modules/.deno/kleur@4.1.5/node_modules/kleur/index.mjs`; the plugin derives `pkgDir` and calls
`this.resolve(name+subpath, pkgDir + '/package.json', {...opts, skipSelf:true})` (walk-up from inside the package finds
the package itself; same for hoisted and pnpm layouts).

- **Vite 8 build / Rolldown: works.** Host conditions applied (`preact` → `dist/preact.module.js` via `browser`),
  subpaths kept (`kleur/colors` → `colors.mjs`), result carries `packageJsonPath` + `moduleSideEffects:null`, so
  `sideEffects:false` is honoured: lodash-es `chunk` = **2.4 KB redirect vs 83.0 KB** when the plugin loads the files
  itself (Rolldown, `$F/exp3/rd-lodash.mjs`).
- **esbuild equivalent works:** `build.resolve(bare, { kind: args.kind, resolveDir: pkgDir, importer, with })` →
  `{path, external, sideEffects, namespace, suffix, pluginData, errors, warnings}` (esbuild `lib/main.d.ts:310,
  348-369`); `kind` is **required** since the 2022 change (changelog-2022 l.569). 3.1 KB (sideEffects applied even when
  not forwarded, but forward `sideEffects`/`suffix` anyway).
- **Vite dev caveat (important):** with the fake importer inside `node_modules`, Vite's `finalizeBareSpecifier` treats
  it as a nested dep and **skips optimization** (`(importer && isInNodeModules(importer))`, plugins/resolve.ts:293-339, l.315)
  → raw `/node_modules/.deno/kleur@4.1.5/…/index.mjs?v=hash` is served, while the scanner had already
  optimized the dep under the raw key `npm:kleur@^4` (wasted, unused bundle; CJS packages would break in the browser).
  With the *real* importer (works only if a top-level `node_modules/<name>` symlink is the right version) the page gets
  prebundled deps but the scanner key (`npm:kleur@^4`) and runtime key (`kleur`) differ → **two optimizer runs**
  (= full reload in a browser). **Working recipe (verified, `$F/exp3/plugin2.mjs`):** in dev, non-scan calls use
  `this.environment.depsOptimizer` (public on `DevEnvironment`): look up `metadata.optimized[rawSpec] ??
  metadata.discovered[rawSpec]`, else `registerMissingImport(rawSpec, resolvedFile)`, and return
  `getOptimizedDepId(info)`; in scan mode return the plain resolved path. Result: one optimizer run, imports rewritten to
  `/node_modules/.vite/deps/npm_03a_kleur@_05e_4.js?v=…`. Different raw specs for the same package end up as separate
  entries sharing one chunk (single instance).
- `cacheDir`: with no package.json Vite uses `<root>/.vite` or the nearest ancestor package's `node_modules/.vite`
  (seen: `$F/node_modules/.vite`) — set `cacheDir` explicitly for deno.json-only projects.

## 4. Import-attribute rewrite pre-pass — FEASIBLE

`$F/exp4/rd.mjs` (Rolldown 1.2.11), `$F/exp5` (Vite 8 dev/build).
- Baseline Rolldown: `with {type:"text"}` and `bytes` of `data.json` both yield the JSON object (bug confirmed).
  `resolveId` options are `{isEntry, kind, custom}` only (d.ts `ResolveIdExtraOptions` l.2892-2917).
- `transform` runs before the importer's `resolveId`s (log order confirmed). `this.parse(code, {lang:'ts'})` works
  (0.2 ms warm, 1.3 ms first call); `ImportDeclaration.attributes[i]` = `{type, key, value, start, end}` (ESTree).
  Rolldown transform `meta` also offers `ast?` and `magicString?` (the latter only with
  `experimental.nativeMagicString`, d.ts l.2935, 3050-3054). Vite dev `this.parse` = `rolldown/parseAst`
  (pluginContainer.ts:774-776) — same options.
- Rewriting to `./data.json?deno-type=text` and removing the `with {…}` clause: `resolveId` receives the query
  intact and Rolldown keeps `data.json`, `data.json?deno-type=text`, `?deno-type=bytes` as distinct modules; output
  prints `{"a":1} "{\"a\":1}\n" bytes:8`. Keeping `with` also works on Rolldown, but remove it (browsers reject
  `type:'text'`). **Do not rewrite `json`**: rewriting it creates a second module instance (`obj2 === obj` became
  false); leave json native (Vite dev strips static attributes itself, importAnalysis.ts:538).
- Handle dynamic `import(x, {with:{type}})` too: Vite dev leaves the options object in place
  (`import("/data.json?import", { with: { type: "json" } })`, `$F/exp5/json-native.mjs`).
- Vite 8 dev with `\0deno:https://…?deno-type=text`: served at
  `/@id/__x00__deno:https://example.test/lib/hello.txt?import&deno-type=text`; Vite adds `import` for non-JS
  extensions and strips it before `load` (load saw `…hello.txt?deno-type=text`); `:` and `//` survive (no `https:/`
  collapse in 8.3.1). Recommendation: percent-encode the remote URL's *own* `?query` inside the id so Vite-added
  queries (`import`, `t=`, `v=`) stay separable.
- Rollup/esbuild expose attributes natively, but the returned id must still encode the type (Rollup dedupes by id).

## 5. Vite 8 dev: TS for virtual ids; alias for remote URLs — FEASIBLE WITH CAVEATS

- `transformWithOxc(code, filename, options?: rolldown TransformOptions, inMap?, config?, watcher?):
  Promise<Omit<TransformResult,'errors'>>` is exported by vite 8.3.1 (`dist/node/index.d.ts:3274`). **Not in Vite 7**
  (7.3.6 d.ts has only `transformWithEsbuild`, l.3010) → Vite 7 compat must use `transformWithEsbuild` (esbuild is a
  Vite 7 dependency).
- `vite:oxc` in dev uses `@rollup/pluginutils` `createFilter`, which rejects any id containing `\0`
  (`vite/dist/node/chunks/node.js:1914-1925`; plugins/oxc.ts:223, 311-337). In build the native transform honours
  `moduleType`. Verified: returning `{code: ts, moduleType:'ts'}` for `\0deno:…` served TS to the browser in dev,
  transpiled correctly in build; calling `transformWithOxc(code, url, {lang:'ts'})` in `load` fixes dev.
- Import analysis skips `https://`/`//`/`data:` unless `matchAlias(specifier)` (importAnalysis.ts:546-551,
  `externalRE = /^([a-z]+:)?\/\//`, utils.ts:282). Verified: no alias → `https://…` and `data:` left as-is; with
  `resolve.alias: [{find: /^(https?:\/\/|data:)/, replacement: '$1'}]` both reach the plugin, root-relative `/abs.ts`
  and `./util.ts` inside remote modules reach it with a `\0deno:` importer. **Caveats:** include `data:`; use a
  capture group + `'$1'` — **`'$&'` breaks Vite 8 build** (native alias plugin emitted `$&example.test/lib/mod.ts`,
  UNLOADABLE_DEPENDENCY); the alias is only needed for `serve`. Fresh's alternative is rewriting to `deno-http::`.

## 6. Vite optimizer injection — FEASIBLE WITH CAVEATS; D2 as written is not viable

- Types: Vite 8.3.1 `optimizeDeps.rolldownOptions?: Omit<RolldownOptions,'input'|'logLevel'|'output'> & {output?}`
  ("plugins are merged with Vite's dep plugin", d.ts l.965); `esbuildOptions` deprecated (l.950) but its `plugins`
  are **auto-converted** by `convertEsbuildPluginToRolldownPlugin` (config.ts ~l.1466-1477). Vite 7:
  `optimizeDeps.esbuildOptions` (7.3.6 d.ts l.811). Injected plugins run before `rolldownDepPlugin`
  (optimizer/index.ts:791-846). Add them from `config()` (arrays merge) or per environment in `configEnvironment`
  (SSR has its own optimizeDeps).
- **`optimizeDeps.include` cannot take Deno specifiers**: includes are resolved by `createOptimizeDepsIncludeResolver`
  → `createBackCompatIdResolver` (alias + `vite:resolve-builtin` only, **no user plugins**; optimizer/resolve.ts:11-40,
  idResolver.ts). `jsr:@std/path`/`\0deno:…` → "Failed to resolve dependency" warning; bare JSR ids fail
  `isOptimizable` (needs `/\.[cm]?[jt]s$/` or `optimizeDeps.extensions`, utils.ts:155-163). The scanner does record a
  non-node_modules dep if `include.includes(rawId)` (scan.ts:638-643).
- **Virtual entries crash** `extractExportsData` (it `fs.readFileSync`s the entry, optimizer/index.ts) — observed
  `ENOENT … open 'https://example.test/lib/mod.ts'` — unless `optimizeDeps.extensions` matches the id, in which case it
  builds the entry with `rolldownOptions.plugins`.
- **Verified working recipe** (`$F/exp6/run.mjs`): `optimizeDeps.extensions: ['.ts']` + `include` of the *final URLs*
  + our resolve/load plugin in `optimizeDeps.rolldownOptions.plugins` + dev `resolveId` returning
  `depsOptimizer.getOptimizedDepId(metadata.optimized[finalUrl])` → remote modules prebundled
  (`https_03a___example__test_lib_mod__ts.js` importing a shared util chunk). It is intrusive (`extensions:['.ts']`
  sends every `.ts` entry through the Rolldown export-extraction path). Simpler alternatives: `jsrDepsInNodeModules`
  (real files in `node_modules/@jsr/*` → the §3 npm path), materialise remote modules as real files under `cacheDir`, or
  accept unbundled remote modules in dev.

## 7. @deno/loader 0.5.0 facts — FEASIBLE WITH CAVEATS

Files: `$S/tarballs/deno-loader-0.5.0/package` (vendored copy at `$F/vendor/deno-loader`). Probes: `$F/loader-probe*.mjs`,
`$F/exp7/probe.mjs`, `$F/vendor-nodepath.mjs`.
- API (src/mod.ts): `Workspace({noConfig,noLock,configPath,nodeConditions,newestDependencyDate,platform,cachedOnly,
  debug,preserveJsx,noTranspile})` (l.64-94) → `createLoader()` → `Loader{addEntrypoints, resolveSync, resolve, load,
  getGraphUnstable}`. `platform` typed `"node"|"browser"`; Rust also accepts `"deno"` (= node) and throws on anything
  else (lib.rs:214-221). `nodeConditions` are *added* to defaults (lib.rs:292-300). Config is discovered from
  `process.cwd()` unless `configPath` is passed (lib.rs:236-247) → always pass `configPath` (multi-root processes).
  Always-on: `unstable_sloppy_imports: true`, `bare_node_builtins: true`, `NullLifecycleScriptsExecutor`,
  `NodeCodeTranslatorMode::Disabled`. `DENO_DIR` env is honoured. No lockfile was written.
- `resolveSync` exists; errors get `ResolveError.prototype` (mod.ts:282-285) with `code` **only** for Node-resolution
  errors (`ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_MODULE_NOT_FOUND` + `isOptionalDependency`, lib.rs:902-935); graph/
  import-map errors ("Could not find constraint …", "not a dependency and not in import map") have `code: undefined`.
  **Gotcha:** outside the graph `resolveSync('jsr:@std/fmt@1/colors')` returns the input unchanged,
  `'@std/path/posix'` → `'jsr:/@std/path@^1/posix'`, and `npm:` throws → fall back to `await resolve()` (43.8 ms for a
  cached jsr range).
- `load()`: `{kind:'module', specifier, mediaType, code: Uint8Array, sourceMap?: Uint8Array}` (JSON bytes, `sources =
  ['https://jsr.io/…/mod.ts']` + `sourcesContent`); **the inline `//# sourceMappingURL=data:` comment is still in
  `code`** (lib.rs:986-1027) → strip it. `load('jsr:…')` throws ("must be resolved to an https: specifier"),
  `load('npm:…')` "Unsupported scheme", `load('node:fs')` → `{kind:'external'}`, `load('data:…')` works.
- Logging: "Downloading <url>" is `console.error("Downloading", specifier)` in
  `src/lib/snippets/rs_lib-aa8c88480f363a4a/helpers.js:4` (source `src/rs_lib/helpers.js`); Rust `log` records go to
  `console.error("{LEVEL} RS - …")` and the reporter prints "Blocking …" (lib.rs:95-135). No log callback. Wrapping
  `console.error` intercepted all three lines in a cold `DENO_DIR` run → works but is process-global; patch helpers.js
  in the vendored copy instead.
- `fetch`: resolved from `globalThis.fetch` at call time (helpers.js:17, `redirect:'manual'`, `response.bytes()`);
  replacing `globalThis.fetch` counted 3 calls → injectable (patch per instance when vendoring). No retries
  (http_client.rs:108 "todo: implement retrying"); client certs only on Deno (helpers.js:36-42); `cachedOnly` only
  blocks remote-module fetches (http_client.rs:74-78), not npm tarballs. Node fetch ignores `HTTP(S)_PROXY` unless
  `--use-env-proxy`/`NODE_USE_ENV_PROXY`.
- Wasm loading: Node/Bun path `rs_lib_node.js:14-25` = `readFileSync(lib/rs_lib.wasm)` + **synchronous**
  `new WebAssembly.Module()` + `new WebAssembly.Instance(…, {'./rs_lib.internal.js', 'node:tty': {isatty}})` at import;
  Deno path `lib/rs_lib.js:8` = Wasm ESM `import * as wasm from "./rs_lib.wasm"` (selected by `typeof Deno`,
  mod.ts:55-59). The Node path also works on Deno and Bun (verified) → one code path is possible.
- Timing (this Mac): Node import+compile+instantiate 84 ms cold, ~15 ms warm; Deno 19-44 ms (native path), 94 ms
  (Node path); Bun 27-53 ms; `Workspace`+`createLoader` ~20-25 ms; `addEntrypoints` 65 ms (small cached graph).
- License: MIT, "Copyright (c) 2018-2025 the Deno authors".

## 8. webpack / Rspack hooks — FEASIBLE

- webpack 5.111.1 `types.d.ts`: `NormalModuleFactory.hooks.resolveForScheme: HookMap<AsyncSeriesBailHook<
  [ResourceDataWithData, ResolveData], true|void>>` and `resolveInScheme` (same signature, since 5.49) (l.19657-19670);
  `NormalModule.getCompilationHooks(compilation).readResource: HookMap<AsyncSeriesBailHook<[AnyLoaderContext],
  null|string|Buffer>>` (since 5.58; `readResourceForScheme` deprecated) (l.19447-19462). `ResourceDataWithData =
  {resource, path?, query?, fragment?, context?, data}` (l.25634-25641).
- @rspack/core 2.2.7: `NormalModuleFactory.hooks.resolveForScheme: HookMap<AsyncSeriesBailHook<
  [ResourceDataWithData], true|void>>` — **one argument, and there is no `resolveInScheme`** (hooks:
  resolveForScheme, beforeResolve, factorize, resolve, afterResolve, createModule; `dist/NormalModuleFactory.d.ts`);
  `NormalModule.getCompilationHooks(c).readResource` typed (`dist/NormalModule.d.ts:7`, unwired per rspack#12210);
  `rspack.experiments.VirtualModulesPlugin` (`new (modules?)`, `writeModule(path, contents)`, exports.d.ts:186,
  VirtualModulesPlugin.d.ts); rules support `scheme?: RuleSetCondition`, `with?`, `enforce?: 'pre'|'post'`
  (config/types.d.ts:719-745). Earlier run `$S/bundlers-deno-test/scheme-rspack-pitch.ts` shows a `scheme` +
  `enforce:'pre'` pitching loader supplying TS source with `builtin:swc-loader` still applied downstream.

## 9. Node `module.registerHooks` sync bridge — FEASIBLE (Node 26, Deno 2.9.7); Bun: no

`$F/exp9`: Node 26.8.1 — an `async resolve` hook fails (`ERR_INVALID_RETURN_PROPERTY_VALUE … got undefined`), so hooks
are sync-only; a worker + `SharedArrayBuffer`/`Atomics.wait` + `receiveMessageOnPort` bridge resolved `jsr:`/`npm:` for
static and dynamic imports. Deno 2.9.7: `registerHooks` is a function and the same bridge worked with
`deno run --import`. Bun 1.3.14: `registerHooks` is undefined (`module.register` exists) → use `Bun.plugin` +
`--preload`. unplugin 3.4.0's `unloader` target (unloader 0.10.1, "Node.js loader with a Rollup-like interface") is
built on `module.registerHooks` and **throws if a hook returns a Promise** — E1 can reuse the same factory via
`unplugin.unloader`, with the bridge inside `load`.

## 10. Vendoring @deno/loader — FEASIBLE

`src/lib/rs_lib.wasm` 5,488,465 B (gzip -9 2,152,570 B; brotli 1,591,927 B); `rs_lib.internal.js` 33,278 B;
`mod.js` 8,368 B; `rs_lib_node.js` 924 B; helpers.js 1,052 B; JSR tgz 2,216,691 B. The glue imports only `node:fs`
(sync fns), `node:process` (`cwd`,`env`,`platform`), `node:tty` (`isatty`), `node:url`, `node:path`; globals `fetch`,
`console.error`, `crypto.getRandomValues`, `Atomics.wait`, `WebAssembly`. `Deno.*` appears only behind `typeof Deno`
guards (helpers.js:37-40). Keep `vendor/` as copied files (don't let tsdown follow `import "./rs_lib.wasm"`), or patch
mod.js to always use the Node path; consider `WebAssembly.compile` (async) to avoid the sync compile at import.

## Plan corrections (exact names)

- §6/§8: our own `unplugin-deno/vite` etc. must wrap `createVitePlugin(factory)`/`unplugin.vite`; unplugin has no subpaths.
- §3.1-3 / R2: drop "`resolvedBy`/ignore `vite:resolve`"; Vite 8 resolver = `vite:resolve-builtin` (+`vite:resolve-dev`);
  use authoritative import map (+ Rolldown probe/`order:'post'` terminator, Rollup `resolvedBy`, Vite `createIdResolver`
  comparison as options).
- §3.2 npm row / D2: Vite dev needs `this.environment.depsOptimizer.{metadata, registerMissingImport, getOptimizedDepId}`
  keyed by the raw Deno specifier; `optimizeDeps.include` cannot hold `jsr:`/`npm:`/`\0deno:`; virtual entries need
  `optimizeDeps.extensions`.
- D1: `resolve.alias` `{find: /^(https?:\/\/|data:)/, replacement: '$1'}` (dev only; never `'$&'`).
- L4/D6: `transformWithOxc` is Vite 8 only; Vite 7 → `transformWithEsbuild`.
- §3.3: `resolveSync` falls back to `resolve()` when it returns `jsr:` or throws for `npm:`; strip inline sourcemap
  comment; always pass `configPath`; `ResolveError.code` is often undefined.
- §5 esbuild: `build.resolve(path, {kind, resolveDir, importer, with})` (`kind` required); return only `esbuild.setup`
  for esbuild. Rsbuild: `rsbuild.setup(api)`, not `rspack(compiler)`. Rspack: no `resolveInScheme`; `resolveForScheme`
  has 1 arg.
- E1: mention `unplugin.unloader` (sync hooks) + Bun via `Bun.plugin`.
