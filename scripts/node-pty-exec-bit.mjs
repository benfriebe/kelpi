#!/usr/bin/env node
/**
 * Restore (or assert) the execute bit on node-pty's prebuilt `spawn-helper` binaries.
 *
 * WHY THIS EXISTS (#36)
 * --------------------
 * node-pty 1.1.0, the version this repo pins and the current `latest` on npm, publishes
 * `prebuilds/darwin-arm64/spawn-helper` and `prebuilds/darwin-x64/spawn-helper` with mode 0644.
 * The execute bit is missing from the tarball itself, so no package manager can put it back:
 *
 *   $ tar -tvf node-pty-1.1.0.tgz | grep spawn-helper
 *   -rw-r--r--  0 0  0  50480  package/prebuilds/darwin-arm64/spawn-helper
 *   -rw-r--r--  0 0  0   9248  package/prebuilds/darwin-x64/spawn-helper
 *
 * node-pty's own lifecycle scripts do not repair it either: `scripts/prebuild.js` (its `install`)
 * only checks that the prebuild directory exists, and `scripts/post-install.js` (its `postinstall`)
 * only prunes `build/Release`. Neither one touches `prebuilds/`. So a clean install on macOS lands
 * a non-executable helper every time, with pnpm and with npm alike, and every PTY spawn fails:
 *
 *   Error: posix_spawnp failed.
 *
 * That error surfaces a long way from its cause. It cost roughly an hour the first time: the test
 * suite reports 24 failures across 9 files that all read like product defects, and a dev instance
 * comes up with a healthy daemon whose terminal panes die the instant they are created, logging
 * nothing. Hence a repair at install time rather than a line in the README that people bounce off.
 *
 * WHAT WOULD MAKE THIS UNNECESSARY
 * --------------------------------
 * Upstream has already fixed it: node-pty 1.2.0-beta.15 ships both helpers 0755 (1.2.0-beta.2 was
 * still 0644). When this repo moves to a node-pty release that carries the bit, delete this script
 * and its two call sites. `--check` will tell you the day it becomes a no-op.
 *
 * USAGE
 *   node scripts/node-pty-exec-bit.mjs           # repair, quietly; never fails an install
 *   node scripts/node-pty-exec-bit.mjs --check   # assert only; exit 1 naming the exact remedy
 *
 * It is wired into the root `postinstall` (so a fresh `pnpm install` is enough) and into `pnpm test`
 * and `scripts/dev-instance.mjs` (so an install run with `--ignore-scripts`, which skips the
 * postinstall, fails loudly at the two places where #36 was originally misdiagnosed).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every `spawn-helper` node-pty could load at runtime, deduplicated by real path.
 *
 * Two layouts, because the repo is not the only consumer: pnpm's isolated store under
 * `node_modules/.pnpm/`, and the flat `node_modules/node-pty` that npm (or a hoisting config)
 * produces. Workspace packages reach node-pty through a symlink into `.pnpm`, so repairing the
 * store copy repairs all of them at once; the realpath dedupe keeps that from being reported twice.
 */
export function spawnHelpers(repoRoot = repoRootDefault) {
    const patterns = [
        'node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper',
        'node_modules/node-pty/prebuilds/*/spawn-helper',
        'packages/*/node_modules/node-pty/prebuilds/*/spawn-helper'
    ];
    const seen = new Map();
    for (const pattern of patterns) {
        let matches = [];
        try {
            matches = fs.globSync(pattern, { cwd: repoRoot });
        } catch {
            // A missing node_modules is the normal pre-install state, not an error worth raising.
            continue;
        }
        for (const match of matches) {
            const absolute = path.join(repoRoot, match);
            let real;
            try {
                real = fs.realpathSync(absolute);
            } catch {
                continue;
            }
            if (!seen.has(real)) seen.set(real, absolute);
        }
    }
    return [...seen.values()].sort();
}

/** The subset of `spawnHelpers` the current user cannot execute. */
export function nonExecutableSpawnHelpers(repoRoot = repoRootDefault) {
    return spawnHelpers(repoRoot).filter((helper) => {
        try {
            fs.accessSync(helper, fs.constants.X_OK);
            return false;
        } catch {
            return true;
        }
    });
}

/** chmod +x every helper that needs it, preserving the rest of its mode. Returns what it changed. */
export function restoreSpawnHelpers(repoRoot = repoRootDefault) {
    const repaired = [];
    for (const helper of nonExecutableSpawnHelpers(repoRoot)) {
        try {
            fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
            repaired.push(helper);
        } catch {
            // Read-only store, someone else's file: leave it. `--check` is what turns this into a
            // hard failure, and it runs where a human is watching.
        }
    }
    return repaired;
}

/**
 * The remedy, spelled out. Printed by every caller that finds a broken helper, because the whole
 * point of #36 is that the next person should lose a minute rather than an hour.
 */
export function spawnHelperRemedy(broken) {
    return [
        'node-pty\'s spawn-helper is not executable, so every PTY spawn will fail with',
        '"posix_spawnp failed." (kelpi#36 - node-pty 1.1.0 ships it 0644 in its tarball).',
        '',
        ...broken.map((helper) => `  not executable: ${helper}`),
        '',
        'Fix it with either of:',
        '  node scripts/node-pty-exec-bit.mjs',
        "  chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper",
        '',
        'A plain `pnpm install` also repairs it (root postinstall); an install run with',
        '--ignore-scripts does not, which is how you got here.'
    ].join('\n');
}

// ── cli ─────────────────────────────────────────────────────────────────────────────

if (process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    if (check) {
        const broken = nonExecutableSpawnHelpers();
        if (broken.length > 0) {
            console.error(spawnHelperRemedy(broken));
            process.exit(1);
        }
    } else {
        const repaired = restoreSpawnHelpers();
        // Silent when there was nothing to do: this runs on every install, and a line of output
        // per install for a defect that is usually already handled is noise. Loud when it acts,
        // because "why did my node_modules change" deserves an answer in the scrollback.
        for (const helper of repaired) {
            console.log(`[node-pty-exec-bit] chmod +x ${path.relative(repoRootDefault, helper)}  (kelpi#36)`);
        }
    }
}
