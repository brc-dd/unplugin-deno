# Contributing and project conventions

This document is for contributors and for coding agents working in this repository. Users should read the
[README](../README.md) instead. Design rationale lives in [architecture.md](architecture.md); the feature plan and
milestones in [plan.md](plan.md); prior-art research in [research/](research/README.md).

## Repository layout

```
unplugin-deno/
├─ package.json              # private workspace root: scripts, dev tooling
├─ pnpm-workspace.yaml
├─ packages/unplugin-deno/   # the published package (npm `unplugin-deno`, JSR `@brc-dd/unplugin-deno`)
│  ├─ src/
│  │  ├─ index.ts            # createUnplugin factory + public types
│  │  ├─ vite.ts rolldown.ts rollup.ts esbuild.ts webpack.ts rspack.ts rsbuild.ts bun.ts farm.ts  # host entries
│  │  ├─ core/               # bundler-agnostic plugin: ownership rules, ids, hooks, platform model, externals
│  │  ├─ config/             # deno.json(c) discovery, workspaces, import maps, lockfile, nodeModulesDir
│  │  ├─ engine/             # Engine interface + `loader` (vendored @deno/loader) + `deno` (CLI) engines
│  │  ├─ hosts/<host>/       # per-host adapters and companion plugins (only what unplugin cannot express)
│  │  ├─ diagnostics/        # error classes, logger, warnings
│  │  └─ utils/              # path/URL helpers (Windows-safe), specifier parsing, small shared helpers
│  ├─ vendor/deno-loader/    # vendored @deno/loader wasm + glue + LICENSE + VERSION (see scripts/vendor-loader.ts)
│  ├─ test/
│  │  ├─ fixtures/<name>/    # self-contained sample projects (each has deno.json; see "Fixtures")
│  │  ├─ integration/        # one file per host: builds fixtures with the real bundler and asserts output
│  │  └─ helpers/            # shared test utilities (temp dirs, run bundler, normalize output)
│  └─ scripts/               # vendoring, fixture install, bench helpers
├─ examples/                 # runnable end-user examples, one directory per scenario
├─ bench/                    # benchmarks against plain npm baselines
└─ docs/                     # this file, architecture, research
```

Unit tests are colocated with the code they test (`src/**/*.test.ts`). Integration tests live in `test/integration/`.

## Toolchain

- Package manager: **pnpm** (workspace). Runtimes tested: **Node ≥ 22.12**, **Deno ≥ 2.7** (2.8+ recommended), **Bun ≥ 1.3**.
- Build: **tsdown** (Rolldown-based). ESM only. Type declarations emitted by tsdown.
- Tests: **Vitest**. `pnpm test` runs under Node; `pnpm test:deno` and `pnpm test:bun` run the same suite under
  the other runtimes (CI runs all three on Linux, macOS and Windows).
- Lint/format: **oxlint** + **oxfmt** (Prettier-compatible style: 2 spaces, single quotes, no semicolons,
  trailing commas, 100 columns). Run `pnpm lint` and `pnpm fmt` before committing.
- Versioning: **changesets**; every user-visible change adds a changeset file.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`), imperative, ≤ 72 chars.

## Code conventions

- TypeScript `strict`, no `any` (use `unknown` + narrowing). Public API has JSDoc. Named exports everywhere;
  default exports only in host entry files (`src/vite.ts` etc.), matching unplugin conventions.
- Imports: `node:` prefix for builtins; relative imports include the `.js` extension (ESM output, runs unchanged
  under Deno); no barrel files except `src/index.ts`.
- Paths vs URLs: keep **file URLs** (`URL` objects or `file:///…` strings) inside the resolver layers and convert to
  OS paths only at the host boundary via `utils/path.ts` (`toPath`, `toFileUrl`). Never string-concatenate paths;
  never assume `/` separators; normalise Windows drive-letter case in one place. Every path helper has a Windows
  test case.
- Ids: build and parse ids only through `core/id.ts` (`splitQuery`, `isOwnedSpecifier`, `withDenoType`,
  `readDenoType`, `isMirrorPath`). No ad-hoc string checks for `\0`, `virtual:`, `?raw` etc. outside that module.
- Errors: throw `DenoPluginError` (`diagnostics/errors.ts`) with a stable `code`, a human message, and an optional
  `hint`. Wrap engine errors (`ResolveError` from the loader) there; never branch on error message text.
- Logging: use the injected `Logger` (`diagnostics/logger.ts`). No `console.*` in library code. `debug` messages
  are free-form but prefixed with the subsystem (`[config]`, `[engine]`, `[vite]`).
- Options: one `resolveOptions(userOptions, hostContext)` in `core/options.ts` applies all defaults and validation.
  Hooks read only the resolved options object.
- Async: resolver hooks may be sync or async; prefer sync (`resolveSync`) on the hot path, async for cache misses.
  Never block with `spawnSync` in hooks.
- No host-specific code in `core/`. Anything that needs a Vite/esbuild/webpack API goes under `hosts/<host>/` and
  is reached through unplugin's escape hatches. `core/` may expose small capability flags the hosts set.
- Keep the dependency footprint minimal: `unplugin`, the vendored loader, and tiny well-known utilities only.

## Fixtures

Each fixture in `packages/unplugin-deno/test/fixtures/<name>/` is a complete, minimal project:

- `deno.json` (or `deno.jsonc`), optional `deno.lock`, optional `package.json`, sources under `src/`.
- A `fixture.json` describing what it exercises (`title`, `entries`, `expect` hints) so integration tests can
  iterate fixtures generically and so a reader knows the purpose without reading the code.
- Names describe the scenario, not the bug: `import-map-scopes`, `workspace-globs`, `npm-subpath-cjs`,
  `attributes-text-bytes`, `remote-https-lock`, `platform-deno-externals`, `virtual-ids-coexist`, …
- Remote fixtures pin exact versions and ship a `deno.lock` so tests are deterministic and work offline after the
  first run (CI caches `DENO_DIR`).
- Fixtures that reproduce an upstream issue mention it in `fixture.json` (`"issues": ["denoland/deno-vite-plugin#98"]`).

Borrowed material: when a fixture or test case is adapted from another project (for example the WICG import-map
reference tests or a Deno test case), keep its license terms, add a `SOURCE` note in that fixture's `fixture.json`
or file header, and add the project to the **Credits** section of the README. Adapt it to the conventions above; do
not paste foreign layouts wholesale.

## Testing expectations

- Every resolver rule and every host adapter behaviour has a test. Bug fixes add a regression test named after
  the upstream issue when one exists.
- Integration tests build each relevant fixture with the **real** bundler (Vite, Rolldown, Rollup, esbuild, …) and
  assert on the produced output (exports evaluated where possible, snapshot of the import graph otherwise), not on
  internal calls.
- Tests must pass under Node, Deno and Bun, on Windows too. Use `test/helpers` for temp directories and for
  normalising paths/newlines in snapshots.
- Keep tests hermetic: fixtures pin versions; network access only for the pinned remote fixtures; `DENO_DIR` is
  pointed at a per-run cache directory in CI.

## Documentation

- `README.md`: short and user-facing (install, one config example per host, options table, limitations, credits).
  No architecture or internals.
- `docs/architecture.md`: how it works and why (for contributors and agents). Update it in the same PR as a
  behavioural change.
- `docs/research/`: historical; do not edit, add new findings as new files.

## Working as a coding agent here

1. Read `docs/plan.md`, `docs/architecture.md`, this file, and the existing code in the area you touch before writing.
2. Stay within the area you were assigned; do not reformat or restructure unrelated files.
3. Prefer extending existing helpers over adding parallel ones; if a helper is missing in `utils/` or `core/id.ts`,
   add it there once.
4. Run `pnpm lint`, `pnpm typecheck`, and the relevant tests before declaring a task done; report failures verbatim.
5. Do not commit; the orchestrating session commits between phases.
