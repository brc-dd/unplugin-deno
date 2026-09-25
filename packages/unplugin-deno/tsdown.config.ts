import { defineConfig } from 'tsdown'

const hosts = [
  'vite',
  'rolldown',
  'rollup',
  'esbuild',
  'webpack',
  'rspack',
  'rsbuild',
  'bun',
  'farm',
]

const entry: Record<string, string> = {
  index: 'src/index.ts',
  ...Object.fromEntries(hosts.map((host) => [host, `src/${host}.ts`])),
  register: 'src/register.ts',
  api: 'src/api.ts',
  // Not exported from package.json. Built on its own until the M1 engine imports it, so the
  // `../vendor/deno-loader/*` imports are verifiably kept external in dist/.
  'vendored-deno-loader': 'src/vendored-deno-loader.ts',
}

export default defineConfig({
  entry,
  format: 'esm',
  platform: 'node',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: {
    // The vendored loader ships as files next to dist/ (it reads its wasm relative to itself).
    // Sources that import it live directly in src/, so the specifier is valid in both places.
    neverBundle: [/^\.\.\/vendor\//],
  },
  outputOptions: {
    // Lets JSR (and Deno) find the declarations of each JavaScript entrypoint.
    banner: (chunk) =>
      chunk.isEntry && chunk.fileName.endsWith('.js')
        ? `/* @ts-self-types="./${chunk.fileName.replace(/\.js$/, '.d.ts')}" */`
        : '',
  },
})
