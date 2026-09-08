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
 * THE BATTERY RUNS TO THE END AND RETRIES ONCE (#109). Every component runs, whatever the one
 * before it did, and the run finishes with a table of what each component cost and how it ended.
 * A red vitest component re-runs only the FILES it failed on, a red scenario lane re-runs only
 * the SCENARIOS it failed, and the packaged smoke re-runs itself, each exactly once and each on
 * its own, off the load the rest of the battery was making; green on that retry passes the
 * component, and the summary says which ones needed it. Red on the retry fails the battery and
 * names the check. The rules and the four promotes that bought them are in `ui-audit/lib/battery.mjs`.
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

import {
    failedScenariosFromResults,
    failedTestFilesFromVitestJson,
    formatBatterySummary,
    runBattery
} from './ui-audit/lib/battery.mjs';
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
            'settings-repositories', 'settings-live-apply', 'labels-design', 'repo-picker-multiselect',
            // B5's phone sheet lives in `SettingsOverlay.tsx` beside the desktop dialog, and the
            // two share every tab component below it, so a change here can move either. The
            // desktop steps above are what pin that it moved neither.
            'phone-settings-sheet'
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
        /*
         * C7 put `chrome/keyboard-viewport.ts` on the other side of `terminal/testing.ts`'s fake
         * phone window: it is the one fake with a keyboard animation, a visual-viewport scroll
         * and a `scrollTo` to refuse, so the chrome module is driven through it. A change here
         * therefore reaches the chrome suite as well as this one, the same way `phone/testing.ts`
         * reaches the settings and chrome suites below.
         */
        tests: ['packages/client/src/terminal', 'packages/client/src/chrome'],
        steps: [
            'terminal-ls', 'terminal-long-line', 'terminal-full-width', 'terminal-glyphs',
            'terminal-nerdfont-prompt', 'terminal-size-matrix', 'terminal-resize-storm',
            'terminal-input-matrix', 'terminal-ime', 'terminal-cursor-focus', 'terminal-osc52',
            'terminal-host-edges', 'terminal-kitty', 'pane-title-osc', 'capture-parity',
            'terminal-drop-and-paste', 'cmd-click-path',
            // C2's software-keyboard layout lives in `terminal/keyboard-inset.ts` and reaches the
            // daemon through the pane's own resize path, so a change here can move the rows a PTY
            // is told about on a phone. C1's key bar, C4's Paste and C3's touch gestures live in
            // this directory too and mount inside `TerminalPane`, so a change here can move them;
            // their steps are the only place a real touch on a real 44px key reaches a real PTY,
            // the only place the bar's Paste is measured against the engine's own bracketed-paste
            // envelope, and the only place a real drag on a real canvas moves a viewport
            // (docs/MOBILE-PLAN.md §4). C5's `phone-caret-owner` is here for the same reason and
            // one step further on: the pane's ONE claim on the caret lives in `TerminalPane.tsx`
            // (`claimCaret`), and on a phone that claim IS the software keyboard, so a change in
            // this directory can summon a keyboard nobody asked for. C9's `phone-key-bar-split`
            // joins them: the bar is one per WINDOW now (`terminal/PhoneKeyBar.tsx`, which also
            // owns the software keyboard's inset for the whole content area), it finds its
            // terminal through `terminal/pane-registry.ts`, and a split grid is the only place
            // "one bar across the bottom" can be told apart from "a bar inside the active pane".
            // All six are the phone lane's; the desktop terminal steps above are what pin that
            // none of them moved anything anywhere else.
            'phone-keyboard-inset', 'phone-key-bar', 'phone-paste', 'phone-touch-scroll', 'phone-caret-owner',
            'phone-key-bar-split'
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
            'phone-form-factor',
            // C7's `chrome/keyboard-viewport.ts` decides what a software keyboard did to the two
            // viewports and keeps the app at the top of its own window; the keyboard step is
            // where its mode detection meets a real layout and a real `visualViewport`.
            'phone-keyboard-inset',
            // B5's phone sheet lives in `chrome/CommandPalette.tsx` beside the desktop card, and
            // where a field sits relative to a software keyboard is a layout-engine fact.
            'phone-palette-sheet',
            // C9: `chrome/form-factor.ts` is what decides whether the window has a key bar at all,
            // and the split step is where the bar's own box is measured against the content row.
            'phone-key-bar-split'
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
            'reattach-after-relaunch', 'content-pane-keybindings', 'scratchpad-create',
            // C5: `app/pane-focus.ts` holds `mayClaimPaneCaret`, the one seam that decides whether
            // the client may move the caret onto a pane surface without being asked - and on a
            // phone that decision is whether a software keyboard comes up. The step is the phone
            // lane's; the desktop focus steps above are what pin that its desktop answer is
            // unchanged (docs/MOBILE-PLAN.md §4 C5).
            'phone-caret-owner'
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
        /*
         * B5 put `phone/testing.ts` here - the fake phone window both of its sheets are driven
         * through - so a change to this directory reaches the `settings/` and `chrome/` suites as
         * well as its own, and the two sheet steps with them. That is why the lists below are
         * wider than "the phone directory's own tests".
         */
        tests: ['packages/client/src/phone', 'packages/client/src/settings', 'packages/client/src/chrome'],
        steps: ['phone-form-factor', 'phone-settings-sheet', 'phone-palette-sheet', 'phone-shell']
    },
    {
        prefix: 'packages/client/src/pwa/',
        tests: ['packages/client/src/pwa'],
        // No audit step yet: A1's manifest builder is covered by its own unit tests, and the
        // daemon serves the files it emits, so `smoke:web` is its live gate. Add the PWA steps
        // here (phone-pwa-shell, A2) when they land.
        smokes: ['smoke:web', 'smoke:pwa']
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

/**
 * Spawn one command and hand back its status. It does NOT exit: what a nonzero status means is
 * the battery runner's decision now (`ui-audit/lib/battery.mjs` has the two rules and the four
 * dead promotes that bought them), because a check that is red under the battery's own load and
 * green on its own must not end the run.
 */
const spawn = (command, options = {}) => {
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
    return result.status ?? 1;
};

/** Single-quote a path for `sh -c`: a worktree can live under a directory with a space in it. */
const q = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
const rel = (file) => path.relative(repoRoot, file) || file;
const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        // A missing or half-written report is not a crash: the caller reads "nothing to retry"
        // out of it, which is the honest answer when the reporter never got to write.
        return null;
    }
};

/**
 * Where the battery's own machine-readable evidence goes: the vitest JSON reports it parses the
 * failed files out of, and the scenario lane's `results.json`. Under `docs/audit/`, which is
 * gitignored, beside the verify report that cites it.
 */
const batteryDir = path.join(reportDir, 'battery');
// Emptied first, every run. A stale report here would be worse than none: if this run's vitest
// died before its reporter wrote, the retry would read the PREVIOUS run's failed files and
// re-run somebody else's flake instead of failing honestly.
fs.rmSync(batteryDir, { recursive: true, force: true });
fs.mkdirSync(batteryDir, { recursive: true });
const artifact = (name) => path.join(batteryDir, `${name.replace(/[^a-z0-9-]+/gi, '-')}.json`);

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
const buildBundlesComponent = {
    label: 'build bundles',
    // Not a check: the three components after it DRIVE what it produces, so a red build makes
    // their verdicts meaningless rather than merely unknown. `battery.mjs` marks the rest "not run".
    precondition: true,
    run: async () => {
        log('  (content-hashed; a no-op when the tree has not moved)');
        try {
            await buildAll(repoRoot, { log: (line) => log(`  ${line}`) });
            return { ok: true };
        } catch (error) {
            return { ok: false, detail: String(error?.message ?? error) };
        }
    }
};

/**
 * The battery's vitest worker cap, and the one reason it exists.
 *
 * WHERE THE LOAD COMES FROM, which is not what it looks like. Unset, vitest sizes its pool at
 * the core count (16 here), but the run queue the root suite makes is far bigger than 16: every
 * daemon a test boots builds an editor resolver (`boot/compose.ts` ▸ `content/external-editor.ts`,
 * CONT-082/084), and that resolver asks the user's LOGIN SHELL, so each boot forks a full
 * `zsh -l -i -c`. Sampled once a second, an uncapped root suite has up to 59 of those alive at
 * once and puts 84 to 92 processes on a 16-core run queue. That is the weather the four dead
 * promotes failed in: `App.filemenu.test.tsx` went red at load 37 and two daemon tests at load
 * 90, all green in isolation seconds later. A battery that makes its own flakes is not measuring
 * the tree.
 *
 * Measured on this 16-core machine, root suite (6338 tests), two passes per cap, machine idle
 * before each pass (run queue 2 to 8, 1-minute load 12 to 14):
 *
 *   cap        wall           peak run queue   peak 1-min load   peak login-shell probes
 *   default    27.6, 27.6 s   84, 92           23.6, 28.6        59, 32
 *   8          29.5, 29.1 s   43, 37           22.2, 18.0        35, 35
 *   4          48.0, 47.5 s   57, 185*         16.8, 15.9        32, 24
 *   (* a neighbouring agent's battery landed inside that pass; its sibling read 57.)
 *
 * Eight is the knee: it halves the run queue for 1.7 s, which is 6% of the suite and 0.14% of a
 * 20-minute battery, while four costs a further 18 s (a 73% longer suite) to buy a reduction the
 * battery does not need. The cap lives on the battery's own commands rather than in
 * `vitest.config.ts` because a person running `npx vitest run` by hand wants every core: it is
 * the BATTERY's concurrency that is the hazard, since it is what runs beside a scenario lane, an
 * Electron audit and a packaged smoke.
 */
const VITEST_MAX_WORKERS = 8;

/**
 * A vitest component: run the suite, and if it goes red, re-run ONLY the files it failed on.
 *
 * The failed files come from vitest's own `--reporter=json` report (parsed, never scraped from
 * the terminal), and the default reporter still prints beside it so a watching human sees the
 * run they always saw. `filters` is what the first run is scoped to (nothing for the full tier,
 * the plan's dirs for the scoped one); the retry is scoped to the failed files instead.
 */
const vitestComponent = (label, command, { filters = [], cwd } = {}) => ({
    label,
    run: () => {
        const report = artifact(label);
        const flags = `--maxWorkers=${String(VITEST_MAX_WORKERS)} --reporter=default --reporter=json --outputFile.json=${q(report)}`;
        const status = spawn([command, ...filters, flags].join(' '), { cwd });
        if (status === 0) return { ok: true };

        const failedFiles = failedTestFilesFromVitestJson(readJson(report));
        if (failedFiles.length === 0) {
            // A nonzero status with no failed file named is a crash, a config error or a killed
            // worker. There is nothing an isolated re-run could tell us, so it is not retried and
            // it is not excused.
            return { ok: false, detail: `exit ${String(status)} with no failed test file named in ${rel(report)} (a crash, a config error or a killed worker)` };
        }
        return {
            ok: false,
            retryOf: failedFiles.map(rel),
            retry: () => {
                const retryReport = artifact(`${label}-retry`);
                const retryFlags = `--maxWorkers=${String(VITEST_MAX_WORKERS)} --reporter=default --reporter=json --outputFile.json=${q(retryReport)}`;
                const retryStatus = spawn([command, ...failedFiles.map(q), retryFlags].join(' '), { cwd });
                if (retryStatus === 0) return { ok: true };
                const stillRed = failedTestFilesFromVitestJson(readJson(retryReport)).map(rel);
                return { ok: false, detail: `red alone as well: ${stillRed.join(', ') || failedFiles.map(rel).join(', ')}` };
            }
        };
    }
});

/**
 * The scenario lane: run it, and if it goes red, re-run ONLY the failed scenarios, one process
 * each, off the load the rest of the battery was making.
 *
 * The lane is given an explicit `--out` so the failed names can be read out of its own
 * `results.json` instead of parsed from its stdout, and each retry gets its own directory so the
 * first run's evidence (screenshots, notes, per-check results) survives the second.
 */
const scenarioComponent = (label, names) => ({
    label,
    run: () => {
        const out = path.join(batteryDir, 'scenarios');
        const status = spawn(`node scripts/scenario.mjs ${SCENARIO_LANE} --out ${q(out)} ${names.join(' ')}`.trim(), {
            env: SANDBOX_GUARD
        });
        if (status === 0) return { ok: true };

        const failedScenarios = failedScenariosFromResults(readJson(path.join(out, 'results.json')));
        if (failedScenarios.length === 0) {
            return { ok: false, detail: `exit ${String(status)} with no failed scenario named in ${rel(path.join(out, 'results.json'))} (the lane itself did not come up)` };
        }
        return {
            ok: false,
            retryOf: failedScenarios,
            retry: () => {
                const stillRed = [];
                for (const name of failedScenarios) {
                    const retryOut = path.join(batteryDir, `scenario-retry-${name}`);
                    // One process per scenario, so each gets its own sandbox and its own screen
                    // conditions. That is precisely the isolation a person performs by hand after
                    // a red lane, and it is what #109's three wobbles came back green under.
                    const retryStatus = spawn(`node scripts/scenario.mjs ${SCENARIO_LANE} --out ${q(retryOut)} ${name}`, {
                        env: SANDBOX_GUARD
                    });
                    if (retryStatus !== 0) stillRed.push(name);
                }
                return stillRed.length === 0 ? { ok: true } : { ok: false, detail: `red alone as well: ${stillRed.join(', ')}` };
            }
        };
    }
});

/** A whole-command component with no way to isolate a part of it: run it, retry it once, done. */
const retryWholeComponent = (label, command, options = {}) => ({
    label,
    run: () => {
        if (spawn(command, options) === 0) return { ok: true };
        return {
            ok: false,
            retryOf: ['the whole component (it has no per-check rerun)'],
            retry: () => (spawn(command, options) === 0 ? { ok: true } : { ok: false, detail: 'red both times' })
        };
    }
});

/** A component that is run once and judged once: no isolation is possible or wanted. */
const plainComponent = (label, command, options = {}) => ({
    label,
    run: () => ({ ok: spawn(command, options) === 0 })
});

const shellPackage = path.join(repoRoot, 'packages', 'shell');
const components = [plainComponent('typecheck', 'pnpm typecheck')];

if (full) {
    components.push(
        vitestComponent('root tests', 'npx vitest run'),
        vitestComponent('shell tests', 'pnpm --filter @kelpi/shell test'),
        // Every scenario, before the audit and without the screen. The promote gate is the one place
        // that must not select: `self-upgrade.mjs` runs `--full`, so this is what stops #47/#53/#55
        // from recurring on a tree where nobody's diff happened to touch the scenario that guards them.
        buildBundlesComponent,
        scenarioComponent(`scenarios (all, ${SCENARIO_LANE})`, []),
        // No retry, on purpose: the audit's exit status is not its verdict. It exits 0 with failed
        // assertions and 1 only when the harness itself broke, because the REPORT is the gate and
        // it is read with `compare-runs` against the previous one. Re-running it would cost 15
        // minutes to learn nothing the report has not already written down.
        plainComponent('full audit', 'node scripts/ui-audit/audit.mjs --out docs/audit/verify-latest', { env: SANDBOX_GUARD }),
        retryWholeComponent('packaged smoke (repackages + 61 checks)', 'pnpm run smoke:packaged', {
            cwd: shellPackage,
            env: SANDBOX_GUARD
        })
    );
} else {
    if (plan.tests.size > 0) components.push(vitestComponent('scoped tests', 'npx vitest run', { filters: [...plan.tests] }));
    // Before the audit, mirroring the full tier's order: a scenario run is seconds and a scoped
    // audit is minutes, so the cheap check that was written FOR this change reports first.
    if (rule.run.length > 0) {
        components.push(buildBundlesComponent, scenarioComponent(`scenarios: ${rule.run.join(', ')}`, rule.run));
    }
    if (plan.steps.size > 0) {
        // No `buildBundles()` here: the audit runs its own (identical, content-hashed) `buildAll`
        // unless told `--no-build`, and it is not told that.
        components.push(
            plainComponent('scoped audit', `node scripts/ui-audit/audit.mjs --only ${[...plan.steps].join(',')} --out docs/audit/verify-latest`, {
                env: SANDBOX_GUARD
            })
        );
    }
    for (const smoke of plan.smokes) {
        components.push(retryWholeComponent(smoke, `pnpm run ${smoke}`, { cwd: shellPackage, env: SANDBOX_GUARD }));
    }
}

const started = Date.now();
const battery = await runBattery({ components, log });

// The table is the point of running everything: one red battery now says which checks failed,
// which wobbled and came back green alone, and what each cost.
log('── battery summary ──────────────────────────────────────────────────────');
for (const line of formatBatterySummary(battery.records)) log(`  ${line}`);

const minutes = Number(((Date.now() - started) / 60000).toFixed(2));
if (!battery.ok) {
    writeReport({
        outcome: 'failed',
        minutes,
        // Kept under its old key so anything reading a previous report still finds the first red.
        failedStep: battery.failed[0].label,
        failedComponents: battery.failed.map((record) => record.label),
        components: battery.records
    });
    log(`✗ verification FAILED in ${minutes.toFixed(1)} min: ${battery.failed.map((record) => `${record.label} (${record.state})`).join(', ')}`);
    process.exit(1);
}

writeReport({ outcome: 'passed', minutes, components: battery.records });
const retried = battery.records.filter((record) => record.retried);
log(`✓ verification passed in ${minutes.toFixed(1)} min (${full ? 'full' : 'scoped'})`);
if (retried.length > 0) {
    // Never a quiet pass: a component that needed its retry is a check worth looking at, even
    // though it did not stop the run.
    log(`  ⚠ ${String(retried.length)} component(s) were red under the battery and green alone: ${retried.map((record) => `${record.label} [${(record.retryOf ?? []).join(', ')}]`).join('; ')}`);
}
if (rule.optOut !== null && rule.uiFiles.length > 0) {
    // Last line of the run, not just the first: the opt-out has to survive a long scrollback.
    log(`  ⚠ shipped with --no-scenario: ${rule.optOut.reason}`);
}
