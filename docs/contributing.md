# Contributing and project conventions

This document is for contributors and for coding agents working in this repository. Users should read the
[README](../README.md) instead. Design rationale lives in [architecture.md](architecture.md); the feature plan and
milestones in [plan.md](plan.md); prior-art research in [research/](research/README.md).

## Repository layout

```
unplugin-deno/
├─ package.json              # private workspace root: scripts, dev tooling
├─ pnpm-workspace.yaml       # workspace packages and all pnpm settings
├─ AGENTS.md                 # entry point for coding agents (CLAUDE.md imports it)
├─ .changeset/               # pending changesets (see "Release")
├─ .github/workflows/ci.yml  # lint, test matrix (3 OS × Node 22/26, Deno, Bun), build and package checks
├─ packages/unplugin-deno/   # the published package (npm `unplugin-deno`, JSR `@brc-dd/unplugin-deno`)
│  ├─ src/
│  │  ├─ index.ts            # createUnplugin factory + public types
│  │  ├─ vite.ts rolldown.ts rollup.ts esbuild.ts webpack.ts rspack.ts rsbuild.ts bun.ts farm.ts  # host entries
│  │  ├─ core/               # bundler-agnostic plugin: ownership rules, ids, hooks, platform model, externals
│  │  ├─ config/             # deno.json(c) discovery, workspaces, import maps, lockfile, nodeModulesDir
│  │  ├─ engine/             # Engine interface + `loader` (vendored @deno/loader) + `deno` (CLI) engines
│  │  ├─ hosts/<host>/       # per-host adapters and companion plugins (only what unplugin cannot express)
│  │  ├─ diagnostics/        # error classes, logger, warnings
│  │  ├─ utils/              # path/URL helpers (Windows-safe), specifier parsing, small shared helpers
│  │  ├─ vendored-deno-loader.ts  # the only importer of vendor/deno-loader; must stay directly in src/
│  │  └─ register.ts api.ts  # `unplugin-deno/register` and `unplugin-deno/api` (placeholders until M3)
│  ├─ vendor/deno-loader/    # generated: patched @deno/loader wasm + glue, hooks.js, LICENSE, VERSION, NOTICE.md
│  ├─ test/
│  │  ├─ fixtures/<name>/    # self-contained sample projects (each has deno.json; see "Fixtures")
│  │  ├─ integration/        # one file per host: builds fixtures with the real bundler and asserts output
│  │  └─ helpers/            # shared test utilities (temp dirs, run bundler, normalize output) + their tests
│  ├─ scripts/               # vendor-loader.ts (+ deno-loader-overlay/), fixture install, bench helpers
│  ├─ deno.json              # JSR manifest (see "Release")
│  └─ tsdown.config.ts vitest.config.ts tsconfig.json
├─ examples/                 # runnable end-user examples, one directory per scenario
├─ bench/                    # benchmarks against plain npm baselines
└─ docs/                     # this file, architecture, research
```

Unit tests are colocated with the code they test (`src/**/*.test.ts`). Integration tests live in `test/integration/`;
the helpers' own tests in `test/helpers/*.test.ts`.

## Toolchain

- Package manager: **pnpm 12** (workspace; `packageManager` in the root `package.json`). pnpm ≥ 11 reads project
  settings only from `pnpm-workspace.yaml`; `.npmrc` is for registries and auth. Optional peers are not installed
  automatically (`autoInstallPeers: false`): a test that needs webpack, Rspack, Rsbuild or Farm adds it as a
  devDependency.
- Runtimes tested: **Node ≥ 22.12**, **Deno ≥ 2.7** (2.8+ recommended), **Bun ≥ 1.3**. Building (tsdown) and
  running `scripts/*.ts` (native type stripping) need Node ≥ 22.18.
- Build: **tsdown** (Rolldown-based), `pnpm build`. ESM only, flat `dist/*.js` + `dist/*.d.ts`
  (`fixedExtension: false`); entry files start with a `@ts-self-types` comment for JSR. Type declarations are
  emitted by tsdown with **TypeScript 6** (its declaration output does not support TypeScript 7 yet);
  `pnpm typecheck` runs `tsc --noEmit`.
- Tests: **Vitest**. `pnpm test` runs under Node; `pnpm test:deno` (`deno run -A npm:vitest run`) and `pnpm test:bun`
  (`bun --bun x vitest run`; without `--bun`, `bunx` honours vitest's Node shebang) run the same suite under the
  other runtimes (CI runs all three on Linux, macOS and Windows).
- Lint/format: **oxlint** (`.oxlintrc.json`: correctness and suspicious categories plus the conventions below as
  rules) + **oxfmt** (`.oxfmtrc.json`; Prettier-compatible style: 2 spaces, single quotes, no semicolons,
  trailing commas, 100 columns; it also formats JSON, YAML and Markdown and sorts `package.json` keys). `docs/` is
  excluded from formatting (hand-formatted), as are `vendor/`, `dist/` and lockfiles. Run `pnpm lint` and
  `pnpm fmt` before committing.
- Versioning: **changesets**; every user-visible change adds a changeset file.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`), imperative, ≤ 72 chars.

## Code conventions

- TypeScript `strict`, no `any` (use `unknown` + narrowing). Public API has JSDoc. Named exports everywhere;
  default exports only in host entry files (`src/vite.ts` etc.), matching unplugin conventions. Host entries
  annotate their export as `UnpluginInstance<Options | undefined>['<host>']` so declarations name unplugin's types.
- Imports: `node:` prefix for builtins; relative imports include the `.js` extension (ESM output, runs unchanged
  under Deno); no barrel files except `src/index.ts`.
- The vendored loader is reached only through `src/vendored-deno-loader.ts`, which must stay **directly in `src/`**
  (depth 1): tsdown keeps `../vendor/…` imports external and emits flat `dist/*.js`, so the same relative specifier
  is valid in the sources and in the published output. Other modules (e.g. `engine/loader/`) import that file,
  never `vendor/` directly.
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
- A `fixture.json` describing what it exercises (`title`, `entries`, `hosts`, optional `expect`, `issues`, `source`;
  the type and validation are in `test/helpers/fixture.ts`) so integration tests can iterate fixtures generically
  and so a reader knows the purpose without reading the code. `smoke-jsr-npm` is the reference example.
- Names describe the scenario, not the bug: `import-map-scopes`, `workspace-globs`, `npm-subpath-cjs`,
  `attributes-text-bytes`, `remote-https-lock`, `platform-deno-externals`, `virtual-ids-coexist`, …
- Remote fixtures pin exact versions and ship a `deno.lock` so tests are deterministic and work offline after the
  first run (CI caches `DENO_DIR`). Generate the lock with `deno install` in a copy of the fixture **outside the
  repository** (Deno would otherwise pick up the ancestor `package.json` and `deno.json`), with a scratch `DENO_DIR`.
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
- Tests must pass under Node, Deno and Bun, on Windows too. Use `test/helpers`: `tempProject(name)` (a copy of a
  fixture in the OS temp directory, outside the repository), `normalize(text)` (placeholders for known paths such as
  `<deno-dir>`, `<hash>` for hashes, LF newlines; also applied to snapshots by the serializer registered in
  `test/helpers/setup.ts`) and `runtime`. Path helpers take an explicit `posix`/`win32` flavour so Windows cases
  run on every OS.
- Keep tests hermetic: fixtures pin versions; network access only for the pinned remote fixtures. The engine reads
  `DENO_DIR` from the environment, so tests set it with `vi.stubEnv('DENO_DIR', await denoDir())`: `denoDir()` is
  `$UNPLUGIN_DENO_TEST_DENO_DIR` (CI points it at a cached directory) or `<os temp>/unplugin-deno-test/deno-dir`,
  shared by local runs so downloads happen once; `freshDenoDir()` gives an empty one. Tests that need no network
  inject a fetch (`setLoaderFetch`) instead.

## Documentation

- `README.md`: short and user-facing (install, one config example per host, options table, limitations, credits).
  No architecture or internals.
- `docs/architecture.md`: how it works and why (for contributors and agents). Update it in the same PR as a
  behavioural change.
- `docs/research/`: historical; do not edit, add new findings as new files.

## Release

Not set up yet: `pnpm release` fails on purpose until the release workflow lands (M1). What exists:

- Versioning: **changesets** (`pnpm changeset`; `.changeset/config.json`, public access, oxfmt formatting).
- npm: `packages/unplugin-deno` publishes `dist/` and `vendor/` (plus `package.json`, `README.md`, `LICENSE`).
  Its `README.md` and `LICENSE` are copies of the root files (npm and JSR publish from the package directory); keep
  them identical. Check with `pnpm -F unplugin-deno publint` and `pnpm -F unplugin-deno attw`
  (`attw --pack --profile esm-only`: `require()` and `node10` resolution are unsupported by design).
- JSR: `packages/unplugin-deno/deno.json` (`@brc-dd/unplugin-deno`) maps the same subpaths to `dist/*.js` (build
  first) and maps the bare npm dependencies to `npm:` specifiers in `imports`. Its `version` must be kept in sync
  with `package.json` (changesets only bumps the latter). `lock: false` keeps Deno from writing a `deno.lock` when
  the tests run under Deno in that directory. `pnpm jsr:dry-run` runs `deno publish --dry-run --allow-dirty`.
- Vendored loader: `node scripts/vendor-loader.ts [version]` in `packages/unplugin-deno` downloads
  `@jsr/deno__loader` from npm.jsr.io, verifies its integrity, copies the Node.js code path, applies patches that
  each assert how often their pattern occurs (so upstream drift fails the script), adds `hooks.js` from
  `scripts/deno-loader-overlay/` and writes `NOTICE.md`. Output is reproducible: re-running for the same version
  changes nothing, so `git diff` shows exactly what a new version changes.

Known issues to resolve before the first JSR publish:

- `pnpm jsr:dry-run` fails type checking with `TS2307: Cannot find module '…/dist/options-<hash>.js'`. Declarations
  shared by several entries go into a declaration-only chunk (`options-<hash>.d.ts`) that the entry `.d.ts` files
  import as `./options-<hash>.js`; TypeScript resolves that to the `.d.ts`, Deno's checker does not. Verified: with
  a stub `options-<hash>.js` containing `/* @ts-self-types="./options-<hash>.d.ts" */` the dry run passes with no
  warnings, and without the entries' `@ts-self-types` banners it passes but warns `unsupported-javascript-entrypoint`
  for all 12 entries (JSR users would get no types). Candidate fixes: emit such stubs from a tsdown hook, emit
  self-contained declarations per entry, or publish the TypeScript sources to JSR. CI runs the dry run with
  `continue-on-error`.
- Under Deno, a JSR package is loaded from `https://jsr.io/…`, but the vendored glue locates its wasm with
  `fileURLToPath(import.meta.url)` and `readFileSync` (the Node.js path, forced on every runtime). Before publishing
  to JSR, the loader must fall back to a non-`file:` strategy (fetching the wasm, or Deno's Wasm module import).

## Working as a coding agent here

1. Read `docs/plan.md`, `docs/architecture.md`, this file, and the existing code in the area you touch before writing.
2. Stay within the area you were assigned; do not reformat or restructure unrelated files.
3. Prefer extending existing helpers over adding parallel ones; if a helper is missing in `utils/` or `core/id.ts`,
   add it there once.
4. Run `pnpm lint`, `pnpm typecheck`, and the relevant tests before declaring a task done; report failures verbatim.
5. Do not commit; the orchestrating session commits between phases.
