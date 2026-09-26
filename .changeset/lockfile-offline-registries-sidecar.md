---
'unplugin-deno': minor
---

Lockfile, offline, private-registry and Deno-output features:

- `lockfile: 'frozen'` fails with `LOCKFILE_FROZEN_DRIFT` when a `jsr:` or `npm:` import or a remote URL resolves to something `deno.lock` does not record (the message names the drift, e.g. `npm:kleur@^4.1.5 resolved to 4.1.5, but deno.lock has no entry for it`). `'auto'` (the default) is frozen when `CI` is set or `deno.json` sets `"lock": { "frozen": true }` and a lockfile exists; `'off'` ignores `deno.lock` like `--no-lock`. The plugin never writes the lockfile.
- Lockfile explanations (`checks.lockfile`): an offline miss of a package `deno.lock` lacks is `NOT_IN_LOCKFILE`; drift that `'auto'` allows and versions the minimum dependency age held back are explained in the debug output, and `RESOLVE_CONSTRAINT` errors caused by the age say so.
- `cachedOnly`: every download is refused on both engines, and `CACHED_ONLY_MISS` hints name the import and the command that fills Deno's cache (`deno cache <entry>` or `deno install`).
- `allowImport` is enforced like Deno's `--allow-import`, with Deno 2.9's defaults (HTTPS only, `raw.esm.sh` included; `host`, `host:port`, `*.domain` and `*` entries): a remote import of another host fails with `DISALLOWED_HOST` before it is downloaded, for the imports of remote modules and redirects too. Hosts that `deno.lock` or the import maps name, and the JSR registry, are always allowed.
- `fetch`: the fetch the `loader` engine downloads with (proxies, custom authentication, a private JSR registry). The loader reads `.npmrc`, `NPM_CONFIG_REGISTRY` and `DENO_AUTH_TOKENS` but not `JSR_URL`, so `engine: 'auto'` uses the Deno CLI when `JSR_URL` names another registry.
- `jsrDepsInNodeModules` (or packages in `node_modules/@jsr/`): `jsr:` imports and import-map keys, subpaths included, resolve to the `@jsr/<scope>__<name>` npm packages in `node_modules`, never to mirrored JSR sources.
- `emitDenoConfig`: a Deno platform build (Rollup, Rolldown, a Vite server environment, esbuild) writes a `deno.json` and a `deno.lock` of its external packages next to the output, so `deno cache` and then `deno run --frozen --cached-only` work there.
