---
'unplugin-deno': minor
---

Resolve and load Deno modules in esbuild builds (`unplugin-deno/esbuild`): `jsr:`, `npm:`, `https:` and `data:` imports, `deno.json` import maps and workspaces found from `absWorkingDir`, npm packages resolved by esbuild itself (so `sideEffects` tree-shaking works), `with { type: "text" | "bytes" | "css" }` imports, pinned `npm:`/`jsr:` externals for Deno output and with `packages: 'external'`, esbuild's `external` option, and `esbuild.context()` rebuilds that pick up `deno.json` changes.
