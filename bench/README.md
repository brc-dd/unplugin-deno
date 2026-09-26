# Benchmark

How much unplugin-deno adds to a Vite 8 app, against the same app with its packages installed in
`node_modules`. The numbers are indicative only: they vary with the machine, the disk cache and
the plugin's version.

## What it measures

`scripts/project.ts` writes a project with an `index.html`, `src/main.ts` and 50 feature
modules; each module imports three of eight packages by bare specifier (`@std/text`, `@std/fmt`,
`@std/collections`, `@std/encoding`, `@std/path` from JSR; `marked`, `nanoid`, `string-width`
from npm). The same sources are built in three setups:

- **(a) npm**: the packages come from `node_modules` (`package.json` installs the JSR ones from
  npm.jsr.io), no plugin;
- **(b) cold mirror**: unplugin-deno resolves them through the import map in
  [`project/deno.json`](project/deno.json) (`"nodeModulesDir": "none"`, locked by
  `project/deno.lock`), with the plugin's mirror of remote modules removed before each run;
- **(c) warm mirror**: the same, with the mirror left from the previous run.

For the dev server, (a) and (c) start with Vite's dependency cache removed, and the times are
the first response for `/src/main.ts` and the full page: that module and everything it imports
(local modules and prebundled dependencies), fetched in parallel waves like a browser does.

Every run is a new process, timed from the start of the script, so loading Vite and the plugin
is included. Downloads are not: a warm-up build fills `DENO_DIR` first.

## Run it

```sh
pnpm bench                     # at the repository root: builds the plugin, then runs the benchmark
pnpm --filter bench run bench  # the benchmark only
BENCH_RUNS=10 pnpm bench       # more runs (default 5)
```

The projects are written to `<os temp dir>/unplugin-deno-bench` (with `DENO_DIR` there unless it
is set). `deno run -A scripts/bench.ts` runs it under Deno.

## Results

2026-09-26, macOS 26.7 on an Apple M2 Pro (10 cores, 16 GiB), Node.js 26.8.1, Vite 8.3.1,
unplugin-deno at the M1 work in progress (0.0.0); median of 5 runs (min–max):

| `vite build`                                | Time             | JS output |
| ------------------------------------------- | ---------------- | --------- |
| (a) npm packages in node_modules, no plugin | 127 ms (121–129) | 58.8 KiB  |
| (b) unplugin-deno, cold mirror              | 303 ms (291–308) | 58.8 KiB  |
| (c) unplugin-deno, warm mirror              | 276 ms (273–279) | 58.8 KiB  |

| Dev server, cold dependency cache           | First request (`/src/main.ts`) | Full page        | Modules |
| ------------------------------------------- | ------------------------------ | ---------------- | ------- |
| (a) npm packages in node_modules, no plugin | 171 ms (166–172)               | 249 ms (237–255) | 59      |
| (c) unplugin-deno, warm mirror              | 260 ms (256–271)               | 383 ms (381–396) | 59      |

The output is the same size: tree-shaking works as well through the plugin. The plugin costs
about 150 ms per build here, most of it with a warm mirror too, so writing the mirror is not the
main cost; it is spent in the plugin's engine (loading the vendored Deno loader and resolving
through it). The dev server needs about 90 ms more for the first request and 130 ms more for the
whole page. One run under Deno 2.9.7 (`deno run -A scripts/bench.ts`) gave similar numbers:
builds of 113, 294 and 268 ms, first requests of 172 and 315 ms.
