---
'unplugin-deno': minor
---

Resolve and load Deno modules in Rolldown and Rollup builds: `jsr:`, `npm:`, `https:` and `data:` imports, `deno.json` import maps and workspaces, remote modules mirrored as files under `node_modules/.unplugin-deno`, `with { type: "text" | "bytes" | "css" }` imports, and pinned `npm:`/`jsr:` externals for `platform: 'deno'`.
