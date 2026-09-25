# unplugin-deno — Target-platform capability research (snapshot: 2026-09-25)

Scope: the *hosts* a new multi-bundler Deno plugin (built on unplugin) must run inside/against — unplugin itself,
Vite, Rolldown/tsdown, Rollup, esbuild (+Bun), Rspack/Rsbuild, webpack, Farm, the Deno 2.5→2.9 platform, and
TypeScript/JSX transpilers. Everything below was verified against **published packages (`npm pack` + `.d.ts`/dist
reading)**, **GitHub releases/issues via `gh`**, official docs/blogs, and **hands-on experiments run under Deno 2.9.7**
(see §1). Where a statement comes from a blog summary only, it is marked *(blog)*.

Local environment used for experiments: macOS arm64, Deno 2.9.7 (V8 15.0, TypeScript 6.0.3), Node 26.8.1, Bun 1.3.14,
pnpm 12.5.1.

---------------------------------------------------------------------------------------------------------------------

## 0. TL;DR

### 0.1 Verified latest versions (npm registry / GitHub, 2026-09-25)

| Package | Latest | Released | Notable previous milestones |
|---|---|---|---|
| `unplugin` | **3.4.0** | 2026-09-16 | 3.0.0 2026-01-22 (ESM-only, Node ≥20.19/22.12, Bun adapter, acorn removed); 3.3.0 2026-06-29 (Rsbuild adapter); dist-tags `latest-v2`=2.3.10, `latest-v1`=1.16.1 |
| `vite` | **8.3.1** | 2026-09-24 | 8.0.0 2026-03-12 (Rolldown+Oxc default), 8.1.0 06-23, 8.2.0 07-30, 8.3.0 09-10; `previous`=7.3.6 |
| `rolldown-vite` | 7.3.1 (frozen) | 2026-01-09 | superseded by Vite 8 |
| `rolldown` | **1.2.11** | 2026-09-24 | 1.0.0 **GA 2026-05-07** (rc.1 2026-01-22), 1.1.0 06-03, 1.2.0 07-15 |
| `@rolldown/pluginutils` | 1.0.1 | — | composable filters |
| `tsdown` | **0.23.0** | 2026-09-03 | depends on `rolldown ~1.2.7`, `rolldown-plugin-dts ^0.28.5` |
| `rollup` | **4.63.5** | 2026-09-24 | 4.38.0 (hook filters), 4.24.0 (JSX); **Rollup 5 not released** (umbrella PR #5994 open) |
| `esbuild` | **0.28.2** | 2026-08-08 | 0.28.0 2026-04-02 (`with {type:'text'}`); stopped publishing to deno.land/x (unreleased notes) |
| `@rspack/core` | **2.2.7** | 2026-09-23 | 2.0.0 2026-04-22; `latest-v1`=1.7.12 |
| `@rsbuild/core` | **2.2.9** | 2026-09-23 | 2.0.0 2026-04-22; `latest-v1`=1.7.6 |
| `@rslib/core` | 1.0.2 | 2026-09-23 | 1.0.0 2026-09-03 |
| `@rspress/core` | 2.0.22 | — | — |
| `webpack` | **5.111.1** | 2026-09-18 | 5.108.0 2026-06-25 (`deno`/`bun` targets), 5.109.0 07-23 (`experiments.typescript: "auto"`), 5.111.0 09-14 (`experiments.outputModule` removed) |
| `@farmfe/core` | **1.7.11** | 2025-08-04 | `beta`=2.0.0-beta.11 (2026-05-28); repo last commit 2026-06-14 |
| `unloader` | 0.10.1 | 2026-08-03 | Node ≥22.18 loader framework (unplugin target) |
| `vitest` | 5.0.2 | 2026-09-25 | 5.0.0 09-03; peer `vite ^6.4 \|\| ^7 \|\| ^8` |
| `typescript` | **7.0.2** (native Go) | 2026-07-08 | 6.0.2 2026-03-23 / 6.0.3 04-16; `next`=7.1.0-dev |
| `bun` / `bun-types` | 1.4.2 | 2026-09-05 | 1.4.0 2026-08-20 (local machine still on 1.3.14) |
| Deno | **2.9.7** | 2026-09-17 | 2.5.0 2025-09-10, 2.6.0 2025-12-10, 2.7.0 2026-02-25, 2.8.0 2026-05-22, 2.9.0 2026-06-25 |
| `@deno/vite-plugin` (npm) | 2.0.4 | 2026-09-24 | — |
| `jsr:@deno/loader` | 0.5.0 | 2026-03-29 | 0.4.0 03-28, 0.3.x through 2026-03 |
| `jsr:@deno/esbuild-plugin` | 1.2.1 | 2025-12-03 | — |
| `jsr:@deno/rolldown-plugin` | 0.0.10 | — | — |
| `jsr:@luca/esbuild-deno-loader` | 0.11.1 | — | — |
| `oxc-transform`/`oxc-parser` | 0.151.0 | 2026-09-21 | Rolldown 1.2.11 pins `@oxc-project/types =0.151.0` |
| `@swc/core` | 1.16.2 | 2026-09-04 | — |

### 0.2 The ten findings that matter most for the plugin design

1. **All major JS bundlers run under Deno 2.9.7 from the global npm cache (no `node_modules`)** — tested: Rolldown 1.2.11
   (napi), Vite 8.3.1 (`deno run -A npm:vite build`), Rspack 2.2.7 (napi), esbuild 0.28.2 (binary), webpack 5.111.1,
   Rollup 4.63.5 (napi), tsdown 0.23.0. Rolldown's minimum permissions: `--allow-env --allow-read --allow-ffi`.
2. **Rolldown is the best-fit core**: native Rust-side hook filters (`resolveId.filter.id` RegExp-only, composable
   `@rolldown/pluginutils` expressions incl. `importerId`), `load` may return `moduleType: 'ts'|'tsx'|…` for
   extension-less ids (tested with `https://example.com/mod`), built-in Oxc TS/JSX. **But Rolldown does not pass
   import attributes to `resolveId` and ignores `with {type:'text'|'bytes'}` (extension-based, deduped by id)** —
   tested; tracked in rolldown#2758/#6410/#9088/#10407 and on the 2026-Q3 plan (#10042).
3. **Vite 8 dev ≠ Vite 8 build.** Dev import-analysis *skips* `http(s)://` specifiers entirely (`isExternalUrl` →
   left for the browser) unless they match a `resolve.alias`; `vite:oxc` in dev decides TS transpilation from the **id
   extension** (`oxc.include`), never for `\0`-prefixed ids, and ignores `moduleType` returned by `load` (tested: build
   honours `moduleType:'ts'`, dev serves the TS untranspiled); the dep optimizer / SSR auto-externalization
   only recognise paths containing a `node_modules` segment (`/(?:^|[\\/])node_modules(?:[\\/]|$)/`) — Deno global-cache
   paths (`$DENO_DIR/npm/registry.npmjs.org/…`) are neither optimised nor externalised.
4. **webpack: unplugin's `resolveId` never sees scheme specifiers** (tested `jsr:` and `https:`; `npm:` takes the same scheme path). unplugin implements `resolveId`
   as an enhanced-resolve `resolve.plugins` entry; webpack's `NormalModuleFactory` routes any `scheme:` request to
   `resolveForScheme` first → `UnhandledSchemeError` (tested, unplugin 3.4.0 + webpack 5.111.1). The *working* native
   path (tested) is `nmf.hooks.resolveForScheme.for(s)` + `nmf.hooks.resolveInScheme.for(s)` +
   `NormalModule.getCompilationHooks(c).readResource.for(s)` — i.e. use the `webpack(compiler)` escape hatch.
5. **Rspack: `readResource` is typed but not wired** (rspack#12210; tested — never fires). unplugin's Rspack adapter
   *does* see scheme requests (via `nmf.hooks.resolve`) and serves them as virtual files under
   `node_modules/.virtual/<encodeURIComponent(id)>`, but the **importer passed back for requests from those virtual
   modules has a spurious leading `/`** (`/https://…`, related unplugin#483/#421) — tested. Native alternative (tested):
   `resolveForScheme.for(s)` + a `module.rules[{ scheme, enforce:'pre' }]` **pitching loader** that returns the source.
6. **Both webpack & Rspack externalise `http(s)://` by default for `target: 'web'`** (`externalsPresets.web`), and
   webpack's new **`target: 'deno'` (5.108, PR #21247) externalises `npm:`, `jsr:`, `node:`, `http(s):`** (DenoTargetPlugin,
   applied in `factorize`, i.e. before any resolver) — tested. A bundling plugin must turn these presets off (or
   deliberately rely on them for "Deno-runtime output keeps remote specifiers").
7. **esbuild via unplugin puts *every* `resolveId` result into `namespace: <plugin.name>`**, so even real files must
   be loaded by the plugin (tested: "Do not know how to load path: ns-test:/…/dep.js"); and unplugin's esbuild
   `onResolve` filter is `/.*/` unless `esbuild.onResolveFilter` is set (hook `filter` is only checked in JS).
   esbuild itself is excellent for Deno: `with` attributes in `onResolve/onLoad`, `type:'text'` and `type:'bytes'`
   supported (tested), `pluginData`, `build.resolve()`.
8. **Deno 2.8+ implements `node:module.registerHooks()` (sync hooks; tested with a virtual module) but not
   `module.register()`**; `require(esm)` works; `process.versions.node` = 26.5.1, `napi` = 10;
   `module.stripTypeScriptTypes` exists (so webpack's built-in TS works under Deno).
9. **Import attributes landscape**: Deno 2.8 made `with { type: "text" }` stable; `"bytes"` still needs
   `--unstable-raw-imports` (tested: `"bytes" is not a valid module type` without it); CSS module imports (2.9) also
   behind the flag. Rollup passes `attributes` + `importerAttributes` to `resolveId` and `attributes` to `load`
   (tested) but warns/dedupes on inconsistent attributes for the same specifier; webpack/Rspack expose
   `resolveData.attributes` and key modules per attribute (tested).
10. **No transpiler outside Deno supports `jsx: "precompile"`** (Oxc: classic/automatic; SWC: automatic/classic/
    preserve; esbuild: transform/preserve/automatic). Options: `deno transpile` (2.8+, experimental; tested — honours
    `jsxPrecompileSkipElements`), `jsr:@deno/loader` (WASM deno_ast), or `Deno.bundle()`/`deno bundle` (esbuild 0.25.5
    driven from Rust).

---------------------------------------------------------------------------------------------------------------------

## 1. Hands-on verification log (all under Deno 2.9.7, no `node_modules`)

Scripts live under `$SCRATCH` = `/private/tmp/claude-501/-Users-divyansh-unplugin-deno/1a551bae-bee4-41ac-ba89-ea42b9e7cb9a/scratchpad`.

| # | Experiment | Script | Result |
|---|---|---|---|
| 1 | Rolldown napi under Deno (user's exact command) | `rolldown-deno-test/` | ✅ `//#region a.ts const a = 1; …` in 0.8 s |
| 2 | Rolldown permissions | `rolldown-deno-test/plugin-test.ts` | Fails without perms at `process.env.NAPI_RS_WASI_FLAVOR`; ✅ with `--allow-env --allow-read --allow-ffi` (no `--allow-sys` needed for a simple build) |
| 3 | Rolldown hook filters + `moduleType:'ts'` for extension-less `https://example.com/mod`; `transform` filter `{ moduleType: ['ts'] }`; `with {type:'json'}` | same | ✅ TS stripped, JSON inlined; `transform` meta.moduleType = `ts`; resolveId opts = `{ isEntry, kind:'import-statement' }` (**no attributes**) |
| 4 | Rolldown `with {type:'text'}` + `with {type:'bytes'}` on the same `.txt` | `rolldown-deno-test/attrs-test.ts` | ⚠️ both imports became the **same text module** (`hello_default` twice) — bytes silently wrong |
| 5 | Deno itself, same file | `rolldown-deno-test/attrs.ts` | ❌ `"bytes" is not a valid module type` without `--unstable-raw-imports`; ✅ with it |
| 6 | `deno run -A npm:vite@8.3.1 build` | `bundlers-deno-test/` | ✅ built in 102 ms |
| 7 | esbuild 0.28.2 JS API | `bundlers-deno-test/esb.ts` | ✅ |
| 8 | esbuild `with {type:'text'}` / `{type:'bytes'}` | `bundlers-deno-test/esb-attrs.ts` | ✅ separate modules; bytes → `Uint8Array.fromBase64(...)`; `onResolve` args `with` populated |
| 9 | Rspack 2.2.7 + `builtin:swc-loader` | `bundlers-deno-test/rsp.ts` | ✅ |
| 10 | webpack 5.111.1 `target:'deno'` | `bundlers-deno-test/wp2.ts` | ✅ ESM `.mjs` output, `node:fs` → `import * as … from "node:fs"`, resolved defaults dumped (see §G) |
| 11 | Rspack custom schemes: `resolveForScheme` + `readResource` | `scheme-rspack.ts` | ❌ `readResource` never called → "Reading from "jsr:…" is not handled by plugins (Unhandled scheme)" |
| 12 | Rspack custom schemes: `resolveForScheme` + NMF `resolve` (relative from scheme issuer) + `rules[{scheme, enforce:'pre'}]` pitching loader | `scheme-rspack-pitch.ts`, `pitch-loader.cjs` | ✅ `hello from-dep 42` (after `externalsPresets.web:false`; with default `target:'web'` the `https:` import was externalised) |
| 13 | webpack custom schemes: `resolveForScheme` + `resolveInScheme` + `readResource`, TS via built-in `experiments.typescript` | `scheme-webpack.ts` | ✅ `hello from-dep! 42` (incl. JSON with `type:'json'` inside a `jsr:` module) |
| 14 | unplugin 3.4.0 → Rspack, `resolveId`/`load` for `jsr:`/`https:` | `up-plugin.ts`, `up-rspack.ts` | ✅ only after stripping a leading `/` from `importer` (`/https://…`) |
| 15 | unplugin 3.4.0 → webpack, same plugin | `up-webpack.ts` | ❌ `resolveId` never called; `UnhandledSchemeError` for both `jsr:` and `https:` |
| 16 | unplugin 3.4.0 → esbuild, `resolveId` returns a real file path, no `load` | `esb-ns.ts` | ❌ "Do not know how to load path: ns-test:/…/dep.js" |
| 17 | webpack/Rspack text+bytes attributes | `wp-attrs.ts`, `rsp-attrs.ts` | Rspack ✅; webpack builds separate modules per attribute but the dev runtime for bytes under `target:'deno'` threw `toImmutableBytes(...) is not a function` (ASI bug in emitted runtime) |
| 18 | Rollup 4.63.5 under Deno, attributes | `rollup-test.ts` | ✅ napi OK; `resolveId` opts `{attributes:{type:'text'}, importerAttributes:{}}`, `load(id,{attributes})`; ⚠️ second import with `type:'bytes'` → warning "…already imported elsewhere with "type": "text"…", reused |
| 19 | `node:module` under Deno | `remote-lock-test/hooks.mjs` | `registerHooks` ✅ (virtual module via `data:` URL); `register` = `undefined`; `stripTypeScriptTypes`/`findPackageJSON`/`isBuiltin` present; `require(esm)` ✅ |
| 20 | `deno transpile` + `jsx:"precompile"` | `jsx-precompile-test/` | ✅ emits `jsxTemplate`/`jsxEscape` from `npm:preact@10/jsx-runtime`, honours `jsxPrecompileSkipElements` |
| 21 | tsdown 0.23.0 under Deno | `tsdown-deno-test/` | ✅ JS build; `--dts` errors: "TypeScript is not installed… (v7.0 is not yet supported), or enable `isolatedDeclarations`…" |
| 22 | `deno info --json`, `deno.lock` v5, DENO_DIR layout | `remote-lock-test/` | see §I |
| 23 | Vite 8.3.1 **build**: `import … from "https://example.com/x.js"` with a normal and an `enforce:'pre'` spy plugin | `bundlers-deno-test/vext.ts` | only the **pre** plugin's `resolveId` saw it; output keeps it as an external import |
| 24 | Vite 8.3.1 **dev** (`transformRequest`): `https://…/x.ts` + `jsr:@luca/hello/mod.ts`, pre plugin returning `\0deno:<id>` | `bundlers-deno-test/vdev.ts` | without alias: `https:` import left untouched (plugin never called), `jsr:` → `/@id/__x00__deno:jsr:…`; **with `resolve.alias: [{ find: /^(https?:\/\/.*)$/, replacement: '$1' }]`** the `https:` import is resolved too → `/@id/__x00__deno:https://…` |
| 25 | Vite 8.3.1 **build**: pre plugin resolves `https://example.com/noext` → `\0deno:https://example.com/noext`, `load` returns TS + `moduleType:'ts'` | `bundlers-deno-test/vmt.ts` | ✅ TS stripped, constant inlined (`console.log(42)`) |
| 26 | Vite 8.3.1 **dev**: same module with ids `\0deno:https://…`, `\0deno/https/example.com/noext`, `\0deno/https/example.com/noext.ts` | `bundlers-deno-test/vmt4.ts` | ❌ in **all three** the TS source is served untranspiled (`export const x: number = 42 as number;`) — Vite's `createFilter` rejects any id containing `\0`, and `vite:oxc` ignores `moduleType` |

---------------------------------------------------------------------------------------------------------------------

## A. unplugin (unjs/unplugin) — 3.4.0

Sources: repo cloned at `$SCRATCH/repos/unplugin` (HEAD `f2acf00`), GitHub releases
<https://github.com/unjs/unplugin/releases>, docs <https://unplugin.unjs.io/guide/>.

### A.1 Release history relevant to us
- **v3.0.0 (2026-01-22)** — *Breaking:* drop Node 18 & the CJS build (#558); **remove acorn** — `this.parse` now
  requires `setParseImpl(fn)` for non-Rollup-family hosts. *Features:* **Bun plugin support** (#539); expose input
  source map for webpack-like bundlers (#562). *Perf:* lazy-load `webpack-virtual-modules`.
- v3.2.0 (2026-06-24) — Bun: sanitize plugin names into namespaces (#599), consume `plugin.bun` (#603),
  `bun.loader` per-plugin loader (#601).
- **v3.3.0 (2026-06-29)** — **Rsbuild adapter** (#608).
- **v3.4.0 (2026-09-16)** — add missing optional peer deps; **`resolveId.filter.id` only accepts a `RegExp`** (string/glob
  filters disallowed, matching Rolldown/Rollup semantics).
- `package.json`: ESM-only, `engines.node: ^20.19.0 || >=22.12.0`; optional peers: `@farmfe/core`, `@rsbuild/core`,
  `@rspack/core`, `bun-types-no-globals`, `esbuild`, `rolldown`, `rollup`, `unloader`, `vite`, `webpack`.
  Exports: `.`, `./rspack/loaders/{load,transform}`, `./webpack/loaders/{load,transform}`.

### A.2 Supported hosts & factories
`createUnplugin(factory)` returns getters: `vite`, `rollup`, `rolldown`, `webpack`, `rspack`, `rsbuild`, `esbuild`,
`farm`, `unloader`, `bun`, `raw`. Per-host factories: `createVitePlugin`, `createRollupPlugin`, `createRolldownPlugin`,
`createWebpackPlugin`, `createRspackPlugin`, `createRsbuildPlugin`, `createEsbuildPlugin`, `createFarmPlugin`,
`createUnloaderPlugin`, `createBunPlugin`; plus `setParseImpl`, `version`. (Docs mention `defineUnplugin` — **not
exported**.) `UnpluginFactory<Options, Nested>` may return an array (nested plugins; Rollup ≥3.1).

`meta` (`UnpluginContextMeta`): `framework: 'rollup'|'vite'|'rolldown'|'farm'|'unloader'|'webpack'|'esbuild'|'bun'|'rspack'|'rsbuild'`,
`versions: Partial<Record<SupportedFramework|'unplugin', string>>` (Rollup-family versions only populated **after
`buildStart`**; Vite ≥7 provides `viteVersion` and the underlying `rollupVersion`/`rolldownVersion`; esbuild and Farm
provide none), `webpack.compiler` / `rspack.compiler`, `esbuildHostName`, `bunHostName`, plus `Partial<RollupContextMeta>`
(`watchMode`, `rollupVersion`).

### A.3 Hook support matrix (from `src/*` + docs table)

| Hook / option | Rollup | Vite | Rolldown | webpack | Rspack | Rsbuild | esbuild | Farm | Bun | Unloader |
|---|---|---|---|---|---|---|---|---|---|---|
| `enforce` | ignored¹ | ✅ | ignored¹ (docs claim ✅) | rule `enforce` for load/transform | same | same | ❌ | `priority` 102/100/98 | ❌ | ignored |
| `buildStart` | ✅ | ✅ | ✅ | `compiler.hooks.make` | `make` | `make` | `onStart` | `buildStart` | `onStart` | ✅ |
| `resolveId` | ✅ | ✅ | ✅ | enhanced-resolve `resolve.plugins` (`resolve` hook) | `nmf.hooks.resolve` (≥1.0.0-alpha.1) | via Rspack | `onResolve` | `resolve` | `onResolve` | ✅ |
| `load` | ✅ | ✅ | ✅ | rule + `unplugin/webpack/loaders/load` (`type:'javascript/auto'`) | rule + loader | same | `onLoad` | `load` | `onLoad` | ✅ |
| `transform` | ✅ | ✅ | ✅ | rule `use()` + transform loader | same | same | synthesized in `onLoad` | `transform` | in `onLoad` | ✅ |
| `watchChange` | ✅ | ✅ | ✅ | from `compiler.modifiedFiles/removedFiles` at `make` | same | same | ❌ | `updateModules` | ❌ | — |
| `buildEnd` | ✅ | ✅ | ✅ | `compiler.hooks.emit` | `emit` | `emit` | `onEnd` | `buildEnd` | `onEnd` (≥1.3.0) | ✅ |
| `writeBundle` (no args) | ✅ | ✅ | ✅ | `afterEmit` | `afterEmit` | `afterEmit` | `onEnd` | `finish` | `onEnd` | — |
| `loadInclude`/`transformInclude` | deprecated → use `filter` |

¹ `enforce` is a Vite concept; Rollup/Rolldown order by array position and per-hook `order: 'pre'|'post'`
(Rolldown's `BuiltinPlugin.enforce` is documented as "Vite-specific").

**Hook filters (`{ filter, handler }`)** — types in `src/types.ts`:
`resolveId.filter.id?: RegExp` (3.4.0), `load.filter.id?: StringFilter`, `transform.filter.{id,code}?: StringFilter`
(`StringFilter = string|RegExp|Array | {include, exclude}`; strings are picomatch globs resolved against `process.cwd()`;
ids normalised to `/`). **No `moduleType` or composable-expression filters** in unplugin's type (open request
unplugin#508 for `@rolldown/pluginutils`).

How filters are applied (`src/rollup/index.ts#toRollupPlugin`, `src/*/index.ts`):
| Host | Native? |
|---|---|
| Rolldown | **passed through natively** (`nativeFilter = key === 'rolldown'`) → evaluated in Rust |
| Vite | handler wrapped; wrapper defers to native when `this.meta.viteVersion` exists (Vite ≥7) — filter object stays on the hook |
| Rollup | wrapped; native when `this.meta.rollupVersion ≥ 4.40` (4.40 fixed AND-semantics, rollup#5909) |
| Unloader | wrapped (JS) |
| webpack/Rspack | JS: `resolveId` filter checked inside the resolver tap; `load`/`transform` id filters checked in the rule `include()`/`use()` (outside the loader — cheap); `transform.code` checked inside the loader |
| esbuild | **JS only**: `onResolve({ filter: esbuild.onResolveFilter ?? /.*/ })`, `onLoad({ filter: esbuild.onLoadFilter ?? /.*/ })` — set these escape hatches for real perf |
| Bun | JS only (`onResolve({filter:/.*/})`) |
| Farm | JS (`filters.sources` come from **user options** `options.filters`, else `['.*']`) |

### A.4 Context (`this`) support
`UnpluginBuildContext`: `addWatchFile`, `emitFile` (**`EmittedAsset` only**), `getWatchFiles`, `parse` (needs
`setParseImpl` except Rollup/Rolldown/Vite), `getNativeBuildContext?()` →
`{framework:'webpack', compiler, compilation?, loaderContext?, inputSourceMap?}` | `{framework:'rspack', …}` |
`{framework:'esbuild', build}` | `{framework:'farm', context}` | `{framework:'bun', build}`.
`UnpluginContext`: `error`, `warn` (webpack/Rspack resolver: first error wins, others `console.error`).
**There is no `this.resolve`** (open since 2022: unplugin#47) — a resolver plugin cannot delegate to the host resolver
through unplugin; use `rollup/vite/rolldown` hook objects (`this.resolve`), esbuild `build.resolve`, webpack/Rspack
`compiler.resolverFactory.get('normal')` / `nmf.getResolver()`, or `rspack.experiments.resolver.ResolverFactory`.
`this.fs` proposal: unplugin#593 / PR #596 (open).

### A.5 Escape hatches (per plugin object)
`rollup?: Partial<RollupPlugin>`, `vite?: Partial<VitePlugin>`, `rolldown?: Partial<RolldownPlugin>`,
`unloader?: Partial<UnloaderPlugin>` (all `Object.assign`-ed onto the generated plugin → can override hooks, add
`config`, `configResolved`, `configureServer`, `applyToEnvironment`, `options`, etc.), `webpack?(compiler)`,
`rspack?(compiler)`, `rsbuild?: Partial<RsbuildPlugin>` (its `setup(api)` runs after unplugin pushes the Rspack plugin
via `api.modifyRspackConfig`), `esbuild?: { onResolveFilter, onLoadFilter, loader: Loader | (code,id)=>Loader, setup(build), config(initialOptions) }`,
`farm?: Partial<JsPlugin>`, `bun?: { loader, setup(build) }`.

### A.6 How `resolveId`/`load` behave for non-file ids, per host (source + experiments)
- **Rollup/Vite/Rolldown/Unloader**: plugin object is passed through; ids like `https://…`, `jsr:@x/y`, `\0deno:…` are
  fine. Returning `{ code, moduleType }` from `load` works at runtime for Rolldown/Vite (unplugin's `TransformResult`
  type only declares `{code, map}` → needs a cast).
- **webpack** (`src/webpack/index.ts`): resolver plugin taps `resolver.getHook('resolve')`; importer =
  `request.context.issuer` (virtual prefix stripped); `isEntry = issuer === ''`. If the resolved id is not on disk
  (`fs.existsSync`), it becomes a virtual file `<context>/_virtual_<encodeURIComponent(id)>` registered in
  `webpack-virtual-modules`; `load` rule decodes it back. `external: true` only **skips `load`**; it does **not**
  externalise (unplugin#238). ⚠️ Scheme specifiers (`jsr:`, `npm:`, `https:`, `node:`?) never reach the resolver plugin
  (NMF `resolveForScheme` path) — **experiment 15**. Known issues: #618/#617 (ENOENT on persistent-cache restore of
  `_virtual_` paths), #591/#592 (`#` escaped as `\0#` in ids), #32 (persistent cache), #524 (loader not `raw` →
  binary corruption), #616/#615 (transform sourcemaps dropped), #421/#483.
- **Rspack** (`src/rspack/index.ts`): taps `compilation → normalModuleFactory.hooks.resolve.tapPromise` (one Rust→JS
  crossing per request, no native filter). Non-existent results become `<context>/node_modules/.virtual/<encodeURIComponent(id)>`
  written through `compiler.rspack.experiments.VirtualModulesPlugin` (native, Rspack ≥1.5; still under `experiments` in
  2.2.7) or a `FakeVirtualModulesPlugin` that writes real empty files under `node_modules/.virtual/<pid>`. Scheme
  specifiers **do** reach it (experiment 14). ⚠️ importer for requests *from* a virtual module is decoded with a
  leading `/` (e.g. `/https://example.com/lib/remote.ts`) — strip it. TS rules still match because the virtual file
  name ends in `.ts`; **extension-less ids (e.g. `https://esm.sh/react`) will not match `test:/\.tsx?$/` rules** →
  encode an extension/query in the id.
- **esbuild** (`src/esbuild/index.ts`): `resolveId` result → `{ path, namespace: plugin.name, external? }` for *every*
  result (experiment 16) → you must `load` every id you resolve (or return real files via `esbuild.setup` with
  `namespace:'file'`). `load` result → `{ contents, loader: esbuild.loader ?? guessLoader(ext), resolveDir: dirname(path) }`
  (`guessLoader` maps `.ts/.mts/.cts→ts`, `.tsx→tsx`, `.json`, `.txt→text`, else `js`); `transform` is emulated inside
  a single combined `onLoad`. `initialOptions.external` short-circuits `resolveId`. Import attributes (`args.with`) are
  **not** forwarded to hooks. Open: #546 (`browser:false` stubs), #517.
- **Bun** (`src/bun/index.ts`, needs Bun ≥1.2.22): single `onResolve({filter:/.*/})`; non-absolute results go to
  `namespace: sanitize(plugin.name)`, absolute results stay in `file`; `load` served by per-namespace `onLoad`;
  loader from `bun.loader` or extension guess.
- **Farm** (`src/farm/index.ts`): importer passed as `path.resolve(params.importer ?? '')` (**never `undefined`**, and
  URL importers get mangled into `/cwd/https:/…`); `\0` encoded as `\\0`; moduleType guessed from extension.
- **Rsbuild**: wraps the Rspack adapter inside `setup(api)` → `api.modifyRspackConfig(c => c.plugins.push(...))`.

### A.7 Deno & Bun notes
- unplugin has no Deno-specific code; the only Deno issue (#372, 2024) was closed as "what would that mean". Nothing
  in unplugin blocks running it *under* Deno (ESM-only, `import.meta.dirname`, `createRequire` for
  `webpack-virtual-modules`) — experiments 14–16 ran unplugin 3.4.0 under Deno 2.9.7.
- **Bun is supported since 3.0.0** (`unplugin.bun`) — Bun's plugin API is esbuild-like (`onResolve/onLoad/onStart/onEnd`
  + `onBeforeParse` native + `build.module()` virtual modules).

---------------------------------------------------------------------------------------------------------------------

## B. Vite — 8.3.1 (stable; Rolldown is the only bundler)

Sources: `npm pack vite@8.3.1` (`dist/node/index.d.ts`, `dist/node/chunks/node.js`), CHANGELOG
<https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md>, <https://vite.dev/blog/announcing-vite8>,
<https://vite.dev/guide/migration>, <https://vite.dev/guide/api-environment>.

### B.1 Status
- **Vite 8.0.0 (2026-03-12)** = "the epic `rolldown-vite` merge" (#21189). Rolldown + Oxc replace esbuild + Rollup;
  `rolldown-vite` is frozen at 7.3.1. `vite@8.3.1` depends on `rolldown ~1.2.9`, `lightningcss`, `postcss`,
  `picomatch`, `tinyglobby`; **esbuild is only an optional peer** (for the deprecated `transformWithEsbuild`/
  `build.minify:'esbuild'`). Node `^20.19.0 || >=22.12.0`.
- Renames (auto-converted, deprecated aliases kept): `build.rollupOptions → build.rolldownOptions`,
  `worker.rollupOptions → worker.rolldownOptions`, `optimizeDeps.esbuildOptions → optimizeDeps.rolldownOptions`,
  `esbuild` → `oxc` (e.g. `oxc.jsx: { runtime:'automatic', importSource }`), Oxc minifier + Lightning CSS minify by
  default. Plugin-author items: add `moduleType: 'js'` when turning non-JS into JS in `load`/`transform`;
  removed `shouldTransformCachedModule`, `resolveImportMeta`, `renderDynamicImport`; `build()` throws `BundleError`
  (`.errors`); `parseAst` → `parse`/`parseSync`.
- **Native plugins**: "v2 native plugins enabled by default" (#21268); `experimental.enableNativePlugin` was removed
  (`'resolver'` value removed in #21510; the option no longer exists in 8.3.1 types). The resolver is now the Rust
  `vite:resolve-builtin` (`viteResolvePlugin` from `rolldown/experimental`), used in dev and build.
- 8.1.0 (2026-06-23): extended `server.fs.deny` defaults (`.env`, `.env.*`, `*.{crt,pem,key,p12,pfx,cer,der}`, `.npmrc`,
  `.yarnrc.yml`, `**/.git/**`), `server.hmr` → `server.ws`, chunk import map, WASM ESM integration, Vite Task,
  experimental **bundled dev ("full bundle mode")** `experimental.bundledDev` / per-env `isBundled`,
  `node_modules/.vite` as cacheDir when `node_modules` exists.
- 8.2.0 (2026-07-30): top-level **`input`** option (#22642); `server.fs.allow` automatically includes `input` (#23035).
- 8.3.0 (2026-09-10): top-level **`tsconfig`** option (#23310); `server.watch` accepts Rolldown watch options (#23133);
  `closeServer`/`closePreviewServer` hooks (#23110); assets via `import.meta.ROLLDOWN_FILE_URL_*`; deleted internal
  `esbuildPlugin` (#23381).

### B.2 Plugin API facts that matter for a resolver
- Plugin type = `Rolldown.Plugin` + Vite hooks. `resolveId(source, importer, { kind?, custom?, ssr?, isEntry })` with
  `filter.id: StringFilter<RegExp>`; `load(id, {ssr?})` with `filter.id`; `transform(code, id, { moduleType, ssr? })`
  with `filter.{id, code, moduleType}`. Vite also exports `withFilter`, `perEnvironmentPlugin`, `perEnvironmentState`,
  `createIdResolver(config, options)` (replacement for deprecated `config.createResolver`), `esmExternalRequirePlugin`,
  `parse/parseSync`, `minify`, `moduleRunnerTransform`, `rolldownVersion`, `defaultClientConditions`,
  `defaultServerConditions`, `defaultExternalConditions`.
- Internal `PluginContainer.resolveId` accepts `attributes?: Record<string,string>` and `skipCalls`, but plugin-facing
  types do not expose attributes (Rolldown doesn't pass them).
- `this.environment` in every per-environment hook (`environment.name`, `.config.consumer: 'client'|'server'`,
  `.config.resolve.conditions`, `.mode: 'dev'|'build'|'scan'…`). **Environment API is "Release Candidate"**
  (`docs/guide/api-environment.md`); `applyToEnvironment`, `sharedDuringBuild`, `perEnvironmentStartEndDuringDev`,
  `perEnvironmentWatchChangeDuringDev`, `resolve.external`/`resolve.noExternal` per environment are `@experimental`.
  `configEnvironment(name, config, env & { isSsrTargetWebworker })`, `hotUpdate` (per-env). `ssr.target: 'node'|'webworker'`
  still exists ("will be removed in a future major"). `createBuilder(inlineConfig, useLegacyBuilder?)` / `builder.buildApp`.
- `resolve` (per environment): `mainFields`, `conditions`, `externalConditions`, `extensions`
  (`['.mjs','.js','.mts','.ts','.jsx','.tsx','.json']`), `dedupe`, `noExternal`, `external`, **`builtins: (string|RegExp)[]`**;
  root-only `preserveSymlinks`, **`tsconfigPaths`** (no longer experimental). Default conditions (dist): client
  `['module','browser','development|production']`, server `['module','node','development|production']`, external
  `['node','module-sync']` — **no `deno` condition anywhere**.
- `optimizeDeps`: `include`, `exclude`, `entries`, `needsInterop`, `extensions`, `disabled`, `noDiscovery`,
  `holdUntilCrawlEnd`, `ignoreOutdatedRequests`, `force`, `rolldownOptions` (`esbuildOptions`/`rollupOptions` deprecated).
- `define`, `import.meta.hot` (client), `ModuleRunner` (`vite/module-runner`) unchanged in spirit; `hmrPartialAccept`,
  `importGlobRestoreExtension`, `renderBuiltUrl`, `bundledDev` under `experimental`.

### B.3 Behaviours that directly affect Deno specifiers (from `dist/node/chunks/node.js`)
1. **`https://` in dev**: `vite:import-analysis` does
   `if ((isExternalUrl(specifier) && !specifier.startsWith("file://") || isDataUrl(specifier)) && !matchAlias(specifier)) return;`
   with `isExternalUrl = /^([a-z]+:)?\/\//` → remote URL imports are **never resolved in dev** (browser fetches them;
   TS from deno.land would break). Work-arounds: add a `resolve.alias` entry matching `^https?://` (alias match re-enables
   resolution — verified in experiment 24) or rewrite specifiers in a `transform` (enforce `'pre'`). `jsr:`/`npm:` are *not* external URLs and do
   go through `resolveId`, but they also match `bareImportRE = /^(?![a-zA-Z]:)[\w@](?!.*:\/\/)/` → resolve them in an
   `enforce:'pre'` plugin before the optimizer/resolver sees them. In **build**, `vite:resolve-builtin` marks external
   URLs external unless an earlier `enforce:'pre'` plugin resolved them (verified in experiment 23).
2. **TS in dev is decided by id extension — and never for `\0` ids**: `vite:oxc` (dev path) transpiles when
   `filter(id) || filter(cleanUrl(id))` matches `oxc.include` (default `/\.(m?ts|[jt]sx)$/`, exclude `/\.js$/`) and then
   returns `moduleType:'js'`; the filter is Vite's `createFilter`, which **returns false for any id containing `\0`**
   (experiment 26: a `\0deno/…/mod.ts` id is served untranspiled). The
   `moduleType` returned by `load` is forwarded to `transform` hooks (`pluginContainer.transform(code,id,{moduleType})`)
   but does **not** trigger Oxc. In bundled envs (`isBundled`), Vite uses the native `viteTransformPlugin` with the same
   include/exclude, but Rolldown core itself honours `moduleType` (experiment 25 — build works). ⇒ In dev, **transpile in
   `load`** (Vite exports `transformWithOxc(code, filename, options, inMap, config, watcher)`; or `rolldown/utils`
   `transform`) and return `moduleType:'js'`, or use non-`\0` ids that end in a real extension. Note DENO_DIR remote-cache
   files (`remote/https/<host>/<sha256>`) have **no extension** either.
3. **Dep optimizer & SSR externals require `node_modules` in the path**: `inNodeModulesRE =
   /(?:^|[\\/])node_modules(?:[\\/]|$)/` gates `isExternalizable` (SSR) and optimizer handling (8.3.0 tightened it to
   whole path segments, #23437). Files in `$DENO_DIR/npm/registry.npmjs.org/<pkg>/<ver>/` are treated as source:
   no CJS→ESM pre-bundling in client dev, no SSR auto-external. With `nodeModulesDir: "auto"|"manual"` Deno's
   `node_modules/.deno/<pkg>@<ver>/node_modules/<pkg>` layout *is* recognised.
4. **`server.fs`**: `strict: true` by default; `isFileLoadingAllowed` = not in `fsDenyGlob` AND
   (`safeModulePaths.has(path)` OR inside `fs.allow`). Import analysis adds every resolved import target to
   `safeModulePaths`, so DENO_DIR files imported from allowed modules are served via `/@fs/…`; direct URL access to
   them 403s. Default `fs.allow` = `searchForWorkspaceRoot(root)`, which (dist) **recognises `deno.json`/`deno.jsonc`
   with a `workspace` field** (in addition to `workspaces` in package.json, `pnpm-workspace.yaml`, `lerna.json`), plus
   `input` (8.2). `isServerAccessDeniedForTransform` only applies to `?raw`/`?url`/`?inline`/svg ids; `\0` ids skip fs checks.
5. **Deno-specific code in Vite**: CLI prints runtime (`typeof Deno … runtimeName = "deno"`); config loading treats
   configs as ESM when `process.versions.deno` is set and avoids `node_modules/.vite-temp`; workspace-root search above.
   No `isDeno` resolution logic.
6. `server.watch` ignores: pass Rolldown watch options (8.3) — keep DENO_DIR out of the watcher; `ensureWatchedFile`
   only watches files under root.

### B.4 Vite docs guidance for Deno
`docs/guide/index.md`: `deno init --npm vite`, `deno add -D npm:vite`, `deno run -A npm:vite`; migration guide shows
`deno add -D npm:@rolldown/plugin-babel …`. Deno docs' tutorial (<https://docs.deno.com/examples/vite_tutorial/>) uses
`deno run -A npm:create-vite@latest`, `package.json` scripts via `deno task`, `deno install` → local `node_modules`
(no `@deno/vite-plugin` needed for npm-only apps). **Vitest 5.0.2**: peer `vite ^6.4 || ^7 || ^8`, Node
`^22.12 || ^24 || >=26`, has `isDeno` env detection and recognises `deno.lock`/`node_modules/.deno/` for PM detection.

---------------------------------------------------------------------------------------------------------------------

## C. Rolldown — 1.2.11 (GA since 1.0.0, 2026-05-07) and tsdown 0.23.0

Sources: `npm pack rolldown@1.2.11` (`dist/shared/define-config-*.d.mts`, `binding-*.d.mts`, `experimental-index.d.mts`,
`plugins-index.d.mts`, `utils-index.d.mts`, `filter-index.d.mts`), releases <https://github.com/rolldown/rolldown/releases>,
<https://rolldown.rs/apis/plugin-api/hook-filters>, <https://rolldown.rs/in-depth/module-types>.

### C.1 Versions / notable releases
1.0.0 2026-05-07 (after rc.1…rc.18 from 2026-01-22); **1.1.0** (06-03): `experimental.lazyBarrel` **on by default**
(#9632), tsconfig auto-discovery walks up and picks the tsconfig that *owns* the file (TS-like project references),
per-project `allowJs`; **1.2.0** (07-15): client-side HMR in dev engine, `import.meta['url']` rewriting, full reload on
tsconfig change, `FILE_NOT_FOUND` error. Weekly patch cadence (1.2.11 on 2026-09-24). Engines `^20.19.0 || >=22.12.0`;
deps `@oxc-project/types =0.151.0`, `@rolldown/pluginutils ^1.0.0`; 15 `@rolldown/binding-*` napi packages
(+ wasm fallback via `NAPI_RS_WASI_FLAVOR`/`@rolldown/binding-wasm32-wasi`).

### C.2 Plugin API vs Rollup
- `resolveId(source, importer, { custom?, isEntry, kind })`, `kind ∈ 'import-statement'|'dynamic-import'|'require-call'|'import-rule'|'url-token'|'new-url'|'hot-accept'`.
  **No `attributes`/`importerAttributes`** (Rollup has both).
- Results: `ResolveIdResult = string | false | null | { id, external?: boolean|'absolute'|'relative', moduleSideEffects?: boolean|'no-treeshake'|null, meta?, description?, invalidate?, packageJsonPath? }`.
- `load(id)` → `string | { code, map?, moduleType?, moduleSideEffects?, meta?, description? }`;
  `transform(code, id, { moduleType, magicString?, ast? })` → may return `code: string | RolldownMagicString`.
- **`ModuleType`** (hook results): `'js'|'jsx'|'ts'|'tsx'|'json'|'text'|'base64'|'dataurl'|'binary'|'empty'|(string&{})`;
  **`moduleTypes`** option (by extension): same + `'css'|'asset'|'copy'`. Hook-returned `moduleType` overrides the
  extension (experiment 3). `ModuleOptions.description` documents virtual modules.
- `moduleSideEffects` precedence: transform > load > resolveId > `treeshake.moduleSideEffects` > package.json `sideEffects` > true.
- **Hook filters** (Rust-side): `transform.filter: { id, code, moduleType }`, `load.filter: { id }`,
  `resolveId.filter: { id: RegExp|RegExp[]|{include,exclude} }` (strings rejected: "the id in resolveId is the raw
  import text"), `renderChunk.filter: { code }`; or `TopLevelFilterExpression[]` from `@rolldown/pluginutils`
  (`and, or, not, id, importerId, moduleType, code, query, include, exclude, queries`, plus `exactRegex`, `prefixRegex`,
  `makeIdFiltersToMatchWithQuery`). RegExps are tested after normalising separators to `/`; string ids are globs.
  Docs: filters supported by Rolldown (all), **Rollup ≥4.38.0, Vite ≥6.3.0; `moduleType` filter not in Rollup/Vite ≤7**.
  Perf rationale: avoid Rust↔JS crossings and allow parallelism.
- `withFilter(pluginOrArray, { transform?, resolveId?, load?, pluginNamePattern? })` (`rolldown/filter`, also re-exported by Vite).
- Plugin metadata: `name`, `version`, **`meta?: { packageName, version, description }`** (experimental), `api`.
- `PluginContext`: `resolve(source, importer, { kind, isEntry, skipSelf = true, custom })`, `load({ id, resolveDependencies })`,
  `emitFile` (asset / chunk / **prebuilt-chunk**), `addWatchFile`, `getModuleInfo`, `getModuleIds`, `parse` (Oxc ESTree),
  **`this.fs`** (`RolldownFsModule`), `meta: { rollupVersion (dummy), rolldownVersion, watchMode }`.
- Hook orders: `ObjectHook = fn | { handler, order?: 'pre'|'post'|null, filter? }` (`sequential` accepted but ignored).

### C.3 Input/output options relevant to Deno
- `platform: 'node'|'browser'|'neutral'` (**no `'deno'`**); `'neutral'` = ESM, empty `mainFields`, no platform conditions.
- `resolve: { alias (no resolveId re-entry — use `viteAliasPlugin`), aliasFields, conditionNames, extensionAlias,
  exportsFields, extensions (['.tsx','.ts','.jsx','.js','.json']), mainFields, mainFiles, modules, symlinks,
  tsconfigFilename (deprecated → top-level `tsconfig: boolean|string`) }` — **no `resolve.builtins`** (Vite has it).
- `external: string|RegExp|Array|((id, parentId, isResolved) => boolean|null)`, `makeAbsoluteExternalsRelative`.
- `transform: { define, inject, dropLabels, jsx: false|'react'|'react-jsx'|'preserve'|JsxOptions, typescript:{
  onlyRemoveTypeImports, allowNamespaces, allowDeclareFields, removeClassFieldsWithoutInitializer, optimizeConstEnums,
  optimizeEnums, rewriteImportExtensions:'rewrite'|'remove'|boolean }, decorator, assumptions, target, helpers, plugins }`;
  `JsxOptions = { runtime:'classic'|'automatic', importSource, pragma, pragmaFrag, development, pure, throwIfNamespace, refresh }`.
- `experimental: { viteMode (hidden), resolveNewUrlToAsset, devMode, chunkModulesOrder, attachDebugInfo:'none'|'simple'|'full',
  chunkImportMap, onDemandWrapping, incrementalBuild, nativeMagicString, chunkOptimization, lazyBarrel }`.
  (`strictExecutionOrder` is now **`output.strictExecutionOrder`**.)
- `output`: `codeSplitting` (replaces deprecated `advancedChunks`/`manualChunks`), `comments` (replaces deprecated
  `legalComments`), `hashCharacters:'base64'|'base36'|'hex'`, `keepNames`, `minify`, `polyfillRequire`, `cleanDir`,
  `topLevelVar`, `minifyInternalExports`, `preserveModules`, `virtualDirname`, `strictExecutionOrder`.
- `checks: ChecksOptions` (per-warning toggles), `onLog`, `watch: { …, onInvalidate }`, `treeshake.moduleSideEffects:
  boolean|string[]|rules|fn|'no-external'`, `devtools`, `optimization`.

### C.4 Built-in / native plugins
`rolldown/plugins`: `replacePlugin`, `esmExternalRequirePlugin`. `rolldown/experimental`: `dev` (DevEngine), `scan`,
`viteAliasPlugin`, `bundleAnalyzerPlugin`, `viteTransformPlugin`, `viteManifestPlugin`, `viteResolvePlugin`,
`viteJsonPlugin`, `viteImportGlobPlugin`, `viteDynamicImportVarsPlugin`, `viteBuildImportAnalysisPlugin`,
`viteLoadFallbackPlugin`, `viteModulePreloadPolyfillPlugin`, `viteReactRefreshWrapperPlugin`, `viteReporterPlugin`,
`viteWebWorkerPostPlugin`, `oxcRuntimePlugin`, `isolatedDeclarationPlugin`, `isolatedDeclaration(Sync)`,
`moduleRunnerTransform`, **`ResolverFactory`** (oxc-resolver), `resolveTsconfig`, `TsconfigCache`, `memfs`,
`defineParallelPlugin`, `freeExternalMemory`, native memory stats. `rolldown/utils`: `parse(Sync)`, `transform(Sync)`
(Oxc), `minify(Sync)`, `TsconfigCache`, visitor. (No `aliasPlugin`/`jsonPlugin`/`moduleFederationPlugin` names any
more — they are the `vite*` variants above.)

### C.5 Known gaps (issues)
- Import attributes: rolldown#2758 (support properly), #6410 (`import bytes`), #9088 (`import text`), #10407 (dedupe
  with different attributes); listed as a Vite 7→8 migration blocker in the 2026-Q3 plan (#10042).
- JS plugins without filters are the main perf cost (each hook = napi call); `defineParallelPlugin` (worker threads)
  exists for heavy JS plugins.

### C.6 tsdown 0.23.0
Rolldown-based library bundler; accepts Rolldown plugins (and unplugin `.rolldown`), `fromVite: boolean|'vitest'`
(reuse Vite plugins), `platform: 'node'|'neutral'|'browser'` ("node: Node.js and compatible runtimes (e.g., Deno, Bun)"),
`nodeProtocol: 'strip'|boolean`, `unbundle`, `exports` generation, `publint`, `attw`, `css`, `exe` (Node SEA ≥25.7,
"not supported in Bun or Deno"), experimental `workspace`. **No JSR/`deno.json` support** (no issues besides #707
"Cannot use tsdown with Deno" – fixed; tsdown 0.23.0 builds under Deno 2.9.7, experiment 21). DTS via
`rolldown-plugin-dts 0.28.x`: needs the TS ≤6 JS API or `isolatedDeclarations` (Oxc) — **TypeScript 7 not supported**.
Engines: Node `^22.18.0 || ^24.11.0 || >=26.0.0`.

---------------------------------------------------------------------------------------------------------------------

## D. Rollup — 4.63.5 (no Rollup 5 yet)

Sources: `npm pack rollup@4.63.5` (`dist/rollup.d.ts`), CHANGELOG, PR #5994.
- **Hook filters** since **4.38.0** (2025-03-29, #5882); AND semantics fixed in 4.40.0 (#5909); `resolveId.filter.id:
  StringFilter<RegExp>`, `load.filter.id`, `transform.filter.{id,code}` (no `moduleType`).
- `resolveId(source, importer, { attributes, custom?, importerAttributes?, isEntry })`; `load(id, { attributes? })`;
  `transform(code, id, { attributes? })`; `this.resolve(source, importer, { importerAttributes?, attributes?, custom?,
  isEntry?, skipSelf? })` (`skipSelf` defaults to true since Rollup 3). Returning `attributes` from `load`/`transform`
  is **deprecated since 4.57.0 (#5700)** and will be removed in Rollup 5. Inconsistent attributes for the same
  module → warning and first resolution reused (experiment 18).
- `output.importAttributesKey: 'with'|'assert'|…` (#5474). **`jsx` option since 4.24.0 (#5668)**:
  `false | 'react' | 'react-jsx' | 'preserve' | 'preserve-react' | { mode:'classic'|'automatic'|'preserve', factory, fragment, importSource, jsxImportSource, preset }`
  — parses/transforms JSX but **not TypeScript**. `experimentalLogSideEffects`. `treeshake.moduleSideEffects:
  boolean|'no-external'|string[]|(id, external)=>boolean`. `external: (string|RegExp)[] | string | RegExp |
  ((source, importer, isResolved) => boolean|null)`.
- **Rollup 5**: not published (dist-tags: latest 4.63.5, beta 4.55.1-0). Umbrella PR **#5994 "Rollup 5"** (open since
  2025-06-28, updated 2026-09-25): chokidar v4 (`watch.chokidar`, #5778), generated AST types (#5730); #6532 "[v5.0]
  Require Node.js 22.0.0".

---------------------------------------------------------------------------------------------------------------------

## E. esbuild — 0.28.2, and Bun 1.4

Sources: `npm pack esbuild@0.28.2` (`lib/main.d.ts`), CHANGELOG + CHANGELOG-2025.
- API (0.28.2): `Platform = 'browser'|'node'|'neutral'`; loaders `base64|binary|copy|css|dataurl|default|empty|file|js|json|jsx|local-css|text|ts|tsx`;
  `BuildOptions`: `packages: 'bundle'|'external'`, `alias`, `resolveExtensions`, `conditions`, `mainFields`,
  `external`, `metafile`, `absWorkingDir`, `absPaths` (0.25.7), `supported`, `mangleProps`, `jsx: 'transform'|'preserve'|'automatic'`,
  `jsxImportSource`, `jsxDev`, `jsxSideEffects`, `tsconfigRaw` (`compilerOptions.{jsx: 'preserve'|'react-native'|'react'|'react-jsx'|'react-jsxdev', jsxImportSource, jsxFactory, jsxFragmentFactory, verbatimModuleSyntax, experimentalDecorators, useDefineForClassFields, paths, baseUrl, target, strict, alwaysStrict, preserveValueImports, importsNotUsedAsValues}`).
- Plugin API: `onStart`, `onEnd(result)`, `onDispose`, `onResolve({filter: RegExp (Go RE2 subset), namespace?}, args)` with
  `args = { path, importer, namespace, resolveDir, kind, pluginData, with }`; result `{ path, external, sideEffects,
  namespace, suffix, pluginData, watchFiles, watchDirs, errors, warnings, pluginName }`; `onLoad` args `{ path, namespace,
  suffix, pluginData, with }` → `{ contents: string|Uint8Array, resolveDir, loader, pluginData, watchFiles, watchDirs }`;
  **`build.resolve(path, { pluginName, importer, namespace, resolveDir, kind, pluginData, with })`**; `build.esbuild`
  (full API copy); `context()` → `watch()`, `serve()`, `rebuild()`, `dispose()`.
- 0.28.0 (2026-04-02): `with { type: 'text' }` (#4435); integrity checks for binary fallback download (breaking).
  `type: 'bytes'` also works in 0.28.2 (experiment 8). 0.28.1: integrity checks for the Deno API install script.
  **Unreleased: "Stop publishing to https://deno.land/x/esbuild — Deno has made deno.land/x read-only… last published
  v0.28.1… use `npm:esbuild`"**; `es2026` tsconfig target; error when code-splitting chunks would be merged.
- esbuild on Deno: `npm:esbuild` works (spawns the `@esbuild/<platform>` binary; experiment 7); `esbuild-wasm` 0.28.2
  also on npm. **`deno bundle` / `Deno.bundle()` use esbuild 0.25.5** downloaded as `@esbuild/<target>` from the npm
  registry and driven from Rust via the `esbuild_client` crate with a catch-all Rust on-resolve/on-load plugin
  (`cli/tools/bundle/esbuild.rs`: `ESBUILD_VERSION = "0.25.5"`), not a fork.
- **Bun 1.4 (1.4.0 2026-08-20; 1.4.2)**: `Bun.build({ plugins, target: 'bun'|'node'|'browser', packages, conditions,
  files (in-memory map), metafile, … })`; `BunPlugin.setup(builder)` with `onStart`, `onEnd`, `onBeforeParse` (native
  napi), `onLoad({filter, namespace})` (args `path, namespace, loader, defer()`), `onResolve({filter, namespace})` (args
  `path, importer, namespace, resolveDir, kind` — **no `with`/`pluginData`**), `module(specifier, cb)` virtual modules;
  loaders `js|jsx|ts|tsx|json|jsonc|toml|yaml|xml|file|napi|wasm|text|css|html`. No native `jsr:` specifiers found in
  1.4 notes/types (JSR via `npm.jsr.io` `@jsr/*`). unplugin supports Bun ≥1.2.22.

---------------------------------------------------------------------------------------------------------------------

## F. Rspack 2.2.7 / Rsbuild 2.2.9 (+ Rslib, Rspress)

Sources: `npm pack @rspack/core@2.2.7`, `@rspack/binding@2.2.7`, `@rsbuild/core@2.2.9`; <https://rspack.rs/blog/announcing-2-0>,
<https://rspack.rs/guide/migration/rspack_1.x>.

### F.1 Rspack 2 (2.0.0 2026-04-22)
- **Breaking**: pure-ESM packages; Node 20.19+/22.12+; `experiments.css` removed (add rules `type: 'css/auto'`);
  `lazyCompilation`, `incremental` (`'none'|'safe'|'advance'|'advance-silent'|{…}`), `cache` moved **top-level**;
  removed `experiments.{layers, topLevelAwait, lazyBarrel, parallelLoader, outputModule (use output.module),
  rspackFuture, typeReexportsPresence, inlineConst, inlineEnum}`; `asyncWebAssembly` default true; `builtin:swc-loader`
  no longer reads `.swcrc`, gains `detectSyntax: 'auto'`, `transformImport`, `collectTypeScriptInfo`; built-in loaders
  read top-level `target`; `resolve.extensions` default drops `.wasm`; `resolve.roots` default `[]`;
  **`NormalModule.getCompilationHooks().readResourceForScheme` removed**; `module.unsafeCache` removed; devtool defaults changed.
- Remaining `experiments` (2.2.7): `asyncWebAssembly`, `css` (deprecated), `futureDefaults`, `newCache`, **`buildHttp:
  { allowedUris, lockfileLocation, cacheLocation, upgrade, frozen, httpClient(url, headers) => Promise<{status, headers, body: Buffer}> }`**,
  `useInputFileSystem: false|RegExp[]`, `nativeWatcher`, `deferImport`, `sourceImport`, `pureFunctions`, `runtimeMode`.
- `rspack.experiments` runtime exports: `VirtualModulesPlugin` (native), `resolver: { ResolverFactory, EnforceExtension,
  async, sync }` (rspack_resolver JS binding), `swc: { transform, transformSync, minify, minifySync }`,
  `createNativePlugin`, `RsdoctorPlugin`, `RstestPlugin`, `RslibPlugin`, `rsc`, `CssChunkingPlugin`, `globalTrace`.
- **`target`** values: `web`, `webworker`, `es3…es2025`, `node[X.Y]`, `async-node[X.Y]`, `electron*`, `nwjs*`,
  `browserslist[:…]` — **no `deno`/`bun`** (webpack has them). `externalsPresets`: `node, web, webAsync, electron*, nwjs`
  (`web`/`webAsync` externalise `http(s)://` and `std:`).
- **Resolution hooks** (`NormalModuleFactory.hooks`): `resolveForScheme: HookMap<AsyncSeriesBailHook<[ResourceDataWithData], true|void>>`,
  `beforeResolve`, `factorize`, `resolve`, `afterResolve`, `createModule` — **no `resolveInScheme`**. `ResolveData`
  (`JsResolveData`): `request, context, contextInfo{issuer,…}, attributes? (read-only import attributes), fileDependencies,
  contextDependencies, missingDependencies, createData?`. `NormalModule.getCompilationHooks(c)`: `loader`, `readResource`
  (**typed, not wired — rspack#12210**, experiment 11).
- `resolve` options: `alias, conditionNames, extensions, fallback, mainFields, mainFiles, modules, preferRelative,
  preferAbsolute, symlinks, enforceExtension, importsFields, descriptionFiles, tsConfig, fullySpecified, exportsFields,
  extensionAlias, aliasFields, restrictions, roots, byDependency, pnp` — **no `resolve.plugins`** (enhanced-resolve JS
  plugins are not supported; use NMF hooks).
- `module.rules[]` conditions: `test, include, exclude, issuer, issuerLayer, dependency, phase, resource,
  resourceFragment, resourceQuery, mimetype, **scheme**, descriptionData, **with** (import attributes), layer`; loader
  items support `parallel` and `cache`. Import attributes `text`/`bytes` work out of the box (experiment 17).
- Externals function data: `{ context, dependencyType, request, contextInfo{issuer, issuerLayer}, getResolve(options) }`.
- Rspack & Deno: runs under Deno 2.9.7 (experiments 9, 12, 14).

### F.2 Rsbuild 2.2.9 plugin API
`RsbuildPluginAPI`: `context`, `expose/useExposed`, `getRsbuildConfig`, `getNormalizedConfig`, `logger`,
`isPluginExists`, `modifyBundlerChain`, `modifyEnvironmentConfig`, `modifyHTML`, `modifyHTMLTags`,
`modifyRspackConfig`, `modifyRsbuildConfig`, `onAfterBuild`, `onAfterCreateCompiler`, `onAfterDevCompile`,
`onAfterEnvironmentCompile`, `onAfterStartDevServer`, `onAfterStartPreviewServer`, `onBeforeBuild`,
`onBeforeDevCompile`, `onBeforeCreateCompiler`, `onBeforeEnvironmentCompile`, `onBeforeStartDevServer`,
`onBeforeStartPreviewServer`, `onCloseBuild`, `onCloseDevServer`, `onDevCompileDone`, `onExit`, `onRestart`,
**`processAssets(descriptor, handler)`**, **`resolve(handler({ resolveData, environment, compiler, compilation }))`**
(NMF resolve with per-environment context), **`transform(descriptor, handler)`** (descriptor: `test, resourceQuery,
targets, environments, raw, layer, issuerLayer, issuer, with, mimetype, enforce, order`; handler context `{ code,
context, resource, resourcePath, resourceQuery, environment, addDependency, emitFile, importModule, resolve }`).
Rslib 1.0.0 (2026-09-03; 1.0.2) = Rsbuild-based library builder (Rsbuild plugins apply). Rspress 2.0.x = docs SSG on
Rsbuild — only relevant as an Rsbuild consumer.

---------------------------------------------------------------------------------------------------------------------

## G. webpack — 5.111.1 (no webpack 6 in sight)

Sources: `npm pack webpack@5.111.1` (`types.d.ts`, `lib/`), GitHub releases v5.108.0–v5.111.1.

### G.1 `target: 'deno'` — added in **5.108.0 (2026-06-25), PR #21247** (with `bun` target #21248)
- Syntax `deno[X[.Y]]` (e.g. `deno`, `deno2`, `deno1.40`): "Emits ESM output; node.js built-ins are available via the
  required 'node:' specifier and web APIs (fetch, WebAssembly, …) are available too."
- Target properties: `node:true, deno:true, web:true, browser:false, webworker:false, require:false, nodeBuiltins:true,
  nodePrefixForCoreModules:true, nodeBuiltinModuleGetter: ≥2.1, importMetaDirnameAndFilename: ≥1.40, global:false,
  document:false, fetchWasm:true, importScripts:false, dynamicImport*, module:true, …`.
- **`DenoTargetPlugin`** (`lib/deno/DenoTargetPlugin.js`) = `ExternalsPlugin` that externalises `node:*`,
  `/^(?:npm|jsr|https?):/` requests verbatim and bare core modules as `node:<name>` (`module-import`, or `node-commonjs`
  for CJS dependencies). Runs in `factorize` → before resolution.
- Resolved defaults observed (experiment 10, `mode:'development'`): `externalsPresets = { web:true, deno:true, node:false, … }`,
  `resolve.conditionNames = ['webpack','development','deno','node','browser']`, `resolve.byDependency.esm.conditionNames
  = ['typescript','import','module-sync','module','...']`, `output.module = true`, `chunkFormat:'module'`,
  `chunkLoading:'import'`, `wasmLoading:'fetch'`, `workerChunkLoading:'import'`, `output.environment` all-modern
  (`nodePrefixForCoreModules:true`, `document:false`, `deferImport:false`, `sourceImport:false`),
  `module.parser.javascript.importMeta = 'preserve-unknown'`, `node = { global:true, __filename:'eval-only', __dirname:'eval-only' }`,
  `compiler.platform.deno` available (5.108 also added `universal`).
### G.2 Other 2026 additions
- 5.107.0 `experiments.typescript` (built-in TS via `module.stripTypeScriptTypes(input, {mode:'strip'})`: erasable
  syntax only, **no `.tsx`**, needs Node ≥22.6 — and **works under Deno 2.9** because Deno implements
  `stripTypeScriptTypes`, experiment 13); **5.109.0 defaults it to `"auto"`** (on when no `.ts/.mts/.cts` rule exists),
  and `experiments.css/html/asyncWebAssembly: "auto"`, `import.meta.glob`, `import.meta.env` defaults,
  `importMeta.resolve`, fine-grained `import.meta` parser options (`importMetaContext` deprecated →
  `importMeta.webpackContext`), `output.html`, `output.resourceHints`, `cache.compression:'zstd'`, `?raw/?url/?inline`
  under `futureDefaults`.
- 5.110.0: `externalsPresets.nodeModules` (+ `allowlist`), externals `sideEffects` flag, `glob` rule condition,
  `descriptionRelativePath` rule condition, `nmf.hooks.prepareModuleType` (HookMap).
- **5.111.0 (2026-09-14)**: **`experiments.outputModule` removed — set `output.module`** (#22011); `output.module` on by
  default with `futureDefaults` on ESM targets (#22088); `output.copy`; file URLs accepted wherever absolute paths are;
  async `processResult` hook.
### G.3 Resolver/scheme APIs (5.111.1 types)
- `NormalModuleFactory.hooks`: `resolve`, `resolveForScheme: HookMap<AsyncSeriesBailHook<[ResourceDataWithData, ResolveData], true|void>>`,
  **`resolveInScheme`** (since 5.49; relative requests inside a scheme context), `factorize`, `beforeResolve`,
  `afterResolve`, `createModule`, `module`, `prepareModuleType`, `createParser/createGenerator` maps.
- `ResolveData`: `contextInfo, resolveOptions?, context, request, phase?: 'defer'|'source'|'evaluation',
  **attributes?: ImportAttributes**, dependencies, dependencyType, createData, file/missing/contextDependencies, cacheable`.
- `NormalModule.getCompilationHooks(c)`: **`readResource: HookMap<AsyncSeriesBailHook<[LoaderContext], string|Buffer|null>>`**
  (5.58+; `readResourceForScheme` deprecated), `loader`, `beforeLoaders`, `beforeParse`, `beforeSnapshot`, `processResult`
  (async since 5.111). ⇒ full native non-file module support (experiment 13).
- `experiments.buildHttp: { allowedUris: (string|RegExp|fn)[], cacheLocation?: string|false, frozen?, lockfileLocation?,
  proxy?, upgrade? }` (HttpUriPlugin; own lockfile `webpack.lock`, no custom client — unlike Rspack's `httpClient`).
- Module types include `asset/source`, `asset/bytes`; `with {type:'text'|'bytes'}` handled natively (experiment 17 —
  dev runtime bug for bytes under `target:'deno'` observed).
- **webpack 6**: no branch, milestone or roadmap issue found; major features keep landing in 5.x minors with
  `experiments.futureDefaults` as the preview of next-major defaults.

---------------------------------------------------------------------------------------------------------------------

## H. Farm — @farmfe/core 1.7.11 (low momentum)
Latest stable 1.7.11 (2025-08-04); `2.0.0-beta.11` (2026-05-28) with v2 plugin betas; main-branch last commit
2026-06-14 (repo pushed 2026-09-22); 5.6k stars, 211 open issues. `JsPlugin`: `resolve { filters: { importers: string[], sources: string[] } (Rust regex strings), executor(params, ctx) }`,
`load { filters: { resolvedPaths } }` → `{ content, moduleType }`, `transform { filters: { resolvedPaths?, moduleTypes? } }`,
`processModule`, `renderResourcePot`, `augmentResourceHash`, `finalizeResources`, `transformHtml`, `writeResources`,
`updateModules`, plugin cache hooks; `priority` ordering; also runs Vite plugins. Deno relevance: none specific;
support via unplugin only (with the importer/`filters` quirks in §A.6). Recommend "best effort".

---------------------------------------------------------------------------------------------------------------------

## I. Deno 2.5 → 2.9.7 platform features

Sources: release posts <https://deno.com/blog/v2.5> … <https://deno.com/blog/v2.9> *(blog)*, `deno --help`/`deno <cmd> --help`
(2.9.7), config schema `cli/schemas/config-file.v1.json@v2.9.7`, `deno types`, Deno source (`libs/resolver/factory.rs`,
`cli/tools/bundle/*`), docs <https://docs.deno.com/runtime/fundamentals/node/>, <https://docs.deno.com/runtime/reference/cli/bundle/>,
<https://docs.deno.com/deploy/reference/builds/>, <https://jsr.io/docs/npm-compatibility>, local experiments.

### I.1 Release timeline & highlights
| Version | Date | Highlights relevant to us |
|---|---|---|
| **2.5** | 2025-09-10 | `permissions` sets in deno.json (`-P`, `--permission-set`), `compilerOptions.rootDirs`, `moduleResolution: "bundler"`, **`deno bundle` HTML entrypoints**, **`Deno.bundle()` runtime API (`--unstable-bundle`)**, test hooks, `DENO_AUDIT_PERMISSIONS`, `--unstable-node-globals` / `DENO_COMPAT=1`, lint rules `no-unversioned-import`/`no-import-prefix`, V8 14.0, TS 5.9.2 |
| **2.6** | 2025-12-10 | **`dx` / `deno x`** (npx-like), **`deno approve-scripts`** (writes `allowScripts`), `minimumDependencyAge` + `--minimum-dependency-age`, `--lockfile-only`, **`deno audit`** (`--socket`), `--ignore-read`/`--ignore-env`, `"publish": false`, experimental **tsgo** (`--unstable-tsgo`, `DENO_UNSTABLE_TSGO=1`), tsconfig `paths`/`isolatedDeclarations`, **source-phase WASM imports** (`import source mod from "./x.wasm"`), `--require` (CJS preload), `deno bundle --platform browser` avoids `createRequire`, `cloudflare:`/`bun:` external by default, `@types/node` bundled, V8 14.2 |
| **2.7** | 2026-02-25 | `package.json` `overrides`, **`jsr:` in package.json deps**, `deno create`, `deno install --compile`, `deno add --save-exact`, `deno audit --ignore`, `deno check --check-js`, Temporal stable, Windows ARM builds, big `node:worker_threads`/`child_process`/`zlib`/`sqlite` compat work, V8 14.5 |
| **2.8** | 2026-05-22 | **`deno pack`** (npm tarball: transpiled JS + `.d.ts`, rewrites `jsr:@std/path` → `@jsr/std__path`), **`deno transpile`** (`--outdir`, `--source-map`, `--declaration`), `deno why`, `deno ci`, `deno bump-version`, `deno audit fix`, `catalog`/`catalogs`, `nodeModulesDir:"manual"` + **node_modules linker `isolated` (default) / `hoisted`**, `deno add` defaults to npm, `--os/--arch/--prod/--package-json`, `.npmrc` `min-release-age`, `certfile/keyfile`, `NPM_CONFIG_REGISTRY` honoured, **`import defer`**, **`with {type:"text"}` stable (bytes still unstable)**, **`module.registerHooks()`**, `lib.node` types by default, Node test pass-rate 76.4%, `setTimeout` returns `Timeout`, **TypeScript 6.0.3**, V8 14.9 |
| **2.9** | 2026-06-25 (…2.9.7 2026-09-17) | `preferPackageJson`, **`jsrDepsInNodeModules`**, **`links` stable** (+ `deno link`/`deno unlink`), `deno list`, `deno watch`, `deno desktop` (experimental), `deno compile --bundle/--minify/--include-as-is/--all-targets/--compress`, **`deno bundle --declaration`** (rolled-up `.d.ts`), `--platform browser` honours package.json `browser` field, CSS module imports `with {type:"css"}` (`--unstable-raw-imports`), **bare builtins (`import "fs"`) resolve to `node:` unconditionally**, `process.version` v26.x, **NAPI 10**, `.npmrc` `trust-policy`, `min-release-age` default 24 h *(blog)*, lockfile seeding from npm/pnpm/yarn/bun lockfiles, `node` shim (`DENO_DISABLE_NODE_SHIM=1`), cold start 1.98× faster |

### I.2 `deno.json` (schema @ v2.9.7)
Top-level keys: `allowScripts, bench, catalog, catalogs, compile, compilerOptions, coverage, deploy, desktop, exclude,
exports, fmt, importMap, imports, jsrDepsInNodeModules, license, links, lint, lock, minimumDependencyAge, name,
nodeModulesDir, patch, permissions, preferPackageJson, publish, scopes, tasks, test, unstable, vendor, version, workspace`.
- `imports` (import map), `scopes`, `importMap` (external file), `workspace: string[] | { members }`.
- **`links: string[]`** (paths/file URLs/globs to local JSR packages; `patch` is the deprecated pre-2.3.6 name).
- **`nodeModulesDir: "auto" | "manual" | "none"`** (schema default `"none"`; booleans still accepted). Docs: with a
  `package.json` present the default becomes manual (BYONM); linker selectable via `--node-modules-linker isolated|hoisted`
  (docs also show `"nodeModulesLinker": "hoisted"` in deno.json — not present in the 2.9.7 JSON schema).
- `lock: boolean | string | { path, frozen }`; `vendor: boolean`; `minimumDependencyAge: <age> | { age, exclude[] }`;
  `jsrDepsInNodeModules: boolean` (installs `jsr:` deps as `@jsr/<scope>__<name>` from npm.jsr.io and writes
  `@jsr:registry` to `.npmrc`); `preferPackageJson: boolean`.
- `unstable` examples: `bare-node-builtins, bundle, byonm, cron, detect-cjs, ffi, fs, fmt-component, fmt-sql, http, kv,
  net, node-globals, raw-imports, sloppy-imports, unsafe-proto, webgpu, worker-options`.
- `compilerOptions` keys: `allowJs, allowUnreachableCode, allowUnusedLabels, baseUrl, checkJs, emitDecoratorMetadata,
  **erasableSyntaxOnly**, exactOptionalPropertyTypes, experimentalDecorators, isolatedDeclarations, **jsx**
  (`preserve|react|react-jsx|react-jsxdev|react-native|precompile`, default `react`), jsxFactory, jsxFragmentFactory,
  **jsxImportSource** (default `react`), **jsxImportSourceTypes** (default `@types/react`), **jsxPrecompileSkipElements**,
  lib, module (`esnext|nodenext|preserve`), moduleResolution (`nodenext|bundler`), noErrorTruncation,
  noFallthroughCasesInSwitch, noImplicitAny, noImplicitOverride, noImplicitReturns, noImplicitThis,
  noPropertyAccessFromIndexSignature, **noUncheckedIndexedAccess**, noUnusedLocals, noUnusedParameters, paths,
  **rootDirs**, skipLibCheck, strict*, **types**, useUnknownInCatchVariables, **verbatimModuleSyntax**`.
- `deploy: { install, build, predeploy, runtime, framework }` (Deno Deploy builder).

### I.3 `deno.lock` v5 (observed)
```json
{ "version": "5",
  "specifiers": { "jsr:@std/assert@1": "1.0.19", "npm:rolldown@^1.2.11": "1.2.11" },
  "jsr":  { "@std/assert@1.0.19": { "integrity": "<sha256 hex>", "dependencies": ["jsr:@std/internal"] } },
  "npm":  { "vite@8.3.1_esbuild@0.28.2": { "integrity": "sha512-…", "dependencies": ["esbuild","lightningcss",…],
            "optionalDependencies": ["fsevents"], "optionalPeers": ["esbuild"], "bin": true },
            "@rolldown/binding-darwin-arm64@1.2.11": { "integrity": "…", "os": ["darwin"], "cpu": ["arm64"] } },
  "remote": { "https://deno.land/std@0.224.0/assert/assert.ts": "<sha256 hex>" },
  "redirects": { … },
  "workspace": { "dependencies": ["jsr:@std/assert@1", "npm:rolldown@^1.2.11"], "packageJson": { … } } }
```
npm keys carry peer suffixes (`name@ver_peer@ver`); npm entry fields seen: `integrity, dependencies, optionalDependencies,
optionalPeers, os, cpu, bin, scripts`. A lockfile is only auto-created when a config file exists.

### I.4 DENO_DIR layout (observed, 2.9.7) and `deno info --json`
`deno info` → `DENO_DIR` (macOS default `~/Library/Caches/deno`), `remote/` (`remote/https/<host>/<sha256>` — body
followed by a trailing `// denoCacheMetadata={"headers":…,"url":…,"time":…}` comment), `npm/` (`npm/<registry-host>/<name>/<version>/`
unpacked + `registry.json` packument; JSR npm-compat under `npm/npm.jsr.io/@jsr/…`), `gen/` (emit cache), `registries/`
(LSP), `location_data/`, `dl/` (upgrade cache), SQLite caches `dep_analysis_cache_v2`, `node_analysis_cache_v2`,
`check_cache_v2`, `fast_check_cache_v2`, `*_incremental_cache_v2`.
`deno info --json <entry>` (`"version": 1`): `roots`, `redirects` (e.g. `"jsr:@std/assert@1" → "https://jsr.io/@std/assert/1.0.19/mod.ts"`,
`"npm:chalk@5" → "npm:/chalk@5.6.2"`), `packages` (JSR req → `@std/assert@1.0.19`), `npmPackages`
(`{ name, version, dependencies, registryUrl, localPath }` — **`localPath` points into DENO_DIR**), `modules[]`
(`kind: esm|asserted|npm|external|…`, `specifier`, `local`, `size`, `mediaType` e.g. `TypeScript`/`Json`, `emit`,
`dependencies[{ specifier, code:{specifier, span}, type?, isDynamic?, assertionType?, npmPackage? }]`, `error?`).

### I.5 Environment variables (2.9.7 `deno --help` + source)
`DENO_DIR`, `DENO_AUTH_TOKENS` (`token@host;…`), `DENO_CERT`, `DENO_TLS_CA_STORE` (`system,mozilla`), `NODE_EXTRA_CA_CERTS`
(honoured since 2.8), `DENO_NO_PACKAGE_JSON`, `DENO_NO_UPDATE_CHECK`, `DENO_NO_PROMPT`, **`DENO_CONDITIONS`** (= `--conditions`),
**`DENO_COMPAT`** (Node compat mode), `DENO_EMIT_CACHE_MODE`, **`DENO_TSC_BIN`** (prebuilt tsc/tsgo for `deno check`),
`DENO_UNSTABLE_TSGO`, `DENO_V8_FLAGS`, `DENO_JOBS`, `DENO_COVERAGE_DIR`, `DENO_INSTALL_ROOT`, `DENO_TRACE_PERMISSIONS`,
`DENO_AUDIT_PERMISSIONS`, `DENO_SERVE_ADDRESS`, `DENO_AUTO_SERVE`, `DENO_DISABLE_NODE_SHIM`, `HTTP(S)_PROXY`/`NO_PROXY`,
**`NPM_CONFIG_REGISTRY`** (+ `.npmrc`), **`JSR_URL`** (registry override, `libs/resolver/factory.rs#resolve_jsr_url`).
There is **no `DENO_NPM_REGISTRY` and no `DENO_JSR_URL`**.

### I.6 Module features
- Import attributes: `type: "json"` stable; **`type: "text"` stable since 2.8**; **`type: "bytes"` still requires
  `--unstable-raw-imports`** (verified 2.9.7); `type: "css"` (2.9) behind the same flag. WASM: direct `.wasm` imports
  (since 2.1) and **source-phase imports** (2.6); `import defer` (2.8).
- Remote imports: `--allow-import` default allow-list = `deno.land:443, jsr.io:443, esm.sh:443, raw.esm.sh:443,
  cdn.jsdelivr.net:443, raw.githubusercontent.com:443, gist.githubusercontent.com:443`; `--deny-import`.
  Note: **deno.land/x is read-only** (esbuild changelog) — new code arrives via JSR/npm.
- npm resolution conditions (docs): ESM `["deno", "node", "import", "module-sync", "default"]`, `require()`
  `["require", "node", "module-sync", "default"]`, extendable via `--conditions` / `DENO_CONDITIONS`.
- CommonJS: `.cjs`, `"type":"commonjs"`, or `--unstable-detect-cjs`; `require(esm)` works (tested).
- Bare Node builtins (`"fs"`) resolve to `node:fs` unconditionally since 2.9 (deno.json/package.json mappings still win).
- JSR npm layer: `https://npm.jsr.io`, `@jsr/<scope>__<name>`, transpiled JS + `.d.ts`; pnpm ≥10.9, Yarn ≥4.9, vlt
  support `jsr:` natively; npm/Bun need `.npmrc` `@jsr:registry=https://npm.jsr.io`.

### I.7 CLI for dependency management (2.9.7 help)
`deno add` (npm default, `--save-exact`, `--package-json`), `deno remove`, `deno install` (`--entrypoint`, `--allow-scripts`,
`--os/--arch`, `--prod`, `--lockfile-only`, `-g`), `deno ci` (frozen), `deno outdated` / `deno update`, `deno audit [fix]`,
`deno why`, `deno list`, `deno link`/`unlink`, `deno approve-scripts`, `deno x`, `deno pack`, `deno transpile`,
`deno bundle`, `deno desktop`, `deno sandbox`, `deno deploy`. Common flags: `--node-modules-dir[=auto|manual|none]`,
`--node-modules-linker isolated|hoisted`, `--vendor`, `--frozen-lockfile`, `--min-dep-age` (unstable), `--conditions`,
`--preload`, `--require`, `--hmr`.

### I.8 `deno bundle` / `Deno.bundle()`
- Built on **esbuild 0.25.5** (downloaded `@esbuild/<target>` from the npm registry; Rust `esbuild_client` + Deno's
  resolver as a catch-all plugin). Docs: "not currently intended as a replacement for complex or interactive build
  tools such as Vite or webpack"; experimental.
- Flags (2.9.7): `-o/--output`, `--outdir`, `--format`, `--packages bundle|external`, `--platform browser|deno`,
  `--sourcemap[=linked|inline|external]`, `--external`, `--watch`, `--minify`, `--keep-names`, `--code-splitting`,
  `--inline-imports`, **`--declaration`**, `--check`, plus the usual resolution/lock flags.
- `Deno.bundle(options)` (**unstable**, `--unstable-bundle`): `{ entrypoints, outputPath?, outputDir?, external?,
  format?: 'esm'|'cjs'|'iife', minify?, keepNames?, codeSplitting?, inlineImports?, packages?, sourcemap?,
  platform?: 'browser'|'deno', write? }` → `{ errors, warnings, success, outputFiles?: { path, contents, hash, text() }[] }`.
  **No plugin API.**

### I.9 Node compatibility for running bundlers under Deno (tested 2.9.7)
- `process.versions`: `node 26.5.1`, `deno 2.9.7`, `napi 10`, `v8 15.0.245.2-rusty`.
- `node:module`: `registerHooks` ✅ (sync resolve/load hooks — virtual module via `data:` URL worked), **`register`
  ✗ (undefined)**, `stripTypeScriptTypes` ✅, `findPackageJSON` ✅, `isBuiltin` ✅, `syncBuiltinESMExports` ✅,
  `enableCompileCache` ✗; `builtinModules.length` 68. `worker_threads` present.
- napi addons load from the **global cache** without `node_modules` (Rolldown, Rspack, Rollup bindings) — needs
  `--allow-ffi` (Rolldown also `--allow-env`, `--allow-read`).
- **Deno Deploy builds**: builder has `deno` plus `node`/`npm`/`npx`/`yarn`/`pnpm` **shims that run through Deno**; 2 vCPU,
  3 GB RAM (4 GB Pro), 8 GB disk, 5-min timeout (15 Pro); `DENO_DIR` cached; `deploy.install/build/predeploy/runtime/framework`
  in deno.json ⇒ any bundler plugin must work when the bundler itself runs on Deno.

### I.10 `@deno/*` building blocks (versions only; deep-dives are covered elsewhere)
`jsr:@deno/loader` 0.5.0 (WASM Deno resolver/loader: workspace + deno.json + lockfile aware, emits transpiled code),
`jsr:@deno/esbuild-plugin` 1.2.1, `jsr:@deno/rolldown-plugin` 0.0.10, `npm:@deno/vite-plugin` 2.0.4,
`jsr:@luca/esbuild-deno-loader` 0.11.1.

---------------------------------------------------------------------------------------------------------------------

## J. TypeScript and JSX transforms

- **TypeScript 7.0 (2026-07-08)** = native Go compiler published as `typescript@7` (`tsc` binary; per-platform
  `@typescript/typescript-<os>-<arch>` deps; no `tsserver` — LSP). **No programmatic JS API in 7.0 ("expected in 7.1")**;
  `@typescript/typescript6` provides `tsc6` side-by-side. Removed: `target: es5`, `downlevelIteration`,
  `moduleResolution: node/node10/classic`, `module: amd/umd/systemjs/none`, `baseUrl`; `esModuleInterop`/
  `allowSyntheticDefaultImports` can't be false; `--checkers`, `--builders`, `--singleThreaded`.
  Consequence: tools needing the TS API (rolldown-plugin-dts/tsdown `--dts`, ts-loader, Vue/Svelte tooling) must
  pin TS ≤6 or use Oxc `isolatedDeclarations`.
- **TypeScript 6.0 (2026-03-23; 6.0.3 04-16)** = bridge release: defaults `strict: true`, `module: esnext`,
  `target: es2025`, `types: []`, `rootDir: .`, `noUncheckedSideEffectImports: true`, `libReplacement: false`; deprecations
  above; `--stableTypeOrdering`, `#/` subpath imports, Temporal types, `asserts` import syntax deprecated in favour of `with`.
  Earlier: `erasableSyntaxOnly` (5.8), `rewriteRelativeImportExtensions` (5.7), `verbatimModuleSyntax` (5.0),
  `allowImportingTsExtensions` (5.0, type-check only), TC39 decorators (5.0; `experimentalDecorators` legacy).
- **Deno 2.9.7 ships TypeScript 6.0.3** (`deno --version`); tsgo is opt-in (`--unstable-tsgo`/`DENO_UNSTABLE_TSGO`,
  `DENO_TSC_BIN`).
- Deno-flavoured TS/JSX in each transformer:
  | Feature | Oxc (Vite 8 / Rolldown) | SWC (Rspack `builtin:swc-loader`) | esbuild | webpack `experiments.typescript` | Deno (`deno_ast`) |
  |---|---|---|---|---|---|
  | `.ts` extension imports | ✅ (resolution); `typescript.rewriteImportExtensions` for emit | ✅ | ✅ | ✅ | ✅ |
  | enums/namespaces/param-props | ✅ | ✅ | ✅ | ❌ strip-only mode | ✅ |
  | `jsx: react-jsx` + `jsxImportSource` | ✅ `runtime:'automatic', importSource` | ✅ `runtime:'automatic', importSource` | ✅ `jsx:'automatic', jsxImportSource` | ❌ no TSX | ✅ |
  | `jsx: precompile` (+ `jsxPrecompileSkipElements`) | ❌ | ❌ (`automatic\|classic\|preserve`) | ❌ (`transform\|preserve\|automatic`) | ❌ | ✅ |
  | `jsxImportSourceTypes` | n/a (types) | n/a | n/a | n/a | ✅ (type-check only) |
  | per-file `@jsxImportSource` pragma | ✅ | ✅ | ✅ | — | ✅ |
  Alternatives for `precompile`: `deno transpile` (2.8+, experimental; honours deno.json — experiment 20), the
  `jsr:@deno/loader` WASM loader (deno_ast emit), `deno bundle`/`Deno.bundle()`, or keep `jsx:"react-jsx"` for bundled
  targets (Fresh-style precompile is a server-rendering optimisation; `jsxTemplate`/`jsxEscape` runtimes exist only in
  Preact/Hono-style jsx-runtimes).

---------------------------------------------------------------------------------------------------------------------

## K. Capability matrix (what a Deno resolver plugin needs × host)

Legend: ✅ native/works · ⚠️ works with caveats/workaround · ❌ not available · (T) = verified by experiment in §1.

| Capability | Vite 8.3 | Rolldown 1.2 | Rollup 4.63 | esbuild 0.28 | Rspack 2.2 | webpack 5.111 | Farm 1.7 | Bun 1.4 |
|---|---|---|---|---|---|---|---|---|
| **resolveId + native filter** | ✅ `filter.id` RegExp (native in bundled/Rolldown paths; JS-side pre-check in dev container); unplugin passes it through (Vite ≥7) | ✅ Rust-side; RegExp-only `id`; composable exprs incl. `importerId` (T) | ✅ ≥4.38 (JS-side); unplugin native ≥4.40 | ✅ `onResolve({filter: RE2, namespace})`; unplugin uses `esbuild.onResolveFilter` (default `/.*/`) | ⚠️ no filter on `nmf.hooks.resolve` → every request crosses to JS (unplugin) | ⚠️ JS (`resolve.plugins` or NMF hooks) | ✅ Rust regex `filters.sources/importers` (unplugin reads `options.filters`) | ✅ `onResolve({filter})`; unplugin uses `/.*/` |
| **`jsr:`/`npm:`/`https:` specifiers reach the plugin** | ⚠️ `jsr:`/`npm:` yes (use `enforce:'pre'`); **`https://` skipped in dev import-analysis** unless alias-matched (T); build: only `enforce:'pre'` plugins see it (T) | ✅ (T) | ✅ | ✅ | ✅ via NMF `resolve` (T) — but `externalsPresets.web` externalises `http(s)` first (disable) | ❌ via unplugin (T); ✅ via `resolveForScheme`/`resolveInScheme` (T); `target:'deno'` externalises them by design | ✅ (source passed) | ✅ |
| **load non-file ids** | ✅ (`\0`-prefixed or URL ids; served as `/@id/…`) | ✅ (T) | ✅ | ⚠️ namespaces; unplugin forces plugin namespace for *all* ids (T) | ⚠️ unplugin virtual files `node_modules/.virtual/…` + importer leading-`/` bug (T); native: `resolveForScheme` + pitching loader (T); `readResource` unwired (#12210) | ⚠️ unplugin `_virtual_` (non-scheme ids only); native `readResource.for(scheme)` ✅ (T) | ✅ (unplugin mangles URL importers) | ✅ namespaces / `build.module()` |
| **set module type from load** | ⚠️ build ✅ `moduleType` (T); dev ❌: `vite:oxc` keys on extension and skips `\0` ids (T) → transpile in `load` (`transformWithOxc`) | ✅ `moduleType` any id (T) | ❌ (JS only; needs TS plugin) | ✅ `loader` (unplugin `esbuild.loader(code,id)`) | ❌ rule-based (`test`/`scheme`/`mimetype`/`with` + `type`) — encode extension/query in id | ❌ rule-based; `experiments.typescript` by extension | ✅ `moduleType` in load result | ✅ `loader` (unplugin `bun.loader`) |
| **TS/TSX transform built-in** | ✅ Oxc | ✅ Oxc (`transform.*`) | ❌ (JSX only, `jsx` option) | ✅ | ✅ `builtin:swc-loader` (configure rules) | ⚠️ strip-only `experiments.typescript` (no TSX/enums); else loaders | ✅ SWC | ✅ |
| **JSX `precompile`** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **import attributes visible to resolver** | ❌ (hook types lack them) | ❌ (T) | ✅ `attributes`, `importerAttributes`; `load(id,{attributes})` (T) | ✅ `args.with` (T) | ✅ `resolveData.attributes` (read-only), rule `with` | ✅ `ResolveData.attributes` | ❌ | ❌ |
| **`with {type:'text'\|'bytes'}` bundling** | ❌ (Rolldown) | ❌ ignored/deduped (T) | ⚠️ via plugin; inconsistent attrs warn (T) | ✅ text+bytes (T) | ✅ (T) | ⚠️ ✅ build, bytes runtime bug seen for `target:'deno'` dev (T) | ? | ? (not verified) |
| **externals from resolver** | ✅ `{external:true}` (build); SSR via `resolve.external/noExternal`; `resolve.builtins` | ✅ `external: true\|'absolute'\|'relative'` | ✅ | ✅ `external:true`, `packages:'external'` | ⚠️ `externals` fn; unplugin `external:true` only skips load (#238) | ⚠️ same; `target:'deno'` preset | ✅ | ✅ |
| **watch files** | ✅ `addWatchFile` (build) / dev watcher (`server.watch`) | ✅ `addWatchFile`, `watchChange`, `watch.onInvalidate` | ✅ | ✅ `watchFiles/watchDirs` | ✅ `fileDependencies`/`addDependency` | ✅ | ✅ `addWatchFile(id, importer)` | ⚠️ none (unplugin stores list) |
| **virtual modules** | ✅ `\0` convention | ✅ `\0` + `description` | ✅ | ✅ namespaces | ✅ native `experiments.VirtualModulesPlugin` | ⚠️ `webpack-virtual-modules` / scheme hooks | ✅ | ✅ `module()`, `files` |
| **environment awareness** | ✅ `this.environment` (Env API RC), `applyToEnvironment`, per-env `resolve.conditions` | ⚠️ `platform` only | ❌ | ⚠️ `initialOptions.platform/conditions` | ⚠️ `options.target`; Rsbuild `environment` in `api.resolve/transform` | ✅ `compiler.platform.{web,node,deno,bun,universal}`, `target:'deno'` | ⚠️ `output.targetEnv` | ⚠️ `config.target` |
| **Deno as output platform** | ⚠️ no preset (add `deno` condition, `resolve.builtins`, `ssr` env) | ⚠️ `platform:'node'\|'neutral'` | ⚠️ manual | ⚠️ `platform:'neutral'\|'node'` | ❌ no `deno` target | ✅ `target:'deno[X.Y]'` | ❌ | ❌ |
| **runs under Deno 2.9.7** | ✅ (T) | ✅ napi (T) | ✅ napi (T) | ✅ (T) | ✅ napi (T) | ✅ (T) | not tested | n/a |

---------------------------------------------------------------------------------------------------------------------

## L. Implications for `unplugin-deno` (derived from the above)

1. **Resolve once, in one place, and feed every host a canonical id.** Use a Deno-aware resolver (e.g. `@deno/loader`
   WASM, or `deno info --json`-derived graph) and emit ids that *keep a real file extension* (ending in
   `.ts/.tsx/.js/.json`) so webpack/Rspack rules and unplugin's esbuild/Bun loader guessing work; use `moduleType`
   (Rolldown, Vite build), `esbuild.loader`, `bun.loader` as the precise channel. **For Vite dev, transpile in `load`**
   (`transformWithOxc`) because `vite:oxc` skips `\0` ids and ignores `moduleType` (experiment 26).
2. **Per-host escape hatches are mandatory, not optional:**
   - Vite: `enforce:'pre'`; add a `resolve.alias` for `^https?://` (or rewrite) so dev import-analysis resolves remote
     URLs; add `deno` to server-env `resolve.conditions`/`externalConditions`; set `resolve.builtins` for Deno server
     envs; handle `optimizeDeps` for npm packages living in DENO_DIR (or require `nodeModulesDir`); use `this.environment`
     (`consumer === 'server'` ⇒ Deno conditions) and `server.fs.allow` for DENO_DIR if files are served directly.
   - Rolldown: native filters (`resolveId.filter.id`), `moduleType` from `load`, `platform`; work around missing
     import attributes (rewrite `with {type:'bytes'|'text'}` specifiers in `transform` using `meta.ast`/`this.parse`).
   - webpack: `webpack(compiler)` → `nmf.hooks.resolveForScheme/resolveInScheme.for('jsr'|'npm'|'https'|'http')` +
     `NormalModule.getCompilationHooks(c).readResource.for(...)`; disable/respect `externalsPresets.web` and the
     `target:'deno'` externals.
   - Rspack: `rspack(compiler)` → `nmf.hooks.resolve` (sees scheme requests; has `attributes`) + `resolveForScheme` +
     a `rules[{ scheme: /^(jsr|npm|https?)$/, enforce:'pre' }]` pitching loader (readResource is unwired); or
     `experiments.buildHttp.httpClient` backed by DENO_DIR for `https:`; fix unplugin's leading-`/` importer.
   - esbuild/Bun: set `esbuild.onResolveFilter`/`onLoadFilter`; return `namespace:'file'` for real files via
     `esbuild.setup` (unplugin otherwise namespaces them); read `args.with` there.
3. **Running under Deno is a first-class target** (Deno Deploy builds run bundlers through Deno shims): avoid
   `module.register()`, rely on `registerHooks` only if needed; napi bindings are fine with `--allow-ffi`.
4. **Transpilation**: rely on host transpilers (Oxc/SWC/esbuild) for `react-jsx`; offer `deno transpile`/`@deno/loader`
   emit as an opt-in path for `jsx:"precompile"` and for TS features webpack's strip-only mode rejects.
5. **Filters**: expose RegExp-only `resolveId` filters (unplugin 3.4 rule; Rolldown/Rollup semantics), keep Vite ≥7 /
   Rollup ≥4.40 for native filtering; consider `@rolldown/pluginutils` expressions (`importerId`) via the `rolldown`
   escape hatch.

---------------------------------------------------------------------------------------------------------------------

## M. Sources (primary)
- unplugin: <https://github.com/unjs/unplugin> (src @ `f2acf00`), releases v3.0.0–v3.4.0, issues #47, #238, #372, #421,
  #483, #508, #524, #546, #591/#592, #593/#596, #616/#615, #618/#617; docs <https://unplugin.unjs.io/guide/>.
- Vite: <https://vite.dev/blog/announcing-vite8>, <https://vite.dev/guide/migration>, <https://vite.dev/guide/api-environment>,
  <https://vite.dev/config/server-options#server-fs-allow>, CHANGELOG (8.0.0 #21189, #21268, #21510; 8.1.0; 8.2.0 #22642,
  #23035; 8.3.0 #23310, #23133, #23110, #23437), `vite@8.3.1` dist.
- Rolldown: <https://github.com/rolldown/rolldown/releases> (v1.0.0, v1.1.0 #9632, v1.2.0), <https://rolldown.rs/apis/plugin-api/hook-filters>,
  <https://rolldown.rs/in-depth/module-types>, issues #2758, #6410, #9088, #10407, #10042; `rolldown@1.2.11` d.ts.
- tsdown: `tsdown@0.23.0` d.ts, issue rolldown/tsdown#707.
- Rollup: <https://github.com/rollup/rollup/blob/master/CHANGELOG.md> (#5882, #5909, #5668, #5474, #5700), PR #5994, #6532.
- esbuild: <https://github.com/evanw/esbuild/blob/main/CHANGELOG.md> (#4435, deno.land/x note), CHANGELOG-2025 (absPaths 0.25.7),
  `esbuild@0.28.2` d.ts; Deno `cli/tools/bundle/esbuild.rs@v2.9.7`.
- Bun: <https://bun.com/blog/bun-v1.4>, `bun-types@1.4.2`.
- Rspack/Rsbuild: <https://rspack.rs/blog/announcing-2-0>, <https://rspack.rs/guide/migration/rspack_1.x>, rspack#12210,
  `@rspack/core@2.2.7`, `@rspack/binding@2.2.7`, `@rsbuild/core@2.2.9` d.ts.
- webpack: releases v5.108.0 (#21247, #21248), v5.109.0 (#21477), v5.110.0, v5.111.0 (#22011, #22088); `webpack@5.111.1`
  `types.d.ts`, `lib/deno/DenoTargetPlugin.js`, `lib/config/target.js`, `lib/typescript/TypeScriptPlugin.js`.
- Farm: <https://github.com/farm-fe/farm>, `@farmfe/core@1.7.11` d.ts.
- Deno: <https://deno.com/blog/v2.5> … <https://deno.com/blog/v2.9>, <https://docs.deno.com/runtime/fundamentals/node/>,
  <https://docs.deno.com/runtime/reference/cli/bundle/>, <https://docs.deno.com/deploy/reference/builds/>,
  <https://docs.deno.com/examples/vite_tutorial/>, <https://jsr.io/docs/npm-compatibility>,
  `cli/schemas/config-file.v1.json@v2.9.7`, `libs/resolver/factory.rs@v2.9.7`.
- TypeScript: <https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/>,
  <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>.
