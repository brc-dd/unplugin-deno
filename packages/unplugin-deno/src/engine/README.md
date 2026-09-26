# `engine/`

Deno's resolution and loading behind one interface
([docs/architecture.md §4](../../../../docs/architecture.md#4-engine-srcengine)). It never imports
`core/`, `config/` or `hosts/`; the project arrives as an `EngineProject`.

- `types.ts`: `Engine`, `EngineFactory`, `EngineCreateOptions` (with `denoBinary` for the `deno`
  engine), `ResolvedModule`, `LoadedModule`, `MediaType`, …
- `create.ts`: `createEngine(kind, options)` over `ENGINE_FACTORIES` (`loader`, `deno`).
- `select.ts`: `selectEngineKind({ engine, project, denoBinary, env })` (async: it may probe
  Deno) and `denoOnlyFeatures(project)`: `auto` picks the `deno` engine only when the project uses
  a feature the vendored loader lacks (`catalog:` in `deno.json` imports or `package.json`
  dependencies, globs in `links`, `jsrDepsInNodeModules`) and Deno 2.8.3+ is installed; otherwise
  the loader, with a warning when Deno was needed.
- `errors.ts`: `EngineResolveError`, a `DenoPluginError` that says whether a missing module is an
  optional dependency of the importing npm package.
- `loader/engine.ts`: the `loader` engine over the vendored `@deno/loader`, reached only through
  [`../vendored-deno-loader.ts`](../vendored-deno-loader.ts) (which must stay at depth 1 in `src/`).
  It installs or downloads npm packages as they are resolved (§4.4). `loader/errors.ts` maps
  loader errors to `DenoPluginError` codes (its hints and classifiers are shared with the `deno`
  engine); `loader/hooks.ts` routes the loader's process-global log and fetch hooks to the live
  engines (and enforces `cachedOnly`).
- `deno-cli/`: the `deno` engine over the installed Deno CLI (2.8.3+, §4.3):
  - `engine.ts`: `denoCliEngineFactory`. `deno info --json` over a synthetic root module that
    imports the entrypoints (or the specifiers waiting for an answer, batched for 5 ms, one run at
    a time); the union of the outputs is the graph (`graph.ts`). Resolution follows the importer's
    recorded dependency and `redirects`; npm subpaths and imports inside npm packages use
    `node-resolver.ts`. Remote modules are read from `DENO_DIR` and transpiled by `transpile.ts`.
    `cachedOnly` points Deno's proxy at a closed port; Deno gets a private copy of `deno.lock`.
  - `node-resolver.ts`: Node.js resolution in bundle mode, ported from `node_resolver` 0.80.0
    (the loader's), with the engine's platform and conditions; its tests compare it with the
    loader on many package shapes.
  - `transpile.ts`: batched `deno transpile --source-map separate` (the loader's emit, same maps).
  - `info.ts`: `deno info --json` guards (unknown shapes become `ENGINE_UNAVAILABLE`), stderr
    progress lines, and `DENO_DIR` cache files (the `// denoCacheMetadata=` line removed).
  - `process.ts`: spawning with timeouts and cancellation, the version gate (`probeDeno`, once per
    binary and process) and Deno's cache directories.
- `media-type.ts`, `deno-dir.ts`, `npm-package.ts`, `package-specifier.ts`: media types, the
  `DENO_DIR` location, npm package lookup for resolved files, and `jsr:`/`npm:`/bare specifier
  parsing.
- `contract.test.ts`: the contract every engine passes, on the `test/fixtures/engine-*` fixtures
  (the `deno` engine's run is skipped when `deno` is missing or older than 2.8.3; `engine-cli-*`
  fixtures cover what only the `deno` engine supports, in `deno-cli/engine.test.ts`).

Measured on macOS arm64 with Deno 2.9.7, tests running under Node 26 (warm numbers are similar
under Deno and Bun; cold ones depend on the network), `engine-basic` (77 modules):

|                                           | `loader`       | `deno`                                                           |
| ----------------------------------------- | -------------- | ---------------------------------------------------------------- |
| `addEntrypoints`, empty `DENO_DIR`        | 2.2 s          | 1.7 s                                                            |
| `addEntrypoints`, warm                    | 23–31 ms       | 46–59 ms                                                         |
| `resolve` of a graph member (`jsr:`, npm) | 5 µs, 26–30 µs | 4 µs, 5–6 µs (memoised)                                          |
| `resolve` not in the graph                | 0.2–0.9 ms     | 35–80 ms (one `deno info`)                                       |
| `load` of a JSR module                    | 1–3 ms each    | first 180–260 ms (transpiles its 73-module closure), then 0.3 ms |
| engine creation                           | 2–30 ms        | 17–40 ms (version probe, cache dirs), then < 1 ms                |
