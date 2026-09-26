# `core/`

The bundler-agnostic plugin
([docs/architecture.md §5](../../../../docs/architecture.md#5-core-plugin-srccore)). No module here
imports a host package.

- `plugin.ts`: the unplugin factory. The Rollup family (Rollup, Rolldown, Vite) gets the generic
  hooks (`writeBundle` writes the sidecar of `sidecar.ts`), with the Rolldown, Rollup and Vite
  specifics from `hosts/` under unplugin's escape hatches (Vite also gets a second instance for
  `worker.plugins`); esbuild gets only `esbuild.setup`; webpack, Rspack and Rsbuild get their
  adapters; other hosts are inert.
- `state.ts`: `PluginState`, the per-instance build state (options re-resolved against the host
  root, project, platform, engines, mirror, resolver; a resolver and mirror per resolve target
  for hosts that build several platforms at once) and the hook implementations (`resolve`,
  `load`, `transform`, `watchChange`, `close`), plus the warnings shown once, the npm packages
  recorded for the duplicate check, the externals recorded for the sidecar, the allow-list,
  lockfile policy and `jsr:` route of the loaded project, and the JSX decision for the hosts.
- `options.ts`: `Options`, `resolveOptions` (every default in one place, validation), Deno's
  `--allow-import` defaults (`DEFAULT_ALLOW_IMPORT`).
- `specifier.ts`, `id.ts`: specifier classification and the id scheme (queries, the
  `?deno-type=` marker, virtual ids, mirror paths, host filters).
- `resolve.ts`: the `resolveId` algorithm (§5.2) returning a `ResolveOutcome`, and the filters;
  it reports `node:` builtins of browser bundles, keeps native addons (`.node`) external,
  records the npm packages it bundles and the externals it keeps, refuses remote URLs outside
  the allow-list before anything is downloaded, compares engine resolutions with `deno.lock`,
  takes `jsr:` through `node_modules/@jsr` on that route, and names the command that fills
  Deno's cache in `CACHED_ONLY_MISS` hints.
- `mirror.ts`: remote and `data:` modules as files (§5.3): layout, rewriting, source maps,
  manifest, integrity, garbage collection. A mirror file's map names its source as
  `sourceRoot` + `sources` = the URL (esbuild reads it so); Rollup-family hosts get
  `sources: ['<file name>']` from `load`, which they resolve next to the mirror file
  (`…/https/jsr.io/…/join.ts`) instead of mangling a URL into a path. The imports of mirrored
  modules (and redirects) are checked against the allow-list and the lockfile, also when a file
  of the generation is reused; `jsr:` imports are kept for `resolveId` on the `@jsr` route.
- `allow-import.ts`: the remote-import allow-list (R15): Deno's `--allow-import` syntax and
  matching (ports, `*.domain`, `*`), plus the hosts of `deno.lock`, of the import maps and of
  the JSR registries; `DISALLOWED_HOST`.
- `lockfile-policy.ts`: `lockfile: 'auto' | 'frozen' | 'off'` (R5, X5): the mode (`CI` and
  `lock.frozen` freeze `auto`), drift of `npm:`/`jsr:`/remote resolutions
  (`LOCKFILE_FROZEN_DRIFT`, or debug output), `NOT_IN_LOCKFILE` for offline misses, and the
  versions the minimum dependency age held back.
- `registry-cache.ts`: read-only npm packuments and JSR metadata from Deno's cache (publish
  times, integrity), for the explanations and the sidecar.
- `jsr-npm.ts`: the `jsrDepsInNodeModules` route (R11): when it applies, and
  `jsr:@scope/name@range/sub` → `npm:@jsr/scope__name@range/sub`.
- `sidecar.ts`: the sidecar `deno.json` and `deno.lock` of Deno platform output (S3):
  externals recorded per platform, the lockfile closure copied from the project's `deno.lock`
  (or read from Deno's cache with the engine's resolutions), `writeSidecar(state, dir)` for the
  hosts.
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
  `node_modules` of another package manager, `cachedOnly` hints) and the npm versions per
  platform (X4).
- `wasm.ts`: `.wasm` module imports as synthesised instantiating modules (§5.12).
- `entries.ts`: host inputs → engine entrypoints. `watch.ts`: invalidation (§5.7).
- `version.ts`: the plugin version (part of the mirror generation).
