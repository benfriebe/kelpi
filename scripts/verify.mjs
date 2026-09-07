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
 *   node scripts/verify.mjs --no-scenario "<reason>"   # ship a UI change with no scenario, on the record
 *
 * `self-upgrade.mjs` runs `--full` as its precondition: a promote cannot skip the battery.
 *
 * THE MAP IS MAINTAINED, NOT INFERRED. When a new audit step lands, add it to the surface
 * that owns it; when a new source dir appears, map it or it escalates by default (unmapped
 * source = full battery, so forgetting the map costs time, never coverage).
 *
 * THE SCENARIO RULE (#65's README, enforced here). A change to a UI surface ships with a scenario
 * (or an audit step) that exercises it against the real app, and this script runs it. The rule
 * used to be social and it did not hold: #47, #53 and #55 were each fixed with unit tests alone
 * and each shipped broken, because a unit test pins the reducer and never presses the key. The
 * decision lives in `ui-audit/lib/verify-plan.mjs` (pure, unit-tested); this file supplies it the
 * diff and what is on disk, then runs what it selected. `--no-scenario "<reason>"` is the only way
 * past, and it is printed and written to the report rather than being a quiet no-op.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildAll } from './ui-audit/lib/stack.mjs';
import { SCENARIO_PREFIX, planScenarios } from './ui-audit/lib/verify-plan.mjs';

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
//
// The map is also what the scenario rule reads to answer "is this file UI?", and it answers it
// from two entries only: `skip` (documentation) and `harness` (this tooling) are never UI, and
// everything else falls through to `verify-plan.mjs` ▸ UI_PREFIXES, which is the client's and the
// shell's whole source tree. An entry may add `ui: true` to claim a path outside those two trees.

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
            'repo-picker-multiselect', 'search-colors', 'last-pane-close-deletes-workspace',
            // `chrome/form-factor.ts` is the phone program's one decision, and the live step is
            // the only thing that can prove its media query against a real browser.
            'phone-form-factor'
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
    /*
     * The phone program's two new client areas (docs/MOBILE-PLAN.md). Both directories are
     * created by later lanes - `phone/` by B1, `pwa/` by A1/A2 - and they are mapped HERE, before
     * they exist, on purpose: an unmapped source dir escalates to the full battery, so the map
     * has to lead the code or the first phone PR pays a 20-minute tax for a file nothing else
     * reaches. Both surfaces are additive and gated on the form factor, so the steps that cover
     * them are the phone lane's, not the desktop suite's.
     */
    {
        prefix: 'packages/client/src/phone/',
        tests: ['packages/client/src/phone'],
        steps: ['phone-form-factor']
    },
    {
        prefix: 'packages/client/src/pwa/',
        tests: ['packages/client/src/pwa'],
        // No audit step yet: A1's manifest builder is covered by its own unit tests, and the
        // daemon serves the files it emits, so `smoke:web` is its live gate. Add the PWA steps
        // here (phone-pwa-shell, A2) when they land.
        smokes: ['smoke:web']
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

// ── the scenario rule ───────────────────────────────────────────────────────────────

// `covers` is read from the module itself rather than parsed out of the text: a declaration that
// only a regex can see is one a rename silently breaks. Importing a scenario is safe by contract
// (a scenario is a default-exported function and nothing else runs at module scope), and a broken
// one is reported instead of taking the whole run down with it.
const scenariosDir = path.join(repoRoot, 'scripts', 'scenarios');
const scenarios = [];
for (const base of fs.existsSync(scenariosDir) ? fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.mjs')).sort() : []) {
    const entry = { name: base.replace(/\.mjs$/, ''), file: `${SCENARIO_PREFIX}${base}`, covers: [] };
    try {
        const mod = await import(pathToFileURL(path.join(scenariosDir, base)).href);
        if (Array.isArray(mod.covers)) entry.covers = mod.covers;
    } catch (error) {
        log(`  warning: ${entry.file} could not be read for its \`covers\` export: ${String(error?.message ?? error)}`);
    }
    scenarios.push(entry);
}

// `git diff` cannot see an untracked file, so a brand-new scenario written beside the fix it
// proves is invisible to the diff above. Without this the rule would refuse hardest exactly when
// it was obeyed best.
const untrackedScenarios = execSync(`git ls-files --others --exclude-standard -- ${SCENARIO_PREFIX}`, {
    cwd: repoRoot,
    encoding: 'utf8'
})
    .trim()
    .split('\n')
    .filter((file) => file.endsWith('.mjs'));

if (has('--no-scenario') && (value('--no-scenario') === undefined || value('--no-scenario').startsWith('--'))) {
    log('--no-scenario needs a reason: node scripts/verify.mjs --no-scenario "why this cannot be exercised"');
    process.exit(2);
}
const rule = planScenarios({
    changed,
    changedScenarioFiles: [
        ...new Set([...changed.filter((f) => f.startsWith(SCENARIO_PREFIX) && f.endsWith('.mjs')), ...untrackedScenarios])
    ],
    scenarios,
    surfaces: SURFACES,
    noScenario: value('--no-scenario') ?? null
});

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
    log(`  scenarios: ${rule.run.join(', ') || '(none)'}`);
    // Why each one was selected, so "it ran something I did not write" is never a mystery: a
    // scenario the diff edited, or one whose `covers` claims a file the diff touched.
    for (const [file, names] of Object.entries(rule.coverage)) log(`    covered: ${file} → ${names.join(', ')}`);
} else {
    log('  scenarios: all of them (the full battery runs scripts/scenarios/ end to end)');
}
// How the rule was satisfied, kept in two separate sentences because they are different claims: a
// `covers` declaration says WHICH scenario presses which file, while a scenario or audit step the
// diff writes discharges the rule for the whole diff without naming anything. Collapsing them into
// one "exercised by" list would let the weaker claim borrow the stronger one's words.
if (rule.uiFiles.length > 0 && rule.ok && rule.optOut === null) {
    if (rule.uncovered.length === 0) {
        log('  every changed UI file is covered by a scenario (above)');
    } else {
        log(`  rule satisfied by what this diff writes: ${[...rule.changedScenarios, ...rule.changedAuditFiles].join(', ')}`);
        for (const file of rule.uncovered) log(`    no \`covers\` declaration names: ${file}`);
    }
}
// Never a quiet skip: the opt-out is louder than the check it replaces, and it goes in the report.
if (rule.optOut !== null && rule.uiFiles.length > 0) {
    log('  ⚠ --no-scenario: this UI change ships WITHOUT a scenario exercising it.');
    log(`    reason: ${rule.optOut.reason}`);
    for (const file of rule.uncovered) log(`    not exercised: ${file}`);
}

/**
 * The record of what this run decided, beside the audit's own output. It exists so an opt-out is
 * auditable after the fact: "which promote shipped a UI change with no scenario, and what did the
 * person say?" has to be answerable from disk, not from a terminal that has scrolled away.
 * `docs/audit/` is gitignored, so this never appears in a diff.
 */
const reportDir = path.join(repoRoot, 'docs', 'audit', 'verify-latest');
const writeReport = (extra) => {
    if (has('--plan')) return; // --plan runs nothing and writes nothing.
    try {
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(
            path.join(reportDir, 'verify-report.json'),
            `${JSON.stringify(
                {
                    at: new Date().toISOString(),
                    tier: full ? 'full' : 'scoped',
                    changed,
                    scenarioRule: {
                        uiFiles: rule.uiFiles,
                        uncovered: rule.uncovered,
                        coverage: rule.coverage,
                        scenariosRun: full ? 'all' : rule.run,
                        noScenario: rule.optOut
                    },
                    ...extra
                },
                null,
                2
            )}\n`
        );
    } catch {
        // The report is evidence, not a gate: never fail a run because a directory would not write.
    }
};

if (!rule.ok) {
    log(`✗ ${rule.message}`);
    writeReport({ outcome: 'refused', refusal: 'scenario-rule' });
    process.exit(1);
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
        // Before exiting, so the report on disk describes the run that actually happened. Without
        // this the last file written would be a previous run's "passed", which is worse than no
        // file at all: it is evidence that says the opposite of the truth.
        writeReport({ outcome: 'failed', failedStep: label });
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

/**
 * `--window hidden` for every scenario a battery runs, always (#66). The functional lane keeps the
 * machine's screen for its owner and lets runs overlap, and it costs a scenario nothing: the
 * assertions are DOM state, CDP input, the CLI, the harness channel and the app's own activity
 * signalling, all of which behave identically there. What it does cost is the screenshots, which
 * come back blank; that is why pixel checks live in the audit, which still opens a real window.
 * ui-audit/README.md ▸ "The functional lane" has the measurements.
 */
const SCENARIO_LANE = '--no-build --window hidden';

/**
 * Bundles, once, before anything drives a real app. Both the scenario step and the audit below run
 * `--no-build` so four `pnpm build`s do not race the same `dist/` trees; that is only honest if
 * SOMETHING built them, and `dist/` is gitignored, so on a fresh clone nothing has. `buildAll` is
 * content-hashed per bundle (ui-audit/lib/build-cache.mjs): ~2.5 s cold, ~0.05 s when the tree has
 * not moved, so paying it here costs a warm run nothing and saves a cold one from driving a stale
 * or absent client.
 */
let built = false;
const buildBundles = async () => {
    if (built) return;
    log('▶ build bundles (content-hashed; a no-op when the tree has not moved)');
    try {
        await buildAll(repoRoot, { log: (line) => log(`  ${line}`) });
    } catch (error) {
        log(`✗ build bundles FAILED: ${String(error?.message ?? error)}`);
        writeReport({ outcome: 'failed', failedStep: 'build bundles' });
        process.exit(1);
    }
    built = true;
};

const started = Date.now();
run('typecheck', 'pnpm typecheck');

if (full) {
    run('root tests', 'npx vitest run');
    run('shell tests', 'pnpm --filter @kelpi/shell test');
    // Every scenario, before the audit and without the screen. The promote gate is the one place
    // that must not select: `self-upgrade.mjs` runs `--full`, so this is what stops #47/#53/#55
    // from recurring on a tree where nobody's diff happened to touch the scenario that guards them.
    await buildBundles();
    run(`scenarios (all, ${SCENARIO_LANE})`, `node scripts/scenario.mjs ${SCENARIO_LANE}`, { env: SANDBOX_GUARD });
    run('full audit', 'node scripts/ui-audit/audit.mjs --out docs/audit/verify-latest', { env: SANDBOX_GUARD });
    run('packaged smoke (repackages + 61 checks)', 'pnpm run smoke:packaged', {
        cwd: path.join(repoRoot, 'packages', 'shell'),
        env: SANDBOX_GUARD
    });
} else {
    if (plan.tests.size > 0) run('scoped tests', `npx vitest run ${[...plan.tests].join(' ')}`);
    // Before the audit, mirroring the full tier's order: a scenario run is seconds and a scoped
    // audit is minutes, so the cheap check that was written FOR this change reports first.
    if (rule.run.length > 0) {
        await buildBundles();
        run(`scenarios: ${rule.run.join(', ')}`, `node scripts/scenario.mjs ${SCENARIO_LANE} ${rule.run.join(' ')}`, {
            env: SANDBOX_GUARD
        });
    }
    if (plan.steps.size > 0) {
        // No `buildBundles()` here: the audit runs its own (identical, content-hashed) `buildAll`
        // unless told `--no-build`, and it is not told that.
        run('scoped audit', `node scripts/ui-audit/audit.mjs --only ${[...plan.steps].join(',')} --out docs/audit/verify-latest`, { env: SANDBOX_GUARD });
    }
    for (const smoke of plan.smokes) {
        run(smoke, `pnpm run ${smoke}`, { cwd: path.join(repoRoot, 'packages', 'shell'), env: SANDBOX_GUARD });
    }
}

writeReport({ outcome: 'passed', minutes: Number(((Date.now() - started) / 60000).toFixed(2)) });
log(`✓ verification passed in ${((Date.now() - started) / 60000).toFixed(1)} min (${full ? 'full' : 'scoped'})`);
if (rule.optOut !== null && rule.uiFiles.length > 0) {
    // Last line of the run, not just the first: the opt-out has to survive a long scrollback.
    log(`  ⚠ shipped with --no-scenario: ${rule.optOut.reason}`);
}
