# unplugin-deno

Deno's module resolution for your bundler: `jsr:`, `npm:`, `https:` and `data:` imports, `deno.json`
import maps and workspaces, `deno.lock`, and `with { type: "text" | "bytes" | "css" }` imports in
Vite, Rolldown, Rollup and esbuild. The bundler can run on Node.js, Deno or Bun, and Deno does not
need to be installed: the plugin ships Deno's resolver
([`@deno/loader`](https://jsr.io/@deno/loader)) as WebAssembly. Built on
[unplugin](https://github.com/unjs/unplugin).

> [!IMPORTANT]
> Pre-release (0.1). Nothing is published yet: npm has only a `0.0.0` placeholder and JSR has no
> package, so the install commands below work once 0.1.0 is released.

## Hosts

| Host             | Entry                    | Tested with  |
| ---------------- | ------------------------ | ------------ |
| Vite 8 and 7     | `unplugin-deno/vite`     | 8.3.1, 7.3.6 |
| Rolldown, tsdown | `unplugin-deno/rolldown` | Rolldown 1.2 |
| Rollup 4         | `unplugin-deno/rollup`   | 4.63         |
| esbuild          | `unplugin-deno/esbuild`  | 0.28         |

Planned: webpack 5, Rspack and Rsbuild, Bun.build, and Farm (best effort). Their entries
(`unplugin-deno/webpack`, `/rspack`, `/rsbuild`, `/bun`, `/farm`) exist but do nothing yet. The
bundler can run under Node.js 22.12+, Deno or Bun.

## Install

```sh
npm install -D unplugin-deno
pnpm add -D unplugin-deno
yarn add -D unplugin-deno
bun add -d unplugin-deno
deno add npm:unplugin-deno # or: deno add jsr:@brc-dd/unplugin-deno
```

## Quick start

Add the plugin before other plugins. Every option is optional.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import deno from 'unplugin-deno/vite'

export default defineConfig({ plugins: [deno()] })
```

```ts
// rolldown.config.ts (in tsdown.config.ts, use deno({ platform: 'node' }): see Platforms)
import { defineConfig } from 'rolldown'
import deno from 'unplugin-deno/rolldown'

export default defineConfig({ input: 'src/main.ts', plugins: [deno()] })
```

```js
// rollup.config.js: Rollup has no platform of its own; add your TypeScript plugin after this one
import deno from 'unplugin-deno/rollup'

export default { input: 'src/main.ts', plugins: [deno({ platform: 'browser' })] }
```

```ts
// build.ts
import { build } from 'esbuild'
import deno from 'unplugin-deno/esbuild'

await build({ entryPoints: ['src/main.ts'], bundle: true, outdir: 'dist', plugins: [deno()] })
```

## What works

- `jsr:`, `npm:` (subpaths, CommonJS), `https:`, `data:` and `node:` imports, and the import
  attributes `text`, `bytes` and `css` (a `CSSStyleSheet`) in static and dynamic imports.
- `deno.json` `imports` and `scopes` (the import map wins over `node_modules`); workspaces with glob
  members, member-scoped `imports` and `links`.
- `deno.lock` version 5: pinned versions and integrity checks of remote modules. Without a lockfile,
  versions match `deno install` (`minimumDependencyAge`, 24 hours by default).
- npm packages from Deno's global cache (`nodeModulesDir: "none"`, the default without a
  `package.json`) or installed into `node_modules` (`"auto"`), resolved by the bundler itself, so
  `exports`, `browser` and `sideEffects` (tree-shaking) apply.
- Remote and JSR modules become plain files with source maps under `node_modules/.unplugin-deno`,
  reused by later builds and prebundled by Vite's dev server.
- Deno server output with pinned `npm:` and `jsr:` imports (see [Platforms](#platforms)).
- Vite dev server: `deno.json` and `deno.lock` changes reload the page; workspace members outside
  the Vite root are served and update when edited.
- Other plugins' `virtual:` and `\0` modules, and queries such as `?raw`, are left alone.
- Errors carry a stable `code` and a hint. `debug: true` (or `DEBUG=unplugin-deno`) prints the
  config, lockfile and platform the plugin found.

## Options

| Option             | Type                                               | Default                       | Description                                                                           |
| ------------------ | -------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- |
| `cwd`              | `string`                                           | bundler root                  | Where `deno.json` discovery starts; base of relative paths.                           |
| `config`           | `string \| false`                                  | discovered                    | Path of the `deno.json(c)`; `false` turns discovery off.                              |
| `cacheDir`         | `string`                                           | `node_modules/.unplugin-deno` | Where remote modules are written (default: under the workspace root).                 |
| `platform`         | `'auto' \| Platform \| Record<string, Platform>`   | `'auto'`                      | Where the output runs, see [Platforms](#platforms). A record names Vite environments. |
| `conditions`       | `string[]`                                         | `[]`                          | Extra export conditions for packages.                                                 |
| `npm`              | `'auto' \| 'node_modules' \| 'deno-cache'`         | `'auto'`                      | Where npm packages load from; `'auto'` follows `nodeModulesDir`.                      |
| `lockfile`         | `'auto' \| 'frozen' \| 'off'`                      | `'auto'`                      | `'off'` ignores `deno.lock`. `'frozen'` is planned and acts like `'auto'`.            |
| `cachedOnly`       | `boolean`                                          | `false`                       | Never download; fail with `CACHED_ONLY_MISS` instead.                                 |
| `exclude`          | `Pattern \| Pattern[]`                             | `[]`                          | Imports (or import-map keys) left to the bundler.                                     |
| `importers`        | `{ include?: Pattern[]; exclude?: Pattern[] }`     | all                           | Only handle imports from matching modules (path prefixes or RegExps).                 |
| `external`         | `Pattern[]`                                        | `[]`                          | Keep matching imports as imports in the output.                                       |
| `bundle`           | `Pattern[]`                                        | `[]`                          | Bundle matching imports even for `platform: 'deno'`.                                  |
| `pinExternals`     | `boolean`                                          | `true` for `'deno'`           | Rewrite external `npm:` and `jsr:` imports to the exact resolved versions.            |
| `importAttributes` | `boolean`                                          | `true`                        | Handle `with { type: "text" \| "bytes" \| "css" }`.                                   |
| `debug`            | `boolean`                                          | `DEBUG=unplugin-deno`         | Print what the plugin discovered.                                                     |
| `resolve`          | `(specifier, importer, { host, platform }) => ...` | none                          | Return a new specifier, `false` (leave it to the bundler) or `null` (default).        |

The bundler root is Vite's `root`, esbuild's `absWorkingDir` or Rolldown's `cwd`, else
`process.cwd()`. `Platform` is `'browser' | 'node' | 'deno' | 'neutral'`. A `Pattern` is a RegExp
or a `deno bundle`-style string: `npm:*`, `jsr:@std/*`, or a specifier, which also matches its
subpaths and every version (`npm:kleur` matches `npm:kleur@^4/colors`).

Planned, accepted but without effect yet: `allowImport`, `emitDenoConfig`, `importMetaMain`, `env`,
`denoGlobals`, `jsx`, `checks`, `denoBinary`. `engine: 'deno'` (use an installed Deno) fails with
`ENGINE_UNAVAILABLE`; the default engine is the bundled loader.

## Platforms

The platform decides what stays external. `'auto'` derives it from the bundler, never from the
runtime running the build:

| Build                                                 | Platform                               |
| ----------------------------------------------------- | -------------------------------------- |
| Vite client environments                              | `browser`                              |
| Vite server environments (`vite build --ssr`)         | `deno` with a `deno.json`, else `node` |
| esbuild or Rolldown, `platform` unset or `'browser'`  | `browser`                              |
| esbuild or Rolldown (tsdown), `'node'` or `'neutral'` | `deno` with a `deno.json`, else `node` |
| Rollup                                                | `deno` with a `deno.json`, else `node` |

A `platform` string overrides this (in Vite, for server environments only). `browser`, `node` and
`neutral` bundle `npm:`, `jsr:` and `https:` imports; `node:` imports stay external, except in
browser builds, where they are left to the bundler. esbuild's `packages: 'external'` keeps `npm:`
and `jsr:` imports external and pinned on every platform.

### Deno server output

On the `deno` platform, `npm:` and `jsr:` imports (bare names mapped to them included) stay in the
output with exact versions, such as `npm:kleur@4.1.5` and `jsr:@std/path@1.1.6`; local and `https:`
modules are bundled. The output needs no `deno.json`: cache its dependencies once, then run it
offline, as Deno Deploy does.

```sh
deno cache dist/server.js
deno run -A --cached-only dist/server.js
```

`bundle: ['npm:some-package']` bundles a package anyway; `pinExternals: false` keeps version ranges
(`npm:kleur@^4`). In Vite's dev server, server code loads `npm:` and `jsr:` imports through Vite
(its module runner cannot import them); builds keep them external.

## Running the bundler under Deno

Run the bundler's CLI through Deno, for example `deno run -A npm:vite build`. Rolldown (and Vite 8,
which uses it) loads a native addon, so a permission list without `-A` needs `--allow-ffi`.

## Limitations

- `unplugin-deno/esbuild` refuses `Bun.build` with `ENGINE_UNAVAILABLE`, and so do
  `unplugin-deno/register` (on import) and `createDenoResolver` from `unplugin-deno/api` (planned).
- Rollup needs its usual plugins for TypeScript, JSON, CommonJS (`@rollup/plugin-commonjs`) and for
  packages outside the import map (`@rollup/plugin-node-resolve`); add them after this one.
- esbuild reads plugin filters once: import-map keys added while an `esbuild.context()` runs need a
  new context (the plugin warns).
- Vite: worker bundles do not get the plugin yet. After a `deno.json` or `deno.lock` change, a
  dependency Vite has already prebundled is rebuilt at the next dev server start.
- JSX settings in `deno.json` `compilerOptions` apply to remote modules only: configure JSX for
  local files in the bundler.
- Remote imports are not restricted to Deno's `--allow-import` hosts yet. npm lifecycle scripts
  never run. `deno.lock` files older than version 5 are ignored with a warning.
- Projects with a `package.json` (`nodeModulesDir: "manual"`) have no end-to-end tests yet, and
  some tests do not pass on Windows yet.

## Comparison

From our research in September 2026 (`@deno/vite-plugin` 2.0.4, `@deno/esbuild-plugin` 1.2.1,
`@luca/esbuild-deno-loader` 0.11.1):

- Each of them supports one bundler, and the two esbuild plugins run only under Deno.
  unplugin-deno supports four bundlers from one package and runs under Node.js, Deno and Bun.
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
- The import-map tests use [web-platform-tests](https://github.com/web-platform-tests/wpt) data
  (3-Clause BSD, web-platform-tests contributors) and cases from
  [`denoland/import_map`](https://github.com/denoland/import_map) (MIT, the Deno authors).
- Version requirement parsing is ported from
  [`deno_semver`](https://github.com/denoland/deno_semver) (MIT, the Deno authors).

## License

[MIT](https://github.com/brc-dd/unplugin-deno/blob/main/LICENSE). Contributing:
[docs/contributing.md](https://github.com/brc-dd/unplugin-deno/blob/main/docs/contributing.md).

Not affiliated with Deno Land Inc.; "Deno" only describes what the plugin is compatible with.
