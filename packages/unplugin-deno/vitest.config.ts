import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      // unit tests, colocated with the code
      'src/**/*.test.ts',
      // real-bundler builds of test/fixtures
      'test/integration/**/*.test.ts',
      // the test helpers' own tests
      'test/helpers/**/*.test.ts',
    ],
    setupFiles: ['test/helpers/setup.ts'],
    // Remote fixtures download into the test DENO_DIR on their first run.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    restoreMocks: true,
    unstubEnvs: true,
    server: {
      deps: {
        // Load the vendored loader natively, as the published package does, instead of through
        // Vite's transform pipeline.
        external: [/[\\/]vendor[\\/]deno-loader[\\/]/],
      },
    },
  },
})
