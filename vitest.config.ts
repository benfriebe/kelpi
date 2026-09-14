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
        // live-app helpers into a vitest project that has no use for them. `shards.test.mjs`
        // joined them for the same reason (#203): `--only`'s chain expansion decides which steps
        // a re-run actually runs, and it reads the step manifest's own prose to do it, so a
        // re-worded entry has to fail here rather than in a 20-minute audit.
        test: {
          name: 'harness',
          include: ['scripts/ui-audit/lib/verify-plan.test.mjs', 'scripts/ui-audit/lib/battery.test.mjs', 'scripts/ui-audit/lib/build-cache.test.mjs', 'scripts/ui-audit/lib/placement.test.mjs', 'scripts/ui-audit/lib/shards.test.mjs', 'scripts/ui-audit/lib/web-batch.test.mjs', 'scripts/ui-audit/lib/aim.test.mjs', 'scripts/ui-audit/lib/cli-invocations.test.mjs'],
        },
      },
    ],
  },
});
