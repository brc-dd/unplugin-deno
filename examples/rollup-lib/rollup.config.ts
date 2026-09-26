import { transform } from 'esbuild'
import type { Plugin, RollupOptions } from 'rollup'
import deno from 'unplugin-deno/rollup'

/** Strips TypeScript with esbuild: Rollup itself only reads JavaScript. */
function typescript(): Plugin {
  return {
    name: 'typescript',
    transform: {
      filter: { id: { include: /\.[cm]?tsx?$/, exclude: /^\0/ } },
      async handler(code, id) {
        const result = await transform(code, {
          loader: id.endsWith('x') ? 'tsx' : 'ts',
          sourcefile: id,
          sourcemap: true,
        })
        return { code: result.code, map: result.map }
      },
    },
  }
}

const config: RollupOptions = {
  input: 'src/mod.ts',
  output: { dir: 'dist', format: 'es', sourcemap: true },
  plugins: [
    // Rollup has no platform setting, and with a deno.json the plugin targets Deno (npm: and jsr:
    // imports would stay external). This library is for Node.js and browsers: bundle everything.
    deno({ platform: 'node' }),
    typescript(),
  ],
}

export default config
