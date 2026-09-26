# `config/`

The pure-TypeScript config layer (no wasm) described in
[docs/architecture.md §3](../../../../docs/architecture.md#3-config-layer-srcconfig-pure-typescript-no-wasm).
It reproduces Deno 2.9's behaviour (verified against Deno 2.9.7) and never imports `core/` (except
the specifier parsers), `engine/` or `hosts/`.

- `deno-config.ts`: the `DenoConfig` fields the plugin uses, `readDenoConfig` (JSONC, errors with
  `file:line:column`), normalisation (`nodeModulesDir`, `workspace`, `links`/`patch`, `exports`,
  `lock`, JSX settings, `minimumDependencyAge`).
- `package-json.ts`: `package.json` reading, dependency classification, catalogs.
- `discover.ts`: `discoverProject`: nearest config folder, workspace root and members (globs),
  `links` (and automatic links), external import maps, warnings, watched files.
- `node-modules.ts`: `detectNodeModules`: the `nodeModulesDir` mode, the `node_modules` layout,
  and the markers of another package manager (pnpm, npm, Yarn) in it.
- `import-map.ts`: the WICG import-map algorithm with Deno's deviations and package expansion, and
  `createImportMapResolver` for workspaces (member/link scopes and packages, package.json
  dependencies).
- `version-req.ts`: Deno's specifier version requirements (lockfile keys, member version matching).
- `lockfile.ts`: the `deno.lock` v5 reader (`pin`, `hasPackage`, `remoteIntegrity`, …),
  which the core's lockfile policy (drift, `lockfile: 'frozen'`) and sidecar lockfile read.
- `project.ts`: `loadProject` assembles everything into a `Project`; `configGeneration` hashes the
  watched files.

The import-map resolver runs the web-platform-tests data in `test/data/wpt-import-maps` and cases
adapted from `denoland/import_map` in `test/data/deno-import-map` (see their `SOURCE.md`).
