# `hosts/`

Per-host adapters
([docs/architecture.md §6](../../../../docs/architecture.md#6-host-adapters-srchosts)): only
what unplugin's generic hooks cannot express, reached through unplugin's escape hatches.

- `shared.ts`: `HostContext`, `createHostLogger` (warnings through `this.warn`, info and debug
  lines through `this.info`, stderr without a context; errors are logged, never thrown) and
  `toRollupResult`, which turns a core `ResolveOutcome` into a Rollup-family `resolveId` result
  (npm redirects and host-resolved markers through `this.resolve` with `skipSelf: true`).
- `rolldown/`: `options` (platform, `cwd`, inputs; loads the project so the Rust-side filters can
  name import-map keys and the mirror directory), `resolveId`/`load` with native filters and
  `moduleType: 'js'`, `closeBundle`.
- `rollup/`: `resolveId` turning `attributes.type` into the `?deno-type=` marker (no id filter,
  so local imports with attributes reach it), `load` with a native filter, `closeBundle`.
- `esbuild/`: the whole plugin on esbuild's own API (the factory returns only `esbuild.setup`,
  because unplugin's generic adapter would register a catch-all `onResolve` first):
  - `index.ts`: `setup` loads the project (root `absWorkingDir`, platform and conditions from
    `initialOptions`) and registers Go-side filters: owned schemes, the marker and the import-map
    keys; bare specifiers only for importers the engine owns (Deno's global npm cache, the
    mirror) when npm packages come from the global cache; `.css` imports for local
    `with { type: "css" }`. Files are returned in the `file` namespace (esbuild loads them and
    the mirror's linked source maps), npm redirects go through `build.resolve` from the package
    (forwarding `sideEffects`), markers are synthesised in the `unplugin-deno` namespace under
    root-relative paths. `onStart` reloads the project when a watched file changed (esbuild has
    no `watchChange`) and seeds the engine once per engine; `onEnd` flushes the mirror manifest
    and returns the buffered warnings; the last `onDispose` disposes the engines. One plugin
    instance may serve several builds (reloading for other settings) unless two with different
    `absWorkingDir`/`platform`/`conditions`/`packages` run at once.
  - `external.ts`: esbuild's `external` patterns, which esbuild applies only after the plugins,
    so matching imports are left to esbuild; `options.ts`: host facts from `initialOptions` and
    the options `packages: 'external'` implies; `paths.ts`: namespace paths; `messages.ts`: errors
    as esbuild messages (code, hint note, `detail`) and the warning buffer; `snapshot.ts`:
    watched-file change detection.

- `vite/`: hooks merged over the generic ones (Vite 8 and 7):
  - `index.ts`: `config` loads the project for the Vite root, appends the dev-only
    `https:`/`data:` alias after the configured aliases and defaults `cacheDir` to
    `<root>/node_modules/.vite` for Deno projects without a `package.json`; `configEnvironment`
    adds the `deno` export condition to server environments on the Deno platform and the
    optimizer plugin to every environment's `optimizeDeps` (dev server); `configResolved`
    extends `server.fs.allow` (mirror, workspace root); `configureServer` watches the project's
    config files and lockfile and, when one changes, reloads the project, invalidates every
    environment and sends a full reload (`hotUpdate` leaves those files to it); `resolveId`
    resolves for the platform of `this.environment`, keeps builtins with Vite, returns
    prebundled ids in the dev server and virtual ids for markers; `load` synthesises markers
    (watching their file) and serves mirror files.
  - `environment.ts`: the platform and resolve target of an environment (client → browser;
    server → `platform` option, else `deno` with a `deno.json`; `npm:`/`jsr:` bundled for Deno
    server environments in the dev server, whose module runner cannot load them as externals).
  - `optimizer.ts`: prebundled dependencies keyed on the specifier as written (the scanner's
    key, so the optimizer runs once), registration of global-cache packages and of `https:`/
    `data:` URLs during the scan, and the Rolldown optimizer plugin; `optimizer-esbuild.ts`: its
    esbuild twin for Vite 7's optimizer.
  - `marker.ts`: `\0deno:<type>:<file>.js` marker ids, which Vite's CSS, JSON and framework
    plugins do not claim by extension; `install.ts`: installs `nodeModulesDir: "auto"` npm
    packages (by adding their requirement to the engine) before their first resolution.

webpack, Rspack, Rsbuild and Bun (M2) are not implemented yet.
