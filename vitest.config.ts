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
          include: ['packages/{protocol,core,daemon,cli,plugin-sdk}/{src,tests}/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        // The harness is not under `packages/`, so neither project above could see it and
        // `scripts/` had no tests at all. What MUST have them is the part of the harness that can
        // stop, or now un-stop, a promote: the scenario rule (#66 follow-up), a pure decision
        // function that can refuse a diff, and the battery runner (#109), which decides whether a
        // red component is a wobble or a regression. Both are named file by file rather than
        // globbed out of `scripts/`, because a wider glob would drag the 1.8 MB audit and its
        // live-app helpers into a vitest project that has no use for them. `cdp.test.mjs` earns
        // its place on the same rule from the other side: a key the harness presses with no entry
        // in the CDP key table is dispatched with a zero virtual key code and dropped in silence,
        // so the press that was supposed to fail a promote never happens at all (#207).
        test: {
          name: 'harness',
          include: ['scripts/ui-audit/lib/verify-plan.test.mjs', 'scripts/ui-audit/lib/battery.test.mjs', 'scripts/ui-audit/lib/build-cache.test.mjs', 'scripts/ui-audit/lib/placement.test.mjs', 'scripts/ui-audit/lib/cdp.test.mjs'],
        },
      },
    ],
  },
});
