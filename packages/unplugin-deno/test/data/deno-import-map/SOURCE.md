# Source: denoland/import_map test cases

- Upstream: https://github.com/denoland/import_map (the import map implementation Deno uses).
- Commit: `024525cdc9a5e4373a84dd5c39c43e5e4291da6e` (2026-09-25).
- License: MIT, Copyright (c) 2018-2025 the Deno authors.

The repository ships no data files of its own (it runs the WPT data through a git submodule), so
[cases.json](cases.json) re-expresses its Deno-specific tests in the WPT data-driven format. Each
case name starts with the upstream test it comes from:

| Case                                                                                                  | Upstream test                      |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `from_json_2`, `from_json_3`, `import_keys`, `querystring`                                            | `rs-lib/tests/integration_test.rs` |
| `parse_with_no_double_encode`                                                                         | `rs-lib/tests/integration_test.rs` |
| `npm_specifiers`, `mapped_windows_file_specifier`, `ext_expand_imports`, `iterate_applicable_entries` | `rs-lib/src/lib.rs` (unit tests)   |
| `test_expand_imports_with_trailing_slash`                                                             | `rs-lib/src/ext.rs`                |
| `tests/test.ts`                                                                                       | `tests/test.ts` (JS API)           |

`expandImports: true` corresponds to `ImportMapOptions { expand_imports: true }` (Deno applies it to
inline `imports`/`scopes` of a `deno.json`). Expected values are the upstream assertions; parsed
maps are given in normalised form (URL keys and addresses serialised) rather than the crate's
`to_json()` text.

MIT License text:

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
