# `engine/`

Deno's resolution and loading behind one interface
([docs/architecture.md §4](../../../../docs/architecture.md#4-engine-srcengine)). It never imports
`core/`, `config/` or `hosts/`; the project arrives as an `EngineProject`.

- `types.ts`: `Engine`, `EngineFactory`, `EngineCreateOptions`, `ResolvedModule`, `LoadedModule`,
  `MediaType`, …
- `create.ts`: `createEngine(kind, options)`; `deno-cli/engine.ts` is the M2 stub
  (`ENGINE_UNAVAILABLE`).
- `loader/engine.ts`: the `loader` engine over the vendored `@deno/loader`, reached only through
  [`../vendored-deno-loader.ts`](../vendored-deno-loader.ts) (which must stay at depth 1 in `src/`).
  `loader/errors.ts` maps loader errors to `DenoPluginError` codes; `loader/hooks.ts` routes the
  loader's process-global log and fetch hooks to the live engines (and enforces `cachedOnly`).
- `media-type.ts`, `deno-dir.ts`, `npm-package.ts`, `package-specifier.ts`: media types, the
  `DENO_DIR` location, npm package lookup for resolved files, and `jsr:`/`npm:`/bare specifier
  parsing.
- `contract.test.ts`: the contract every engine passes, on the `test/fixtures/engine-*` fixtures.
