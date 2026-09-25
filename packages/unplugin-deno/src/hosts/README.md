# `hosts/`

Planned for M1 (Vite, Rolldown, Rollup, esbuild) and M2 (webpack, Rspack, Rsbuild, Bun): the
per-host adapters described in
[docs/architecture.md §6](../../../../docs/architecture.md#6-host-adapters-srchosts), one
directory per host, plus `shared.ts` with the `HostContext` abstraction. Only behaviour unplugin's
generic hooks cannot express lives here; it is reached through unplugin's escape hatches.
