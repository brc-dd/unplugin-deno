# `engine/`

Planned for M1: the `Engine` interface and the `loader` engine over the vendored `@deno/loader`
([docs/architecture.md §4](../../../../docs/architecture.md#4-engine-srcengine)); the `deno` CLI
engine follows in M2. The vendored module is imported only through
[`../vendored-deno-loader.ts`](../vendored-deno-loader.ts), which must stay at depth 1 in `src/`
so its `../vendor/…` import is valid both in the sources and in `dist/`. It never imports
`core/` or `hosts/`.
