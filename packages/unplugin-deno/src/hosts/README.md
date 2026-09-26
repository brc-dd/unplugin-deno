# `hosts/`

Per-host adapters
([docs/architecture.md §6](../../../../docs/architecture.md#6-host-adapters-srchosts)): only
what unplugin's generic hooks cannot express, reached through unplugin's escape hatches.

- `shared.ts`: `HostContext`, `createHostLogger` (warnings through `this.warn`, info and debug
  lines through `this.info`, stderr without a context; errors are logged, never thrown),
  `toRollupResult`, which turns a core `ResolveOutcome` into a Rollup-family `resolveId` result
  (npm redirects and host-resolved markers through `this.resolve` with `skipSelf: true`),
  `transformContext` (the host parser and `getModuleInfo(id).isEntry` for the `transform` hook),
  the `deno.json` JSX settings as Oxc, esbuild and Rollup options, and `rollupEntryDirectory`
  (the directory of the first entry chunk a `writeBundle` wrote). The generic hooks of
  `core/plugin.ts` include `writeBundle`, which writes the sidecar `deno.json`/`deno.lock` of a
  Deno platform build there (`emitDenoConfig`, `core/sidecar.ts`) for Rolldown and Rollup.
- `rolldown/`: `options` (platform, `cwd`, inputs; loads the project so the Rust-side filters can
  name import-map keys and the mirror directory; sets `transform.jsx` from `deno.json` unless it
  is set), `resolveId`/`load` with native filters and `moduleType: 'js'`, `closeBundle`.
- `rollup/`: `options` (inputs, Rollup version; the `jsx` option from `deno.json` unless it is
  set, for the JSX a TypeScript plugin preserves), `resolveId` turning `attributes.type` into the
  `?deno-type=` marker (no id filter, so local imports with attributes reach it), `load` with a
  native filter, `closeBundle`. The generic transform pre-pass stays on (Rollup resolves each
  specifier once per module, whatever its attributes); Rollup's `this.parse` reads only
  JavaScript, so the source scan of TypeScript uses the token scanner.
- `esbuild/`: the whole plugin on esbuild's own API (the factory returns only `esbuild.setup`,
  because unplugin's generic adapter would register a catch-all `onResolve` first):
  - `index.ts`: `setup` refuses hosts that are not esbuild (`Bun.build`), loads the project (root
    `absWorkingDir`, platform and conditions from `initialOptions`) and registers Go-side
    filters: owned schemes, the marker and the import-map keys; bare specifiers only for
    importers the engine owns (Deno's global npm cache, the mirror, `node_modules` with
    `npm: 'deno-cache'`) when npm packages come from the global cache; `.css` imports for local
    `with { type: "css" }`. Files are returned in the `file` namespace (esbuild loads them and
    the mirror's linked source maps), npm redirects go through `build.resolve` from the package
    (forwarding `sideEffects`), markers are synthesised in the `unplugin-deno` namespace under
    root-relative paths. `setup` also sets the `deno.json` JSX options unless the build sets JSX,
    defines the inlined `process.env.<KEY>` variables (`env`; `Deno.env.get()` is not inlined,
    esbuild has no transform hook), loads `.wasm` modules (unless the build has a `.wasm` loader)
    and the mirror files that contain `import.meta.main` (replaced with `false`, the map
    composed and inlined; local files keep theirs). `onStart` reloads the project when a watched
    file changed (esbuild has no `watchChange`) and seeds the engine once per engine; `onEnd`
    flushes the mirror manifest, reports npm packages bundled in several versions, writes the
    sidecar `deno.json`/`deno.lock` of a Deno platform build next to the first entry output (the
    metafile's, else `outdir` or the `outfile` directory; nothing with `write: false`) and
    returns the buffered warnings; the last `onDispose` disposes the engines. One plugin
    instance may serve several builds (reloading for other settings) unless two with different
    `absWorkingDir`/`platform`/`conditions`/`packages` run at once.
  - `external.ts`: esbuild's `external` patterns, which esbuild applies only after the plugins,
    so matching imports are left to esbuild; `options.ts`: host facts from `initialOptions`, the
    options `packages: 'external'` implies, and the JSX and `define` build options; `mirror.ts`:
    mirror files with `import.meta.main` replaced; `paths.ts`: namespace paths; `messages.ts`:
    errors as esbuild messages (code, hint note, `detail`) and the warning buffer;
    `snapshot.ts`: watched-file change detection.
- `vite/`: hooks merged over the generic ones (Vite 8 and 7):
  - `index.ts`: `config` loads the project for the Vite root, applies the `deno.json` JSX
    settings (`oxc.jsx` on Vite 8, `esbuild.jsx*` on Vite 7) unless the config sets JSX, appends
    the path-like import-map entries (the root map with the Vite root's member scope over it) and
    the dev-only `https:`/`data:` alias after the configured aliases, registers a second plugin
    instance in `worker.plugins` for worker bundles, and defaults `cacheDir` to
    `<root>/node_modules/.vite` for Deno projects without a `package.json`; `configEnvironment`
    adds the `deno` export condition to server environments on the Deno platform and the
    optimizer plugin to every environment's `optimizeDeps` (dev server); `configResolved`
    extends `server.fs.allow` (mirror, workspace root); `configureServer` watches the project's
    config files and lockfile and, when one changes, reloads the project, invalidates every
    environment and sends a full reload (`hotUpdate` leaves those files to it); `resolveId`
    resolves for the platform of `this.environment`, keeps builtins with Vite, returns
    prebundled ids in the dev server and virtual ids for markers; `load` synthesises markers
    (watching their file) and `.wasm` modules and serves mirror files; `transform` runs the
    source transforms for the platform of `this.environment` (`import.meta.main` only in
    builds); `buildEnd` reports npm packages bundled in several versions for that platform;
    `writeBundle` writes the sidecar `deno.json`/`deno.lock` of an environment on the Deno
    platform (`emitDenoConfig`; client environments write none).
  - `environment.ts`: the platform and resolve target of an environment (client → browser;
    server → `platform` option, else `deno` with a `deno.json`; `npm:`/`jsr:` bundled for Deno
    server environments in the dev server, whose module runner cannot load them as externals).
  - `optimizer.ts`: prebundled dependencies keyed on the specifier as written (the scanner's
    key, so the optimizer runs once), registration of global-cache packages and of `https:`/
    `data:` URLs during the scan, and the Rolldown optimizer plugin; `optimizer-esbuild.ts`: its
    esbuild twin for Vite 7's optimizer.
  - `marker.ts`: `\0deno:<type>:<path>.js` marker ids, which Vite's CSS, JSON and framework
    plugins do not claim by extension; `<path>` is relative to the Vite root (`..` written `~u`,
    other drives `~abs/<path>`), so no machine path reaches ids, URLs or output.

- `webpack/`: the webpack 5 adapter (≥ 5.108) under unplugin's `webpack(compiler)` escape hatch,
  and the request handling, source transforms and JSX settings it shares with the Rspack and
  Rsbuild adapters:
  - `index.ts`: an `ExternalsPlugin` applied in `apply` (before the config's externals and
    presets) whose function resolves the requests the plugin owns (`factorize` knows the
    dependency type; the attribute type comes from `beforeResolve`) and keeps external outcomes
    as native externals (`module-import` in ES module output, `node-commonjs` for `require()`);
    `normalModuleFactory.hooks.resolve` rewrites the request to the file (local, npm and mirror
    files; `#` escaped as `\0#`) or, for npm redirects, to `name + subpath` with the package
    directory as context (the engine's file when webpack cannot resolve it); markers and the
    plugin's virtual ids are `unplugin-deno:` scheme modules (`resolveForScheme` gives them a
    JavaScript mimetype, a rule types them `javascript/esm` after webpack's `with { type }`
    rules, `NormalModule.getCompilationHooks().readResource` reads them from `state.load` and adds
    the target as a dependency). The project is loaded in `beforeRun`/`watchRun` (before webpack
    compiles `module.rules`; `beforeCompile` as a fallback), where the rules of `transforms.ts`
    are appended and `jsx.ts` configures the JSX loaders; `afterResolve` records the entry
    modules (no issuer, or a worker), `finishModules` reports npm packages bundled in several
    versions. The `environment` hook turns off `externalsPresets.web` (jsr:, npm:, https:, `//`,
    `std:`) and `.deno` (`target: 'deno'`) unless the config sets them, and logs what it decided
    at info level; `experiments.buildHttp` keeps the URLs it allows. Host facts:
    `compiler.platform` (`deno` → Deno, Node.js targets → `deno` with a `deno.json`, else
    browser), `compiler.context`, `compiler.options.entry`, the user's `resolve.conditionNames`.
    `watchRun` reloads the project for changed config files; they are `fileDependencies` (a
    lockfile not created yet a missing dependency, which some watchers would otherwise report as
    removed) and `buildDependencies` (persistent cache) of every compilation; `done` writes the
    sidecar `deno.json`/`deno.lock` of a Deno platform build into `output.path`
    (`emitDenoConfig`), flushes the manifest and, outside watch mode, disposes the engines;
    `shutdown` and `watchClose` dispose them.
  - `transforms.ts`: `SourceTransforms`, the rules added once the project is loaded: a `pre`
    rule runs `state.transform` (unplugin's public `transform` loader) on local script modules
    (`.[cm][jt]sx?` outside `node_modules`, the mirror and Deno's npm cache; not `?raw` or
    `new URL()` assets) before the user's TypeScript loader, on the source as written (the token
    scanner; `Deno.*` locations are the source's): `import.meta.main` is `false` outside the
    entry modules (`EntryModules`), environment variables are inlined for the browser (the
    `.env` files become module dependencies) and `Deno.*` uses of browser bundles are reported
    (`denoGlobals: 'error'` fails the module's build); mirror files are loaded (unplugin's `load`
    loader) and transformed in one hook, the edit's map composed over the mirror's; `.wasm`
    module imports (no query, not `new URL()`) of local and mirror files are loaded as the
    core's instantiating module, npm packages' `.wasm` files stay with the host's
    `experiments.asyncWebAssembly`. Rule conditions are RegExps (native on Rspack) except the
    Wasm one; loader idents hash the transform settings (platform, options, inlined values) for
    the persistent cache. npm package files are not transformed: webpack (and Rspack 2)
    evaluate their `import.meta.main` per module.
  - `jsx.ts`: the `deno.json` JSX settings (unless `jsx: 'host'`) applied to the JSX loaders of
    `module.rules` that do not configure JSX: esbuild-loader (`jsx`, `jsxImportSource`, `jsxDev`
    / `jsxFactory`, `jsxFragment`; configured when one of esbuild's JSX options or
    `tsconfigRaw.compilerOptions.jsx*` is set) and `builtin:swc-loader`/`swc-loader`
    (`jsc.transform.react`; configured when `runtime`, `importSource`, `pragma` or `pragmaFrag`
    is set), found by package name or path in `loader`, `use` (strings, objects, arrays; not
    functions), `oneOf` and nested `rules`; changed rules are copies. Debug lines say what was
    applied; an info line says what to set when no such loader exists (webpack's
    `experiments.typescript` cannot compile JSX); `precompile` warns once.
  - `requests.ts`: `Router` (attribute types noted in `beforeResolve`, owned requests resolved
    in the externals function once per attribute type and import mode, outcomes applied in the
    `resolve` hook; URL and CSS dependencies and `buildHttp` URLs are left to the host),
    `applyOutcome`, `toHostError` (a `DenoPluginError` as `[unplugin-deno] <message> (<code>)`
    plus the hint, without the plugin's stack), `CompilationLog` (warnings into the current
    compilation, info and debug lines to the infrastructure logger), `ConfigReloader` (one
    reload per change for compilers sharing a state; its `generation` tells the others),
    `WatchedFiles` (the watched files that exist, and the missing ones),
    `loadLoader`/`mirrorLoad` (unplugin's public `unplugin/{webpack,rspack}/loaders/load`
    entries, with an optional ident), `composeMaps`, entries, platform hint, `buildHttp` matcher.
  - `presets.ts`: which presets to take over, the presets' behaviour for the requests the
    plugin leaves to the host (webpack's web preset with `jsr:`/`npm:`, Rspack's without, the
    deno preset's `node:` externals for bare builtins), and the info lines.
  - `synthetic.ts`: the `unplugin-deno:` scheme resources (the target relative to the compiler
    context, so module ids hold no machine paths).
- `rspack/`: the Rspack 2 adapter (`rspack(compiler)`) and the Rspack plugin Rsbuild reuses:
  - `plugin.ts`: `applyRspack(state, compiler, { target, standalone })`: the webpack flow
    (`../webpack/requests.ts`, `transforms.ts`, `jsx.ts`) on Rspack's hooks (its `resolve` hook
    sees scheme requests and their attributes; it has no `resolveInScheme` and never calls
    `readResource`, so neither is used; its native compiler reads `module.rules` at the first
    build, after `beforeRun`); `externalsPresets.web` (http(s):, `//`, `std:`) is taken over as on
    webpack. Entries come from `afterResolve` (no issuer; Rspack does not say which dependencies
    are workers), duplicates are reported per compiler platform in `finishModules`, and `done`
    writes the Deno platform sidecar into `output.path` as on webpack. Standalone compilers set
    the host hints and dispose the engines when done; Rsbuild environments share a state that
    Rsbuild's hooks set up and close. Rspack's incremental rebuild resolves again only
    the imports of the modules it rebuilds, so after a config reload `watchRun` adds the
    importers of the plugin's requests (`Router.importers`) to `modifiedFiles`.
  - `synthetic.ts`: markers as empty `experiments.VirtualModulesPlugin` files under
    `node_modules/.virtual/unplugin-deno/<hash>/<name>.<type>.js`, loaded through unplugin's
    Rspack `load` loader (which adds the target as a dependency, so edits rebuild the marker;
    rewriting a virtual file does not).
  - `index.ts`: `rspackApply(state)`.
- `rsbuild/`: `rsbuildHooks(state)` (Rsbuild 2 does not call unplugin's `rspack(compiler)`):
  `setup(api)` sets the root, loads the project in `api.modifyRspackConfig` and appends the Rspack
  plugin to each environment's config with the environment's target (`web`/`web-worker` →
  browser unless a `platform` record names the environment, `node` → the record entry, a
  `platform` string, or `deno` with a `deno.json`), so the source transforms, checks and Wasm
  modules follow each environment's platform, and the JSX settings reach Rsbuild's
  `builtin:swc-loader` rules once `tools.swc` and plugins such as `@rsbuild/plugin-react` have
  configured them; `onAfterBuild`/`onAfterDevCompile` flush the manifest,
  `onCloseBuild`/`onCloseDevServer` dispose the engines.

What users configure on these hosts (as the integration tests do, with webpack 5.111, Rspack 2.2
and Rsbuild 2.2): a TypeScript loader that keeps import attributes (webpack: `esbuild-loader` with
`target: 'esnext'`; Rspack: `builtin:swc-loader` with `jsc.experimental.keepImportAttributes:
true`; Rsbuild's default SWC settings keep them), a loader that compiles JSX for `.jsx`/`.tsx`
files (esbuild-loader and the SWC loaders get the `deno.json` settings; others are configured by
hand), and ES module output for the Deno platform (`output.module: true`; with script output the
externals become `require()` calls). The attribute types come from the hosts' `beforeResolve`
data (`resolveData.attributes`). `wasm: false` leaves every `.wasm` file to the host's
`experiments.asyncWebAssembly` (or the user's rules). The dev servers (webpack-dev-server, Rspack
and Rsbuild dev) have no tests yet.

Bun and Farm are not implemented yet (planned): `core/plugin.ts` gives them an inert plugin.
