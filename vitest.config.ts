import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['infra/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    passWithNoTests: true,
  },
});
