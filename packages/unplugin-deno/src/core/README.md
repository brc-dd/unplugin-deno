# `core/`

The bundler-agnostic plugin
([docs/architecture.md §5](../../../../docs/architecture.md#5-core-plugin-srccore)). No module here
imports a host package.

- `plugin.ts`: the unplugin factory. The Rollup family (Rollup, Rolldown, Vite) gets the generic
  hooks, with the Rolldown and Rollup specifics from `hosts/` under unplugin's escape hatches;
  esbuild gets only `esbuild.setup`; other hosts are inert until their adapters land.
- `state.ts`: `PluginState`, the per-instance build state (options re-resolved against the host
  root, project, platform, engines, mirror, resolver) and the hook implementations
  (`resolve`, `load`, `transform`, `watchChange`, `close`).
- `options.ts`: `Options`, `resolveOptions` (every default in one place).
- `specifier.ts`, `id.ts`: specifier classification and the id scheme (queries, the
  `?deno-type=` marker, virtual ids, mirror paths, host filters).
- `resolve.ts`: the `resolveId` algorithm (§5.2) returning a `ResolveOutcome`, and the filters.
- `mirror.ts`: remote and `data:` modules as files (§5.3): layout, rewriting, source maps,
  manifest, integrity, garbage collection.
- `npm.ts`: the npm strategy (§5.4): redirects to the host, global-cache paths.
- `attributes.ts`: import-attribute markers (§5.5): the transform pre-pass and marker modules.
- `platform.ts`: platform model, conditions, externals policy and pinning (§5.6).
- `entries.ts`: host inputs → engine entrypoints. `watch.ts`: invalidation (§5.7).
- `version.ts`: the plugin version (part of the mirror generation).
