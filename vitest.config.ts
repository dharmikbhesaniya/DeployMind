import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.data/**', 'web/**'],
    env: {
      DEPLOYMIND_DB_PATH: '.data/test_deploymind.sqlite',
      DEPLOYMIND_DATA_DIR: '.data/test_data',
    },
  },
});
