# unplugin-deno — feature plan

Status: **approved 2026-09-25** (revision 2, after a fact-check against the research and a feasibility review of the
core mechanisms against the real sources). Milestones M0–M3 below are the work plan; M1 is the first target.

**Progress (2026-09-26, after the M2 work).** M0 is done, and M1 is done except for the items listed below. Of M2,
the P1 set is implemented on Vite 8/7, Rolldown, Rollup, esbuild, webpack, Rspack and Rsbuild: the `deno` CLI engine
with `engine: 'auto'` selection, S3 (the sidecar `deno.json`/`deno.lock`), S6, L5 for the automatic and classic
runtimes, the Wasm instantiation of L6, `import.meta.main` (L7), env inlining (L9), L10, R9 (Vite workers), R10, R11,
R12's duplicate warning (X4), R13, R15, D4, D7, X3 for `node:` builtins and native addons (S5), X4, X5, the webpack
and Rspack/Rsbuild adapters, and the frozen lockfile/CI mode. [architecture.md](architecture.md) describes the code;
its [Appendix A](architecture.md#appendix-a-deviations-from-planmd) lists where it departs from sections 2–6 below.
Open:

- M2: `jsx: 'deno'` (L5 `precompile` for local files; `"jsx": "precompile"` compiles with the automatic runtime and a
  warning meanwhile), S4's `resolve.builtins` experiment, L8, the source-phase imports of L6,
  `import.meta.filename`/`dirname` (L7), DCE constants such as `IS_BROWSER` (L9), CommonJS-only packages and the full
  import chain in X3/S5, and the Bun adapter (`unplugin-deno/bun` and `/farm` are inert).
- From M1: the first publish (0.1.0 through the version pull request; the release workflow, npm trusted publishing and
  the JSR link are configured, see [contributing.md](contributing.md#release)), the D8 docs, R6's `browser: false` mappings for packages from Deno's
  global cache, and P2's Deno Deploy and `deno desktop` checks.
- M3 as planned, S7 included.

CI (2026-09-26, commit 4a123a6): all 16 jobs pass on ubuntu, macOS and Windows (Node 22 and 26, Deno, Bun; lint,
build and package checks; the examples). The Windows failures of the `deno` engine were one bug: `deno info` given an
absolute Windows path read the drive letter as a URL scheme and reported the synthetic root module as external, so the
engine now passes it as a `file:` URL. The JSR dry run passes and is a required CI step.

**Follow-ups found by the examples (2026-09-26):**

1. Done: `compilerOptions.jsx*` of `deno.json` configure local JSX on every host (L5, architecture.md §5.11).
2. Done: mirror source maps name readable sources on the Rollup-family hosts (the file next to the mirror file; esbuild
   keeps the URL), and the README says that npm files from Deno's global cache keep their `DENO_DIR` paths.
3. Done: Vite marker ids are relative to the root (`\0deno:<type>:<path>.js`, `~u` for `..`).
4. Done: a warning when `nodeModulesDir: "auto"` meets a `node_modules` another package manager installed, and a hint
   that says to add an `npm:` package to `package.json` with `"manual"`.
5. Documented in the README and the examples: `--node-modules-dir=manual` when a bundler runs under Deno in a project
   with `"nodeModulesDir": "none"`.
6. Done: `emitDenoConfig` writes the sidecar `deno.json`/`deno.lock`, so the output runs with
   `deno run --frozen --cached-only` (S3).
7. Documented in the README and `examples/esbuild-browser`: `cacheDir` when `config` points into a subdirectory.
8. Done: `"prepare": "tsdown"` builds `dist/` after a fresh clone.

The plan is derived from the research reports in [`research/`](research/README.md) (about 5,100 lines, six parallel
research passes over 30+ prior-art packages, the bundlers' current APIs, Deno 2.5–2.9 release notes, framework
integrations and ~1,500 issues). Shorthand for issue references is in [research/README.md](research/README.md).
How the design is realised in code is in [architecture.md](architecture.md).

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
  `vite.config.ts` can import `jsr:` under Node, readable sourcemaps, and **fast dev** (remote and JSR modules are
  real files the dev server can prebundle).

Names: npm `unplugin-deno` (claimed), JSR `@brc-dd/unplugin-deno`. Not affiliated with Deno Land Inc.; nominative use
of "Deno" only, no logo (research: frameworks-and-demand.md §7).

Non-goals (v1): re-implementing a bundler; replacing `deno bundle`; type-checking; running npm lifecycle scripts
ourselves (we tell the user to run `deno install`, or do it through the optional Deno CLI engine).

---

## 2. What the research says (the findings that shape the design)

1. **Every surviving plugin converged on `@deno/loader`** (Deno's Rust resolver/graph/npm-installer/transpiler as a
   5.5 MB wasm): `@deno/vite-plugin` 2.x, `@deno/esbuild-plugin`, `@deno/rolldown-plugin`, Fresh 2's internal plugin,
   Lume. Plugins that shell out to `deno info` per import are the source of the OOM (>8 GB), "10× slower" and
   "output format changed" complaints. (frameworks-and-demand.md §6, §8; vite.md; esbuild.md)
2. **`@deno/loader` runs on Node and Bun since 0.4.0 (2026-03)** and returns source maps since 0.5.0.
   `@deno/vite-plugin` 2.0.4 already uses 0.5 and builds under Node; `@deno/esbuild-plugin` and
   `@deno/rolldown-plugin` still pin 0.3 and are Deno-only. The loader is JSR-only (`npm i` fails without an `.npmrc`
   for `@jsr`, and npm 12 rejects npm.jsr.io tarballs outright), stale against Deno 2.8/2.9 (`catalog:`,
   `jsrDepsInNodeModules`, link globs, glob workspace members, the 24 h minimum-dependency-age default, CSS imports;
   deno-js-loader#86 asks for a refresh), uses sync fs, keeps stale contents for edited local files, prints
   "Downloading…" via `console.error`, downloads every npm package in the lockfile eagerly, and its `cachedOnly` only
   blocks remote modules. Its real API is small: `Workspace({noConfig, noLock, configPath, nodeConditions,
   newestDependencyDate, platform: 'node'|'browser', cachedOnly, debug, preserveJsx, noTranspile})` →
   `Loader{addEntrypoints, resolveSync, resolve, load, getGraphUnstable}`. There is no `cwd`, `nodeModulesDir`,
   `vendor`, `lockfile` or `frozen` option; those come from `deno.json` or must be plugin logic.
   (multi-and-deno-tooling.md §1; feasibility review)
3. **The official plugins have correctness bugs users hit daily** (about ten reproduced with Vite 8.3.1 / esbuild
   0.28.2): `npm:pkg@x/subpath` loses the subpath (fix pending in dvp PR #98); `virtual:` and `\0` ids of other
   plugins crash the build; `node_modules` silently beats the import map; import attributes ignored (`with
   {type:"text"}` of a `.json` returns an object); `data:` imports fail; deno.json found from `process.cwd()` instead
   of `absWorkingDir` (issue-reported); workspace members outside the Vite root get no HMR; JSR modules never
   prebundle in dev (~30 requests for `@std/path`). (vite.md; esbuild.md)
4. **Letting the host's own resolver handle npm packages matters**: `lodash-es` `chunk` bundles to 10.4 KB when
   esbuild resolves through a real `node_modules` vs 321.9 KB when the plugin loads npm files itself (loses
   `sideEffects`/`browser`/conditions); the feasibility review measured 2.4 KB vs 83.0 KB on Rolldown. (esbuild.md;
   feasibility review)
5. **unplugin's generic hooks are not enough for a resolver plugin** (unplugin 3.4.0, verified): on **webpack**
   `resolveId` never sees `jsr:`/`npm:`/`https:` (scheme requests bypass the resolver → `UnhandledSchemeError`);
   on **webpack/Rspack** `{external: true}` is silently ignored and virtual modules get a wrong importer; on
   **esbuild** unplugin registers its own catch-all `onResolve(/.*/)` *before* the `esbuild.setup` escape hatch and
   puts every resolved id into the plugin namespace; `rspack(compiler)` is never called under Rsbuild. Working
   native recipes exist for each. (ecosystem.md §A.6, §K; rolldown-rollup-rspack-webpack.md; feasibility review)
6. **Vite 8 dev ≠ build**: dev import-analysis skips `https://` and `data:` specifiers unless a `resolve.alias`
   matches; dev never transpiles TS for `\0` ids and ignores `moduleType`; the optimizer and SSR externalisation
   only recognise paths containing `node_modules`, so Deno's global cache is neither optimised nor externalised;
   `optimizeDeps.include` is resolved without user plugins, so `jsr:`/`npm:`/virtual entries fail there.
   (ecosystem.md §B.3; feasibility review)
7. **Rolldown (and thus Vite 8) does not pass import attributes to `resolveId` and dedupes `text`/`bytes` imports
   of the same id** (rolldown#2758, on their Q3 plan). Rollup exposes attributes but also reuses the first
   resolution for the same id; esbuild, webpack and Rspack key modules per attribute. Bun's `onResolve` has no
   `with`. (ecosystem.md §0.2, §K)
8. **`resolvedBy` is never set by Vite 7/8 or Rolldown** (only Rollup), so Fresh's "let other plugins answer, ignore
   Vite's resolver" trick is a no-op there; the import map must be authoritative for its keys instead. Rolldown has
   no `importerId` filter in unplugin's typed API (only through its escape hatch). (feasibility review; ecosystem.md)
9. **webpack ≥5.102 `target:"web"` and 5.108's `target:"deno"` externalise `jsr:`/`npm:`/`https:` before any
   resolver runs**; `target:"deno"` also gives correct `import.meta.main`, the `deno` condition, and (unlike Deno)
   the `browser` condition. Both webpack and Rspack externalise `http(s):` for web targets by default.
   (rolldown-rollup-rspack-webpack.md §6; ecosystem.md §G)
10. **Deno 2.8.3 added `deno info --json` → `npmPackages[*].localPath` explicitly for bundler plugins; Deno 2.9
    added `jsrDepsInNodeModules`** (installs `jsr:` deps into `node_modules/@jsr/…` with symlinks; its import-map
    subpath handling is broken on 2.9.7) and stable `links`; 2.8 made `with {type:"text"}` stable (`bytes` still
    unstable) and implemented `node:module.registerHooks()`. Open PR denoland/deno#34345 moves `deno bundle` to
    Rolldown and adds a `Deno.bundle({plugins})` API. (multi-and-deno-tooling.md §6; ecosystem.md §I)
11. **SSR is half the product.** The largest pain cluster (~30 issues) is server builds: CJS/native npm packages
    break when bundled, and users cannot hand `npm:`/`jsr:` back to Deno to load at runtime. Deno Deploy runs
    **every** build through Deno-shimmed `node`/`npm` (so "the build runs on Deno" says nothing about the output
    platform) and runs apps with `--cached-only`, so externals must be static and pinned.
    (frameworks-and-demand.md §2.5, §3, §8)
12. **Nobody supports `jsx: "precompile"` outside Deno** (Oxc/SWC/esbuild don't); `@deno/loader` and
    `deno transpile` do. All major bundlers run under Deno 2.9.7 (Rolldown needs `--allow-env --allow-read
    --allow-ffi`); Vite 8 needs Deno ≥ 2.7 (`util.parseEnv`). (ecosystem.md §0.2, §J; frameworks-and-demand.md)
13. Verified versions (2026-09-25): unplugin 3.4.0 (ESM-only, Bun + Rsbuild + `unloader` targets, RegExp-only
    `resolveId` filter), Vite 8.3.1 (Rolldown/Oxc default), Rolldown 1.2.11, tsdown 0.23.0, Rollup 4.63.5,
    esbuild 0.28.2, Rspack 2.2.7 / Rsbuild 2.2.9, webpack 5.111.1, Farm 1.7.11 (stale), TypeScript 7.0.2 (tsdown's
    declaration output needs TypeScript ≤ 6), Deno 2.9.7.

---

## 3. Architecture (summary — details in architecture.md)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Host adapters (thin)  vite · rolldown/tsdown · rollup · esbuild · webpack ·  │
│                        rspack/rsbuild · bun · farm · (Deno.bundle later)      │
├──────────────────────────────────────────────────────────────────────────────┤
│ Core plugin (unplugin factory)                                               │
│   ownership rules · id scheme · resolveId/load/transform · platform model ·  │
│   remote-module mirror · import-attribute markers · externals · diagnostics  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Engine interface   resolve(spec, importer, {kind}) → {url, kind, …}          │
│                    load(url, type) → {code, map, mediaType}                  │
│   engines: `loader` (vendored @deno/loader wasm, default) · `deno` (CLI:     │
│            deno info --json + localPath + DENO_DIR) · `lite` (later, no wasm)│
├──────────────────────────────────────────────────────────────────────────────┤
│ Config layer (pure TS, no wasm)  deno.json(c) discovery · workspace/members  │
│   (incl. globs) · import map + scopes · links · nodeModulesDir detection ·   │
│   lockfile read · compilerOptions.jsx* · package.json interplay · watching   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Key decisions (all confirmed by the feasibility review unless marked experimental):

- **Import map is authoritative for its keys.** A mapped bare specifier is mapped by us first, then the *mapped
  target* is resolved (a path is handed to the host; `npm:` goes through the npm strategy; `jsr:`/`https:` through
  the engine). No reliance on `resolvedBy`. An `exclude` option leaves chosen keys to the host.
- **Remote modules become real files** in a project-local **mirror** (`node_modules/.unplugin-deno/…`, configurable
  `cacheDir`), written from the engine's transpiled output with import specifiers rewritten so relative imports
  resolve natively. Hosts load them like any other file: Vite prebundles them (path contains `node_modules`),
  webpack/Rspack need no virtual-module plugin for them, sourcemaps and output paths are readable and reproducible,
  and the Node `register` hook can import them. Virtual ids are used only for synthesised modules.
- **npm packages are redirected to the host's own resolver** when a `node_modules` exists (bare `pkg/subpath`
  resolved from the package's directory via `this.resolve`/`build.resolve`), falling back to the engine-resolved path
  in Deno's global npm cache when there is none. In Vite dev the redirect is keyed on the raw Deno specifier through
  `DevEnvironment.depsOptimizer` so prebundling stays on and runs once.
- **Import attributes are encoded in the id** (`?deno-type=text|bytes`) on every host; detected natively where the
  host passes `attributes`/`with` (Rollup, esbuild, webpack, Rspack) and via a `transform` pre-pass that rewrites the
  specifier (static and dynamic imports) on Rolldown/Vite. `json` is left to the host.
- **Platform is derived from project shape and explicit options, never from the runtime of the build process.**
- **Engine default is the vendored `@deno/loader`**, lazily initialised; the Deno CLI engine is an alternative
  (`engine: 'deno'`) and the `auto` fallback when the loader lacks a feature the config uses and a `deno` binary is
  present.

---

## 4. Feature list

Priority: **P0** = first release (M1), **P1** = M2, **P2** = M3, **P3** = exploratory.
"Today" = which existing plugin already does it (none = a genuine gap).

### 4.1 Resolution

| # | Feature | Pri | Evidence / notes | Today |
|---|---|---|---|---|
| R1 | `jsr:` (ranges → lockfile-pinned version, exports map, subpaths), `npm:` (ranges, **subpaths kept**, peer/optional deps, CJS), `https:`/`http:` (redirects, lockfile integrity), `node:`, `data:`, `file:`, `bun:`/`cloudflare:` external | P0 | dvp PR #98 (subpath); `data:` fails in `@deno/esbuild-plugin` | partial everywhere |
| R2 | Import map: `imports`, `scopes`, package-with-subpath expansion, importer-relative (which member's map applies), **import map authoritative over `node_modules` and native resolvers** | P0 | deno#33787; vite.md "import-map entries lose to node_modules" | Fresh (Vite 7 build only) |
| R3 | Workspaces: root + members **including globs**, member-scoped import maps, `links` (stable in 2.9), members outside the bundler root, several dev servers at once. Member discovery is done by our config layer because the vendored loader lacks glob members and link globs | P0 | deno#26721 (+16), fresh#3805, vite#22237 | broken/partial |
| R4 | `nodeModulesDir` `auto`/`manual`/`none`, hoisted vs isolated linker, BYONM; `package.json` deps alongside `deno.json`; `DENO_NO_PACKAGE_JSON` | P0 | deno#26091 | partial |
| R5 | `deno.lock` v5 honoured; `lockfile: 'auto' \| 'frozen' \| 'off'` implemented by the plugin (compare resolved versions against the lock; frozen fails on drift; default `frozen` when `CI=true`) | P0/P1 | deno#16105 (+39) | implicit only |
| R6 | Export conditions per platform (`deno`, `node`, `browser`, `import`, `default`, custom `conditions`; documented hazard: react-dom ≤19.2 maps `deno` to its browser server build), `browser` field incl. `false` maps, `sideEffects` → `moduleSideEffects` | P0 | fresh#3546, deno-js-loader#30/#60; `deno bundle` 2.8.1 | `deno bundle` only |
| R7 | Query-suffix preservation (`?raw`, `?url`, `?worker`, `?inline`, `?v=`), other plugins' `virtual:`/`\0` ids untouched | P0 | fresh#3893/#3412, dvp#101/#17 | none reliably |
| R8 | Imports inside remote modules (relative, root-relative, package-scoped bare) resolved through the engine and **rewritten to their targets when the module is mirrored**, so no importer filters are needed on any host | P0 | Fresh `http_absolute`; `@deno/vite-plugin` root-relative | Fresh, `@deno/vite-plugin` |
| R9 | Workers (`new Worker(new URL(…, import.meta.url))`, Vite `?worker` incl. adding ourselves to `worker.plugins`) and dynamic `import()` sub-graphs go through the same resolver | P1 | dvp#106 | open bugs everywhere |
| R10 | Private registries: `.npmrc` scoped registries + auth, `DENO_AUTH_TOKENS`, `JSR_URL`, `NPM_CONFIG_REGISTRY`, proxies/`DENO_CERT`, injected `fetch` (the loader reads `globalThis.fetch` at call time) | P1 | deno#16105, esbuild_deno_loader#55 | loader inherits some |
| R11 | Deno 2.9 `jsrDepsInNodeModules` awareness: when `node_modules/@jsr/…` exists, use it as the npm route (one JSR route per build: never mix `@jsr/*` npm-compat packages and `jsr.io` sources) | P1 | multi §6.6 | none |
| R12 | Duplicate-instance detection: `npm:x`, bare `x`, JSR-transitive npm deps and prebundled copies collapse to one module; warn on duplicate framework copies | P1 | vite.md preact `.module.js` vs `.mjs` | none |
| R13 | Offline (`cachedOnly`) mode with a clear "run `deno install`/`deno cache`" error; note the loader's `cachedOnly` only covers remote modules | P1 | fresh#3467 | poor errors |
| R14 | Minimum-dependency-age parity: pass Deno's setting (default 24 h in 2.9) as `newestDependencyDate` so versions match `deno install` when there is no lockfile | P0 | multi §1.5, vite.md | none |
| R15 | Remote-import allow-list mirroring `--allow-import` (Deno's default hosts) with an option to extend; clear error for disallowed hosts | P1 | rolldown#1768, webpack buildHttp `allowedUris` | webpack buildHttp |
| R16 | One engine workspace per config scope (nearest `deno.json` of the importer) for imports from outside the workspace | P2 | vite.md (`@str4ngemd` fork) | `@str4ngemd` fork |

### 4.2 Loading and transforms

| # | Feature | Pri | Notes | Today |
|---|---|---|---|---|
| L1 | Local files handed to the host as paths (native TS/JSX, HMR, sourcemaps) | P0 | avoids the loader's stale-file bug | `@deno/vite-plugin` partially |
| L2 | Remote/JSR modules mirrored as real files, pre-transpiled by the engine, with **readable sourcemaps** (`sources` = URL) and **reproducible ids** (no DENO_DIR or cwd paths in output/chunk names) | P0 | loader 0.5 `sourceMap`; T12 (~11 issues); rrrw reproducibility | none |
| L3 | **Import attributes on every bundler**: `with { type: "text" \| "bytes" }` (and `"css"` → `CSSStyleSheet` module like Deno 2.9) encoded as `?deno-type=`; `json` left to the host; native detection where available, `transform` pre-pass (static + dynamic imports) on Rolldown/Vite | P0 | rolldown#2758; esbuild.md test failures; Rollup dedupe | none correct on Rolldown/Vite |
| L4 | `moduleType`/loader from Deno media type where the host accepts it (Rolldown, Vite build, esbuild, Bun); mirrored code is JS so Vite-dev's `\0`/TS limitation does not apply | P0 | ecosystem.md §B.3 | `@lulu/deno-rolldown-plugin` (moduleType) |
| L5 | JSX per deno.json for local **and remote** modules: local via host transpiler with `jsxImportSource` resolved through the import map; remote via the engine (per-package settings, incl. `precompile`) | P0 (automatic) / P1 (`precompile` for local files via `jsx: 'deno'`) | jsr#24 (+21), deno#30080 | Fresh (Babel, Preact-only) |
| L6 | Wasm: `.wasm` module imports → JS instantiate wrapper (like `deno bundle`), source-phase imports where the host supports them | P1 | fresh#3897 (`.wasm` from `jsr:@deno/doc`) | `deno bundle` |
| L7 | `import.meta.main` → `false` in non-entry modules (entry keeps it); `import.meta.filename/dirname` handling for browser | P1 | deno-rolldown-plugin#15 | webpack `target:deno`, `deno bundle` |
| L8 | CJS correctness when bundling npm for Deno/Node targets (node-mode `__toESM`, `createRequire` shim for esbuild; Rolldown module-format hint) | P1 | deno#34524/#34837; Fresh's CJS transform | `deno bundle` hacks |
| L9 | Env inlining: `Deno.env.get("PUBLIC_X")`, `process.env.X`, `import.meta.env.X` behind a prefix/allow-list, loaded from `.env`/process; DCE-friendly constants (`IS_BROWSER`) | P1 | deno#30639 (+9) | Fresh (Preact-specific), `@deno/esbuild-plugin` `publicEnvVarPrefix` |
| L10 | `Deno` global in browser bundles: `denoGlobals: 'error' \| 'warn' \| 'off'` (users asked for errors/warnings, not a shim) | P1 | T10 | none |
| L11 | Sourcemap/path hygiene: `sources` as URLs for remote, project-relative for mirror files; strip the loader's inline `sourceMappingURL` comment; no absolute cache paths in emitted output | P0 | rrrw §reproducibility | none |

### 4.3 Deno server-output mode (SSR / `deno run` / Deno Deploy)

| # | Feature | Pri | Notes | Today |
|---|---|---|---|---|
| S1 | `platform: 'deno'`: `npm:`/`jsr:` **external and pinned** (`react` → `npm:react@19.2.0`, `jsr:@std/path@^1` → `jsr:@std/path@1.0.8`), `node:` prefixed, static imports only (Deploy runs `--cached-only`) | P0 | fresh SSR cluster (~30), nitro#4618, deno-rolldown-plugin PR #13 | none |
| S2 | Per-package override: `bundle: ['npm:some-esm-only']`, `external: [...]`, glob patterns like `deno bundle` | P0 | | `deno bundle` |
| S3 | Emit a sidecar `deno.json` (`imports` pinned to what was externalised) and a trimmed `deno.lock` next to the output so it runs with `deno run --cached-only` (design inference; validated by an integration test that runs the output under Deno) | P1 | Deploy constraints | none |
| S4 | Vite SSR integration: add `deno` to server `resolve.conditions`/`externalConditions`; **experimental** `resolve.builtins` for `/^npm:/`, `/^jsr:/` when the dev server runs under Deno so `ssrLoadModule` loads them natively; never force `noExternal: true` | P1 | dvp#54/#56, deno#26492, vite#20828/#20850 | Fresh forces globals |
| S5 | Native-addon (`.node`) and CJS-only detection with warnings and a suggested `external` | P1 | fresh#3323/#3362 | none |
| S6 | webpack `target: 'deno'` / Rspack: respect or override the built-in externalisation loudly (option), never silently | P1 | ecosystem.md §G | webpack silently externalises |
| S7 | deno.json-only projects in frameworks: synthesise the `noExternal`/`optimizeDeps.include` lists frameworks derive from `package.json` (vitefu) | P2 | deno-astro-adapter#67, kit#14555, solid-start#1990, qwik#8616 | none |

### 4.4 Dev-server (Vite) specifics

| # | Feature | Pri | Notes |
|---|---|---|---|
| D1 | Dev-only `resolve.alias` `{ find: /^(https?:\/\/\|data:)/, replacement: '$1' }` so dev import-analysis reaches us; `server.fs.allow` += mirror dir, workspace root (Vite ≥8.0.9 detects JSON `deno.json` workspaces itself; still needed for Vite 7 and JSONC) | P0 |
| D2 | Prebundling of remote/JSR/npm deps: mirrored files live under `node_modules`, so the optimizer treats them as deps; npm redirects keyed on the raw specifier via `depsOptimizer` (one optimizer run); `jsrDepsInNodeModules` used when present | P0 |
| D3 | HMR for local files incl. workspace members outside root; full reload on `deno.json`/`deno.lock` change; mirror refresh on lock change | P0 |
| D4 | Mirror **path-like** import-map aliases into `resolve.alias` so CSS `@import`/Sass `@use`/Tailwind see them (Vite resolves CSS without user plugins) | P1 |
| D5 | Environment API: per-environment platform/engine workspace (`this.environment`, `applyToEnvironment`), works with `builder` and with Vitest | P0 |
| D6 | Vite 7 compatibility (Fresh is pinned there; `transformWithEsbuild` instead of `transformWithOxc`, `esbuildOptions.plugins`); Vite 6 unsupported | P0 |
| D7 | Register ourselves in `worker.plugins` so worker sub-builds resolve Deno specifiers | P1 |
| D8 | Document `vite --configLoader native` under Deno for config files that import `jsr:`; the Node `register` hook (E1) covers Node | P0 (docs) |

### 4.5 Good-citizen and correctness guarantees (cross-cutting)

- Never throw from `resolveId` for ids we don't own; return `null`. Never claim non-Deno ids. (rolldown panics, dvp#101)
- Never write into DENO_DIR except through the engine; the mirror is the only plugin-owned cache and lives under the
  project (`node_modules/.unplugin-deno` by default, like Vite's `node_modules/.vite`); atomic writes, safe for
  concurrent processes.
- Never hijack global config (`noExternal`, `optimizeDeps` off, Babel on every file).
- Don't branch on error-message text; use `ResolveError.code` when present and structured fallbacks otherwise.
- Surface `addEntrypoints` diagnostics as warnings (the official plugins drop them).
- Windows: path/URL conversion, drive-letter case, long paths, no argv-length limits — tested in CI.
- Multi-instance safe (two dev servers, worker sub-builds, Vitest workers); webpack persistent cache safe.

### 4.6 Diagnostics and DX

| # | Feature | Pri |
|---|---|---|
| X1 | Readable errors with hints (which deno.json/member/scope was used; "not in lockfile, run `deno install`"; "did you mean"); no raw wasm/Rust panics | P0 |
| X2 | `debug: true` / `DEBUG=unplugin-deno`: engine chosen, config files, lockfile, nodeModulesDir, per-specifier trace | P0 |
| X3 | Browser-safety checks: `node:` builtins, `Deno.*`, CJS-only or native packages reaching a client bundle, **with the import chain**; suggest alias/external/polyfill | P1 |
| X4 | Duplicate framework copies (react/preact/vue/solid) warning | P1 |
| X5 | Lockfile drift / min-dependency-age / cachedOnly explanations | P1 |
| X6 | Route the loader's "Downloading…" (`console.error`) through the host logger with progress; quiet by default | P0 |

### 4.7 Runtime and portability

| # | Feature | Pri |
|---|---|---|
| P1 | Runs on Node ≥ 22.12, Deno ≥ 2.7 (2.8+ recommended), Bun ≥ 1.3; no Deno binary required; least privilege under Deno (no `--allow-run`) | P0 |
| P2 | Windows, macOS, Linux CI; Deno Deploy build (Deno-shimmed `node`) and `deno desktop` tested | P0 |
| P3 | Works when the bundler runs under Deno with `nodeModulesDir: none` (global npm cache) | P0 |

### 4.8 Extras nobody provides

| # | Feature | Pri | Notes |
|---|---|---|---|
| E1 | `unplugin-deno/register`: Node `module.registerHooks()` resolver (reusing unplugin's `unloader` target) so `vite.config.ts`, Vitest, SSR dev and scripts can import `jsr:`/`npm:`/import-map aliases under Node (`node --import unplugin-deno/register`); async engine bridged to the sync hooks via a worker + `Atomics.wait` (verified on Node 26 and Deno 2.9.7; Bun needs `Bun.plugin` + `--preload`) | P2 | official README says impossible; fresh#3777 |
| E2 | `unplugin-deno/api`: programmatic `createDenoResolver()` for other tools (Tailwind/PostCSS/Sass/tsc bridges); optional `node_modules/<alias>` materialiser for import-map aliases | P2 | deno#33370, fresh#3499 |
| E3 | Ambient type generation / recipe (`vite/client`, `?raw`, CSS modules) so `deno check`/LSP stop flagging bundler-only imports | P2 |
| E4 | License/SBOM report for `jsr:`/`https:` deps | P3 | deno#30121 |
| E5 | `Deno.bundle({ plugins })` adapter once denoland/deno#34345 lands | P3 |
| E6 | HTML entrypoint helpers compatible with `deno bundle`'s behaviour | P3 |

---

## 5. Bundler support and adapter notes

| Host | Pri | How (beyond unplugin's generic hooks) | Known constraint |
|---|---|---|---|
| **Vite 8** (7 compat) | P0 | `enforce:'pre'`; native `resolveId` filters; companion plugins for alias/`fs.allow`/optimizer/SSR conditions; `this.environment`; `depsOptimizer` wiring for npm redirects; `hotUpdate` | dev skips `https:`/`data:` without alias; attributes not passed (see L3); `optimizeDeps.include` can't take Deno specifiers |
| **Rolldown** / tsdown | P0 | Rust-side filters; `moduleType` from `load`; `platform`; `this.resolve` redirect for npm (returns `{id, external, packageJsonPath, moduleSideEffects, meta}`) | no import attributes to `resolveId` (L3 workaround); `resolveId` options are `{kind, isEntry, custom}` |
| **Rollup 4** (≥4.40 for native filters) | P0 | `attributes` in `resolveId`/`load` → `?deno-type=` ids; `jsx` option; local TS needs the user's TS plugin | no `moduleType`; reuses first resolution per id |
| **esbuild 0.28** | P0 | Return **only** `esbuild.setup` from the factory for this host (unplugin's own catch-all `onResolve(/.*/)` would win otherwise): narrow `onResolve` filters, real files in the `file` namespace, `args.with`, `build.resolve(path, {kind, resolveDir, importer, …})` (`kind` required) | – |
| **webpack 5.108+** | P1 | `webpack(compiler)`: `nmf.hooks.resolveForScheme/resolveInScheme.for(scheme)` (`AsyncSeriesBailHook<[ResourceDataWithData, ResolveData]>`) + `NormalModule.getCompilationHooks(c).readResource.for(scheme)`; disable `externalsPresets.web` scheme externals in `apply` (or honour `target:'deno'` deliberately); `module.rules[].with` for attributes; mirror files need no virtual modules | generic `resolveId` never sees schemes; `external:true` dropped; persistent cache needs `needBuild` handling |
| **Rspack 2** / Rsbuild 2 | P1 | `rspack(compiler)`: `nmf.hooks.resolve` + `resolveForScheme.for(scheme)` (one argument; no `resolveInScheme`) + `rules[{scheme, enforce:'pre'}]` pitching loader or `rspack.experiments.VirtualModulesPlugin`; Rsbuild via `rsbuild.setup(api)` (`rspack(compiler)` is not called under Rsbuild) | `readResource` typed but unwired (rspack#12210); unplugin importer leading-`/` bug (rspack/index.ts:115) |
| **Bun.build** | P2 | unplugin 3 Bun target; `bun.loader`; esbuild-like namespaces | `onResolve` has no `with` → attributes only via the transform pre-pass |
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
    cacheDir?: string,                     // mirror location; default node_modules/.unplugin-deno under the project
    engine?: 'auto' | 'loader' | 'deno',   // default 'auto'
    denoBinary?: string,                   // for the CLI engine
    // resolution
    platform?: 'auto' | 'browser' | 'node' | 'deno' | 'neutral' | Record<envName, ...>,
    conditions?: string[],                 // extra export conditions
    npm?: 'auto' | 'node_modules' | 'deno-cache',   // where npm packages are loaded from
    lockfile?: 'auto' | 'frozen' | 'off',
    cachedOnly?: boolean,                  // offline
    allowImport?: string[],                // remote hosts (default: Deno's --allow-import defaults)
    exclude?: (string | RegExp)[],         // import-map keys / specifiers to leave to the host
    // externals (server mode)
    external?: (string | RegExp)[],        // `npm:*`, `jsr:@scope/*`, globs like deno bundle
    bundle?: (string | RegExp)[],          // force-bundle in 'deno' platform
    pinExternals?: boolean,                // rewrite to exact versions (default true for platform 'deno')
    emitDenoConfig?: boolean | string,     // sidecar deno.json/deno.lock next to output
    // transforms
    importAttributes?: boolean,            // default true
    importMetaMain?: boolean,              // default true
    env?: { prefix?: string | string[]; allow?: string[]; files?: string[] } | false,
    denoGlobals?: 'error' | 'warn' | 'off',
    jsx?: 'auto' | 'host' | 'deno',        // where JSX gets transformed for local files ('deno' supports precompile)
    // diagnostics
    checks?: { browserSafety?: boolean; duplicates?: boolean; lockfile?: boolean } | boolean,
    debug?: boolean,
    // escape hatches
    importers?: { include?: FilterPattern; exclude?: FilterPattern }, // limit which importers we act on
    resolve?: (spec, importer, ctx) => ...,// user override hook
  })],
})
```

Everything has a sensible default; zero-config must work for `deno init --npm vite` style projects and for
deno.json-only projects. Options that the engine cannot express (`lockfile`, `npm`, `cwd`) are plugin logic.

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
  each bundler; compare bundle sizes against direct-node_modules baselines (the lodash-es case).
- **Contract tests for the engine interface** so `loader` and `deno` engines produce identical results on the fixture
  graphs; property tests for the import-map resolver against the WICG reference tests and Deno's test cases (credited).
- **Regression tests named after upstream issues** (dvp#98, dvp#101, fresh#3893, esbuild_deno_loader#31, …).

---

## 8. Packaging, tooling, release

- TypeScript (pinned ≤ 6 for tsdown's declaration output), ESM-only, built with **tsdown** (Rolldown) — dogfooding
  `unplugin-deno/rolldown` on ourselves. `unplugin` stays an external dependency (its webpack/Rspack loader paths
  depend on `import.meta.dirname`).
- `exports`: `.`, `./vite`, `./rolldown`, `./rollup`, `./esbuild`, `./webpack`, `./rspack`, `./rsbuild`, `./bun`,
  `./farm`, `./register`, `./api`. `publint` + `@arethetypeswrong/cli` in CI.
- Vendored `@deno/loader` (5.49 MB wasm, 2.15 MB gzip, 43 KB glue, MIT) in `vendor/deno-loader/` with its licence and
  a `scripts/vendor-loader.ts` to re-vendor from JSR (tracks denoland/deno-js-loader; #86 requests a refresh).
- Publish to **npm** (`unplugin-deno`) and **JSR** (`@brc-dd/unplugin-deno`). Peer deps: none required (bundlers as
  optional peers).
- pnpm workspace: `packages/unplugin-deno`, `examples/*`, `bench/`. Lint/format: oxlint + oxfmt; changesets; GitHub
  Actions matrix above.

---

## 9. Milestones

**M0 — Skeleton.** Repo layout, tsdown build, CI matrix (3 OS × 3 runtimes), fixture harness, vendored loader smoke
test under Node/Deno/Bun, docs skeleton.

**M1 — Core + Vite 8 (7) + Rolldown + esbuild + Rollup (P0 set).** Config layer (discovery, workspaces incl. globs,
import maps, scopes, `links`, `nodeModulesDir`, lockfile), `loader` engine, ownership rules + id scheme, remote-module
mirror with specifier rewriting and sourcemaps, npm redirect strategy (+ Vite `depsOptimizer` wiring), import
attributes on all four hosts, platform model (browser/node/deno with pinned externals = S1/S2), min-dependency-age
parity, Vite dev specifics (D1–D3, D5, D6, D8), diagnostics X1/X2/X6, Windows green. Ship `0.1`.

**M2 — Server story + webpack/Rspack (P1 set).** `deno` CLI engine, S3–S6, L5 `precompile` for local files, L6–L10,
R9–R13, R15, D4, D7, X3–X5, webpack + Rspack/Rsbuild adapters via escape hatches, Bun adapter, frozen lockfile/CI mode.
Ship `0.2`–`0.x`, gather framework feedback (Fresh, Lume, Hono, Astro adapter).

**M3 — Extras (P2/P3).** `register` hook (E1), resolver API + bridges (E2), ambient types (E3), deno.json-only
framework lists (S7), R16, `lite` engine, SBOM, `Deno.bundle` adapter when upstream lands. `1.0` once M1+M2 are stable
across two bundler majors.

---

## 10. Decisions (resolved)

1. Engine default: vendored `@deno/loader`, lazy; Deno CLI as `engine: 'deno'` and `auto` fallback.
2. Vendor the loader inside the npm tarball (the JSR-only dependency fails on npm/bun; npm 12 rejects npm.jsr.io
   tarballs).
3. npm: redirect to the host resolver when `node_modules` exists; engine-resolved global-cache path otherwise.
4. `platform: 'deno'` externals: external + pinned for `npm:`/`jsr:` (configurable via `pinExternals`/`bundle`).
5. Import attributes: `?deno-type=` id marker everywhere; transform pre-pass only where attributes are not exposed.
6. Remote modules: real files in a project-local mirror (not virtual ids) — for prebundling, host-native loading on
   webpack/Rspack, readable/reproducible output and the register hook.
7. Support floor: Vite 7 + 8, Rollup ≥ 4.40, Rolldown ≥ 1.0, esbuild ≥ 0.25, Node ≥ 22.12, Deno ≥ 2.7, Bun ≥ 1.3.
8. Repo: pnpm monorepo with `examples/` and `bench/`. JSR name `@brc-dd/unplugin-deno`.

---

## 11. Risks

- `@deno/loader` staleness (no release since 2026-03; Deno moves monthly). Mitigations: config layer owns discovery
  (workspaces/globs/links), CLI engine, vendoring with patches, upstream issue #86, and — if it stays stale —
  building our own wasm from the `deno_resolver`/`deno_graph` crates.
- Loader cold start (eager download of every npm package in the lockfile; 3.2 s cold for 110 modules; no retries)
  under Deno Deploy's 5 min / 3 GB build budget. Mitigations: `cachedOnly` when everything is cached, retries in the
  vendored glue, progress logging.
- Rolldown/Vite import-attribute gap (rolldown#2758) — the transform workaround is a small source rewrite.
- The Vite `depsOptimizer` wiring uses a public but low-level API (`DevEnvironment.depsOptimizer`); pin tested Vite
  versions and cover with integration tests.
- webpack/Rspack adapters depend on semi-internal hooks (`resolveForScheme`, pitching loaders, `VirtualModulesPlugin`).
  Mitigation: pin tested versions, contract tests per host.
- Mirror writes on read-only filesystems: fail with a clear error and a `cacheDir` hint (virtual-id fallback only if
  demand appears).
- Scope creep: the extras (register hook, bridges, SBOM) are explicitly M3.
