# Frameworks B: how Deno-native and Deno-friendly frameworks bundle client code (as of 2026-09-25)

Scope: Lume, Hono + Vite (`@hono/vite-*`, HonoX), Ultra, Aleph.js, Lockness (consumer angle), the deno-plc stack, Vike on Deno, and four small tools (packup, dsbuild, Devtools_Hot, esbuild-deno-plugin).
Method: `gh api` for repo metadata, file contents and issues; local shallow clones in `$SCRATCH/repos/fw-lume` and `$SCRATCH/repos/fw-hono-vite-plugins` (plus the existing `lockness-monorepo` and `deno-plc-vite-plugin-deno` clones); the npm registry and JSR `meta.json` for versions; WebFetch for vike.dev, lume.land and hono.dev.
Star counts and dates come from the GitHub API on 2026-09-25.

---

## 0. Summary table

| Project | Client/browser bundler | Server code | Deno resolution for client bundles (pinned version) | npm: / jsr: / https: / import map in browser bundles | Status |
|---|---|---|---|---|---|
| **Lume** 3.3.2 | esbuild `npm:esbuild@0.28.2` (+ terser `npm:terser@5.51.2`) | Not bundled. Deno runs `_config.ts` and templates natively. | **`jsr:@deno/loader@0.5.0`** (the latest on JSR), wrapped in Lume's own esbuild plugin `lume-loader` | All go through `@deno/loader` `Workspace`/`Loader` (resolve and load). History: esm.sh rewrite in v2, then `@luca/esbuild-deno-loader@0.11.1` in v3.0.0–3.0.5, then `@deno/loader` from v3.0.6 | Very active. 2,283★. Last release v3.3.2 on 2026-09-22 |
| **Hono + Vite** (`@hono/vite-dev-server` 0.26.1, `@hono/vite-build` 1.11.1, HonoX) | Vite (client build) | Vite SSR build. `@hono/vite-build/deno` emits a bundle for `deno run`/`deno serve` | **None shipped.** Deno users add `@deno/vite-plugin` themselves (e.g. `npm:@deno/vite-plugin@^2.0.2` in honox#370) | Nothing Deno-aware. Only `preset: 'hono' \| '@hono/hono'` picks the `serveStatic` import for the Deno adapter | Active. vite-plugins 291★, pushed 2026-07-11. HonoX 2,930★ |
| **Ultra** 2.3.8 | **No bundler.** Unbundled ESM and native browser import maps. Build is per-file SWC transpile via `mesozoic@v1.3.10` plus vendoring | Deno runs it natively | None. Uses `deno.land/x/import_map@v0.15.0` and generates per-entry import maps | npm packages come from **esm.sh URLs in the import map**. No `npm:`, no `jsr:` | Dormant. 2,945★, not archived. Last release 2023-09-19. The Ultra 3 branch was abandoned 2024-10-28 |
| **Aleph.js** 1.0-beta | Dev: on-demand SWC-wasm transform (`aleph_compiler@0.9.3`). Prod: esbuild `deno.land/x/esbuild@v0.17.12` | Deno runs it natively | None. Its own import-map loader, with **esm.sh** for npm | esm.sh URLs proxied as `/-/esm.sh/...`. `npm:` broken (#567). No `jsr:` | **Archived.** 5,176★. README says "no longer maintained… use Fresh" (2025-07-06) |
| **Lockness** (`@lockness/vite` 0.3.0) | Vite 8 (Rolldown) `npm:vite@^8`, **client assets only** | Not bundled. The Deno server `App.fetch` is injected. The config loads with `--configLoader native` | **Its own** `lockness:deno-resolver` (in `jsr:@lockness/vite@0.3.0`): `deno info --json` for jsr:/https:, `import.meta.resolve` for npm: | Bare specifiers and import-map aliases are **left to Vite**. Needs `nodeModulesDir: "auto"` | New and very active. Created 2026-08-25, 0★ |
| **deno-plc** | Vite `npm:vite@^6.0.3` (monorepo pin) | Their plugin's `env: "deno"` can bundle for Deno | **Its own**: `jsr:@deno-plc/vite-plugin-deno@2.3.5` (the monorepo pins `^2.3.3`). Uses `deno info --json` plus its own npm resolver built on `resolve.exports` | Handles everything via the `deno info` graph with no `node_modules`. Has a `legacy_npm` escape hatch | Low activity. 22★. v2.3.5 on 2026-03-17 |
| **Vike** | Vite, via `npm:vike` | Vite SSR | **None.** Relies on `node_modules` and Deno's npm compatibility | Only `npm:` (or package.json). No jsr:/https:/deno.json handling in the Vite graph (inferred) | Vike is very active (5,832★). The Deno docs page is community-maintained |

---

## 1. Lume (github.com/lumeland/lume)

**Status:** 2,283★. Not archived. Last push 2026-09-23. Latest release **v3.3.2 (2026-09-22)**; v3.3.1 2026-08-10; v3.3.0 2026-07-29.

### (1) Bundlers
- **Client/browser:** the `esbuild` plugin (`plugins/esbuild.ts`) runs esbuild with `bundle: true, format: "esm", platform: "browser", minify: true, jsx: "automatic"` and browser targets from `core/utils/browsers.ts`. It uses `write: false` and a metafile to map outputs back to Lume pages. Pinned in `deps/esbuild.ts`: `export * from "npm:esbuild@0.28.2";`. Changelog 3.1.3 (2025-12-30): "Import `esbuild` dependency from `npm` to avoid permissions issues [#795]". Before that it was `https://deno.land/x/esbuild@v0.25.x/mod.js`.
- `terser` plugin: `npm:terser@5.51.2`. It only minifies and does not resolve anything.
- `_components` JS (`core/components.ts#compileJS`) also uses esbuild. Only component files are resolved there. **Every other import is marked `external`**, so no Deno resolution happens on that path.
- **Server side:** there is no bundling. Deno executes `_config.ts`, page modules and the `jsx` plugin (SSR via `deps/ssx.ts`) directly. For HMR, Lume uses Deno ≥ 2.9 `node:module` `registerHooks` (`core/utils/hmr.ts`), which appends `#<version>` to local specifiers. This caused a CJS regression (#870, below).

### (2) Resolution plugin and version
- **`jsr:@deno/loader@0.5.0`** (`deps/deno_loader.ts`; the JSR latest, published 2026-03-29). It is wrapped in Lume's **own esbuild plugin `lume-loader`** (`deps/esbuild-loader/loader.ts`, 260 lines, moved to its own module 2026-05-17).
- How the wrapper works:
  - It constructs `new Workspace({ configPath, nodeConditions: options.conditions, platform: "browser" | "node" })` and calls `workspace.createLoader()` and `loader.addEntrypoints(...)`.
  - `onResolve({filter:/.*/})` calls `loader.resolve(specifier, importer, ResolutionMode.Import|Require)` and maps the resulting scheme to an esbuild namespace (`file`/`http`/`https`/`npm`/`jsr`/`data`).
  - `onLoad` calls `loader.load(url, RequestedModuleType)` and maps `MediaType` to an esbuild loader.
  - Lume-specific extras:
    - Entry points and files already in Lume's virtual FS are served from memory, not disk.
    - `options.alias` is handled manually.
    - Node built-ins become `external` with a warning.
    - esbuild `external` globs become regexes.
    - `.json` is forced to `RequestedModuleType.Json`, because npm packages import JSON without `with {type:"json"}`.
    - On Windows, absolute paths are converted to `file:` URLs.
  - The `platform` default was fixed to `"browser"` in v3.2.5 (2026-05-25): "configure the `platform` option of the Deno loader to "browser"".
- **History** (from CHANGELOG.md):
  - **Lume 1.x/2.x:** its own resolver. It used the `import_map` package to apply deno.json imports, then **rewrote `npm:`/`jsr:` to esm.sh URLs** (`handleEsm()` builds `https://esm.sh/<name>` or `https://esm.sh/jsr/<name>`, with `?dev`, `cjs-exports`, `target` and `deps` options). See https://github.com/lumeland/lume/blob/v2.5.3/plugins/esbuild.ts
  - **v3.0.0 (2025-05-07):** "Refactor of `esbuild` plugin to use `esbuild-deno-loader` to resolve and load jsr and npm dependencies". It pinned `export { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11.1";` with `https://deno.land/x/esbuild@v0.25.4`.
  - **v3.0.6 (2025-08-07):** "`esbuild` plugin: use `jsr:@deno/loader` official package instead of `@luca/esbuild-deno-loader`."

### (3) How specifiers are handled in browser bundles
- `npm:`, `jsr:`, `https:` and deno.json `imports`/`scopes` are all resolved **and loaded** by `@deno/loader`, from Deno's cache and npm resolution. esm.sh is gone, apart from one test fixture.
- JSX settings are read from the project `deno.json` `compilerOptions` (`jsx`, `jsxImportSource`).
- Users can point `denoConfig` at a **separate deno.json for browser code**. This gives a different import map and JSX runtime from the Lume/SSR side, and it is the main reason the maintainer gave for not switching to `Deno.bundle` (#795).
- Docs (https://lume.land/plugins/esbuild/): "It's recommended to register all NPM/JSR dependencies in the import map, in order to avoid issues in CI environments like Netlify." Inline `npm:x@1.0.3` imports can make the build try to write to the Deno cache.
- Workspaces: handled implicitly by `@deno/loader`'s `Workspace({configPath})`. Lume passes a single `configPath` (site root `deno.json` or `denoConfig`). *I did not verify this with a Lume workspace test.*

### (4) Maintenance
- Very active: 3.3.x releases, dependencies bumped weekly, 44 open issues.

### (5) Issues showing bundling and resolution pain
- **#706** https://github.com/lumeland/lume/issues/706: with esm.sh rewriting (Lume 2.4.3), `@std/html` mapped to `jsr:@std/html@^1.0.3` became `https://esm.sh/jsr//@std/html@^1.0.3/entities`, with an extra slash.
- **#715** https://github.com/lumeland/lume/issues/715: `lume-loader` failed on npm package-internal bare imports (radix-ui → `react-remove-scroll` "not in import map"). The maintainer blamed Deno `import.meta.resolve` behaviour (denoland/deno#27436), switched to the `import_map` package, and suggested esm.sh meanwhile. The thread also shows duplicate React versions.
- **#751** https://github.com/lumeland/lume/issues/751: Lume 3 dev on `@luca/esbuild-deno-loader`. A CJS `require('./data')` inside an npm package failed: "Cannot read file …/deno_esbuild/registry.npmjs.org/langs@2.0.0/node_modules/langs/data".
- **#808** https://github.com/lumeland/lume/issues/808: on Windows, the `@deno/loader` path produced `ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'c'` for `require("node:crypto")` inside `node_modules/@noble/hashes`. Fixed in 3.2.0 (see also #807).
- **#513** https://github.com/lumeland/lume/issues/513: in Lume 1.19 the esbuild plugin could not bundle `npm:` specifiers coming from the import map ("readfile 'npm:/node-emoji@2/'").
- **#444** https://github.com/lumeland/lume/issues/444: an esm.sh-hosted dependency (`@tanstack/react-table`) broke the build spontaneously. This is the fragility of CDN rewriting.
- **#795** https://github.com/lumeland/lume/issues/795: proposal to use `Deno.bundle` (Deno ≥ 2.4) instead of esbuild. The maintainer said Deno.bundle has "no option to configure a custom loader" (virtual or generated files) and no way to use a separate import map or JSX config. It also covers esbuild wasm permissions and `DENO_DIR` write-permission workarounds.
- **#870** https://github.com/lumeland/lume/issues/870: the Deno `registerHooks` HMR hook appended `#0` to specifiers and broke CJS `require()` in `node_modules`, and again when `DENO_DIR` sits inside the project. This is server-side, but it is the same class of resolution problem (PR #871).
- (Related) **#828** https://github.com/lumeland/lume/issues/828: the Sass plugin cannot resolve transitive npm Sass imports in CI.

---

## 2. Hono + Vite (github.com/honojs/vite-plugins, github.com/honojs/honox)

**Status:** honojs/vite-plugins has 291★ and was last pushed 2026-07-11. Packages: `@hono/vite-dev-server` **0.26.1** (npm 2026-07-11), `@hono/vite-build` **1.11.1** (npm 2026-04-05), `@hono/vite-cloudflare-pages` 0.4.3, `@hono/vite-ssg` 0.3.3. HonoX has 2,930★ and was last pushed 2026-08-18.

### (1) Bundlers
- Client: plain Vite (`vite build --mode client`).
- Server: a Vite SSR build.
  - `@hono/vite-build` builds the server entry with `ssr.noExternal: true` (it **bundles all dependencies**) and the default `ssrTarget: 'webworker'` (`packages/build/src/base.ts`).
  - **Deno adapter:** `@hono/vite-build/deno` (`packages/build/src/adapter/deno/index.ts`, added in PR #181 on 2024-09-15, https://github.com/honojs/vite-plugins/pull/181). It prepends `import { serveStatic } from '${preset}/deno'` plus a static-file hook.
  - PR #332 (2026-01-23, https://github.com/honojs/vite-plugins/pull/332) added `preset: '@hono/hono'`, so JSR users import `@hono/hono/deno` instead of `hono/deno`. This is a small example of dual-registry (npm vs JSR) import-map pain.
- Dev: `@hono/vite-dev-server` loads the app via `server.ssrLoadModule(entry)` and serves it through `getRequestListener` from `@hono/node-server`. Its adapters are **bun, cloudflare and node only; there is no Deno adapter**. Under Deno, people use the default or `@hono/vite-dev-server/node`, which means Deno's Node-compat layer. The README only says "if you change the entry point, you can run on Deno…".

### (2) Resolution plugin
- **None shipped.** Neither package references `jsr:`, `npm:` or deno.json.
- The de-facto Deno recipe is to add `@deno/vite-plugin` yourself. honojs/honox#370 uses `"@deno/vite-plugin": "npm:@deno/vite-plugin@^2.0.2"` with `@hono/vite-build/deno` and `@hono/vite-dev-server/node`.
- The npm latest of `@deno/vite-plugin` is 2.0.4 (2026-09-24).

### (3) Specifier handling
- Without `@deno/vite-plugin`, only npm packages from `node_modules` work, via package.json or `nodeModulesDir`.
- Server code also runs through Vite in dev (`ssrLoadModule`) and in build (`noExternal: true`). So **any `jsr:`/`npm:`/`https:` or import-map specifier in server code needs a Vite-side Deno resolver, not just client code.**
- deno.json `compilerOptions.jsxImportSource` is not honoured by Vite. HonoX users must set `oxc: { jsx: { importSource: "hono/jsx" } }` (Vite 8), or `esbuild.jsx` on older Vite, by hand.

### (4) Maintenance
- Active, with a release in July 2026. Deno support is community-driven: the Deno adapter and the `@hono/hono` preset both came from external contributors.

### (5) Issues
- **honojs/vite-plugins#189** https://github.com/honojs/vite-plugins/issues/189: "Does not work on deno". Request headers were always empty via `@hono/vite-dev-server` (node-server under Deno compat). Reported fixed by Deno 2.3. Still open.
- **honojs/vite-plugins#362** https://github.com/honojs/vite-plugins/issues/362: under Deno, pre-bundled client deps (`/.vite/deps/…`) hit the Hono router and returned 404. Node did not show this. Fixed by adding `.vite/*` to the exclude list (PR #363, released 0.26.1).
- **honojs/vite-plugins#250** https://github.com/honojs/vite-plugins/issues/250: Deno plus hono/jsx gave "React is not defined". Setting `esbuild.jsx` manually fixed it, because deno.json JSX config is not picked up.
- **honojs/honox#370** https://github.com/honojs/honox/issues/370 (open, 2026-06-03): **island hydration breaks** after replacing package.json/tsconfig with `deno.json` plus `@deno/vite-plugin`. The same issue notes that Vite doesn't pick up the JSX import source from deno.json.
- **honojs/honox#229** https://github.com/honojs/honox/issues/229: form POSTs fail ("Missing content type") only under the Deno dev server. This is a Deno node-compat header bug, the same as #189.

---

## 3. Ultra (github.com/exhibitionist-digital/ultra)

**Status:** 2,945★. **Not archived, but dormant.**
- Latest release **v2.3.8 (2023-09-19)**. The last `main` commit is 2023-10-17 ("refactor: server handlers").
- A branch named `3` ("Ultra 3: No Build Web Component Framework", using `deno serve`, `hono/jsx` precompile and `jsr:@hono/hono`) was created and abandoned on **2024-10-28**. Its README says "Thank you for going on this journey with us."
- The repo also has experimental `jit-esbuild` and `jit-sucrase` branches.

### (1) Bundlers
- **No bundling, by design.** Its manifesto: "Bundling is an **anti-pattern**", "You write ESM, we ship ESM", "Native import maps in browser".
- Production build (`build.ts` → `lib/build/ultra.ts`) uses **mesozoic** (`https://deno.land/x/mesozoic@v1.3.10`; https://github.com/deckchairlabs/mesozoic, 29★, last push 2025-01-29). Mesozoic copies sources, transforms JS/TS per file with **SWC** and CSS with Lightning CSS, **vendors remote dependencies** (`vendorDependencies: true`), and writes per-entry import maps (`importMap.browser.json`, `importMap.server.json`).
- Dev: a compiler middleware transpiles `.ts/.tsx/.js/.jsx` on request (`lib/middleware/compiler.ts`).
- Server: Deno runs it natively. `start` uses `deno run --no-remote ./server.js` on vendored output.

### (2) Resolution plugin
- None. Uses `https://deno.land/x/import_map@v0.15.0` and Deno's module graph for vendoring.

### (3) Specifier handling
- npm packages are **esm.sh URLs in the import map** (e.g. `"react": "https://esm.sh/v122/react@18.2.0?dev"` in `examples/basic/importMap.json`). The browser loads the same import map natively.
- There is no `npm:`/`jsr:` support. Some user build tasks even run `deno run --no-npm` (see #290).

### (4) Maintenance
- Effectively dead since late 2023. 28 open issues.

### (5) Issues
- **#123** https://github.com/exhibitionist-digital/ultra/issues/123: vendoring broke on Deno 1.22 because an esm.sh-internal path (`/v78/invariant@…`) was an invalid URL. This is a CDN-rewrite fragility.
- **#250** https://github.com/exhibitionist-digital/ultra/issues/250: an import-map entry pointing to a local file (`"tw": "./src/twind/twind.ts"`) was resolved relative to the parent directory during build.
- **#277** https://github.com/exhibitionist-digital/ultra/issues/277: a root alias (`"/~/": "./src/"`) gave the browser error "server responded with a MIME type of ''".
- **#290** https://github.com/exhibitionist-digital/ultra/issues/290: `/~/` alias entries are missing from the generated `importMap.browser.json`/`importMap.server.json`, so there is "Module not found" at runtime.
- **#288** https://github.com/exhibitionist-digital/ultra/issues/288: JSON import (`assert {type:'json'}`) crashes client-side because the compiler middleware only handles `.ts/.tsx/.js/.jsx`.

---

## 4. Aleph.js (github.com/alephjs/aleph.js)

**Status: archived.** 5,176★.
- On **2025-07-06** a README notice was added: "This project is no longer maintained, we recommend using fresh".
- The last GitHub release is 1.0.0-alpha.47 (2022-05-19). The last version commit is "1.0.0-beta.44" (2023-07-01).

### (1) Bundlers
- Dev: on-demand per-module transform with **`https://deno.land/x/aleph_compiler@0.9.3`** (SWC compiled to wasm), with import maps and HMR.
- Production client: **esbuild `https://deno.land/x/esbuild@v0.17.12/mod.js`** with a custom "bundle-client-modules" plugin (`server/build.ts`).
- CSS: parcel-css/lightningcss (`bundleCSS`).
- Server: Deno runs it natively.

### (2) Resolution plugin
- Its own. `server/helpers.ts#loadImportMap` reads deno.json `imports`/`scopes` or `importMap`. The compiler receives `importMap` as JSON.

### (3) Specifier handling
- npm packages come from **esm.sh**: `https://esm.sh/react@18.2.0?dev` is served locally as `/-/esm.sh/react@18.2.0?dev` (helpers.ts, around lines 179–224).
- Other CDNs are unsupported (#154).
- `npm:` breaks because Aleph appends a `?ssr&v=` query (#567). There is no `jsr:` (it predates JSR).

### (4) Maintenance
- Dead and archived.

### (5) Issues
- **#567** https://github.com/alephjs/aleph.js/issues/567: `import Chance from "npm:chance"` fails with "npm package 'chance?ssr&v=lnoso8ht' does not exist". Aleph's query-string cache-busting is applied to `npm:` specifiers.
- **#154** https://github.com/alephjs/aleph.js/issues/154: only esm.sh works (not skypack, jsdelivr or jspm). The maintainer explained Aleph needs esm.sh `?dev` builds and a single React instance.
- **#450** https://github.com/alephjs/aleph.js/issues/450: import-map entries needed by imported libraries work in the Deno CLI but fail in Aleph build/dev.
- **#418** https://github.com/alephjs/aleph.js/issues/418: the bundler downloaded wrong URLs (`zod@v3.9.8/index.ts/external.ts`) when handling re-exports.
- **#438** https://github.com/alephjs/aleph.js/issues/438: `aleph build` failed with "Could not read from file vendor.bundle.entry.js" because of a path-format bug.

---

## 5. Lockness (locknessland/lockness-monorepo; consumer angle only)

**What it is:** "a high-performance, fullstack MVC web framework built natively for Deno" (Laravel/Adonis-style: DI container, Drizzle, sessions, queues, Inertia, and so on).
- About 38 workspace packages, published to JSR under `@lockness/*`.
- The repo was created on GitHub on 2026-08-25 (migrated from `locknessland/lockness`). 0★. Extremely active: commits on 2026-09-25.
- `jsr:@lockness/vite` **0.3.0** was published 2026-09-08.
- Vite docs: https://github.com/locknessland/lockness-monorepo/blob/main/docs/vite.md

### (1) Bundlers
- **Vite 8 (Rolldown)**, `"vite": "npm:vite@^8"`. It is the one `npm:` exception to their "JSR-first" dependency policy (`packages/vite/deno.json`).
- It is used for **client assets only**: one client entry (`app/client.ts`) plus Tailwind CSS. The build emits a hashed manifest, and `viteAssets()` reads it at render time.
- **Server code is never bundled by Vite.** The Deno `App` is injected into `lockness({ app })`, and the dev bridge forwards non-asset requests to `App.fetch()` (`appType: 'custom'`).
- Vite must run as `deno run -A npm:vite --configLoader native`. Their stated reason is that Vite 8 pre-bundles `vite.config.ts` "with esbuild" and then cannot resolve bare `@lockness/*` or the `@lockness/core` JSX runtime (#154). *Whether that step actually uses esbuild or Rolldown in Vite 8 is not verified; either way, it does not honour deno.json.*
- Tailwind CSS is compiled via `@tailwindcss/cli`, not `@tailwindcss/vite`.

### (2) Resolution plugin
- **Its own `lockness:deno-resolver`** (`packages/vite/src/plugins/deno.ts`, `enforce: 'pre'`). It is exported as `denoResolver()` and "stays reusable outside Lockness".
- Its research doc (`.specnaut/specs/vite-integration/research.md`) calls `@deno/vite-plugin` the "Preferred base", yet the implementation is custom. It also rules out `@deno-plc/vite-plugin-deno` because it is flagged "fullstack frameworks most likely incompatible" and "React unsupported".
- Mechanics:
  - **`jsr:`** runs `deno info --json <spec>` through a `Deno.Command` subprocess (argument array, no shell), then follows `redirects` to reach a `https://jsr.io/...` URL.
  - **`npm:`** uses `import.meta.resolve(source)` and converts the result to a filesystem path in `node_modules`.
  - **`https:`** is returned verbatim. `load()` runs `deno info --json <url>` again and reads the `local` cached file ("performs no custom fetch").
  - Every specifier is validated against allowlist regexes first, as SSRF and injection hardening.
- **Bare specifiers and import-map aliases are not handled.** `resolveId` returns `null`, so Vite's resolver takes them.
- `nodeModulesDir: "auto"` is mandatory.

### (3) Consumer-angle observations (risks for anyone reusing this resolver; my inferences, not verified by running it)
- `import.meta.resolve` runs in the **plugin module's** context, not the importer's. Scoped import maps and workspace-member-specific maps are therefore not respected, and it depends on the package being in Deno's graph.
- Each jsr:/https: module costs a `deno info` **subprocess per specifier**, with no batching or cache. This will be slow for large jsr graphs.
- The demo client entry imports only CSS, so the browser-side jsr:/npm: path is mostly exercised by unit tests (`tests/deno_resolver.test.ts`), not by a real bundle.
- There is no handling for `jsr:` package-internal relative imports beyond Vite's URL handling (they rely on `https://jsr.io/...` ids and `load()`).

### (4) Maintenance
- Brand new and daily-active, with a single maintainer/team. No external adoption signal (0★).

### (5) Issues (all closed; the internal tracker is spec-driven)
- **#103** https://github.com/locknessland/lockness-monorepo/issues/103: research on Vite plus Deno. It lists gotchas: `node_modules` still needed, the permissions required, the "config-file resolution blind spot" (`@deno/vite-plugin` cannot rewrite specifiers inside `vite.config.ts`), dual manifests, and deno.lock ownership.
- **#106** https://github.com/locknessland/lockness-monorepo/issues/106: implement the Deno specifier resolver ("Vite's default module resolver is Node-centric…").
- **#154** https://github.com/locknessland/lockness-monorepo/issues/154: standalone `vite build`/`dev` failed because Vite bundles `vite.config.ts` before plugins run (emitting `react/jsx-runtime` and treating `@lockness/*` as external). Fixed with `--configLoader native`.
- **#156** https://github.com/locknessland/lockness-monorepo/issues/156: Tailwind v4 utilities were not compiled by the production `vite build`, so the build plugin had to shell out to `@tailwindcss/cli`.
- (Earlier: PR/issue **#92**, a "failed big-bang attempt" at Vite integration, referenced in #103.)

---

## 6. deno-plc stack (github.com/deno-plc)

**What it is:** "@Deno-PLC", a GPL framework for **PLC/HMI** (industrial control UI) applications by Hans Schallmoser (TUM student). Its stack, from https://github.com/deno-plc/deno-plc:
- "**NATS** is the backbone"
- "**Vite** is used to bundle the frontend code"
- "**Preact** is used to declaratively build the user interface"
- "**Deno** is used as a type checker and server-side runtime"

Packages: `@deno-plc/nats`, `router`, `signals`, `signal-utils`, `ui`, `utils`, plus adapters (tcp, osc, obs, vlc, routeros).
- The monorepo `deno.json` pins `"@deno-plc/vite-plugin-deno": "jsr:@deno-plc/vite-plugin-deno@^2.3.3"`, `"vite": "npm:vite@^6.0.3"` and `nodeModulesDir: "auto"`.
- The dev server is `frontend/src/dev-vite.ts`: the Vite JS API (`createServer(config({env:"browser"}))`) plus a Hono app for SSR and dev assets.
- There is a second, experimental path, `dev-dplc`, using **`@deno-plc/build`** ("a WIP custom build system … based on ESBuild and SWC"). It is a Hono dev server that also uses `deno info` and an npm compiler with `npm:esbuild@^0.25.2`, and has Rust parts. Last commit 2025-05-24.

### Plugin facts
- https://github.com/deno-plc/vite-plugin-deno: 22★, LGPL-2.1+. JSR **2.3.5 (2026-03-17)**.
- First JSR release 0.1.0 was **2024-05-31**. That is *before* `@deno/vite-plugin` existed (npm 0.0.1 appeared 2024-09-20).

### Why they built their own (README)
- "Use Deno for the frontend and enjoy development without the hassle of `node_modules` and package managers!"
- The plugin "injects a custom rollup resolver at the earliest stage possible (even before the builtin fs loader)". Instead of Vite resolving imports, it "consults the Deno CLI (`deno info --json`). This ensures that all imports link to exactly the same files Deno would use (including import mapping)."
- It adds a Node/npm-compatible resolver (probing plus package.json `exports` via `resolve.exports`) "because `deno info` only outputs the resolved npm package versions, not the exact files".
- It transforms CJS to ESM itself (AST worker pool; `lebab`/`acorn` in the monorepo deps).
- It maps `file:` URLs back to paths so HMR works.
- It adds internal specifiers `npm-data:` and `npm-probe:`, plus `virtual:node:null` for unpolyfilled `node:` modules.
- Options: `env: "browser"|"deno"`, `undeclared_npm_imports`, `extra_import_map` (with a `#standalone` suffix), `exclude`, and `legacy_npm` (hand selected packages back to Vite and `node_modules`).
- The README acknowledges `esbuild_deno_loader` "does exactly the same for esbuild".

### Stated limitations
These are also Lockness's reasons for rejecting it.
- "Currently only build script configurations are supported because `vite.config.ts` will always be run with Node". The Vite JS API is required. *This looks stale: issue #9 uses a `vite.config.js` importing `npm:vite@8.1.0` and `jsr:@deno-plc/vite-plugin-deno@2.3.5`. Not verified.*
- Asset imports (`import url from './img.png'`) and CSS imports throw, because "Deno simply cannot handle such imports". You must use `new URL(..., import.meta.url)` or import CSS from HTML.
- "Currently React is unsupported" because `react-dom` does "extremely ugly things with cjs exports". Preact/compat aliasing is recommended.
- "Fullstack frameworks are most likely incompatible."
- Dependency optimisation is unsupported.
- Babel/PostCSS/Tailwind plugins need `node_modules` (`legacy_npm`).
- Deno < 2.1.7 is unsupported.

### Specifier handling
- `./`, `https:`, `jsr:`, `npm:` and mapped imports are all "provided by Deno" through `deno info`. The plugin itself only resolves concrete `npm:foo@1.2.3` subpaths.
- Workspaces are supported, with a regression in 2.3.1 fixed in 2.3.3 (#6).

### Maintenance
- Sporadic: commits in 2025-02, 2025-05 and 2026-03. Two open issues.

### Issues
- **#1** https://github.com/deno-plc/vite-plugin-deno/issues/1: the Vite `vanilla-ts` template fails in dep-scan with "invalid output of deno info file:///…/index.html". HTML entries are not Deno modules.
- **#2** https://github.com/deno-plc/vite-plugin-deno/issues/2 and **#7** https://github.com/deno-plc/vite-plugin-deno/issues/7: "underscore version extension differs". `deno info` reports the same npm package twice with different peer-dependency suffixes (TanStack Start; `wagmi`/`engine.io-client`).
- **#6** https://github.com/deno-plc/vite-plugin-deno/issues/6: workspace support regressed in ^2.3.1.
- **#9** https://github.com/deno-plc/vite-plugin-deno/issues/9 (open, 2026-07-01): scoped `npm:@scope/...` imports become `""` when `legacy_npm` is empty. The regex `/"npm:()(@.+)"/` captures an empty group.
- **#8** https://github.com/deno-plc/vite-plugin-deno/issues/8 (open, 2026-01-13): "Consider using `@deno/loader`". No response.
- Commit f75cec5 (2026-03-17): "fix: deno changed its info output format again". Depending on the `deno info --json` output shape is brittle.

---

## 7. Vike on Deno

**Status:** vikejs/vike has 5,832★ and was pushed 2026-09-25 (very active).
- The Deno page https://vike.dev/deno is "maintained by the community and may contain outdated information".
- Community examples: `richard-unterberg/deno-vike-react` (2025-09, 0★) and `brillout/vps-deno` (2023).
- Server integrations:
  - `vike-node` is deprecated ("superseded by vike-server", npm 0.3.7, 2025-02).
  - `vikejs/vike-server` (the repo formerly named vike-node, 39★) is marked "[Deprecated]".
  - `vike-photon` 0.1.26 (2026-03-26) is deprecated in favour of **Universal Deploy** (https://vike.dev/blog/universal-deploy, 2026-04-21). That post mentions Deno only as a self-hosting runtime ("with Node.js / Bun / Deno").
  - `@vikejs/hono` 0.2.1 (npm 2026-06-19, repo vikejs/vike-server-adapters, 3★) is a thin `@universal-middleware/hono` wrapper. The only file mentioning "deno" in that repo is `packages/express/src/index.ts`, so there is no Deno-specific logic.

### (1) Bundlers
- Vite for both client and SSR builds, invoked as `deno run --allow-all --node-modules-dir npm:vike dev|build|preview`.

### (2) Resolution plugin
- **None.** Vike does not use `@deno/vite-plugin`. The docs recipe is `npm:` specifiers in the config (`import vike from 'npm:vike@latest/plugin'`) or a minimal package.json, plus `--node-modules-dir`. "Don't use any package manager — let Deno handle your dependencies."
- The community example uses package.json and `import vike from 'vike/plugin'`, with no deno.json imports.

### (3) Specifier handling
- Only npm packages via `node_modules`.
- `jsr:`, `https:` and deno.json import-map aliases are **not supported in the Vite module graph** unless the user adds `@deno/vite-plugin`. *This is inferred: no docs or code mention it, and I found no issue reports of jsr: use with Vike.*
- Scaffolding: `deno run -A npm:create-vike@latest` works (vike#3240, Deno 2.7, Vite 8), producing a package.json project.

### (5) Issues
- **vikejs/vike#3240** https://github.com/vikejs/vike/issues/3240 (2026-05): "Internal error when using Deno". A dev-logger `assert()` failed under Deno (`getTagSource`). Fixed in 0.4.259.
- **vikejs/vike#579** https://github.com/vikejs/vike/issues/579 (2022): vite-plugin-ssr required a `package.json`, so a pure-Deno (`npm:vite`, `npm:vite-plugin-ssr/plugin`) setup failed.
- **vikejs/vike-server#127** https://github.com/vikejs/vike-server/issues/127: under Bun and Deno, server HMR fails with "Address already in use (os error 48)" from `Deno.serve`. The workaround `hmr: 'prefer-restart'` later became the default in vike-photon.
- **chakra-ui/ark#3750** https://github.com/chakra-ui/ark/issues/3750 (2026-01): Vike prerender/SSR under Deno fails with "'solid-js/web' does not provide an export named 'use'". It "works fine with Deno when using `package.json` instead of `deno.json`". The resolution conditions and graph differ between Deno npm resolution and Vite/Node resolution.
- **denoland/deno#33901** https://github.com/denoland/deno/issues/33901 (2026-05): a Deno canary 2.7.14 panic during a `vike dev` request (a runtime regression, not resolution).
- **vikejs/bati#250** https://github.com/vikejs/bati/issues/250: "Consider deno" as a runner (closed with no discussion).

---

## 8. Minor tools

| Tool | What it is | Loader and pin | Activity |
|---|---|---|---|
| **packup** (https://github.com/kt3k/packup, https://packup.deno.dev) | "Zero-config web application packager for Deno": a Parcel-like bundler that takes HTML entries, with esbuild, Sass and livereload | `jsr:@luca/esbuild-deno-loader@0.10.3` plus `https://deno.land/x/esbuild@v0.21.4/mod.js` (`deps.ts`) | **Inactive.** 337★. Last commit 2024-06-02 (v0.2.6 bump). GitHub releases stop at v0.2.3 (2023-07-20) |
| **dsbuild** (https://github.com/orgsofthq/dsbuild, `jsr:@orgsoft/dsbuild`) | "Deno to browser in seconds": zero-config bundler, dev server, watch, React/MDX static rendering, CSS via lightningcss-wasm | **`jsr:@deno/esbuild-plugin@^1`** plus `npm:esbuild@^0.23.0`. It migrated from esbuild_deno_loader on 2025-06-16 | **Low activity.** 114★. v0.3.2 on 2025-09-08. Issues: #8 https://github.com/orgsofthq/dsbuild/issues/8 (`with {type:"text"}` fails with "[plugin: deno-loader] [unreachable] Not an ESM module"); #4 https://github.com/orgsofthq/dsbuild/issues/4 (duplicate React from peer deps, improved by switching to `@deno/esbuild-plugin`); #1 https://github.com/orgsofthq/dsbuild/issues/1 (Windows path with percent-encoded chars: "deno-resolver didn't set a resolve directory") |
| **nhrones/Devtools_Hot** (https://github.com/nhrones/Devtools_Hot, JSR `@ndh/hot` 1.1.5) | A personal dev server that esbuild-bundles `src/` to `dist/bundle.js` and live-reloads by injecting a WebSocket script | `jsr:@luca/esbuild-deno-loader@^0.11.0` plus `npm:esbuild@0.24.0` | **Inactive and personal.** 1★. Last commit 2025-01-10 |
| **twosaturdayscode/esbuild-deno-plugin**, now **duesabati/esbuild-deno-plugin** (https://github.com/duesabati/esbuild-deno-plugin, JSR `@duesabati/esbuild-deno-plugin`) | A fork and rewrite of `esbuild_deno_loader`. It drops "portable" mode and adds explicit **workspace** support (resolves each member's own import map) | It is itself a loader: file/https/data/npm/jsr and import maps. JSR latest 0.2.6; the repo is at 0.2.7 | **Dormant.** 10★. Last commit 2025-02-28 |

---

## 9. Cross-cutting patterns (relevant to an unplugin-based Deno plugin)

1. **Four generations of solutions.**
   - (a) Rewrite `npm:` to **esm.sh/CDN URLs** in the import map: Aleph, Ultra, Lume ≤2. All three accumulated CDN-fragility bugs (Lume #444 and #706, Ultra #123, Aleph #154), dev/prod build mismatches, and duplicate React instances.
   - (b) **`@luca/esbuild-deno-loader`**: Lume 3.0.0–3.0.5, packup, Devtools_Hot.
   - (c) **`deno info --json` subprocess graphs**: deno-plc, Lockness. These are brittle to output-format changes (deno-plc commit f75cec5) and duplicate npm peer-dependency entries (deno-plc #2 and #7), and slow when run per specifier.
   - (d) The **official Rust-backed loaders**: `@deno/loader` in Lume ≥3.0.6, `@deno/esbuild-plugin` in dsbuild, and `@deno/vite-plugin` in the HonoX Deno recipe. The only actively maintained Deno-native framework with real client bundling (Lume) settled on `jsr:@deno/loader@0.5.0` wrapped in its own esbuild plugin.
2. **Vite-based frameworks (Hono/HonoX, Vike) ship no Deno resolution at all.** They rely on Deno's npm compatibility and `node_modules` (`nodeModulesDir: "auto"` or `--node-modules-dir`). Users bolt on `@deno/vite-plugin` for jsr:/import maps. Failures show up as subtle runtime differences: missing headers (hono#189, honox#229), `.vite/deps` 404s (hono#362), and island hydration breaking with deno.json (honox#370).
3. **The server graph matters as much as the client graph.** In Vite dev, SSR code goes through `ssrLoadModule` (Hono) and builds bundle with `noExternal: true`, so a Deno resolver must cover SSR environments too. Lockness sidesteps this by keeping the server on Deno and using Vite only for client assets. That approach needs `--configLoader native` so Deno, not Vite's config bundler, loads `vite.config.ts` and the server graph.
4. **deno.json `compilerOptions` (jsx, jsxImportSource) are ignored by Vite.** Hono #250 and HonoX #370 had to set `esbuild.jsx`/`oxc.jsx` manually. Lume reads them from deno.json itself. Lume also supports a **separate deno.json for browser code** (`denoConfig`), which users value for React-on-client with Lume-JSX-on-server.
5. **Browser conditions and platform** must be passed explicitly. Lume had to force `platform: "browser"` on `@deno/loader` (3.2.5). deno-plc has `env: "browser"|"deno"`. ark#3750 shows deno.json vs package.json resolution producing different `solid-js/web` exports.
6. **Import-attribute and non-JS edge cases keep recurring:**
   - JSON imported without `with {type:"json"}` inside npm packages (Lume forces the Json module type).
   - `type: "text"` (dsbuild #8).
   - CSS and asset imports: deno-plc cannot handle them, because Deno rejects them.
   - CJS `require('./data')` (Lume #751).
   - `node:` built-ins in browser bundles: Lume externalises them with a warning; deno-plc uses `virtual:node:null` or polyfill maps.
   - Windows paths and URLs (Lume #808, dsbuild #1).
7. **CI and permissions:** inline `npm:x@ver` specifiers not in the lockfile or import map trigger Deno-cache writes during the build. Lume recommends registering everything in the import map, and esbuild wasm needs `DENO_DIR` write access (Lume #795).
8. **`Deno.bundle` (Deno ≥ 2.4) is not yet a framework-grade replacement.** It has no custom loader or virtual-module hook and cannot use a separate import map or JSX config (Lume #795).
9. **Maintenance reality:** Aleph is archived, and Ultra and packup are dead. deno-plc, dsbuild and duesabati are single-maintainer and dormant. Lockness is brand new with 0★. Among the frameworks covered here, Lume is the most battle-tested reference for a loader-based design. (Fresh is covered in a separate report.)

## 10. Could not verify / caveats
- Whether Lockness's `import.meta.resolve('npm:…')` resolves against the importer's scope or the plugin's scope in real consumer apps. This is inferred from the code; I did not run it.
- Whether deno-plc's README claim that "vite.config.ts will always be run with Node" is still true in 2026. Issue #9 suggests configs now work under `deno run npm:vite`.
- Whether Vike works with jsr:/import-map aliases when `@deno/vite-plugin` is added. I found no docs or issues either way.
- Lume workspace-member resolution through `@deno/loader` `Workspace({configPath})` is assumed from the loader's design and not tested.
- The Vite 8 config pre-bundler tool (esbuild vs Rolldown) named in Lockness #154 is quoted from their issue text.
