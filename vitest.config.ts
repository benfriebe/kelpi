import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['packages/client/src/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'node',
          include: ['packages/{protocol,core,daemon}/{src,tests}/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
    ],
  },
});
