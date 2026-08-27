/**
 * The title bar's density pack — `docs/SPACING-REVIEW.md` S4, S22, S55, S58.
 *
 * The register's own three legs are Swift source, port source and a live measurement; jsdom can
 * only hold the third one honest by proxy, so every block here asserts the *declaration* the
 * live measurement was traced back to, and names the number the sandbox read. What is genuinely
 * behavioural — the identity's truncation reserve, which is computed rather than declared — is
 * asserted on the pure function the component calls.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TopBar, identityReserve } from './TopBar';
import type { ChromePane } from './types';

afterEach(cleanup);

function pane(id: string): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test',
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function renderBar(overrides: Partial<React.ComponentProps<typeof TopBar>> = {}) {
    return render(
        <TopBar
            workspaceName="reflow-pipeline"
            workspaceColor="blue"
            panes={[pane('p1')]}
            connection="connected"
            onToggleSidebar={() => {}}
            onToggleInspector={() => {}}
            onCycleLayout={() => {}}
            onSelectLayout={() => {}}
            onToggleSyncInput={() => {}}
            {...overrides}
        />
    );
}

// ── S4: the identity's truncation gutter ────────────────────────────────────────────

describe('S4 — the centred identity reserves room for both clusters', () => {
    /*
     * `WindowTitleBar.swift:89-90` pads the identity 80 leading / 86 trailing and centres it, and
     * says why: "so a long name truncates instead of overlapping the menu / sidebar buttons on a
     * narrow window". The port reserved nothing — the sandbox measured the trailing cluster at
     * 232.64 px wide starting at `width − 12 − 232.64`, against an identity centred on the window
     * with only `max-w-[280px]` to stop it, so at 700 px the name ran under the layout chip.
     */
    it('takes the LARGER of the two clusters, because a centred box is bound by both', () => {
        const bar = { left: 0, right: 1280 };
        // The sandbox's own numbers: leading cluster ends at 165, trailing begins at 1035.36.
        expect(identityReserve(bar, { right: 165 }, { left: 1035.36 })).toBe(257);
        // Reserving 80 on one side and 257 on the other would centre the name 88 px left of the
        // window centre, which the shipped bar (80 vs 86 — a 3 px shift) never does.
        expect(identityReserve(bar, { right: 900 }, { left: 1035.36 })).toBe(912);
    });

    it('is the cluster edge plus this bar’s own 12 px trailing padding', () => {
        expect(identityReserve({ left: 0, right: 1000 }, null, { left: 900 })).toBe(112);
        expect(identityReserve({ left: 0, right: 1000 }, { right: 100 }, null)).toBe(112);
        // A bar with no clusters at all still keeps the gutter, never a negative reserve.
        expect(identityReserve({ left: 0, right: 1000 }, null, null)).toBe(12);
    });

    it('caps the identity’s width from that reserve, and lets the name shrink into it', () => {
        renderBar();
        const identity = screen.getByTestId('top-bar-identity');
        // jsdom has no layout, so the reserve falls back to the 256 the sandbox measured
        // (232.64 + the bar's `pr-3` + slack) rather than to "no cap at all".
        expect(identity.style.maxWidth).toBe('calc(100% - 512px)');
        const name = identity.querySelector('span.truncate') as HTMLElement;
        // `min-w-0` is what makes `.truncationMode(.tail)` real: a flex item's automatic minimum
        // is its min-content width, so a nowrap name would otherwise overflow the cap instead.
        expect(name.className).toContain('min-w-0');
        expect(name.className).toContain('truncate');
        // …and the members that must NOT absorb the squeeze keep their size.
        expect(screen.getByTestId('identity-dot').className).toContain('shrink-0');
    });
});

// ── S22: the leading glyph cluster ──────────────────────────────────────────────────

describe('S22 — three glyphs 14 px apart, each with a real target', () => {
    it('spaces the cluster at the Swift’s 14, not Tailwind’s nearest 8', () => {
        renderBar();
        const cluster = screen.getByLabelText('Toggle sidebar').parentElement as HTMLElement;
        // `HStack(spacing: 14)` — `WindowTitleBar.swift:243`. Measured 8.00 / 8.00 before.
        expect(cluster.className).toContain('gap-3.5');
        expect(cluster.className).not.toContain('gap-2');
    });

    it('gives each 13 px glyph a 3 px inset so the box is 19, not 13', () => {
        renderBar({ overflowItems: [{ id: 'settings', label: 'Settings…' }] });
        for (const label of ['Toggle sidebar', 'Toggle inspector', 'More actions']) {
            expect(screen.getByLabelText(label).style.padding).toBe('3px');
        }
    });
});

// ── S55 / S58: the layout chip, its chevron, and the dropdown it opens ───────────────

describe('S58 — the chevron is a target, not a glyph', () => {
    it('carries the vertical inset the two chips beside it already have', () => {
        renderBar();
        const chevron = screen.getByTestId('layout-menu-toggle');
        // Measured 18 × 10 with `padding: 0px 4px`: the ~4 px between "custom" and the caret was
        // there, the target was not. The chips beside it are 19.4 px tall at `2px 6px`.
        expect(chevron.className).toContain('py-[3px]');
        expect(chevron.className).toContain('px-1');
    });
});

describe('S55 — the layout dropdown’s rows', () => {
    it('insets a label 10 px from the panel wall, like every other menu row', () => {
        renderBar();
        fireEvent.click(screen.getByTestId('layout-menu-toggle'));
        const rows = [...screen.getByTestId('layout-menu').querySelectorAll('[role="menuitem"]')];
        expect(rows).toHaveLength(5);
        for (const row of rows) {
            // `px-2` put the label 4 px (the panel's own `p-1`) from the wall; `MenuRow` and the
            // preview's copy menu both settle on 10.
            expect(row.className).toContain('px-2.5');
            expect(row.className).toContain('py-1');
            expect(row.className).toContain('text-[12px]');
        }
    });

    it('puts 2 px between rows so two hover rectangles cannot touch (S54 family)', () => {
        renderBar();
        fireEvent.click(screen.getByTestId('layout-menu-toggle'));
        const menu = screen.getByTestId('layout-menu');
        // Measured `itemGaps: [0,0,0,0]` — five labels stacked flush.
        expect(menu.className).toContain('flex');
        expect(menu.className).toContain('flex-col');
        expect(menu.className).toContain('gap-0.5');
    });

    it('and the shared `ContextMenu` behind ••• spends it the same way', () => {
        renderBar({ overflowItems: [{ id: 'settings', label: 'Settings…' }, { id: 'inspector', label: 'Show Inspector' }] });
        fireEvent.click(screen.getByTestId('titlebar-menu-toggle'));
        const menu = screen.getByTestId('context-menu');
        // S54's "1–2 px between rows" applied to all three of this client's menus at once — the
        // shared context menu, this dropdown, and the preview's copy menu — so they stay one
        // family rather than one of them growing a gap the other two lack.
        expect(menu.className).toContain('flex-col');
        expect(menu.className).toContain('gap-0.5');
        expect([...menu.querySelectorAll('[role="menuitem"]')]).toHaveLength(2);
    });
});
