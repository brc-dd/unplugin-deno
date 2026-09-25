# Prior-art research (snapshot 2026-09-25)

These reports were produced by six parallel research passes before any code was written. They inform
[`../../PLAN.md`](../../PLAN.md). Facts marked "verified"/"(T)" inside the reports were reproduced locally
with Deno 2.9.7, Node 26, Bun 1.3 and the bundler versions named in each report.

| File | Scope |
|---|---|
| [esbuild.md](esbuild.md) | `@deno/esbuild-plugin`, `@luca/esbuild-deno-loader` and forks, `@oazmi/esbuild-plugin-deno`, `@ggpwnkthx/esbuild-plugin-deno`, `@miyauci/esbuild-deno-specifier`, `@miyauci/esbuild-import-map`, `esbuild-plugin-cache-deno`; esbuild plugin API usage matrix |
| [vite.md](vite.md) | `@deno/vite-plugin` (defects reproduced with Vite 8.3.1), `@deno-plc/vite-plugin-deno`, `@str4ngemd/deno-vite-plugin`, `@transitionsag/deno-workspace-vite-plugin`, `@lockness/vite`, `vite_deno_plugin`, `vite_plugin_deno_resolve`; Vite 8 dev-vs-build behaviour |
| [rolldown-rollup-rspack-webpack.md](rolldown-rollup-rspack-webpack.md) | `@deno/rolldown-plugin`, `@lulu/deno-rolldown-plugin`, `rollup-plugin-deno`, `rollup-plugin-deno-resolver`/drollup, `rspack-deno-plugin`, `@snowman/rspack-deno-plugin`, webpack `target: "deno"` and `experiments.buildHttp`, rolldown PR #1762, unplugin webpack/rspack adapter limits (verified recipes) |
| [multi-and-deno-tooling.md](multi-and-deno-tooling.md) | `@deno/loader` complete API, runtime support, npm handling and bugs; `@jeiea/unplugin-deno`; `unplugin-jsr`; `deno bundle` flags and internals (edge-case checklist); `Deno.bundle()`; `deno info --json` schema; `deno.lock` v5; DENO_DIR layout; Deno 2.5–2.9 changes; `@deno/emit`; other `@deno/*` wasm packages |
| [ecosystem.md](ecosystem.md) | Verified latest versions and newest APIs of unplugin 3.4, Vite 8.3, Rolldown 1.2, tsdown, Rollup 4.63, esbuild 0.28, Rspack 2.2/Rsbuild 2.2, webpack 5.111, Farm, Bun, TypeScript 7; Deno 2.5–2.9 platform features; capability matrix (plugin needs × host); 26 experiments |
| [frameworks-and-demand.md](frameworks-and-demand.md) | What is officially recommended today; Fresh 2, Lume, Deno Deploy; ranked pain-point themes from ~1,500 issues; 21-item wishlist; capabilities nobody provides; anti-features; naming/trademark check; acceptance matrix |
| [frameworks-A.md](frameworks-A.md) | Astro, SvelteKit, Nuxt/Nitro, React Router, TanStack Start, SolidStart, Qwik on Deno |
| [frameworks-B.md](frameworks-B.md) | Lume, Hono, Ultra, Aleph, Lockness, deno-plc, Vike on Deno |

Shorthand used across the reports and the plan: `dvp#` = denoland/deno-vite-plugin, `fresh#` = freshframework/fresh,
`deno#` = denoland/deno, `deno-js-loader#` = denoland/deno-js-loader, `esbuild_deno_loader#` = lucacasonato/esbuild_deno_loader,
`deno-rolldown-plugin#` = denoland/deno-rolldown-plugin, `rolldown#` = rolldown/rolldown, `rspack#` = web-infra-dev/rspack,
`vite#` = vitejs/vite, `jsr#` = jsr-io/jsr, `unplugin#` = unjs/unplugin.
