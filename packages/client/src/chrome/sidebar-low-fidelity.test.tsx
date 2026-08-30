/**
 * The LOW-POLISH sidebar fidelity items — `docs/UI-FIDELITY.md` L1…L21.
 *
 * Metrics, tones, glyph weights and the three behaviours hiding among them (the filter's clear
 * button yielding focus, the flexible right-click spacer, the spring-load's fast reveal). Every
 * block names the Swift line the number comes from and asserts THAT number, not "something
 * changed" — the whole tier is invisible one item at a time and only reads as the shipped app
 * when all of it lands.
 *
 * Not here, because they are asserted where the behaviour they belong to already lives:
 * L11 (the label menu's single glyph) in `Sidebar.bulk.test.tsx`, L12 (no key-equivalent column)
 * in `sidebar-polish.test.tsx` + `shortcuts.test.tsx`, and L18 (the status dot's offsets and its
 * centred ring) in `sidebar-agent-dot.test.tsx`.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from './index';
import { rowEnterAnimation, SPRING_LOAD_ENTER_MS } from './Sidebar';
import type { ChromePane, ChromeRepo, ChromeSidebarEntry, ChromeWorkspace } from './types';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

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
        workingDirectory: '/src/app',
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

function entries(options: { collapsed?: boolean; labels?: readonly string[] } = {}): ChromeSidebarEntry[] {
    return [
        {
            kind: 'workspace',
            workspace: workspace(W1, 'alpha', options.labels === undefined ? {} : { labels: [...options.labels] })
        },
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
    const row = screen.getAllByTestId('workspace-row').find((el) => el.dataset['workspaceId'] === id);
    if (row === undefined) throw new Error(`no row for ${id}`);
    return row;
}

function rowIDs(): string[] {
    return screen.getAllByTestId('workspace-row').map((row) => row.getAttribute('data-workspace-id') ?? '');
}

// ── L3: the icon → text gap is NINE ─────────────────────────────────────────────────

describe('L3 — a nine-point gap between the glyph and the name', () => {
    it('is the same 9px on a workspace row and on a group band', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        // `HStack(spacing: 9)` — `WorkspaceRowView.swift:51` and `GroupHeaderRow.swift:38`.
        expect(rowFor(W1).className).toContain('gap-[9px]');
        expect(screen.getByTestId('group-header').className).toContain('gap-[9px]');
        // …and Tailwind's nearest step, which is what both used to carry, is gone.
        expect(rowFor(W1).className).not.toContain('gap-2');
        expect(screen.getByTestId('group-header').className).not.toContain('gap-2');
    });
});

// ── L4: the label chip row ──────────────────────────────────────────────────────────

describe('L4 — the chip row is a three-point-down, non-wrapping, clipping HStack', () => {
    it('sits 3px under the name, never wraps, and lets a long chip truncate', () => {
        render(<Sidebar {...baseProps()} entries={entries({ labels: ['infra', 'a-very-long-label-indeed'] })} />);
        const chips = within(rowFor(W1)).getAllByTestId('label-chip');
        const row = chips[0]?.parentElement as HTMLElement;

        // `VStack(alignment: .leading, spacing: 3)` — `WorkspaceRowView.swift:54`.
        expect(row.className).toContain('mt-[3px]');
        expect(row.className).not.toContain('mt-0.5');
        // An `HStack` does not wrap, and a row whose height depends on its labels is a row the
        // sidebar cannot keep at one height (§H5).
        expect(row.className).toContain('flex-nowrap');
        expect(row.className).not.toContain('flex-wrap');
        // `.lineLimit(1)` — `WorkspaceLabelViews.swift:47`.
        for (const chip of chips) {
            expect(chip.className).toContain('truncate');
            expect(chip.className).toContain('min-w-0');
        }
    });

    it('draws the `+N` overflow indicator at 9px MEDIUM', () => {
        render(<Sidebar {...baseProps()} entries={entries({ labels: ['a', 'b', 'c', 'd'] })} />);
        // `.font(.system(size: 9, weight: .medium))` — `WorkspaceRowView.swift:72`.
        const overflow = within(rowFor(W1)).getByText('+1');
        expect(overflow.className).toContain('text-[9px]');
        expect(overflow.className).toContain('font-medium');
    });
});

// ── L5: the "No matches" empty state ────────────────────────────────────────────────

describe('L5 — the filter empty state keeps its three notes of emphasis', () => {
    it('is a 4px-spaced stack of a 12px medium headline over a 10px sub-line', () => {
        render(<Sidebar {...baseProps()} entries={entries()} filter="zzz" />);
        const empty = screen.getByTestId('sidebar-filter-empty');
        // `VStack(spacing: 4) { … }.padding(.vertical, 24)` — `WorkspaceListView.swift:730-741`.
        expect(empty.className).toContain('gap-1');
        expect(empty.className).toContain('py-6');
        const [headline, subline] = [...empty.children] as HTMLElement[];
        expect(headline?.textContent).toBe('No matches');
        expect(headline?.className).toContain('text-[12px]');
        expect(headline?.className).toContain('font-medium');
        expect(subline?.className).toContain('text-[10px]');
    });
});

// ── L6: the filtered row's "in <group>" caption ─────────────────────────────────────

describe('L6 — the group caption sits BELOW the row, not inside the name column', () => {
    it('is a 9px tertiary line at a 20px leading inset, outside the row box', () => {
        render(<Sidebar {...baseProps()} entries={entries()} filter="beta" />);
        const caption = screen.getByTestId('row-group-caption');
        const row = rowFor(W2);
        // `VStack(alignment: .leading, spacing: 0) { row; Text("in …") }` with
        // `.font(.system(size: 9)).padding(.leading, 20).padding(.bottom, 2)` —
        // `WorkspaceListView.swift:772-796`.
        expect(caption.textContent).toBe('in squad');
        expect(caption.className).toContain('text-[9px]');
        expect(caption.style.paddingLeft).toBe('20px');
        expect(caption.style.paddingBottom).toBe('2px');
        // Outside the row entirely — a sibling under it, which is what keeps the filtered
        // list's rows the same height as the main list's.
        expect(row.contains(caption)).toBe(false);
        expect(row.nextElementSibling).toBe(caption);
    });
});

// ── L8: the collapse chevron ────────────────────────────────────────────────────────

describe('L8 — the collapse chevron is 11pt semibold in the TERTIARY colour', () => {
    it('swaps the glyph (never rotates) at 11px, a heavier stroke and the tertiary token', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const chevron = screen.getByTestId('group-chevron');
        // `.font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.textTertiary)` —
        // `GroupHeaderRow.swift:85-89`.
        expect(chevron.style.color).toContain('--kelpi-fg-tertiary');
        const svg = chevron.querySelector('svg') as SVGElement;
        expect(svg.getAttribute('width')).toBe('11');
        expect(svg.getAttribute('stroke-width')).toBe('1.6');
        // Both apps swap `chevron.down` for `chevron.right`; neither invents a rotation.
        expect(svg.getAttribute('data-icon')).toBe('chevron-down');
        fireEvent.click(chevron);
        expect((screen.getByTestId('group-chevron').querySelector('svg') as SVGElement).getAttribute('data-icon')).toBe(
            'chevron-right'
        );
    });
});

// ── L9: the "No workspaces" placeholder ─────────────────────────────────────────────

describe('L9 — the empty-group placeholder carries the Swift’s 16pt padding structure', () => {
    it('starts 52px from the list edge and keeps a trailing inset', () => {
        render(
            <Sidebar
                {...baseProps()}
                entries={[
                    ...entries(),
                    {
                        kind: 'group',
                        group: { id: G2, name: 'empty', color: null, icon: null, isCollapsed: false },
                        workspaces: []
                    }
                ]}
            />
        );
        const placeholder = screen.getByTestId('group-empty');
        /*
         * `GroupEmptyRow` is `HStack(spacing: 8) { Spacer().frame(width: 16); Color.clear
         * .frame(width: 4); Text }` inside `.padding(.horizontal, 16)`, so the text starts at
         * 16 + 16 + 8 + 4 + 8 = 52 from the list's leading edge. Here that is the scroller's
         * own `px-2` (8) + `ml-6` (24) + `pl-5` (20).
         */
        expect(placeholder.className).toContain('ml-6');
        expect(placeholder.className).toContain('pl-5');
        expect(placeholder.className).toContain('pr-4');
        expect(placeholder.className).not.toContain('pl-2');
    });
});

// ── L10: the group-band drop preview ────────────────────────────────────────────────

describe('L10 — the drop preview is a wash OVER the band, not a replacement for it', () => {
    it('keeps the group’s own fill and stroke and layers 18% accent on top', () => {
        render(<Sidebar {...baseProps()} entries={entries()} springLoadMs={100_000} />);
        const header = screen.getByTestId('group-header');
        const restingBorder = header.style.border;
        const restingBackground = header.style.backgroundColor;

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        // The header's own band (44–64) resolves to `ontoGroupHeader` — the target
        // `WorkspaceListView.swift:1891-1898` tints.
        fireEvent.mouseMove(window, { clientY: 58 });
        expect(header.dataset['dropPreview']).toBe('true');

        // `Rectangle().fill(Color.accentColor.opacity(0.18))` laid over the band: the fill and
        // the stroke underneath are untouched, so the group's colour still reads through.
        expect(header.style.backgroundColor).toBe(restingBackground);
        expect(header.style.border).toBe(restingBorder);
        expect(header.style.backgroundImage).toContain('linear-gradient');
        expect(header.style.backgroundImage).toContain('var(--kelpi-accent');
        expect(header.style.backgroundImage).toContain('18%');

        fireEvent.mouseUp(window);
    });
});

// ── L7 / L15: the drag counter and the spring-load reveal ───────────────────────────

describe('L7 — the multi-drag counter is a trailing overlay', () => {
    it('is absolutely positioned 4px in from the row box, monospaced, and inert', () => {
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                selectedWorkspaceIDs={new Set([W1, W4])}
            />
        );
        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 40 });
        const badge = within(rowFor(W1)).getByTestId('drag-count');
        /*
         * `.overlay(alignment: .trailing) { … .padding(.trailing, 12) }` over the row's PADDED
         * frame (`WorkspaceListView.swift:1348-1358`) — and this port keeps that frame's
         * trailing 8 as the row's own `marginRight` (M7), so 12 from there is 4 from the row
         * box. Monospaced, semibold, 10pt, and hit-testing off.
         */
        expect(badge.className).toContain('absolute');
        expect(badge.style.right).toBe('4px');
        expect(badge.className).toContain('font-mono');
        expect(badge.className).toContain('text-[10px]');
        expect(badge.className).toContain('font-semibold');
        expect(badge.className).toContain('pointer-events-none');
        fireEvent.mouseUp(window);
    });
});

describe('L15 — a spring-loaded group opens on the fast ease', () => {
    it('plays the 100ms ease-in-out entry, not the 350ms row-enter spring', () => {
        vi.useFakeTimers();
        render(<Sidebar {...baseProps()} entries={entries({ collapsed: true })} springLoadMs={650} />);
        expect(rowIDs()).toEqual([W1, W4]);

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 58 });
        act(() => {
            vi.advanceTimersByTime(700);
        });
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);

        // `withAnimation(.easeInOut(duration: 0.1)) { springLoadedGroupID = target }` —
        // `WorkspaceListView.swift:1989-1991`.
        expect(rowFor(W2).style.animation).toBe(rowEnterAnimation(true));
        expect(rowFor(W2).style.animation).toContain(`${String(SPRING_LOAD_ENTER_MS)}ms`);
        expect(rowFor(W2).style.animation).toContain('ease-in-out');
        expect(rowFor(W2).style.animation).not.toContain('350ms');
        fireEvent.mouseUp(window);
    });

    it('leaves an ordinary insertion on the 350ms entry spring', () => {
        const { rerender } = render(<Sidebar {...baseProps()} entries={entries()} />);
        rerender(
            <Sidebar
                {...baseProps()}
                entries={[...entries(), { kind: 'workspace', workspace: workspace(G2, 'epsilon') }]}
            />
        );
        expect(rowFor(G2).style.animation).toBe(rowEnterAnimation(false));
        expect(rowFor(G2).style.animation).toContain('350ms');
    });
});

// ── L13 / L14 / L19 / L20: the chrome around the list ───────────────────────────────

describe('L13 — the filter’s clear button yields first responder', () => {
    it('clears the text AND drops focus, exactly as Escape does', () => {
        const onFilterChange = vi.fn();
        render(<Sidebar {...baseProps()} entries={entries()} filter="al" onFilterChange={onFilterChange} />);
        const field = screen.getByTestId('sidebar-filter') as HTMLInputElement;
        field.focus();
        expect(document.activeElement).toBe(field);

        fireEvent.click(screen.getByLabelText('Clear filter'));
        // `filterText = ""; isFilterFieldFocused = false` — `WorkspaceListView.swift:657-668`.
        expect(onFilterChange).toHaveBeenCalledWith('');
        expect(document.activeElement).not.toBe(field);
    });
});

describe('L14 — the trailing right-click target flexes to fill the viewport', () => {
    it('is at least 40px and grows, rather than a fixed 32px block', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const spacer = screen.getByTestId('sidebar-spacer');
        // `Color.clear.frame(minHeight: 40, maxHeight: .infinity)` —
        // `WorkspaceListView.swift:335-336`.
        expect(spacer.className).toContain('min-h-10');
        expect(spacer.className).toContain('flex-1');
        expect(spacer.className).not.toContain('h-8');
        // …which only means anything because the scroller is a flex column.
        expect((spacer.parentElement as HTMLElement).className).toContain('flex-col');
    });
});

describe('L19 — the list’s trailing inset is 8, with the row’s own 8 making 16', () => {
    it('pads the scroller symmetrically and leaves the second 8 on the row', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const scroller = screen.getByRole('listbox', { name: 'Workspaces' });
        // `.padding(.trailing, 8)` on the list (`WorkspaceListView.swift:358`) plus the row's
        // call-site `.padding(.horizontal, 8)` (`:1339`) = 16 to the right of a row's box.
        expect(scroller.className).toContain('px-2');
        expect(scroller.className).not.toContain('pr-3');
        expect(rowFor(W1).style.marginRight).toBe('8px');
    });
});

describe('L20 — the footer’s create button is BODY size', () => {
    it('draws label and glyph at 13, not at the chrome default 12', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const button = screen.getByTestId('sidebar-new-workspace');
        // The Swift's label sets no font, so it inherits the system body face
        // (`WorkspaceListView.swift:400-436`) and the `plus` symbol comes with it.
        expect(button.className).toContain('text-[13px]');
        expect(button.className).not.toContain('text-[12px]');
        expect((button.querySelector('svg') as SVGElement).getAttribute('width')).toBe('13');
    });
});

// ── L1 / L2 / L16 / L17 / L21: the two sheets ───────────────────────────────────────

const REPOS: ChromeRepo[] = [{ id: 'r1', name: 'app', path: '/src/app', worktreeBase: '/wt/app' }];

function openWorkspaceSheet(props: Record<string, unknown> = {}): void {
    render(
        <Sidebar
            {...baseProps()}
            entries={entries()}
            profiles={['work']}
            onCreateWorkspace={vi.fn().mockResolvedValue(null) as never}
            {...props}
        />
    );
    fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
}

function openGroupSheet(): void {
    render(<Sidebar {...baseProps()} entries={entries()} onCreateGroup={vi.fn()} />);
    fireEvent.click(screen.getByTestId('sidebar-new-menu-toggle'));
    fireEvent.click(screen.getByTestId('context-menu').querySelector('[data-menu-item="new-group"]') as HTMLElement);
}

describe('L2 — the workspace sheet’s swatches are 24pt at an 8pt gap', () => {
    it('sizes the circles at 24 and draws the selection ring INSIDE them', () => {
        openWorkspaceSheet();
        const row = screen.getByTestId('new-workspace-colors');
        // `HStack(spacing: 8) { Circle().frame(width: 24, height: 24) … }` —
        // `NewWorkspaceSheet.swift:86-97`.
        expect(row.className).toContain('gap-2');
        const swatches = [...row.querySelectorAll('[role="radio"]')] as HTMLElement[];
        expect(swatches.length).toBeGreaterThan(0);
        for (const swatch of swatches) {
            expect(swatch.style.width).toBe('24px');
            expect(swatch.style.height).toBe('24px');
        }
        const selected = swatches.find((swatch) => swatch.dataset['selected'] === 'true') as HTMLElement;
        // `.overlay(Circle().strokeBorder(Color.primary, lineWidth: 2))` — `strokeBorder` is an
        // INWARD stroke, so the swatch never grows under its own selection.
        expect(selected.style.boxShadow).toContain('inset');
        expect(selected.style.boxShadow).toContain('2px');
        expect(selected.style.outline).toBe('');
    });

    it('spaces the sheet’s fields 16 apart', () => {
        openWorkspaceSheet();
        // `VStack(spacing: 16)` — `NewWorkspaceSheet.swift:76`.
        expect(screen.getByTestId('new-workspace-form').className).toContain('gap-4');
    });

    it('lets the keyboard ring reach the colour row (L96’s collateral)', () => {
        /*
         * The row is a TAB STOP with its own arrow-key handling, and
         * `NewWorkspaceSheet.swift:98-99` makes it `.focusable().focused($focusedField, equals:
         * .color)` — a focusable container AppKit rings. §L96 moved the global `:focus-visible`
         * rule into `@layer base` so a control's own `outline-none` finally wins; this row must
         * not be one of the controls that declines it, or a keyboard user would land on it with
         * no indicator at all. (`:focus-visible` does not match a pointer press on a `tabIndex`
         * div, so the ring stays a Tab-only affordance either way.)
         */
        openWorkspaceSheet();
        const row = screen.getByTestId('new-workspace-colors');
        expect(row.tabIndex).toBe(0);
        expect(row.className).not.toContain('outline-none');
        expect(row.style.outline).toBe('');
    });
});

describe('L1 — the group sheet is a labelled row of 16pt swatches', () => {
    it('leads with a "Color" caption and marks the choice with a checkmark inside the swatch', () => {
        openGroupSheet();
        const row = screen.getByTestId('new-group-colors');
        // `HStack(spacing: 6) { Text("Color"); Spacer(); … }` — `NewGroupSheet.swift:28-60`.
        expect(row.className).toContain('gap-1.5');
        expect(row.className).toContain('ml-auto');
        expect((row.parentElement as HTMLElement).textContent).toContain('Color');

        const none = screen.getByTestId('new-group-color-none');
        expect(none.style.width).toBe('16px');
        // The group sheet opens on "no colour", whose swatch carries the checkmark.
        expect(none.textContent).toBe('✓');

        const red = screen.getByTestId('new-group-color-red');
        expect(red.style.width).toBe('16px');
        expect(red.style.height).toBe('16px');
        expect(red.textContent).toBe('');
        fireEvent.click(red);
        // `Image(systemName: "checkmark").font(.system(size: 8, weight: .bold))`, white on the
        // fill — and no ring at all, which is what the port drew instead.
        expect(screen.getByTestId('new-group-color-red').textContent).toBe('✓');
        expect(screen.getByTestId('new-group-color-red').className).toContain('text-[8px]');
        expect(screen.getByTestId('new-group-color-red').style.boxShadow).toBe('');
        expect(screen.getByTestId('new-group-color-none').textContent).toBe('');
    });

    it('spaces the group sheet’s fields 14 apart', () => {
        openGroupSheet();
        // `VStack(alignment: .leading, spacing: 14)` — `NewGroupSheet.swift:16`.
        expect(screen.getByTestId('new-group-form').className).toContain('gap-[14px]');
    });
});

describe('L21 — the Group and Profile pickers are content-sized and trailing', () => {
    it('pushes each picker to the trailing edge instead of stretching it', () => {
        openWorkspaceSheet();
        for (const id of ['new-workspace-group', 'new-workspace-profile']) {
            const picker = screen.getByTestId(id);
            // `HStack { Text; Spacer(); Picker.labelsHidden().pickerStyle(.menu) }` —
            // `NewWorkspaceSheet.swift:104-122`.
            expect(picker.className).toContain('ml-auto');
            expect(picker.className).not.toContain('flex-1');
        }
    });
});

describe('L17 — the worktree fields carry captions, not placeholders', () => {
    it('labels each field above it and leaves the field itself empty', () => {
        openWorkspaceSheet({ repos: REPOS });
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        const picker = screen.getByTestId('new-workspace-repo-picker');
        fireEvent.click(within(picker).getByTestId('repo-choice-r1'));
        fireEvent.click(within(picker).getByTestId('repo-picker-choose'));
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));

        const section = screen.getByTestId('new-workspace-worktree');
        // `VStack(alignment: .leading, spacing: 4) { Text("Worktree name").font(.caption);
        // TextField("", …) }` — `NewWorkspaceSheet.swift:293-319`.
        expect(section.textContent).toContain('Worktree name');
        expect(section.textContent).toContain('Branch name');
        for (const id of ['new-workspace-worktree-name', 'new-workspace-worktree-branch']) {
            const field = screen.getByTestId(id) as HTMLInputElement;
            expect(field.getAttribute('placeholder')).toBeNull();
            const caption = (field.parentElement as HTMLElement).firstElementChild as HTMLElement;
            expect(caption.className).toContain('text-[10px]');
        }
    });
});
