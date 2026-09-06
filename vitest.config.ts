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
          include: ['packages/{protocol,core,daemon,cli}/{src,tests}/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        // The harness is not under `packages/`, so neither project above could see it and
        // `scripts/` had no tests at all. The one thing in there that MUST have them is the
        // scenario rule (#66 follow-up): it is a pure decision function that can refuse a diff
        // and therefore block a promote, so being wrong about it is expensive. The include names
        // that one file rather than globbing `scripts/`, because a wider glob would drag the
        // 1.8 MB audit and its live-app helpers into a vitest project that has no use for them.
        test: {
          name: 'harness',
          include: ['scripts/ui-audit/lib/verify-plan.test.mjs'],
        },
      },
    ],
  },
});
