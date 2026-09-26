# vite-ssr-deno

A [Hono](https://hono.dev) server that Vite builds into one file for Deno. The plugin builds
Vite's server output for the Deno platform (the project has a `deno.json`): `npm:` and `jsr:`
imports stay imports, pinned to the versions in `deno.lock`, while local modules and the text file
imported `with { type: 'text' }` are bundled. `dist/server.js` starts with:

```js
import { format } from 'jsr:@std/fmt@1.0.10/duration'
import { Hono } from 'npm:hono@4.13.9'
import { html } from 'npm:hono@4.13.9/html'
import { hostname } from 'node:os'
```

## Run it

```sh
pnpm dev     # deno run -A --watch src/server.ts: Deno runs the sources as they are
pnpm build   # vite build: dist/server.js
pnpm start   # deno run -A --cached-only dist/server.js, on http://localhost:8000
```

Under Deno, build with `deno run -A --node-modules-dir=manual npm:vite build` (see the
[examples README](../README.md#dependencies-denojson-for-the-code-packagejson-for-the-tools)).

`--cached-only` works right after a build: the plugin downloaded the pinned packages into Deno's
cache (`DENO_DIR`) while resolving them. `deno.lock` lists the output's pinned specifiers too
(`npm:hono@4.13.9` next to `npm:hono@4`), so running the output never changes it.

`pnpm check` type-checks the sources with `deno check`, builds the server, compares its imports
with `deno.lock`, starts it with
`deno run --cached-only`, requests `/api/status`, and loads the app through Vite's dev server
(`ssrLoadModule`). CI runs it.
