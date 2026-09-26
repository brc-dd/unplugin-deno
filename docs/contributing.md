# Contributing and project conventions

This document is for contributors and for coding agents working in this repository. Users should read the
[README](../README.md) instead. Design rationale lives in [architecture.md](architecture.md); the feature plan and
milestones in [plan.md](plan.md).

## Repository layout

```
unplugin-deno/
├─ package.json              # private workspace root: scripts, dev tooling
├─ pnpm-workspace.yaml       # workspace packages and all pnpm settings
├─ AGENTS.md                 # entry point for coding agents (CLAUDE.md imports it)
├─ README.md                 # user-facing README (copied to packages/unplugin-deno/README.md, see "Release")
├─ .changeset/               # pending changesets (see "Release")
├─ .github/workflows/ci.yml  # lint, test matrix (3 OS × Node 22/26, Deno, Bun), build and package checks, examples
├─ .github/workflows/release.yml  # version pull request, publishing to npm and JSR (see "Release")
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
│  ├─ scripts/               # vendor-loader.ts and deno-loader-overlay/ (generate vendor/deno-loader);
│  │                         # sync-version.ts and jsr-publish.ts (release, see "Release")
│  ├─ deno.json              # JSR manifest (see "Release")
│  └─ tsdown.config.ts vitest.config.ts tsconfig.json
├─ examples/                 # runnable end-user examples, one directory per scenario
└─ docs/                     # this file, architecture, plan
```

`src/config/`, `src/core/`, `src/engine/` and `src/hosts/` each have a `README.md` with a short module map; keep
them in step with the code. Unit tests are colocated with the code they test (`src/**/*.test.ts`); integration tests
live in `test/integration/`, the helpers' own tests in `test/helpers/*.test.ts`.

## Toolchain

- Package manager: **pnpm 12** (workspace; `packageManager` in the root `package.json`). pnpm ≥ 11 reads project
  settings only from `pnpm-workspace.yaml` (there is no `.npmrc`). Optional peers are not installed
  automatically (`autoInstallPeers: false`): a test that needs webpack, Rspack, Rsbuild or Farm adds it as a
  devDependency.
- Runtimes supported: **Node ≥ 22.12**, **Deno ≥ 2.7** (2.8+ recommended), **Bun ≥ 1.3**; CI tests Node 22 and 26,
  the latest Deno 2 and the latest Bun. The `deno` engine needs a Deno ≥ 2.8.3 binary. Building (tsdown) and running
  `scripts/*.ts` (native type stripping) need Node ≥ 22.18.
- Build: **tsdown** (Rolldown-based), `pnpm build`. ESM only, flat `dist/*.js` + `dist/*.d.ts`
  (`fixedExtension: false`); entry files start with a `@ts-self-types` comment for JSR, and each declaration-only chunk
  gets an empty `.js` twin with such a comment (see "Release"). Type declarations are emitted by tsdown with
  **TypeScript 6** (its declaration output does not support TypeScript 7 yet); `pnpm typecheck` runs `tsc --noEmit`.
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
- `.changeset/*.md`: what users see changing, one file per change (see "Release").

## Release

Releases are automated: changesets describe the changes, and `.github/workflows/release.yml` turns them into a version
pull request and publishes merged versions to npm (`unplugin-deno`) and JSR (`@brc-dd/unplugin-deno`). The first
release, 0.1.0, came from `.changeset/first-release.md` (a `minor` bump over the `0.0.0` placeholder).

### From a change to a release

1. A pull request with a user-visible change adds a changeset: run `pnpm changeset`, pick `unplugin-deno` and the bump
   (while 0.x, `minor` for features and breaking changes, `patch` for fixes) and describe the change for users.
   `pnpm changeset status` lists the pending bumps.
2. Every push to `main` runs the Release workflow (Node 26, the pnpm of `packageManager`, Deno 2): `pnpm install`,
   `pnpm check-version`, then `changesets/action@v2` (v2 is the major that supports Changesets CLI v3). While
   changesets are pending, the action runs `pnpm run version-packages` (`changeset version`, which bumps
   `package.json`, writes `CHANGELOG.md` and deletes the changesets; `pnpm sync-version`, which copies the version into
   `deno.json`; `pnpm install --lockfile-only`) and opens or updates the `chore: version packages` pull request from
   the `changeset-release/main` branch. GitHub starts no workflows for pull requests that a workflow's `GITHUB_TOKEN`
   creates, so CI does not run on it by itself: close and reopen it to run CI.
3. Merging the version pull request runs the workflow again. With no changesets left, the action runs
   `pnpm run release`: `pnpm build`; `changeset publish`, which runs `pnpm publish` for each version npm does not have
   and tags it `unplugin-deno@<version>`; then `pnpm -F unplugin-deno jsr:publish` (`scripts/jsr-publish.ts`), which
   asks the JSR API and runs `deno publish` unless JSR already has the version. When the package does not exist on JSR,
   or (in GitHub Actions) is not linked to this repository, OIDC cannot publish it: the script then prints a notice and
   succeeds. The action pushes the tags and creates a GitHub release with the changelog entry. Every later
   push to `main` without pending changesets runs `pnpm run release` again, which publishes only what is missing, so a
   failed publish is retried by re-running the workflow or by the next push.

### One-time setup (done for this repository on 2026-09-26; kept for forks and for reference)

- GitHub: Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull
  requests"; without it the action cannot open the version pull request. The job requests `contents: write`,
  `pull-requests: write` and `id-token: write` itself, so the default token can stay read-only.
- npm, trusted publishing (no token): on npmjs.com, package `unplugin-deno` → Settings → Trusted Publisher → GitHub
  Actions: user `brc-dd`, repository `unplugin-deno`, workflow filename `release.yml`, no environment. It needs a
  GitHub-hosted runner and `id-token: write`. `changeset publish` uses `pnpm publish`, and pnpm 12 does the OIDC token
  exchange itself (npm's "npm CLI 11.5.1 or later" applies to `npm publish`; Node 26 ships npm 11.12 or later anyway).
  Once it works, "Require two-factor authentication and disallow tokens" in the package settings blocks token
  publishing. npm attaches provenance only for public repositories (`publishConfig.provenance` is set).
- JSR: create the package (https://jsr.io/new, scope `@brc-dd`, name `unplugin-deno`) and link the public GitHub
  repository `brc-dd/unplugin-deno` in its Settings tab (JSR links only public repositories). `deno publish` in the
  workflow then authenticates with OIDC (no secret) and adds provenance.

### Publishing by hand

If the workflow cannot publish: on an up-to-date `main` that contains the merged version pull request, run
`pnpm install`, `npm login` (pnpm reads the token from `~/.npmrc`) and `pnpm release`. `pnpm publish` asks for a
one-time password when the account uses 2FA, and `deno publish` opens the browser to authorize. Then push the tag
(`git push origin unplugin-deno@<version>`) and create the GitHub release from the changelog entry. For JSR alone:
`pnpm build && pnpm -F unplugin-deno jsr:publish`. Local publishes carry no provenance.

### Package contents and checks

- npm: `files` publishes `dist/`, `vendor/`, `README.md`, `LICENSE` and `CHANGELOG.md` (with `package.json`); no
  sources, tests or source maps. `exports` maps each subpath to `./dist/<name>.js` without `types` conditions:
  TypeScript finds the `.d.ts` beside each file. The `prepare` script (tsdown) runs on `pnpm install` in the workspace
  and before `pnpm pack` and `pnpm publish` (pnpm 12 runs `prepack` and `prepare` for both), so a publish always ships
  a fresh build. `publishConfig` sets public access and provenance. Check the package with `npm pack --dry-run`,
  `pnpm -F unplugin-deno publint` and `pnpm -F unplugin-deno attw` (`attw --pack --profile esm-only`: `require()` and
  `node10` resolution are unsupported by design).
- JSR: `packages/unplugin-deno/deno.json` (`@brc-dd/unplugin-deno`) exports the same subpaths as `package.json`, in the
  same order, and maps the npm dependencies to `npm:` specifiers with the same ranges in `imports`. `publish.include`
  lists `dist`, `vendor`, `README.md` and `LICENSE` (`deno.json` is always published); `"!dist"` in `publish.exclude`
  un-ignores the git-ignored build. `lock: false` keeps Deno from writing a `deno.lock` when the tests run under Deno
  in that directory. `pnpm jsr:dry-run` (after `pnpm build`) runs `deno publish --dry-run --allow-dirty`, which
  type-checks the published files as JSR does. The package is about 6.2 MB, 5.5 MB of it the wasm: below JSR's limits
  of 20 MB for the files of a version and for a single file (https://jsr.io/docs/quotas-and-limits; the 4 MB per-file
  figure on JSR's troubleshooting page is outdated, the registry's `MAX_FILE_SIZE` is 20 MiB).
- Versions: changesets bumps only `package.json`. `pnpm sync-version` (`scripts/sync-version.ts`) copies the version
  into `deno.json`; `pnpm check-version` (run by the release workflow) and `src/manifests.test.ts` fail when they
  differ. The test also compares the exports and dependency ranges of both manifests and checks that the package's
  `README.md` and `LICENSE` are copies of the root files: npm and JSR publish from the package directory, so after
  editing the README run `cp README.md packages/unplugin-deno/README.md` (its links are absolute URLs so they work on
  npm and JSR).
- Types for Deno and JSR: entry files start with `/* @ts-self-types="./<name>.d.ts" */`. Declarations shared by
  several entries go into a declaration-only chunk (`options-<hash>.d.ts`) that the entry declarations import as
  `./options-<hash>.js`; TypeScript resolves that to the `.d.ts`, Deno needs the `.js`. rolldown-plugin-dts has no
  option that avoids such chunks, so a plugin in `tsdown.config.ts` emits an `export {}` twin with a `@ts-self-types`
  comment for each one. Deno also checks `vendor/deno-loader/mod.d.ts` (through the `@ts-self-types` comment of
  `mod.js`), so `scripts/vendor-loader.ts` restores the `[Symbol.dispose]()` members its generated declarations drop.
- Vendored loader: `node scripts/vendor-loader.ts [version]` in `packages/unplugin-deno` (or
  `pnpm -F unplugin-deno vendor:loader`) downloads `@jsr/deno__loader` from npm.jsr.io, verifies its integrity,
  copies the glue of both wasm loading paths (`rs_lib_node.js` for `file:` URLs, `lib/rs_lib.js` for Deno loading the
  JSR package from `https:` URLs; [architecture.md §4.2](architecture.md#42-loader-engine-vendored-denoloader-050)),
  applies patches that each assert how often their pattern occurs (so upstream drift fails the script), adds
  `hooks.js` from `scripts/deno-loader-overlay/` and writes `NOTICE.md`. Output is reproducible: re-running for the
  same version changes nothing, so `git diff` shows exactly what a new version changes. Under Deno,
  `src/vendored-deno-loader.remote.test.ts` loads `vendor/deno-loader/` from a local HTTP server the way JSR serves it.

### Known issues

- From JSR (`https://jsr.io/…` URLs under Deno), the Vite, Rolldown, Rollup and esbuild entries work
  (`test/integration/jsr-served.test.ts` serves the built package over HTTP to a child `deno run`, like JSR does). The
  webpack, Rspack and Rsbuild adapters locate unplugin's loader files with `require.resolve` from an installed package
  (`src/hosts/webpack/unplugin-loaders.ts`), so from JSR they fail with `ENGINE_UNAVAILABLE` and a hint to install the
  npm package; the README lists this under Limitations.

## Working as a coding agent here

1. Read `docs/plan.md`, `docs/architecture.md`, this file, and the existing code in the area you touch before writing.
2. Stay within the area you were assigned; do not reformat or restructure unrelated files.
3. Prefer extending existing helpers over adding parallel ones; if a helper is missing in `utils/` or `core/id.ts`,
   add it there once.
4. Run `pnpm lint`, `pnpm typecheck`, and the relevant tests before declaring a task done; report failures verbatim.
5. Do not commit; the orchestrating session commits between phases.
