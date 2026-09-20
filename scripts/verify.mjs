#!/usr/bin/env node
/** Strict acceptance gate. Diagnostic retries never erase first-attempt failure.
 * --since <ref> --acceptance <incident-manifest.json> binds the exact commit verdict.
 * --plan executes nothing and exits unverified (2); reports are unique and retained.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    CONSECUTIVE_LANE_FAILS,
    ORDERING_DEPENDENT,
    failedScenariosFromResults,
    failedTestFilesFromVitestJson,
    formatBatterySummary,
    readRetryHistory,
    recordRetryHistory,
    retryVerdicts,
    runBattery,
    scenarioObservations,
    writeRetryHistory
} from './ui-audit/lib/battery.mjs';
import { buildAll } from './ui-audit/lib/stack.mjs';
import { SCENARIO_PREFIX, planScenarios } from './ui-audit/lib/verify-plan.mjs';

import { startRun, snapshot, resolveRef, readArtifact, writeAcceptance, digest } from './ui-audit/lib/acceptance-io.mjs';
import { inspectResults, exitCode } from './ui-audit/lib/acceptance-results.mjs';
import { acceptanceVerdict } from './ui-audit/lib/acceptance-verdict.mjs';
import { captureSource, captureOutputs } from './ui-audit/lib/acceptance-provenance.mjs';
import { CANONICAL_ORDER, expandChains } from './ui-audit/lib/shards.mjs';
import { scenarioPlan, auditPlan } from './ui-audit/lib/incident-diagnostics-plan.mjs';
import { smokePlan } from './ui-audit/lib/smoke-plan.mjs';
import { assertionIdentities } from './ui-audit/lib/acceptance-selection.mjs';
import { executionRoots, captureExecutionRoots, observeExecutionRoots, executionRootErrors, targetWorkspaceLinkErrors, prepareTargetBuild } from './ui-audit/lib/execution-roots.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};
const { harnessRoot, targetRoot: repoRoot } = executionRoots({ targetRoot: value('--target-root') });

// ── the surface map ─────────────────────────────────────────────────────────────────
// prefix → { tests: vitest paths, steps: audit step ids, smokes: shell-package scripts }
// A `null` entry means ESCALATE: the surface is shared and the diff gets the full battery.
//
// The map is also what the scenario rule reads to answer "is this file UI?", and it answers it
// from two entries only: `skip` (documentation) and `harness` (this tooling) are never UI, and
// everything else falls through to `verify-plan.mjs` ▸ UI_PREFIXES, which is the client's and the
// shell's whole source tree. An entry may add `ui: true` to claim a path outside those two trees.

const SURFACES = [
    { prefix: 'vitest.config.ts', harness: true },
    // Pure documentation never needs a run.
    { prefix: 'docs/', skip: true },
    { prefix: 'README', skip: true },

    // Harness changes run registered targeted unit tests; product evidence remains explicit.
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
            // `phone-touch-mouse-reporting` is `phone-touch-scroll`'s other mode (#123): the
            // gesture machine and the mouse reporter both live in this directory, and which of
            // the two owns a contact is decided in `TerminalPane.tsx`. Only a live step can put
            // a real finger on a real canvas over an application that really asked for the
            // mouse, and the bytes it reads are the ones a TUI turns into a click.
            'phone-keyboard-inset', 'phone-key-bar', 'phone-paste', 'phone-touch-scroll',
            'phone-touch-mouse-reporting', 'phone-caret-owner',
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
        steps: ['phone-form-factor', 'phone-settings-sheet', 'phone-palette-sheet', 'phone-shell', 'phone-view-toggle', 'phone-landing']
    },
    /*
     * The window interaction surface (palette session + shared prompt requests). It is a shared
     * surface - every plugin `ui.show*` call and every palette gesture crosses it - but it is a
     * CONTRACT module, not an unmapped area: its own unit suite covers the request model, and the
     * two suites it replaced (`chrome/` for the palette, `plugins/` for the prompts) are what pin
     * that the bundled presenters still behave. The steps are the five gestures that reach it
     * through a real window: the phone's palette and settings sheets, a palette command with a
     * countable effect, and the two native modal peers it has to queue behind.
     */
    {
        prefix: 'packages/client/src/interaction/',
        tests: ['packages/client/src/interaction', 'packages/client/src/chrome', 'packages/client/src/plugins'],
        steps: ['phone-palette-sheet', 'phone-settings-sheet', 'scratchpad-create', 'help-overlay', 'titlebar-menu']
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
const reference = since === undefined ? null : resolveRef(repoRoot, since);
const gitOutput = (argv) => execFileSync('git', argv, { cwd: repoRoot, encoding: 'utf8' }).trim();
const changed = has('--full') ? [] : [...new Set([
    ...gitOutput(['diff', '--name-only', reference ?? 'HEAD', '--']).split('\n'),
    ...gitOutput(['ls-files', '--others', '--exclude-standard']).split('\n')
].filter(Boolean))];
const acceptedFlags = new Set(['--since', '--acceptance', '--no-scenario', '--full', '--plan', '--scenario-window', '--target-root', '--target-head', '--harness-head', '--out']);
for (let i = 0; i < args.length; i++) {
    if (!acceptedFlags.has(args[i])) throw new Error(`unsupported argument: ${args[i]}`);
    if (['--since', '--acceptance', '--no-scenario', '--scenario-window', '--target-root', '--target-head', '--harness-head', '--out'].includes(args[i])) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${args[i]} requires a value`);
        i++;
    }
}
const scenarioWindow = value('--scenario-window') ?? 'hidden';
if (!['hidden', 'onscreen'].includes(scenarioWindow)) throw new Error('--scenario-window must be hidden or onscreen');
const acceptanceRun = has('--plan') ? null : startRun(repoRoot, { args, reference, ...(value('--out') ? { outRoot: path.resolve(value('--out')) } : {}) });
const reportDir = acceptanceRun?.outDir;
const policyReasons = [];
let executionContext = null, executionContextReceipt = null, executionPreflightError = null;
if (has('--target-root') || has('--target-head') || has('--harness-head')) {
    if (acceptanceRun) acceptanceRun.schemaVersion = 2;
    try {
    executionContext = captureExecutionRoots({ targetRoot: repoRoot, harnessRoot, targetHead: value('--target-head'), harnessHead: value('--harness-head') });
    const links = targetWorkspaceLinkErrors(repoRoot);
    if (links.length) throw new Error(links.join('; '));
    if (acceptanceRun) {
        acceptanceRun.schemaVersion = 2;
        acceptanceRun.executionContext = executionContext;
        const contextPath = path.join(reportDir, 'execution-context.json');
        fs.writeFileSync(contextPath, `${JSON.stringify(executionContext, null, 2)}\n`, { flag: 'wx' });
        executionContextReceipt = { path: contextPath, sha256: digest(fs.readFileSync(contextPath)), kind: 'execution-context' };
        acceptanceRun.artifacts.push(executionContextReceipt);
        acceptanceRun.executionContextPath = contextPath;
    }
    } catch (error) { executionPreflightError = `external execution preflight: ${error.message}`; policyReasons.push(executionPreflightError); }
}
let incidentManifest = null;
if (value('--acceptance') && acceptanceRun) {
    const evidence = readArtifact(path.resolve(value('--acceptance')), acceptanceRun, { startedAt: 0, kind: 'incident-manifest' });
    incidentManifest = evidence.data;
    acceptanceRun.manifestPath = path.resolve(value('--acceptance'));
    if (evidence.error) policyReasons.push(`incident manifest: ${evidence.error}`);
}
const finish = (components = [], extraReasons = []) => {
    const end = snapshot(repoRoot);
    if (executionContext) {
        try { acceptanceRun.executionEnd = observeExecutionRoots(executionContext); }
        catch (error) { extraReasons.push(`execution sources: ${error.message}`); }
        extraReasons.push(...executionRootErrors(executionContext, acceptanceRun.executionEnd));
    }
    const result = acceptanceVerdict(acceptanceRun, { components, end, manifest: incidentManifest, policyReasons: [...policyReasons, ...extraReasons] });
    acceptanceRun.artifacts.push(...result.incidentArtifacts);
    const report = writeAcceptance(acceptanceRun, { ...result, end, components, manifest: incidentManifest, policyReasons: [...policyReasons, ...extraReasons], scope: 'commit' });
    console.log(`[verify] ${report.verdict}: ${reportDir}/acceptance.json`);
    for (const reason of report.reasons) console.log(`[verify]   ${reason}`);
    process.exitCode = exitCode(report.verdict);
    return report;
};
if (executionPreflightError) {
    if (acceptanceRun) finish();
    else console.error(executionPreflightError);
    process.exit(2);
}

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
    log('unverified: no changes selected; use --since <ref> or --full.');
    if (acceptanceRun) finish([], ['no-op invocation does not establish commit acceptance']);
    process.exit(2);
}

// ── the scenario rule ───────────────────────────────────────────────────────────────

// `covers` is read from the module itself rather than parsed out of the text: a declaration that
// only a regex can see is one a rename silently breaks. Importing a scenario is safe by contract
// (a scenario is a default-exported function and nothing else runs at module scope), and a broken
// one is reported instead of taking the whole run down with it.
const scenariosDir = path.join(harnessRoot, 'scripts', 'scenarios');
const targetScenarioNames = executionContext ? fs.readdirSync(path.join(repoRoot, 'scripts/scenarios')).filter(file => file.endsWith('.mjs')).sort() : null;
if (targetScenarioNames) for (const file of targetScenarioNames) {
    if (!fs.existsSync(path.join(scenariosDir, file))) policyReasons.push(`target scenario has no reviewed harness implementation: ${file}`);
}
const scenarios = [];
for (const base of fs.existsSync(scenariosDir) ? fs.readdirSync(scenariosDir).filter((f) => f.endsWith('.mjs') && (!targetScenarioNames || targetScenarioNames.includes(f))).sort() : []) {
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
const untrackedScenarios = gitOutput(['ls-files', '--others', '--exclude-standard', '--', SCENARIO_PREFIX]).split('\n').filter(file => file.endsWith('.mjs'));

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
    log('  harness files changed — running actual targeted harness tests');
    plan.tests.add('scripts/ui-audit/lib');
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

if (rule.optOut !== null && rule.uiFiles.length > 0) policyReasons.push('UI --no-scenario is an evidence gap, not a waiver');
if (!rule.ok) {
    log(`unverified: ${rule.message}`);
    if (acceptanceRun) finish([], ['scenario coverage rule unsatisfied']);
    process.exit(2);
}
if (has('--plan')) { log('unverified: plan only, no acceptance evidence created'); process.exit(2); }

// ── run ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn one command and hand back its status. It does NOT exit: what a nonzero status means is
 * the battery runner's decision now (`ui-audit/lib/battery.mjs` has the two rules and the four
 * failed checks do not hide independent evidence; retries remain diagnostic.
 */
let lastExecution = null, retainedBuild = null;
const spawn = (command, options = {}) => {
    const startedAt = Date.now();
    const env = { ...process.env, KELPI_ACCEPTANCE_RUN_ID: acceptanceRun.runId, KELPI_ACCEPTANCE_HEAD: acceptanceRun.start.head, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...options.env };
    if (executionContextReceipt) {
        env.KELPI_ACCEPTANCE_CONTEXT = executionContextReceipt.path;
        env.KELPI_ACCEPTANCE_CONTEXT_SHA256 = executionContextReceipt.sha256;
    }
    // A battery launched from inside a Kelpi pane inherits that pane's injected route to the
    // LIVE daemon (KELPI_SOCKET, and NEX_SOCKET under the old name). No battery child may
    // carry it: anything that legitimately talks to a daemon pins its own sandbox route, and
    // an inherited pane route would satisfy KELPI_REQUIRE_SOCKET while addressing the real
    // instance — the one hole the guard cannot see.
    if (retainedBuild) { env.KELPI_ACCEPTANCE_BUILD_RECEIPT = retainedBuild.path; env.KELPI_ACCEPTANCE_BUILD_SHA256 = retainedBuild.sha256; }
    delete env.KELPI_SOCKET;
    delete env.NEX_SOCKET;
    const result = spawnSync('sh', ['-c', command], {
        cwd: options.cwd ?? repoRoot,
        stdio: 'inherit',
        env
    });
    const receipt = { command, cwd: options.cwd ?? repoRoot, startedAt, finishedAt: Date.now(), exitStatus: result.status ?? 1, signal: result.signal, error: result.error?.message ?? null };
    const file = path.join(reportDir, `command-${acceptanceRun.artifacts.length}-${startedAt}.json`);
    fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    acceptanceRun.artifacts.push({ path: file, sha256: digest(fs.readFileSync(file)), kind: 'command' });
    lastExecution = { ...receipt, path: file };
    return receipt.exitStatus;
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
// The run directory is new; first-attempt evidence is never deleted.
fs.mkdirSync(batteryDir, { recursive: true });
const artifact = (name) => path.join(batteryDir, `${name.replace(/[^a-z0-9-]+/gi, '-')}.json`);
/** What the full lane did to each scenario this run, or `null` when no full lane ran (#215). */
let laneObservations = null;

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
 * Hidden is the default functional lane. Visual requirements remain unverified
 * there because CDP captures a blank window. --scenario-window onscreen requests
 * reviewable captures under the same desktop reservation and freezes that choice.
 */
const SCENARIO_LANE = `--no-build --window ${scenarioWindow}`;

/**
 * Bundles, once, before anything drives a real app. Both the scenario step and the audit below run
 * `--no-build` so four `pnpm build`s do not race the same `dist/` trees; that is only honest if
 * strict acceptance binds one forced build to complete source inputs and actual outputs.
 * Child runners receive that retained receipt and must observe exactly those outputs.
 */
const retainBuild = (exitStatus, startedAt, source, outputs, error = null) => {
    const receipt = { command: 'buildAll(repoRoot, force=true)', runId: acceptanceRun.runId, head: acceptanceRun.start.head, exitStatus, startedAt, finishedAt: Date.now(), source, build: { inputManifestSha256: source?.inputManifestSha256, outputs, forced: true }, ...(executionContext ? { executionContext } : {}), error };
    const file = path.join(reportDir, 'build-result.json');
    fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
    retainedBuild = { path: file, sha256: digest(fs.readFileSync(file)), kind: 'build' };
    acceptanceRun.artifacts.push(retainedBuild); acceptanceRun.buildReceiptPath = file;
    return { ...receipt, path: file };
};
const buildBundlesComponent = {
    label: 'build bundles', kind: 'build', command: 'buildAll(repoRoot, force=true)', precondition: true,
    run: async () => {
        const startedAt = Date.now(); let source;
        try {
            source = captureSource(repoRoot);
            if (executionContext) {
                const changedRoots = executionRootErrors(executionContext, observeExecutionRoots(executionContext));
                if (changedRoots.length) throw new Error(changedRoots.join('; '));
                const preparation = prepareTargetBuild(repoRoot, reportDir);
                const file = path.join(reportDir, 'build-preparation.json');
                fs.writeFileSync(file, `${JSON.stringify(preparation, null, 2)}\n`, { flag: 'wx' });
                acceptanceRun.artifacts.push({ path: file, sha256: digest(fs.readFileSync(file)), kind: 'build-preparation' });
            }
            await buildAll(repoRoot, { force: true, log: (line) => log(`  ${line}`) });
            if (JSON.stringify(captureSource(repoRoot)) !== JSON.stringify(source)) throw new Error('source changed during forced build');
            const outputs = captureOutputs(repoRoot);
            return { ok: true, verdict: 'verified', execution: retainBuild(0, startedAt, source, outputs) };
        } catch (error) {
            return { ok: false, verdict: 'failed', detail: String(error?.message ?? error), execution: retainBuild(1, startedAt, source, [], String(error?.message ?? error)) };
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
const structuredAttempt = (kind, reportPath, command, options = {}) => {
    const startedAt = Date.now();
    const status = spawn(command, options);
    const finishedAt = Date.now();
    const raw = readArtifact(reportPath, acceptanceRun, { startedAt, kind });
    const selection = options.selection ?? components.find(c => c.reportPath === reportPath)?.selection;
    const evidence = { kind, path: reportPath, command, exitStatus: status, startedAt, finishedAt, selection };
    const buildReceipt = retainedBuild ? readJson(retainedBuild.path) : null;
    const checked = inspectResults(kind, raw.data, { ...evidence, runId: acceptanceRun.runId, head: acceptanceRun.start.head, selection, buildReceipt });
    for (const visual of checked.visualRequirements) for (const shot of visual.shots) {
        try {
            const bytes = fs.readFileSync(shot.path), sha256 = digest(bytes);
            if (shot.sha256 && shot.sha256 !== sha256) throw new Error('screenshot digest differs from runner');
            if (fs.statSync(shot.path).mtimeMs < startedAt - 1000) throw new Error('screenshot predates attempt');
            if (!acceptanceRun.artifacts.some(a => a.path === shot.path && a.sha256 === sha256)) acceptanceRun.artifacts.push({ path: shot.path, sha256, bytes: bytes.length, kind: 'visual' });
        } catch (error) { checked.missing.push(`visual retention: ${error.message}`); if (checked.verdict === 'verified') checked.verdict = 'unverified'; }
    }
    return { execution: lastExecution, ok: checked.verdict === 'verified', verdict: checked.verdict, detail: [...checked.failures, ...checked.missing, ...(raw.error ? [raw.error] : [])].join('; '), evidence };
};
const vitestComponent = (label, command, { filters = [], cwd } = {}) => ({
    label, kind: 'vitest', collection: { command, filters, cwd }, command: [command, ...filters.map(q), `--maxWorkers=${VITEST_MAX_WORKERS} --reporter=default --reporter=json --outputFile.json=${q(artifact(label))}`].join(' '), reportPath: artifact(label),
    run: () => {
        const report = artifact(label);
        const flags = file => `--maxWorkers=${VITEST_MAX_WORKERS} --reporter=default --reporter=json --outputFile.json=${q(file)}`;
        const outcome = structuredAttempt('vitest', report, [command, ...filters.map(q), flags(report)].join(' '), { cwd });
        const failedFiles = failedTestFilesFromVitestJson(readJson(report));
        if (outcome.ok || failedFiles.length === 0) return outcome;
        return { ...outcome, retryOf: failedFiles.map(rel), retry: () => {
            const retryReport = artifact(`${label}-retry`);
            return structuredAttempt('vitest', retryReport, [command, ...failedFiles.map(q), flags(retryReport)].join(' '), { cwd, selection: { ...components.find(c => c.label === label)?.selection, members: components.find(c => c.label === label)?.selection?.members.filter(m => failedFiles.includes(m.id)) } });
        } };
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
    selection: scenarioPlan(harnessRoot, (names.length ? names.map(name => scenarios.find(s => s.name === name)?.file ?? name) : scenarios.map(s => s.file)).map(file => path.resolve(harnessRoot, file))),
    label, kind: 'scenario', command: `node ${q(path.join(harnessRoot, 'scripts/scenario.mjs'))} ${SCENARIO_LANE} --out ${q(path.join(batteryDir, 'scenarios'))} ${(names.length ? names : scenarios.map(s => s.name)).map(q).join(' ')}`, reportPath: path.join(batteryDir, 'scenarios/results.json'),
    run: () => {
        const out = path.join(batteryDir, 'scenarios');
        const outcome = structuredAttempt('scenario', path.join(out, 'results.json'), `node ${q(path.join(harnessRoot, 'scripts/scenario.mjs'))} ${SCENARIO_LANE} --out ${q(out)} ${(names.length ? names : scenarios.map(s => s.name)).map(q).join(' ')}`, { env: SANDBOX_GUARD });
        const results = readJson(path.join(out, 'results.json'));
        if (names.length === 0) laneObservations = scenarioObservations(results, { stillRed: failedScenariosFromResults(results) });
        const failedNames = failedScenariosFromResults(results);
        if (outcome.ok || failedNames.length === 0) return outcome;
        return { ...outcome, retryOf: failedNames, retry: () => {
            const replayOut = path.join(batteryDir, 'scenario-prefix-replay');
            const failureIndex = results?.sequence?.firstFailure?.index;
            const replay = Number.isInteger(failureIndex) ? structuredAttempt('scenario', path.join(replayOut, 'results.json'), `node ${q(path.join(harnessRoot, 'scripts/scenario.mjs'))} ${SCENARIO_LANE} --out ${q(replayOut)} --replay ${q(path.join(out, 'results.json'))} --through ${failureIndex}`, { env: SANDBOX_GUARD, selection: scenarioPlan(harnessRoot, results.files.slice(0, failureIndex + 1)) }) : { ok: false, verdict: 'unverified', detail: 'original failure sequence unavailable for replay' };
            const isolated = failedNames.map((name, index) => {
                const retryOut = path.join(batteryDir, `scenario-retry-${index}`);
                return structuredAttempt('scenario', path.join(retryOut, 'results.json'), `node ${q(path.join(harnessRoot, 'scripts/scenario.mjs'))} ${SCENARIO_LANE} --out ${q(retryOut)} ${q(name)}`, { env: SANDBOX_GUARD, selection: scenarioPlan(harnessRoot, [path.join(scenariosDir, `${name}.mjs`)]) });
            });
            const stillRed = failedNames.filter((_, index) => !isolated[index].ok);
            if (names.length === 0) laneObservations = scenarioObservations(results, { stillRed });
            const attempts = [{ ...replay, mode: 'preceding-sequence-replay' }, ...isolated.map(a => ({ ...a, mode: 'isolated-retry' }))];
            return { ok: attempts.every(a => a.ok), detail: 'diagnostic prefix replay and isolated retries; first failure retained', attempts };
        } };
    }
});

const auditComponent = (label, only = '') => ({
    selection: auditPlan(harnessRoot, [...(only ? expandChains(only.split(',')) : CANONICAL_ORDER), 'renderer-console']),
    label, kind: 'audit', command: `node ${q(path.join(harnessRoot, 'scripts/ui-audit/audit.mjs'))} --no-build ${only ? `--only ${q(only)}` : ''} --out ${q(path.join(batteryDir, 'audit'))}`, reportPath: path.join(batteryDir, 'audit/results.json'),
    run: () => {
        const out = path.join(batteryDir, 'audit');
        return structuredAttempt('audit', path.join(out, 'results.json'), `node ${q(path.join(harnessRoot, 'scripts/ui-audit/audit.mjs'))} --no-build ${only ? `--only ${q(only)}` : ''} --out ${q(out)}`, { env: SANDBOX_GUARD });
    }
});

/** A whole-command component with no way to isolate a part of it: run it, retry it once, done. */
const retryWholeComponent = (label, script, options = {}) => {
    const smokeFiles = { smoke: 'smoke.mjs', 'smoke:web':'web-smoke.mjs', 'smoke:pwa':'pwa-smoke.mjs', 'smoke:terminal':'terminal-smoke.mjs', 'smoke:packaged':'packaged-smoke.mjs' };
    const source = path.join(harnessRoot, 'packages/shell/scripts', smokeFiles[script]);
    const name = script === 'smoke' ? 'shell' : script.split(':')[1];
    const selection = smokePlan(harnessRoot, name);
    const report = artifact(`${label}-smoke`);
    const commandFor = file => `node ${q(source)} --no-build --acceptance-report ${q(file)}${name === 'terminal' ? ` --out ${q(file + '.screenshots')}` : ''}`;
    return {
        label, kind: 'smoke', command: commandFor(report), selection, reportPath: report,
        run: () => {
            const first = structuredAttempt('smoke', report, commandFor(report), { ...options, selection });
            if (first.ok) return first;
            return { ...first, retryOf: ['the whole smoke; original attempt retained'], retry: () => {
                const retryReport = artifact(`${label}-smoke-retry`);
                return structuredAttempt('smoke', retryReport, commandFor(retryReport), { ...options, selection });
            } };
        }
    };
};

/** A component that is run once and judged once: no isolation is possible or wanted. */
const plainComponent = (label, command, options = {}) => ({
    label, kind: 'command', command,
    run: () => { const status = spawn(command, options); return { ok: status === 0, verdict: status === 0 ? 'verified' : 'failed', exitStatus: status, execution: lastExecution }; }
});

const shellPackage = path.join(repoRoot, 'packages', 'shell');
const components = full || changed.some(f => f.startsWith('packages/')) ? [plainComponent('typecheck', 'pnpm typecheck')] : [];

if (full) {
    components.push(
        vitestComponent('root tests', 'npx vitest run'),
        vitestComponent('shell tests', 'pnpm --filter @kelpi/shell test'),
        // Every scenario, before the audit and without the screen. The promote gate is the one place
        // that must not select: `self-upgrade.mjs` runs `--full`, so this is what stops #47/#53/#55
        // from recurring on a tree where nobody's diff happened to touch the scenario that guards them.
        buildBundlesComponent,
        scenarioComponent(`scenarios (all, ${SCENARIO_LANE})`, []),
        // Audit assertions, step errors, cleanup and visual review are interpreted from raw JSON.
        auditComponent('full audit'),
        retryWholeComponent('packaged smoke (repackages + 69 checks)', 'smoke:packaged', {
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
        if (!components.includes(buildBundlesComponent)) components.push(buildBundlesComponent);
        // The audit consumes the same forced build receipt as the scenario lane.
        components.push(
            auditComponent('scoped audit', [...plan.steps].join(','))
        );
    }
    if (plan.smokes.size > 0 && !components.includes(buildBundlesComponent)) components.push(buildBundlesComponent);
    for (const smoke of plan.smokes) {
        components.push(retryWholeComponent(smoke, smoke, { cwd: shellPackage, env: SANDBOX_GUARD }));
    }
}

// Vitest collection freezes full test names before execution, including dynamically expanded tests.
for (const component of components.filter(c => c.kind === 'vitest')) {
    const collectionPath = artifact(`${component.label}-selection`);
    const fileListPath = artifact(`${component.label}-selected-files`);
    const { command, filters, cwd } = component.collection;
    const collectCommand = `${command.replace(/(?: run| test)$/, ' list')} ${filters.map(q).join(' ')} --maxWorkers=${VITEST_MAX_WORKERS} --json=${q(collectionPath)}`;
    // Shell package scripts invoke vitest run; call its local vitest binary directly for collection.
    const actualCommand = command.includes('@kelpi/shell') ? `pnpm --filter @kelpi/shell exec vitest list --maxWorkers=${VITEST_MAX_WORKERS} --json=${q(collectionPath)}` : collectCommand;
    const fileStatus = spawn(`${actualCommand.replace(`--json=${q(collectionPath)}`, `--json=${q(fileListPath)}`)} --filesOnly`, { cwd });
    const selectedFiles = readArtifact(fileListPath, acceptanceRun, { startedAt: lastExecution.startedAt, kind: 'test-file-collection' });
    const fileCollectionReceipt = lastExecution;
    const status = spawn(actualCommand, { cwd });
    const collection = readArtifact(collectionPath, acceptanceRun, { startedAt: lastExecution.startedAt, kind: 'test-collection' });
    const members = new Map();
    if (Array.isArray(selectedFiles.data)) for (const selected of selectedFiles.data) if (typeof selected?.file === 'string') members.set(selected.file, { id: selected.file, mode: 'assert', requiredAssertions: [], minAssertions: 1 });
    if (Array.isArray(collection.data)) for (const test of collection.data) {
        if (typeof test?.file !== 'string' || typeof test?.name !== 'string') continue;
        if (!members.has(test.file)) members.set(test.file, { id: test.file, mode: 'assert', requiredAssertions: [], minAssertions: 1 });
        // Vitest permits repeated display names (notably parameterised cases).  The frozen plan
        // records the per-file occurrence, matching the raw JSON interpreter, so a later run
        // cannot make one case disappear behind its neighbour's prose.
        members.get(test.file).requiredAssertions.push(test.name);
    }
    for (const member of members.values()) member.requiredAssertions = assertionIdentities(member.requiredAssertions);
    component.selection = { kind: 'vitest', ordered: false, complete: status === 0 && fileStatus === 0 && Array.isArray(selectedFiles.data) && Array.isArray(collection.data) && members.size > 0, members: [...members.values()] };
    component.collectionReceipt = { files: fileCollectionReceipt, tests: lastExecution };
}
const executionPlan = { schemaVersion: acceptanceRun.schemaVersion, ...(executionContext ? { executionContext } : {}), runId: acceptanceRun.runId, head: acceptanceRun.start.head, reference, args, changed, scenarioWindow, scenarioRule: rule, components: components.map(({ label, kind, command, reportPath, selection, collectionReceipt }) => ({ label, kind, command, ...(reportPath ? { reportPath } : {}), ...(selection ? { selection } : {}), ...(collectionReceipt ? { collectionReceipt } : {}) })) };
const planPath = path.join(reportDir, 'verification-plan.json');
fs.writeFileSync(planPath, `${JSON.stringify(executionPlan, null, 2)}\n`, { flag: 'wx' });
acceptanceRun.planPath = planPath;
acceptanceRun.artifacts.push({ path: planPath, sha256: digest(fs.readFileSync(planPath)), kind: 'plan' });

const started = Date.now();
const battery = await runBattery({ components, log });

/*
 * The retry history (#215): what the full lane did to each scenario, kept across batteries beside
 * the run's own output under the gitignored `docs/audit/`, and deliberately NOT under
 * each immutable run directory. History adds context only; original failures remain red.
 * N is `KELPI_ORDERING_LANES`, default 2.
 */
const historyFile = path.join(repoRoot, 'docs', 'audit', 'battery-retry-history.json');
let verdicts = [];
// An empty list is a lane that observed nothing (a `results.json` that could not be read), not a
// green lane: it must write nothing and say nothing rather than re-emit the last run's verdicts.
if (laneObservations !== null && laneObservations.length > 0) {
    // `parseInt`, not `Number()`: an exported-but-empty KELPI_ORDERING_LANES is `0` under `Number`,
    // which would call every retry-rescued scenario ordering-dependent on its first failure.
    const asked = Number.parseInt(process.env.KELPI_ORDERING_LANES ?? '', 10);
    const consecutive = Number.isInteger(asked) && asked >= 1 ? asked : CONSECUTIVE_LANE_FAILS;
    const history = recordRetryHistory(readRetryHistory(historyFile), laneObservations);
    writeRetryHistory(historyFile, history);
    // Only the scenarios THIS lane ran. The store outlives a rename or a deletion, and a verdict
    // for a scenario nothing runs any more would be the loudest line in every later green run.
    const seen = new Set(laneObservations.map((observation) => observation.name));
    verdicts = retryVerdicts(history, { consecutive }).filter((verdict) => seen.has(verdict.name));
}

// The table is the point of running everything: one red battery now says which checks failed,
// which wobbled and came back green alone, and what each cost.
log('── battery summary ──────────────────────────────────────────────────────');
for (const line of formatBatterySummary(battery.records, verdicts)) log(`  ${line}`);

// Digest every retained first-attempt/retry diagnostic, including images and clipboard traces.
const retainDirectory = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) retainDirectory(file);
        else if (entry.isFile() && !acceptanceRun.artifacts.some(a => a.path === file)) acceptanceRun.artifacts.push({ path: file, sha256: digest(fs.readFileSync(file)), kind: 'diagnostic' });
        else if (entry.isSymbolicLink()) policyReasons.push(`unretained symlink artifact: ${file}`);
    }
};
retainDirectory(batteryDir);
finish(battery.records);
