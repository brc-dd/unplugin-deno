import { join } from 'node:path'
import * as esbuild from 'esbuild'
import deno from 'unplugin-deno/esbuild'

/** Bundles browser/main.ts into www/js/; `--serve` rebuilds on change and serves www/. */
const options: esbuild.BuildOptions = {
  absWorkingDir: import.meta.dirname,
  entryPoints: ['browser/main.ts'],
  outdir: 'www/js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    deno({
      // The browser code has its own deno.json (import map and lockfile), separate from the one
      // of the Deno server in serve.ts.
      config: 'browser/deno.json',
      // Keep the mirror of remote modules in ./node_modules rather than next to that deno.json.
      cacheDir: 'node_modules/.unplugin-deno',
    }),
  ],
}

if (process.argv.includes('--serve')) {
  const context = await esbuild.context(options)
  await context.watch()
  await context.serve({ servedir: join(import.meta.dirname, 'www'), port: 8000 })
} else {
  await esbuild.build(options)
}
