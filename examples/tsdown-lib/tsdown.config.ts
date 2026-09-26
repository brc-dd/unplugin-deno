import deno from 'unplugin-deno/rolldown'
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    // For Deno: the plugin's platform keeps npm: packages as imports pinned to the locked
    // version, and `bundle` inlines the jsr: modules. tsdown's own platform is left neutral.
    entry: 'src/mod.ts',
    outDir: 'dist/deno',
    platform: 'neutral',
    plugins: [deno({ platform: 'deno', bundle: ['jsr:*'] })],
  },
  {
    // For browsers (and Node.js): everything is bundled.
    entry: 'src/mod.ts',
    outDir: 'dist/browser',
    platform: 'browser',
    plugins: [deno()],
  },
])
