# unplugin-deno — feature plan

Status: **draft for review** (2026-09-25). Nothing is implemented yet. This plan is derived from the research reports in
[`docs/research/`](docs/research/) (about 5,100 lines, written by six parallel research passes over 30+ prior-art
packages, the bundlers' current APIs, Deno 2.5–2.9 release notes, framework integrations, and ~1,500 issues).

| Report | Covers |
|---|---|
| [esbuild.md](docs/research/esbuild.md) | `@deno/esbuild-plugin`, `@luca/esbuild-deno-loader` (+ forks), `@oazmi`, `@ggpwnkthx`, `@miyauci/*`, esbuild plugin API |
| [vite.md](docs/research/vite.md) | `@deno/vite-plugin` (18 defects reproduced), `@deno-plc`, `@str4ngemd`, `@transitionsag`, `@lockness/vite`, older deno.land/x plugins, Vite 8 behaviour |
| [rolldown-rollup-rspack-webpack.md](docs/research/rolldown-rollup-rspack-webpack.md) | `@deno/rolldown-plugin`, `@lulu`, rollup plugins, `rspack-deno-plugin`, webpack `target: "deno"`, rolldown PR #1762, unplugin adapter limits |
| [multi-and-deno-tooling.md](docs/research/multi-and-deno-tooling.md) | `@deno/loader` full API + bugs, `@jeiea/unplugin-deno`, `unplugin-jsr`, `deno bundle` / `Deno.bundle()`, `deno info --json`, `deno.lock` v5, DENO_DIR, Deno 2.5–2.9 |
| [ecosystem.md](docs/research/ecosystem.md) | Verified latest versions and newest APIs of unplugin, Vite, Rolldown, Rollup, esbuild, Rspack, webpack, Farm, Bun, TypeScript; capability matrix; 26 experiments |
| [frameworks-and-demand.md](docs/research/frameworks-and-demand.md) (+ [A](docs/research/frameworks-A.md), [B](docs/research/frameworks-B.md)) | Fresh 2, Lume, Astro, SvelteKit, Nuxt, React Router, TanStack, Solid, Qwik, Hono, Deno Deploy; ranked pain points; wishlist; naming check |

---

## 1. Goal and positioning

**One plugin that gives every bundler Deno's module semantics, and is correct where the existing plugins are not.**

- Resolves `jsr:`, `npm:`, `https:`/`http:`, `node:`, `data:`, `file:`, bare specifiers via `deno.json` import maps
  and scopes, workspaces, `links`, `deno.lock`, `nodeModulesDir` modes, export conditions, `compilerOptions.jsx*`.
- Works on **Vite, Rolldown (and tsdown), Rollup, esbuild, webpack, Rspack/Rsbuild, Bun.build** (Farm best-effort),
  with one core and thin per-host adapters.
- Runs wherever the bundler runs: **Node, Deno, Bun**, on Linux/macOS/**Windows**. No Deno binary required by default
  (an installed Deno can optionally be used as an alternative engine).
- Is a **good citizen**: claims only ids it owns, never breaks other plugins' `virtual:`/`\0` ids, preserves `?raw`
  and friends, hands CSS/assets/local files back to the host.
- Ships the things nobody ships: a **Deno server-output mode** (pinned `npm:`/`jsr:` externals that run on
  `deno run`/Deno Deploy), **import attributes done right on every bundler**, **workspace-native** resolution,
  **diagnostics** (browser-safety, duplicates, lockfile), **env inlining**, a **Node `register` hook** so
  `vite.config.ts` can import `jsr:` under Node, and readable sourcemaps.

Naming: npm `unplugin-deno` is free (checked 2026-09-25). JSR: publish under your own scope (e.g.
`@brc-dd/unplugin-deno`); `@jeiea/unplugin-deno` (JSR, abandoned one-day project) is not a conflict. Avoid the `@deno/`
scope and logo; add "not affiliated with Deno Land Inc." to the README. Details: frameworks-and-demand.md §7.

Non-goals (v1): re-implementing a bundler; replacing `deno bundle`; type-checking; running npm lifecycle scripts
ourselves (we tell the user to run `deno install` or do it via the optional Deno CLI engine).

---

## 2. What the research says (the findings that shape the design)

1. **Every surviving plugin converged on `@deno/loader`** (Deno's Rust resolver/graph/npm-installer/transpiler as a
   5.5 MB wasm): `@deno/vite-plugin` 2.x, `@deno/esbuild-plugin`, `@deno/rolldown-plugin`, Fresh 2's internal plugin,
   Lume. Plugins that shell out to `deno info` per import are the source of the OOM (>8 GB), "10× slower" and
   "output format changed" complaints. (frameworks-and-demand.md §6, §8; vite.md; esbuild.md)
2. **`@deno/loader` runs on Node and Bun since 0.4.0 (2026-03)** and returns source maps since 0.5.0, but the official
   plugins pin 0.3 and are therefore Deno-only. It is JSR-only (`npm i` fails without an `.npmrc` for `@jsr`), stale
   against Deno 2.8/2.9 (`catalog:`, `jsrDepsInNodeModules`, 24 h min-dependency age, CSS imports), uses sync fs
   (blocks the event loop), keeps stale contents for edited local files, prints "Downloading…" on stderr, and has a
   `cachedOnly` bug. Its real API is small: `Workspace({noConfig,noLock,configPath,nodeConditions,
   newestDependencyDate,platform,cachedOnly,debug,preserveJsx,noTranspile})` → `Loader{addEntrypoints,resolveSync,
   resolve,load,getGraphUnstable}`. (multi-and-deno-tooling.md §1)
3. **Official plugins have correctness bugs users hit daily** (all reproduced): `npm:pkg@x/subpath` loses the
   subpath; `virtual:` and `\0` ids of other plugins crash the build; `node_modules` silently beats the import map;
   import attributes ignored (`with {type:"text"}` of a `.json` returns an object); `data:` imports fail; wrong
   `absWorkingDir`; workspace members outside the Vite root get no HMR; JSR modules never prebundle in dev
   (30 requests for `@std/path`). (vite.md; esbuild.md)
4. **Letting the host's own resolver handle npm packages matters**: `lodash-es` `chunk` bundles to 10.4 KB when
   esbuild resolves through a real `node_modules`, vs 321.9 KB when the plugin loads npm files itself (loses
   `sideEffects`/`browser`/conditions). (esbuild.md)
5. **unplugin's generic hooks are not enough for a resolver plugin** (unplugin 3.4.0, verified): on **webpack**
   `resolveId` never sees `jsr:`/`npm:`/`https:` (scheme requests bypass the resolver → `UnhandledSchemeError`);
   on **webpack/Rspack** `{external:true}` is silently ignored and virtual modules get a wrong importer; on
   **esbuild** every resolved id is forced into the plugin's namespace (real files then fail to load) and the default
   filter is `/.*/`. Working native recipes exist for each and are documented. (ecosystem.md §A.6, §K;
   rolldown-rollup-rspack-webpack.md)
6. **Vite 8 dev ≠ build**: dev import-analysis skips `https://` specifiers unless a `resolve.alias` matches; dev
   never transpiles TS for `\0` ids and ignores `moduleType`; optimizer/SSR-externalisation only recognise paths
   containing `node_modules` (so Deno's global cache is neither optimised nor externalised). (ecosystem.md §B.3)
7. **Rolldown (and thus Vite 8) does not pass import attributes to `resolveId` and dedupes `text`/`bytes` imports
   of the same id** (rolldown#2758, on their Q3 plan). Rollup, esbuild, webpack, Rspack do expose attributes.
   (ecosystem.md §0.2)
8. **webpack ≥5.102 `target:"web"` and 5.108's `target:"deno"` externalise `jsr:`/`npm:`/`https:` before any
   resolver runs**; `target:"deno"` also gives correct `import.meta.main` and the `deno` condition. Both webpack and
   Rspack externalise `http(s):` for web targets by default. (rolldown-rollup-rspack-webpack.md §5; ecosystem.md §G)
9. **Deno 2.8.3 added `deno info --json` → `npmPackages[*].localPath` explicitly for bundler plugins; Deno 2.9
   added `jsrDepsInNodeModules`** (installs `jsr:` deps into `node_modules/@jsr/…` with symlinks) and stable `links`;
   2.8 made `with {type:"text"}` stable (`bytes` still unstable) and implemented `node:module.registerHooks()`.
   Open PR denoland/deno#34345 moves `deno bundle` to Rolldown and adds a `Deno.bundle({plugins})` API.
   (multi-and-deno-tooling.md §6; ecosystem.md §I)
10. **SSR is half the product.** The largest pain cluster (~30 issues) is server builds: CJS/native npm packages
    break when bundled, and users cannot hand `npm:`/`jsr:` back to Deno to load at runtime. Deno Deploy runs builds
    through Deno-shimmed `node`/`npm` and runs apps with `--cached-only`, so externals must be static and pinned.
    (frameworks-and-demand.md §3, §8)
11. **Nobody supports `jsx: "precompile"` outside Deno** (Oxc/SWC/esbuild don't); `@deno/loader` and
    `deno transpile` do. All major bundlers run under Deno 2.9.7 (Rolldown needs `--allow-env --allow-read
    --allow-ffi`). (ecosystem.md §0.2, §J)
12. Verified versions (2026-09-25): unplugin 3.4.0 (ESM-only, Bun + Rsbuild support, RegExp-only `resolveId`
    filter), Vite 8.3.1 (Rolldown/Oxc default), Rolldown 1.2.11, tsdown 0.23.0, Rollup 4.63.5, esbuild 0.28.2,
    Rspack 2.2.7 / Rsbuild 2.2.9, webpack 5.111.1, Farm 1.7.11 (stale), TypeScript 7.0.2, Deno 2.9.7.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Host adapters (thin)  vite · rolldown/tsdown · rollup · esbuild · webpack ·  │
│                        rspack/rsbuild · bun · farm · (Deno.bundle later)      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Core plugin (unplugin factory)                                               │
│   ownership rules · id scheme · resolveId/load/transform · platform model ·  │
│   import-attribute rewriting · externals policy · diagnostics · watch        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Engine interface   resolve(spec, importer, {kind, attrs, conditions}) →      │
│                    {url, kind: local|npm|remote|node|external, path?, type}  │
│                    load(url, type) → {code, map, mediaType}                  │
│   engines: `loader` (vendored @deno/loader wasm, default) · `deno` (CLI:     │
│            deno info --json + localPath + DENO_DIR) · `lite` (later, no wasm)│
├──────────────────────────────────────────────────────────────────────────────┤
│ Config layer (pure TS, no wasm)  deno.json(c) discovery · workspace/members  │
│   · import map + scopes · links · nodeModulesDir detection · lockfile read · │
│   compilerOptions.jsx* · package.json interplay · file watching              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Ownership rules (what we claim, in order)

1. **Split the id**: `base` + `query` (`?raw`, `?url`, `?worker`, `?inline`, `?v=…`) + our own `?deno-type=` marker.
   Never touch ids starting with `\0` or `virtual:` unless the `\0deno:` prefix is ours. Re-append the query untouched.
2. **Prefixed specifiers** `jsr:` `npm:` `https:` `http:` `data:` `node:` `bun:` `cloudflare:` `file:` → ours.
3. **Bare specifiers that the importer's import map (deno.json `imports`/`scopes`, workspace member, `links`) maps**
   → ours, and we must run **before** the host's own resolver (Fresh's trick: `enforce: 'pre'`, then
   `this.resolve()` to let other *plugins* answer, but ignore answers produced by the host's built-in resolver so
   the import map beats a same-named `node_modules` package). Unmapped bare specifiers → not ours (host resolves).
4. **Relative imports whose importer is a remote/virtual module** (filter on `importerId`) → ours.
5. Everything else (CSS, assets, local relative imports, other plugins' ids) → untouched.

Hook filters are the first line of defence: `resolveId.filter.id` is a RegExp built from the prefixes **plus the
import-map keys of every workspace member**, so Rolldown/Vite 8/Rollup ≥4.40 skip the JS hook entirely for
unrelated ids (`@miyauci/esbuild-import-map`'s idea; ecosystem.md §K).

### 3.2 Id scheme and loading

| Resolved kind | What we return | Who loads it |
|---|---|---|
| Local file (`file:` in the graph, incl. workspace members) | absolute OS path | **the host** (native TS/JSX, HMR, watch, sourcemaps) |
| npm package, `node_modules` present | **redirect** to the host resolver: bare `pkg/subpath` resolved from the package directory (`this.resolve(bare, <pkgDir>/index, {skipSelf})`, esbuild `build.resolve({resolveDir})`, webpack/Rspack `context`) | the host (keeps `sideEffects`, `browser`, conditions, CJS interop, Vite prebundling) |
| npm package, no `node_modules` (`nodeModulesDir: "none"`) | absolute path inside `DENO_DIR/npm/registry.npmjs.org/<pkg>/<ver>/…`; imports *inside* those files resolve through the engine (importer filter) | the host loads the file; Vite gets an `optimizeDeps` entry + `server.fs.allow` |
| Remote (`https:`, `jsr:`-resolved URL) and `data:` | virtual id `\0deno:<final URL>` (Rollup/Rolldown/Vite), namespace `deno` (esbuild/Bun), virtual path mirroring the URL with a real extension (webpack/Rspack) | **us**, via `engine.load()`; code is already JS (loader transpiles TS/JSX per deno.json), `map` passed through with `sources = [url]` |
| `node:`, `bun:`, `cloudflare:`, `*.node` | `{ external: true }` (native externals config on webpack/Rspack, since unplugin drops the flag there) | – |
| npm/jsr in Deno server-output mode | `{ id: 'npm:pkg@<pinned>/subpath', external: true }` | Deno at runtime |

`moduleType`/loader mapping follows `deno bundle`'s table (multi-and-deno-tooling.md §4.3): JS/Mjs/Cjs/Mts → `js`,
TS → `ts`, Jsx/Tsx → `jsx`/`tsx`, Json → `json`, Jsonc/Json5/Markdown/Html/Sql → `text`, Wasm/Unknown → `binary`.
Since remote code arrives pre-transpiled, `moduleType` is mostly `js`; it matters for the Vite-dev limitation and for
`json`/`text`/`bytes`.

### 3.3 Engines

- **`loader` (default).** Vendored `@deno/loader` 0.5.x (MIT) — copied into the package (avoids the JSR-only install
  failure on npm/bun, lets us patch: route "Downloading…" into the host logger, fix `cachedOnly`, add retry/proxy,
  silence noise). Lazy-initialised only when a deno.json/lockfile/Deno specifier is present (15–35 ms instantiate).
  One `Workspace` per **platform** (browser vs node conditions), one `Loader` per environment; `addEntrypoints(inputs)`
  at `buildStart` so versions match Deno's; `resolveSync` in `resolveId`, async `resolve` only for specifiers outside
  the graph. Local files are **never** loaded through it (works around its stale-file bug). Recreate the Loader on
  `deno.json`/`deno.lock`/`package.json`/import-map changes (~12 ms).
- **`deno` (CLI engine, P1).** Uses the installed Deno: one batched `deno info --json` for the entry graph
  (`modules[*].local`, `npmPackages[*].localPath` (2.8.3+), `redirects`, `packages`), further batched calls for
  specifiers discovered later (never one subprocess per import, bounded concurrency, temp-file arg passing on Windows
  to avoid "os error 206"). Always matches the installed Deno's semantics (`catalog:`, `jsrDepsInNodeModules`,
  min-dependency-age). Can run `deno install` when the user opts in (lifecycle scripts). Auto-selected by
  `engine: 'auto'` when deno.json uses features the vendored loader lacks and a `deno` binary is on PATH.
- **`lite` (P3, optional).** No wasm: pure-TS import maps + `jsr.io` `meta.json`/`version_meta.json` + `https:` with
  `deno.lock` integrity + npm via `node_modules`. For constrained environments and browsers. Approximate by design;
  documented as such.

### 3.4 Platform / environment model

`platform: 'browser' | 'node' | 'deno' | 'neutral'`, auto-detected per environment:
Vite `this.environment.config.consumer` (`client` → browser; `server` → `deno` if the bundler process runs on Deno or
the user says so, else `node`), esbuild `initialOptions.platform`, Rolldown `platform`, webpack `compiler.platform` /
`target: 'deno'`, Rspack `target`. Drives: export conditions (`deno`, `node`, `browser`, `import`, `default`, plus
user `conditions`), `node:` externals, the `browser` field (`false` → empty module, like `deno bundle`), and the
externals policy for `npm:`/`jsr:` (bundle for browser; **external + pinned** for `deno`; host default for `node`).

### 3.5 Watch, caching, performance

In-process only. Graph cached per build session; hook filters keep the JS hooks off the hot path; DENO_DIR is the
disk cache (shared with the CLI, cached by Deno Deploy); watch `deno.json(c)`, `deno.lock`, `package.json`,
`.npmrc`, import-map files and every local file in the graph; bounded fetch concurrency; a single wasm instance
shared across environments. Benchmarks against a plain npm Vite project (target: within ~10% for dev start and build).

---

## 4. Feature list

Priority: **P0** = in the first release, **P1** = second release, **P2** = later, **P3** = exploratory.
"Today" = which existing plugin already does it (none = a genuine gap).

### 4.1 Resolution

| # | Feature | Pri | Evidence / notes | Today |
|---|---|---|---|---|
| R1 | `jsr:` (ranges → lockfile-pinned version, exports map, subpaths), `npm:` (ranges, **subpaths kept**, peer/optional deps, CJS), `https:`/`http:` (redirects, lockfile integrity), `node:`, `data:`, `file:`, `bun:`/`cloudflare:` external | P0 | dvp#98 subpath bug; `data:` fails in `@deno/esbuild-plugin` | partial everywhere |
| R2 | Import map: `imports`, `scopes`, package-with-subpath expansion, importer-relative (which member's map), **import map beats `node_modules` and native resolvers** | P0 | deno#33787; vite.md "import-map entries lose to node_modules" | Fresh only (ordering trick) |
| R3 | Workspaces: root + members (incl. globs), member-scoped import maps, `links` (stable in 2.9), members outside the bundler root, several dev servers at once | P0 | deno#26721 (+16), fresh#3805, vite#22237 | broken/partial |
| R4 | `nodeModulesDir` `auto`/`manual`/`none`, hoisted vs isolated linker, BYONM; `package.json` deps alongside `deno.json`; `DENO_NO_PACKAGE_JSON` | P0 | deno#26091 | partial |
| R5 | `deno.lock` v5 honoured; `lockfile: 'auto' \| 'frozen' \| 'off'` (frozen = fail if resolution would change the lock; CI default when `CI=true`) | P0/P1 | deno#16105 (+39) | loader-based plugins only implicitly |
| R6 | Export conditions per platform (`deno`, `node`, `browser`, custom `conditions`), `browser` field incl. `false` maps, `sideEffects` → `moduleSideEffects` | P0 | fresh#3546, deno-js-loader#30/#60; `deno bundle` 2.8.1 | `deno bundle` only |
| R7 | Query-suffix preservation (`?raw`, `?url`, `?worker`, `?inline`, `?v=`), other plugins' `virtual:`/`\0` ids untouched | P0 | fresh#3893/#3412, dvp#101/#17 | none reliably |
| R8 | Relative/root-relative imports inside remote modules (`importerId` filter; Fresh's `http_absolute` case) | P0 | Fresh | Fresh |
| R9 | Workers (`new Worker(new URL(…, import.meta.url))`, Vite `?worker`) and dynamic `import()` sub-graphs go through the same resolver | P1 | fresh#3897, dvp#106 | open bugs everywhere |
| R10 | Private registries: `.npmrc` scoped registries + auth, `DENO_AUTH_TOKENS`, `JSR_URL`, `NPM_CONFIG_REGISTRY`, proxies/`DENO_CERT` | P1 | deno#16105, esbuild_deno_loader#55/#63 | loader inherits some |
| R11 | Deno 2.9 `jsrDepsInNodeModules` awareness (map `jsr:` → `node_modules/@jsr/...` when present; warn about its subpath bug on 2.9.7) | P1 | multi §6.6 | none |
| R12 | Duplicate-instance detection: `npm:x`, bare `x`, JSR-transitive npm deps and prebundled copies collapse to one module; warn on duplicate framework copies | P1 | vite.md preact `.module.js` vs `.mjs` | none (Fresh forces `noExternal`) |
| R13 | Optional `vendor`/offline (`cachedOnly`) mode with a clear "run `deno install`/`deno cache`" error | P1 | fresh#3467 | poor errors |

### 4.2 Loading and transforms

| # | Feature | Pri | Notes | Today |
|---|---|---|---|---|
| L1 | Local files handed to the host as paths (native TS/JSX, HMR, sourcemaps) | P0 | avoids loader stale-file bug | `@deno/vite-plugin` partially |
| L2 | Remote/JSR modules served pre-transpiled with **readable sourcemaps** (`sources` = URL, not DENO_DIR hash paths) | P0 | loader 0.5 `sourceMap`; T12 (~11 issues) | none |
| L3 | **Import attributes on every bundler**: `with { type: "json" \| "text" \| "bytes" }` (and `"css"` → `CSSStyleSheet` module like Deno 2.9); native on Rollup/esbuild/webpack/Rspack; on Rolldown/Vite via a `transform` pre-pass that rewrites the specifier to `…?deno-type=text` (filtered to files containing `with`) | P0 | rolldown#2758; esbuild.md test failures | none correct on Rolldown/Vite |
| L4 | `moduleType`/loader from Deno media type (Rolldown, Vite build, esbuild, Bun); Vite **dev** transpile in `load` via `transformWithOxc` for `\0` ids (dev ignores `moduleType`) | P0 | ecosystem.md §B.3 | none |
| L5 | JSX per deno.json for local **and remote** modules: `react-jsx`/`react-jsxdev`/`preserve` via host transpiler with `jsxImportSource` resolved through the import map; `precompile` via the loader/`deno transpile` (opt-in, server side) | P0 (automatic) / P1 (precompile) | jsr#24 (+21), deno#30080 | Fresh (Babel, Preact-only) |
| L6 | Wasm: `.wasm` module imports → JS instantiate wrapper (like `deno bundle`), source-phase imports where the host supports them | P1 | T21 | none |
| L7 | `import.meta.main` → `false` in non-entry modules (entry keeps it); `import.meta.filename/dirname` handling for browser | P1 | deno-rolldown-plugin#15; webpack `target:deno` does it | webpack only |
| L8 | CJS correctness when bundling npm for Deno/Node targets (node-mode `__toESM`, `createRequire` shim for esbuild; Rolldown module-format hint) | P1 | deno#34524/#34837; Fresh's 960-line CJS transform | `deno bundle` hacks |
| L9 | Env inlining: `Deno.env.get("PUBLIC_X")`, `process.env.X`, `import.meta.env.X` behind a prefix/allow-list, loaded from `.env`/process; DCE-friendly constants (`IS_BROWSER`) | P1 | deno#30639 (+9) | Fresh only (Preact-specific) |
| L10 | `Deno` global in browser bundles: `denoGlobals: 'error' \| 'warn' \| 'shim'` (shim = minimal `Deno` object for `Deno.env`/`Deno.build`) | P1 warn / P3 shim | T10 | none |

### 4.3 Deno server-output mode (SSR / `deno run` / Deno Deploy)

| # | Feature | Pri | Notes | Today |
|---|---|---|---|---|
| S1 | `platform: 'deno'`: `npm:`/`jsr:` **external and pinned** (`react` → `npm:react@19.2.0`, `jsr:@std/path@^1` → `jsr:@std/path@1.0.8`), `node:` prefixed, static imports only (Deploy runs `--cached-only`) | P0 | fresh SSR cluster (~30), nitro#4618, official PR #13 | none |
| S2 | Per-package override: `bundle: ['npm:some-esm-only']`, `external: [...]`, glob patterns like `deno bundle` | P0 | | `deno bundle` |
| S3 | Emit a sidecar `deno.json` (`imports` pinned to what was externalised) and a trimmed `deno.lock` next to the output so the output dir is runnable with `deno run --cached-only` | P1 | Deploy constraints | none |
| S4 | Vite SSR integration: add `deno` to server `resolve.conditions`/`externalConditions`; `resolve.builtins` for `/^npm:/`, `/^jsr:/` when the dev server runs under Deno so `ssrLoadModule` loads them natively; do **not** force `noExternal: true` | P1 | dvp#54/#56, deno#26492, vite#20828/#20850 | Fresh forces globals |
| S5 | Native-addon (`.node`) and CJS-only detection with warnings and a suggested `external` | P1 | fresh#3323/#3362 | none |
| S6 | webpack `target: 'deno'` / Rspack: respect or override the built-in externalisation loudly (option), never silently | P1 | ecosystem.md §G | webpack silently externalises |
| S7 | deno.json-only projects in frameworks: synthesise the `noExternal`/`optimizeDeps.include` lists frameworks derive from `package.json` (vitefu) | P2 | deno-astro-adapter#67, kit#14555, solid-start#1990, qwik#8616 | none |

### 4.4 Dev-server (Vite) specifics

| # | Feature | Pri | Notes |
|---|---|---|---|
| D1 | `resolve.alias` for `^https?://` so dev import-analysis reaches us; `server.fs.allow` += DENO_DIR + Deno workspace root; Vite `root` vs workspace root handled | P0 |
| D2 | Prebundle JSR/remote/global-cache npm deps: inject our resolver into `optimizeDeps.rolldownOptions.plugins` (Vite 8) / `esbuildOptions.plugins` (Vite ≤7) and add discovered deps to `optimizeDeps.include` | P0/P1 |
| D3 | HMR for local files incl. workspace members outside root; full reload on `deno.json`/`deno.lock` change; invalidate remote module cache on lock change | P0 |
| D4 | Mirror **path-like** import-map aliases into `resolve.alias` so CSS `@import`/Sass `@use`/Tailwind see them (Vite resolves CSS without user plugins) | P1 |
| D5 | Environment API: per-environment loader/platform (`this.environment`, `applyToEnvironment`), works with `builder` and with Vitest | P0 |
| D6 | Vite 7 compatibility (Fresh is pinned there); Vite 6 best-effort | P0 (7) |

### 4.5 Good-citizen and correctness guarantees (cross-cutting)

- Never throw from `resolveId` for ids we don't own; return `null`. Never claim non-Deno ids. (rolldown panics, dvp#101)
- Never write into DENO_DIR except through the engine; never create private temp caches (esbuild_deno_loader#82/#84).
- Never hijack global config (`noExternal`, `optimizeDeps` off, Babel on every file).
- Don't branch on error-message text; use `ResolveError.code`.
- Windows: path/URL conversion, drive-letter case, long paths, no argv-length limits — tested in CI.
- Multi-instance safe (two dev servers, worker sub-builds, Vitest workers).

### 4.6 Diagnostics and DX

| # | Feature | Pri |
|---|---|---|
| X1 | Readable errors with hints (which deno.json/member/scope was used; "not in lockfile, run `deno install`"; "did you mean"); no raw wasm/Rust panics | P0 |
| X2 | `debug: true` / `DEBUG=unplugin-deno`: engine chosen, config files, lockfile, nodeModulesDir, per-specifier trace | P0 |
| X3 | Browser-safety checks: `node:` builtins, `Deno.*`, CJS-only or native packages reaching a client bundle, **with the import chain**; suggest alias/external/polyfill | P1 |
| X4 | Duplicate framework copies (react/preact/vue/solid) warning | P1 |
| X5 | Lockfile drift / min-dependency-age / cachedOnly explanations | P1 |
| X6 | Route the loader's "Downloading…" through the host logger with progress; quiet by default | P0 |

### 4.7 Runtime and portability

| # | Feature | Pri |
|---|---|---|
| P1 | Runs on Node ≥ 22.12, Deno ≥ 2.6 (target 2.8+), Bun ≥ 1.3; no Deno binary required; least privilege under Deno (no `--allow-run`) | P0 |
| P2 | Windows, macOS, Linux CI; Deno Deploy build (Deno-shimmed `node`) and `deno desktop` tested | P0 |
| P3 | Works when the bundler runs under Deno with `nodeModulesDir: none` (global npm cache) | P0 |

### 4.8 Extras nobody provides

| # | Feature | Pri | Notes |
|---|---|---|---|
| E1 | `unplugin-deno/register`: Node `module.registerHooks()` resolver so `vite.config.ts`, Vitest, SSR dev and scripts can import `jsr:`/`npm:`/import-map aliases under Node (`node --import unplugin-deno/register`); async loader bridged to sync hooks via a worker + `Atomics.wait` | P2 | official README says impossible; fresh#3777 |
| E2 | `unplugin-deno/api`: programmatic `createDenoResolver()` for other tools (Tailwind/PostCSS/Sass/tsc bridges); optional `node_modules/<alias>` materialiser for import-map aliases | P2 | deno#33370, fresh#3499 |
| E3 | Ambient type generation / recipe (`vite/client`, `?raw`, CSS modules) so `deno check`/LSP stop flagging bundler-only imports | P2 |
| E4 | License/SBOM report for `jsr:`/`https:` deps | P3 | deno#30121 |
| E5 | `Deno.bundle({ plugins })` adapter once denoland/deno#34345 lands | P3 |
| E6 | HTML entrypoint helpers compatible with `deno bundle`'s behaviour | P3 |

---

## 5. Bundler support and adapter notes

| Host | Pri | How (beyond unplugin's generic hooks) | Known constraint |
|---|---|---|---|
| **Vite 8** (7 compat) | P0 | `enforce:'pre'`; native `resolveId` filters; companion plugins for alias/`fs.allow`/optimizer injection/SSR conditions; `this.environment`; dev transpile via `transformWithOxc`; `hotUpdate` | dev skips `https:` without alias; dev ignores `moduleType`; attributes not passed (see L3) |
| **Rolldown** / tsdown | P0 | Rust-side filters incl. `importerId` (`@rolldown/pluginutils`); `moduleType` from `load`; `platform`; `this.resolve` redirect for npm | no import attributes to `resolveId` (L3 workaround) |
| **Rollup 4** (≥4.40 for native filters) | P0 | `attributes` in `resolveId`/`load`; `jsx` option; needs a TS plugin for local TS (host concern) | no `moduleType` |
| **esbuild 0.28** | P0 | `esbuild.setup` escape hatch: narrow `onResolve` filters, `namespace:'file'` for real files, `deno` namespace for remote, `args.with`, `build.resolve({resolveDir})` for npm, `onStart/onEnd`, `pluginData` | unplugin's default adapter namespaces everything (bypass it) |
| **webpack 5.108+** | P1 | `webpack(compiler)`: `resolveForScheme/resolveInScheme.for('jsr'\|'npm'\|'https'\|'http')` + `readResource.for(...)`; disable `externalsPresets.web` scheme externals in `apply` (or honour `target:'deno'` deliberately); `module.rules[].with` for attributes; virtual paths mirroring URLs with real extensions | generic `resolveId` never sees schemes; `external:true` dropped |
| **Rspack 2** / Rsbuild 2 | P1 | `rspack(compiler)`: `nmf.hooks.resolve` + `resolveForScheme` + `rules[{scheme, enforce:'pre'}]` pitching loader (or `experiments.VirtualModulesPlugin`); `builtin:swc-loader` for TS from virtual dir; Rsbuild via `api.modifyRspackConfig` | `readResource` typed but unwired (rspack#12210); unplugin importer leading-`/` bug |
| **Bun.build** | P2 | unplugin 3 Bun target; `bun.loader`; esbuild-like namespaces | attributes unverified |
| **Farm** | P2 (best-effort) | generic hooks + `filters` | low momentum |
| **`Deno.bundle`** | P3 | after #34345 | – |

---

## 6. Public API sketch

```ts
import deno from 'unplugin-deno/vite' // also /rolldown /rollup /esbuild /webpack /rspack /rsbuild /bun /farm

export default defineConfig({
  plugins: [deno({
    // discovery
    cwd?: string,                          // default: host root (Vite root, esbuild absWorkingDir, process.cwd())
    config?: string | false,               // path to deno.json(c); false = no config discovery
    engine?: 'auto' | 'loader' | 'deno',   // default 'auto' (vendored @deno/loader; Deno CLI when needed/present)
    denoBinary?: string,                   // for the CLI engine
    // resolution
    platform?: 'auto' | 'browser' | 'node' | 'deno' | 'neutral' | Record<envName, ...>,
    conditions?: string[],                 // extra export conditions
    npm?: 'auto' | 'node_modules' | 'deno-cache',   // where npm packages are loaded from
    lockfile?: 'auto' | 'frozen' | 'off',
    cachedOnly?: boolean,                  // offline
    // externals (server mode)
    external?: (string | RegExp)[],        // `npm:*`, `jsr:@scope/*`, globs like deno bundle
    bundle?: (string | RegExp)[],          // force-bundle in 'deno' platform
    pinExternals?: boolean,                // rewrite to exact versions (default true for platform 'deno')
    emitDenoConfig?: boolean | string,     // sidecar deno.json/deno.lock next to output
    // transforms
    importAttributes?: boolean,            // default true
    importMetaMain?: boolean,              // default true
    env?: { prefix?: string | string[]; allow?: string[]; files?: string[] } | false,
    denoGlobals?: 'error' | 'warn' | 'shim' | 'off',
    jsx?: 'auto' | 'host' | 'deno',        // where JSX gets transformed ('deno' = loader, supports precompile)
    // diagnostics
    checks?: { browserSafety?: boolean; duplicates?: boolean; lockfile?: boolean } | boolean,
    debug?: boolean,
    // escape hatches
    include?/exclude?: FilterPattern,      // limit which importers we act on
    resolve?: (spec, importer, ctx) => ...,// user override hook
  })],
})
```

Everything has a sensible default; zero-config must work for `deno init --npm vite` style projects and for
deno.json-only projects.

---

## 7. Testing strategy

- **Fixture matrix** (from the demand-driven acceptance matrix, frameworks-and-demand.md §8): Vite SPA with
  `jsr:`+`npm:`+aliases and no package.json; the three `nodeModulesDir` modes + hoisted linker; workspace with globs and
  `links`, two dev servers; `react → npm:preact/compat` alias under Rolldown; `?raw`/`?url`/`?worker` through aliases,
  worker importing JSR, `.wasm` from JSR; Astro/Solid `virtual:` modules + Tailwind v4 + Sass aliases; SSR build
  running under `deno serve` with `npm:pg`/`npm:sharp` external and CJS named imports when bundled; React Router /
  TanStack / Hono `ssrLoadModule` importing `jsr:`; esbuild browser bundle with a separate browser deno.json
  (Lume-style); Rspack/Rsbuild + JSR; webpack `target: web` and `deno`; env inlining; `vite.config.ts` importing
  JSR (register hook); Windows path cases; private registry + frozen lockfile + min-dependency-age; Deno Deploy-like
  build under Deno-shimmed node; Vitest node + browser mode.
- **Runtimes × OS in CI**: Node 22/24/26, Deno 2.8/2.9, Bun 1.3+ on ubuntu/macos/**windows**. Snapshot output of
  each bundler; compare bundle sizes against direct-node_modules baselines (the 31× lodash-es case).
- **Contract tests for the engine interface** so `loader` and `deno` engines produce identical results on the fixture
  graphs; property tests for the import-map resolver against the WICG spec examples and Deno's test cases.
- **Regression tests named after upstream issues** (dvp#98, dvp#101, fresh#3893, esbuild_deno_loader#31, …).

---

## 8. Packaging, tooling, release

- TypeScript, ESM-only, built with **tsdown** (Rolldown) — dogfooding `unplugin-deno/rolldown` on ourselves.
- `exports`: `.`, `./vite`, `./rolldown`, `./rollup`, `./esbuild`, `./webpack`, `./rspack`, `./rsbuild`, `./bun`,
  `./farm`, `./register`, `./api`. Types via `tsdown --dts`. `publint` + `@arethetypeswrong/cli` in CI.
- Vendored `@deno/loader` wasm + glue in `vendor/deno-loader/` with its MIT licence and a `scripts/vendor-loader.ts`
  to re-vendor (tracks denoland/deno-js-loader releases; file issue #86 there asking for a refresh).
- Publish to **npm** (`unplugin-deno`) and **JSR** (your scope). Peer deps: none required (bundlers optional peers).
- pnpm workspace: `packages/unplugin-deno`, `examples/*` (vite-react, vite-preact-ssr-deno, hono-deno-deploy,
  esbuild-lume-style, tsdown-lib, webpack, rsbuild, bun), `bench/`.
- Lint/format: oxlint + oxfmt (or biome); conventional commits + changesets; GitHub Actions matrix above.

---

## 9. Milestones

**M0 — Skeleton (small).** Repo layout, tsdown build, CI matrix (3 OS × 3 runtimes), fixture harness, vendored
loader smoke test under Node/Deno/Bun, `docs/research` kept.

**M1 — Core + Vite 8 + Rolldown + esbuild + Rollup (P0 set).** Config layer (discovery, workspaces, import maps,
scopes, `links`, `nodeModulesDir`), `loader` engine, ownership rules + id scheme, npm redirect strategy, remote
virtual modules with sourcemaps, import attributes on all four hosts, platform model (browser/node/deno with pinned
externals = S1/S2), Vite dev specifics (D1–D3, D5, D6), diagnostics X1/X2/X6, Windows green. Ship `0.1`.

**M2 — Server story + webpack/Rspack (P1 set).** `deno` CLI engine, S3–S6, L5 precompile, L6–L10, R9–R13, D2
prebundling, D4 CSS aliases, X3–X5, webpack + Rspack/Rsbuild adapters via escape hatches, Bun adapter, frozen
lockfile/CI mode. Ship `0.2`–`0.x`, gather framework feedback (Fresh, Lume, Hono, Astro adapter).

**M3 — Extras (P2/P3).** `register` hook (E1), resolver API + bridges (E2), ambient types (E3), deno.json-only
framework lists (S7), `lite` engine, SBOM, `Deno.bundle` adapter when upstream lands. `1.0` once M1+M2 are stable
across two bundler majors.

---

## 10. Decisions to confirm (recommended default first)

1. **Engine default**: vendored `@deno/loader` wasm, lazy, with the Deno CLI as `auto` fallback — vs. CLI-first when
   Deno is installed (always-current semantics, but requires a binary and subprocesses).
2. **Vendor the loader** inside the npm tarball (+2.2 MB compressed) — vs. an optional dependency on
   `@jsr/deno__loader` that needs an `.npmrc` (fails on npm/bun today) — vs. publishing our own npm mirror package.
3. **npm default = redirect to the host resolver when `node_modules` exists** (best output) — vs. always loading
   through the loader (uniform but 31× worse output in the lodash-es case).
4. **`platform: 'deno'` default externals = external + pinned** for `npm:`/`jsr:` — vs. bundle by default like Vite.
5. **Import-attribute rewriting on Rolldown/Vite** (transform pre-pass, specifier gets `?deno-type=`) — accept the
   small source rewrite until rolldown#2758 lands.
6. **Support floor**: Vite 7+8, Rollup 4.40+, Node 22.12+, Deno 2.6+ (drop 5/6 and older Node).
7. **Repo shape**: pnpm monorepo with `examples/` and `bench/` — vs. single package.
8. **JSR scope/name** for the JSR publish and whether to also publish a `@…/deno-loader` mirror.

---

## 11. Risks

- `@deno/loader` staleness (no release since 2026-03; Deno moves monthly). Mitigations: CLI engine, vendoring with
  patches, upstream issue, and — if it stays stale — building our own wasm from the `deno_resolver`/`deno_graph`
  crates (large but well-trodden; crates are published).
- Rolldown/Vite import-attribute gap (rolldown#2758) — the transform workaround is small but it is a source rewrite.
- webpack/Rspack adapters depend on semi-internal hooks (`resolveForScheme`, pitching loaders, `VirtualModulesPlugin`).
  Mitigation: pin tested versions, contract tests per host.
- Scope creep: the extras (register hook, bridges, SBOM) are explicitly M3.
- Trademark: nominative use only, disclaimer in README (frameworks-and-demand.md §7).
