/**
 * The shell's own vitest project.
 *
 * The repo-root `vitest.config.ts` defines two projects (`client`, `node`) and neither's
 * `include` covers `packages/shell`, so the root `pnpm test` does not pick these up — and the
 * root config is not this package's to edit. A local config keeps the shell's pure-logic tests
 * runnable on their own:
 *
 *     pnpm --filter @nex/shell test              # anywhere
 *     npx vitest run --root packages/shell       # from the repo root
 *
 * (A bare `npx vitest run packages/shell` from the root finds nothing: it filters the root
 * projects' file lists, and neither project's `include` matches this package.)
 *
 * Only pure modules are covered: bounds clamping, badge/tray derivation, the config hotkey
 * parse, icon encoding, run-dir/entry resolution. Anything that imports `electron` is
 * exercised by `scripts/smoke.mjs` against a real Electron process instead — an Electron
 * import cannot resolve under plain Node.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        name: 'shell',
        environment: 'node',
        include: ['src/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/dist/**']
    }
});
