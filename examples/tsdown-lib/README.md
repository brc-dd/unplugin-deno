# tsdown-lib

A small library written for Deno, publishable to JSR as it is (`name`, `version` and `exports` in
`deno.json`), and built with [tsdown](https://tsdown.dev) for two targets:

- `dist/deno/mod.js`, for Deno: `jsr:@std/fmt` is bundled, `npm:ms` stays an import pinned to the
  locked version (`import ms from "npm:ms@2.1.3"`);
- `dist/browser/mod.js`, for browsers and Node.js: everything is bundled, the CommonJS `ms`
  included.

`tsdown.config.ts` builds both with `unplugin-deno/rolldown`: the plugin's `platform: 'deno'` and
`bundle: ['jsr:*']` for the first, tsdown's `platform: 'browser'` for the second.

```ts
import { humanize } from './dist/browser/mod.js'

humanize('90m') // '1h 30m'
```

## Run it

```sh
pnpm build                                         # both outputs
deno run -A --node-modules-dir=manual npm:tsdown   # the same, under Deno
```

`pnpm check` type-checks the sources with `deno check`, builds the library, checks the imports
of both outputs against `deno.lock`, and
imports `dist/browser/mod.js` in Node.js and both outputs under Deno. CI runs it.
