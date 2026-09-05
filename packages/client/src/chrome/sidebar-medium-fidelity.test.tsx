/**
 * The MEDIUM sidebar fidelity items — `../kelpi-docs/UI-FIDELITY.md` M1…M10.
 *
 * Every block below names the Swift line the port had drifted from, and asserts the number or the
 * string that line specifies rather than "something changed". Nothing here re-tests behaviour the
 * neighbouring suites already own (§WS-043's hide rule, §WS-078's mirroring, §WS-068's two-shape
 * prompt) — only the presentation those suites never looked at.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import { ROW_TRAILING_INSET_PX, workspaceColorDisplayName } from './Sidebar';
import type { ChromePane, ChromeRepo, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001'; // alpha, top level
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002'; // beta, in squad
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003'; // gamma, in squad
const W4 = 'aaaaaaaa-0000-4000-8000-000000000004'; // delta, top level
const G1 = 'cccccccc-0000-4000-8000-000000000001'; // squad
const G2 = 'cccccccc-0000-4000-8000-000000000002'; // empty

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

/** alpha · delta · squad[beta, gamma] — the shape every other sidebar suite uses. */
function entries(options: { collapsed?: boolean } = {}): ChromeSidebarEntry[] {
    return [
        { kind: 'workspace', workspace: workspace(W1, 'alpha') },
        { kind: 'workspace', workspace: workspace(W4, 'delta') },
        {
            kind: 'group',
            group: {
                id: G1,
                name: 'squad',
                color: 'green',
                icon: null,
                isCollapsed: options.collapsed ?? false
            },
            workspaces: [workspace(W2, 'beta'), workspace(W3, 'gamma')]
        }
    ];
}

function baseProps() {
    return { activeWorkspaceID: W1, filter: '', onFilterChange: vi.fn(), rowHeight: 20 };
}

function rowFor(id: string): HTMLElement {
    return screen.getAllByTestId('workspace-row').find(
        (row) => row.getAttribute('data-workspace-id') === id
    ) as HTMLElement;
}

/** The ids of a menu's rows, in render order — separators and captions carry none. */
function menuOrder(scope: HTMLElement): string[] {
    return [...scope.querySelectorAll('[data-menu-item]')].map(
        (el) => el.getAttribute('data-menu-item') ?? ''
    );
}

function openSubmenu(menu: HTMLElement, id: string): HTMLElement {
    fireEvent.mouseEnter(menu.querySelector(`[data-menu-item="${id}"]`) as HTMLElement);
    return screen.getByTestId('context-submenu');
}

// ── M1: the guide rule does not stop at an empty group ───────────────────────────────

describe('M1 — the group guide runs through the "No workspaces" placeholder', () => {
    /** squad[beta] and an EMPTY group of the same colour, so the two guides are comparable. */
    function withEmptyGroup(color: ChromeSidebarEntry extends never ? never : 'green' | null): ChromeSidebarEntry[] {
        return [
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
                workspaces: [workspace(W2, 'beta')]
            },
            {
                kind: 'group',
                group: { id: G2, name: 'empty', color, icon: null, isCollapsed: false },
                workspaces: []
            }
        ];
    }

    it('draws the same 1.5px rule at the same 18px inset a child row draws', () => {
        render(<Sidebar {...baseProps()} entries={withEmptyGroup('green')} />);
        const placeholder = screen.getByTestId('group-empty');
        const guide = within(placeholder).getByTestId('group-guide');

        // `WorkspaceListView.swift:311-328` — `Rectangle().fill(color).frame(width: 1.5)` at
        // `groupGuideLeadingInset` 18, which from the row's own 24px indent is −6.
        expect(guide.style.width).toBe('1.5px');
        expect(guide.style.left).toBe('-6px');
        expect(guide.style.position).toBe('absolute');
        // …and it is a full-height segment: an empty group has no sibling to bridge to, so
        // neither edge is pulled out over the outer gap.
        expect(guide.style.top).toBe('0px');
        expect(guide.style.bottom).toBe('0px');
        // The placeholder is the positioned ancestor, or the rule would land on the scroller.
        expect(placeholder.style.position === 'relative' || placeholder.className.includes('relative')).toBe(
            true
        );
    });

    /**
     * S47 (owner-directed) moved the placeholder onto the list's 4px pitch, and the rule rides
     * the box: the segment used to begin 2.00px under its band where a one-member group's
     * begins 4.00px under its own, so the two runs did not line up. The margins are the whole of
     * that difference — `top`/`bottom` stay 0, because an unbridged segment spans its own box —
     * so asserting them is asserting where the rule starts, with no box model to measure in.
     */
    it('starts where a one-member group’s rule starts, now the box is on the pitch (S47)', () => {
        render(<Sidebar {...baseProps()} entries={withEmptyGroup('green')} />);
        const placeholder = screen.getByTestId('group-empty');
        const memberRow = rowFor(W2);
        expect(placeholder.style.marginTop).toBe(memberRow.style.marginTop);
        expect(placeholder.style.marginBottom).toBe(memberRow.style.marginBottom);
        expect(placeholder.style.marginTop).toBe('2px');

        // Both segments are unbridged — the placeholder has no sibling, W2 is squad's only
        // member — so each spans its own box exactly, and equal margins put the two starts the
        // same distance under their bands.
        for (const guide of [
            within(placeholder).getByTestId('group-guide'),
            within(memberRow).getByTestId('group-guide')
        ]) {
            expect(guide.style.top).toBe('0px');
            expect(guide.style.bottom).toBe('0px');
            expect(guide.style.left).toBe('-6px');
            expect(guide.style.width).toBe('1.5px');
        }
    });

    it('takes the group’s own colour — the same expression a child row’s does', () => {
        render(<Sidebar {...baseProps()} entries={withEmptyGroup('green')} />);
        const onRow = within(rowFor(W2)).getByTestId('group-guide');
        const onPlaceholder = within(screen.getByTestId('group-empty')).getByTestId('group-guide');
        // Both groups are green, so `groupChildGuideColor` returns the same colour for the
        // `.workspaceRow` case and the `.groupEmpty` case (`WorkspaceListView.swift:465-479`).
        expect(onPlaceholder.style.background).toBe(onRow.style.background);
        expect(onPlaceholder.style.background).not.toBe('');
    });

    it('falls back to the divider for a COLOURLESS group rather than drawing nothing', () => {
        render(<Sidebar {...baseProps()} entries={withEmptyGroup(null)} />);
        const guide = within(screen.getByTestId('group-empty')).getByTestId('group-guide');
        // `group.color?.color ?? chromeTheme.divider` — the `??` is the only branch, and the
        // fallback is the theme's divider token (`tokens.divider` = `--kelpi-border`), read live
        // rather than frozen as a hex.
        expect(guide.style.background).toContain('var(--kelpi-border');
    });
});

// ── M2 / M3: the two context menus ───────────────────────────────────────────────────

describe('M2 — the row and group menus are in the Swift’s order', () => {
    it('a row is Rename / Color / Profile / Change Icon / Labels / Move', () => {
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                profiles={['work']}
                onSetWorkspaceProfile={vi.fn()}
                onSetWorkspaceColor={vi.fn()}
                onToggleWorkspaceLabel={vi.fn()}
            />
        );
        fireEvent.contextMenu(rowFor(W1));
        // `WorkspaceListView.swift:896-910`. The verbs after the divider are §WS-053's and were
        // never in dispute; the six above it are what M2 is about.
        expect(menuOrder(screen.getByTestId('context-menu')).slice(0, 6)).toEqual([
            'rename',
            'color',
            'profile',
            'icon',
            'labels',
            'move'
        ]);
    });

    it('a group is New Workspace / Rename / Color / Change Icon / Expand|Collapse / Delete', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onSetGroupColor={vi.fn()} />);
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        // `WorkspaceListView.swift:1183-1207` — the same Color-before-Change-Icon order.
        expect(menuOrder(screen.getByTestId('context-menu'))).toEqual([
            'new-workspace',
            'rename',
            'color',
            'icon',
            'collapse',
            'delete'
        ]);
    });
});

describe('M3 — Color submenus read `WorkspaceColor.displayName`', () => {
    const DISPLAY = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Gray', 'Black', 'White'];

    it('capitalises the first letter and leaves the rest alone', () => {
        // `rawValue.capitalized` (`WorkspaceColor.swift:36`).
        expect(workspaceColorDisplayName('gray')).toBe('Gray');
        expect(workspaceColorDisplayName('')).toBe('');
    });

    it('on a row’s submenu', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onSetWorkspaceColor={vi.fn()} />);
        fireEvent.contextMenu(rowFor(W1));
        const submenu = openSubmenu(screen.getByTestId('context-menu'), 'color');
        expect(
            [...submenu.querySelectorAll('[data-menu-item]')].map((el) =>
                // The ticked row carries the checkmark glyph in the same text node.
                (el.textContent ?? '').trim().replace(/^[✓✔–]\s*/, '')
            )
        ).toEqual(DISPLAY);
    });

    it('and on the BULK submenu, which is the same `ForEach`', () => {
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                selectedWorkspaceIDs={new Set([W1, W4])}
                onSetBulkColor={vi.fn()}
            />
        );
        fireEvent.contextMenu(rowFor(W1));
        const submenu = openSubmenu(screen.getByTestId('context-menu'), 'bulk-color');
        expect(
            [...submenu.querySelectorAll('[data-menu-item]')].map((el) =>
                // The ticked row carries the checkmark glyph in the same text node.
                (el.textContent ?? '').trim().replace(/^[✓✔–]\s*/, '')
            )
        ).toEqual(DISPLAY);
    });
});

// ── M5: the custom-emoji sheet ───────────────────────────────────────────────────────

describe('M5 — the custom-emoji sheet names its subject and says what it wants', () => {
    function openEmojiSheet(target: HTMLElement): void {
        fireEvent.contextMenu(target);
        fireEvent.mouseEnter(
            screen.getByTestId('context-menu').querySelector('[data-menu-item="icon"]') as HTMLElement
        );
        fireEvent.click(
            screen.getByTestId('context-submenu').querySelector('[data-menu-item="icon:custom"]') as HTMLElement
        );
    }

    it('titles itself `Custom Emoji for "<group>"` and carries the caption', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onSetGroupIcon={vi.fn()} />);
        openEmojiSheet(screen.getByTestId('group-header'));

        const sheet = screen.getByTestId('emoji-sheet');
        // `GroupCustomEmojiSheet.swift:24-25`.
        expect(within(sheet).getByTestId('emoji-sheet-title').textContent).toBe('Custom Emoji for “squad”');
        // `:27-31` — the paragraph the port had dropped entirely.
        const caption = within(sheet).getByTestId('emoji-sheet-caption').textContent ?? '';
        expect(caption).toContain('single emoji or symbol');
        expect(caption).toContain('Letters, digits, and punctuation are rejected');
        // `.frame(width: 340)`, not 280.
        expect(sheet.className).toContain('w-[340px]');
        // The dialog's accessible name is the title, so the sheet is findable by what it says.
        expect(sheet.getAttribute('aria-label')).toBe('Custom Emoji for “squad”');
    });

    it('and names a WORKSPACE when that is what it was raised from', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onSetWorkspaceIcon={vi.fn()} />);
        openEmojiSheet(rowFor(W1));
        expect(screen.getByTestId('emoji-sheet-title').textContent).toBe('Custom Emoji for “alpha”');
    });
});

// ── M6: the selection header ─────────────────────────────────────────────────────────

describe('M6 — the selection header’s buttons, padding and scope', () => {
    it('renders Select All / Clear as accent buttons at 6px vertical padding', () => {
        render(<Sidebar {...baseProps()} entries={entries()} selectedWorkspaceIDs={new Set([W1])} />);
        const header = screen.getByTestId('selection-header');
        // `.padding(.vertical, 6)` (`WorkspaceListView.swift:848`).
        expect(header.className).toContain('py-1.5');
        for (const label of ['Select All', 'Clear']) {
            // `.buttonStyle(.borderless)` — accent text, not the strip's body colour.
            expect((within(header).getByText(label) as HTMLElement).style.color).toContain('--kelpi-accent');
        }
    });

    it('offers Select All while a COLLAPSED group still hides unselected rows', () => {
        const onSelectionChange = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries({ collapsed: true })}
                // Both VISIBLE rows are selected; beta and gamma are inside the collapsed group.
                selectedWorkspaceIDs={new Set([W1, W4])}
                onSelectionChange={onSelectionChange}
            />
        );
        const header = screen.getByTestId('selection-header');
        // `if count < store.workspaces.count` (`:838`) — the whole set, not the visible order.
        expect(within(header).getByText('Select All')).toBeTruthy();

        fireEvent.click(within(header).getByText('Select All'));
        // …and it selects all four, exactly as the menu's own "Select All Workspaces" does
        // (§WS-045), rather than the two the eye can see.
        expect(onSelectionChange).toHaveBeenCalledWith(new Set([W1, W4, W2, W3]));
    });
});

// ── M7 / M8: row and band metrics ────────────────────────────────────────────────────

describe('M7 — the band is 8px wider on the right than the rows it heads', () => {
    it('gives a workspace row a trailing inset and a group band none', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        expect(rowFor(W1).style.marginRight).toBe(`${String(ROW_TRAILING_INSET_PX)}px`);
        // `GroupHeaderRow.swift:107` is `.padding(.leading, 8)` — leading only.
        expect(screen.getByTestId('group-header').style.marginRight).toBe('');
    });

    it('and the inset is outside the ring, so a nested row keeps its own indent', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const nested = rowFor(W2);
        expect(nested.style.marginRight).toBe('8px');
        // §WS-089's indent is untouched by M7 — the two margins are independent.
        expect(nested.style.marginLeft).toBe('24px');
    });
});

describe('M8 — the avatar and band glyphs are the Swift’s sizes and faces', () => {
    it('draws the avatar LETTER at 11 bold in the rounded face', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        // `Text(avatarGlyph).font(.system(size: 11, weight: .bold, design: .rounded))`
        // (`WorkspaceRowView.swift:145`).
        const letter = within(rowFor(W1)).getByText('A');
        expect(letter.className).toContain('text-[11px]');
        expect(letter.className).toContain('font-bold');
        expect(letter.style.fontFamily).toContain('ui-rounded');
    });

    it('and an avatar EMOJI a point larger, in no particular face', () => {
        const withEmoji: ChromeSidebarEntry[] = [
            {
                kind: 'workspace',
                workspace: workspace(W1, 'alpha', { icon: { kind: 'emoji', grapheme: '🚀' } })
            }
        ];
        render(<Sidebar {...baseProps()} entries={withEmoji} />);
        // `Text(grapheme).font(.system(size: 12))` (`:137`).
        const glyph = within(rowFor(W1)).getByText('🚀');
        expect(glyph.className).toContain('text-[12px]');
        expect(glyph.style.fontFamily).toBe('');
    });

    it('and the group band’s folder at 14 in a 13px glyph slot', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const header = screen.getByTestId('group-header');
        // `Image(systemName: "folder.fill").font(.system(size: 14))` (`GroupHeaderRow.swift:148`).
        expect(header.querySelector('svg[data-icon="folder"]')?.getAttribute('width')).toBe('14');
        // …inside the slot an emoji icon would render in: `Text(grapheme).font(.system(size: 13))`.
        expect((header.querySelector('span') as HTMLElement).className).toContain('text-[13px]');
    });
});

// ── M9: Create is the default action ─────────────────────────────────────────────────

describe('M9 — Create is the sheet’s default action', () => {
    const REPOS: ChromeRepo[] = [{ id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/wt/app' }];

    function openSheet(props: Record<string, unknown> = {}) {
        const onCreateWorkspace = vi.fn().mockResolvedValue(null);
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                profiles={['work']}
                onCreateWorkspace={onCreateWorkspace as never}
                {...props}
            />
        );
        fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
        return onCreateWorkspace;
    }

    it('is a FILLED accent button, louder than the Cancel beside it', () => {
        openSheet();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        const submit = screen.getByTestId('new-workspace-submit');
        const cancel = screen.getByTestId('new-workspace-cancel');
        // `.keyboardShortcut(.defaultAction)` (`NewWorkspaceSheet.swift:205`) — AppKit's filled
        // accent push button.
        expect(submit.getAttribute('data-default-action')).toBe('true');
        expect(submit.style.background).toContain('--kelpi-accent');
        expect(submit.style.color).toBe('rgb(255, 255, 255)');
        // Cancel stays the plain bordered button it always was — the two must not read alike.
        expect(cancel.style.background).toBe('');
        expect(submit.style.background).not.toBe(cancel.style.background);
        /*
         * SPACING-REVIEW S10 — and they are the same BOX, which is a different claim from
         * reading differently. Both class lists were dead until S1 was layered (live, before:
         * Create 37.59 × 16.80 at `padding: 0px`, its accent fill painted on the ink of the
         * word; Cancel 38.82 × 16.80 with no border at all). The row asks for
         * `padding: '4px 10px'` on both, and Cancel was still 2 px short of it.
         */
        expect(cancel.className).toContain('px-2.5');
        expect(submit.className).toContain('px-2.5');
        expect(cancel.className).not.toContain('px-2 ');
    });

    it('stays a filled push button when disabled rather than turning into an outline', () => {
        openSheet();
        const submit = screen.getByTestId('new-workspace-submit') as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        expect(submit.style.background).not.toBe('');
        expect(submit.style.background).not.toContain('--kelpi-accent');
    });

    it('takes Return from a control the browser would never submit from', async () => {
        const onCreateWorkspace = openSheet({ repos: REPOS });
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        // A `<select>` is not a text input, so implicit form submission does not fire from it —
        // which is exactly the gap `.defaultAction` does not have.
        fireEvent.keyDown(screen.getByTestId('new-workspace-profile'), { key: 'Enter' });
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledTimes(1);
        });
        expect(onCreateWorkspace).toHaveBeenCalledWith('ws', null, undefined, expect.anything());
    });

    it('and Return from the name field still submits exactly once', async () => {
        const onCreateWorkspace = openSheet();
        const name = screen.getByLabelText('New workspace name');
        fireEvent.change(name, { target: { value: 'ws' } });
        fireEvent.keyDown(name, { key: 'Enter' });
        await waitFor(() => {
            expect(onCreateWorkspace).toHaveBeenCalledTimes(1);
        });
    });

    it('and Return does nothing at all while Create is disabled', () => {
        const onCreateWorkspace = openSheet();
        fireEvent.keyDown(screen.getByLabelText('New workspace name'), { key: 'Enter' });
        expect(onCreateWorkspace).not.toHaveBeenCalled();
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
    });
});

// ── M10: the group-delete prompt's title ─────────────────────────────────────────────

describe('M10 — the group-delete prompt titles itself like the workspace one', () => {
    it('reads `Delete "<name>"?` and leaves the consequence to the detail line', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onDeleteGroup={vi.fn()} />);
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.click(screen.getByText('Delete Group…'));

        const dialog = screen.getByTestId('confirm-dialog');
        // `groupDeleteTitle` (`WorkspaceListView.swift:859-863`).
        expect(dialog.textContent).toContain('Delete “squad”?');
        expect(dialog.textContent).not.toContain('Delete the group');
        // The membership consequence is still said — in the line that exists to say it.
        expect(within(dialog).getByTestId('confirm-group-detail').textContent).toContain(
            'also delete the 2 workspaces'
        );
    });
});
