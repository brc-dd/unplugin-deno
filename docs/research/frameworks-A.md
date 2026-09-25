# Meta-frameworks on Deno: Deno specifiers in client and SSR builds

Research snapshot: 2026-09-25. Frameworks covered: Astro, SvelteKit, Nuxt/Nitro, React Router v7/v8 (Remix), TanStack Start, SolidStart, Qwik/Qwik City. Fresh 2 is included at the end for contrast.

Sources:
- GitHub (`gh api` / `gh issue view`), the npm registry (`npm view`, `npm pack`), and a few official doc pages.
- Local clones:
  - deno-docs @ 0d62971 (2026-09-17)
  - denoland/deno-astro-adapter @ fa0f9bf (2026-07-01)
  - denoland/svelte-adapter @ e547c5e (2026-09-24)
  - nitrojs/nitro main @ 076ef12 (2026-09-24), sparse checkout
  - pluvial/svelte-adapter-deno and dbushell/sveltekit-adapter-deno
- Tarballs in `$SCRATCH/pkgs`: vite 8.3.1, vitefu 1.1.3, vite-plugin-solid 2.11.14, @sveltejs/vite-plugin-svelte 7.3.1, @builder.io/qwik-city 1.20.1, @qwik.dev/router 2.0.0-beta.45.

Markers: **[V]** means verified in source code, the npm registry or an issue. **[I]** means inferred. **[U]** means unverified.

---

## 0. Cross-cutting findings

1. **Everything runs on node_modules. No framework ships a Deno resolver.**
   - Every mainstream meta-framework runs on Deno through Deno's Node/npm compatibility:
     - dependencies are declared in `package.json`, or as `npm:` entries in deno.json `imports`;
     - they are installed into a real `node_modules` (`"nodeModulesDir": "auto"` or `"manual"`, plus `deno install`);
     - Vite, Rollup and Rolldown then use their normal Node resolution.
   - None of the official adapters or presets ships a Deno resolver.
   - Deno's own tutorials for Astro, SvelteKit, Svelte, Nuxt, Qwik and Solid do not use `@deno/vite-plugin`. [V deno-docs]
   - The only Deno-published setups that do use it are:
     - the plain Vite SPA tutorials (React, Vue), in `examples/tutorials/react.md` and `vue.md`;
     - the React Router Deno template, which was removed with React Router 8.

2. **`npm:` and `jsr:` specifiers in app source are unsupported out of the box, in both client and SSR code, in every framework.**
   - Vite 8.3.1 has no handling for them. [V `dist/node/chunks/node.js`]
     - `bareImportRE = /^(?![a-zA-Z]:)[\w@](?!.*:\/\/)/` classifies `npm:foo` and `jsr:@std/x` as bare package names, and Node resolution then fails.
     - Only `https?://` URLs are treated as external (`externalRE = /^([a-z]+:)?\/\//`).
   - The JSR path the tooling actually supports is JSR's npm-compat registry: `npx jsr add`, which creates `@jsr/scope__name` entries plus a `.npmrc` (https://jsr.io/docs/with/vite). This works in Nuxt and SvelteKit, sometimes with `build.transpile`.
   - The only ways to write `jsr:`, `npm:` or deno.json aliases in framework source today:
     - `@deno/vite-plugin`, which currently breaks with framework virtual modules (Astro 7; React Router 8.3 with plugin 2.0.3);
     - Fresh 2's own Deno Vite plugin.

3. **SSR output strategies.**

   **A. Keep bare externals; Deno resolves them at runtime from node_modules or the deno.json import map.**
   - Astro with `@deno/astro-adapter`: Vite's default SSR externalization.
   - SvelteKit with `@deno/svelte-adapter`: copies `builder.writeServer()` output with no re-bundle.
   - React Router: `build/server/index.js`.
   - Nitro v2 `deno-server`: `extends: "node-server"`, deps traced into `.output/server/node_modules`, run with `--unstable-byonm`.

   **B. Bundle everything.**
   - Nitro `deno-deploy`, v2 and v3 (`noExternals: true` / `node: false`, single `index.ts`).
   - Nitro v3 `deno-server`: bundles all except the nf3 "native / non-bundleable" packages, which are traced.
   - Qwik City `deno-server` adapter: `ssr.noExternal: true`, `ssr.target: "webworker"`.
   - Old community SvelteKit adapters: rollup/esbuild re-bundle.

   **C. Deno-scheme externals.** Only `https://` (plus `node:`) is kept external by Nitro's Deno presets and by Vite. Beyond that:
   - The Astro adapter explicitly externalizes its own `jsr:@std/http` and `jsr:@std/path` imports.
   - Qwik's Deno middleware keeps an unversioned `https://deno.land/std/path/mod.ts` import.
   - Nobody keeps user `npm:`/`jsr:` imports external today.
     - Nitro PR #4025 (open) would externalize `/^(?:https:\/\/|npm:|jsr:)/` in the Deno presets.
     - Nitro issue #4618 proposes emitting the installed version (`npm:unjwt@0.7.2`).
     - Precedent: Nitro v2's `deno-server-legacy` preset rewrote every bare external to `npm:<name>` in `renderChunk`.
   - Deno Deploy caches the static module graph and runs with `--cached-only`, so any external `jsr:`/`https:` import must be a static import (Astro adapter fix bae135a / #60).

4. **`package.json` is load-bearing even on Deno.** Several tools derive SSR `noExternal`, optimizeDeps or externals from `package.json`.
   - vitefu `crawlFrameworkPkgs()` returns an empty config when there is no `package.json`: "don't throw as package.json is not required". Both vite-plugin-solid and vite-plugin-svelte use it. [V vitefu 1.1.3 `src/index.js`]
   - adapter-node reads `dependencies` (kit #14555).
   - React Router checked `package.json` for `isbot` / `@react-router/node` (#13743, fixed).
   - Qwik's bundle detection reads `/package.json` (#8616).

   Projects with only a deno.json break in the same way:
   - Astro adapter #67: `astro:react:opts` gets loaded natively by Deno.
   - solid-start #1990: the client build of `@solidjs/router` ends up running on the server.
   - kit #14555, qwik #8616.

   Workarounds seen in the wild: `ssr.noExternal: [...]`, or a stub `package.json`. The React Router Deno template shipped `{"comment": "This only exists to help vite module resolution..."}`.

5. **Export conditions differ between build time and runtime.** Vite SSR resolves with `node` conditions; Deno at runtime uses `deno` + `node`.
   - react-dom ≤19.2 maps `"deno": "./server.browser.js"`, which has no `renderToPipeableStream`; react-dom 19.3.0 maps `"deno": "./server.node.js"`. [V npm]
   - This broke the React Router SPA build under Deno (#14401). It led to custom `entry.server.tsx` files using `renderToReadableStream` (the Deno template, Deno desktop docs) and to the Astro adapter alias `react-dom/server → react-dom/server.browser`.
   - The Nitro dev worker under Deno needed the `deno` condition: #4390, fixed by #4397.
   - The React Router template set `environments.ssr.resolve.{conditions,externalConditions}: ["deno"]`.

6. **Config files are loaded before plugins run.**
   - `vite.config.ts`, `astro.config.ts` and `svelte.config.js` imports are resolved before any Vite plugin runs. This is a documented limitation in the @deno/vite-plugin README, and astro #17738 was closed as not planned.
   - Vite 8.3.1 has `configLoader: 'native'` ("planned to become the default in a future major version of Vite" [V source]). With it, Deno's native resolver (import map, `npm:`, `jsr:`) would load the config.

7. **Virtual modules and `\0` ids.**
   - A Deno resolver at `enforce:'pre'` or normal order sees framework virtual ids before the framework's own `enforce:'post'` plugins rename them.
   - Deno's loader then throws `Unsupported scheme "virtual"` / `"astro"`. Examples: Astro `virtual:astro:*` (deno-vite-plugin #101), React Router `virtual:react-router/inject-hmr-runtime` (#101 comment), solid-start `%00vite` (deno-vite-plugin #36).
   - Fresh's plugin avoids this: it calls `this.resolve()` first and returns early for anything another plugin resolved or anything `\0`-prefixed.

8. **Deno's `node_modules/.deno/` isolated layout causes its own problems.**
   - Duplicate module instances (deno #28326).
   - Failure to resolve an entry module through symlinks (deno #29624).
   - The same file imported via an alias and via a relative path becomes two modules (react-router #14258).

---

## 1. Snapshot

| Framework | Latest (npm, Sept 2026) | Bundler | Deno adapter / preset | Deno resolution plugin in official setup? |
|---|---|---|---|---|
| Astro | astro 7.3.5 (vite ^8.0.13) | Vite 8 (Rolldown) | `@deno/astro-adapter` 0.6.0 (2026-07-01) | No. @deno/vite-plugin breaks on Astro 7 virtual modules (#101) |
| SvelteKit | @sveltejs/kit 2.70.3 (next 3.0.0-next.29) | Vite 5–8 | `@deno/svelte-adapter` 0.2.2 (2026-09-24); community adapters stale or archived | No. Open suggestion svelte-adapter#11 |
| Nuxt / Nitro | nuxt 4.5.2 → nitropack ^2.13.4 (Nitro v2, Rollup); `nitro` 3.0.260903-beta (v3: Rolldown, or Vite builder) | Vite for the app; Rollup/Rolldown for the server | Nitro presets `deno_deploy`, `deno_server` (alias `deno` differs between v2 and v3) | No |
| React Router (Remix) | react-router 8.4.0 (v7 line 7.18.4) | Vite 8 | No adapter. Deno template existed 2025-05-27 → removed 2026-06-17 (v7 branch only) | Template used `@deno/vite-plugin` 1.0.4 |
| TanStack Start | @tanstack/react-start 1.168.58 | Vite ≥7 or Rsbuild 2 (+ Nitro v3 `nitro/vite`) | Nitro presets; Deno Deploy "auto-configures Nitro" | No |
| SolidStart | @solidjs/start 2.0.5 (peer vite ^8 \|\| ^9) | Vite Environment API + `nitro/vite` (v2); Vinxi + Nitro v2 (v1) | Nitro presets | No |
| Qwik | @builder.io/qwik(-city) 1.20.1; @qwik.dev/router 2.0.0-beta.45 | Vite (v2 on Vite 8 `rolldownOptions`) | `…/adapters/deno-server/vite` + `…/middleware/deno` | No |

---

## 2. Astro

**(1) Bundler.** Vite 8 (Rolldown). Astro 7.3.5 depends on `vite ^8.0.13` [V npm]. The adapter writes `vite.build.rolldownOptions` [V `src/index.ts`].

**(2) Adapter: `@deno/astro-adapter`.**
- npm: https://www.npmjs.com/package/@deno/astro-adapter
- Repo: https://github.com/denoland/deno-astro-adapter (115★, 12 open issues, not archived, last push 2026-07-01).
- Releases:
  - 0.3.2: 2025-09-22
  - 0.4.0: 2026-04-08 ("support astro 6", #56)
  - 0.5.1: 2026-05-05 (#58 "Remove fragile import shims")
  - 0.5.2: 2026-05-29 (`--cached-only` fix)
  - **0.6.0: 2026-07-01** ("feat: support Astro 7 (#63)"), peer `astro ^7.0.0`
- Maintained by Deno plus community contributors.
- Recommended by the Astro docs (https://docs.astro.build/en/guides/deploy/deno/, package.json/npm based) and by the Deno Deploy docs (https://docs.deno.com/deploy/reference/frameworks/). Static sites need no adapter.
- What it does [V `src/index.ts`, `src/server.ts`]:
  - `setAdapter({ serverEntrypoint: "@deno/astro-adapter/server.ts", entrypointResolution: "auto", supportedAstroFeatures: {hybrid/static/server output, sharpImageService: stable} })`
  - In `astro:build:setup` for `target === "server"`:
    - aliases `react-dom/server → react-dom/server.browser`;
    - aliases every bare Node builtin (`fs`, `path`, … ~50 modules) to `node:<mod>`;
    - pushes `jsr:@std/http@^1.1.1/file-server` and `jsr:@std/path@^1.1.5` into `build.rolldownOptions.external`.
  - `server.ts` statically imports those `jsr:` specifiers, so the built `dist/server/entry.mjs` contains raw `jsr:` imports that Deno resolves at runtime. Its handler uses `Deno.serve` + `serveFile`, and `setGetEnv(Deno.env.get)`.
  - History:
    - Up to 0.3.x it used a shim module `@deno/astro-adapter/__deno_imports.ts` that was string-replaced in `astro:build:done`. This broke in issue #53: "Stripping types is currently unsupported for files under node_modules".
    - 0.5.1 switched to `await import(JSR_CONST)`. That crashed on Deno Deploy (`--cached-only`) because the module was "hidden from Deno's static graph, so it's not pre-cached" (comment in `test/cached-only.test.ts`).
    - 0.5.2 made the `jsr:` imports static (commit bae135a).
- The adapter's own repo tests run in a Deno workspace (`"workspace": ["test/fixtures/*"]`, `"nodeModulesDir": "auto"`), with fixture `package.json`s (`"@deno/astro-adapter": "workspace:*"`).

**(3) Resolution plugin.** None. Setup is `deno add npm:@deno/astro-adapter` plus deno.json/package.json tasks (`deno run -A npm:astro build`). The Deno tutorial (https://docs.deno.com/examples/astro_tutorial/, repo https://github.com/denoland/tutorial-with-astro) is `package.json` + `astro build` with a static site and no adapter. `@deno/vite-plugin` does not currently work with Astro 7 (deno-vite-plugin #101).

**(4) `npm:`/`jsr:` in client/SSR code.**
- Not supported by Astro or Vite. [I from Vite's `bareImportRE`]
- `@deno/vite-plugin` was meant to enable them but fails on `virtual:astro:*` (#101). Config-level (`astro.config.ts`) deno.json aliases are also unsupported (astro #17738, closed not planned).

**(5) SSR externals.**
- Vite's default SSR externalization applies. The adapter does not set `ssr.noExternal`, so node_modules deps stay as bare imports in `dist/server/*` and Deno resolves them at runtime through node_modules/package.json. [V issues #47/#51 and astro #14297, Astro 5 era; [U] for Astro 7.]
- This breaks when only `dist/` is uploaded (deployctl, classic Deploy).
- The adapter's own `jsr:` std imports are kept external on purpose.
- In deno.json-only projects, integration packages (e.g. `@astrojs/react`) get externalized and their `astro:*` virtual imports hit Deno's native loader. The fix is `vite.ssr.noExternal: ['@astrojs/react']` (#67).

**(6) Issues.**
- https://github.com/denoland/deno-astro-adapter/issues/67 (OPEN, 2026-08): `Unsupported scheme "astro" for module "astro:react:opts"` when using deno.json instead of package.json. Workarounds: `ssr.noExternal: ['@astrojs/react']` or `module.registerHooks` to serve the virtual module.
- https://github.com/denoland/deno-vite-plugin/issues/101 (OPEN, 2026-06): @deno/vite-plugin + Astro 7 fails with `Unsupported scheme "virtual" for module "virtual:astro:server-island-manifest"`. Cause: the plugin sees Astro's `enforce:'post'` virtual ids before Astro rewrites them to `\0`.
- https://github.com/withastro/astro/issues/17738 (closed NOT_PLANNED, 2026-08): deno.json import-map aliases not honored while loading `astro.config.ts` and its transitive imports. @deno/vite-plugin can't help ("bootstrap-order issue").
- https://github.com/denoland/deno-astro-adapter/issues/47 and https://github.com/denoland/deno-astro-adapter/issues/51 (OPEN): Deno Deploy (deployctl, `root: dist`) fails with `Relative import path "unstorage" not prefixed with / or ./ or ../`. Bare SSR externals are unresolvable without node_modules/package.json. The workaround was to add an import map to deno.json.
- https://github.com/withastro/astro/issues/14297 (closed): `@astrojs/mdx` leaves `import 'clsx'` in a page chunk, which breaks Deno Deploy. Astro says the adapter must handle it.
- https://github.com/denoland/deno-astro-adapter/issues/53 (closed): the `__deno_imports.ts` shim was not replaced, giving `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. This led to the #58 rewrite and then the `--cached-only` fix (bae135a).
- https://github.com/denoland/deno-astro-adapter/issues/30 (OPEN, Deno 2.0 era): `ERR_MODULE_NOT_FOUND` in the `node_modules/.deno/...` layout (zod-to-json-schema, luma.gl) during `deno task build`.
- https://github.com/denoland/deno/issues/29624 (closed): with `deno install`, Vite(Astro) could not resolve the entry module for `@qwikdev/astro` (symlinked layout); later fixed.

---

## 3. SvelteKit

**(1) Bundler.** Vite. Kit 2.70.3 peers `vite ^5 || ^6 || ^7 || ^8`; SvelteKit 3 is `next` 3.0.0-next.29. Framework config comes from `@sveltejs/vite-plugin-svelte` 7.3.1.

**(2) Adapters.**
- **Official: `@deno/svelte-adapter`.**
  - Repo: https://github.com/denoland/svelte-adapter (33★, active).
  - Releases: 0.1.0 (2025-05-19), 0.1.1 (2026-02-02), 0.2.1 (2026-05-29), **0.2.2 (2026-09-24)**. Peer `@sveltejs/kit ^2.31.0`.
  - Output `.deno-deploy/`:
    - `server.ts` → `Deno.serve(prepareServer(...))`
    - `handler.ts`, which imports `./server/index.js`, `./server/manifest.js` and the bare `@deno/svelte-adapter/__internal`
    - `deploy.json` (Deno Deploy staticFiles/redirects/headers)
    - `svelte.json` (ISR)
    - `static/`
  - Uses `builder.writeClient / writePrerendered / writeServer`, with **no re-bundling**. [V `src/index.ts`]
  - Supports ISR, remote functions (+CSRF), SvelteKit instrumentation, and `read()`. Run with `deno run -A ./.deno-deploy/server.ts`.
  - Deno desktop looks for `.deno-deploy/server.ts` first (https://docs.deno.com/runtime/desktop/frameworks/).
  - SvelteKit itself declined an official Deno adapter: https://github.com/sveltejs/kit/issues/976 (2021). The `packages/` folder of sveltejs/kit has an `adapter-bun` but no Deno adapter [V].
- **Community: `svelte-adapter-deno`** (https://github.com/pluvial/svelte-adapter-deno).
  - 0.9.1, 2024-08-09; not archived but inactive since 2024.
  - Re-bundles the server with Rollup (`nodeResolve`, `commonjs`, `json`; nothing external) and copies a `deps.ts` containing `https://deno.land/std@0.175.0/...` and `https://deno.land/x/oak@v11.1.0/mod.ts` URL imports. [V `index.js`, `deps.ts`]
- **Community: `sveltekit-adapter-deno`** (https://github.com/dbushell/sveltekit-adapter-deno).
  - 0.16.1, 2024-10-27; **archived**. The README says "no longer maintained… official adapters should be preferred".
  - esbuild bundles `server.js` (`bundle:true, platform:"node"`).

**(3) Resolution plugin.**
- None. Deno docs:
  - https://docs.deno.com/examples/sveltekit_tutorial/ (updated 2026-08-17): converts package.json scripts to deno.json tasks (`"dev": "deno run -A npm:vite dev"`) and adds `"nodeModulesDir": "auto"`.
  - https://docs.deno.com/examples/svelte_tutorial/ (repo https://github.com/denoland/tutorial-with-svelte): package.json devDeps including `@deno/svelte-adapter ^0.1.0`, plain `sveltekit()` vite config, and a deno.json containing only jsr imports for oak + `sloppy-imports`.
- There is no `@deno/vite-plugin` in either. Open suggestion to add it: https://github.com/denoland/svelte-adapter/issues/11.

**(4) `npm:`/`jsr:`.**
- Not supported in `.svelte` or `.ts` sources without a plugin. JSR works via the npm-compat registry: "For JSR, I currently use the NPM compatibility layer" (brunnerh, kit #14555).
- deno.json-only projects are unsupported: kit #14555 was closed NOT_PLANNED, because adapter-node reads `package.json` `dependencies`.
- vite-plugin-svelte uses vitefu `crawlFrameworkPkgs` (`src/utils/options.js:485`), which returns an empty config without `package.json`. So Svelte component libraries are not auto-added to `ssr.noExternal` in deno.json-only projects. [V code; consequence I]

**(5) SSR externals.** Kit's Vite SSR build externalizes node_modules deps, except `@sveltejs/kit` and Svelte libraries crawled from package.json, which become `noExternal`. `@deno/svelte-adapter` ships that output unchanged, so bare imports are resolved at runtime by Deno (node_modules/package.json or the deno.json import map). The adapter's own `__internal` import is also bare.

**(6) Issues.**
- https://github.com/sveltejs/kit/issues/14555 (closed NOT_PLANNED, 2025-09): "Support for `deno.json`". `adapter-node` needs `package.json` `dependencies`.
- https://github.com/sveltejs/kit/issues/12783 (closed): adapter-node output used bare `path` imports, breaking `deno run build/index.js`. Fixed by using `node:` imports (https://github.com/sveltejs/kit/pull/12785).
- https://github.com/denoland/svelte-adapter/issues/22 (OPEN, 2026-07): prerendered endpoints are written to disk but never registered in `staticFiles`, so they 404 on Deno Deploy.
- https://github.com/denoland/svelte-adapter/issues/16 (OPEN): generated assets (e.g. the service worker) are not served.
- https://github.com/denoland/svelte-adapter/issues/11 (OPEN): suggestion to encourage `@deno/vite-plugin`.
- https://github.com/denoland/deno/issues/35846 (OPEN, 2026-07): SvelteKit with deno.json imports: `svelte.config.js` fails with `Import "@sveltejs/vite-plugin-svelte" not a dependency and not in import map` on Windows (drive-letter casing).
- https://github.com/denoland/deno/issues/28326 (closed): `@codemirror/state` loaded twice in the browser (`node_modules/@codemirror/state` vs `node_modules/.deno/@codemirror+state@…`), which breaks `instanceof`.
- https://github.com/denoland/deno/issues/30798 (OPEN): `deno check`/`lint` can't see SvelteKit virtual modules (`$env/static/private`, `$lib`).
- https://github.com/denoland/deno/issues/36870 (OPEN, 2026-09): `deno desktop --hmr` cannot resolve a transitive npm dep (`kleur`) while loading the Vite config (`@deno/svelte-adapter` 0.2.1, Kit 2.69).

---

## 4. Nuxt / Nitro

**(1) Bundler.**
- Nuxt 4.5.2 (2026-08-30) uses `@nuxt/vite-builder` for the app, and **`nitropack ^2.13.4` (Nitro v2, Rollup)** for the server. [V npm]
- Nitro v3 is npm `nitro` 3.0.260903-beta (`latest` is still a beta), with nightlies as `nitro-nightly`. Its builder is auto-selected: `vite` if `vite.config.*` contains `nitro(`, otherwise `rolldown` (default), with `rollup` optional. [V `src/config/resolvers/builder.ts`]

**(2) Presets.**

*Nitro v3* (https://github.com/nitrojs/nitro/blob/main/src/presets/deno/preset.ts) [V]:
- `deno-deploy` (`deno_deploy`):
  - entry `deno/runtime/deno-deploy` (`Deno.serve` + crossws)
  - `exportConditions: ["deno"]`, `node: false`, unenv Deno preset (`node:` builtins external, inject `process`/`Buffer`/timers)
  - `rollupConfig.external: id => id.startsWith("https://") || id.startsWith("node:")`
  - `output.entryFileNames: "index.ts"`, `manualChunks: () => "index"`, i.e. a single file
  - deploy: `deno run -A jsr:@deno/deployctl deploy server/index.ts`
- `deno-server` (`deno_server`, **alias `deno`**):
  - entry uses `srvx/deno`; `exportConditions: ["deno"]`
  - external: `https://`, `node:`, builtins
  - writes `.output/deno.json` `{tasks:{start:"deno run -A ./server/index.mjs"}}`

*Nitro v2 / nitropack* (used by Nuxt; https://github.com/nitrojs/nitro/blob/v2/src/presets/deno/preset.ts) [V]:
- `deno-deploy` (**alias `deno`**): `node:false`, `noExternals:true`, the same `https://`/`node:` externals, single `index.ts`.
- `deno-server` (compatibilityDate ≥ 2025-01-30): `extends: "node-server"`; writes deno.json `start: deno run --allow-net --allow-read --allow-write --allow-env --unstable-byonm --unstable-node-globals ./server/index.mjs`.
- `deno-server-legacy` (older compat dates; alias `deno-server`; https://github.com/nitrojs/nitro/blob/v2/src/presets/deno/preset-legacy.ts):
  - a `rollup-plugin-node-deno` that marks builtins and `https?://` external;
  - in `renderChunk` it **rewrites every bare external import to `"npm:<specifier>"`** (builtins → `node:`);
  - injects `globalThis.process`.
- Gotcha: `preset: "deno"` means `deno-deploy` (bundle everything) in Nitro v2/Nuxt, which is what Deno's Nuxt tutorial and https://github.com/denoland/examples/tree/main/with-nuxt use. In Nitro v3 it means `deno-server`.

Docs:
- https://nitro.build/deploy/runtimes/deno (`NITRO_PRESET=deno_server`, `deno run --allow-net --allow-read --allow-env .output/server/index.mjs`)
- https://nitro.build/deploy/providers/deno-deploy (still describes deployctl / classic Deploy)
- https://nuxt.com/deploy/deno-deploy (`deno_deploy`, marked experimental)
- Deno Deploy docs say "Nuxt requires no additional setup. Deno Deploy automatically configures Nitro". How it configures Nitro is not documented [U].

**(3) Resolution plugin.** None. The Deno tutorial (https://docs.deno.com/examples/nuxt_tutorial/) uses `deno -A npm:nuxi@latest init` (choosing deno as the package manager), `package.json`, and `nitro: { preset: "deno" }`.

**(4) `npm:`/`jsr:`.**
- Unsupported in both app code (Vite) and server code (Nitro).
- In Nitro v3, the externals plugin's exclude filter `/^(?:[\0#~.]|[a-z0-9]{2,}:)|\?/` skips any scheme id [V `src/build/plugins/externals.ts`]. The Deno presets only externalize `https://`, so `npm:x` fails to resolve at build time. PR #4025's docstring confirms: "bundling them is impossible and failing to resolve them breaks the build".
- Open work:
  - https://github.com/nitrojs/nitro/pull/4025 (OPEN, `bunny` preset). Adds `src/presets/_utils/externals.ts` `isDenoSpecifier = /^(?:https:\/\/|npm:|jsr:)/` and uses it in both `deno-deploy` and `deno-server` externals, with tests `test/unit/deno-specifiers.test.ts` and `test/vite/deno-specifiers.test.ts`.
  - https://github.com/nitrojs/nitro/issues/4618 (OPEN, 2026-09-13) proposes resolving `npm:`/`jsr:` versions from the installed tree, so that `import "unjwt"` is emitted as `npm:unjwt@0.7.2`. pi0: "I have plans for built-in auto resolution for npm:"; keep it in the bunny preset for now.
- JSR via the npm-compat registry in Nuxt needs `build.transpile` (nuxt #30737).

**(5) SSR externals.**
- v3 `deno-server`: `node: true`, so the externals plugin runs. It bundles everything except nf3 `NodeNativePackages` / `NonBundleablePackages` (only when actually imported) plus user `traceDeps`, which are traced into `.output/server/node_modules`.
- `deno-deploy`: `node:false` / `noExternals`, so everything is bundled into one `index.ts`, and native addons fail (#3026).
- v2 `deno-server`: node-server behaviour (externals traced into `.output/server/node_modules`, run with `--unstable-byonm`).
- Legacy v2: bare externals rewritten to `npm:` specifiers.

**(6) Issues.**
- https://github.com/nitrojs/nitro/issues/4618 (OPEN): `npm:`/`jsr:` version pinning for Deno presets.
- https://github.com/nitrojs/nitro/pull/4025 (OPEN PR): keep `npm:`/`jsr:`/`https:` external in the Deno presets.
- https://github.com/nitrojs/nitro/issues/4390 (closed 2026-09-07): Vite dev under Deno fails with `Return value from serve handler must be a Response constructed … in this realm`. The dev worker resolved with the `node` condition; fixed by https://github.com/nitrojs/nitro/pull/4397 ("respect bun/deno export conditions in dev server").
- https://github.com/nitrojs/nitro/issues/3026 (closed): `deno-deploy` preset: `Cannot resolve "./argon2.android-arm64.node" … and externals are not allowed!`. Native addons are not bundleable and Deno Deploy can't load them.
- https://github.com/nitrojs/nitro/issues/3832 (OPEN): Nitro v3 dropped the Deno v1 node-globals shims (`process`, `Buffer`, `global`).
- https://github.com/nuxt/nuxt/issues/30737 (closed): JSR packages (npm-compat) are not transpiled, so `@std/ulid` is missing at runtime unless listed in `build.transpile`.
- https://github.com/denoland/deno/issues/34327 (closed): Deno 2.8 crash in `Deno.serve` with Nitro (v3 beta) dev + Hono.
- https://github.com/nuxt/nuxt/issues/29666 (closed, Deno 2.0): "Cannot start nuxt: EINVAL: invalid argument, stat".

---

## 5. React Router v7/v8 (Remix)

**(1) Bundler.** Vite via `@react-router/dev/vite`. react-router is at 8.4.0 (2026-09); the v7 line is at 7.18.4 (`version-7` tag).

**(2) Adapter / template.**
- No adapter package. `@remix-run/deno` 2.17.5 exists for Remix v2 only; Remix 3 is `next` 3.0.0-rc.3, and its Deno story is [U].
- Official **Deno template**: https://github.com/remix-run/react-router-templates/tree/v7/deno.
  - Added 2025-05-27 (https://github.com/remix-run/react-router-templates/pull/131).
  - **Removed from main in "Update templates to React Router 8"** (https://github.com/remix-run/react-router-templates/pull/213, merged 2026-06-17: "Trims a few excess templates (Still available in the `v7` branch)"). [V commit 90652b6 file list]
- Deno Deploy lists "Remix" as ⚠️ Experimental.
- Deno desktop docs: React Router works once you add a Deno-compatible `app/entry.server.tsx` using `renderToReadableStream`.

**(3) Resolution plugin: yes, in the template (v7 branch).** [V]
- `vite.config.ts`: `plugins: [reactRouter(), deno(), tailwindcss()]` with `@deno/vite-plugin` 1.0.4, plus `environments.ssr.build.target "ESNext"` and `resolve.conditions: ["deno"]`, `externalConditions: ["deno"]`.
- `deno.jsonc`:
  - `"nodeModulesDir": "auto"`, `"unstable": ["sloppy-imports"]`;
  - every dependency as an `npm:` entry in `imports` (react-router, vite 6.3.5, …), plus `"@std/http": "jsr:@std/http@^1.0.16"` and `"~/": "./app/"`;
  - tasks run `deno run -A npm:@react-router/dev@7.16.0 build|dev`.
- A **dummy `package.json`**: `{"comment": "This only exists to help vite module resolution. Do not use this file, instread use deno.json."}`.
- `react-router.config.ts`: `future.unstable_viteEnvironmentApi: true`.
- `server.ts`: `Deno.serve` + `createRequestHandler(() => import("./build/server/index.js"))` + `@std/http` `serveDir`/`serveFile`.

**(4) `npm:`/`jsr:`.** Only via @deno/vite-plugin. It broke in plugin 2.0.3 with React Router 8.3 (`Unsupported scheme "virtual" for module "virtual:react-router/inject-hmr-runtime"`, comment on deno-vite-plugin #101); downgrading to 2.0.2 works.

**(5) SSR externals.**
- Vite's SSR default applies: `build/server/index.js` keeps bare imports, and Deno resolves them at runtime via the deno.json import map and node_modules.
- Linked workspace packages are bundled instead, and their deps then can't be resolved at runtime (deno-vite-plugin #54).
- The default `entry.server` relies on `renderToPipeableStream`. With react-dom ≤19.2, Deno resolves `react-dom/server` via the `deno` condition to the browser build, hence the custom `entry.server.tsx`.

**(6) Issues.**
- https://github.com/remix-run/react-router-templates/pull/213: Deno template dropped for v8.
- https://github.com/remix-run/react-router/issues/14401 (closed): `deno task build` with `ssr:false` fails with `'react-dom/server' does not provide an export named 'renderToPipeableStream'` (the `deno` export condition).
- https://github.com/remix-run/react-router/issues/13743 (closed, fixed by https://github.com/remix-run/react-router/pull/13744): `@react-router/dev` required `package.json` under Deno, even with a custom `entry.server`.
- https://github.com/remix-run/react-router/issues/14258 (closed): the same module imported via a deno.json import-map alias (`@/`) and via a relative path was duplicated in the bundle (module identity).
- https://github.com/denoland/deno-vite-plugin/issues/54 (OPEN): React Router + Deno workspace packages: SSR externalization bundles the workspace package but leaves its deps unresolvable; only `ssr.noExternal: true` works.
- https://github.com/denoland/deno-vite-plugin/issues/56 (closed): `viteDevServer.ssrLoadModule()` in a custom RR server fails on `npm:`/`jsr:` ("Only file and data URLs are supported by the default ESM loader").
- https://github.com/denoland/deno/issues/34307 (closed): Deno 2.8.0 regression, `Unsupported scheme "node" for module "node:assert"` with Vite + React Router.
- https://github.com/denoland/deno-vite-plugin/issues/101 (comment by swcarter007, 2026-08-07): RR 8.3.0 + plugin 2.0.3 virtual-module failure.
- Related (Bun, but the same mechanism): https://github.com/remix-run/react-router/issues/15433. RR 8.3 dev restarts with `NODE_OPTIONS=--conditions=development` (https://github.com/remix-run/react-router/pull/15291). Behaviour under Deno is [U].

---

## 6. TanStack Start

**(1) Bundler.** Vite (≥7) **or Rsbuild** (`@rsbuild/core ^2.0.0` peer) [V npm]. Hosting docs (https://github.com/TanStack/router/blob/main/docs/start/framework/react/guide/hosting.md): "TanStack Start supports Vite and Rsbuild". An Rsbuild build emits `dist/server/index.js` with a fetch-style entry.

**(2) Adapter.**
- No Deno-specific adapter, and the hosting docs have no Deno section (Bun and Node do have one). Deno support comes through Nitro v3 (`nitro/vite`, presets `deno_server`/`deno_deploy`).
- Deno Deploy docs (https://docs.deno.com/deploy/reference/frameworks/): `deno add npm:nitro-nightly@latest`, `plugins: [tanstackStart(), nitro(), viteReact()]`; "Deno Deploy automatically configures Nitro".
- Deno desktop detects `@tanstack/{react,solid}-start` and uses `.output/server/index.*`.
- The Deno tutorial https://docs.deno.com/examples/tanstack_tutorial/ covers TanStack Router + Query (a Vite SPA) plus a Hono API, not Start.

**(3) Resolution plugin.** None.

**(4) `npm:`/`jsr:`.** Unsupported. There is no Start-level handling, and Nitro doesn't handle them either (see §4).

**(5) SSR externals.** Handled by Nitro v3 with the Vite builder (see §4): `deno_server` bundles almost everything plus nf3-traced native deps; `deno_deploy` bundles everything. With Rsbuild the server bundle comes from Rsbuild, and its external policy is [U].

**(6) Issues.** Few Deno-specific issues were found, which suggests either low usage or that it mostly works; flagged as a gap.
- https://github.com/TanStack/router/issues/5356 (closed): router-generator on Deno failed with the misleading error `This version of Node.js … does not support module.register()`. Cause: tsx; they migrated to jiti.
- https://github.com/nitrojs/nitro/issues/4390 and https://github.com/denoland/deno/issues/34327: Nitro v3 Vite dev under Deno crashes (Response realm / `Deno.serve`), fixed via export conditions (#4397).
- https://github.com/denoland/deno/issues/35441 (closed): the tanstack-start init CLI prompts for permissions under Deno.

---

## 7. SolidStart

**(1) Bundler.**
- **v2** (`@solidjs/start` 2.0.5, 2026-09-10; peer `vite ^8 || ^9`): a plain Vite plugin (`solidStart()`) on the Vite Environment API. Deps are h3 v2 and srvx; there is no Vinxi.
- Deployment goes through `nitro()` from `nitro/vite` (Nitro v3), or the Netlify/Cloudflare Vite plugins (https://github.com/solidjs/solid-docs/blob/main/src/routes/solid-start/v2/(2)guides/(5)deployment-plugins.mdx).
- **v1**: Vinxi + Nitro v2 (`app.config.ts`, `server.preset`).

**(2) Adapter.**
- Nitro presets `deno_server`/`deno_deploy` (no Solid-specific Deno adapter).
- Deno Deploy: "SolidStart requires no additional setup… automatically configures Nitro".

**(3) Resolution plugin.** None. The Deno Solid tutorial (https://docs.deno.com/examples/solidjs_tutorial/) is a Vite SPA (`vite-plugin-solid`) with `deno add jsr:@hono/hono npm:@solidjs/router`, deno.json `imports` and no @deno/vite-plugin. Start is not covered.

**(4) `npm:`/`jsr:`.** Unsupported. With only a deno.json, vite-plugin-solid's `crawlFrameworkPkgs` (vitefu) finds no `package.json`, so Solid libraries are not `noExternal`'d or optimized. [V code; this matches #1990's symptom]

**(5) SSR externals.** Nitro (§4).

**(6) Issues.**
- https://github.com/solidjs/solid-start/issues/1990 (closed as a v1 bug, 2026-07): with deno.json instead of package.json, SSR throws `Client-only API called on the server side` from `@solidjs/router` (externalized client build).
- https://github.com/solidjs/solid-start/issues/2044 (closed): `vinxi build` spawns `node` (`dax: node: command not found`), so it fails when only Deno is installed.
- https://github.com/solidjs/solid-start/issues/1809 (closed): `deno-deploy` preset static assets are only served when run with cwd `.output`.
- https://github.com/denoland/deno-vite-plugin/issues/36 (closed): @deno/vite-plugin broke the solid-start build (a `\0vite` id encoded as `/%00vite`). A commenter says deno-vite-plugin PR #33 fixes it; closed.
- https://github.com/denoland/deno-vite-plugin/issues/40 (OPEN): `Module "npm:solid-bootstrap" has been externalized for browser compatibility` (also `npm:react`, `npm:lucide-react`). The workaround is `resolve.alias` from `npm:x` to `x`.
- https://github.com/nitrojs/nitro/issues/3026: SolidStart + `deno-deploy` + native addon.

---

## 8. Qwik / Qwik City

**(1) Bundler.** Vite. Qwik v1 is `@builder.io/qwik` / `@builder.io/qwik-city` 1.20.1 (2026-09-23). Qwik v2 is `@qwik.dev/core` / `@qwik.dev/router` 2.0.0-beta.45; the npm `latest` tag points to this beta. v2 starters use `build.rolldownOptions` (Vite 8).

**(2) Adapter.** In-repo and maintained (https://github.com/QwikDev/qwik):
- v1: `@builder.io/qwik-city/adapters/deno-server/vite` (`denoServerAdapter`) + `@builder.io/qwik-city/middleware/deno`.
- v2: `@qwik.dev/router/adapters/deno-server/vite` + `@qwik.dev/router/middleware/deno` (`createQwikRouter`).
- Added with `qwik add deno`, which creates `adapters/deno/vite.config.ts` and `src/entry.deno.ts`. Serve with `deno run --allow-net --allow-read --allow-env server/entry.deno.js`. Starter: https://github.com/QwikDev/qwik/tree/main/starters/adapters/deno. Docs: https://qwik.dev/docs/deployments/deno/.

**(3) Resolution plugin.** None. The Deno tutorial (https://docs.deno.com/examples/qwik_tutorial/, 2025-03) is `deno init --npm qwik@latest` with package.json/package-lock and no adapter.

**(4) `npm:`/`jsr:`.** Unsupported.

**(5) SSR externals** [V `lib/adapters/deno-server/vite/index.mjs`, both v1 and v2]:
- Config:
  - `resolve.conditions: ["webworker","worker"]`
  - `ssr: { target: "webworker", noExternal: true, external: ["node:async_hooks"] }`
  - `build.ssr: true`, ESM, `hoistTransitiveImports: false`
- So **everything is bundled**.
- The Deno middleware (`lib/middleware/deno/index.mjs`) contains `import { extname, fromFileUrl, join } from "https://deno.land/std/path/mod.ts"`. This is an **unversioned remote URL**; Vite keeps it external as a URL and Deno fetches it at runtime. It is present in both 1.20.1 and 2.0.0-beta.45 [V].

**(6) Issues.**
- https://github.com/QwikDev/qwik/issues/8616 (OPEN, 2026-05): with deno.json(c) and no package.json, "Qwik core bundle not found" and "could not read /package.json to determine package name".
- https://github.com/QwikDev/qwik/issues/8364 (closed): Deno as package manager breaks the production build. Causes: `qwik build` uses execa (`addAbortListener`), `static/deno` SSG is a stub ("Deno not implemented"), and the client manifest.
- https://github.com/QwikDev/qwik/issues/8546 (closed): v2 intermittent Rollup "Unexpected early exit… `\^@virtual:qwik-router-server-fns`" only under Deno.
- https://github.com/QwikDev/qwik/issues/7813 (closed): the optimizer called `Deno.platform()` (a removed API).
- https://github.com/QwikDev/qwik/issues/7697 (closed): absolute `outDir` `/dist` under Deno (EACCES).
- https://github.com/QwikDev/qwik/issues/7520 (closed): the `deno start` hello-world was broken.
- https://github.com/denoland/deno/issues/29624 (closed): `@qwikdev/astro` entry was unresolvable after `deno install` (symlinked layout).

---

## 9. Contrast: Fresh 2, the only framework that resolves Deno specifiers in both builds

- `packages/plugin-vite/src/plugins/deno.ts` in https://github.com/denoland/fresh (local clone 86d6cde).
- It creates two `@deno/loader` `Workspace` loaders: SSR with `platform:"node"`, and browser with `platform:"browser", preserveJsx:true`. Both use `cachedOnly: true`, so `deno install` is required.
- Plugin settings: `enforce:"pre"`, `sharedDuringBuild:true`, `applyToEnvironment(){return true}`.
- resolveId:
  - builtins become `node:` external;
  - it calls `this.resolve()` first and returns early if another plugin resolved the id, if it is external non-http, or if it is `\0`-prefixed;
  - otherwise it calls `loader.resolve(id, importerFileUrl)`; results that are `jsr:`/`npm:`/`https:`, or non-JS types, become a virtual `\0deno::<type>::<specifier>` id; files become absolute paths.
- load: `loader.load()`, plus a Babel JSX transform.
- Result: `jsr:`, `npm:`, `https:` and import-map aliases are **bundled into both client and server outputs**. Only `node:` stays external.

---

## 10. Implications for a multi-bundler Deno plugin (unplugin)

1. **Be additive to node_modules resolution.** Frameworks will keep relying on Vite/Rollup Node resolution with `nodeModulesDir` + `deno install`. The plugin should handle only `npm:`, `jsr:`, `https:`, deno.json/workspace aliases and workspace members, and leave the rest alone. Provide an option to fall back to node_modules for `npm:` (strip `npm:` → bare name → normal resolution) so npm packages in client builds dedupe with framework deps. This is the deno-vite-plugin #40 workaround.
2. **Resolve order and virtual modules.** Call `this.resolve(id, importer, {skipSelf:true})` first; this is Fresh's approach. Never hand these to the Deno resolver:
   - `\0` ids;
   - ids with a `virtual:` / `astro:` prefix;
   - `$app/*`, `$env/*`, `#imports`, `~/` framework aliases;
   - ids with a `?query`;
   - any scheme outside an allowlist.
   This is the fix needed for deno-vite-plugin #101 and #36.
3. **SSR external policy should be configurable per environment.**
   - (a) bundle (Fresh / Qwik / Nitro deno-deploy style);
   - (b) keep `jsr:`/`npm:`/`https:` external, as static imports (for Deno Deploy's `--cached-only`), optionally pinned to the version in deno.lock / the installed tree (Nitro #4618);
   - (c) rewrite bare externals to `npm:<name>@<version>` (the Nitro v2 legacy approach), so output runs without node_modules.
4. **Replace package.json-derived heuristics.** Synthesize the framework-package lists (vitefu-style `ssr.noExternal` / `optimizeDeps.include`) from deno.json `imports` and the lockfile, or document a stub `package.json`. This fixes the Astro #67, solid-start #1990 and kit #14555 class of bugs.
5. **Conditions.** When the SSR output will run on Deno, add the `deno` condition to SSR `resolve.conditions` and `externalConditions`. That keeps build-time and runtime resolution consistent (react-dom/server, srvx) and matches the React Router template and Nitro #4397.
6. **Stable ids.** Return canonical absolute filesystem paths, not `file://` URLs or alias-derived ids, to avoid duplicate module instances (react-router #14258, deno #28326).
7. **Config files.** Document Vite `configLoader: 'native'` (Vite 8.3) and bundler-specific equivalents for deno.json aliases in config files. A plugin cannot fix this (astro #17738).

---

## 11. Not verified / gaps

- How Deno Deploy "automatically configures Nitro" (env var? which preset? Nitro v2 vs v3) is not documented in deno-docs.
- Whether Astro 7 (Vite 8) still leaves node_modules deps as bare externals in `dist/server`. The evidence (#47, #51, astro #14297) is from the Astro 5 era.
- The exact Vite 8 error for `npm:x`/`jsr:x` without a plugin is inferred from `bareImportRE`/`externalRE` in the source. It was not executed.
- React Router 8.3+ dev restart (`NODE_OPTIONS=--conditions=development`) under Deno was not tested.
- The Qwik v2 middleware's unversioned `https://deno.land/std/path/mod.ts` on Deno Deploy (`--cached-only`) was not tested.
- TanStack Start + Rsbuild SSR external policy on Deno.
- The Remix 3 (3.0.0-rc.3) Deno story was not investigated.
- The Deno Deploy runtime doc (https://docs.deno.com/deploy/reference/runtime/, modified 2026-06-18) says "Custom flags, including `--unstable-*` flags, cannot be passed". So flags such as Nitro v2's `--unstable-byonm` must come from deno.json. Consequences were not tested.
