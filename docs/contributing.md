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
├─ README.md                 # user-facing README (copied to packages/unplugin-deno/README.md, see "Release")
├─ .changeset/               # pending changesets (see "Release")
├─ .github/workflows/ci.yml  # lint, test matrix (3 OS × Node 22/26, Deno, Bun), build and package checks, examples
├─ packages/unplugin-deno/   # the published package (npm `unplugin-deno`, JSR `@brc-dd/unplugin-deno`)
│  ├─ src/
│  │  ├─ index.ts            # the unplugin instance + public types and errors
│  │  ├─ vite.ts rolldown.ts rollup.ts esbuild.ts webpack.ts rspack.ts rsbuild.ts bun.ts farm.ts  # host entries
│  │  ├─ core/               # bundler-agnostic plugin: state, options, ids, resolveId, mirror, externals, sidecar,
│  │  │                      # attributes, source transforms, JSX, Wasm, checks, lockfile policy
│  │  ├─ config/             # deno.json(c) discovery, workspaces, import maps, lockfile, nodeModulesDir
│  │  ├─ engine/             # Engine interface, engine selection, `loader` (vendored @deno/loader), `deno` (Deno CLI)
│  │  ├─ hosts/<host>/       # per-host adapters (only what unplugin cannot express); shared.ts
│  │  ├─ diagnostics/        # DenoPluginError and error codes, logger
│  │  ├─ utils/              # path/URL helpers (Windows-safe), fs, hashing, the import lexer, a JS tokenizer
│  │  ├─ vendored-deno-loader.ts  # the only importer of vendor/deno-loader; must stay directly in src/
│  │  └─ register.ts api.ts  # `unplugin-deno/register` and `unplugin-deno/api` (placeholders that throw until M3)
│  ├─ vendor/deno-loader/    # generated: patched @deno/loader wasm + glue, hooks.js, LICENSE, VERSION, NOTICE.md
│  ├─ test/
│  │  ├─ fixtures/<name>/    # self-contained sample projects (each has deno.json; see "Fixtures")
│  │  ├─ data/               # import-map test data from other projects, each with a SOURCE.md
│  │  ├─ integration/        # builds fixtures with the real bundlers and asserts on the output
│  │  └─ helpers/            # shared test utilities (temp dirs, builders, normalize output) + their tests
│  ├─ scripts/               # vendor-loader.ts and deno-loader-overlay/ (generate vendor/deno-loader)
│  ├─ deno.json              # JSR manifest (see "Release")
│  └─ tsdown.config.ts vitest.config.ts tsconfig.json
├─ examples/                 # runnable end-user examples, one directory per scenario
├─ bench/                    # benchmarks against plain npm baselines
└─ docs/                     # this file, architecture, plan, research
```

`src/config/`, `src/core/`, `src/engine/` and `src/hosts/` each have a `README.md` with a short module map; keep
them in step with the code. Unit tests are colocated with the code they test (`src/**/*.test.ts`); integration tests
live in `test/integration/`, the helpers' own tests in `test/helpers/*.test.ts`.

## Toolchain

- Package manager: **pnpm 12** (workspace; `packageManager` in the root `package.json`). pnpm ≥ 11 reads project
  settings only from `pnpm-workspace.yaml`; `.npmrc` is for registries and auth. Optional peers are not installed
  automatically (`autoInstallPeers: false`): a test that needs webpack, Rspack, Rsbuild or Farm adds it as a
  devDependency.
- Runtimes supported: **Node ≥ 22.12**, **Deno ≥ 2.7** (2.8+ recommended), **Bun ≥ 1.3**; CI tests Node 22 and 26,
  the latest Deno 2 and the latest Bun. The `deno` engine needs a Deno ≥ 2.8.3 binary. Building (tsdown) and running
  `scripts/*.ts` (native type stripping) need Node ≥ 22.18.
- Build: **tsdown** (Rolldown-based), `pnpm build`. ESM only, flat `dist/*.js` + `dist/*.d.ts`
  (`fixedExtension: false`); entry files start with a `@ts-self-types` comment for JSR. Type declarations are
  emitted by tsdown with **TypeScript 6** (its declaration output does not support TypeScript 7 yet);
  `pnpm typecheck` runs `tsc --noEmit`.
- Tests: **Vitest**. `pnpm test` runs under Node; `pnpm test:deno` (`deno run -A npm:vitest run`) and `pnpm test:bun`
  (`bun --bun x vitest run`; without `--bun`, `bunx` honours vitest's Node shebang) run the same suite under the
  other runtimes (CI runs all three on Linux, macOS and Windows). To run one file:
  `pnpm -F unplugin-deno exec vitest run src/core/plugin.test.ts`.
- Lint/format: **oxlint** (`.oxlintrc.json`: correctness and suspicious categories plus the conventions below as
  rules) + **oxfmt** (`.oxfmtrc.json`; Prettier-compatible style: 2 spaces, single quotes, no semicolons,
  trailing commas, 100 columns; it also formats JSON, YAML and Markdown, including the READMEs and changesets, and
  sorts `package.json` keys). `docs/` is excluded from formatting (hand-formatted, about 120 columns), as are
  `vendor/`, `dist/`, lockfiles and `CHANGELOG.md`. Run `pnpm lint` and `pnpm fmt` before committing.
- Versioning: **changesets**; every user-visible change adds a changeset file.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`), imperative, ≤ 72 chars.

## Code conventions

- TypeScript `strict`, no `any` (use `unknown` + narrowing). Public API has JSDoc. Named exports everywhere;
  default exports only in host entry files (`src/vite.ts` etc.), matching unplugin conventions. Host entries
  annotate their export as `UnpluginInstance<Options | undefined>['<host>']` so declarations name unplugin's types.
- Imports: `node:` prefix for builtins; relative imports include the `.js` extension (ESM output, runs unchanged
  under Deno); no barrel files except `src/index.ts`. Bundler packages are imported with `import type` only.
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
- Options: one `resolveOptions(userOptions, context)` in `core/options.ts` applies all defaults and validation.
  Hooks read only the resolved options object. An option of a later milestone is validated but documented as
  planned until it has an effect.
- Async: resolver hooks may be sync or async; prefer sync (`resolveSync`) on the hot path, async for cache misses.
  Never block with `spawnSync` in hooks.
- No host-specific code in `core/` beyond wiring: anything that needs a Vite/esbuild/webpack API goes under
  `hosts/<host>/` and is reached through unplugin's escape hatches (`core/plugin.ts` composes the adapters).
  `core/` may expose small capability flags the hosts set.
- Keep the dependency footprint minimal: `unplugin`, the vendored loader, and tiny well-known utilities only.
- Source comments cite `docs/architecture.md` by section number (`§5.3`); renumbering sections means updating them.

## Fixtures

Each fixture in `packages/unplugin-deno/test/fixtures/<name>/` is a complete, minimal project:

- `deno.json` (or `deno.jsonc`), optional `deno.lock`, optional `package.json`, sources under `src/`.
- A `fixture.json` describing what it exercises (`title`, `entries`, `hosts`, optional `expect`, `issues`, `source`;
  the type and validation are in `test/helpers/fixture.ts`) so integration tests can iterate fixtures generically
  and so a reader knows the purpose without reading the code. `smoke-jsr-npm` is the reference example. `hosts` lists
  the hosts whose integration tests build the fixture (`[]` for fixtures of other tests); it is documentation, checked
  only against the host names, so update it when a host's tests start or stop using the fixture.
- Names describe the scenario, not the bug, prefixed by the tests that use them: `core-*` (the core suite and every
  host's integration tests), `engine-*` (the engine contract; `engine-cli-*` only the `deno` engine), `esbuild-*`,
  `vite-*` and `webpack-*` (host-specific tests; `webpack-remote-css` and `webpack-watch` run on Rspack too);
  unprefixed fixtures (`import-map-scopes`, `workspace-globs`, `lockfile-v5-sample`, …) serve the config-layer tests.
- Remote fixtures pin exact versions and ship a `deno.lock` so tests are deterministic and work offline after the
  first run (CI caches the test `DENO_DIR`). Generate the lock with `deno install` in a copy of the fixture **outside
  the repository** (Deno would otherwise pick up the ancestor `package.json` and `deno.json`), with a scratch
  `DENO_DIR`.
- Fixtures that reproduce an upstream issue mention it in `fixture.json` (`"issues": ["denoland/deno-vite-plugin#98"]`).
- A fixture may commit stub packages in its own `node_modules/` (`core-import-map-precedence`); `.gitignore` re-includes
  `packages/unplugin-deno/test/fixtures/**/node_modules/`. Never run `deno install` inside the repository copy of a
  fixture: tests work on temporary copies (`tempProject`), and `nodeModulesDir: "auto"` installs there.
- `oxfmt` formats fixture sources too (TypeScript, JSON, CSS), so expected values must match the formatted files.
  Binary data files use the `.bin` extension, which `.gitattributes` marks as binary.

Borrowed material: when test data or a test case is adapted from another project (the web-platform-tests import-map
data, the `denoland/import_map` cases, a Deno test case), keep its license terms, record the source (upstream,
commit, license) in a `SOURCE.md` next to the data (`test/data/<name>/SOURCE.md`) or in the fixture's `source` field
or file header, and add the project to the **Credits** section of the README. Adapt it to the conventions above; do
not paste foreign layouts wholesale.

## How the tests are organised

Unit tests sit next to each module (`src/**/*.test.ts`) and use small inline projects (`tempDir(files)`) or
fixtures. Integration tests build fixtures with the real bundlers: `test/integration/core-suite.ts` holds the tests
of the `core-*` fixtures and runs once per host from `rolldown.test.ts` and `rollup.test.ts` (a fixture a host cannot
build is skipped there with its reason in `SKIPPED`); `esbuild.test.ts`, `vite.test.ts` (builds), `vite-dev.test.ts`
(dev server), `webpack.test.ts`, `rspack.test.ts` and `rsbuild.test.ts` run the same fixtures on their host plus their
own `esbuild-*`/`vite-*`/`webpack-*` fixtures, and the Vite files run everything on Vite 8 and Vite 7. The webpack and
Rspack tests cover production builds and watch mode (`watchBuilds`), webpack's also its persistent cache, and the
Rsbuild tests production builds of one or more environments; no test starts their dev servers.
`src/engine/contract.test.ts` runs the `engine-*` fixtures against both engines (the
`deno` engine's run needs a Deno binary, below), `src/engine/deno-cli/engine.test.ts` the `engine-cli-*` fixtures, and
`src/config/import-map.wpt.test.ts` the data in `test/data/`. The whole suite runs under Node (`pnpm test`), Deno
(`pnpm test:deno`) and Bun (`pnpm test:bun`), and CI runs each on Linux, macOS and Windows.

## Testing expectations

- Every resolver rule and every host adapter behaviour has a test. Bug fixes add a regression test named after
  the upstream issue when one exists.
- Integration tests build each relevant fixture with the **real** bundler (Vite, Rolldown, Rollup, esbuild, …) and
  assert on the produced output (exports evaluated where possible, the import graph otherwise), not on internal
  calls.
- Tests must pass under Node, Deno and Bun, on Windows too. Use `test/helpers`: `tempProject(name)` (a copy of a
  fixture in the OS temp directory, outside the repository), `normalize(text)` (placeholders for known paths such as
  `<deno-dir>`, `<hash>` for hashes, LF newlines; also applied to snapshots by the serializer registered in
  `test/helpers/setup.ts`) and `runtime`. Path helpers take an explicit `posix`/`win32` flavour so Windows cases
  run on every OS. Assert on values that do not depend on the OS (for example `@std/path/posix` rather than
  `@std/path`, whose `join` uses `\` on Windows).
- Builders (all put the plugin first, write ES modules to a temporary directory with the shared test `DENO_DIR`, and
  return the chunks with their code, module ids and sizes, imports, and the host's logs):
  `buildWithRolldown(fixtureDir, entries, pluginOptions, rolldownOptions)` and `buildWithRollup(…)` in
  `test/helpers/build.ts` (for Rollup, followed by the small esbuild TypeScript and JSON plugins of
  `test/helpers/rollup-ts.ts`; the TypeScript plugin preserves JSX for Rollup's `jsx` option);
  `buildWithEsbuild` and `contextWithEsbuild` in `test/helpers/esbuild.ts`; `buildWithVite`, `startViteDevServer` and
  `loadVite(7 | 8)` in `test/helpers/vite.ts`; `buildWithWebpack`/`webpackConfig` in `test/helpers/webpack.ts`
  (TypeScript through `esbuild-loader` with `target: 'esnext'`, which keeps import attributes),
  `buildWithRspack`/`rspackConfig` in `test/helpers/rspack.ts` (`builtin:swc-loader` with
  `jsc.experimental.keepImportAttributes`), and `buildWithRsbuild` in `test/helpers/rsbuild.ts` (one `BuildResult` per
  Rsbuild environment, default SWC settings). Those three share `test/helpers/webpack-stats.ts` (stats → chunks,
  `HostBuildError` with the host's error messages, the captured infrastructure log) and
  `test/helpers/webpack-family.ts` (`entryChunk`, `expectedValues`, `generationDir`, `mirrorLoads`, `infoLines`,
  `runUnderDeno`, `watchBuilds` for watch-mode rebuilds). `evaluateModule` imports an output file in the current
  runtime (`installCssStyleSheet` provides a `CSSStyleSheet` stand-in).
- `startMockRegistry()` (`test/helpers/mock-registry.ts`) serves the npm package `mock-pkg@1.0.0` and the JSR package
  `@mock/pkg@1.0.0` on `127.0.0.1` (an ephemeral port) and records every request with its `authorization` header; the
  private-registry tests point `NPM_CONFIG_REGISTRY` and an `.npmrc` token, the `fetch` option, or `JSR_URL` with
  `DENO_AUTH_TOKENS` at it, with a fresh `DENO_DIR` (and `HOME` set to the project, so no user `.npmrc` applies).
- Deno binaries: tests that run the output under `deno run --cached-only` (or, with the sidecar,
  `deno run --frozen --cached-only`) need a `deno` on `PATH` and skip without one (`DENO_AVAILABLE` in
  `core-suite.ts`); CI has it only on the `deno` rows. Tests of the `deno` engine use `denoBinary` from
  `test/helpers/deno-binary.ts`: the binary named by `UNPLUGIN_DENO_TEST_DENO_BINARY` (default `deno`), probed once
  when the module loads with `--version`, with a `skipReason` when it is missing or older than 2.8.3; they skip with
  `it.skipIf(denoBinary.skipReason !== undefined)` and pass `denoBinary: denoBinary.binary` to the plugin.
- Keep tests hermetic: fixtures pin versions; network access only for the pinned remote fixtures. The engine reads
  `DENO_DIR` from the environment, so tests set it with `vi.stubEnv('DENO_DIR', await denoDir())`: `denoDir()` is
  `$UNPLUGIN_DENO_TEST_DENO_DIR` (CI points it at a cached directory) or `<os temp>/unplugin-deno-test/deno-dir`,
  shared by local runs so downloads happen once; `freshDenoDir()` gives an empty one. Tests that need no network
  inject a fetch (`setLoaderFetch`) instead.

## Documentation

- `README.md`: short and user-facing (install, a quick start covering every host, options table, engines,
  platforms, limitations, comparison, credits; about 250 lines). No architecture or internals. Every claim needs a
  test; say "planned" for options and hosts that have no effect yet.
- `docs/architecture.md`: how it works and why (for contributors and agents). Update it in the same PR as a
  behavioural change.
- `docs/plan.md`: goals, scope and milestones; only its progress note changes as work lands.
- `src/{config,core,engine,hosts}/README.md`: one short module map per directory.
- `.changeset/*.md`: what users see changing; until the first release, one changeset describes 0.1.0 as a whole.
- `docs/research/`: historical; do not edit, add new findings as new files.

## Release

Not set up yet: `pnpm release` fails on purpose until the release workflow lands, and nothing has been published (npm
has only a `0.0.0` placeholder of `unplugin-deno`, JSR has no `@brc-dd/unplugin-deno`; checked 2026-09-26). What
exists:

- Versioning: **changesets** (`pnpm changeset`; `.changeset/config.json`, public access, oxfmt formatting).
  The pending changeset (`.changeset/first-release.md`, one `minor` bump) describes 0.1.0 for users;
  `pnpm changeset status` lists the bumps.
- npm: `packages/unplugin-deno` publishes `dist/` and `vendor/` (plus `package.json`, `README.md`, `LICENSE`).
  Its `README.md` and `LICENSE` are copies of the root files (npm and JSR publish from the package directory); keep
  them identical (`cp README.md packages/unplugin-deno/README.md`; links in the README are absolute URLs so they work
  on npm and JSR). Check with `pnpm -F unplugin-deno publint` and `pnpm -F unplugin-deno attw`
  (`attw --pack --profile esm-only`: `require()` and `node10` resolution are unsupported by design).
- JSR: `packages/unplugin-deno/deno.json` (`@brc-dd/unplugin-deno`) maps the same subpaths to `dist/*.js` (build
  first) and maps the bare npm dependencies to `npm:` specifiers in `imports`. Its `version` must be kept in sync
  with `package.json` (changesets only bumps the latter). `lock: false` keeps Deno from writing a `deno.lock` when
  the tests run under Deno in that directory. `pnpm jsr:dry-run` runs `deno publish --dry-run --allow-dirty`.
- Vendored loader: `node scripts/vendor-loader.ts [version]` in `packages/unplugin-deno` (or
  `pnpm -F unplugin-deno vendor:loader`) downloads `@jsr/deno__loader` from npm.jsr.io, verifies its integrity,
  copies the Node.js code path, applies patches that each assert how often their pattern occurs (so upstream drift
  fails the script), adds `hooks.js` from `scripts/deno-loader-overlay/` and writes `NOTICE.md`. Output is
  reproducible: re-running for the same version changes nothing, so `git diff` shows exactly what a new version
  changes.

Known issues to resolve before the first JSR publish:

- `pnpm jsr:dry-run` (after `pnpm build`) fails type checking with three errors (checked 2026-09-26 with Deno 2.9.7):
  - `TS2307: Cannot find module '…/dist/options-<hash>.js'`, at `dist/index.d.ts`. Declarations shared by several
    entries go into a declaration-only chunk (`options-<hash>.d.ts`, with no `.js` beside it) that the entry `.d.ts`
    files import as `./options-<hash>.js`; TypeScript resolves that to the `.d.ts`, Deno's checker does not. Verified
    earlier: with a stub `options-<hash>.js` containing `/* @ts-self-types="./options-<hash>.d.ts" */` that error goes
    away, and without the entries' `@ts-self-types` banners the check passes but warns
    `unsupported-javascript-entrypoint` for all 12 entries (JSR users would get no types). Candidate fixes: emit such
    stubs from a tsdown hook, emit self-contained declarations per entry, or publish the TypeScript sources to JSR.
  - `TS2420: Class 'Workspace' incorrectly implements interface 'Disposable'` and the same for `Loader`, at
    `vendor/deno-loader/mod.d.ts` (lines 139 and 152): since the vendored `mod.js` carries
    `// @ts-self-types="./mod.d.ts"`, Deno checks that declaration file, whose classes say `implements Disposable` but
    declare no `[Symbol.dispose]()` member. A candidate fix is a patch in `scripts/vendor-loader.ts` that adds the
    member to the declarations (or drops the `implements` clause).

  CI runs the dry run with `continue-on-error`.
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
