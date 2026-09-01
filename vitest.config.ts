import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['dist/**', 'test/**'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    include: ['test/**/*.test.ts'],
    mockReset: true,
    restoreMocks: true,
  },
});
