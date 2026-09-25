---
'unplugin-deno': minor
---

Support Vite 8 and 7: every environment resolves for its platform (the browser for client environments; Deno, with the `deno` export condition and pinned `npm:`/`jsr:` externals, for server environments of a `deno.json` project), the dev server prebundles `jsr:`, `npm:` (also CommonJS packages from Deno's global cache), `https:` and `data:` dependencies in one optimizer run, `deno.json`, import map and `deno.lock` changes reload the page, and `with { type: "text" | "bytes" | "css" }` imports are no longer taken for CSS or JSON by Vite's own plugins.
