#!/usr/bin/env node
/**
 * Impact-mapped verification: run exactly the checks the diff needs.
 *
 * The full battery (typecheck + ~6000 tests + five smokes + repackage + the 15.6-minute
 * audit) is the right gate for a handoff and the wrong tax for a one-column tweak. This
 * script reads the diff, maps each changed file to the audit steps and test dirs that cover
 * its surface, and runs precisely those. Files on SHARED surfaces (daemon core, protocol,
 * the shell, tokens/styles, the vendored engine) escalate to the full battery, because their
 * blast radius is the whole app — the tier is chosen by the diff, not by optimism.
 *
 *   node scripts/verify.mjs                # verify uncommitted changes (diff vs HEAD)
 *   node scripts/verify.mjs --since <ref>  # verify everything since a ref
 *   node scripts/verify.mjs --full         # the full battery, regardless of the diff
 *   node scripts/verify.mjs --plan         # print what would run, run nothing
 *
 * `self-upgrade.mjs` runs `--full` as its precondition: a promote cannot skip the battery.
 *
 * THE MAP IS MAINTAINED, NOT INFERRED. When a new audit step lands, add it to the surface
 * that owns it; when a new source dir appears, map it or it escalates by default (unmapped
 * source = full battery, so forgetting the map costs time, never coverage).
 */

import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};

// ── the surface map ─────────────────────────────────────────────────────────────────
// prefix → { tests: vitest paths, steps: audit step ids, smokes: shell-package scripts }
// A `null` entry means ESCALATE: the surface is shared and the diff gets the full battery.

const SURFACES = [
    // Pure documentation never needs a run.
    { prefix: 'docs/', skip: true },
    { prefix: 'README', skip: true },

    // The harness itself: judged by its own diff discipline, not by product steps. Run the
    // steps you changed by hand; verify.mjs only warns.
    { prefix: 'scripts/ui-audit/', harness: true },
    { prefix: 'scripts/', harness: true },

    {
        prefix: 'packages/client/src/settings/',
        tests: ['packages/client/src/settings'],
        steps: [
            'settings-open', 'settings-close', 'keybinding-record', 'keybinding-conflict',
            'appearance-preset-theme', 'appearance-ghostty-write', 'appearance-system-stats',
            'appearance-sidebar-tint', 'global-hotkey-record', 'settings-tcp-state',
            'settings-repositories', 'settings-live-apply', 'labels-design', 'repo-picker-multiselect'
        ]
    },
    {
        prefix: 'packages/client/src/webpane/',
        tests: ['packages/client/src/webpane'],
        steps: [
            'web-pane', 'web-find', 'web-url-bar-shortcut', 'web-batch-pickup', 'web-batch-internals',
            'web-tab-strip', 'web-loading-strip', 'web-focus-handoff', 'web-page-click-focus',
            'web-favourite', 'web-cookie-panel', 'web-console-frames', 'web-popup-layering',
            // Issue #12's timing half: the poster swap, sampled per frame. Its deeper
            // counterpart is `scripts/ui-audit/poster-swap-flicker.mjs`, run outside a battery.
            'poster-swap'
        ],
        smokes: ['smoke:web']
    },
    {
        prefix: 'packages/client/src/grid/',
        tests: ['packages/client/src/grid'],
        steps: [
            'fresh-boot', 'split-keybinding', 'keybinding-blast-radius', 'divider-drag',
            'layout-nested-divider', 'close-pane', 'tidy-grid', 'pane-header-details',
            'pane-context-menu', 'terminal-search', 'search-colors', 'panel-slide-flash',
            'cmd-click-path', 'reopen-closed-pane'
        ]
    },
    {
        prefix: 'packages/client/src/terminal/',
        tests: ['packages/client/src/terminal'],
        steps: [
            'terminal-ls', 'terminal-long-line', 'terminal-full-width', 'terminal-glyphs',
            'terminal-nerdfont-prompt', 'terminal-size-matrix', 'terminal-resize-storm',
            'terminal-input-matrix', 'terminal-ime', 'terminal-cursor-focus', 'terminal-osc52',
            'terminal-host-edges', 'terminal-kitty', 'pane-title-osc', 'capture-parity',
            'terminal-drop-and-paste', 'cmd-click-path'
        ],
        smokes: ['smoke:terminal']
    },
    {
        prefix: 'packages/client/src/chrome/',
        tests: ['packages/client/src/chrome'],
        steps: [
            'workspace-create-ui', 'workspace-create-cli', 'workspace-create-full',
            'workspace-create-worktree', 'workspace-rename-context', 'workspace-switch',
            'workspace-edges', 'bulk-workspace-ops', 'sidebar-resize', 'sidebar-ring-clearance',
            'sidebar-drag-nest-preview', 'sidebar-row-submenus', 'sidebar-drag-affordances',
            'sidebar-spring', 'sidebar-escape-clears-selection', 'sidebar-remaining',
            'panel-slide-flash', 'status-popover', 'footer-git-stats', 'repo-registry',
            'inspector-open', 'inspector-repo-status', 'inspector-worktree-create',
            'graft-toggle', 'graft-swap-prompt', 'graft-orphan-banner', 'repo-autodetect',
            'pane-branch-chain', 'help-overlay', 'titlebar-menu', 'mac-chrome', 'debug-menu',
            'repo-picker-multiselect', 'search-colors', 'last-pane-close-deletes-workspace'
        ]
    },
    {
        prefix: 'packages/client/src/content/',
        tests: ['packages/client/src/content'],
        steps: [
            'markdown-pane', 'markdown-edit-toggle', 'content-gutter-window', 'markdown-copy-header',
            'diff-pane', 'content-pane-keybindings', 'scratchpad-create', 'drop-markdown',
            'external-editor', 'open-file-dialog', 'open-relative-path', 'cmd-click-path'
        ]
    },
    {
        prefix: 'packages/client/src/app/',
        tests: ['packages/client/src'],
        steps: [
            'web-page-click-focus', 'web-focus-handoff', 'terminal-cursor-focus', 'agent-lifecycle',
            'reattach-after-relaunch', 'content-pane-keybindings', 'scratchpad-create'
        ]
    },
    {
        prefix: 'packages/daemon/src/term/',
        tests: ['packages/daemon/src/term'],
        steps: [
            'terminal-ls', 'terminal-size-matrix', 'terminal-resize-storm', 'terminal-search',
            'capture-parity', 'cmd-click-path', 'terminal-host-edges', 'reattach-after-relaunch'
        ],
        smokes: ['smoke:terminal']
    },
    {
        prefix: 'packages/daemon/src/content/',
        tests: ['packages/daemon/src/content'],
        steps: [
            'markdown-pane', 'markdown-edit-toggle', 'markdown-copy-header', 'diff-pane',
            'content-gutter-window', 'drop-markdown', 'open-relative-path'
        ]
    },
    {
        prefix: 'packages/daemon/src/webpane/',
        tests: ['packages/daemon/src/webpane'],
        steps: ['web-pane', 'web-find', 'web-tab-strip', 'web-popup-layering', 'web-focus-handoff'],
        smokes: ['smoke:web']
    },

    // Shared surfaces: full battery, no exceptions. The comments say why.
    { prefix: 'packages/client/src/styles.css', escalate: 'the unlayered/base CSS reaches every control (S1)' },
    { prefix: 'packages/client/src/connection/', escalate: 'every byte of every stream crosses it' },
    { prefix: 'packages/client/src/App.tsx', escalate: 'the composition root wires every surface' },
    { prefix: 'packages/client/', escalate: 'unmapped client area' },
    { prefix: 'packages/daemon/', escalate: 'daemon core (handlers/boot/ws/store/control)' },
    { prefix: 'packages/core/', escalate: 'shared layout/env/agent logic' },
    { prefix: 'packages/protocol/', escalate: 'the wire itself' },
    { prefix: 'packages/cli/', escalate: 'the CLI every hook and agent runs' },
    { prefix: 'packages/shell/', escalate: 'the main process: windows, focus, layering' },
    { prefix: 'vendor/', escalate: 'the vendored terminal engine' }
];

// ── the diff ────────────────────────────────────────────────────────────────────────

const since = value('--since');
const diffCmd = since ? `git diff --name-only ${since}` : 'git diff --name-only HEAD';
const changed = has('--full')
    ? []
    : execSync(diffCmd, { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

const plan = { tests: new Set(), steps: new Set(), smokes: new Set(), escalations: [], harness: [], skipped: [] };
for (const file of changed) {
    const surface = SURFACES.find((entry) => file.startsWith(entry.prefix));
    if (surface === undefined) {
        plan.escalations.push(`${file} (no surface mapping — unmapped source escalates)`);
    } else if (surface.skip) {
        plan.skipped.push(file);
    } else if (surface.harness) {
        plan.harness.push(file);
    } else if (surface.escalate) {
        plan.escalations.push(`${file} (${surface.escalate})`);
    } else {
        for (const test of surface.tests ?? []) plan.tests.add(test);
        for (const step of surface.steps ?? []) plan.steps.add(step);
        for (const smoke of surface.smokes ?? []) plan.smokes.add(smoke);
    }
}

const full = has('--full') || plan.escalations.length > 0;
const log = (line) => console.log(`[verify] ${line}`);

if (changed.length === 0 && !has('--full')) {
    log('no uncommitted changes — nothing to verify (use --since <ref> or --full).');
    process.exit(0);
}

log(full ? 'tier: FULL BATTERY' : 'tier: impact-scoped');
if (plan.escalations.length > 0) for (const reason of plan.escalations) log(`  escalated by: ${reason}`);
if (plan.harness.length > 0) {
    log('  harness files changed — verify.mjs does not judge harness diffs; run the changed');
    log('  steps yourself and diff the assertions per the campaign discipline:');
    for (const file of plan.harness) log(`    ${file}`);
}
if (!full) {
    log(`  tests: ${[...plan.tests].join(', ') || '(none)'}`);
    log(`  steps: ${[...plan.steps].join(', ') || '(none)'}`);
    log(`  smokes: ${[...plan.smokes].join(', ') || '(none)'}`);
}
if (has('--plan')) process.exit(0);

// ── run ─────────────────────────────────────────────────────────────────────────────

const run = (label, command, options = {}) => {
    log(`▶ ${label}`);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...options.env };
    // A battery launched from inside a Kelpi pane inherits that pane's injected route to the
    // LIVE daemon (KELPI_SOCKET, and NEX_SOCKET under the old name). No battery child may
    // carry it: anything that legitimately talks to a daemon pins its own sandbox route, and
    // an inherited pane route would satisfy KELPI_REQUIRE_SOCKET while addressing the real
    // instance — the one hole the guard cannot see.
    delete env.KELPI_SOCKET;
    delete env.NEX_SOCKET;
    const result = spawnSync('sh', ['-c', command], {
        cwd: options.cwd ?? repoRoot,
        stdio: 'inherit',
        env
    });
    if (result.status !== 0) {
        log(`✗ ${label} FAILED`);
        process.exit(result.status ?? 1);
    }
};

/**
 * For every battery component that drives a daemon (the audit and the smokes): any `kelpi`
 * invocation whose sandbox route env is missing or stale must FAIL, never fall back to the
 * live daemon's /tmp/kelpi.sock. The 2026-08-31 promote wiped the running instance's
 * workspaces exactly that way — the audit's CLI still exported the pre-rename NEX_SOCKET,
 * the resolver saw nothing, and the mac-chrome step's delete-every-workspace clause ran
 * against the real daemon. Unit tests do not get this (they must control their own env).
 */
const SANDBOX_GUARD = { KELPI_REQUIRE_SOCKET: '1' };

const started = Date.now();
run('typecheck', 'pnpm typecheck');

// The half of the wire-spec conformance guard that needs `docs/`. It cannot live in the test
// suite: `docs/` is gitignored, and a test that reads it fails in every fresh worktree (which is
// how it used to behave). The other half, snapshot vs TypeScript, runs in `pnpm test` everywhere.
// This step no-ops with a printed line when the doc is absent, so it is never a silent pass.
run('wire spec snapshot', 'node packages/protocol/scripts/snapshot-wire-spec.mjs --check');

if (full) {
    run('root tests', 'npx vitest run');
    run('shell tests', 'pnpm --filter @kelpi/shell test');
    run('full audit', 'node scripts/ui-audit/audit.mjs --out docs/audit/verify-latest', { env: SANDBOX_GUARD });
    run('packaged smoke (repackages + 61 checks)', 'pnpm run smoke:packaged', {
        cwd: path.join(repoRoot, 'packages', 'shell'),
        env: SANDBOX_GUARD
    });
} else {
    if (plan.tests.size > 0) run('scoped tests', `npx vitest run ${[...plan.tests].join(' ')}`);
    if (plan.steps.size > 0) {
        run('scoped audit', `node scripts/ui-audit/audit.mjs --only ${[...plan.steps].join(',')} --out docs/audit/verify-latest`, { env: SANDBOX_GUARD });
    }
    for (const smoke of plan.smokes) {
        run(smoke, `pnpm run ${smoke}`, { cwd: path.join(repoRoot, 'packages', 'shell'), env: SANDBOX_GUARD });
    }
}

log(`✓ verification passed in ${((Date.now() - started) / 60000).toFixed(1)} min (${full ? 'full' : 'scoped'})`);
