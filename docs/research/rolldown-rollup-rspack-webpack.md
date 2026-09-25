# Deno support in Rolldown / Rollup / Rspack / webpack — research report

Research date: 2026-09-25. Scope: prior art for a new multi-bundler Deno plugin ("unplugin-deno", built on unplugin).
`$SCRATCH` = `/private/tmp/claude-501/-Users-divyansh-unplugin-deno/1a551bae-bee4-41ac-ba89-ea42b9e7cb9a/scratchpad`.

Tool versions that were current on 2026-09-25 (npm/JSR): rolldown **1.2.11** (stable 1.x), rollup 4.63.5, tsdown 0.23.0,
webpack **5.111.1**, @rspack/core **2.2.7**, @rsbuild/core 2.2.9, unplugin **3.4.0**, @deno/loader **0.5.0** (JSR), Deno 2.9.7 locally.

I ran small experiments, and their scripts are listed in §13. Everything marked **[verified]** was observed by running code, not just read from the source.

---

## 0. TL;DR

* **`@deno/rolldown-plugin` is JSR-only, not on npm** (`jsr:@deno/rolldown-plugin@0.0.10`, repo `denoland/deno-rolldown-plugin`, 31★).
  It is about 180 lines around `@deno/loader` (deno_graph, deno_resolver and deno_npm compiled to Wasm). It hasn't been touched since 2025-07-31.
  It pins `@deno/loader@^0.3.0`, which can only run under Deno because the Wasm `sys_traits` backend calls `Deno.*`.
  **`@deno/loader` ≥ 0.4.0 (2026-03-28) runs under Node too** (sys_traits PR #80). The "must run via Deno" limitation is now just a stale dependency pin.
  The plugin does everything in `resolveId`: it resolves, then eagerly loads, then caches the code, and `load` only looks the code up.
  It **does not use rolldown's `moduleType` or hook filters**. Instead it appends a fake extension (`<url>.rolldown.js`) so rolldown can infer the type.
  **[verified]** It still works with rolldown 1.2.11 under Deno for `jsr:`, `node:` and JSON imports.
* **webpack ≥ 5.108.0 has `target: "deno" | "denoX[.Y]"`** (PR #21247, 2026-06-23). It is only an **output/runtime target**:
  * It emits ESM (`chunkFormat: "module"`, `chunkLoading: "import"`, `.mjs`).
  * It externalizes Node builtins **with a forced `node:` prefix**.
  * It keeps `npm:`, `jsr:`, `node:` and `http(s):` imports **external**.
  * It adds the `deno` export condition, translates `import.meta.main` to an "is entry module" check, and gates `import.meta.dirname/filename` on the Deno version.
  * It does **not** read `deno.json` or import maps, and does **not** resolve or bundle `jsr:`/`npm:`/`https:`. `https:` bundling needs `experiments.buildHttp`.
  * **Surprise:** since **webpack 5.102.0**, `externalsPresets.web` (so the default `target: "web"` too) also externalizes `jsr:`, `npm:` and `std:` requests.
* **`experiments.buildHttp` (webpack's HttpUriPlugin since webpack 5.49.0, also in Rspack ≥ 1.3) is the best prior art for remote-module fetching.** It has:
  * an `allowedUris` allow-list
  * `webpack.lock` with sha512 integrity and content-type
  * a content cache in `webpack.lock.data/`
  * `frozen`, which defaults to true in production, plus `upgrade`
  * Cache-Control, ETag and redirect handling, plus proxy support
  * EOL-corruption detection, and a lockfile parser that tolerates merge conflicts
* **Rolldown PR #1762** was an *example-only* Rust `HttpImportPlugin` (`reqwest` fetch, `module_type: Ts`). It was closed unmerged in 2024-09.
  Its sibling issue #1768, "http-import by default", was closed **NOT_PLANNED**.
  A native `builtin:deno-loader` (PR #3124) was also closed. Maintainers don't want Deno support in core because of binary size.
  Issue #3172 ("Native Deno Loader Plugin Integration") is still open but stale. Today rolldown has **no Deno platform**: `platform` is only `node | browser | neutral`.
  **Rolldown does not pass import attributes to plugins** (issue #2758 is open). That matters for Deno's `with {type:"text"|"bytes"}`.
* **Critical unplugin finding [verified, unplugin 3.4.0]:**
  * **webpack:** `resolveId` is **never called for `jsr:`, `npm:`, `https:` or `node:` requests**. webpack routes scheme URIs past enhanced-resolve, where unplugin's resolver plugin lives. Depending on the target they are either externalized by presets or fail with `UnhandledSchemeError`.
  * **rspack:** `resolveId` *is* called, because unplugin taps `normalModuleFactory.hooks.resolve`.
  * **Both adapters silently ignore `{ external: true }`:** a non-file id becomes an **empty virtual module**. For example, `node:fs` was bundled as a 1-byte module.
  * `load` output is forced to `type: 'javascript/auto'`, and there is no `moduleType`.
  * So unplugin-deno needs the `webpack(compiler)` / `rspack(compiler)` escape hatches: `resolveForScheme`, virtual modules and native externals.
* **Rspack JS API [verified 2.2.7]:**
  * `normalModuleFactory.hooks.resolveForScheme.for('jsr')` works from JS.
  * `NormalModule.getCompilationHooks(c).readResource.for(scheme)` exists in the typings but is **never called**: it isn't wired to Rust, and reading still fails with "Unhandled scheme".
  * The recipe that works: in `resolveForScheme`, rewrite `resourceData.resource/path` to a path served by `rspack.experiments.VirtualModulesPlugin`. `builtin:swc-loader` then handles `.ts` if the virtual path ends in `.ts`.
  * `ResolveData.attributes` (import attributes) is available since rspack 2.2.3, and `module.rules[].with: {type:"text"}` works.
* `rspack-deno-plugin` (npm and JSR, 11★) is a naive `beforeResolve` request rewriter. It is Deno-runtime-only, runs `deno info --json` per specifier, needs `nodeModulesDir`, and has several bugs.
  `@lulu/deno-rolldown-plugin` is a small `@deno/loader@^0.1` port. It uses `moduleType` correctly but has no filters and no fallthrough.
  `rollup-plugin-deno` (egoist, 2021) solves the *opposite* problem: it builds Node code *for* Deno.
  `deno-rollup` / `rollup-plugin-deno-resolver` (cmorten, archived) was a full Deno port of Rollup 2 with URL imports and `Deno.emit`.

---

## 1. `@deno/rolldown-plugin` (official)

### 1.1 Identity
| Field | Value |
|---|---|
| Registry | **JSR only**: `jsr:@deno/rolldown-plugin`. `npm view @deno/rolldown-plugin` returns 404. The task brief said npm, which is wrong. |
| Repo | https://github.com/denoland/deno-rolldown-plugin (JSR metadata still says `denoland/rolldown-plugin`, which redirects) |
| Maintainer | David Sherret (all 13 commits) |
| License | MIT |
| Latest | 0.0.10, published 2025-07-31 (10 versions: 0.0.1 on 2025-06-04 through 0.0.10) |
| Stars / forks | 31 / 2 (`sandros94`, `qupig`, which only carry PR branches) |
| Activity | Last commit 2025-07-31 ("fix: strip base directory off files (#11)"). Two community PRs have been open since 2026-01/02 with no response. **Effectively dormant.** |
| JSR | score 82. runtimeCompat: **deno only**. Dependents: `@azurite/rolldown-plugins`, `@brad-jones/deno-net-bundler` |
| Dependencies | `jsr:@deno/loader@^0.3.0` (resolves to ≤ 0.3.14, **never 0.4+/0.5**), `jsr:@std/path@^1.1.1` |
| Clone | `$SCRATCH/repos/deno-rolldown-plugin` (source: `src/mod.ts`, 178 lines. Test: `src/mod.test.ts`) |

### 1.2 How it plugs into Rolldown/Rollup
The plugin object is `{ name: "deno-plugin", buildStart, resolveId, load, [Symbol.dispose] }`, typed by hand with no `rolldown` types. It claims Rollup compatibility too.
* **`buildStart(options)`**
  * Normalizes `options.input` (string, array or record) into a list.
  * Creates `new Workspace({...pluginOptions})` and runs `loader = await workspace.createLoader()`.
  * Calls `await loader.addEntrypoints(inputs)`, which builds the npm/jsr graph the way `deno` would. The diagnostics it returns are **ignored**.
* **`resolveId(source, importer, { kind })`**
  * No `filter`, no `order`. It claims **every** id.
  * Maps `kind`: `import-statement` and `dynamic-import` → `ResolutionMode.Import`, `require-call` → `ResolutionMode.Require`. Any other kind **throws** `"not implemented"`, which includes rolldown's `new-url`, `import-rule`, `url-token` and `hot-accept`.
  * Maps the importer id back to the original specifier through the `modules` map.
  * `await loader.resolve(source, importer, mode)` uses the async resolve. Loader docs warn this can cause extra "npm installs" compared with `resolveSync` after `addEntrypoints`.
  * Then it **eagerly loads**: `loader.load(resolved, RequestedModuleType.Default)`. It always uses `Default`, so import attributes are ignored.
  * If `kind === "external"` (for `node:`), it returns `{ id, external: true }`.
  * Otherwise it appends `".rolldown" + ext` when the URL doesn't already end with the extension derived from the media type. Example: `https://esm.sh/react` becomes `https://esm.sh/react.rolldown.js`, and `foo.mts` becomes `foo.mts.rolldown.ts`. This lets rolldown infer the module type from the extension.
  * `file:///` URLs are converted to paths "so the base gets stripped" (#11). This gives nicer `//#region` names and fixes issue #6.
  * It stores `{specifier, code: TextDecoder(code)}` in `modules`.
* **`load(id)`** returns `modules.get(id)?.code` and **no `moduleType` or `map`**.
* **`[Symbol.dispose]`** frees the Wasm loader. Rolldown never calls it, so the old loaders leak in watch mode because every `buildStart` creates a new Workspace.
* Not used: `this.error` or `this.warn`, `addWatchFile` (so `deno.json` and `deno.lock` changes are not watched), `watchChange`, `moduleSideEffects`, `meta`, `options` or `outputOptions`, rolldown's `platform`, `resolve.conditionNames`, hook filters, and `moduleType`.

### 1.3 Resolution and loading architecture
Everything is delegated to `@deno/loader`, which is Deno CLI code (deno_graph, deno_resolver, deno_npm, deno_config) compiled to Wasm:
* **Config:** it discovers `deno.json(c)` and `deno.lock` from the cwd, including workspaces. Options: `configPath`, `noConfig`, `noLock`, `cachedOnly`.
* **`jsr:`** resolves to `https://jsr.io/...` URLs through the JSR registry and `deno.lock`. It downloads into `DENO_DIR`. Output ids are `https://jsr.io/@std/path/1.1.6/join.ts`.
* **`npm:`** resolves through deno_npm into the global cache (`DENO_DIR/npm/registry.npmjs.org/...`) or into `node_modules` when `nodeModulesDir` is set.
  * The README says "ESM/CJS interop is not implemented" and "will probably not work well for npm packages".
  * Issue #8: subpath exports in deep ESM files fail (for example `react-remove-scroll-bar/constants`, and `Could not find referrer npm package ...`).
* **`https:`** is supported by deno_graph, with redirects and `DENO_AUTH_TOKENS` because it's the Deno CLI's http client, reached through Wasm fetch.
* **`node:`** is `kind: "external"`. It was fixed in 0.0.5 (#2/#3). **Bare builtins (`fs`) are not prefixed.**
* **`data:`, `blob:`, `file:`** are supported by the loader.
* **Transpilation:** the loader transpiles TS/TSX/JSX to JS by default, using `compilerOptions` from deno.json. Options: `noTranspile`, `preserveJsx`.
  The plugin then hands rolldown JS under a `.ts` or `.tsx` id, so rolldown parses and transforms it a second time.
  **Source maps are lost.** `@deno/loader@0.5` now returns `sourceMap` (PR #84), but the plugin can't reach it.
* **Platform:** the loader's `platform` option (`"node" | "browser"`, default `"node"`) chooses npm export conditions. The plugin passes it through as a user option but **does not map it from rolldown's `platform`**.

### 1.4 Why it must run under Deno
The README says: "You must run rolldown via Deno … running it via Node.js would require dsherret/sys_traits#4".
The Wasm build of `sys_traits` implemented fs, env and time with `Deno.*` APIs.
`sys_traits` PR #80 (merged 2026-03-27) moved the Wasm backend to Node APIs, and **`@deno/loader` 0.4.0 (2026-03-28, "feat: add Node.js runtime support (#82)")** instantiates the Wasm manually under Node (`src/rs_lib_node.js`).
The plugin's `^0.3.0` range can't pick that up. **A modern plugin can use `@deno/loader` ≥ 0.4 from Node, Deno or Bun** (install it on Node with `npx jsr add @deno/loader`).

### 1.5 Options (from source)
`DenoPluginOptions extends WorkspaceOptions` (from `@deno/loader@0.3.0`), with no extra options:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `noConfig` | boolean | false | skip deno.json discovery |
| `noLock` | boolean | false | ignore deno.lock |
| `configPath` | string | discovered | path or `file:` URL to deno.json |
| `nodeConditions` | string[] | – | extra conditions for package.json `exports` |
| `platform` | `"node" \| "browser"` | `"node"` | npm resolution platform |
| `cachedOnly` | boolean | false | no network (but `nodeModulesDir: "auto"` overrides it, see #7) |
| `debug` | boolean | false | loader debug logs, plus "Remapped X to Y" logs from the plugin |
| `preserveJsx` | boolean | false | keep JSX |
| `noTranspile` | boolean | false | skip TS/JSX transpile |

`@deno/loader@0.5.0` adds `newestDependencyDate: Date` (a minimum-release-age style limit), and its `MediaType` gains `Jsonc`, `Json5` and `Markdown`.

### 1.6 Quality
* **Tests:** one Deno test (`src/mod.test.ts`) that resolves and loads itself and checks that `node:events` is external. It never actually runs rolldown.
* **CI:** `deno fmt --check`, `deno lint`, `deno test -A` on **canary** Deno, and JSR publish on tag (`jsr:@david/publish-on-tag`).
* **Types:** hand-written, not `rolldown`'s `Plugin` type.
* **Bugs found while reading:**
  * The `loads` map is **never written** (`loads.get` only), so the "dedupe load promises" logic is dead code.
  * Resolution failures reject from `resolveId` instead of returning `null`. That hides rolldown's `UNRESOLVED_ENTRY` diagnostics (#14) and can cause rolldown panics (rolldown #8326, closed as not planned).
  * Unknown `kind` values throw.
  * No `moduleType`, so types are inferred from fake extensions.

### 1.7 Issues and PRs (all of them: https://github.com/denoland/deno-rolldown-plugin/issues)
* **#15 (open)** "Plugin should discard `import.meta.main` blocks of non-entry modules". In a single bundle, every module's `if (import.meta.main)` block runs. **[verified]** Still true: output keeps `if (import.meta.main)` verbatim. (webpack solves this, see §6.)
* **#14 (open)** "plugin prevents useful error prompts or causes rust panic". A missing entry gives `TypeError: Cannot convert undefined or null to object` instead of `UNRESOLVED_ENTRY`. **PR #16 (open)** fixes it by returning `null` on load errors.
* **#8 (open)** "Fails to resolve npm packages with subpath exports or complex module structures" (radix-ui, @base-ui-components). dsherret: "when bundling it should do more work".
* #12 (closed) "Log resolved config file or workspace in debug". Users can't tell which deno.json and lock are in effect. Suggestion: log `🦕 config: ../deno.json`, `lock: ../deno.lock`.
* #7 (closed) panics with `cachedOnly` and missing deps (Tokio `Send should not fail`, V8 "disposed Isolate"). The root cause was `nodeModulesDir: "auto"` plus `deno task` auto-install.
* #6 (closed) `//#region` ids included `DENO_DIR` absolute paths, which made output non-reproducible. Fixed by converting ids to paths and stripping the base.
* #2 (closed) `Unsupported scheme "node"`.
* **PR #13 (open, sandros94)** `rewriteExternalSpecifiers`.
  * Uses `loader.getGraphUnstable()` plus a `renderChunk` regex to rewrite *external* bare imports to Deno-native specifiers (`"chalk"` → `"npm:chalk@5.6.2"`, `"@std/assert"` → `"https://jsr.io/@std/assert/1.0.17/mod.ts"`).
  * It reads `options.external` in the `options` hook.
  * The idea is good, because it produces a bundle that runs on Deno without an import map (use case: Bunny Edge Scripting). The implementation (regex over output) is fragile. It should happen in `resolveId` by returning `{id: "npm:chalk@5.6.2", external: true}`.

### 1.8 Empirical check [verified]
`$SCRATCH/sandbox/drp`: Deno 2.9.7, `npm:rolldown@1.2.11`, `jsr:@deno/rolldown-plugin@0.0.10`.
Input: `@std/path` through an import map, `jsr:@std/path@1/basename`, `node:fs`, and `./data.json with {type:"json"}`, with `platform: "neutral"`.
Result:
* The bundle builds.
* Regions are named `//#region https://jsr.io/@std/path/1.1.6/join.ts`.
* `node:fs` stays external.
* JSON is inlined.
* `if (import.meta.main)` is kept.

### 1.9 Ideas to steal / pitfalls
* Steal:
  * Use `@deno/loader` as the single source of Deno semantics (config, lock, workspaces, npm, jsr, https, `DENO_AUTH_TOKENS`, transpile).
  * Call `addEntrypoints()` in `buildStart` so npm/jsr resolution matches `deno run`.
  * Normalize `file:` URLs to paths for stable output.
  * `kind` → `ResolutionMode` mapping.
  * PR #13's "rewrite externals to pinned Deno specifiers" feature.
* Avoid:
  * Loading inside `resolveId`.
  * Fake `.rolldown.js` extensions: use `moduleType` for rolldown, and `.ts`-suffixed virtual paths for webpack/rspack.
  * Throwing instead of returning `null`.
  * Ignoring `platform` and conditions.
  * Ignoring import attributes.
  * No source maps.
  * No `addWatchFile(deno.json/deno.lock)`.
  * A new Workspace per rebuild with no disposal.
  * Canary-only CI.
  * Pinning a Deno-only loader range.

---

## 2. `@lulu/deno-rolldown-plugin`

| Field | Value |
|---|---|
| Registry / repo | JSR `@lulu/deno-rolldown-plugin` 0.1.1 (2025-06-21), 0.1.0. Repo https://github.com/luludotdev/deno-rolldown-plugin (Jack Baron). 1★, 1 fork (gmh5225, not ahead). MIT. Last push 2025-06-21. JSR score 100. runtimeCompat deno-only |
| Deps | `jsr:@deno/loader@^0.1.2` (pinned to the June-2025 0.1.x API, **which has the #8 subpath bug**). Imports `npm:rolldown@1.0.0-beta.18` types |
| Clone | `$SCRATCH/repos/lulu-deno-rolldown-plugin` (`mod.ts`, 128 lines) |

**v0.1.x (a port of the new `@deno/esbuild-plugin`):**
* `buildStart`: `new Workspace({debug, configPath})` then `workspace.createLoader({ entrypoints, noTranspile, preserveJsx })`, using the old 0.1 API where entrypoints are passed at creation.
* `resolveId`:
  * `isBuiltin(id)` (from `node:module`) → `{id, external: true}`. Bare `fs` is kept **unprefixed**.
  * Otherwise it calls the *sync* `loader.resolve(id, importer, kind)`. `require-call` maps to `Require` and everything else to `Import`. `file:` results become paths.
  * **No filter and no fallthrough.** Unresolvable ids throw.
* `load`:
  * Converts every id to a URL (`http(s):`, `npm:` and `jsr:` stay as-is, anything else goes through `toFileUrl(id)`), then calls `loader.load(url)`.
  * Returns `{ code, moduleType: mediaToLoader(mediaType) }` (`Jsx→jsx`, `Js/Mjs/Cjs→js`, `Ts/Mts/Dmts/Dcts→ts`, `Tsx→tsx`, `Css→"css"`, `Json→json`, `Wasm→"binary"`, `SourceMap→json`, `Html/Sql/Unknown→"default"`).
  * Two of those values (`"css"` and `"default"`) aren't valid rolldown `ModuleType`s in 1.2.x. The valid set is `js|jsx|ts|tsx|json|text|base64|dataurl|binary|empty`.
  * **Pitfall:** because `load` has no filter, it hijacks other plugins' virtual ids (`\0foo`), calls `toFileUrl` on them and fails.
* **Options:** `debug?`, `configPath?`, `noTranspile?`, `preserveJsx?`.
* **v0.0.x history** (commit `00e8d70` "rough port from deno-vite-plugin", 2025-05-02) had three parts:
  * A `deno:prefix` plugin with `resolveId: { order: "pre" }` for `npm:` and `http(s):`.
  * A main plugin that shells out to `deno info --json <id>` (`resolver.ts`) and stores `{loader, id, resolved}` in rolldown **module `meta.deno`**. It reads the importer's meta through `this.getModuleInfo(importer)` to resolve relative imports inside cached remote modules.
  * It used `import.meta.resolve(id)` to apply the *host* Deno's import map (that only works when running under Deno).
  * `npm:` was mapped to `this.resolve(bareName)`, which dropped the version (a TODO).
* **Differences from the official plugin:**
  * returns `moduleType` (better)
  * sync resolve
  * resolves in `resolveId` and loads in `load` (correct split)
  * no `.rolldown` fake extensions
  * treats Node builtins through `isBuiltin` instead of loader "external"
  * no file-URL/importer remapping map
  * older loader API
  * no tests, CI only runs `deno check`, `lint` and `fmt`
* Steal: the `moduleType` mapping, the correct resolve/load split, and the idea of putting Deno info in `meta`.

---

## 3. Rollup-era packages

### 3.1 `rollup-plugin-deno` (npm, egoist)
* Version 1.0.1 (2021-03-29), MIT, no repository field, about 35 downloads per month. Tarball: `$SCRATCH/tarballs/rollup-plugin-deno-1.0.1/`.
* **Purpose is the reverse: "Create a bundle for Deno runtime"**, meaning it converts Node-targeted code so it runs on Deno.
* `resolveId`: Node builtins (`builtinModules`) → `{ id: "https://deno.land/std@0.90.0/node/<name>.ts", external: true }`, the Deno std Node polyfills of the time.
* `renderChunk`: regex-based global shims. It detects `process`, `global`, `Buffer`, `setImmediate/clearImmediate` and `__filename/__dirname`, then prepends imports from std/node and rewrites `__dirname` to `_deno_path.dirname(_deno_path.fromFileUrl(import.meta.url))`.
* Historical idea that is still relevant, since webpack now does it natively: **output-side "target Deno" transforms**, meaning `node:` prefixing, `__dirname` or `import.meta.dirname` shims, and globals. Obsolete today because Deno implements `node:` builtins and the `process` and `Buffer` globals.

### 3.2 `rollup-plugin-deno-resolver` / `deno-rollup` ("drollup")
* **Origin:** https://github.com/cmorten/deno-rollup (Craig Morten), 72★, **archived**. Last push 2022-08-28 ("feat: fully deprecate"). deno.land/x/drollup `2.58.0+0.20.0`.
  https://github.com/crewdevio/deno-rollup (0★) is a 2022 copy with one extra commit bumping to Rollup 2.67.3.
  `rollup-plugin-deno-resolver` was never published to npm. It lived at `src/rollup-plugin-deno-resolver/` inside drollup.
* A **full Deno-native port of Rollup 2**: it imported `https://unpkg.com/rollup@2.58.0/dist/es/rollup.browser.js`, wrapped the CLI and API, and bundled Deno ports of plugins (importmap, esbuild, terser, css, html, json, postcss, svelte, yaml, virtual, image, string).
* The resolver plugin (`denoResolver({ fetchOpts?: RequestInit, compilerOpts?: Deno.CompilerOptions })`, see `$SCRATCH/repos/cmorten-deno-rollup/src/rollup-plugin-deno-resolver/`):
  * `resolveId`: joins URLs relative to URL importers (`new URL(source, importerUrl)`).
    It fixes Windows device paths and URLs mangled by `path.normalize` (`https:/x` → `https://x`, see `ensureUrl.ts`).
    **Extensionless fallback:** if a URL returns 404, it tries `url + ".js"`, assuming CommonJS-style imports.
    It checks existence with `fetch` (a double download; there's a TODO about it).
  * `load`: `file:` → `Deno.readFile`. `http(s):` → `Cache.cache(url)` from deno.land/x/cache (its own DENO_DIR-like cache), falling back to `fetch(url, fetchOpts)`, where **`fetchOpts` carries auth headers**.
  * TS: `Deno.emit(url, { check: false, compilerOptions, sources })`. That API was removed in Deno 1.22, which is part of why the project died.
  * The importmap plugin (derived from rollup-plugin-import-map) validates maps, supports `imports` and `scopes`, and has an `external: true` option that marks all mapped imports external.
* Deprecation reason: `npm:rollup` runs on Deno (Deno 1.25+). "Future efforts will be spent bolstering the Node compatibility layer."
* Lessons:
  * Fetching remote code yourself needs caching, integrity and auth. Use Deno's own machinery instead (`@deno/loader`).
  * Relying on unstable Deno APIs (`Deno.emit`) kills a project.
  * Extension-less remote URLs are a real problem, and the fix is to use the Content-Type/media type, not guess `.js`.

---

## 4. `rspack-deno-plugin` (npm) / `@snowman/rspack-deno-plugin` (JSR)

| Field | Value |
|---|---|
| Repo | https://github.com/LonelySnowman/rspack-deno-plugin, 11★, 1 fork. MIT. Created 2025-01-31, last push 2025-10-18 |
| Versions | npm `rspack-deno-plugin` 1.0.7 (2025-10-18), JSR `@snowman/rspack-deno-plugin` 1.0.7 (same code). npm downloads about 71 per month |
| Origin | Built for **rspack bounty issue #8696** ("support rspack-deno-{loader,plugin} to bundle deno application", $100, closed 2025-04-16) after Deno issue denoland/deno#26091 ("dependencies not resolved when using RsBuild", where JSR packages aren't in node_modules). "This project learns esbuild_deno_loader." |
| Deps | **`@rspack/core` and `@rspack/cli` as runtime dependencies**, not peer dependencies, which duplicates rspack. `lodash-es` is unused |
| Runtime | **Deno only**: `Deno.cwd()`, `Deno.Command(Deno.execPath())`, `Deno.readTextFileSync`, `Deno.env` |
| Clone | `$SCRATCH/repos/rspack-deno-plugin` (`src/index.ts`, `src/deno-cache.ts`, `src/loader/native-loader.ts`) |

**How it plugs in:**
* `class RspackDenoPlugin { apply(compiler) }` taps `compiler.hooks.beforeRun` and `watchRun` (tapPromise) → `initPlugin()`.
  * `initPlugin()` pushes **two `module.rules`** on every run: `builtin:swc-loader` with `jsc.parser.syntax: "typescript"` for everything under the DENO_DIR remote cache (`test: <modulesCache dir>`), and for `/\.ts$/`.
  * **Bug:** the rules accumulate on every `watchRun`.
  * **Bug:** the remote cache is treated as TypeScript regardless of media type, so TSX and JSX fail.
* `compiler.hooks.compilation` → `normalModuleFactory.hooks.beforeResolve.tapPromise` mutates `resolveData.request`:
  1. **Import map:** only the top-level `imports` of `./deno.json` in the **cwd**. The package name and subpath are split by regex. `npm:` targets are *not* rewritten; they fall through to node_modules. No `scopes`.
  2. **Inside DENO_DIR:** when `resolveData.context` contains the DENO_DIR path, it maps the issuer's local cache path back to its URL through `deno info` output, then rewrites the request to `dependencies[].code.specifier`. This is how relative imports in cached remote modules work.
  3. **Workspaces** (added in 1.0.5): walks up to find a `deno.json` with a `workspace` field, and maps member `name` to `exports`. Only string `exports`; the default is `./index.ts`.
  4. **`npm:x@range/sub`** → strips `npm:` and the version with the regex `/@[\^|~|>|<|>=|<=|=]\d+(\.\d+)?(\.\d+)?/g`, then relies on **node_modules**, so `"nodeModulesDir": "auto"` is required.
     **[verified] regex bugs:** `npm:chalk@5.6.2` → `chalk@5.6.2` (unresolvable), `npm:react@^19.0.0-rc.1` → `react-rc.1`, `npm:/chalk@>=5` → `chalk@>=5`.
  5. **`jsr:` and `http(s):`** → spawns **`deno info --json <specifier>` once per new specifier** (with `DENO_NO_PACKAGE_JSON=true`) and rewrites the request to `module.local`, the hash-named file in `DENO_DIR/remote/https/...`.
     **JSON and CSS** files are copied to `$DENO_DIR/rspack-deno-plugin/<subpath>.<ext>`, which **writes into the user's DENO_DIR**. The copy strips the trailing `// denoCacheMetadata=…` line that **Deno 2 appends to cached remote files**. That's a pitfall for anyone reading DENO_DIR directly: JSON becomes invalid, which is exactly what the bounty tester hit with `https://esm.sh/lodash@4.17.21/package.json`.
  6. `node:`, `file:`, `data:` → left to rspack.
* Uses `deno info --json --no-config --no-lock` in a temp dir to learn `denoDir`, `modulesCache` and `npmCache`.
* **Options:** only `{ mode: "native" | "portable" }` (default `"native"`). `"portable"` is an empty TODO stub.
* **Tests:** e2e build-only CI (`test/e2e/{http,jsr,npm,monorepo}`: `deno install && deno run build`) with no output assertions. No unit tests.
* Maintainer quote from #8696 (translated from Chinese):
  > "NormalModuleFactory `resolve` doesn't support returning a module instance; `readResourceForScheme` doesn't seem supported … so the only way is creating temporary local files for rspack to resolve."
  That limitation still holds in 2.2.7 (see §9).
* Steal:
  * Handle the DENO_DIR "issuer local path → URL" back-mapping.
  * Workspace member mapping.
  * `DENO_NO_PACKAGE_JSON`.
  * The warning about `denoCacheMetadata`.
* Avoid:
  * `deno info` per specifier.
  * Requiring node_modules.
  * Mutating user config on every run.
  * Writing into DENO_DIR.
  * Regex version stripping.
  * Treating all remote files as TS.
  * cwd-only `deno.json`.

---

## 5. Rspack issues about Deno (context)
* #8696 (bounty, closed): test matrix from stormslowly. Everything passed except:
  * bare `@std/yaml/stringify` not in the import map (Deno auto-resolves JSR deps from `deno.json` imports only)
  * `jsr:@std/yaml/deno.json`
  * `https://esm.sh/lodash@4.17.21/package.json`, broken by the `denoCacheMetadata` comment
* #7150 "Support for Deno runtime" (closed). Rspack and Rsbuild run under Deno. rsbuild#5804 was a Deno-specific `public/` copy bug. rsbuild#7614: `deno init --npm rsbuild` templates.
* denoland/deno#26091 (open). hardfist: "we (Rspack) can make a rspack plugin which calls deno_resolver". marvinhagemeister: every bundler assumes node_modules, which Deno can't fix.

---

## 6. webpack `target: "deno"` (5.108.0+)

### 6.1 Provenance
* **PR #21247 "feat: add deno target"** by Alexander Akait (@alexander-akait). Merged 2026-06-23 and released in **v5.108.0 (2026-06-25)**. AI-assisted (Claude Code, per the PR body). Diff saved at `$SCRATCH/notes/webpack/pr21247.diff`.
* Changed files:
  * `lib/deno/DenoTargetPlugin.js` (new; now at `lib/deno/DenoTargetPlugin.js` on main after the #22118 restructure, using `lib/node/nodeBuiltins`)
  * `lib/config/target.js`
  * `lib/config/defaults.js`
  * `lib/WebpackOptionsApply.js`
  * `lib/node/NodeTargetPlugin.js` (exports `builtins`)
  * the schema
  * tests `test/configCases/deno/{code-splitting,import-meta-dirname,node-builtins,protocol-externals,standard-api,web-and-node}`
* Siblings: **#21248 "feat: add bun target"** (same release, `bun:*` externals). **#21286 "Respect the node: prefix for node.js core modules used as externals"**. #21810 "derive the import phases from the target" (`deferImport` for deno ≥ 2.8, `sourceImport` for deno ≥ 2.6). #21524 / 5.109.1: Deno compatibility fixes in webpack itself. #21216 / #21240 / #21257: webpack's test suite now runs under Deno and Bun in CI.
* webpack issue search: `--search deno --state open` finds nothing relevant (only #17512, about web workers). Closed issues of interest: #18277 "Implement ability to use node: prefixes for Node.js core modules" (led to `output.environment.nodePrefixForCoreModules`) and #16091 "experiments.buildHttp breaks HMR".

### 6.2 What the target changes (source plus **[verified]** `applyWebpackOptionsDefaults` on 5.111.1, `$SCRATCH/sandbox/wp/defaults.cjs`)
`target: "deno"` (or `denoX`, `denoX.Y`) sets these target properties:
* `node: true, deno: true, web: true, browser: false, webworker: false, electron: false, nwjs: false`
* `require: false, nodeBuiltins: true, nodePrefixForCoreModules: true`
* `nodeBuiltinModuleGetter: ≥2.1`, `importMetaDirnameAndFilename: ≥1.40`
* `global: false, document: false, fetchWasm: true, importScripts: false`
* all modern syntax flags `true`, including `dynamicImport`, `module` and `topLevelAwait`
* `deferImport: ≥2.8`, `sourceImport: ≥2.6`

The resulting defaults:

| Area | Value for `target: "deno"` |
|---|---|
| Output format | `output.module: true` (ESM is forced; `experiments.outputModule` has since been removed, #22011), `chunkFormat: "module"`, `chunkLoading: "import"`, `workerChunkLoading: "import"`, `wasmLoading: "fetch"`, `globalObject: "globalThis"`, filenames `[name].mjs`, `scriptType: "module"`, `iife: false` |
| Externals | `externalsType: "module-import"`. `externalsPresets = { web: true, node: false, deno: true, bun: false, ... }` |
| `DenoTargetPlugin` | `new ExternalsPlugin(dep => dep.category === "commonjs" ? "node-commonjs" : "module-import", fn)`. `fn` keeps `node:*` and `/^(?:npm\|jsr\|https?):/` **as-is and external**, and rewrites bare core modules (`fs`) to **`node:fs`** |
| Web preset | since **5.102.0**, externalizes `/^(?:\/\/\|https?:\/\/\|std:\|jsr:\|npm:)/` as `module`/`import` (and `asset <url>` for `url` deps, and `css-import` for CSS) |
| Resolve | `conditionNames: ["webpack", "production"\|"development", "deno", "node", "browser"]`. `byDependency.esm.conditionNames: ["typescript"(if experiments.typescript), "import", "module-sync", "module", "..."]`. `mainFields: ["module", "..."]`. **`aliasFields: []`, so the package.json `browser` field is ignored** |
| Node stuff | `node.__dirname/__filename: "eval-only"`, `node.global: true` |
| JS parser | `javascript.importMeta: "preserve-unknown"`, `createRequire: true` |
| Loader | `loader.target: "deno"` (loaders can branch on it) |

**[verified] Output of a sample** (`$SCRATCH/sandbox/wp/src/index.mts` → `dist-deno/main.mjs`):
* `import {readFileSync} from "fs"` → `import * as … from "node:fs"`.
* `npm:chalk@5`, `jsr:@std/path@1` and `https://deno.land/std@0.224.0/assert/assert.ts` are kept as top-level ESM imports.
* Dynamic `import("./other.mts")` becomes an `.mjs` chunk loaded with native `import()`.
* **`import.meta.main` → `__webpack_require__.c[__webpack_require__.s] === __webpack_module__`**, a true "is this the entry module" check. (Recent fixes: #21620, #21973 scope-hoists it.) This is exactly the fix that `@deno/rolldown-plugin` issue #15 asks for.
* `import.meta.dirname` → a `__webpack_dirname__` shim computed from the chunk's `import.meta.url` (because the version-less `deno` target doesn't assume ≥ 1.40; `deno1.40` keeps it native).
* **`import.meta.url` was replaced by the *build-time* `file:///…/src/index.mts` literal.** Deno users who rely on the runtime module URL would find that surprising.
* `Deno.version` stays a free global.
* TypeScript was stripped by webpack's **built-in TS** (`experiments.typescript`, which is `"auto"` since 5.109.0 and becomes true when Node ≥ 22.6 `module.stripTypeScriptTypes` exists and no TS loader is configured).
  Caveat: a local `package.json` with `"type":"commonjs"` made `.ts` files parse as `javascript/dynamic` and fail. Deno projects often have no package.json `type`.

### 6.3 What it does NOT do
* It doesn't read `deno.json` or `deno.jsonc` (`imports`, `scopes`, `compilerOptions.jsx*`, `nodeModulesDir`, `workspace`, `links`, `patch`) or import maps, and doesn't use `deno.lock`.
* It doesn't resolve or bundle `jsr:` or `npm:` specifiers. They are always external, so the output only runs on Deno.
* It doesn't bundle `https:` unless `experiments.buildHttp` is on (`buildHttp` turns off `externalsPresets.web`, but the **deno preset still externalizes `https?:`**, so you'd have to disable `externalsPresets.deno` too).
* It doesn't handle `DENO_AUTH_TOKENS` or Deno's `with { type: "text" | "bytes" }` semantics (not checked).
* It doesn't map the output back to Deno specifiers for bare imports, i.e. no "rewrite externals" like PR #13 in §1.7.
* It adds the `browser` condition next to `deno`/`node`. Deno's own resolver uses `deno`, `node`, `import`/`require` and `default`, **not `browser`**, so npm packages whose `exports` list `browser` before `node` can resolve differently than under `deno run`.
* In short, it is an **output target**, not a Deno resolver. It complements unplugin-deno. For example, unplugin-deno in webpack could default to `target: "deno"` output semantics, or document it.

---

## 7. `experiments.buildHttp` (webpack HttpUriPlugin): the best remote-import prior art
Source: `lib/schemes/HttpUriPlugin.js` on main (`$SCRATCH/notes/webpack/lib_schemes_HttpUriPlugin.js`) and schema `schemas/plugins/schemes/HttpUriPlugin.json`.
* **Options** (`experiments.buildHttp: string[] | RegExp[] | fn | HttpUriOptions`):
  * `allowedUris` (**required**; strings as prefixes, RegExps, or functions)
  * `lockfileLocation` (default `<context>/webpack.lock`, or `<name>.webpack.lock` for named compilers)
  * `cacheLocation` (default `<lockfile>.data`, `false` disables it)
  * `frozen` (default = **production mode** when the object form is used)
  * `upgrade` (default false)
  * `proxy` (or `http_proxy` / `HTTP_PROXY`)
* **Hooks it uses:**
  * `normalModuleFactory.hooks.resolveForScheme.for("http"|"https")`: sets `resourceData.resource/path/query/fragment` and `context = dirname(resolved)`, plus **`resourceData.data.mimetype = contentType`** so `module.rules` can match on `mimetype`.
  * `resolveInScheme.for(scheme)`: relative URLs inside remote modules.
  * `NormalModule.getCompilationHooks(c).readResourceForScheme.for(scheme)`: returns content and stores `buildInfo.resourceIntegrity`.
  * `hooks.needBuild`: rebuilds when the integrity changes.
  * `compilation.hooks.finishModules`: writes lockfile updates atomically through a temp file.
* **Lockfile:**
  * `{ "version": 1, "<url>": { "resolved": "<final url>", "integrity": "sha512-…", "contentType": "…" } | "no-cache" | "ignore" }`.
  * Parsing tolerates git merge-conflict markers by taking the union of both sides.
  * Clear errors: "outdated lockfile entry, but lockfile is frozen", "missing content in the lockfile cache", "has content now, upgrading not enabled".
* **Cache and network:**
  * Content-addressed cache files `webpack.lock.data/<origin>/<path>_<query>_<sha512-20>.<ext>`.
  * Honors HTTP `Cache-Control` (`no-cache` → not stored; `max-age` → `validUntil`; `must-revalidate`) and **ETag** (`If-None-Match`).
  * Follows redirects, **re-validating each hop against `allowedUris`**.
  * Detects CRLF corruption and suggests `.gitattributes: **/*webpack.lock.data/** -text`.
* **Rspack** implements the same option natively (`crates/rspack_plugin_schemes/src/http_uri/`) **since Rspack 1.3** (blog "announcing-1-3").
  Rspack #14086 keeps buildHttp imports bundled for the node target. #15609 (merged 2026-09-11) enforces lockfile integrity when frozen and defaults `frozen: true` in production.
  `@rspack/browser`'s `BrowserHttpImportEsmPlugin` rewrites bare imports to esm.sh URLs and pairs them with buildHttp.
* **Lessons for unplugin-deno:**
  * The lockfile, frozen, upgrade and allow-list UX is excellent, but Deno already has `deno.lock` (with `remote` integrity hashes for https modules, plus jsr and npm integrity).
  * Unplugin-deno should **reuse `deno.lock` through `@deno/loader`** and not invent a new lockfile. It should expose webpack-like `frozen` and `allowedUris`-style policies (Deno has `--allow-import` host allow-lists, and `lock.frozen` in deno.json).
  * The `resolveForScheme` / `readResourceForScheme` / `needBuild` / mimetype-rule pattern is the **native way to add `jsr:`/`npm:`/`https:` schemes to webpack**.

---

## 8. Rolldown: PR #1762 and the current Deno surface

### 8.1 PR #1762: "chore(example): `deno_bundle` in rolldown"
* https://github.com/rolldown/rolldown/pull/1762, by Yunfei He (@hyfdev/hyf0, core team). Opened 2024-07-27, **closed unmerged 2024-09-03**, no review comments (only bots).
  +703/−0, almost all of it `Cargo.lock`. Adds `reqwest` and `url` dev-deps.
* Content: `crates/rolldown/examples/deno_bundle.rs` (90 lines), a native Rust `HttpImportPlugin`:
  * `resolve_id`: if the importer starts with `http`, returns `Url::parse(importer).join(specifier)`. An `http…` entry is returned as-is.
  * `load`: `reqwest::get(id).text()` → `HookLoadOutput { code, module_type: Some(ModuleType::Ts) }`, which **assumes TS for everything**.
  * It bundled `https://deno.land/std@0.224.0/text/mod.ts` into `text.bundle.js` with a sourcemap. The regions are named by URL. There's no caching, lock, integrity, auth, `jsr:`/`npm:` or import map.
* Linked: **#1768 "Support http-import by default"** (hyfdev) was closed **NOT_PLANNED** on 2024-09-12.
  hyf0 linked https://deno.com/blog/http-imports as "a nice explanation on why we shouldn't enable http-import by default. It's not a recommended pattern."
  In the thread, @7086cmd prototyped a native `rolldown_plugin_http_resolve` (fork branch `7086cmd/rolldown@feat/http-resolve`), and @ikkz noted it would need caching and cleanup.
* **Status today:** the feature doesn't exist in rolldown. **[verified]** Rolldown 1.2.11 **treats `https://…` imports as external by default, silently**.
  `jsr:` and `npm:` produce `UNRESOLVED_IMPORT` warnings ("Module not found, treating it as an external dependency") and stay external.
  `node:*` and bare builtins are external without warnings on `platform: "node"`, and **with** warnings on `browser`/`neutral`.

### 8.2 Other Rolldown Deno history
* **PR #3124 "feat(plugin/deno-loader): add draft"** (@nestarz, 2024-12-11 → closed stale 2025-05-29):
  * A native `builtin:deno-loader` in `crates/rolldown_plugin_deno_loader/` with options `entryPoints`, `importMap` (JSON string) and `importMapBaseUrl`.
  * It used the `import_map` crate (`expand_imports: true`).
  * It shelled out to `deno info --no-config --import-map data:application/json,<json> --json <spec>` (the **import map passed as a data: URI** is a neat trick) and cached the results.
  * `npm:` was stripped and re-resolved with `ctx.resolve(..., skip_self)`.
  * JSON became `export default <json>`.
  * It shipped as the fork `@rolldown-deno-fork/rolldown`.
  * hyf0: builtin plugins increase the binary size, so issues should come first; "As for deno, we are still investigating how to work with deno in a best way."
* **Issue #3172 "Native Deno Loader Plugin Integration"** (open, `stale`):
  * hi-ogawa suggested porting deno-vite-plugin to a rolldown plugin "using `resolveId: { filter }` for rolldown specific optimization".
  * qupig pointed to `denoland/deno-rolldown-plugin`.
  * The only upstream API ask mentioned was denoland/deno#23929.
* #8326 "Errors thrown by plugins not properly caught" (a panic from the Deno plugin) was closed NOT_PLANNED. #6561 "N-API error: GenericFailure, channel closed" happened under Deno and was also not planned.
* Rolldown code mentioning Deno:
  * `crates/rolldown_std_utils/src/path_ext.rs` names chunks from the **parent directory for `index` *and* `mod`** files, following the Deno style guide.
  * `stabilize_id` tests keep `https://deno.land/x/oak/mod.ts` ids verbatim.
  * The CLI `--configLoader native` works on Deno and Bun.

### 8.3 Rolldown 1.2.11 plugin and option surface relevant to Deno (from `dist/shared/define-config-*.d.mts`)
* **`platform`:** `"node" | "browser" | "neutral"` only. **There is no `deno`.** Defaults are `node` for cjs format and `browser` otherwise.
* **`resolve`:** `alias`, `aliasFields`, `conditionNames` (defaults: node → `["import","node","default"]`, browser → `["import","browser","default"]`, neutral → `["import","default"]`), `extensionAlias`, `exportsFields`, `extensions` (`.tsx,.ts,.jsx,.js,.json`), `mainFields`, `mainFiles`, `modules`, `symlinks`.
  There's no `resolve.builtins`. Add the `deno` condition yourself.
* **Hook filters** (`resolveId/load/transform: { filter, handler }`):
  * `resolveId.filter.id` accepts **RegExp only**.
  * `load` takes `id`. `transform` takes `id`, `moduleType` and `code`.
  * `renderChunk` takes `code`.
  * Composable filters from `rolldown/filter` (`@rolldown/pluginutils`): `and`, `or`, `not`, `id`, **`importerId`**, `moduleType`, `code`, `query`, `include`, `exclude`, `exactRegex`, `prefixRegex`, `makeIdFiltersToMatchWithQuery`.
  * **`importerId`** lets a resolveId filter also catch *relative* imports whose importer is a remote or jsr module: `include(or(id(/^(jsr|npm|https?|node):/), importerId(/^(https?|jsr|npm):/)))`.
* **`resolveId` args:** `(source, importer, { kind, isEntry, custom })`. `kind` is one of `import-statement | dynamic-import | require-call | import-rule | url-token | new-url | hot-accept`.
  It returns `string | false | null | { id, external: boolean|"absolute"|"relative", moduleSideEffects, meta, invalidate?, packageJsonPath? }`.
  **Import attributes are not passed.** Issue **#2758 "Support import attributes properly"** is open, as is **#6410** (import bytes).
* **`load` result:** `{ code, map, moduleType, moduleSideEffects, meta }`. `ModuleType = "js"|"jsx"|"ts"|"tsx"|"json"|"text"|"base64"|"dataurl"|"binary"|"empty"|(string & {})`. This is what Deno `MediaType` should map to, instead of fake extensions.
* **Plugin context:** `this.fs` (RolldownFsModule), `emitFile`, `addWatchFile`, `getModuleInfo`, `resolve`, `load`, and `meta.watchMode`.
* **`moduleTypes`** (an esbuild-style extension → type map), `transform` (oxc: `jsx` `false|"react"|"react-jsx"|"preserve"|JsxOptions`, `define`, `inject`, `dropLabels`, decorators, and more), top-level **`tsconfig: boolean | string`** (default `true`, auto-discovered), `checks` (for example `unresolvedImport`, `emptyImportMeta`, `pluginTimings`, `unsupportedTsconfigOption`; handy for silencing warnings for intentionally external `jsr:`/`npm:` imports), `output.legalComments: "none"|"inline"`, and `makeAbsoluteExternalsRelative`.
* **`experimental`:** `resolveNewUrlToAsset`, `chunkImportMap` (emits an import map of hashed chunks), `incrementalBuild`, `nativeMagicString`, `chunkOptimization`, `lazyBarrel`, `attachDebugInfo`, `chunkModulesOrder`, `devMode`, `viteMode`.
* **`rolldown/experimental` exports:** `ResolverFactory` (oxc-resolver), `TsconfigCache` and `resolveTsconfig`, `transform`/`transformSync` (oxc), `isolatedDeclaration(Plugin)`, `minify`, `parse`, `scan`, `memfs`, `viteResolvePlugin`, `viteAliasPlugin`, `viteJsonPlugin`, `viteTransformPlugin`, `bundleAnalyzerPlugin`, `defineParallelPlugin`, `dev`, `DevEngine`.
  `rolldown/plugins`: `esmExternalRequirePlugin`, `replacePlugin`.
  Native Rust plugins **cannot** be added by third parties. Maintainers have declined a built-in Deno plugin.
* **Deno-relevant defaults [verified]:**
  * `import.meta.main`, `url` and `dirname` are left untouched in ESM output.
  * A local `package.json` `"type":"commonjs"` made rolldown wrap an ESM `.ts` entry in `__commonJSMin`. That's a pitfall to avoid when mixing in `package.json`.

### 8.4 tsdown (rolldown-based library bundler)
* https://github.com/rolldown/tsdown (4.3k★), v0.23.0. `platform?: 'node' | 'neutral' | 'browser'`. The docs say `node` covers "Node.js and compatible runtimes (e.g., Deno, Bun)".
* **`nodeProtocol: true | 'strip'`** (`src/features/node-protocol.ts`): a rolldown `resolveId` with `order: 'pre'` and a builtin-name RegExp filter, returning `{ id: 'node:fs', external: true, moduleSideEffects: false }`. This is good prior art for "prefix `node:` for Deno output".
* Deno issues: **#707 "Cannot use tsdown with Deno"** (`node:util` `parseEnv` missing, closed). Nothing about JSR publishing or `deno.json`. `exe` (Node SEA) is "not supported in Bun or Deno".
  There is no Deno or JSR integration, which is an opportunity: a companion could generate `jsr.json` or `deno.json` `exports` from tsdown's `exports`.

---

## 9. Rspack / Rsbuild API for a Deno resolver (rspack 2.2.7)

### 9.1 Hooks (source `packages/rspack/src/NormalModuleFactory.ts`, docs `website/docs/en/api/plugin-api/normal-module-factory-hooks.mdx`)
* `normalModuleFactory.hooks`:
  * `beforeResolve` (AsyncSeriesBail; return `false` to ignore)
  * `factorize` ("returning module instance is not supported")
  * `resolve` ("returning module instance or `false` is not supported")
  * `afterResolve`
  * `createModule`
  * `resolveForScheme` (HookMap, `[resourceData]`, with "TODO: second param resolveData")
* **`ResolveData.attributes`** (import attributes) since **2.2.3** is available in beforeResolve, factorize, resolve and afterResolve. **[verified]** `{"type":"text"}`.
* `NormalModule.getCompilationHooks(compilation)` returns `{ loader, readResource: HookMap<AsyncSeriesBail<[LoaderContext], string|Buffer>> }`.
  `readResourceForScheme` was removed in 2.0 (migration guide).
  **[verified] JS taps on `readResource.for("jsr")` are never invoked.** The dist has no `register…ReadResource…Taps` binding, and the build fails with `Reading from "jsr:@std/path@1" is not handled by plugins (Unhandled scheme)`.
* **Resolver:** Rust (`rspack_resolver`, derived from oxc-resolver). **`resolve.plugins` doesn't exist.** JS can't hook resolution steps; it can only rewrite requests in NMF hooks or use `resolve.alias`, `resolve.byDependency`, `resolve.tsConfig`, `resolve.extensionAlias`, `resolve.conditionNames` and `resolve.restrictions`.
  `experiments.useInputFileSystem: RegExp[]` routes selected paths through the JS `inputFileSystem`.
  `compiler.rspack.experiments.VirtualModulesPlugin` is native (≥ 1.5).
* **Working recipe [verified]** (`$SCRATCH/sandbox/wp/up/run-rspack-scheme3.mjs`):
  ```js
  const vfs = new rspack.experiments.VirtualModulesPlugin({ [vpath]: code }); vfs.apply(compiler);
  compiler.hooks.thisCompilation.tap(N, (c, { normalModuleFactory }) =>
    normalModuleFactory.hooks.resolveForScheme.for("jsr").tapPromise(N, async rd => {
      rd.resource = rd.path = vpath /* e.g. <ctx>/node_modules/.deno/jsr/@std/path/1.0.8/mod.ts */; return true; }));
  // + rule { test: /\.ts$/, loader: "builtin:swc-loader", options: { jsc: { parser: { syntax: "typescript" } } }, type: "javascript/auto" }
  ```
  This bundled `export const a: number = 42` as `var a = 42`. The `module.rules[].with: { type: "text" }` rule with `type: "asset/source"` also worked for import attributes.
  **Idea:** mirror the whole Deno module graph into a deterministic virtual tree, like `deno vendor` (`.deno/jsr.io/@std/path/1.1.6/join.ts`, `.deno/esm.sh/...`), so relative imports inside remote modules resolve natively with no per-import JS round-trips.
* **Scheme externals:** rspack's `externalsPresets.web` uses `HttpExternalsRspackPlugin`, which externalizes only `http(s)://` and `//`, not `jsr:`/`npm:`. That differs from webpack ≥ 5.102.
  There's no `deno` target in rspack; `lib/config/target.ts` has none.
* **`builtin:swc-loader`** TS/TSX: `jsc.parser: { syntax: "typescript", tsx: true, decorators }`, `jsc.transform.react: { runtime: "automatic", importSource, pragma, pragmaFrag, development, refresh }`.
  unplugin-deno can translate `deno.json` `compilerOptions.jsx`, `jsxImportSource`, `jsxFactory` and `jsxFragmentFactory` into these. Alternatively, `@deno/loader` transpiles before the loader runs.
* **`experiments.buildHttp`** is supported (see §7). `experiments.rspackFuture` is gone in 2.x.
  The 2.x Experiments are `asyncWebAssembly, css (deprecated), futureDefaults, newCache, buildHttp, useInputFileSystem, nativeWatcher, deferImport, sourceImport, pureFunctions, runtimeMode`.

---

## 10. unplugin's webpack / rspack adapters (unplugin 3.4.0, `$SCRATCH/repos/unplugin`)

### 10.1 How the hooks map
* **webpack `resolveId`** (`src/webpack/index.ts`):
  * An **enhanced-resolve plugin** pushed to `compiler.options.resolve.plugins`. It taps `resolver.getHook('resolve')` and calls `resolver.doResolve(target, {...request, request: resolved})`.
  * `importer` comes from `request.context.issuer`, and `isEntry = issuer === ''`. **No `kind` or `attributes`.**
  * If `fs.existsSync(resolved)` is false, the id becomes a virtual module: `<context>/_virtual_/<encodeURIComponent(id)>` is written empty into `webpack-virtual-modules`, and the loader decodes it later.
* **rspack `resolveId`** (`src/rspack/index.ts`):
  * Taps **`normalModuleFactory.hooks.resolve`** and sets `resolveData.request`.
  * Virtual paths are `<context>/node_modules/.virtual/<encodeURIComponent(id)>`, using `rspack.experiments.VirtualModulesPlugin` on ≥ 1.5, otherwise `FakeVirtualModulesPlugin`, which writes real empty files and deletes them on exit or `shutdown`.
* **`load`:** a `module.rules.unshift({ include: id => filter…, enforce, use: [LOAD_LOADER], type: 'javascript/auto' })`. The loader decodes the virtual id and calls `load(id)`, then `callback(null, res.code, res.map ?? map)`.
  **The module type is forced to `javascript/auto`, and there's no `moduleType`.** JSON must be returned as JS, and TS must be transpiled unless another `.ts` rule matches the (encoded) path.
* **`transform`:** a `module.rules.unshift({ enforce, use: data => transformUse(...) })`. The filter runs on `resource + resourceQuery`. A code filter can only be checked inside the loader.
* **`buildStart`/`watchChange`** run in `compiler.hooks.make`. `buildEnd` runs in `emit`. `writeBundle` runs in `afterEmit` with no arguments.
* **Escape hatches:** `webpack(compiler)`, `rspack(compiler)`, `rolldown: Partial<RolldownPlugin>` (merged over the generic hooks), and `rollup`, `vite`, `esbuild` and `bun` sections. `meta.framework` identifies the bundler.
* **Rolldown and rollup:** `toRollupPlugin` passes hooks straight through. Rolldown always uses native filters. Rollup uses native filters when the version supports them, and emulates them otherwise.
  So `kind`, `custom` and `moduleType` returned from `load` **do work at runtime on rolldown** even though unplugin's `HookFnMap` types omit them. The typed signature is `resolveId(id, importer, { isEntry })` and `load` returns `{ code, map }`.

### 10.2 Empirical probe [verified] (`$SCRATCH/sandbox/wp/up/{plugin.mjs,run-webpack*.mjs,run-rspack.mjs}`)
Entry imports `jsr:@std/path@1`, `npm:chalk@5`, `https://example.com/x.ts`, `node:fs` and a virtual id. The probe plugin's `resolveId` returns ids for `jsr:`/`npm:`/`https:` and `{ id: 'node:fs', external: true }` for `node:fs`.

| Bundler / config | `resolveId` saw | Result |
|---|---|---|
| webpack 5.111 `target:"web"` | only `./entry.js` and `virtual-thing` | `jsr:`, `npm:` and `https:` → **external** (web preset); `node:fs` → **UnhandledSchemeError** |
| webpack `target:"deno"` | same | all four external (the deno preset) |
| webpack `target:"web"`, `externalsPresets.web:false` | same | all four → `UnhandledSchemeError: Reading from "jsr:…" is not handled by plugins`. **The load hook never runs**, because scheme reading fails before loaders |
| rspack 2.2.7 `target:"web"` | `node:fs`, `npm:`, `jsr:` (not `https:`, which the web preset externalizes) | virtual modules `node_modules/.virtual/jsr%3A%40std%2Fpath%401` and so on; **`node:fs` became a 1-byte empty module although `external: true` was returned** |
| rspack with `externalsPresets.web:false` | all, including `https:` | all virtual; `load` called for each |

**Why:** webpack's `NormalModuleFactory` resolve step sends any request with a scheme (`getScheme()` → `jsr`, `npm`, `node`, `https`) to `hooks.resolveForScheme`. It never calls enhanced-resolve, so resolver plugins never see these requests. Externals (`ExternalModuleFactoryPlugin`, which taps `factorize`) match on **`dependency.request`**. **[verified]** Rewriting `resolveData.request` in `beforeResolve` does *not* prevent externalization.

### 10.3 Known unplugin issues that matter here
* **#238 (open, 2022) "Runtime externals don't work in webpack":** `external: true` produces an empty virtual module.
* **#483 (open)** "rspack/webpack virtual modules can't do relative import": relative imports resolve against `node_modules/.virtual/`. **This is fatal for remote modules** unless the plugin resolves every relative import itself, which it can because the importer is decoded, or unless it mirrors URL structure.
* **#618 (open)** webpack: ENOENT on cached virtual modules when `resolveId` is skipped under the filesystem cache (Next.js). Fix PR #617.
* **#421 (open)** Windows: a `/` prefix on virtual ids gets mangled.
* **#616 (open)** webpack/rspack: transform sourcemaps are dropped or not composed.
* **#524 (open)** binary files are treated as text (relevant to Wasm and `bytes` imports).
* #554 (closed) `addWatchFile` with rspack virtual ids. #503 (closed) rspack concurrency when resolving the same virtual module. #537 (closed) `.virtual` folder deletion racing with parallel compilers.

### 10.4 Working webpack recipe (for the escape hatch) [verified] (`$SCRATCH/sandbox/wp/up/run-webpack-scheme2.mjs`)
```js
apply(compiler) {
  // plugins run BEFORE applyWebpackOptionsDefaults(), so this opt-out sticks:
  compiler.options.externalsPresets = { ...compiler.options.externalsPresets, web: false, deno: false };
  new webpack.ExternalsPlugin("module-import", ({request}, cb) => request?.startsWith("node:") ? cb(null, request) : cb()).apply(compiler);
  compiler.hooks.thisCompilation.tap(N, (c, { normalModuleFactory }) => {
    normalModuleFactory.hooks.resolveForScheme.for("jsr").tap(N, rd => { /* set rd.resource/path/context, rd.data.mimetype */ return true; });
    webpack.NormalModule.getCompilationHooks(c).readResourceForScheme.for("jsr").tap(N, resource => Buffer.from(code));
  });
}
```
The content was served correctly. Setting `mimetype: "text/typescript"` did **not** trigger webpack's built-in TS stripping (the parse failed on `: number`), so serve **pre-transpiled JS**, which `@deno/loader` produces by default, or use a `.ts` virtual path.
The alternative is to rewrite every Deno specifier to an absolute path in a virtual tree during `beforeResolve`. That's unplugin's approach, but applied before externals, and it requires mutating `dependency.request` or disabling the presets.

---

## 11. Implications and recommendations for unplugin-deno (Rolldown/Rollup/Rspack/webpack)

**Core engine**
* Use **`@deno/loader` ≥ 0.5** (Node, Deno and Bun capable; `sourceMap` in the load response; `newestDependencyDate`).
* Create one `Workspace` and `Loader` per compiler and **reuse it across watch rebuilds**. Dispose it on `closeBundle`, `shutdown` or `watchClose`.
* Call `addEntrypoints` in `buildStart`, then use **`resolveSync`**. Fall back to async `resolve` only for specifiers not in the graph, such as dynamic ones.
* Don't shell out to `deno info` for each specifier the way rspack-deno-plugin and PR #3124 do.

**Resolution rules to get right**
* **Map the bundler's `platform` and conditions to the loader:** rolldown `platform: browser`, webpack `target: web`, rspack `target: web` → `platform: "browser"`. Always include the `deno` condition, and remember webpack's deno target also includes `browser`.
* **Return `null` from `resolveId`** for anything the loader can't resolve. Rolldown then produces proper `UNRESOLVED_IMPORT` diagnostics, and other plugins' virtual ids keep working (fixes #14, and the pitfall of lulu's `load` claiming every id).
  Use `this.error` with the loader's `ResolveError.code` and `specifier`.
* **Use filters:**
  * rolldown `resolveId.filter` should combine `id(/^(jsr|npm|node|https?|data):/)`, `importerId(/^(https?|jsr|npm):/)`, and bare specifiers from the import map. Precompute a RegExp from the `deno.json` `imports` keys.
  * `load.filter.id` should match the plugin's own id namespace.
* **Keep `resolveId` and `load` separate:** resolve in `resolveId` and load in `load`.
* **Stop inventing fake extensions:**
  * Rolldown: return `moduleType` mapped from `MediaType`.
  * webpack/rspack: use virtual paths that keep the real extension, mirroring the URL layout (`.deno/<host>/<path>`) so relative imports resolve natively, and set `resourceData.data.mimetype`.
* **Import attributes:**
  * Rspack exposes `ResolveData.attributes` (≥ 2.2.3), and webpack does too; both also support `module.rules[].with` conditions. Rollup 4 passes `attributes` to `resolveId` and `this.resolve`, and exposes `moduleInfo.attributes`.
  * **Rolldown does not** (#2758 is open). Map `RequestedModuleType.Json/Text/Bytes` where possible. On rolldown, rewrite `with {type:"text"|"bytes"}` into a query suffix in a `transform` pre-pass, or wait for #2758.
* **Handle `import.meta.main`:** replace it with `false` in non-entry modules (fix for rolldown plugin #15). webpack already does this natively.
* **Output-side Deno target helpers**, as an option for rolldown and rollup:
  * Prefix bare builtins with `node:` (tsdown `nodeProtocol`, webpack `nodePrefixForCoreModules`).
  * Optionally **rewrite externals to pinned Deno specifiers** (PR #13 idea). Do it in `resolveId` by returning `{ id: "npm:chalk@5.6.2", external: true }`, not with renderChunk regexes.
  * Keep `jsr:`/`npm:`/`https:` external when the target is Deno and the user wants a "thin" bundle, mirroring webpack's deno target and `externalsPresets.deno`.
* **Watch mode:**
  * `addWatchFile(deno.json, deno.lock, workspace member configs)` and rebuild the loader when they change.
  * `DENO_DIR` and npm cache files are immutable, so skip watching them.
  * Invalidate `file:` modules normally.
* **Reproducibility:**
  * Strip `DENO_DIR` or cwd from ids and `//#region` names (#6/#11).
  * Log the resolved config, lock and workspace in debug mode (#12).
  * Offer `frozen`, which is Deno's `lock.frozen`, and a `cachedOnly` mode, but document that `nodeModulesDir: "auto"` plus `deno task` auto-install interacts with it (#7).
* **Security and policy:** borrow buildHttp's `allowedUris` (Deno equivalent: `--allow-import` hosts) and its clear frozen and upgrade error messages. Reuse `deno.lock` remote integrity; don't add a new lockfile.

**webpack and rspack specifics** (unplugin's generic hooks are not enough)
* **webpack:**
  * Use the `webpack(compiler)` hook to set `externalsPresets.web/deno = false` before defaults are applied. Re-add a `node:` / builtin external with prefixing, plus optional "keep `jsr:`/`npm:` external".
  * Tap `resolveForScheme.for("jsr"|"npm"|"http"|"https"|"data"?)` together with `resolveInScheme`, and `readResourceForScheme.for(...)`.
  * Or rewrite in `beforeResolve` to virtual absolute paths.
  * Serve transpiled JS plus source maps.
  * Provide `needBuild` or `buildInfo` integrity so the persistent cache works (see unplugin #618).
* **rspack:**
  * Tap `resolveForScheme`, or unplugin's `resolve` hook path, and point `resourceData` at `rspack.experiments.VirtualModulesPlugin` paths (a mirrored URL tree).
  * **Don't rely on `readResource.for(scheme)`**, because JS taps are never invoked.
  * Register a native `externals` entry for `node:` and for any intentionally external Deno specifiers.
  * Add `builtin:swc-loader` rules for virtual `.ts`/`.tsx` paths, or serve transpiled JS from `@deno/loader`.
* **npm packages:** prefer the loader's resolution to real files, either in the global npm cache or `node_modules`, so the bundler parses real files, handles CJS interop natively, and relative requires work.
  Don't strip `npm:` versions with regexes (rspack-deno-plugin bug) or require `nodeModulesDir`.
* **Avoid writing into `DENO_DIR`** (rspack-deno-plugin copies JSON and CSS there). Never read `DENO_DIR` remote cache files directly without stripping Deno 2's trailing `// denoCacheMetadata=` line; better, use the loader's `load()`.

**Most-requested features and bugs across these projects**
* npm subpath exports and CJS interop (#8)
* readable errors instead of panics (#14, rolldown #8326)
* `import.meta.main` semantics (#15)
* debug output showing the resolved config and lock (#12)
* workspace support (rspack-deno-plugin #1)
* running under Node, not just Deno (README of the official plugin, sys_traits #4)
* JSON and extension-less remote files (rspack #8696 test matrix)
* externals rewritten to Deno specifiers (PR #13)
* native, faster Deno resolution in rolldown (rolldown #3172, PR #3124)
* no http-import by default (rolldown #1768 — maintainers consider it an anti-pattern, so make remote imports opt-in or clearly controlled)

---

## 12. Comparison table

| | @deno/rolldown-plugin | @lulu/deno-rolldown-plugin | rollup-plugin-deno (egoist) | deno-rollup / deno-resolver (cmorten) | rspack-deno-plugin / @snowman | webpack `target:"deno"` | webpack/rspack `buildHttp` |
|---|---|---|---|---|---|---|---|
| Registry / latest | JSR 0.0.10 (2025-07-31) | JSR 0.1.1 (2025-06-21) | npm 1.0.1 (2021-03) | deno.land/x drollup 2.58.0+0.20.0 (2021-10, archived 2022) | npm+JSR 1.0.7 (2025-10-18) | built-in, webpack ≥ 5.108.0 (2026-06) | built-in (webpack ≥ 5.49.0, 2021-08; rspack ≥ 1.3) |
| Stars / activity | 31★, dormant; 2 PRs unreviewed | 1★, dormant | n/a, dead | 72★, archived | 11★, low | active (Akait) | active |
| Bundlers | rolldown (and rollup, in theory) | rolldown | rollup 2 | Rollup 2 (Deno port) | rspack, rsbuild | webpack | webpack, rspack |
| Runtime needed | **Deno** (loader ^0.3) | **Deno** | Node | Deno (old APIs) | **Deno** | any | any |
| Engine | `@deno/loader` (Wasm deno_graph/resolver/npm) | `@deno/loader@0.1` | none | own fetch + `Deno.emit` | `deno info --json` + node_modules | none (externals) | own HTTP client + lockfile |
| Hooks | `buildStart`, `resolveId` (resolve+load), `load` | `buildStart`, `resolveId`, `load` | `resolveId`, `renderChunk` | `resolveId`, `load` | `beforeRun/watchRun` (push rules), NMF `beforeResolve` | `ExternalsPlugin` (factorize) | NMF `resolveForScheme`/`resolveInScheme`, `readResourceForScheme`, `needBuild`, `finishModules` |
| Filters / order | none | none | none | none | n/a | n/a | n/a |
| deno.json / import map | yes (discovered, workspaces) | yes | no | importmap plugin (imports + scopes) | top-level `imports` of cwd only, workspaces (1.0.5+) | no | no |
| deno.lock | yes | yes | no | no | via `deno info` (sort of) | no | own `webpack.lock` |
| `jsr:` | bundled | bundled | no | no | bundled via DENO_DIR files | **external** | no |
| `npm:` | bundled (weak CJS interop, #8) | bundled | no | no | node_modules only (regex bugs) | **external** | no |
| `https:` | bundled | bundled | no | bundled (fetch) | bundled via DENO_DIR | **external** | **bundled** (allow-list + lock) |
| `node:` | external (bare not prefixed) | external via `isBuiltin` (bare kept) | → std/node polyfill URLs | n/a | left to rspack | external, **bare → `node:` prefixed** | n/a |
| TS/JSX | loader transpile (plus fake ext) | loader + `moduleType` | no | `Deno.emit` | `builtin:swc-loader` (all remote as TS) | webpack built-in TS (Node ≥ 22.6) | via rules/mimetype |
| Import attributes | ignored | ignored | no | no | no (rspack now exposes `attributes`) | webpack supports `with` rules | n/a |
| Sourcemaps | lost | lost | n/a | n/a | swc | yes | yes |
| Watch / caching | new loader per build, no config watch | same | n/a | deno.land/x/cache | duplicate rules per `watchRun` | n/a | lockfile cache + ETag/Cache-Control |
| Integrity | deno.lock | deno.lock | no | no | Deno's | n/a | sha512 lockfile, `frozen` |
| `import.meta.main` | kept everywhere (#15) | kept | n/a | n/a | n/a | **entry-module check** | n/a |
| Tests / CI | 1 unit test; fmt/lint/test on canary | check/lint/fmt only | jest (not in tarball) | extensive Deno tests | e2e build-only | webpack suite (configCases/deno) | webpack suite |

---

## 13. Clone and artifact paths
* Clones (shallow):
  * `$SCRATCH/repos/deno-rolldown-plugin` (denoland/deno-rolldown-plugin)
  * `$SCRATCH/repos/lulu-deno-rolldown-plugin` (luludotdev/deno-rolldown-plugin)
  * `$SCRATCH/repos/cmorten-deno-rollup` (cmorten/deno-rollup, drollup and rollup-plugin-deno-resolver)
  * `$SCRATCH/repos/rspack-deno-plugin` (LonelySnowman/rspack-deno-plugin)
  * `$SCRATCH/repos/unplugin` and `$SCRATCH/repos/deno-js-loader` (already present, read-only)
* Tarballs:
  * `$SCRATCH/tarballs/rollup-plugin-deno-1.0.1/package`
  * `$SCRATCH/tarballs/rspack-deno-plugin-1.0.7/package`
  * `$SCRATCH/tarballs/rolldown-1.2.11/package` (type definitions: `dist/shared/define-config-*.d.mts`, `dist/filter-index.d.mts`)
* JSR source: `$SCRATCH/jsr/deno-loader-0.3.0/mod.ts` (the `@deno/loader` API version the official plugin uses)
* Notes:
  * `$SCRATCH/notes/webpack/pr21247.diff`, plus `lib_deno_DenoTargetPlugin.js`, `lib_config_target.js`, `lib_config_defaults.js` and `lib_schemes_HttpUriPlugin.js` from webpack main
  * `$SCRATCH/notes/rolldown/pr1762.diff` and `pr3124.diff`, plus rolldown source files mentioning Deno
  * `$SCRATCH/notes/rspack/*.ts` and `*.mdx` (rspack main: NormalModule, NormalModuleFactory, types, defaults, target, rspackOptionsApply, docs)
  * `$SCRATCH/notes/tsdown/`
* Experiments:
  * `$SCRATCH/sandbox/wp`: webpack 5.111.1, @rspack/core 2.2.7 and unplugin 3.4.0.
    * `defaults.cjs` prints the deno target defaults.
    * `build.cjs` builds a deno-target sample into `dist-deno/`.
    * `up/`: unplugin probe (`plugin.mjs`, `run-webpack.mjs`, `run-webpack2.mjs`, `run-rspack.mjs`) and scheme recipes (`run-webpack-scheme*.mjs`, `run-rspack-scheme*.mjs`).
  * `$SCRATCH/sandbox/rd`: rolldown 1.2.11 default handling of Deno specifiers (`build.mjs`).
  * `$SCRATCH/sandbox/drp`: `@deno/rolldown-plugin@0.0.10` plus rolldown 1.2.11 under Deno 2.9.7 (`build.ts`).
