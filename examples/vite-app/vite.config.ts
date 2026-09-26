import deno from 'unplugin-deno/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [deno()],
})
