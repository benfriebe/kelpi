/**
 * The command palette's density pack — `../kelpi-docs/SPACING-REVIEW.md` S23, S32.
 *
 * `CommandPaletteView.swift:114-155` is the whole reference: an `HStack(spacing: 10)` whose
 * `Spacer()` is a stack MEMBER (so the stack spends 10 pt on both sides of it), and two trailing
 * pills at `.padding(.horizontal, 6).padding(.vertical, 2)`.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette, type PaletteItem } from './index';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';

const ITEMS: readonly PaletteItem[] = [
    {
        id: `ws:${W1}`,
        kind: 'workspace',
        icon: 'rectangle.stack',
        title: 'a-workspace-with-a-very-long-name-indeed',
        subtitle: '2 panes',
        workspaceID: W1,
        workspaceName: 'kelpi-client',
        paneID: null,
        workspaceColor: 'blue'
    },
    {
        id: `pane:${P1}`,
        kind: 'pane',
        icon: 'terminal',
        title: '~/code/kelpi/packages/client/src/chrome',
        subtitle: '',
        workspaceID: W1,
        workspaceName: 'kelpi-client',
        paneID: P1,
        workspaceColor: 'blue'
    }
];

function renderPalette() {
    return render(
        <CommandPalette
            open
            query=""
            onQueryChange={vi.fn()}
            items={ITEMS}
            onConfirm={vi.fn()}
            onDismiss={vi.fn()}
            bucket="dark"
        />
    );
}

// ── S23: the title column → trailing badge gap ──────────────────────────────────────

describe('S23 — the row’s trailing gap is a spacer, not a flex filler', () => {
    /*
     * The `Spacer()` at `CommandPaletteView.swift:137` is a member of the `HStack(spacing: 10)`,
     * so the stack spends 10 pt on BOTH sides of it: a ≥20 pt floor between a truncating title
     * and the pill (§L50's arithmetic). The port made the TITLE COLUMN the filler instead, and
     * the sandbox measured `titleToPill = 10.00` on both the workspace row and the pane row.
     */
    it('carries §L56’s spacer between the title column and the badge', () => {
        renderPalette();
        const row = screen.getAllByTestId('palette-row')[0] as HTMLElement;
        const spacer = within(row).getByTestId('palette-spacer');
        // The same `min-w-[10px] flex-1` the footer's bucket rows already use, so the two
        // list surfaces in this client spend their trailing gap the same way.
        expect(spacer.className).toContain('min-w-[10px]');
        expect(spacer.className).toContain('flex-1');
        expect(spacer.getAttribute('aria-hidden')).toBe('true');
        // …and it sits between the title column and everything trailing it.
        const children = [...row.children];
        const titleIndex = children.findIndex((el) => el.className.includes('flex-col'));
        expect(children.indexOf(spacer)).toBe(titleIndex + 1);
    });

    it('takes `flex-1` OFF the title column, or the spacer would never get any', () => {
        renderPalette();
        const row = screen.getAllByTestId('palette-row')[0] as HTMLElement;
        const title = [...row.children].find((el) => el.className.includes('flex-col')) as HTMLElement;
        expect(title.className).toContain('min-w-0');
        expect(title.className).not.toContain('flex-1');
    });
});

// ── S32: the trailing pills ─────────────────────────────────────────────────────────

describe('S32 — the badge pills’ vertical inset', () => {
    it('is the Swift’s 2 pt, not half of it', () => {
        renderPalette();
        const pills = screen
            .getAllByTestId('palette-row')
            .map((row) => [...row.children].at(-1) as HTMLElement)
            .filter((el) => el.className.includes('rounded'));
        expect(pills.length).toBeGreaterThan(0);
        for (const pill of pills) {
            // `.padding(.horizontal, 6).padding(.vertical, 2)` — `CommandPaletteView.swift:143-152`.
            // Measured `1px 6px`: horizontal right, vertical half.
            expect(pill.className).toContain('px-1.5');
            expect(pill.className).toContain('py-0.5');
            expect(pill.className).not.toContain('py-px');
        }
    });
});
