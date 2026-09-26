---
'unplugin-deno': minor
---

Deno's source semantics for local files, and diagnostics, on Vite, Rolldown, Rollup and esbuild:

- JSX: the `compilerOptions.jsx*` settings of `deno.json` (`react-jsx`, `react-jsxdev`, `react` with `jsxFactory`, and `precompile`, compiled with the automatic runtime and a warning) configure the bundler's JSX transform unless its config sets JSX; `jsxImportSource` resolves through the import map (`preact` → `npm:preact@^10`). `jsx: 'host'` leaves the bundler's settings alone.
- `import.meta.main` is `false` in modules that are not entries of the build (`importMetaMain`; on esbuild only in remote modules).
- `env: { prefix: 'PUBLIC_' }` inlines `Deno.env.get("PUBLIC_X")`, `process.env.PUBLIC_X` and `process.env["PUBLIC_X"]` into browser bundles, from the process and `.env`/`.env.local` (or `env.files`); `env.server` inlines for server platforms too. esbuild inlines the `process.env` reads.
- `denoGlobals` (default `'warn'` for the browser): a local module of a browser bundle that uses `Deno.*` is reported once with its location; `'error'` fails the build (`PLATFORM_INCOMPATIBLE`).
- Checks: `node:` builtins imported into browser bundles (with the importer), npm packages resolving to native addons (kept external), and npm packages bundled in several versions are reported (`checks.browserSafety`, `checks.duplicates`).
- `.wasm` module imports are instantiated like in Deno, with their own imports resolved (`wasm: false` leaves them to the bundler).
- Vite: path-like import-map entries (`"@styles/": "./src/styles/"`) become `resolve.alias` entries, so CSS `@import` and Sass `@use` see them; worker bundles (`?worker`) resolve Deno specifiers; marker module ids are relative to the root, so no machine path reaches the output.
- Source maps of remote and JSR modules name readable sources on every bundler: the URL on esbuild, the file next to the mirror file (`node_modules/.unplugin-deno/…/https/jsr.io/…/join.ts`) on Rollup, Rolldown and Vite, instead of mangled paths.
- A warning when `nodeModulesDir: "auto"` meets a `node_modules` another package manager installed, and a clearer hint for `npm:` packages missing from `package.json` with `nodeModulesDir: "manual"`.
