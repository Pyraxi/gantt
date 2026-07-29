import { defineConfig } from 'vitest/config';

// Single unit project for now. Vitest 4 changed browser-provider config to
// a factory; we'll add a `browser` project when actual UI interaction tests
// (drag/resize) land in v0.1, importing playwright from
// '@vitest/browser-playwright' per the v4 API.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/engine/src/**/*.test.{ts,tsx}',
            'packages/core/src/**/*.test.{ts,tsx}',
            'packages/mpp-import/src/**/*.test.{ts,tsx}',
          ],
          environment: 'happy-dom',
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
