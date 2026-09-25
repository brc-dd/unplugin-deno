# `core/`

The bundler-agnostic plugin. M0 contains the factory skeleton (`plugin.ts`) and the options
(`options.ts`). M1 adds, per [docs/architecture.md §5](../../../../docs/architecture.md#5-core-plugin-srccore):
`specifier.ts` and `id.ts` (specifier classification and the id scheme), `resolve.ts` (the
`resolveId` algorithm, §5.2), `mirror.ts` (remote modules as files, §5.3), `npm.ts` (npm redirect
strategy, §5.4), `attributes.ts` (import-attribute markers, §5.5), `platform.ts` (platform model
and externals, §5.6), `entries.ts` (entrypoint discovery) and `watch.ts` (invalidation, §5.7).
No module here imports a host package.
