# Vite group — prior-art research for `unplugin-deno`

Research date: 2026-09-25. Machine: macOS, Deno 2.9.7, Node 26.8.1, latest Vite 8.3.1 (Rolldown 1.2.x).
All paths below are relative to `$SCRATCH = /private/tmp/claude-501/-Users-divyansh-unplugin-deno/1a551bae-bee4-41ac-ba89-ea42b9e7cb9a/scratchpad`.

Method: shallow clones + full issue/PR dumps via `gh`, JSR sources fetched per version, and **hands-on experiments** under
`$SCRATCH/exp/*` (official plugin 2.0.3 ≡ 2.0.4 source, Vite 8.3.1, Deno 2.9.7; 2.0.4 itself was blocked by Deno 2.9's
default 24h `minimumDependencyAge`). Claims marked **[verified]** were reproduced locally; **[code]** means derived from
reading source; **[issue]** means reported by users.

---

## 0. TL;DR

* There are really only **three architectures** in the Vite group:
  1. **"Ask Deno" resolvers** — shell out to `deno info --json` (official v1, deno-plc, lockness, anatoo, itsdouges) or
     call Deno's resolver in-process via WASM `@deno/loader` (official v2, Fresh's in-house plugin, str4ngeMD fork).
     They mint virtual ids (`\0deno::<MediaType>::<id>::<resolved>#deno`) and serve remote/JSR code themselves.
  2. **"Rewrite to node_modules"** — never load Deno code; rewrite `npm:` to bare names and let Vite's Node resolver +
     optimizer handle them (official plugin's `npm:` path), or alias `deno.json` import-map keys to
     `node_modules/@jsr/<scope>__<name>` npm-compat tarballs (transitionsag).
  3. **Custom npm implementation** — read tarballs from `$DENO_DIR/npm/registry.npmjs.org/…`, resolve `exports` with
     `resolve.exports`, convert CJS→ESM with lebab in a worker pool (deno-plc). Fragile.
* The official **`@deno/vite-plugin` 2.x** (npm, 10.4k downloads/week) is the de-facto standard (create-vite-extra Deno
  templates, Deno docs React/Vue/Solid tutorials) but has real, reproducible defects:
  `npm:pkg@x/subpath` loses the subpath **[verified]**; any late-resolved `virtual:`/custom-scheme id crashes the build
  (`Unsupported scheme "virtual"`), and since 2.0.3 even `\0`-prefixed ids like Vue's `\0plugin-vue:export-helper` do
  (URL parsing strips the NUL) **[verified]**; deno.json import-map entries lose to same-named packages in
  `node_modules` (plugin is not `enforce:"pre"` for bare ids) **[verified]**; workspace-member entry files outside the Vite
  root become virtual modules with **no HMR and stale content** **[verified]**; `https:` imports in client source are left
  raw for the browser in dev (network fetch, no lockfile/integrity, import attributes dropped) **[verified]**; JSR code is
  never pre-bundled (one request per JSR file) **[verified]**; without `node_modules`, CJS npm packages are served raw to
  the browser in dev **[verified]**; `import.meta.resolve` "import-map heuristic" is dead code/harmful (it resolves from
  the plugin's own `node_modules` location, never consults deno.json) **[verified]**; Vite query suffixes are dropped on
  aliased imports (`@/icons.svg?raw` becomes an asset URL) **[verified]**.
* **Fresh 2 does not use `@deno/vite-plugin`**; it ships its own `@fresh/plugin-vite/src/plugins/deno.ts`
  (enforce `pre`, two `@deno/loader` loaders — SSR `platform:"node"`, client `platform:"browser"`+`preserveJsx`,
  `cachedOnly:true` — import-attribute aware, Babel JSX), and sets `resolve.noExternal: true` +
  `optimizeDeps.noDiscovery: true`. PR #93/#98 in the official repo were attempts to converge; #98 is still open.
* Most-demanded features across issue trackers: **workspaces/member import maps** (#19 #41 #47 #53 #54 #57 #77, str4ngeMD,
  transitionsag), **npm deps of JSR packages** (#40 #74 #77, PR #88), **subpaths & `@jsxImportSource npm:`**
  (#58 #59 #98), **performance/concurrency** (#50 #55 #63 PR #61, masslbs fork), **Windows** (#48 #57 #68 #72 #75 #86),
  **SSR / ssrLoadModule** (#54 #56, Vite #20828 #20850), **other plugins' virtual modules** (#75 #80 #101, TanStack/Vue/
  Astro/react-router/windicss), **CSS/asset aliasing & `?raw`** (#17 #22 #42 #100 PR #85), **Vitest / Vitest browser mode**
  (#23 #29 #47 #60 #90), **making it an unplugin** (#34, open since 2024-12).
* Vite 8 facts that matter for the design: Rolldown+Oxc by default (8.0.0, 2026-03-12); `vite:resolve` is a **native
  Rust plugin** (`viteResolvePlugin` from `rolldown/experimental`) that runs *before* user `normal` plugins;
  `experimental.enableNativePlugin` was removed; hook filters (`{ filter: { id }, handler }`) supported since Vite 6.3 /
  Rollup 4.38; `load`/`transform` may return `moduleType` and Vite guesses it from the id's extension otherwise;
  per-environment `resolve.builtins`/`external`/`noExternal`; `optimizeDeps.rolldownOptions` replaces `esbuildOptions`.

---
## 1. How Vite itself relates to Deno (Vite repo @ `bc598a6`, v8.3.1, cloned at `repos/vite`)

### 1.1 Deno-specific code in Vite core

| Location (in `repos/vite/packages/vite/src/node/`) | What it does | Landed |
|---|---|---|
| `config.ts:2541` `bundleAndLoadConfigFile` | `isESM = typeof process.versions.deno === 'string' \|\| isFilePathESM(...)` — config is always ESM under Deno | PR #18081/#18158 (merged 2024-09) |
| `config.ts:2782-2786` `loadConfigFromBundledFile` | Under Deno the bundled temp config is **not** written into `node_modules/.vite-temp` "because Deno only supports Node.js style modules under node_modules/ and configs with `npm:` import statements will fail" — it is written next to the config, so Deno applies the project import map to it | PR #18823 (6.0.2) |
| `config.ts:1885-1900` cacheDir | If no `package.json` but `node_modules/` exists ("Deno projects using npm packages") use `node_modules/.vite` | PR #21777 (8.1.0) |
| `server/searchRoot.ts:38-90` `hasWorkspaceDenoJSON` | `searchForWorkspaceRoot` recognizes `deno.json`/`deno.jsonc` with a `workspace` field (affects default `server.fs.allow`, needed because npm pkgs live in root `node_modules/.deno`). Only valid-JSON `deno.jsonc` is detected (no JSONC parser) | PR #22238 (8.0.9) |
| `nativeConfigCompat.ts:294` | native-config-compat check treats everything as ESM under Deno | 8.x |
| `utils.ts:103-135` | `nodeLikeBuiltins = [...nodeBuiltins, /^node:/, /^bun:/]` ("Supported by Node, Deno, Bun"). `npm:` is **not** a builtin since PR #20558 (7.1.2) — before that, `npm:` specifiers were treated as builtins and never reached plugins (reported by the Deno team while revamping their plugin) | 7.1.2 |
| `utils.ts:973` | `dns.getDefaultResultOrder` workaround for Deno/Bun | 8.0.x |
| `plugins/css.ts:2351,3437` | Deno returns `Uint8Array` for lightningcss `res.code` | — |

Nothing in Vite knows about `deno.json` imports, `jsr:`, `https:` module loading, or `deno.lock`.

### 1.2 Vite docs & scaffolding
* `docs/guide/index.md` only shows `deno init --npm vite`, `deno add -D npm:vite`, `deno run -A npm:vite`;
  `docs/guide/migration.md` shows `deno add -D npm:@rolldown/plugin-babel …`. No mention of `@deno/vite-plugin`.
* `create-vite` (`packages/create-vite/src/index.ts:1087-1152`) only special-cases the printed commands for Deno
  (`deno run -A npm:create-…`); all templates are `package.json`-based. `deno init --npm vite` ⇒ runs `npm:create-vite`.
* The **Deno templates live in `bluwy/create-vite-extra`** (`template-deno-{react,vue,preact,solid,svelte,lit,vanilla}[-ts]`,
  updated 2026-09-09): `deno.json` imports `"@deno/vite-plugin": "npm:@deno/vite-plugin@^2.0.2"`,
  `"vite": "npm:vite@^8.2.2"`, tasks `deno run -A --node-modules-dir npm:vite`, and `vite.config.js` =
  `plugins: [deno(), react()]`.
* Deno's own docs: `examples/tutorials/vite.md` (updated 2026-06-13) uses plain `create-vite` + `package.json`
  (**no Deno plugin**); `examples/tutorials/{react,vue,solidjs}.md` use `@deno/vite-plugin` with
  `optimizeDeps.include: ["react/jsx-runtime"]` (copy-pasted even into the Vue tutorial).

### 1.3 Open Vite issues that constrain a Deno resolver
* **#20828** `ssrLoadModule` errors on non-npm packages — `ssr/fetchModule.ts:45-78` assumes any bare specifier left in
  SSR output is an npm package and runs `tryNodeResolve(url, importer, {conditions: externalConditions})`; import-map
  / JSR bare names externalized by Vite ⇒ "Cannot find module '@std/path'". https://github.com/vitejs/vite/issues/20828
* **#20850** `external: true` returned from `resolveId` is ignored in the ssr env ("Failed to load url npm:preact").
  https://github.com/vitejs/vite/issues/20850
* **#20003** support loading `npm:`-prefixed JSR-style specifiers + CJS transpile; bluwy redirected to the Deno plugin;
  reporter notes pre-bundling runs before/independently of plugins. https://github.com/vitejs/vite/issues/20003
* Tangential (matched the search only via envinfo): #22845 modulepreload not resolved for plugin-resolved ids,
  #22864 `experimental.bundledDev` fails to resolve virtual modules, #21088 transitive deps excluded from pre-bundling
  resolved from project instead of importer, #12366 import files as bytes (≈ Deno `with {type:"bytes"}`).

### 1.4 Vite 7/8 features relevant to a resolver plugin
* **Rolldown is the default in Vite 8.0.0 (2026-03-12)**; current 8.3.1 (2026-09-24). `rolldown-vite` was the Vite 7
  preview. `experimental.enableNativePlugin` (incl. `'resolver'`) was **removed** during the 8.0 betas (CHANGELOG #21510);
  native plugins are always on: `vite:resolve` is `viteResolvePlugin` from `rolldown/experimental`
  (`plugins/resolve.ts:260`), with a JS callback `finalizeBareSpecifier` for optimizer integration. Plugins cannot extend
  the native resolver's lookup (e.g. add DENO_DIR roots) — only intercept earlier with `enforce:'pre'`.
* **Plugin order** (`plugins/index.ts` `resolvePlugins`): `[vite:optimized-deps, watch-package-data, vite:pre-alias, alias,
  ...user 'pre', vite:modulepreload-polyfill, vite:resolve (native), html-inline-proxy, css, oxc, json, wasm, worker, asset,
  ...user normal, ...]` ⇒ a non-`pre` resolver only sees ids Vite **failed** to resolve. This is the
  root cause of the official plugin's import-map-precedence bug (§2.6).
* **Hook filters** (`docs/guide/api-plugin.md:708`): `resolveId/load/transform: { filter: { id, code?, moduleType? },
  handler }`, supported by Vite ≥ 6.3 and Rollup ≥ 4.38; must also re-check inside the handler for older hosts.
  Helpers `exactRegex`/`prefixRegex` in `@rolldown/pluginutils` (re-exported from `rolldown/filter`). Fresh already uses
  `resolveId: { filter: { id: /^(?!\0|[\\/]@fs[\\/]|fresh-island::|fresh:)/ } }`.
* **`moduleType`** (`docs/guide/migration.md:314`, `server/transformRequest.ts:265-360,540-575`): `load`/`transform` may
  return `moduleType` (`js|jsx|ts|tsx|json|text|css|…`); otherwise Vite/Rolldown guess it by scanning the id for a
  known extension suffix (`getModuleTypeFromId` walks every `.`; the remainder must equal an extension, so a
  `…/mod.ts#deno` suffix yields `undefined` ⇒ `js`). Converting content to JS requires `moduleType:'js'`.
  Returning `moduleType:'ts'|'tsx'` lets Oxc do the TS/JSX transform with the user's `oxc.jsx` config.
* **Environment API** (`docs/guide/api-environment-plugins.md`): `this.environment` in all hooks
  (`.name`, `.config.consumer` = `'client'|'server'`), `applyToEnvironment(env) => boolean | PluginOption`,
  `perEnvironmentPlugin(name, factory)`, `sharedDuringBuild: true` for one instance across envs during `buildApp`.
* **Per-environment resolve options** (`plugins/resolve.ts:80-104`, `config.ts:1205-1225`): `resolve.conditions`,
  `externalConditions` (default `['node','module-sync']`), `mainFields`, `external`, `noExternal`, and
  **`resolve.builtins`** — default for `consumer:'server'` is `nodeLikeBuiltins` (`[]` for webworker + `noExternal:true`).
  `fetchModule` externalizes anything matching `builtins` **before** its Node resolution ⇒ adding `/^npm:/`, `/^jsr:/`
  to SSR `resolve.builtins` when Vite runs *under Deno* would let the module runner hand `npm:`/`jsr:` specifiers to
  Deno's native loader (unexplored idea; nobody does this yet).
  Default client conditions: `DEFAULT_CONDITIONS` minus `node`; server: minus `browser`. **`deno` is never a default
  condition** — users add it manually (see issue #56's config: `conditions: ["module","deno","node",…]`).
* **`resolve.tsconfigPaths`** (8.x) and `resolve.alias[].customResolver` deprecated → "use a plugin with
  `enforce:'pre'`".
* **Optimizer**: `optimizeDeps.rolldownOptions` (esbuildOptions auto-converted, deprecated), `include/exclude/
  noDiscovery`. The dependency **scanner** (`optimizer/scan.ts:225,379`) resolves through the full environment plugin
  container (so a Deno plugin takes part in discovery), but the **bundling** step (`optimizer/rolldownDepPlugin.ts:94-110`)
  resolves with `createBackCompatIdResolver` (alias + native resolve only) plus `optimizeDeps.rolldownOptions.plugins`
  ⇒ JSR/https modules resolved to plugin virtual ids are never pre-bundled unless the Deno resolver is also injected into
  `optimizeDeps.rolldownOptions.plugins` (a natural fit for an unplugin that can emit a Rolldown plugin).
* **`experimental.bundledDev`** (full-bundle dev mode) exists; open bugs with virtual modules (#22864).
* **Config loading**: `--configLoader bundle|runner|native` (6.1+). Under Deno, `native` loads `vite.config.ts`
  through Deno itself so import maps, `jsr:` and JSR-hosted plugins work in the config file (Lockness relies on it).
  The official README's "Deno resolution cannot be used in vite.config.ts" limitation predates this.
* `createIdResolver` (exported from `vite`) — Vite-configured id resolver (`idResolver.ts`: only `@rollup/plugin-alias`
  with `resolve.alias` + the native resolve plugin — **no user plugins**). Vite's **CSS pipeline** (`plugins/css.ts:317,
  1378-1417`: CSS `@import`, Sass `@use`, Less, `url()`) resolves through it, so a `resolveId`-only Deno plugin can never
  make import-map aliases work inside CSS/SCSS (official #22 still open); only entries pushed into `resolve.alias`
  (transitionsag's approach) or a CSS transform (transitionsag 0.3–0.4 rewrote `@import "<alias>"`) can.
  `ModuleRunner`/`RunnableDevEnvironment` — SSR dev runner; runs fine inside Deno.

---
## 2. `@deno/vite-plugin` (official) — deep dive

Clone: `repos/deno-vite-plugin` (HEAD `4edcf6f`, 2026-09-25). Experiments: `exp/official`, `exp/official-202`, `exp/official-nonm`, `exp/ws`.

### 2.1 Identity
* Repo https://github.com/denoland/deno-vite-plugin — MIT, created 2024-09-20, **116★, 22 forks**, last push
  2026-09-24, not archived. Registry: **npm only** (`@deno/vite-plugin`); JSR publication was declined in #35
  ("easier for folks new to Deno").
* npm maintainers: `ry`, `divy-work`, `denobot`, `bartlomieju`. Commit authors: Marvin Hagemeister (26, original author;
  states on PR #88 he no longer works at Deno and has no permissions), Bartek Iwańczuk (13, current maintainer; his 2026
  PRs #91–#98 are Claude-Code-generated), swcarter007 (2), others 1 each.
* Versions: 0.0.1 (2024-09-20) … 1.0.0 (2024-09-27), 1.0.1 (2024-11-27), 1.0.2 (2024-12-06), 1.0.3 (2025-01-30),
  1.0.4 (2025-02-14), 1.0.5 (2025-06-23), 1.0.6 (2025-12-18), **2.0.0–2.0.2 (2026-03-30)**, 2.0.3 (2026-07-27),
  **2.0.4 (2026-09-24, deps only)**.
* Downloads: **10,360/week**, 52,455/month (npm API, Sept 2026). Notable dependents found via code search: create-vite-extra
  Deno templates, `denoland/tutorial-with-react`, `denoland/react-vite-ts-template`, Floorp, Stellar-Wallets-Kit,
  zypher-agent (49 repos matched `"@deno/vite-plugin"` in code search).
* Activity: bursty. 2025 had months-long gaps with community PRs rotting (#61 open since 2025-04, #88 since 2026-03);
  2026 revival by Bartek (loader rewrite, Vite 8, env API, workspace fix, OIDC publishing).
* Package: ESM-only, `exports: { ".": { import: "./dist/index.js" }, "./resolver": {types, import} }` — no `default`/
  `require` condition (see #60). Deps: `@deno/loader` = `npm:@jsr/deno__loader@^0.5.0` (WASM, top-level await),
  `@std/jsonc` = `npm:@jsr/std__jsonc@^1`; `.npmrc` `@jsr:registry=https://npm.jsr.io`. Peer: `vite: 5.x || 6.x || 7.x || 8.x`
  (PR #93's "drop Vite 5/6" text was not applied; CI still tests 5–8).

### 2.2 Changelog (GitHub releases + commits)
| Version | Changes |
|---|---|
| 0.0.1–0.0.4 | prototype; `deno info` typo (#4); http resolution (#7); node ESM (#10) |
| 1.0.0 | packaging (#12) |
| 1.0.1 | mapped directories (`"mapped/": "./mapped/"`) in import map (#25) |
| 1.0.2 | Vite 6 (#27) |
| 1.0.3 | skip `kind: external` (#33, fixed SolidStart `\0vite/preload-helper.js` #36); `execFile` escaping for `#`-prefixed mappings (#32, #31); empty-string sourcemap → `null` (#39, #38/#29) |
| 1.0.4 | keep resolved in-root paths as plain paths (#43) — fixes aliased local TSX bypassing `@vitejs/plugin-react` ("React is not defined", #42) |
| 1.0.5 | Windows path normalization (#68) |
| 1.0.6 | Vite 7 peer (#76); ignore `\0` Vite internals (#80, fixes #75) |
| **2.0.0** | Vite 8 (#91: `transformWithOxc`/`transformWithEsbuild` instead of own esbuild dep, fixes #89); JSON modules as ESM (#82, #52); **replace `deno info` with `@deno/loader`** (#92, fixes #18 #50 #55 #63 #72 #86, "likely" #15 #48 #90); **Environment API + `onLoad` + https import rewriting** (#93, "features needed for Fresh") |
| 2.0.1/2.0.2 | version fixes |
| 2.0.3 | honor workspace-member-scoped import maps (#102); npm trusted publishing via OIDC (#104, #105) |
| 2.0.4 | dependency security bumps (#107); CI pinned to npm 11 because npm 12 refuses `npm.jsr.io` tarballs (`EALLOWREMOTE`) |

### 2.3 v1 architecture (≤1.0.6, for contrast — `git show e04b1a7:src/resolver.ts`)
* One `execFile("deno", ["info","--json", id], {cwd: root})` **per specifier**, no concurrency limit, default 1 MB
  `maxBuffer`; `deno --version` probed once; stderr "Integrity check failed" rethrown, all other failures ⇒ "not
  resolvable". Result mapping: `esm` ⇒ `{id: mod.local, loader: mediaType, dependencies}`, `npm` ⇒ `{id: npmPackage}`,
  `external` ⇒ null, anything else ⇒ `throw Unsupported` (broke on `asserted` JSON #52).
* Sub-imports of a Deno module were resolved from the cached parent's `dependencies[].code.specifier` (a graph-aware
  trick), load = `fs.readFile(mod.local)` + esbuild transform.
* Failure catalogue (all closed by 2.0): OOM/>8 GB from hundreds of concurrent `deno info` (#50; builds 1.3 s → 27 s),
  1 MB stdout truncation for big graphs like Mantine (#63; 7.3 MB of JSON), `vendor: true` ⇒ no `local` field (#18),
  `#` treated as shell comment (#31), Deno 2.3.6 changed `deno info --json` output (no `roots`) ⇒ "Cannot read
  properties of undefined (reading '0')" (#75), Windows `deno.exe` vs npm-shim `deno.ps1` (#86), Windows Server exec
  args (#72), Windows cache-key separators (#57).

### 2.4 v2 architecture (2.0.x) — how it actually works [code]
Returns **three plugins** (`src/index.ts:146-157`):

1. **`deno:config`** — `configResolved`: `findDenoConfig(config.root)` (`src/index.ts:72-99`) walks up from the Vite
   root, remembers the nearest `deno.json`/`deno.jsonc` but returns the **first ancestor with a `workspace` field**
   (so a standalone app nested under an unrelated workspace root picks the outer config). No option to override.
2. **`deno:prefix`** (`src/prefixPlugin.ts`) — `enforce:"pre"`, `sharedDuringBuild:true`, `applyToEnvironment(){return
   true}` (with `@ts-ignore` for Vite <7). `resolveId`: strips `deno-http::`; **`npm:`** ⇒ `resolveDeno` ⇒ bare
   package name ⇒ `this.resolve(name)` (Vite's resolver ⇒ `node_modules`) ⇒ `return result ?? name` (unresolvable ⇒
   bare string id ⇒ Vite "externalized for browser compatibility", #40/#74/#77); **`http(s):`** ⇒ `resolveViteSpecifier`.
3. **`deno`** (`src/resolvePlugin.ts`) — *normal* order (runs after the native `vite:resolve`), shared, all envs.
   `resolveId` ⇒ `resolveViteSpecifier`; `load` ⇒ only `\0deno…` ids.

Per-environment state (`src/index.ts:101-144`): `Map<envName, Promise<Loader>>` created lazily with
`new Workspace({...workspaceOptions, ...environments[env], configPath}).createLoader()` and a
`Map<envName, Map<specifier, DenoResolveResult>>` resolution cache; env key = `this.environment?.name ?? "__default__"`.

`resolveViteSpecifier(id, cache, root, loader, importer)` (`src/resolver.ts:189-294`):
1. **member referrer** (2.0.3): if `importer` is a real absolute path (not `\0deno`, not `/@…`, not under
   `/node_modules/`) and `id` is bare, `id = loader.resolveSync(id, file://importer)`. No guard for `\0…`/`virtual:` ids —
   and because the WHATWG URL parser strips leading C0 controls, `\0plugin-vue:export-helper` "resolves" to
   `plugin-vue:export-helper`, losing the `\0` that step 4 relies on [verified regression vs 2.0.2].
2. **`import.meta.resolve(id)` "import-map heuristic"** — **[verified] never consults deno.json**: it runs inside
   `node_modules/.deno/@deno+vite-plugin@…/dist/resolver.js`, so under both Deno and Node it Node-resolves from the
   plugin's own location (`preact`, `vite` ⇒ `file:///…/node_modules/.deno/…`), and throws for import-map keys
   (`@std/path`, `@/util.ts`). Leftover from v1.
3. if `importer` is a `\0deno` id: `loader.resolveSync(id, parentUrl)`; `file://` results are handed back to Vite as
   plain paths (Vite pipeline + HMR for them).
4. `cache.get(id) ?? resolveDeno(id, loader)` (`src/resolver.ts:75-159`): ignore `\0`; `resolveSync(id, undefined)`;
   `jsr:`/`http(s):` ⇒ `await loader.addEntrypoints([resolved])` (incremental graph, **one call per new specifier, no
   batching, diagnostics ignored**) then `resolveSync` again ⇒ `https://jsr.io/@s/p/<ver>/file.ts`; `npm:` ⇒
   `{id: bareName, kind:"npm"}` (**version and subpath discarded**); `node:` ⇒ null; `file://` ⇒ media type from
   extension; any other scheme ⇒ `await loader.load(url)` **just to learn the media type** (then loaded again in `load`)
   ⇒ unknown schemes throw a plain `Error` ⇒ build crash.
5. `kind:"npm"` ⇒ `return null` (let Vite resolve the *original* bare id via node_modules).
6. plain path if local and (unknown media type or inside Vite root); else virtual id
   **`\0deno::<TypeScript|TSX|JavaScript|JSX|Json>::<original id>::<resolved path|URL>#deno`** (`#deno` suffix added so
   `vite:json` & friends don't match by extension; in the browser it becomes a URL fragment, still works).

`load` (`src/resolvePlugin.ts:65-113`): `loader.load(url, RequestedModuleType.Default)` — **@deno/loader transpiles**
TS/TSX/JSX with the Deno config's `compilerOptions` (JSX mode/import source) unless `preserveJsx`/`noTranspile`,
returns source maps (loader ≥0.5.0) ⇒ regex `rewriteHttpImports` (`HTTP_IMPORT_RE =
/(?:from\s+|export\s+.*?from\s+|import\s*\()(['"])(https?:\/\/[^'"]+)\1/g` ⇒ `deno-http::https://…`, so Vite's SSR
module runner doesn't externalize it as `network`; documented limits: template literals, false positives in
comments/strings) ⇒ `onLoad(ctx)` ⇒ JSON ⇒ `export default ${code}` (no map). Never returns `moduleType`, never calls
`addWatchFile`, import attributes ignored (always `RequestedModuleType.Default`; `text`/`bytes` unsupported).

### 2.5 Configuration surface (complete — `src/index.ts:17-65`)
```ts
export default function deno(options?: DenoPluginOptions): Plugin[];
interface DenoPluginOptions {
  environments?: Record<string, Omit<WorkspaceOptions, "configPath">>; // per Vite env name, e.g. ssr: {platform:"node"}
  workspaceOptions?: Omit<WorkspaceOptions, "configPath">;              // defaults for all envs
  onLoad?: (ctx: LoadContext) => OnLoadResult | Promise<OnLoadResult>;  // post-transpile hook
}
interface LoadContext { code: string; id: string; mediaType: MediaType; environment: string; ssr: boolean }
type OnLoadResult = { code: string; map?: string | null } | null | undefined | void;
// @deno/loader 0.5 WorkspaceOptions: noConfig?, noLock?, configPath?, nodeConditions?: string[],
// newestDependencyDate?: Date, platform?: "node" | "browser" (default "node"), cachedOnly?, debug?,
// preserveJsx?, noTranspile?
```
No `configPath`/`root`, `include`/`exclude`, `external`, `alias`, lockfile, `nodeModulesDir`, logging or cache options.
Note the default `platform:"node"` also applies to the **client** environment unless the user overrides it.
Subpath export `@deno/vite-plugin/resolver` exposes `resolveDeno`, `resolveViteSpecifier`, `toDenoSpecifier`,
`parseDenoSpecifier`, `DENO_HTTP_PREFIX`, … "for downstream consumers (e.g. Fresh)".

### 2.6 Hands-on verification (Vite 8.3.1, plugin 2.0.3 = 2.0.4 source, Deno 2.9.7 / Node 26.8.1)
| # | Scenario (`exp/official*`, `exp/ws`) | Result |
|---|---|---|
| 1 | build under Deno: import-map `jsr:` (`@std/path`), inline `jsr:@std/encoding@^1/base64`, import-map `npm:` (`preact`), inline `npm:preact@^10.24.0`, alias `@/util.ts`, `https://jsr.io/@std/path/1.1.2/deno.json with {type:"json"}` | ✅ 83 modules; JSR code appears as `//#region \0deno::TypeScript::https://jsr.io/@std/path/1.1.6/…#deno`; loader prints `Downloading https://jsr.io/…` (fetches on demand, not `cachedOnly`) |
| 2 | inline `import { useState } from "npm:preact@^10.24.0/hooks"` | ❌ `Missing export useState` — resolved to `preact` (subpath dropped). Open PR #98 |
| 3 | build under **Node** with `vite.config.ts` in a dir without `package.json` | ❌ "Failed to resolve @deno/vite-plugin. This package is ESM only but it was tried to load by `require`" (#60). With `vite.config.mts` ✅ byte-identical output in 184 ms ⇒ the WASM loader works under Node |
| 4a | an `enforce:"post"` plugin resolving `virtual:my-mod` → `\0virtual:my-mod` | ❌ `[plugin deno] Error: Unsupported scheme "virtual" for module "virtual:my-mod"` — **same on 2.0.2 and 2.0.3** (pre-existing since the 2.0.0 loader rewrite; = #101 Astro) |
| 4b | transformed code imports `"\0plugin-x:helper"`, resolved by an `enforce:"post"` plugin (what `@vitejs/plugin-vue`'s `\0plugin-vue:export-helper` does) | ✅ 2.0.2; ❌ **2.0.3/2.0.4** `Unsupported scheme "plugin-x"` — regression from #102: the new member-referrer path has no `\0` guard and the WHATWG URL parser strips the leading U+0000, so `\0plugin-x:helper` becomes `plugin-x:helper` and slips past `resolveDeno`'s `\0` check (= #102 comments: Vue, react-router, TanStack) |
| 5 | deno.json `"preact": "./src/fake-preact.ts"` while `node_modules/preact` exists | ❌ real `node_modules/preact` bundled — import map silently ignored because `vite:resolve` runs first |
| 6 | dev server, `GET /src/main.ts` | JSR ⇒ `/@id/__x00__deno::TypeScript::https://jsr.io/@std/path/1.1.6/mod.ts::…#deno`; `@std/path/mod.ts` re-exports ~30 files ⇒ ~30 un-bundled requests; npm ⇒ `/node_modules/.vite/deps/preact.js` (pre-bundled); **`https://…/deno.json` left raw** for the browser (Vite's import analysis skips external URLs), and the `with {type:"json"}` attribute is gone |
| 7 | `nodeModulesDir: "none"`, build | ✅ npm packages loaded from DENO_DIR as `\0deno::JavaScript::file:///…/Caches/deno/npm/registry.npmjs.org/preact/10.29.8/dist/preact.mjs#deno`; config load prints `UNRESOLVED_IMPORT … treating it as external` warnings but works (Vite writes the temp config beside the file and Deno applies the import map) |
| 8 | `nodeModulesDir: "none"`, dev, `import { useState } from "react"` | ❌ React served as raw CJS (`module.exports = require("./cjs/react.development.js")`) — no pre-bundling/CJS interop for loader-resolved npm code (cf. #87, fixed by user with `nodeModulesDir: auto`) |
| 9 | workspace: Vite root `app/`, `@scope/lib` member via import map; member uses its own `#lib/` alias + `jsr:` dep | ✅ resolves (2.0.3 fix). `lib/mod.ts` becomes a `\0deno::TypeScript::file:///…/lib/mod.ts#deno` virtual module; its `#lib/helper.ts` import becomes `/@fs/…/helper.ts`. Editing `helper.ts` ⇒ page reload; **editing `lib/mod.ts` ⇒ nothing, and the dev server keeps serving stale code** |
| 10 | `vite build --ssr src/server.ts` | ✅ npm externalized as bare `import { h, render } from "preact"` (inline `npm:` collapsed); JSR bundled inline (JSDoc kept); runs on Node and Deno when `node_modules` exists |
| 11 | `import a from "@/icons.svg?raw"` (import-map alias) vs `"./icons.svg?raw"` | ❌ alias path loses `?raw` (`fileURLToPath` drops the query) ⇒ `a` is a `data:image/svg+xml,…` asset URL, `b` is the SVG text (#100, PR #85) |

### 2.7 Feature matrix
| Feature | Status |
|---|---|
| `jsr:` (inline + import map, transitive) | ✅ via loader; always a virtual module; TS transpiled by Deno (not Vite) |
| `npm:` inline | ⚠️ rewritten to bare name, version + subpath dropped (#98), peer/multi-version impossible ("TODO: Resolving custom versions is not supported"), needs `node_modules`; unresolvable ⇒ silent externalization (#40) |
| `npm:` via import map | ✅ if in root `node_modules` (Vite resolves the bare id); member-scoped npm deps not handled (PR #102 "not covered") |
| `npm:` deps *inside* JSR packages | ⚠️ resolved from project root `node_modules`; fails when only transitively installed (#40, #74, #77) |
| `https:`/`http:` | ✅ build; ⚠️ client dev leaves raw URLs (no lockfile/integrity, attributes lost); SSR works via `deno-http::` rewriting; root-relative `/…` imports inside https modules resolved by loader |
| `node:` | returned null ⇒ Vite (browser-external in client, builtin in SSR) |
| `data:` / `blob:` / `file:` | `file:` via loader; `data:` not special-cased (jeiea fork adds data-URL import-map support) |
| import map `imports`, trailing-slash, `#`-prefixed keys | ✅ (tests `alias*.ts`) — but loses to `node_modules` for same-named packages |
| `scopes` | only via loader when a referrer is passed (member path) |
| workspaces / `links` | ✅ root + member import maps since 2.0.3 (test `tests/linked`); member entry outside root = virtual (no HMR) |
| `deno.lock` | respected by loader (default `noLock:false`); integrity enforced by loader; plugin doesn't watch it |
| `compilerOptions.jsx*` | applied by loader to *virtual* modules only; local in-root files use Vite's Oxc/esbuild config ⇒ possible divergence; `@jsxImportSource npm:…` pragmas in JSR TSX break because of the subpath bug (#58/#59) |
| TS transpile | own (loader) for virtual modules; Vite for plain paths |
| Import attributes | JSON only (by media type); `text`/`bytes` ignored |
| WASM | not handled (local `.wasm` falls to Vite) |
| Source maps | ✅ from loader ≥0.5 (JSON none) |
| HMR | Vite's, for plain paths only; virtual outside-root locals never invalidated [verified]; no `handleHotUpdate`/`hotUpdate`/`addWatchFile` |
| optimizeDeps / prebundling | untouched; JSR/https never pre-bundled; npm pre-bundled only through `node_modules` |
| SSR | env-aware loaders; `https:` rewrite; no `ssr.external/noExternal`/`resolve.builtins` config; Vite #20828/#20850 apply |
| Environment API | `sharedDuringBuild`, `applyToEnvironment`, `this.environment.name`, `config.consumer` for `onLoad.ssr` |
| Hook filters | ❌ none (every id hits the JS hooks — costly under Rolldown) |
| Workers | needs `worker.plugins: () => [deno()]` for builds (#106, documented Vite behaviour) |
| Runs under Node | ✅ (loader has a Node WASM path) but ESM-only config caveat (#60) |
| Windows | CI matrix includes windows; historical issues all v1 |
| Private registries / `DENO_AUTH_TOKENS` / DENO_DIR | inherited from `@deno/loader` (uses `deno_npmrc`, `deno_cache_dir`, JS `fetch`); nothing plugin-specific, untested |
| Vendoring (`vendor:true`) | v1 broke (#18); v2 delegated to loader |
| Error messages | raw loader errors (`Unsupported scheme …`), silent fallbacks elsewhere |

### 2.8 Quality
* Tests: `tests/plugin.test.ts` (vitest) runs `deno run -A --unstable-bare-node-builtins npm:vite build` on
  `tests/fixture` (13 lib entries: aliases, `mapped/`, `#hash-prefix/`, npm/jsr/http via map and inline, JSON import,
  `\0vite/preload-helper.js`, linked member) then executes each `dist/*.js` with Node expecting `"it works"`.
  **Build-only**; no dev-server, HMR, SSR, worker, Windows-path or error-path tests.
* CI `.github/workflows/ci.yml`: `deno fmt --check`, `deno lint`; test matrix {ubuntu, macos, windows} × Vite {5,6,7,8},
  Node 22, Deno **canary**; `scripts/test-vite-versions.sh` for local multi-version runs. Release via GitHub release ⇒
  npm trusted publishing with provenance.
* Types: `tsc` emits `.d.ts`; `skipLibCheck` because loader types reference Deno globals; several `@ts-ignore`s for
  env-API fields to keep Vite 5/6 compiling.

### 2.9 Issues (all 50 read; grouped) — https://github.com/denoland/deno-vite-plugin/issues
* **Workspaces / import maps**: #19 workspace deps unresolvable (closed via Deno #26138, re-reported 2026-03 for Svelte
  types), #41 "Not allowed to load local resource" (fixed by upgrade), #47 (vitest config), **#53 OPEN** member aliases
  like `~/` fail in SSR (`Cannot find module '~/lib/logger.ts'`; workaround: single root import map / rename packages),
  **#54 OPEN** workspace packages vs SSR externalization (can't externalize `@scope/shadcn`; transitive deps missing at
  runtime), #57 relative import in member fails on Windows, **#77 OPEN** "vite workspace import bugs" (repro
  andykais/deno-vite-workspace-bug-repro; str4ngeMD fork posted as fix), #24 import map not working (duplicate Vite
  versions), #22/#100 aliases don't work for `.scss/.css/.svg` and `?raw` (**OPEN**, PR #85), #17 postcss NUL byte for CSS
  through `\0deno`, #42 aliasing bypassed React plugin.
* **npm**: **#40 OPEN** "npm prefix imports externalized" (workaround `resolve.alias: {"npm:react": "react"}`),
  **#74 OPEN** deps of a JSR library must be re-declared as aliases, #87 Vue named exports missing without
  `nodeModulesDir: auto`, #16 duplicate React from esm.sh (won't fix: "fundamental architectural issue with http
  imports"), **#64 OPEN** MUI `…_1` peer-suffixed dir path wrong, #73 `process is not defined` (use `define`).
* **Other plugins' ids**: #36 SolidStart `\0vite/preload-helper`, #75 `\0plugin-vue:export-helper`/`\0vite/preload-helper`
  (9 comments, Windows users patched `node_modules`), **#101 OPEN** Astro `virtual:` (Astro plugins are
  `enforce:'post'`), **#83 OPEN** SVGR "URI malformed", PR #102 comments: TanStack Start `virtual:tanstack-start-…`,
  `plugin-vue:export-helper`, react-router `virtual:react-router/inject-hmr-runtime` regressions in 2.0.3.
* **Perf / robustness (v1)**: #50 OOM, #55 10× speed-up proposals (dedupe, prefix skip list, lock, workspace
  fast-path, SQLite cache), #63 1 MB buffer, #31 shell `#`, #38/#29 empty source map, #18 `vendor:true`, #52 JSON
  `asserted`, #15 nested JSR with ranges.
* **Windows**: #48, #57, #72, #75, #86.
* **SSR / test runners**: #56 `ssrLoadModule` with `npm:`/`jsr:` ("Only file and data URLs are supported"), #30 esm.sh
  `drizzle-orm/pg-core` in vitest, #23 Vitest browser mode (`jsr:@std/internal@^1.0.5/format` not loadable, fixed),
  #29 vitest 3, **#60 OPEN** VSCode Vitest extension (ESM-only), #90 JSR in Vitest on Windows, #78 `deno test` with
  Vite transforms (needs a Deno module-loader API, denoland/deno#8327).
* **Meta**: **#34 OPEN "Make this an unplugin?"** (brc-dd, 2024-12; Marvin: "if somebody wants to have a go… feel
  free"), **#65 OPEN** investigate a Rust/native Rolldown plugin reusing Deno's resolver crate (Marvin: "extracting
  resolution in Deno to a reusable crate"), #51 idiomatic React SPA template, #35 JSR publishing, #89 Vite 8, #106 worker
  plugins, #62/#20/#21 out of scope.

### 2.10 Pull requests of note
* **#98 OPEN** (bartlomieju, 2026-03-30) — preserve `npm:` subpath; resolve bare ids with importer before
  `import.meta.resolve`; `configureServer` post-middleware that serves `/@id/…` misses via
  `server.environments.client.transformRequest(id)` (SSR-only virtual island modules missing from the client graph);
  **`exclude?: string | RegExp | (string|RegExp)[]`** option; `config(){ esbuild: { exclude: [/\x00deno::/] } }`;
  strips `/** @jsxImportSource … */`/`@jsxRuntime` pragmas so Vite's transform doesn't try to resolve `npm:` JSX sources.
* **#88 OPEN** (uriva) — correct scoped-package parsing, **warn + return undefined** instead of silently externalizing.
* **#85 OPEN** — keep `?raw` & friends: `fileURLToPath(id) + id.substring(idx)`.
* **#61 OPEN** (lbsal) — lock around `deno info`; thread contains notcome's alternative: *no `deno info` at all* —
  npm via `nodeModulesDir: auto`, JSR via `"vendor": true` (clean `vendor/` tree), parse deno.json manually.
* #59 (alexgleason) npm subpaths; #58 closed: transform stripping `npm:`+version from `@jsxImportSource` pragmas.
* #79 `roots` missing; #69/#66/#67/#70 clau-org Windows cache keys + rename; #80 merged `\0` guard.

### 2.11 Forks (`gh api repos/denoland/deno-vite-plugin/forks`)
| Fork | Ahead | Interesting |
|---|---|---|
| str4ngeMD/deno-vite-plugin | 10 | per-importer config scope loaders (see §4); published as `jsr:@str4ngemd/deno-vite-plugin` |
| masslbs/deno-vite-plugin (`@masslbs/deno-vite-plugin` on npm) | 7 | lock around `deno info`, **on-disk `./cache.json`** written at `buildEnd`, `NOCACHE=1` to bypass, `DEBUG=deno-vite-plugin` logging (no invalidation on lockfile change — stale-cache risk) |
| GitonioDev | 2 | ignore Vite virtual modules |
| jeiea (branch `feat/data-json-import`) | 4 | data-URL modules from import maps, asserted JSON |
| uriva (branch `fix/npm-specifier-resolution`) | — | = PR #88 |
| clau-org (npm `@clau-org/vite-plugin`) | — | Windows cache-key normalization (#69) |
Others (swcarter007, jozef-javorsky-dodo, moreal, AjaniBilby, Loshido, petamoriken, alexgleason, jsantell…) are 0 ahead.

### 2.12 Who uses it / relationship to Fresh
* `create-vite-extra` `template-deno-*` (the "Deno" choice under `create vite` → Others) and Deno docs tutorials.
* **Fresh 2 does not use it.** `repos/fresh/packages/plugin-vite/src/plugins/deno.ts` (417 lines, Fresh HEAD 2026-06-03,
  `@deno/loader@^0.4.0`) is a separate, more complete design: single plugin, `enforce:"pre"`, calls
  `this.resolve(id, importer, options)` first and **ignores results where `resolvedBy === "vite:resolve"`**, node builtins
  ⇒ `{id: "node:x", external: true}`, `loader.resolve` (async, may install) with a `file://` importer so member import
  maps apply, `options.attributes.type` ⇒ `RequestedModuleType.{Json,Text,Bytes}` (+ `.json` extension ⇒ Json) stored in
  `meta.deno.type` and re-read in `load` via `this.getModuleInfo(id).meta`, virtual ids `\0deno::<type>::<url>` for
  `https|jsr|npm` results, two loaders (`platform:"node"`, and `platform:"browser"` + `preserveJsx`, both
  `cachedOnly: true` ⇒ requires `deno install` first), Babel for client JSX + `httpAbsolute` rewrite
  (`deno-http::` prefix for absolute/`/`-rooted imports inside remote modules), a `transform` with **hook filter**
  `{ filter: { id: JSX_REG } }` to re-run Deno's `precompile` JSX for SSR. Fresh's `mod.ts` also sets
  `resolve.noExternal: true` ("externals lead to duplicate modules with `preact` vs `npm:preact@*`"),
  `optimizeDeps.noDiscovery: true` ("optimize deps leads to duplicate modules…"), and **only adds `deno()` when
  `typeof process.versions.deno === "string"`**. PR #93 ("features needed for Fresh") and #98 were the convergence
  attempt; Fresh has not switched.

### 2.13 Verdict
**Good / worth stealing**
* In-process `@deno/loader` (no subprocess, same resolution code as the CLI, lockfile + integrity for free, works on
  Node too) — the single biggest improvement (fixed ~10 issues at once).
* Per-Vite-environment loaders with `platform` / `preserveJsx` / `nodeConditions` options; `onLoad` post-hook.
* Handing `file://` results back to Vite as plain paths (Vite pipeline + HMR) while virtualizing only remote code.
* Referrer-aware resolution (`resolveSync(id, file://importer)`) so member-scoped import maps work.
* `deno-http::` prefix to survive Vite's SSR runner externalization of `https:`.
* `#deno` suffix to stop extension-based plugin matching; `\0` prefix for virtual ids.
* Cross-version CI matrix (Vite 5–8 × 3 OSes), fixture executed at runtime not just built.

**Bad / pitfalls to avoid**
* Two-phase design where Deno resolution runs **after** `vite:resolve` ⇒ import-map precedence violated.
* Calling Deno's loader for ids it doesn't own (`virtual:`, `astro:`, `plugin-vue:`…) ⇒ crashes; no scheme allow-list, no
  hook filters, no `exclude` (still only in open PR #98).
* Collapsing `npm:pkg@range/sub` to `pkg`; silently returning unresolved bare strings (externalization at runtime).
* `import.meta.resolve` from inside the plugin package (resolves from the wrong location).
* Loading remote modules twice (resolve for media type + load); `addEntrypoints` per specifier (no up-front graph from
  `index.html`/entries, so lockfile-less resolution can differ from `deno`).
* No pre-bundling for JSR/https in dev (request waterfalls); CJS npm code served raw without `node_modules`.
* Virtualizing local files outside the root ⇒ no watch/HMR, stale content.
* Client-dev `https:` imports bypass the plugin entirely (Vite skips resolve for external URLs).
* Config discovery only from Vite root, prefers any ancestor workspace; no override; ESM-only package breaks CJS config
  loaders (#60); README still says Deno resolution can't work in `vite.config.ts` (use `--configLoader native`).
* Regex-based import rewriting.

---
## 3. `@deno-plc/vite-plugin-deno` (JSR)

Clone: `repos/deno-plc-vite-plugin-deno` (HEAD `e046832`). Experiment: `exp/plc`.

### 3.1 Identity
* https://github.com/deno-plc/vite-plugin-deno — author Hans Schallmoser (`hansSchall`), **LGPL-2.1-or-later**,
  22★, 1 fork (wanderer, no new work). JSR `@deno-plc/vite-plugin-deno`, 26 versions 0.1.0 (2024-05-31) → **2.3.5
  (2026-03-17)**; JSR score 100, runtimeCompat **deno only**; ~66 JSR downloads in the stats window.
* Activity: sporadic, maintained against the author's own "quite large codebase" (SSR, multiple frontends, WASM).
  2.3.5 commit: "deno changed its info output format again + update to zod v4". README self-describes as
  "Nothing for newbies".

### 3.2 How it plugs in (`mod.ts`)
Single plugin `vite-plugin-deno`, `enforce:"pre"`, `resolveId: { order:"pre", handler }`, `load`,
`handleHotUpdate` (debounce), `config()` (only for `env:"deno"`: `build.rollupOptions.external: [/^node:/]`).
No environment API, no hook filters, no `transform`, no optimizeDeps/ssr config. **Deno runtime required**
(`Deno.Command`, `Deno.readTextFile`, `Worker`), and the README insists on JS-API scripts
(`scripts/dev.ts` → `createServer({configFile:false, plugins:[pluginDeno()]})`) because "vite.config.ts will always be run
with Node" (outdated since `--configLoader native`).

### 3.3 Resolution / loading architecture (`src/graph.ts`, `src/resolve.ts`, `src/npm.ts`)
* **Graph ingestion via `deno info --json`**: `new Deno.Command(Deno.execPath(), {args: ["info","--json",
  ("--config", deno_json)?, ("--lock", deno_lock)?, root], env: {DENO_NO_PACKAGE_JSON: "true"}})`; output validated by
  zod (`DenoInfoOutput`: roots/modules/redirects/packages/npmPackages). **One call ingests the whole subgraph**: every
  `esm` module becomes a `GraphModule` whose `esm_dependencies` are filled from `dependencies[].code.specifier`, so
  sub-imports are resolved from real graph edges (exact per-importer semantics, incl. version-specific npm). Calls are
  serialized through a single `#pending` promise; a miss triggers `update_info(referrer)` once, then a descriptive error
  (e.g. "*vite has been recognized as an NPM package … add "vite" to undeclared_npm_imports or `"vite/x" =>
  "npm:vite@8.3.1/x"` to extra_import_map*").
* Entry ids with no importer are joined to `Deno.cwd()`; `file:` results are returned as **plain paths** (reverse map
  `fs_remap`) so Vite's HMR works; everything else is `encodeURIComponent(url)` (ids like
  `https%3A%2F%2Fjsr.io%2F%40std%2Fpath%2F1.1.6%2Fjoin.ts` — still ending in `.ts`, so **Vite/Oxc does the TS transform**).
* **npm is re-implemented**: package list from `npmPackages`, files read from
  `$DENO_DIR/npm/registry.npmjs.org/<name>/<version>` (**hard-coded registry host** — breaks with `.npmrc` custom
  registries/mirrors), `package.json` `exports` via `resolve.exports` (`browser: env==="browser"`), legacy `main`,
  probing (`npm-probe:` → `.js/.mjs/.cjs`, `/index`), file ids `npm-data:<name>@<ver>/<path>`; a wrapper module
  `export * from …; import d from …; export default d` (default-export detection via acorn). **CJS→ESM via `lebab`**
  in a Worker pool (`navigator.hardwareConcurrency`) when code mentions `require`/`module`; throws on non-top-level
  exports ("does UGLY things with Cjs exports") ⇒ **React is unsupported** (README recommends Preact/compat).
  `legacy_npm` hands chosen packages back to Vite/`node_modules` and regex-rewrites `"npm:<pkg>@…"` strings in loaded code.
* Other schemes: `virtual:node:null` (a module that throws — opt out of `node:` polyfills), `#standalone` suffix to treat
  a replaced import as its own graph root, `extra_import_map` (Map, values may be Promises), `undeclared_npm_imports`
  (pre-resolved with `deno info npm:<pkg>` for code injected by JSX/HMR transforms, e.g. `preact/jsx-runtime`,
  `@prefresh/core`).
* Default excludes: `/\/@(fs|id)/`, `/\/?(@|\.)vite\//`, `/\/node_modules\//`, `/^<stdin>$/`, `/^node:/` (env deno);
  any id with a non-JS extension (css, svg, png…) is skipped (`constants.ts` supported = js jsx ts tsx mjs cjs json).
* Load: `Deno.readTextFile(local)` (raw source), strips `//# sourceMappingURL` from http modules and
  `/** @jsx… */` pragmas from `.tsx`. Caches module code except for `file:` modules.

### 3.4 Options (complete — `mod.ts:36-104`)
`deno_json?: string`, `deno_lock?: string`, `env?: "deno" | "browser"` (default `"browser"`; controls `browser`
field/conditions and allows `node:`), `undeclared_npm_imports?: string[]`, `legacy_npm?: string[]`,
`extra_import_map?: [string,string][] | Map<string, string | Promise<string>>`, `exclude?: (string|RegExp)[]`
(strings → exact-match RegExp, deprecated), `log_id?: string` (logtape logger, default `"vite-plugin-deno"`),
`hot_update_min_time?: number` (ms, default 0; issue #5 duplicate HMR events).

### 3.5 Features / quality / issues
* Dev + HMR for local files ✅; JSR/https/npm ✅ (build verified with Vite 8.3.1 + Deno 2.9.7 **incl.
  `npm:preact@^10.24.0/hooks`** — the subpath case the official plugin fails); pre-bundling ❌ ("Dependency
  optimization unsupported"); SSR only via `env:"deno"` (bundling for Deno, "can replace `deno bundle`"); asset/CSS
  imports "will throw" per README (they're excluded by extension now); Babel/PostCSS/Tailwind need `node_modules`.
* [verified] fails out-of-the-box on Vite's injected `vite/modulepreload-polyfill` from `index.html` (must exclude or
  set `build.modulePreload.polyfill:false`) — symptom of intercepting *everything* at `order:"pre"`.
* [code] zod `mediaType` enum only allows `TypeScript|JavaScript|TSX|Dts` for `kind:"esm"` ⇒ a graph containing a remote
  `.jsx`/`.mjs`/`.cjs` module fails validation wholesale; `asserted` JSON modules are parsed but never turned into
  `GraphModule`s (only `esm` are), so JSON imports likely fail.
* Tests: only `ast-ops.test.ts`, `specifier.test.ts`; CI `deno task check-ci` (fmt, lint, publish dry-run, tests) then
  `deno publish`. Logging with per-resolve timings (logtape) is good.
* Issues (https://github.com/deno-plc/vite-plugin-deno/issues): #1 `index.html` passed to `deno info` (fixed 2.1.8),
  #2/#7 "underscore version extension differs" (peer-suffixed npm ids like
  `@tanstack/react-router@1.81.10_react@18.3.1_…`), #3 examples, #5 duplicate HMR events, #6 workspace regression,
  **#8 OPEN "Consider using `@deno/loader`"**, **#9 OPEN** `legacy_npm` empty ⇒ regex `"npm:()(@.+)"` rewrites every
  scoped `npm:@…` import to `""`.
* PRs: none.

**Good**: whole-graph ingestion with dependency edges; zod-validated CLI output; excellent actionable errors; logging;
`virtual:node:null`; `#standalone`; `undeclared_npm_imports` for injected imports; plain paths for local files.
**Bad**: Deno-only + no `vite.config.ts`; CLI output drift; serialized subprocesses; hand-rolled npm with hard-coded
registry path and lebab CJS conversion; no pre-bundling; LGPL (can't copy code into an MIT project).

---

## 4. `@str4ngemd/deno-vite-plugin` (JSR fork of the official plugin)

Clone: `repos/str4ngemd-deno-vite-plugin` (upstream fetched as remote `upstream`; merge-base `0996992` = official 2.0.3+CI).
* https://github.com/str4ngeMD/deno-vite-plugin — fork of denoland/deno-vite-plugin, MIT, 0★, created 2026-09-05.
  JSR `@str4ngemd/deno-vite-plugin` 2.0.3-1 and **2.0.4 (2026-09-24)**, JSR score 23, ~7 downloads. README: "the actual
  plugin code in 3 ts files were written by AI. Beware!"; announced in official issue #77.
* **Diff vs upstream** (`git diff upstream/main...HEAD -- src`): only `src/index.ts` (+~60), `prefixPlugin.ts`,
  `resolvePlugin.ts` (signature changes). `resolver.ts` untouched. New logic:
  * `findDenoConfigForImporter(importer, fallback)`: unwrap `\0deno` importers to their real path; skip non-absolute,
    `/@…`, `/node_modules/` importers; else `findDenoConfig(dirname(importer))` (nearest config, preferring an ancestor
    with `workspace`).
  * Loaders and caches keyed by **`JSON.stringify([envName, configPath])`** instead of env name ⇒ one
    `Workspace`/`Loader` per (environment × Deno config scope). `getLoader(envName, importer)` in both `resolveId`s and
    `getLoader(envName, id)` in `load`.
  * Effect: a Vite app **outside** a Deno workspace can import a member file (via a relative path/alias) and that
    member's transitive workspace imports (`@MyMath/computePi`, bare member names with no `imports` entry) resolve with
    the *member's* workspace config — something Deno CLI does natively. Example in `EXAMPLE/` (math-workspace,
    native-deno, sample-vite, with `"links": ["../../"]`).
* No new options, tests or CI changes; the JSR publish includes images, lockfiles, tests and `EXAMPLE/` (no `publish.exclude`).
  Also documents a build workaround `deno eval 'import { build } from "vite"; import cfg from "./vite.config.ts"; await
  build({...cfg, configFile:false})'` because `vite build` couldn't load a JSR-hosted plugin from the config (use
  `--configLoader native` instead).
* **Idea worth stealing**: resolve with the loader belonging to the **config scope of the importer**, not the Vite
  root (multi-root / out-of-workspace imports). Cost: N loaders (each a WASM workspace + npm/jsr resolution state).

---
## 5. `@transitionsag/deno-workspace-vite-plugin` (JSR)

Sources: all 13 published versions downloaded from JSR into `repos/transitionsag-deno-workspace-vite-plugin/v<ver>/`
(no public GitHub repo; the `TransitionsAg` org's only public repo is `bloom`). Experiment: `exp/tsag`, `exp/jsr-pkgjson`.

### 5.1 Identity
MIT, JSR only, **13 versions published in ~40 hours (0.1.0 2026-04-06 → 0.5.2 2026-04-08)**, then silent; JSR score 70,
runtimeCompat `deno` (uses `Deno.readTextFileSync/statSync/readDirSync`), no download stats. CI (`.github/workflows/ci.yml`)
runs lint/tests inside a Nix flake. Intended to be used **together with and before** `@deno/vite-plugin`
(README examples include SolidStart/vinxi).

### 5.2 Evolution
* 0.1.0–0.1.1: `resolveId` (enforce pre) resolver for **local** import-map targets of all workspace members (walk up
  to the `deno.json` with `workspace`, expand member globs with `@std/fs` `expandGlob`, collect `imports` whose targets
  are paths — `npm:`/`jsr:`/`http(s):`/`workspace:` filtered out), longest-prefix match, extension probing
  (`.ts .tsx .js .jsx .mjs .cjs .css`) and index probing (`mod.ts mod.tsx index.ts index.tsx`); `package.json` members.
* 0.1.2–0.1.3: vinxi/SolidStart hacks (skip `virtual:`, `$vinxi/`, `vinxi:`, `/@manifest`; a `load` hook returning
  `{code:"export default []", moduleType:"js"}` for `/@manifest…assets` without `id`).
* 0.2.0: member `name` + `exports` become import keys (`@scope/pkg`, `@scope/pkg/sub`).
* 0.3.0: `transform` rewriting CSS `@import "<alias>"` to absolute paths (regex).
* 0.4.2: `config()` also emits `resolve.alias`, **sorted longest-first** so subpath exports win over the bare name.
* 0.4.3: `resolveJsrDependencies?: boolean` — `jsr:` targets ⇒ `<workspaceRoot>/node_modules/@jsr/<scope>__<name>`.
* **0.5.0–0.5.2 (current): complete rewrite to an alias-only plugin** — one `config()` hook returning `resolve.alias`
  entries; `resolveId`/`load`/`transform` removed; description "resolves jsr: imports and ~/ paths".

### 5.3 The `jsr:` → `node_modules/@jsr` approach, precisely (v0.5.2 `src/plugin.ts`)
1. In `config(config)`: `startDir = options.root ?? config.root ?? Deno.cwd()`; `root = findWorkspaceRoot(startDir)
   ?? startDir` (nearest ancestor `deno.json(c)` with an array `workspace`).
2. `collectJsrAliases(root)`: for every `imports` entry of the root config **and** of each member config whose value
   starts with `jsr:`: `jsrSpecifierToNpmPath("jsr:@std/assert@^1.0")` strips `jsr:`, strips a version **only if it
   starts with `^` or `~`** (`/@[\^~].*$/`), drops the leading `@`, replaces the first `/` with `__` ⇒ `std__assert`;
   target dir `<root>/node_modules/@jsr/std__assert`; **added only if `Deno.statSync(dir)` succeeds**, as
   `{ find: "@std/assert", replacement: "<root>/node_modules/@jsr/std__assert" }`.
3. `collectWorkspaceAliases(root)`: for each member dir with `name` and `exports` (string ⇒ `{".": …}`): `"."` ⇒
   `{find: name, replacement: <dir>/<export>}`; `"./x"` ⇒ `{find: name + "/x", …}`; wildcard `"./x/*"` ⇒
   `{find: /^name\/x\/(.+?)suffix$/, replacement: <dir>/<target with * → $1>}`.
4. Returned as `resolve.alias` (applied by Vite's `vite:pre-alias`/alias plugin before everything else).
* **Where do `node_modules/@jsr/*` dirs come from?** Not from `deno.json` `imports` — [verified] `deno install` with
  `"@std/assert": "jsr:@std/assert@^1"` + `nodeModulesDir:"auto"` creates **no** `node_modules/@jsr`. They appear when
  JSR packages are installed through **JSR's npm compatibility layer**: a `package.json` dependency using the `jsr:`
  protocol (`"@std/assert": "jsr:^1.0.0"`, supported by Deno 2.9 `deno install`, pnpm, yarn) or
  `"@jsr/std__assert": "npm:@jsr/std__assert@^1"` with `.npmrc` `@jsr:registry=https://npm.jsr.io`. [verified] Deno then
  creates `node_modules/.deno/@jsr+std__assert@1.0.19/…` and symlinks **both** `node_modules/@std/assert` and
  `node_modules/@jsr/std__assert`. The tarball contains pre-transpiled `.js` + `.js.map` + original `.ts` + `_dist/*.d.ts`,
  a `package.json` with `exports` (`types`/`default` per subpath, kebab-case keys → snake_case files) and its own JSR
  deps rewritten to npm deps (`"@jsr/std__internal": "^1.0.12"`, `import … from "@jsr/std__internal/format"`).
* Consequence: JSR packages become ordinary npm packages to Vite ⇒ **pre-bundling, CJS interop, SSR externals,
  `resolve.conditions`, dedupe all "just work"**, no loader, runs even without Deno. Price: a second manifest
  (`package.json`) to keep in sync with `deno.json` (versions come from `package.json` ranges and the package manager's
  lockfile, not from the import-map ranges), Vite sees JSR's npm-compat build rather than the exact modules Deno loads,
  and mixing both routes (`jsr:` inline somewhere + alias elsewhere) can load two copies of a package.

### 5.4 Bugs / limits
* **[verified]** Aliasing to the *directory* breaks JSR subpath exports whose key differs from the filename:
  `@std/assert/almost-equals` ⇒ `node_modules/@jsr/std__assert/almost-equals` ⇒ `UNLOADABLE_DEPENDENCY` (file is
  `almost_equals.js`). Root imports work. Correct fix: alias to the **package name** (`@jsr/std__assert`) so Vite
  applies `package.json#exports`.
* [code] Exact versions (`jsr:@std/path@1.1.0`) or subpath targets (`jsr:@std/path@^1/posix`) produce wrong dir names
  and are silently skipped; `jsr:` imports written inline in source are not handled at all.
* [code] Workspace member discovery only understands `dir/*` globs: for an explicit member like `"./packages/core"` it
  lists the *subdirectories* of `packages/core` (`pattern.replace(/\/\*$/, "")` then `readDirSync`).
* [code] v0.5.x lost 0.4.2's longest-first sort; with Vite's first-match alias semantics a `"."` alias listed before
  `"./sub"` swallows `name/sub` (prefix + `/` match) ⇒ `<dir>/mod.ts/sub`.
* `config.root` in `config()` is the raw (possibly relative) user value; Deno-only APIs.
**Good**: zero-runtime-cost alias approach; npm-compat route gives pre-bundling for free; member `exports` (incl.
wildcards) → aliases. **Bad**: requires npm-compat install, ignores `deno.lock`, stringly path math, no tests shipped.

---

## 6. `@lockness/vite` (JSR) — part of the Lockness framework

Clone: `repos/lockness-monorepo` (HEAD `32baca7`, very active: dozens of commits on 2026-09-25). Package:
`packages/vite/` (`deno.json` name `@lockness/vite` 0.3.0, JSR 2026-09-08, ~3 downloads).
* https://github.com/locknessland/lockness-monorepo — "A TypeScript (first) web framework for Deno", MIT, 0★, created
  2026-08-25 (history migrated), homepage lockness.land, 38-member Deno workspace. Framework policy: JSR-only deps;
  `vite` is the single documented `npm:` exception (`deps.policy.jsonc`).
* **What the framework needs from Vite** (`docs/vite.md`, `src/lockness.ts`): Vite is only the **client asset
  pipeline + dev middleware**. `lockness({ app })` composes: `denoResolver()` (`src/plugins/deno.ts`),
  `lockness:client-entry` virtual module, CSS/Tailwind v4 collector + build CSS compile, a **dev-server bridge**
  (`appType:'custom'`, middleware forwarding every non-Vite request — allowlist of `/@vite/`, `/@id/`, `/@fs/`,
  `/@react-refresh`, `/node_modules/`… — to the injected `App.fetch()`; dev-only CSP widening for the HMR socket;
  loopback + `server.fs.strict`), an HMR plugin (`configureServer` watcher ⇒ `onReload()` then `ws.send({type:
  'full-reload'})` for backend files), and `build.manifest` + `viteAssets()` manifest reader with CSP nonces.
  **The server never goes through Vite's SSR/module runner** — it runs natively in Deno; `vite.config.ts` does
  `import app from './main.ts'`, so **`--configLoader native` is mandatory** (issue #154: Vite's config bundler emitted
  `react/jsx-runtime` and treated `@lockness/*` as external). `nodeModulesDir:"auto"` required for Vite/Rolldown's
  own native deps.
* **The resolver plugin** (`src/plugins/deno.ts`, 233 lines): `lockness:deno-resolver`, `enforce:'pre'`, intercepts
  **only** ids starting with `jsr:`, `npm:`, `https:` (bare/import-map ids are left to Vite). Strict allow-list regexes
  per scheme (throws on malformed specifiers; "no shell metacharacters"). `npm:`/`https:` ⇒
  `import.meta.resolve(source)` — works because the plugin is Deno-executed JSR source: [verified] from a Deno module
  `import.meta.resolve("npm:preact@^10/hooks")` returns the `node_modules/.deno/…` (or DENO_DIR) file URL with Deno's
  node conditions, while `jsr:` specifiers come back unchanged (`jsr:@std/path@^1.1.0`), hence `jsr:` ⇒
  `deno info --json <spec>` via
  `Deno.Command` (argument array, no shell) ⇒ `https://jsr.io/…` URL; `load` for `https:` ids ⇒ another
  `deno info --json <url>` ⇒ read `modules[].local` from Deno's cache (integrity-checked; "no custom fetch, SSRF-safe").
  [code] Gaps: relative imports *inside* a JSR module (`./_util.ts` from an `https://jsr.io/…` importer) are not handled
  by the plugin (Vite would resolve them against a fake path); one subprocess per specifier and per remote module;
  TS from JSR relies on Vite's transform (id ends in `.ts`); no caching; Deno-only.
* Options: none for the resolver. `LocknessPluginOptions { app: AppFetchHandler; config?: Partial<LocknessViteConfig>;
  onReload?: () => void | Promise<void> }` for the aggregate.
* Tests: `tests/deno_resolver.test.ts` (classification, validation, jsr/npm/https resolution), `e2e_smoke.test.ts`
  (real `vite build` + dev SSR through the bridge), CSS/HMR/dev-server/asset tests — strong security framing.
* **Take-aways**: (1) a framework may only need *client* resolution + a Deno-native server — unplugin-deno should work
  in that "Deno server, Vite client" topology; (2) document `--configLoader native` for Deno users; (3) security posture
  (specifier validation, argv-not-shell, read from Deno's integrity-checked cache) is a good checklist.

---

## 7. Older deno.land/x plugins (skimmed)

### 7.1 `vite_deno_plugin` — https://deno.land/x/vite_deno_plugin (repo anatoo/vite-deno-plugin, **archived**, MIT, 34★)
Clone `repos/anatoo-vite-deno-plugin`; v0.9.0–0.9.4 (last 2024-02-18, repo archived 2024-03-31).
* Two plugins: `vite:deno-import-map-plugin` (**own WHATWG-style import-map implementation**: normalize keys/values
  against the map's dir, sort keys descending by code units, trailing-slash prefix entries; `scopes` TODO) and
  `vite:deno-url-import` (`enforce:'pre'`): `https://` ids ⇒ `deno cache <url>` subprocess then `deno info <url> --json`
  (caches every `esm` module's `local ?? emit` path from that output), load = `Deno.readTextFileSync(local)`.
* Nice ideas: resolve root-relative imports (`/v135/react@…`) from an `https:` importer with `new URL(id, importer)`;
  **auto-append `?dev` to esm.sh URLs in development** (provider-specific dev builds).
* Option: `importMapFilename` (default `./deno.json` if present). Known issues: no `npm:`; deno.land/x remote libs
  "not working"; must use `vite.config.mts` and `--config`.

### 7.2 `vite_plugin_deno_resolve` — https://deno.land/x/vite_plugin_deno_resolve (itsdouges, **no license**, 16★)
Clone `repos/itsdouges-vite_plugin_deno_resolve`; 0.2.0–0.5.0 (2022-12), last push 2023-09-20; forks incl.
`bartlomieju/vite_plugin_deno_resolve`.
* `vite:deno-https-resolve`: `transform` regex-rewrites `from 'http…'` to `from '@url/http…'` **because Vite skips
  `resolveId` for URL imports** (same trick as the official plugin's `deno-http::` and Fresh's `httpAbsolute`);
  `resolveId` ⇒ `deno cache` (in a **temp dir as cwd**, i.e. ignoring the project's deno.json) ⇒ `@url/<URL>` ids;
  `load` ⇒ `deno info <url> --json` ⇒ read `emit || local`. `vite:deno-npm-resolve` is a stub.
* Open issues: #2 umbrella "missing Deno features" (Bartek: no API to get the current import map), #4 React plugin can't
  find deps, #6 support import_map.json, #7 only single-quoted imports remapped.
* History lesson: in 2022 the blocker was that `deno info` didn't expose npm cache locations; everything since then
  converges on "let Deno's resolver answer" — today via `@deno/loader`.

---
## 8. Cross-cutting lessons for `unplugin-deno` (Vite side)

### 8.1 Ideas worth stealing
1. **In-process Deno resolution via `@deno/loader`** (official v2, Fresh): same code as the CLI, lockfile/integrity,
   `.npmrc`, Node + Deno support; `Workspace` options `platform`, `nodeConditions`, `preserveJsx`, `noTranspile`,
   `cachedOnly`, `newestDependencyDate` (map from deno.json `minimumDependencyAge`; Deno 2.9 defaults to 24 h — it even
   blocked installing the newest official plugin release during this research).
2. **Per-environment loaders** keyed by `this.environment.name` / `config.consumer` (browser vs node conditions,
   preserveJsx for client) — and, from str4ngeMD, **per config scope** (nearest `deno.json` of the importer) for
   multi-root/out-of-workspace imports.
3. **Referrer-aware resolution** (`resolveSync(id, file://importer)`) so member `imports`/`scopes` apply.
4. **Fresh's ordering trick**: `enforce:'pre'` + `this.resolve(id, importer, options)` first, keep results from other
   plugins but **ignore `resolvedBy === "vite:resolve"`** ⇒ Deno import-map precedence without breaking other plugins'
   virtual modules.
5. **Import attributes → `RequestedModuleType`** (`json`/`text`/`bytes`) stored in `meta` (Fresh).
6. **Hand local files back to Vite as plain absolute paths** (HMR, Vite transforms) — including files *outside* the root
   (the official plugin's virtualization of those is the source of the stale-module bug); virtualize only remote/cache code.
7. **`deno-http::`-style prefixing** of URL imports so Vite's SSR runner/import analysis routes them through `resolveId`
   (official, Fresh `httpAbsolute` via Babel AST, itsdouges `@url/`) — do it with an AST/lexer, not regex.
8. **Graph ingestion**: get the whole module graph (deno-plc via `deno info`; loader `addEntrypoints` with all Vite
   inputs up front, as the loader docs recommend) instead of per-specifier resolution.
9. **JSR via npm-compat** (`node_modules/@jsr/*`, transitionsag) as an *optional* mode: pre-bundling + CJS interop for free;
   alias to the package **name**, not the directory.
10. `virtual:node:null`-style opt-out stubs, `#standalone`, `undeclared_npm_imports` for injected imports, and
    deno-plc-grade actionable error messages suggesting exact config fixes.
11. `exclude` option (PR #98) + a default skip-list for framework virtual ids; esm.sh `?dev` in development (anatoo).
12. Security posture from Lockness: validate specifiers, argv not shell, read remote code only from Deno's
    integrity-checked cache.
13. `onLoad` extension point (official) for framework-specific post-processing.
14. Test matrix across Vite majors × OSes (official) and **runtime execution of built fixtures**, not just "build passed".
15. **Mirror local-path import-map entries (`@/`, `~/`, `@assets/`, member names/exports) into `resolve.alias`** from the
    `config()` hook (transitionsag) so Vite-internal resolvers that bypass user plugins — CSS `@import`, Sass `@use`,
    Less — honour them too; keep `resolveId` for `jsr:`/`npm:`/`https:`.

### 8.2 Pitfalls to avoid (all observed in the wild)
* Resolving after `vite:resolve` (import-map precedence lost) — or intercepting *everything* at `order:"pre"` and
  choking on Vite's own injected ids (`vite/modulepreload-polyfill`, `\0vite/preload-helper.js`) or framework virtual ids.
* Passing unknown schemes to Deno's loader; not using hook filters.
* Collapsing `npm:` specifiers to bare names (versions, subpaths, peers lost; `@jsxImportSource npm:…/jsx-runtime`
  breaks); silently returning unresolved ids (runtime "externalized for browser compatibility").
* Assuming `node_modules` for npm (CJS served raw in dev without it) — or, conversely, hand-rolling npm resolution/CJS
  conversion (deno-plc: React impossible, hard-coded registry path).
* Shelling out to `deno info` per specifier (OOM, 1 MB buffer, shell escaping, Windows binary names, output-format drift
  between Deno versions — broke official v1 and deno-plc twice).
* `import.meta.resolve` inside the plugin package; regex import rewriting; stringly `jsr:` → path math.
* Dropping `?query`/`#hash` suffixes: the official plugin resolves `@assets/icons.svg?raw` through the loader and then
  `fileURLToPath()`, which discards the search params, so Vite returns the asset URL instead of the raw text (#100,
  fix in open PR #85) [verified: `@/icons.svg?raw` → `data:image/svg+xml,…` while `./icons.svg?raw` → text]. Strip Vite
  queries before resolving and re-append them after.
* **Two resolution authorities with different conditions** ⇒ duplicate packages. [verified] the same `preact@10.29.8`
  resolves to `dist/preact.module.js` through Vite (client conditions/`module` field, `exp/official`) but to
  `dist/preact.mjs` through Deno (`import.meta.resolve`, loader default `platform:"node"`, `exp/official-nonm`). If some
  imports of a package go through Deno and others through Vite you get two instances (broken hooks/context) — the
  reason Fresh forces `resolve.noExternal: true`. Pass the environment's `resolve.conditions` to the loader
  (`nodeConditions`), use `platform:"browser"` for client envs, and keep one authority per package.
* Virtualizing local files (no HMR/stale); not calling `addWatchFile`; no `deno.json`/`deno.lock` change handling.
* Leaving `https:` client imports to the browser in dev (no integrity, CORS, attribute loss).
* Not handling SSR externalization (Vite #20828: bare jsr/import-map ids are `tryNodeResolve`d by `fetchModule`).
* ESM-only package with top-level await ⇒ unusable from CJS-bundled configs/Vitest extension (#60); JSR-only
  distribution ⇒ `vite.config.ts` can't import it without `--configLoader native`.
* Unbounded on-disk caches without invalidation (masslbs `cache.json`).

### 8.3 Most-demanded features (issue frequency across the group)
1. Workspaces & member import maps / out-of-workspace imports (official #19 #41 #47 #53 #54 #57 #77 + PR #102, str4ngeMD,
   transitionsag, deno-plc #6).
2. npm deps of JSR packages & inline `npm:` fidelity (subpaths, scoped names, versions, jsxImportSource): #40 #58 #59
   #64 #74 #77 #87 PR #88 PR #98, deno-plc #2 #7 #9.
3. Interop with other plugins' virtual modules (Vue, Astro, TanStack, react-router, SolidStart/vinxi, SVGR, windicss):
   #36 #75 #80 #83 #101 + #102 comments.
4. Performance (concurrency, caching, fewer subprocesses): #50 #55 #63 PR #61, masslbs.
5. Windows paths/binaries: #48 #57 #68 #72 #75 #86 #90.
6. SSR (`ssrLoadModule`, externals, Deno-native server): #54 #56, Vite #20828 #20850, Lockness.
7. Aliases for CSS/SCSS/assets and query suffixes (`?raw`, `?url`): #17 #22 #42 #100 PR #85 — CSS `@import`/Sass `@use`
   go through `createIdResolver` (no user plugins), so import-map aliases must also be mirrored into `resolve.alias`.
8. Test runners (Vitest node/browser mode, VSCode extension, `deno test`): #23 #29 #47 #60 #78 #90.
9. Tooling shape: "make this an unplugin" (#34), native Rolldown plugin reusing Deno's resolver crate (#65), JSR
   publishing (#35), idiomatic templates (#51).

### 8.4 Surprising discoveries
* The official plugin's `import.meta.resolve` branch is inert/harmful — deno.json is never consulted there.
* In Vite 8 the official plugin's main resolver runs **after the native Rust `vite:resolve`**, so a package in
  `node_modules` silently overrides a deno.json mapping of the same name.
* Fresh 2 (Deno's flagship) maintains its own Vite Deno plugin and does not use `@deno/vite-plugin`.
* `@deno/vite-plugin` works fine under **Node** (WASM loader) if the config is ESM (`.mts`/`type:module`).
* Without `node_modules`, builds work (npm served from DENO_DIR through the loader) but dev breaks for CJS packages.
* Deno 2.9 `deno install` understands `jsr:` in `package.json` and links JSR packages as npm-compat tarballs into
  both `node_modules/@scope/name` and `node_modules/@jsr/scope__name`.
* Deno 2.9's default 24 h minimum dependency age blocked installing `@deno/vite-plugin@2.0.4` (published the day before).
* The official 2.0.3 "workspace" fix introduced a regression for `\0`-prefixed virtual ids (Vue/react-router/TanStack):
  `new URL("\0plugin-vue:x")` silently drops the NUL, so the id escapes the plugin's `\0` guard; 2.0.4 did not fix it.

---

## 9. Comparison table

| | `@deno/vite-plugin` | `@deno-plc/vite-plugin-deno` | `@str4ngemd/deno-vite-plugin` | `@transitionsag/deno-workspace-vite-plugin` | `@lockness/vite` (resolver) | `vite_deno_plugin` (anatoo) | `vite_plugin_deno_resolve` |
|---|---|---|---|---|---|---|---|
| Registry / license | npm / MIT | JSR / LGPL-2.1+ | JSR / MIT | JSR / MIT (no public repo) | JSR / MIT | deno.land/x / MIT | deno.land/x / none |
| Latest (date) | 2.0.4 (2026-09-24) | 2.3.5 (2026-03-17) | 2.0.4 (2026-09-24) | 0.5.2 (2026-04-08) | 0.3.0 (2026-09-08) | v0.9.4 (2024-02-18) | 0.5.0 (2022-12-27) |
| Popularity | 116★, 10.4k dl/wk | 22★, ~66 JSR dl | 0★, ~7 dl | —, no stats | 0★, ~3 dl | 34★ | 16★ |
| Status | active (bursty) | low-activity | one-off fork | abandoned after 2 days | very active framework | **archived** | stale |
| Engine | `@deno/loader` WASM in-process (v1: `deno info` per id) | `deno info --json` per graph root (serialized) | = official + loader per config scope | none (static alias table) | `import.meta.resolve` + `deno info` per id | own import map + `deno cache`/`deno info` | `deno cache`/`deno info` |
| Runs under Node | ✅ (ESM config) | ❌ Deno only | ✅ in principle (same code, JSR-distributed) | ❌ Deno APIs | ❌ | ❌ | ❌ |
| Vite versions | 5–8 (CI) | 6 types; builds on 8 | 5–8 | 8 | 8 | 5 | 3 |
| Hooks / order | 3 plugins: `deno:config` (configResolved), `deno:prefix` pre resolveId, `deno` normal resolveId+load; env API | 1 plugin pre: resolveId(order pre)+load+handleHotUpdate+config | same as official | `config` → `resolve.alias` (0.4: +resolveId/load/transform) | 1 plugin pre: resolveId+load | 2 plugins (one pre) | 2 plugins pre; transform rewrite |
| `jsr:` | ✅ virtual, loader-transpiled | ✅ encoded URL ids, Vite transpiles | ✅ | only via `node_modules/@jsr` npm-compat (root export OK, kebab subpaths ❌) | inline only; relative imports inside JSR ❌ | ❌ | ❌ |
| `npm:` | → bare name via `node_modules` (subpath/version lost); loader+DENO_DIR w/o node_modules | own resolver on DENO_DIR + lebab CJS→ESM | same as official | ❌ | `import.meta.resolve` → path | ❌ (use esm.sh) | stub |
| `https:` | ✅ build/SSR; ❌ client dev (raw) | ✅ | ✅ | ❌ | ✅ via Deno cache | ✅ (+esm.sh `?dev`) | ✅ (`@url/` prefix) |
| Import map / scopes | via loader (loses to node_modules) | via `deno info` + `extra_import_map` | via loader, per importer scope | local targets + member exports | ❌ (bare left to Vite) | own `imports` impl, no scopes | ❌ |
| Workspaces | ✅ members (2.0.3), outside-root entry not HMR'd | ✅ (2.3.3) | ✅ + out-of-workspace | ✅ member name/exports (glob-only) | ❌ in resolver (bare ids left to Vite; config loaded natively by Deno) | ❌ | ❌ |
| Import attributes | JSON only | JSON (schema only) | JSON only | n/a | ❌ | ❌ | ❌ |
| Dev pre-bundling | npm via node_modules only | ❌ | same | ✅ (npm-compat) | npm only | ❌ | ❌ |
| HMR | Vite's for plain paths | Vite's for local files + debounce | same | Vite's | Vite's + server full-reload | Vite's | Vite's |
| SSR | env-aware loaders, `deno-http::` rewrite | `env:"deno"` bundling | same | n/a | server runs natively in Deno | ❌ | ❌ |
| Options | `environments`, `workspaceOptions`, `onLoad` | 9 (deno_json, deno_lock, env, undeclared_npm_imports, legacy_npm, extra_import_map, exclude, log_id, hot_update_min_time) | same as official | `root` (+`resolveJsrDependencies` in 0.4.3) | none | `importMapFilename` | none |
| Tests / CI | build+run fixtures, Vite 5–8 × 3 OS | unit tests only; real-world project | inherited | Nix CI, tests not published | good unit + e2e | unit tests | none |

---

## 10. Clone / artifact paths
* `$SCRATCH/repos/deno-vite-plugin` — denoland/deno-vite-plugin (depth 200; v1 via `git show e04b1a7:src/…`)
* `$SCRATCH/repos/str4ngemd-deno-vite-plugin` — str4ngeMD fork (remote `upstream` = denoland)
* `$SCRATCH/repos/deno-plc-vite-plugin-deno` — deno-plc/vite-plugin-deno
* `$SCRATCH/repos/transitionsag-deno-workspace-vite-plugin/v0.1.0 … v0.5.2` — all JSR versions (no public repo)
* `$SCRATCH/repos/lockness-monorepo` — locknessland/lockness-monorepo (`packages/vite`, `docs/vite.md`)
* `$SCRATCH/repos/anatoo-vite-deno-plugin` — anatoo/vite-deno-plugin (deno.land/x `vite_deno_plugin`)
* `$SCRATCH/repos/itsdouges-vite_plugin_deno_resolve` — itsdouges/vite_plugin_deno_resolve
* `$SCRATCH/repos/vite` — vitejs/vite @ bc598a6 (8.3.1), depth 1
* Shared clones read (owned by other agents): `$SCRATCH/repos/fresh` (Fresh `packages/plugin-vite`),
  `$SCRATCH/repos/deno-js-loader` (`@deno/loader`)
* Raw data: `$SCRATCH/data/dvp-issues.json`, `dvp-prs.json`, `dvp-issues-full.md` (all official issues + comments),
  `dvp-forks.txt`
* Experiments: `$SCRATCH/exp/official` (node_modules mode, 2.0.3), `exp/official-202` (2.0.2 regression baseline),
  `exp/official-nonm` (`nodeModulesDir:"none"`),
  `exp/ws` (workspace/HMR), `exp/plc` (deno-plc on Vite 8), `exp/tsag` (transitionsag), `exp/jsr-nm`, `exp/jsr-pkgjson`
  (Deno `jsr:` install behaviour)
