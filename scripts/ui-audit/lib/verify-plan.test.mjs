/**
 * The scenario rule's own tests.
 *
 * The rule decides whether a diff may ship, so it is the one part of the harness that can stop a
 * promote by being wrong. It is a pure function precisely so this file can put every branch under
 * test without booting a daemon, a shell or a window: a refusal that names the wrong file, or an
 * opt-out that silently evaporates, would otherwise only be discovered by the person it blocked.
 *
 * These run under the ROOT vitest through a third project in `vitest.config.ts` whose include is
 * this file's path and nothing else. The two shipped projects glob `packages/`, so `scripts/` was
 * outside the suite entirely; widening either of them would have pulled 1.8 MB of audit source
 * into a jsdom or node project that has no reason to load it.
 */
import { describe, expect, it } from 'vitest';

import { coversPath, isUiFile, planScenarios } from './verify-plan.mjs';

/** A cut-down `SURFACES`, in the shape `verify.mjs` passes: order matters, longest prefix first. */
const SURFACES = [
    { prefix: 'docs/', skip: true },
    { prefix: 'scripts/ui-audit/', harness: true },
    { prefix: 'scripts/', harness: true },
    { prefix: 'packages/client/src/chrome/', tests: ['packages/client/src/chrome'], steps: ['titlebar-menu'] },
    { prefix: 'packages/daemon/', escalate: 'daemon core' }
];

const SCENARIOS = [
    {
        name: 'confirm-dialog-keys',
        file: 'scripts/scenarios/confirm-dialog-keys.mjs',
        covers: ['packages/client/src/chrome/Sidebar.tsx', 'packages/client/src/chrome/ContextMenu.tsx']
    },
    {
        name: 'menu-accelerators-follow-rebinding',
        file: 'scripts/scenarios/menu-accelerators-follow-rebinding.mjs',
        covers: ['packages/shell/src/menu.ts', 'packages/core/src/config/']
    },
    { name: 'no-covers', file: 'scripts/scenarios/no-covers.mjs' }
];

const plan = (changed, extra = {}) => planScenarios({ changed, scenarios: SCENARIOS, surfaces: SURFACES, ...extra });

describe('isUiFile', () => {
    it('treats the client and the shell sources as UI', () => {
        expect(isUiFile('packages/client/src/chrome/Sidebar.tsx', { surfaces: SURFACES })).toBe(true);
        expect(isUiFile('packages/shell/src/menu.ts', { surfaces: SURFACES })).toBe(true);
        // Not a component, still UI: every surface you look at is built out of it.
        expect(isUiFile('packages/client/src/styles.css', { surfaces: SURFACES })).toBe(true);
    });

    it('never treats docs, the harness or the daemon as UI', () => {
        expect(isUiFile('docs/shell-ui.md', { surfaces: SURFACES })).toBe(false);
        expect(isUiFile('scripts/scenarios/confirm-dialog-keys.mjs', { surfaces: SURFACES })).toBe(false);
        expect(isUiFile('scripts/ui-audit/lib/verify-plan.mjs', { surfaces: SURFACES })).toBe(false);
        expect(isUiFile('packages/daemon/src/handlers/app/events.ts', { surfaces: SURFACES })).toBe(false);
    });

    it('lets the map opt a surface in explicitly', () => {
        const surfaces = [{ prefix: 'packages/daemon/src/term/', ui: true }];
        expect(isUiFile('packages/daemon/src/term/pty.ts', { surfaces })).toBe(true);
    });
});

describe('covers matching', () => {
    it('matches an exact path', () => {
        expect(coversPath('packages/client/src/chrome/Sidebar.tsx', 'packages/client/src/chrome/Sidebar.tsx')).toBe(true);
    });

    it('matches a directory prefix, with or without the trailing slash', () => {
        expect(coversPath('packages/core/src/config/', 'packages/core/src/config/bindings.ts')).toBe(true);
        expect(coversPath('packages/core/src/config', 'packages/core/src/config/bindings.ts')).toBe(true);
    });

    it('does not let a prefix run past a path segment', () => {
        // The bug a bare `startsWith` ships with: `chrome` must not claim `chromeless.ts`.
        expect(coversPath('packages/client/src/chrome', 'packages/client/src/chromeless.ts')).toBe(false);
        expect(coversPath('packages/client/src/chrome/Sidebar', 'packages/client/src/chrome/SidebarResizer.tsx')).toBe(false);
    });
});

describe('the rule', () => {
    it('refuses a UI diff that ships no scenario, and names the files', () => {
        const result = plan(['packages/client/src/webpane/WebPane.tsx', 'packages/client/src/webpane/tabs.ts']);
        expect(result.ok).toBe(false);
        expect(result.uncovered).toEqual([
            'packages/client/src/webpane/WebPane.tsx',
            'packages/client/src/webpane/tabs.ts'
        ]);
        expect(result.message).toContain('packages/client/src/webpane/WebPane.tsx');
        expect(result.message).toContain('packages/client/src/webpane/tabs.ts');
        expect(result.message).toContain('--no-scenario');
        expect(result.optOut).toBeNull();
    });

    it('refuses a pure refactor too: touching UI files is the trigger, not changing behaviour', () => {
        expect(plan(['packages/shell/src/notify.ts']).ok).toBe(false);
    });

    it('passes when the diff writes a scenario, and runs it', () => {
        const result = plan(['packages/client/src/webpane/WebPane.tsx', 'scripts/scenarios/no-covers.mjs']);
        expect(result.ok).toBe(true);
        expect(result.changedScenarios).toEqual(['no-covers']);
        expect(result.run).toContain('no-covers');
        expect(result.message).toBeNull();
    });

    it('sees a scenario that git cannot: an untracked new file, passed in by the caller', () => {
        // `git diff --name-only HEAD` never lists an untracked file, so without this the rule
        // would refuse the diff that obeyed it hardest: a fix plus a brand-new scenario for it.
        const result = plan(['packages/client/src/webpane/WebPane.tsx'], {
            changedScenarioFiles: ['scripts/scenarios/no-covers.mjs']
        });
        expect(result.ok).toBe(true);
        expect(result.run).toContain('no-covers');
    });

    it('does not let a DELETED scenario discharge the rule or get run', () => {
        const result = plan(['packages/client/src/webpane/WebPane.tsx', 'scripts/scenarios/deleted-one.mjs']);
        expect(result.ok).toBe(false);
        expect(result.changedScenarios).toEqual([]);
        expect(result.run).not.toContain('deleted-one');
    });

    it('passes when the diff adds an audit step instead', () => {
        const result = plan(['packages/client/src/webpane/WebPane.tsx', 'scripts/ui-audit/audit.mjs']);
        expect(result.ok).toBe(true);
        expect(result.changedAuditFiles).toEqual(['scripts/ui-audit/audit.mjs']);
    });

    it('passes with --no-scenario and records the reason verbatim', () => {
        const result = plan(['packages/client/src/webpane/WebPane.tsx'], { noScenario: '  a comment-only change  ' });
        expect(result.ok).toBe(true);
        expect(result.optOut).toEqual({ reason: 'a comment-only change' });
        expect(result.message).toBeNull();
    });

    it('does not accept an empty --no-scenario as an opt-out', () => {
        // `--no-scenario` with nothing after it is a flag someone hoped would be free.
        expect(plan(['packages/client/src/webpane/WebPane.tsx'], { noScenario: '   ' }).ok).toBe(false);
        expect(plan(['packages/client/src/webpane/WebPane.tsx'], { noScenario: null }).ok).toBe(false);
    });

    it('asks for nothing when the diff touches no UI surface', () => {
        const result = plan(['packages/daemon/src/store/db.ts', 'docs/agent-lifecycle.md']);
        expect(result.ok).toBe(true);
        expect(result.uiFiles).toEqual([]);
        expect(result.run).toEqual([]);
        expect(result.optOut).toBeNull();
    });
});

describe('covers selects the scenarios the scoped tier runs', () => {
    it('re-runs a scenario for a file it declares, without the diff touching the scenario', () => {
        const result = plan(['packages/client/src/chrome/Sidebar.tsx']);
        expect(result.ok).toBe(true);
        expect(result.run).toEqual(['confirm-dialog-keys']);
        expect(result.coverage['packages/client/src/chrome/Sidebar.tsx']).toEqual(['confirm-dialog-keys']);
    });

    it('matches a covers entry that is a directory prefix', () => {
        const result = plan(['packages/core/src/config/bindings.ts']);
        expect(result.run).toEqual(['menu-accelerators-follow-rebinding']);
    });

    it('runs every scenario the diff touches on any surface, deduplicated and sorted', () => {
        const result = plan([
            'packages/client/src/chrome/Sidebar.tsx',
            'packages/shell/src/menu.ts',
            'scripts/scenarios/confirm-dialog-keys.mjs'
        ]);
        expect(result.run).toEqual(['confirm-dialog-keys', 'menu-accelerators-follow-rebinding']);
    });

    it('leaves a UI file uncovered when no covers entry claims it, even beside one that is', () => {
        const result = plan(['packages/client/src/chrome/Sidebar.tsx', 'packages/client/src/chrome/Inspector.tsx']);
        expect(result.ok).toBe(false);
        expect(result.uncovered).toEqual(['packages/client/src/chrome/Inspector.tsx']);
        expect(result.run).toEqual(['confirm-dialog-keys']);
    });
});
