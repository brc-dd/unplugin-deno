# vite-app

A browser app built with Vite 8 from sources written for Deno. "Slugger" turns a post title into
a URL path and files the post under the closest known topic. `vite.config.ts` only adds the
plugin; everything else comes from `deno.json`.

What it shows:

- `jsr:` packages through import-map aliases: `@std/text/to-kebab-case` and `@std/html/entities`
  (`"@std/text": "jsr:@std/text@^1"`);
- an `npm:` package with a subpath: `nanoid/non-secure` (`"nanoid": "npm:nanoid@^6"`);
- an `https:` module that has relative imports of its own: `closest_string.ts` from
  `deno.land/std`;
- a text import: `import topicList from './topics.txt' with { type: 'text' }`;
- `?raw` through a path alias: `import logo from '@/logo.svg?raw'` (`"@/": "./src/"`);
- local files stay Vite's: `index.html`, `style.css`, TypeScript, hot module replacement. In the
  dev server the JSR, npm and `https:` dependencies are prebundled like `node_modules` ones.

## Run it

With Node.js, after `pnpm install` at the repository root:

```sh
pnpm dev       # dev server
pnpm build     # production build in dist/
pnpm preview   # serves dist/
```

With Deno (`--node-modules-dir=manual` loads Vite and the plugin from `node_modules`, see the
[examples README](../README.md#dependencies-denojson-for-the-code-packagejson-for-the-tools)):

```sh
deno run -A --node-modules-dir=manual npm:vite
deno run -A --node-modules-dir=manual npm:vite build
```

`pnpm check` type-checks the sources with `deno check`, builds the app, runs the bundle against
a small stand-in for the DOM, and requests the entry and its prebundled dependencies from the dev
server. CI runs it.
