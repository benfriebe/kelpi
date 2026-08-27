/**
 * The sidebar's density pack — `docs/SPACING-REVIEW.md` S18, S38, S39, S52, S61.
 *
 * Each block names the Swift line the number comes from (or, for `S39`, the owner-directed
 * divergence from it) and the figure the sandbox measured before the fix, so a future sweep can
 * tell "this was decided" from "this drifted".
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import {
    FOOTER_MENU_ESTIMATED_HEIGHT,
    FOOTER_MENU_ROW_HEIGHT,
    NAME_TRAILING_RESERVE_PX,
    fitLabelChips
} from './Sidebar';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const G1 = 'cccccccc-0000-4000-8000-000000000001';

function pane(id: string): ChromePane {
    return {
        id,
        type: 'shell',
        label: null,
        title: null,
        workingDirectory: '/Users/test/code',
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function workspace(id: string, name: string, overrides: Partial<ChromeWorkspace> = {}): ChromeWorkspace {
    return { id, name, color: 'blue', icon: null, labels: [], panes: [pane(`${id}-p1`)], ...overrides };
}

function entries(labels: readonly string[] = []): ChromeSidebarEntry[] {
    return [
        { kind: 'workspace', workspace: workspace(W1, 'alpha', { labels: [...labels] }) },
        {
            kind: 'group',
            group: { id: G1, name: 'a-group-with-a-long-name', color: 'green', icon: null, isCollapsed: false },
            workspaces: [workspace(W2, 'beta')]
        }
    ];
}

function baseProps() {
    return { activeWorkspaceID: W1, filter: '', onFilterChange: vi.fn(), rowHeight: 20 };
}

function rowFor(id: string): HTMLElement {
    return screen
        .getAllByTestId('workspace-row')
        .find((row) => row.getAttribute('data-workspace-id') === id) as HTMLElement;
}

// ── S18: the name column → ⌘N badge / chevron reserve ───────────────────────────────

describe('S18 — the untranscribed `Spacer` between the name and the trailing badge', () => {
    /*
     * `WorkspaceRowView.swift:51,79,84-88` is
     * `HStack(spacing: 9) { avatar; VStack; Spacer(minLength: 4); Text("⌘n") }`, and SwiftUI
     * spends the stack's spacing on every adjacent pair, the `Spacer` included: 9 + 4 + 9 = 22.
     * The sandbox measured a flat 9.00 px on every row, truncated or not, at both 220 px and the
     * 180 px minimum — an ellipsis 9 px from a monospace glyph.
     */
    it('reserves 13 px on the name column, so the floor is the Swift’s 22', () => {
        expect(NAME_TRAILING_RESERVE_PX).toBe(13);
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const nameColumn = rowFor(W1).querySelector('span.flex-col') as HTMLElement;
        expect(nameColumn.style.marginRight).toBe('13px');
        // The row's own gap is untouched — 9 + 13 = 22, not 13.
        expect(rowFor(W1).className).toContain('gap-[9px]');
    });

    it('does the same on the group band, whose chain is identical', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const band = screen.getByTestId('group-header');
        const nameColumn = band.querySelector('span.flex-col') as HTMLElement;
        // `GroupHeaderRow.swift:38,83,85-89` — the same `HStack(spacing: 9)` + `Spacer` chain,
        // this time before the collapse chevron.
        expect(nameColumn.style.marginRight).toBe('13px');
    });
});

// ── S39: the label chips (OWNER-DIRECTED divergence) ────────────────────────────────

describe('S39 — chips fold into `+N` instead of clipping to stubs (owner-directed)', () => {
    /*
     * OWNER-DIRECTED DIVERGENCE from `WorkspaceRowView.swift:65-76` / `WorkspaceLabelViews.swift:
     * 44-55`, which always draw `min(3, labels.count)` chips and let each clip as far as it must.
     * At the 180 px sidebar minimum the port (faithfully) rendered three chips at 27.09 / 16.41 /
     * 22.00 px against the 39 / 24 / 31 they wanted — 69 %, 68 %, 71 % of their ink, one glyph and
     * an ellipsis each. The count now falls before a chip is squeezed under 80 %, and everything
     * dropped joins the `+N` the Swift already has. Deliberately NOT a change to §L4's
     * `flex-nowrap` / `truncate` / `min-w-0` recipe.
     */
    it('shows every chip when they fit at their own width', () => {
        expect(fitLabelChips([39, 24, 31], 128)).toBe(3);
        // 39 + 4 + 24 + 4 + 31 = 102 — comfortable inside 128.
    });

    it('drops to two, then one, then none as the row narrows — never to stubs', () => {
        // Three chips + the `+N` they would need would not fit; two chips + `+N` do:
        // 39 + 4 + 24 + 4 + 11 = 82.
        expect(fitLabelChips([39, 24, 31], 88)).toBe(2);
        expect(fitLabelChips([39, 24, 31], 60)).toBe(1);
        expect(fitLabelChips([39, 24, 31], 30)).toBe(0);
    });

    it('lets the last chip give back a fifth of its ink, and no more', () => {
        // One chip of 40 in 32 px is exactly 80 % — kept, and `truncate` does the rest.
        expect(fitLabelChips([40], 32)).toBe(1);
        expect(fitLabelChips([40], 31)).toBe(0);
    });

    it('keeps the Swift’s answer when there is nothing to measure', () => {
        // jsdom, a hidden row, a zero-width sidebar: fall back to `min(3, labels.count)`.
        expect(fitLabelChips([39, 24, 31], 0)).toBe(3);
        expect(fitLabelChips([0, 0], 120)).toBe(2);
        expect(fitLabelChips([39, 24, 31], Number.POSITIVE_INFINITY)).toBe(3);
    });

    it('renders the capped set and the `+N` under an unmeasurable layout', () => {
        render(<Sidebar {...baseProps()} entries={entries(['infra', 'api', 'web', 'ops'])} />);
        const chips = within(rowFor(W1)).getAllByTestId('label-chip');
        expect(chips.map((chip) => chip.textContent)).toEqual(['infra', 'api', 'web']);
        expect(within(rowFor(W1)).getByTestId('label-overflow').textContent).toBe('+1');
        // §L4's recipe is untouched: still a non-wrapping row of clipping chips.
        const row = chips[0]?.parentElement as HTMLElement;
        expect(row.className).toContain('flex-nowrap');
        expect(row.className).toContain('mt-[3px]');
        for (const chip of chips) {
            expect(chip.className).toContain('truncate');
            expect(chip.className).toContain('min-w-0');
        }
    });
});

// ── S38 / S61: the custom emoji sheet ───────────────────────────────────────────────

describe('S38 / S61 — the custom emoji sheet’s rhythm', () => {
    function openSheet(): HTMLElement {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        fireEvent.contextMenu(rowFor(W1));
        fireEvent.mouseEnter(screen.getByTestId('context-menu').querySelector('[data-menu-item="icon"]') as HTMLElement);
        fireEvent.click(screen.getByTestId('context-submenu').querySelector('[data-menu-item="icon:custom"]') as HTMLElement);
        return screen.getByTestId('emoji-sheet');
    }

    it('is padded 20, not 16 — the sibling New Workspace sheet’s own number', () => {
        const sheet = openSheet();
        // `.padding(20)` — `GroupCustomEmojiSheet.swift:75`. Measured 16 px on all four sides.
        expect(sheet.className).toContain('p-5');
        expect(sheet.className).not.toContain('p-4');
        expect(sheet.className).toContain('w-[340px]');
    });

    it('spaces every row of the form the same 12, not five different `mb-*`', () => {
        const sheet = openSheet();
        const form = sheet.querySelector('form') as HTMLElement;
        // `VStack(alignment: .leading, spacing: 12)` — `:24`. Measured 8 / 8 / 4 / 8 / 12.
        expect(form.className).toContain('flex');
        expect(form.className).toContain('flex-col');
        expect(form.className).toContain('gap-3');
        for (const child of [...form.children]) {
            expect(child.className).not.toMatch(/\bmb-\d/);
        }
    });

    it('opens the browse grid’s two rows to 6 px (S61)', () => {
        const sheet = openSheet();
        const grid = within(sheet).getByTestId('emoji-browse');
        // 26.4 px cells 4.00 px apart read as two squashed strips.
        expect(grid.className).toContain('gap-1.5');
        expect(grid.className).not.toContain('gap-1 ');
    });
});

// ── S52: the group-delete confirmation ──────────────────────────────────────────────

describe('S52 — three destructive answers that read as three objects', () => {
    function openGroupDelete(memberCount: number): HTMLElement {
        const onDeleteGroup = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                onDeleteGroup={onDeleteGroup}
            />
        );
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.click(
            screen.getByTestId('context-menu').querySelector('[data-menu-item="delete"]') as HTMLElement
        );
        const dialog = screen.getByTestId('confirm-dialog');
        expect(within(dialog).getByTestId('confirm-group-detail').dataset['members']).toBe(String(memberCount));
        return dialog;
    }

    it('gives each answer AppKit’s gutter and minimum width', () => {
        const dialog = openGroupDelete(1);
        const buttons = [...(within(dialog).getByTestId('confirm-actions').querySelectorAll('button'))];
        expect(buttons).toHaveLength(3);
        for (const button of buttons) {
            // Measured `padding: 0px`, `border-width: 0px` on all three — the same recipe the
            // quit dialog settled on in S53 (`.confirmationDialog` is push buttons in an alert).
            expect(button.className).toContain('px-3');
            expect(button.className).toContain('py-1');
            expect(button.className).toContain('min-w-[68px]');
            expect(button.style.border).not.toBe('');
        }
        // …and the two destructive ones are boxed, so they are two answers rather than one
        // paragraph of red text.
        expect(within(dialog).getByTestId('confirm-delete-cascade').style.border).not.toContain('transparent');
        expect(within(dialog).getByTestId('confirm-delete').style.border).not.toContain('transparent');
    });

    it('stacks the three-answer shape, the way an NSAlert does with labels this long', () => {
        const dialog = openGroupDelete(1);
        const actions = within(dialog).getByTestId('confirm-actions');
        // Both destructive labels wrapped to two lines side by side in a 320 px dialog.
        // `flex-col-reverse` puts the default at the top and Cancel at the bottom while the DOM
        // (and so the tab order) still starts at Cancel.
        expect(actions.className).toContain('flex-col-reverse');
        // The register's 8 → 12 px applies to both shapes, so the dialog has one gap, not two.
        expect(actions.className).toContain('gap-3');
        const order = [...actions.querySelectorAll('button')].map((el) => el.dataset['testid']);
        expect(order).toEqual(['confirm-cancel', 'confirm-delete-cascade', 'confirm-delete']);
    });

    it('keeps the two-answer shape on one row, at the register’s 12 px gap', () => {
        const onDeleteWorkspace = vi.fn();
        render(<Sidebar {...baseProps()} entries={entries()} onDeleteWorkspace={onDeleteWorkspace} />);
        fireEvent.contextMenu(rowFor(W1));
        fireEvent.click(
            screen.getByTestId('context-menu').querySelector('[data-menu-item="delete"]') as HTMLElement
        );
        const actions = within(screen.getByTestId('confirm-dialog')).getByTestId('confirm-actions');
        expect(actions.className).toContain('justify-end');
        expect(actions.className).toContain('gap-3');
        expect(actions.className).not.toContain('flex-col');
    });
});

// ── the footer chevron menu's height estimate ───────────────────────────────────────

describe('the footer menu’s upward drop is derived from `MenuRow`, not frozen', () => {
    /*
     * `ContextMenu` positions by its TOP edge and this menu drops UPWARD off a bar sitting on
     * the window's bottom edge, so its height is supplied rather than read back. A stale
     * estimate does not look stale — it drops the menu ONTO the bar. When S1/S3 gave `MenuRow`
     * the padding its class list had always declared (16.8 → 24.8 px a row), the constant still
     * said 18, and the audit's "it drops UPWARD, clear of the bar it hangs off" turned red.
     * This ties the constant back to the classes the row and the panel actually carry.
     */
    const PY: Readonly<Record<string, number>> = { '0.5': 2, '1': 4, '1.5': 6, '2': 8 };

    it('matches the row and panel the shared menu really renders', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        fireEvent.click(screen.getByTestId('sidebar-new-menu-toggle'));
        const menu = screen.getByTestId('context-menu');
        const row = menu.querySelector('[role="menuitem"]') as HTMLElement;

        const fontSize = Number(/text-\[(\d+)px\]/.exec(menu.className)?.[1] ?? NaN);
        const rowPadding = PY[/py-([\d.]+)/.exec(row.className)?.[1] ?? ''] ?? NaN;
        const panelPadding = PY[/(?:^|\s)p-([\d.]+)/.exec(menu.className)?.[1] ?? ''] ?? NaN;
        const rowGap = PY[/gap-([\d.]+)/.exec(menu.className)?.[1] ?? ''] ?? NaN;
        // `line-height: 1.4` from `styles.css`'s body rule — the row's own line box.
        const rowHeight = fontSize * 1.4 + rowPadding * 2;

        expect(rowHeight).toBeCloseTo(FOOTER_MENU_ROW_HEIGHT, 5);
        // Two rows, the gap between them, and the panel's padding + 1 px border on each side.
        expect(FOOTER_MENU_ESTIMATED_HEIGHT).toBe(
            Math.ceil(rowHeight * 2 + rowGap + (panelPadding + 1) * 2)
        );
    });
});
