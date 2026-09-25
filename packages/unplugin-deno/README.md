# unplugin-deno

Deno's module resolution for every bundler: `jsr:`, `npm:` and `https:` imports, `deno.json`
import maps and workspaces, `deno.lock` and import attributes in Vite, Rolldown, Rollup, esbuild,
webpack, Rspack/Rsbuild and Bun, with the bundler running on Node.js, Deno or Bun. No Deno
installation required.

> [!IMPORTANT]
> Pre-release: unplugin-deno is not published yet and is not ready for use. See the
> [plan](https://github.com/brc-dd/unplugin-deno/blob/main/docs/plan.md) for scope and status.

## Planned hosts

| Host             | Entry                                           | Target        |
| ---------------- | ----------------------------------------------- | ------------- |
| Vite 7 and 8     | `unplugin-deno/vite`                            | first release |
| Rolldown, tsdown | `unplugin-deno/rolldown`                        | first release |
| Rollup 4         | `unplugin-deno/rollup`                          | first release |
| esbuild          | `unplugin-deno/esbuild`                         | first release |
| webpack 5        | `unplugin-deno/webpack`                         | later         |
| Rspack, Rsbuild  | `unplugin-deno/rspack`, `unplugin-deno/rsbuild` | later         |
| Bun.build        | `unplugin-deno/bun`                             | later         |
| Farm             | `unplugin-deno/farm`                            | best effort   |

## License

[MIT](https://github.com/brc-dd/unplugin-deno/blob/main/LICENSE). Includes a vendored copy of
[`@deno/loader`](https://jsr.io/@deno/loader) (MIT, the Deno authors).

Not affiliated with Deno Land Inc.; "Deno" only describes what the plugin is compatible with.
