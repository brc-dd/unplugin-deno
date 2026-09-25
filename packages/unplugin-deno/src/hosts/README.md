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

Vite (M1, next phase) uses the generic hooks for now; esbuild (next phase) and webpack, Rspack,
Rsbuild and Bun (M2) are not implemented yet.
