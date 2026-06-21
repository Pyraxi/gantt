import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias the workspace engine to its source so `pnpm test` runs green straight
// after `pnpm install`, with no build step. Without this, the core tests
// resolve `@pyraxi/cpm-engine` via its package `exports`, which point at the
// built `dist/`.
const enginePath = fileURLToPath(new URL('./packages/engine/src/index.ts', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            '@pyraxi/cpm-engine': enginePath,
          },
        },
        test: {
          name: 'unit',
          include: [
            'packages/engine/src/**/*.test.{ts,tsx}',
            'packages/core/src/**/*.test.{ts,tsx}',
          ],
          environment: 'happy-dom',
          // SVAR injects a <link> to its CDN icon font on mount; don't let
          // happy-dom fetch it, so the mount smoke tests run deterministically
          // offline (otherwise the fetch races teardown → AbortError).
          environmentOptions: {
            happyDOM: { settings: { disableCSSFileLoading: true } },
          },
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
