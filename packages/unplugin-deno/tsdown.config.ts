import { basename } from 'node:path'
import type { Plugin } from 'rolldown'
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
  // Not exported from package.json. Built as its own entry so the `../vendor/deno-loader/*`
  // imports are verifiably kept external in dist/ (see src/entries.test.ts).
  'vendored-deno-loader': 'src/vendored-deno-loader.ts',
}

/**
 * Declarations shared by several entries land in a declaration-only chunk (`options-<hash>.d.ts`)
 * that the entry declarations import as `./options-<hash>.js`. TypeScript resolves that to the
 * `.d.ts`; Deno loads the `.js`, so `deno publish` (JSR type-checks the published files) fails with
 * TS2307 when it is missing. rolldown-plugin-dts has no option that avoids shared declaration
 * chunks, so this emits a `.js` twin for each one: an empty module whose `@ts-self-types` comment
 * points Deno at the declarations. No JavaScript imports the twins.
 */
function declarationChunkTwins(): Plugin {
  return {
    name: 'unplugin-deno:declaration-chunk-twins',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || chunk.isEntry || !chunk.fileName.endsWith('.d.ts')) continue
        const twin = chunk.fileName.replace(/\.d\.ts$/, '.js')
        if (twin in bundle) continue
        this.emitFile({
          type: 'asset',
          fileName: twin,
          source: `/* @ts-self-types="./${basename(chunk.fileName)}" */\nexport {}\n`,
        })
      }
    },
  }
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
  plugins: [declarationChunkTwins()],
})
