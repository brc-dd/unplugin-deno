# Source: web-platform-tests import maps data

- Upstream: https://github.com/web-platform-tests/wpt, directory
  `import-maps/data-driven/resources/` (format documented in `import-maps/data-driven/README.md`).
- Commit: `7f8d6b3544da6ce717dc0eb4e63754e5fbc1a3f0` (2025-11-25, the latest change to that
  directory; identical to `master` at `ec045886be6767b59f45fc7351c04cfd4f273727`, fetched
  2026-09-26).
- Raw URL pattern:
  `https://raw.githubusercontent.com/web-platform-tests/wpt/7f8d6b3544da6ce717dc0eb4e63754e5fbc1a3f0/import-maps/data-driven/resources/<name>.json`
- License: 3-Clause BSD, copyright web-platform-tests contributors; the license text is in
  [LICENSE.md](LICENSE.md) (copied from the repository root at the same commit).

All 22 `*.json` files of the directory are copied; `pnpm fmt` (oxfmt) re-indented
`parsing-schema-specifier-map.json`, which differs from upstream in whitespace only. They are run by
`src/config/import-map.wpt.test.ts`:

- `expectedResults` cases resolve each specifier with `resolveImportMap` (`null` = resolution
  throws);
- `expectedParsedImportMap` cases (the `parsing-*.json` files, which the WPT harness itself does not
  run) compare `serializeImportMap(parseImportMap(...))`; a string `importMap` is JSON text and is
  parsed with the strict JSON parser used for external import map files (`parseJson`).

Skipped cases, if any, are listed with a reason in the `SKIPPED` table of the test file.
