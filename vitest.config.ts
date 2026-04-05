import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    isolate: true,
    coverage: {
      provider: 'v8',
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
