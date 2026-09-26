# rollup-lib

A library written for Deno that Rollup 4 bundles for Node.js and browsers: `sizeTable()` formats
file sizes as an aligned table with `jsr:@std/collections`, `jsr:@std/fmt` and
`npm:string-width` (an npm package with dependencies of its own).

`rollup.config.ts` uses:

- `unplugin-deno/rollup` with `platform: 'node'`. Rollup has no platform setting, so with a
  `deno.json` the plugin would build for Deno and keep `npm:` and `jsr:` imports external;
- a small esbuild plugin that strips TypeScript, because Rollup only reads JavaScript (it does not
  type-check; `deno check src/mod.ts` does).

To keep an npm dependency as an import for the library's users, name it in Rollup's `external`
option (`external: ['string-width']`) and in `package.json` `dependencies`: Rollup then leaves
the bare import as written, without asking the plugin.

## Run it

```sh
pnpm build                                                            # dist/mod.js
deno run -A --node-modules-dir=manual npm:rollup -c rollup.config.ts   # the same, under Deno
```

`pnpm check` type-checks the sources with `deno check`, builds the library, and imports it in
Node.js and under Deno. CI runs it.
