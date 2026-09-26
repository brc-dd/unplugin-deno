---
'unplugin-deno': minor
---

First release: Deno's module resolution for Vite 8 and 7, Rolldown (and tsdown), Rollup 4 and esbuild, with the bundler running on Node.js, Deno or Bun and no Deno installation needed.

- `jsr:`, `npm:` (subpaths, CommonJS), `https:`, `data:` and `node:` imports, and `with { type: "text" | "bytes" | "css" }` import attributes on every supported bundler.
- `deno.json` import maps and scopes, which win over `node_modules`; workspaces with glob members, member-scoped imports and `links`; `deno.lock` pins and integrity checks of remote modules; without a lockfile, the versions `deno install` would pick (`minimumDependencyAge`).
- npm packages from Deno's global cache or installed into `node_modules` (`nodeModulesDir: "auto"`), resolved by the bundler itself, so `exports`, `browser` and `sideEffects` apply.
- Remote and JSR modules written as plain files with source maps under `node_modules/.unplugin-deno` and reused by later builds.
- Deno server output (`platform: 'deno'`, the server environments of a Vite project with a `deno.json`, esbuild's `packages: 'external'`): `npm:` and `jsr:` imports stay external, pinned to exact versions, so the output runs under `deno run --cached-only`.
- Vite: a platform per environment, the `deno` export condition for Deno server environments, JSR, npm, `https:` and `data:` dependencies prebundled in one optimizer run, full reloads when `deno.json` or `deno.lock` change, and workspace members outside the Vite root.
- esbuild: `deno.json` found from `absWorkingDir`, `esbuild.context()` rebuilds that pick up `deno.json` changes, and esbuild's own `external` option respected.
- Errors with stable codes and hints; `debug: true` or `DEBUG=unplugin-deno` prints what the plugin found.

Not included yet: webpack, Rspack, Rsbuild, Bun.build and Farm (their entries do nothing), `unplugin-deno/register` and `unplugin-deno/api` (they throw), the `deno` engine, `lockfile: 'frozen'`, `allowImport` and the other options the README lists as planned.
