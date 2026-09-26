# `core/`

The bundler-agnostic plugin
([docs/architecture.md §5](../../../../docs/architecture.md#5-core-plugin-srccore)). No module here
imports a host package.

- `plugin.ts`: the unplugin factory. The Rollup family (Rollup, Rolldown, Vite) gets the generic
  hooks, with the Rolldown, Rollup and Vite specifics from `hosts/` under unplugin's escape hatches
  (Vite also gets a second instance for `worker.plugins`); esbuild gets only `esbuild.setup`;
  webpack, Rspack and Rsbuild get their adapters; other hosts are inert.
- `state.ts`: `PluginState`, the per-instance build state (options re-resolved against the host
  root, project, platform, engines, mirror, resolver; a resolver and mirror per resolve target
  for hosts that build several platforms at once) and the hook implementations (`resolve`,
  `load`, `transform`, `watchChange`, `close`), plus the warnings shown once, the npm packages
  recorded for the duplicate check and the JSX decision for the hosts.
- `options.ts`: `Options`, `resolveOptions` (every default in one place; options of later
  features are validated but have no effect yet).
- `specifier.ts`, `id.ts`: specifier classification and the id scheme (queries, the
  `?deno-type=` marker, virtual ids, mirror paths, host filters).
- `resolve.ts`: the `resolveId` algorithm (§5.2) returning a `ResolveOutcome`, and the filters;
  it reports `node:` builtins of browser bundles, keeps native addons (`.node`) external and
  records the npm packages it bundles.
- `mirror.ts`: remote and `data:` modules as files (§5.3): layout, rewriting, source maps,
  manifest, integrity, garbage collection. A mirror file's map names its source as
  `sourceRoot` + `sources` = the URL (esbuild reads it so); Rollup-family hosts get
  `sources: ['<file name>']` from `load`, which they resolve next to the mirror file
  (`…/https/jsr.io/…/join.ts`) instead of mangling a URL into a path.
- `npm.ts`: the npm strategy (§5.4): redirects to the host, global-cache paths.
- `attributes.ts`: import-attribute markers (§5.5): the transform pre-pass and marker modules.
- `platform.ts`: platform model, conditions, externals policy and pinning (§5.6).
- `source.ts`: the source transforms and checks of the `transform` hook (§5.10):
  `import.meta.main` → `false` outside entries, environment-variable reads found for inlining,
  `Deno.*` references; one scan with the host's parser (oxc in Rolldown and Vite 8) or the
  token scanner of `utils/js-tokens.ts`.
- `env.ts`: the variables `env` inlines (prefixes, names) and their values (`process.env` over
  the `.env` files).
- `jsx.ts`: the `deno.json` JSX settings as a host-neutral transform (§5.11); the adapters map
  it to their hosts' options.
- `checks.ts`: diagnostics messages (browser safety, `Deno.*` globals, native addons, a
  `node_modules` of another package manager) and the npm versions per platform (X4).
- `wasm.ts`: `.wasm` module imports as synthesised instantiating modules (§5.12).
- `entries.ts`: host inputs → engine entrypoints. `watch.ts`: invalidation (§5.7).
- `version.ts`: the plugin version (part of the mirror generation).
