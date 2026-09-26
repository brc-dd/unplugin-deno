# unplugin-deno

Deno's module resolution for your bundler: `jsr:`, `npm:`, `https:` and `data:` imports,
`deno.json` import maps and workspaces, `deno.lock`, and `with { type: "text" | "bytes" | "css" }`
imports in Vite, Rolldown, Rollup, esbuild, webpack, Rspack and Rsbuild. The bundler can run on
Node.js, Deno or Bun, and Deno does not need to be installed: the plugin ships Deno's resolver
([`@deno/loader`](https://jsr.io/@deno/loader)) as WebAssembly, and uses an installed Deno only
for the few features that resolver lacks. Built on [unplugin](https://github.com/unjs/unplugin).

## Hosts

| Host             | Entry                    | Tested with                  |
| ---------------- | ------------------------ | ---------------------------- |
| Vite 8 and 7     | `unplugin-deno/vite`     | 8.3.1, 7.3.6                 |
| Rolldown, tsdown | `unplugin-deno/rolldown` | Rolldown 1.2.11, tsdown 0.23 |
| Rollup 4         | `unplugin-deno/rollup`   | 4.63.5                       |
| esbuild          | `unplugin-deno/esbuild`  | 0.28.2                       |
| webpack 5.108+   | `unplugin-deno/webpack`  | 5.111.1                      |
| Rspack 2         | `unplugin-deno/rspack`   | 2.2.7                        |
| Rsbuild 2        | `unplugin-deno/rsbuild`  | 2.2.9                        |

Planned: Bun.build and Farm (best effort); their entries (`unplugin-deno/bun`, `/farm`) do nothing
yet. The bundler can run under Node.js 22.12+, Deno or Bun.

## Install

```sh
npm install -D unplugin-deno   # or pnpm, yarn, bun
deno add npm:unplugin-deno     # or: deno add jsr:@brc-dd/unplugin-deno
```

## Quick start

Add the plugin before other plugins. Every option is optional.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import deno from 'unplugin-deno/vite'

export default defineConfig({ plugins: [deno()] })
```

The other hosts take `plugins: [deno()]` from their entry too:

- esbuild, Rolldown and tsdown. tsdown builds for `node` by default, which is the Deno platform in a
  project with a `deno.json`: set `platform` (see [Platforms](#platforms)).
- Rollup, with a `platform` (Rollup has none of its own) and your TypeScript plugin after this one.
- webpack and Rspack, with a TypeScript loader that keeps import attributes: `esbuild-loader` with
  `target: 'esnext'`, or `builtin:swc-loader` with `jsc.experimental.keepImportAttributes: true`.
- Rsbuild, whose SWC settings keep import attributes.

## What works

- `jsr:`, `npm:` (subpaths, CommonJS), `https:`, `data:` and `node:` imports, and the import
  attributes `text`, `bytes` and `css` in static and dynamic imports.
- `deno.json` `imports` and `scopes` (they win over `node_modules`); workspaces with glob members,
  member-scoped `imports` and `links`; `catalog:` versions through an installed Deno.
- `deno.lock` version 5 pins and integrity checks. Without a lockfile, versions match
  `deno install` (`minimumDependencyAge`, 24 hours by default).
- npm packages from Deno's global cache (`nodeModulesDir: "none"`, the default without a
  `package.json`) or `node_modules` (`"auto"`; JSR packages too with `jsrDepsInNodeModules`),
  resolved by the bundler itself, so `exports`, `browser` and `sideEffects` apply.
- Remote and JSR modules become files with source maps under `node_modules/.unplugin-deno`, reused
  by later builds and prebundled by Vite's dev server.
- Deno's semantics for your code (JSX settings, `.wasm` imports, `import.meta.main`, environment
  variables), and warnings for `Deno.*` and `node:` in browser bundles, npm native addons and npm
  packages bundled in several versions.
- Vite: `deno.json` and `deno.lock` changes reload the dev server's page; workspace members outside
  the root update when edited; workers resolve Deno specifiers; CSS `@import` sees path-like
  import-map keys. webpack and Rspack: watch mode reloads `deno.json`, and webpack's persistent
  cache has the config files and the lockfile as build dependencies.
- Other plugins' `virtual:` and `\0` modules, and queries such as `?raw`, are left alone. Errors
  carry a stable `code` and a hint; `debug: true` (or `DEBUG=unplugin-deno`) prints the config,
  lockfile, engine and platform the plugin found.

## Options

| Option             | Type                                                    | Default                       | Description                                                                           |
| ------------------ | ------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `cwd`              | `string`                                                | bundler root                  | Where `deno.json` discovery starts; base of relative paths.                           |
| `config`           | `string \| false`                                       | discovered                    | Path of the `deno.json(c)`; `false` turns discovery off.                              |
| `cacheDir`         | `string`                                                | `node_modules/.unplugin-deno` | Where remote modules are written (default: under the workspace root).                 |
| `engine`           | `'auto' \| 'loader' \| 'deno'`                          | `'auto'`                      | Who resolves, see [Engines](#engines).                                                |
| `denoBinary`       | `string`                                                | `'deno'`                      | The Deno executable of the `deno` engine.                                             |
| `platform`         | `'auto' \| Platform \| Record<string, Platform>`        | `'auto'`                      | Where the output runs, see [Platforms](#platforms).                                   |
| `conditions`       | `string[]`                                              | `[]`                          | Extra export conditions for packages.                                                 |
| `npm`              | `'auto' \| 'node_modules' \| 'deno-cache'`              | `'auto'`                      | Where npm packages load from; `'auto'` follows `nodeModulesDir`.                      |
| `lockfile`         | `'auto' \| 'frozen' \| 'off'`                           | `'auto'`                      | See [Lockfile and offline](#lockfile-and-offline).                                    |
| `cachedOnly`       | `boolean`                                               | `false`                       | Never download; fail with `CACHED_ONLY_MISS` instead.                                 |
| `allowImport`      | `string[]`                                              | Deno's defaults               | Hosts `https:` imports may come from, like `--allow-import`.                          |
| `fetch`            | `typeof fetch`                                          | `globalThis.fetch`            | What the `loader` engine downloads with.                                              |
| `exclude`          | `Pattern \| Pattern[]`                                  | `[]`                          | Imports (or import-map keys) left to the bundler.                                     |
| `importers`        | `{ include?: Pattern[]; exclude?: Pattern[] }`          | all                           | Only handle imports from matching modules (path prefixes or RegExps).                 |
| `external`         | `Pattern[]`                                             | `[]`                          | Keep matching imports as imports in the output.                                       |
| `bundle`           | `Pattern[]`                                             | `[]`                          | Bundle matching imports even for `platform: 'deno'`.                                  |
| `pinExternals`     | `boolean`                                               | `true` for `'deno'`           | Rewrite external `npm:` and `jsr:` imports to the exact resolved versions.            |
| `emitDenoConfig`   | `boolean \| string`                                     | `false`                       | Write `deno.json` and `deno.lock` for Deno output (a string names the directory).     |
| `importAttributes` | `boolean`                                               | `true`                        | Handle `with { type: "text" \| "bytes" \| "css" }`.                                   |
| `wasm`             | `boolean`                                               | `true`                        | Instantiate `.wasm` module imports like Deno.                                         |
| `importMetaMain`   | `boolean`                                               | `true`                        | Make `import.meta.main` `false` outside entry modules.                                |
| `env`              | `{ prefix?; allow?; files?; server? } \| false`         | `false`                       | Inline environment variables, see below.                                              |
| `denoGlobals`      | `'error' \| 'warn' \| 'off'`                            | `'warn'` for the browser      | What to do when local code of a browser bundle uses `Deno.*`.                         |
| `jsx`              | `'auto' \| 'host' \| 'deno'`                            | `'auto'`                      | Apply the `deno.json` JSX settings (`'host'`: never; `'deno'`: planned, as `'auto'`). |
| `checks`           | `boolean \| { browserSafety?; duplicates?; lockfile? }` | all on                        | The warnings and the lockfile explanations.                                           |
| `debug`            | `boolean`                                               | `DEBUG=unplugin-deno`         | Print what the plugin discovered.                                                     |
| `resolve`          | `(specifier, importer, { host, platform }) => ...`      | none                          | Return a new specifier, `false` (leave it to the bundler) or `null` (default).        |

The bundler root is Vite's `root`, esbuild's `absWorkingDir`, Rolldown's `cwd`, webpack's and
Rspack's `context` or Rsbuild's root, else `process.cwd()`; with `config` in a subdirectory, the
mirror goes to that directory's `node_modules` unless `cacheDir` says otherwise. `Platform` is
`'browser' | 'node' | 'deno' | 'neutral'`. A `Pattern` is a RegExp or a `deno bundle`-style string:
`npm:*`, `jsr:@std/*`, or a specifier, which also matches its subpaths and every version
(`npm:kleur` matches `npm:kleur@^4/colors`). `env: { prefix: 'PUBLIC_' }` inlines
`Deno.env.get("PUBLIC_X")` and `process.env.PUBLIC_X` from the process and `.env`/`.env.local`
(`files`); `allow` names more variables, and `server: true` inlines into server output too.

## Engines

`engine: 'auto'` (the default) resolves with the bundled loader, which needs no Deno installation.
It switches to the installed Deno CLI (2.8.3 or later, `denoBinary`) when the project uses what
the loader lacks: `catalog:` versions (in `deno.json` or `package.json`), globs in `links`,
`jsrDepsInNodeModules`, or a `JSR_URL` naming another registry. Without a usable Deno it warns and
uses the loader. `'loader'` and `'deno'` choose one. Neither engine writes your `deno.lock`.

## Platforms

The platform decides what stays external. `'auto'` derives it from the bundler, never from the
runtime running the build:

| Build                                                     | Platform                               |
| --------------------------------------------------------- | -------------------------------------- |
| Vite client environments, Rsbuild `web`/`web-worker` ones | `browser`                              |
| Vite server environments, Rsbuild `node` environments     | `deno` with a `deno.json`, else `node` |
| esbuild or Rolldown, `platform` unset or `'browser'`      | `browser`                              |
| esbuild or Rolldown (tsdown), `'node'` or `'neutral'`     | `deno` with a `deno.json`, else `node` |
| Rollup; webpack or Rspack with a Node.js target           | `deno` with a `deno.json`, else `node` |
| webpack or Rspack with a web target                       | `browser`                              |
| webpack `target: 'deno'`                                  | `deno`                                 |

A `platform` string overrides this (in Vite and Rsbuild, for server environments only); a record
names Vite or Rsbuild environments. `browser`, `node` and `neutral` bundle `npm:`, `jsr:` and
`https:` imports; `node:` imports stay external, except in browser builds, where they are left to
the bundler. esbuild's `packages: 'external'` keeps `npm:` and `jsr:` imports external and pinned.

### Deno server output

On the `deno` platform, `npm:` and `jsr:` imports (bare names mapped to them included) stay in the
output with exact versions, such as `npm:kleur@4.1.5` and `jsr:@std/path@1.1.6`; local and `https:`
modules are bundled. The output needs no `deno.json`: cache its dependencies once, then run it
offline, as Deno Deploy does: `deno cache dist/server.js`, then
`deno run -A --cached-only dist/server.js`.

`emitDenoConfig: true` also writes a `deno.json` (`"lock": "./deno.lock"`, `"nodeModulesDir":
"none"`) and a `deno.lock` of the external packages (copied from your `deno.lock`, or from Deno's
cache) next to the entry chunk (webpack and Rspack: into `output.path`), so the output also runs
with `deno run --frozen --cached-only`. `bundle: ['npm:some-package']` bundles a package anyway;
`pinExternals: false` keeps version ranges (`npm:kleur@^4`). On webpack and Rspack, Deno output
must be ES modules (`output.module: true`); webpack's `target: 'deno'` keeps the pinned externals.
In Vite's dev server, server code loads `npm:` and `jsr:` imports through Vite (its module runner
cannot import them); builds keep them external.

## Import attributes, JSX and Wasm

- `with { type: "text" }` imports a string, `"bytes"` a `Uint8Array` and `"css"` a
  `CSSStyleSheet`, as in Deno; `"json"` is left to the bundler.
- The `compilerOptions.jsx*` settings of `deno.json` configure the bundler's JSX transform unless
  its config sets JSX (on webpack and Rspack: `esbuild-loader`, `swc-loader` and
  `builtin:swc-loader` rules). `jsxImportSource` resolves through the import map.
- `import { add } from './add.wasm'` instantiates the module as Deno does, with its own imports
  resolved next to it. webpack and Rspack leave the `.wasm` files of npm packages to their own Wasm
  support; `wasm: false` leaves every `.wasm` file to the bundler.

## Lockfile and offline

The plugin reads `deno.lock` and never writes it. `lockfile: 'auto'` uses its pins and resolves
what it does not cover as `deno install` would; `'frozen'` fails with `LOCKFILE_FROZEN_DRIFT` when
an import resolves to something `deno.lock` does not record, and `'auto'` is frozen when the `CI`
environment variable is set or `deno.json` sets `"lock": { "frozen": true }`; `'off'` ignores
`deno.lock`. `cachedOnly: true` never downloads: a module missing from Deno's cache fails with
`CACHED_ONLY_MISS`, whose hint names the command that fills the cache (`deno cache src/main.ts`),
and a package `deno.lock` lacks with `NOT_IN_LOCKFILE`. `https:` imports must come from Deno's
default `--allow-import` hosts, hosts `deno.lock` or the import maps name, or `allowImport`
(`[...DEFAULT_ALLOW_IMPORT, 'example.com']`); others fail with `DISALLOWED_HOST` before any
download.

## Private registries

The `loader` engine reads `NPM_CONFIG_REGISTRY` and `.npmrc` auth tokens, and downloads with
`globalThis.fetch`: pass `fetch` to add authentication or to send JSR requests elsewhere. On
Node.js, `fetch` honours `HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1` (Node.js 24+). A JSR
registry in `JSR_URL` (with `DENO_AUTH_TOKENS`) needs the `deno` engine, which `engine: 'auto'`
picks when Deno is installed.

## Running the bundler under Deno

Run the bundler's CLI through Deno, for example `deno run -A npm:vite build`. Rolldown (and Vite 8,
which uses it) loads a native addon, so a permission list without `-A` needs `--allow-ffi`. When
`deno.json` sets `"nodeModulesDir": "none"`, add `--node-modules-dir=manual` so that Deno loads the
bundler and the plugin from `node_modules`.

## Limitations

- esbuild has no transform hook: `env` inlines only `process.env.X` (through `define`),
  `import.meta.main` is replaced only in remote modules, `denoGlobals` has no effect, and import-map
  keys added while an `esbuild.context()` runs need a new context (the plugin warns).
- Rollup needs its usual TypeScript, JSON, CommonJS and node-resolve plugins after this one; its
  `jsx` option compiles the JSX your TypeScript plugin preserves, without a development runtime.
- `"jsx": "precompile"` compiles with the automatic runtime and a warning (`jsx: 'deno'` is
  planned). `.wasm` modules compile synchronously, which Chromium allows on the main thread only
  up to 4 KB.
- Vite rebuilds a dependency it has prebundled after a `deno.json` or `deno.lock` change only at
  the next dev server start. webpack, Rspack and Rsbuild are tested with builds and watch mode, not
  with their dev servers.
- Projects with a `package.json` (`nodeModulesDir: "manual"`) have no end-to-end build tests yet.
- From JSR (the package running under Deno from `jsr.io` URLs), the webpack, Rspack and Rsbuild entries need the
  npm package instead: they locate unplugin's loader files with `require`.
- `unplugin-deno/register` and `createDenoResolver` from `unplugin-deno/api` (planned) throw
  `ENGINE_UNAVAILABLE`, and `unplugin-deno/esbuild` refuses `Bun.build`.
- npm lifecycle scripts never run. Source maps of npm packages from Deno's global cache keep their
  `DENO_DIR` paths. `deno.lock` files older than version 5 are ignored with a warning.

## Comparison

From our research in September 2026 (`@deno/vite-plugin` 2.0.4, `@deno/esbuild-plugin` 1.2.1,
`@luca/esbuild-deno-loader` 0.11.1):

- Each of them supports one bundler, and the two esbuild plugins run only under Deno.
  unplugin-deno supports seven bundlers from one package and runs under Node.js, Deno and Bun.
- Like `@luca/esbuild-deno-loader`, and unlike `@deno/esbuild-plugin`, it lets the bundler resolve
  npm packages, so `sideEffects` tree-shaking works. Unlike `@deno/vite-plugin`, it has JSR modules
  prebundled in Vite's dev server.
- It has regression tests for issues reported against them, such as `npm:` subpaths
  (denoland/deno-vite-plugin#98), other plugins' `virtual:` ids (#101) and `absWorkingDir`
  (denoland/deno-esbuild-plugin#29).
- None of them keeps `npm:` and `jsr:` imports external and pinned for Deno output, and none
  imports `with { type: "text" | "bytes" }` the way Deno does.

## Credits

- [`@deno/loader`](https://github.com/denoland/deno-js-loader) (MIT, the Deno authors): a patched
  copy ships in `vendor/deno-loader` (see its
  [NOTICE](https://github.com/brc-dd/unplugin-deno/blob/main/packages/unplugin-deno/vendor/deno-loader/NOTICE.md)).
- The `deno` engine resolves the files of npm packages with a port of Deno's
  [`node_resolver`](https://crates.io/crates/node_resolver) (MIT, the Deno authors).
- Version requirement parsing is ported from
  [`deno_semver`](https://github.com/denoland/deno_semver) (MIT, the Deno authors).
- The import-map tests use [web-platform-tests](https://github.com/web-platform-tests/wpt) data
  (3-Clause BSD, web-platform-tests contributors) and cases from
  [`denoland/import_map`](https://github.com/denoland/import_map) (MIT, the Deno authors).

## License

[MIT](https://github.com/brc-dd/unplugin-deno/blob/main/LICENSE). Contributing:
[docs/contributing.md](https://github.com/brc-dd/unplugin-deno/blob/main/docs/contributing.md).

Not affiliated with Deno Land Inc.; "Deno" only describes what the plugin is compatible with.
