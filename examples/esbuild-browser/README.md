# esbuild-browser

A Markdown editor with a live preview, bundled for the browser with esbuild, laid out like a Lume
site: the browser code in `browser/` has its own `deno.json` (import map and lockfile), separate
from the `deno.json` of the Deno server in `serve.ts`.

- `browser/deno.json` maps `@std/fmt` to `jsr:` and `marked` to `npm:`; `browser/main.ts` also
  imports `text/case.ts` from `https://deno.land/std`.
- `build.ts` gives esbuild `platform: 'browser'` and the plugin `config: 'browser/deno.json'`.
  `cacheDir` keeps the plugin's mirror of remote modules in `./node_modules`; by default it would
  go next to that `deno.json`, in `browser/node_modules`.
- The bundle, `www/js/main.js`, is an ES module: in a browser it runs the editor, elsewhere it
  just exports `preview()`.

## Run it

```sh
pnpm build   # node build.ts: www/js/main.js
pnpm dev     # rebuilds on change and serves www/ on http://localhost:8000
pnpm start   # serves www/ with the Deno server in serve.ts
```

Under Deno, `deno run -A build.ts` (and `deno run -A build.ts --serve`) needs no flag: the root
`deno.json` keeps Deno's default for a project with a `package.json`, so esbuild and the plugin
come from `node_modules`, while `browser/deno.json` sets `"nodeModulesDir": "none"` for the code.

`pnpm check` type-checks the sources with `deno check`, builds the bundle, and imports it in
Node.js and under Deno to render some Markdown.
CI runs it.
