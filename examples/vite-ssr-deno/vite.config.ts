import deno from 'unplugin-deno/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [deno()],
  build: {
    // A server build of one entry: dist/server.js runs with `deno run`.
    ssr: 'src/server.ts',
  },
})
