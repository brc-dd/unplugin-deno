# Examples

Small projects that use unplugin-deno the way an app or a library would. Each one has its own
`deno.json` (import map) and `deno.lock`, a `package.json` for the build tools, sources written
for Deno, and a `check` script that builds the example and verifies the output. CI runs every
check on Linux and Windows.

| Example                            | Host              | What it shows                                                                                                                          |
| ---------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [vite-app](vite-app)               | Vite 8            | Browser app: `jsr:` packages through import-map aliases, an `npm:` subpath, an `https:` module, a text import, `?raw` through an alias |
| [vite-ssr-deno](vite-ssr-deno)     | Vite 8            | Hono server built for Deno: `npm:` and `jsr:` imports stay external, pinned to the locked versions; the output runs with `deno run`    |
| [tsdown-lib](tsdown-lib)           | tsdown (Rolldown) | Library with an output for Deno (`npm:` pinned, `jsr:` bundled) and one for browsers (everything bundled)                              |
| [esbuild-browser](esbuild-browser) | esbuild           | Lume-style browser bundle: the browser code has its own `deno.json`, separate from the Deno server's                                   |
| [rollup-lib](rollup-lib)           | Rollup 4          | Library for Node.js and browsers, with a small esbuild plugin for TypeScript                                                           |

## Running them

From the repository root:

```sh
pnpm install
pnpm examples:check            # builds the plugin once, then checks every example
pnpm --filter vite-app check   # checks one example
```

Then use an example's `package.json` scripts in its directory (`pnpm dev`, `pnpm build`, …). The
checks need [Deno](https://deno.com) on the `PATH`: they type-check the sources with Deno and run
the output under Deno too.

## Dependencies: `deno.json` for the code, `package.json` for the tools

The examples declare what their code imports in `deno.json` (`jsr:`, `npm:`, `https:`) and set
`"nodeModulesDir": "none"`: unplugin-deno loads those packages from Deno's cache (`DENO_DIR`), and
`deno.lock` pins them. `package.json` lists only the build tools (the bundler and the plugin),
which pnpm, npm or Yarn installs into `node_modules`. The other modes, in a project with a
`package.json`:

- without `nodeModulesDir` (Deno's default there is `"manual"`), npm packages come from
  `node_modules`, so every `npm:` import must also be a dependency in `package.json`;
- with `"auto"`, the plugin, like Deno, installs the `package.json` dependencies into
  `node_modules/.deno` itself and replaces the package manager's links: avoid it next to pnpm,
  npm or Yarn.

To run a tool under Deno, pass `--node-modules-dir=manual`: Deno then loads the bundler and the
plugin from `node_modules`, while the plugin still loads the code's packages as `deno.json` says:

```sh
deno run -A --node-modules-dir=manual npm:vite build
```

## Lockfiles

The plugin reads `deno.lock` and never writes it. To change dependencies, edit `deno.json` and
run `deno install` (plus `deno install --entrypoint <file>` for `https:` imports) in a copy of the
example that has only `deno.json` and the sources: in the example itself, `deno install` would
also install the `package.json` tools. The committed lockfiles also contain what Deno adds when
it runs the tools (`workspace.packageJson`) and, in `vite-ssr-deno` and `tsdown-lib`, the pinned
specifiers of the build output, so running the output never changes them.

## Outside this repository

Copy an example and replace `"unplugin-deno": "workspace:*"` in its `package.json` with a
published version once there is one. The `check` scripts build the plugin only when it is an
unbuilt workspace package; with a published version that step does nothing.
