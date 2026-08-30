/**
 * The sidebar interactions shell-ui.md §5.5/§5.6/§15 specify but WP3.4 left for later:
 * spring-loaded groups, drag auto-scroll, multi-row drag consolidation, the one-shot
 * scroll-new-entry-into-view, and the "Change Icon" picker.
 *
 * Geometry note: the rows are 20 px with the 4 px content padding, and jsdom's
 * `getBoundingClientRect` is all zeros — so `contentY(clientY) === clientY` and the zone
 * arithmetic is readable in the test (alpha 4–24 · delta 24–44 · header 44–64 · …), exactly
 * as `Sidebar.test.tsx` already relies on.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_KEYBINDINGS } from './keys';
import { CURATED_EMOJI, Sidebar, normalizeEmojiInput } from './index';
// §WS-027's clearance constants come straight off the component, not through the barrel: the
// point of the block that uses them is that the test and the ring read the SAME numbers.
import {
    GROUP_BAND_CORNER_RADIUS_PX,
    ROW_ACTIVE_RING_PX,
    ROW_CORNER_RADIUS_PX,
    ROW_OUTER_GAP_PX,
    ROW_SELECTION_RING_PX,
    ringBleedPx,
    ringOffsetPx
} from './Sidebar';
import type { ChromePane, ChromeSidebarEntry, ChromeWorkspace } from './types';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001'; // alpha (top level)
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002'; // beta  (in squad)
const W3 = 'aaaaaaaa-0000-4000-8000-000000000003'; // gamma (in squad)
const W4 = 'aaaaaaaa-0000-4000-8000-000000000004'; // delta (top level)
// Four more top-level rows, used only by the N4b geometry test's seven-row list.
const W5 = 'aaaaaaaa-0000-4000-8000-000000000005';
const W6 = 'aaaaaaaa-0000-4000-8000-000000000006';
const W7 = 'aaaaaaaa-0000-4000-8000-000000000007';
const W8 = 'aaaaaaaa-0000-4000-8000-000000000008';
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

function entries(options: { collapsed?: boolean; alphaIcon?: ChromeWorkspace['icon'] } = {}): ChromeSidebarEntry[] {
    return [
        {
            kind: 'workspace',
            workspace: workspace(W1, 'alpha', { icon: options.alphaIcon ?? null })
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

function rowIDs(): string[] {
    return screen.getAllByTestId('workspace-row').map((row) => row.getAttribute('data-workspace-id') ?? '');
}

function rowFor(id: string): HTMLElement {
    const row = screen.getAllByTestId('workspace-row').find((el) => el.dataset['workspaceId'] === id);
    if (row === undefined) throw new Error(`no row for ${id}`);
    return row;
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

// ── spring-loaded groups (§5.5) ─────────────────────────────────────────────────────

describe('spring-loaded groups', () => {
    it('expands a collapsed group after the 650 ms dwell, and collapses it again on release', () => {
        vi.useFakeTimers();
        render(<Sidebar {...baseProps()} entries={entries({ collapsed: true })} springLoadMs={650} />);
        expect(rowIDs()).toEqual([W1, W4]);

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        // y=58 is the group header's bottom half (44–64) → hovering "into" the group.
        fireEvent.mouseMove(window, { clientY: 58 });

        // Not yet: a cursor merely transiting a header must not open it.
        act(() => {
            vi.advanceTimersByTime(600);
        });
        expect(rowIDs()).toEqual([W1, W4]);

        act(() => {
            vi.advanceTimersByTime(60);
        });
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);
        expect(screen.getByTestId('group-header').dataset['collapsed']).toBe('false');

        // Release: the spring-load is transient, so the group closes again — and the drop it
        // was opened for is what actually commits (alpha lands inside, hence out of sight).
        fireEvent.mouseUp(window);
        expect(screen.getByTestId('group-header').dataset['collapsed']).toBe('true');
        expect(rowIDs()).not.toContain(W2);
        expect(rowIDs()).not.toContain(W3);
    });

    it('cancels the dwell when the cursor leaves the group', () => {
        vi.useFakeTimers();
        render(<Sidebar {...baseProps()} entries={entries({ collapsed: true })} springLoadMs={650} />);

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 58 });
        act(() => {
            vi.advanceTimersByTime(400);
        });
        // Back up to delta's top half — the dwell restarts from nothing.
        fireEvent.mouseMove(window, { clientY: 28 });
        act(() => {
            vi.advanceTimersByTime(400);
        });

        expect(rowIDs()).toEqual([W1, W4]);
        fireEvent.mouseUp(window);
    });

    it('leaves an already-expanded group alone (nothing to spring)', () => {
        vi.useFakeTimers();
        const onToggleGroupCollapse = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                springLoadMs={10}
                onToggleGroupCollapse={onToggleGroupCollapse}
            />
        );

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 58 });
        act(() => {
            vi.advanceTimersByTime(50);
        });

        // A spring-load is transient by definition: the persisted collapse is never touched.
        expect(onToggleGroupCollapse).not.toHaveBeenCalled();
        fireEvent.mouseUp(window);
    });
});

// ── drag auto-scroll (§5.5) ─────────────────────────────────────────────────────────

describe('drag auto-scroll', () => {
    /** jsdom has no layout, so the scroll container gets a measurable box and a real scrollTop. */
    function scrollableList(): { top: number; get scrollTop(): number } {
        const list = screen.getByRole('listbox');
        let scrollTop = 0;
        Object.defineProperty(list, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
                scrollTop = value;
            }
        });
        list.getBoundingClientRect = () =>
            ({ top: 0, bottom: 100, left: 0, right: 200, width: 200, height: 100, x: 0, y: 0 }) as DOMRect;
        return {
            top: 0,
            get scrollTop() {
                return scrollTop;
            }
        };
    }

    it('scrolls 3 px per 15 ms tick while the cursor sits in the bottom edge zone', () => {
        vi.useFakeTimers();
        render(<Sidebar {...baseProps()} entries={entries()} autoScrollIntervalMs={15} />);
        const list = scrollableList();

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        // 95 is inside the 40 px bottom zone of a viewport ending at 100.
        fireEvent.mouseMove(window, { clientY: 95 });

        act(() => {
            vi.advanceTimersByTime(15);
        });
        expect(list.scrollTop).toBe(3);

        act(() => {
            vi.advanceTimersByTime(45);
        });
        expect(list.scrollTop).toBe(12);

        // Moving back into the middle stops it.
        fireEvent.mouseMove(window, { clientY: 50 });
        act(() => {
            vi.advanceTimersByTime(60);
        });
        expect(list.scrollTop).toBe(12);
        fireEvent.mouseUp(window);
    });

    it('scrolls up in the top edge zone and stops when the drag ends', () => {
        vi.useFakeTimers();
        render(<Sidebar {...baseProps()} entries={entries()} autoScrollIntervalMs={15} />);
        const list = scrollableList();

        fireEvent.mouseDown(rowFor(W4), { clientY: 60 });
        fireEvent.mouseMove(window, { clientY: 10 });
        act(() => {
            vi.advanceTimersByTime(30);
        });
        expect(list.scrollTop).toBe(-6);

        fireEvent.mouseUp(window);
        const settled = list.scrollTop;
        act(() => {
            vi.advanceTimersByTime(60);
        });
        expect(list.scrollTop).toBe(settled);
    });
});

// ── multi-row drag (§5.5) ───────────────────────────────────────────────────────────

describe('multi-row drag', () => {
    function selectBoth(): void {
        fireEvent.click(rowFor(W1), { metaKey: true });
        fireEvent.click(rowFor(W4), { metaKey: true });
    }

    it('drags the whole selection and commits ONE bulk move', () => {
        const onMoveWorkspaces = vi.fn();
        const onMoveWorkspace = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                onMoveWorkspaces={onMoveWorkspaces}
                onMoveWorkspace={onMoveWorkspace}
            />
        );
        selectBoth();

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 95 });

        // The companion row collapses away and the grabbed row wears the `+1` capsule.
        expect(rowFor(W4).dataset['dragHidden']).toBe('true');
        expect(screen.getByTestId('drag-count').textContent).toBe('+1');

        fireEvent.mouseUp(window);
        expect(onMoveWorkspaces).toHaveBeenCalledTimes(1);
        expect(onMoveWorkspaces).toHaveBeenCalledWith({
            workspaceIDs: [W1, W4],
            groupID: G1,
            index: expect.any(Number)
        });
        // Never both: a bulk move and a single move would double-apply the grabbed row.
        expect(onMoveWorkspace).not.toHaveBeenCalled();
    });

    it('falls back to a single move when assembly wires no bulk callback', () => {
        const onMoveWorkspace = vi.fn();
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={onMoveWorkspace} />);
        selectBoth();

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 95 });
        fireEvent.mouseUp(window);

        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
        expect(onMoveWorkspace.mock.calls[0]?.[0]).toMatchObject({ workspaceID: W1 });
    });

    it('a single-row drag is untouched by the multi-drag path', () => {
        const onMoveWorkspaces = vi.fn();
        const onMoveWorkspace = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                onMoveWorkspaces={onMoveWorkspaces}
                onMoveWorkspace={onMoveWorkspace}
            />
        );

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 95 });
        expect(screen.queryByTestId('drag-count')).toBeNull();
        fireEvent.mouseUp(window);

        expect(onMoveWorkspaces).not.toHaveBeenCalled();
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
    });
});

// ── scroll the new entry into view (§15) ────────────────────────────────────────────

describe('scroll-new-entry-into-view', () => {
    let scrolled: HTMLElement[] = [];

    beforeEach(() => {
        scrolled = [];
        Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement): void {
            scrolled.push(this);
        };
    });

    it('scrolls the named row into view exactly once, then reports it handled', () => {
        const onScrollHandled = vi.fn();
        const view = render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                scrollToWorkspaceID={W3}
                onScrollHandled={onScrollHandled}
            />
        );

        expect(scrolled).toHaveLength(1);
        expect(scrolled[0]?.dataset['workspaceId']).toBe(W3);
        expect(onScrollHandled).toHaveBeenCalledTimes(1);

        // Assembly clears it; a later re-render must not scroll again.
        view.rerender(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                scrollToWorkspaceID={null}
                onScrollHandled={onScrollHandled}
            />
        );
        expect(scrolled).toHaveLength(1);
    });

    /**
     * §WS-101: a target this client cannot see at all is DROPPED, not retried forever — the
     * Swift `resolvedScrollTarget` returns nil and the pending target is cleared.
     */
    it('drops a target for a workspace this client cannot see', () => {
        const onScrollHandled = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                scrollToWorkspaceID="not-a-workspace"
                onScrollHandled={onScrollHandled}
            />
        );
        expect(scrolled).toHaveLength(0);
        expect(onScrollHandled).toHaveBeenCalledTimes(1);
    });

    /** §WS-101: a workspace hidden inside a collapsed group resolves to that group's header. */
    it('falls back to the group header when the target is inside a collapsed group', () => {
        const onScrollHandled = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries({ collapsed: true })}
                scrollToWorkspaceID={W3}
                onScrollHandled={onScrollHandled}
            />
        );
        expect(scrolled).toHaveLength(1);
        expect(scrolled[0]?.dataset['testid'] ?? scrolled[0]?.getAttribute('data-testid')).toBe('group-header');
        expect(onScrollHandled).toHaveBeenCalledTimes(1);
    });
});

// ── drag polish (§WS-089, §WS-092, §WS-093) ─────────────────────────────────────────

describe('drag polish', () => {
    it('previews the nested indentation while the cursor holds a group header (§WS-089)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 58 }); // the header's bottom half → append

        // The ORDER is untouched (a header target is preview-only, §WS-087) …
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);
        // … but the SLOT already shows the indentation it is about to have.
        const row = rowFor(W1);
        expect(row.dataset['nestPreview']).toBe('true');
        expect(row.style.marginLeft).toBe('24px');
        /*
         * REPLACED, not dropped. This used to assert §WS-084's lift on the in-flow row —
         * `scale(1.03)`, `opacity: 0.8`, a drop shadow — which is now the CURSOR CLONE's, since
         * the row's own slot is the gap the drop lands in. The lift is asserted on the clone in
         * "the dragged row follows the cursor (§WS-084)" below; what this asserts instead is the
         * stronger half: the slot keeps its box and paints nothing at all.
         */
        expect(row.dataset['dragGap']).toBe('true');
        expect(row.style.visibility).toBe('hidden');
        expect(row.style.transform).toBe('');
        expect(row.style.opacity).toBe('1');

        // Leaving the header for a real drop target takes the preview away again.
        fireEvent.mouseMove(window, { clientY: 30 });
        expect(rowFor(W1).dataset['nestPreview']).toBeUndefined();
        // …and the gap is still a gap: it belongs to the gesture, not to the target.
        expect(rowFor(W1).dataset['dragGap']).toBe('true');
        fireEvent.mouseUp(window);
        // The gesture ended, so the slot is a row again — in the same commit the clone died in.
        expect(rowFor(W1).dataset['dragGap']).toBeUndefined();
        expect(rowFor(W1).style.visibility).toBe('');
    });

    /**
     * REPLACES the three §WS-092 landing tests ("plays the falls-into-the-group landing", "a new
     * drag flushes a landing still in flight", "skips the landing for a spring-loaded group").
     *
     * The scripted 400 ms fall is gone, so there is no pending commit to flush and no branch to
     * skip: every drop commits on release, on the one settle seam. The assertions here are
     * strictly stronger than the three they replace — each configuration is asserted to commit
     * SYNCHRONOUSLY (the old tests allowed a timer), to leave no landing node behind, and to
     * leave nothing pending on the clock afterwards.
     *
     * Parity is stated rather than assumed: the Swift plays the fall only when
     * `expandGroupOnWorkspaceDrop` is FALSE (`WorkspaceListView.swift:1513`) and that setting
     * ships TRUE (`SettingsFeature.swift:41`), so a default install takes the ordinary
     * spring-home branch at `:1539` — which is what this now does in every configuration.
     */
    it('commits a drop onto a collapsed header at once, with no landing (§WS-092)', () => {
        vi.useFakeTimers();
        for (const springLoaded of [false, true]) {
            const onMoveWorkspace = vi.fn();
            render(
                <Sidebar
                    {...baseProps()}
                    entries={entries({ collapsed: true })}
                    springLoadMs={springLoaded ? 650 : 100_000}
                    onMoveWorkspace={onMoveWorkspace}
                />
            );

            fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
            fireEvent.mouseMove(window, { clientY: 58 }); // collapsed group's header
            if (springLoaded) {
                act(() => {
                    vi.advanceTimersByTime(700); // the group springs open under the cursor
                });
            }
            fireEvent.mouseUp(window);

            // The move is already out, on the release itself.
            expect(onMoveWorkspace, String(springLoaded)).toHaveBeenCalledTimes(1);
            expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: W1, groupID: G1, index: 2 });
            // No scripted fall anywhere in the output, and no second commit waiting on a clock.
            expect(document.querySelectorAll('[data-landing]')).toHaveLength(0);
            act(() => {
                vi.advanceTimersByTime(2000);
            });
            expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
            cleanup();
        }
    });

    /**
     * The gap is the drop target's own slot, and it MOVES with the resolution — the shadow
     * re-orders the list live, so the empty space is always where the row would land.
     */
    it('the gap tracks the resolved slot rather than the row’s origin (§WS-084)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);

        // rows: alpha 4–24 · delta 24–44 · header 44–64 · beta 64–84 · gamma 84–104.
        const gaps = (): HTMLElement[] =>
            screen.getAllByTestId('workspace-row').filter((row) => row.dataset['dragGap'] === 'true');
        const gapIndex = (): number => rowIDs().indexOf(gaps()[0]?.dataset['workspaceId'] ?? '');

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 78 }); // deep inside the group's children
        // Exactly ONE slot is vacant, it is the dragged row's, and it has taken the depth of the
        // container the drop resolved to.
        expect(gaps()).toHaveLength(1);
        expect(gaps()[0]?.dataset['workspaceId']).toBe(W1);
        expect(gaps()[0]?.dataset['depth']).toBe('1');
        const inGroup = gapIndex();

        fireEvent.mouseMove(window, { clientY: 8 }); // back out to the top of the list
        expect(gaps()).toHaveLength(1);
        expect(gaps()[0]?.dataset['workspaceId']).toBe(W1);
        expect(gaps()[0]?.dataset['depth']).toBe('0');
        // …and it MOVED: the empty space is the resolved slot, not the row's origin.
        expect(gapIndex()).toBe(0);
        expect(inGroup).toBeGreaterThan(0);
        fireEvent.mouseUp(window);
        expect(gaps()).toHaveLength(0);
    });

    /**
     * §WS-093. jsdom has no box model, so the guard's degradation ("nothing measured at all =
     * nothing to be stale about") is what every other drag test in this file relies on. The
     * dangerous case is a PARTIAL measurement, which is what this stubs.
     */
    it('ignores drag input until every rendered row has been measured (§WS-093)', () => {
        const onMoveWorkspace = vi.fn();
        const original = Element.prototype.getBoundingClientRect;
        // Only the group header measures: four of the five rendered rows are unknown.
        Element.prototype.getBoundingClientRect = function stub(this: HTMLElement): DOMRect {
            const measured = this.dataset['testid'] === 'group-header';
            return {
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                right: 0,
                bottom: measured ? 20 : 0,
                width: 0,
                height: measured ? 20 : 0,
                toJSON: () => ({})
            } as DOMRect;
        };
        try {
            render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={onMoveWorkspace} />);
            fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
            fireEvent.mouseMove(window, { clientY: 95 });
            expect(rowIDs()).toEqual([W1, W4, W2, W3]); // nothing moved: the drag never started
            fireEvent.mouseUp(window);
            expect(onMoveWorkspace).not.toHaveBeenCalled();
        } finally {
            Element.prototype.getBoundingClientRect = original;
        }

        // With the geometry back to jsdom's uniform nothing, the same gesture lands.
        cleanup();
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={onMoveWorkspace} />);
        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 95 });
        fireEvent.mouseUp(window);
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
    });

    /**
     * Defect N4b, in a box model that has margins — the thing jsdom's all-zero rects hid.
     *
     * Sidebar rows carry an outer margin that `getBoundingClientRect().height` does not
     * report, so walking the list by `y += height` puts every row a little higher than it
     * really is and the error compounds. The stubbed gap below stays 2px because the compounding
     * is the subject, not the constant — the live gap is 4px since §WS-027's clearance fix
     * uncollapsed those margins. This stubs a REAL layout (40px rows, a 2px gap, a
     * seven-row list) and drops three quarters of the way down the last row's group header —
     * the exact gesture `run-I` step 80 drives. Under the old accumulate-heights model that
     * point lands past the end of the computed content and resolves to "append at top level";
     * with measured offsets it resolves to the header the cursor is actually over.
     */
    it('resolves a drop against where rows ARE, not where accumulated heights say (N4b)', () => {
        const ids = [W1, W4, W5, W6, W7, W8];
        const tall: ChromeSidebarEntry[] = [
            ...ids.map((id) => ({ kind: 'workspace' as const, workspace: workspace(id, `ws-${id.slice(-1)}`) })),
            {
                kind: 'group' as const,
                group: { id: G1, name: 'squad', color: 'green' as const, icon: null, isCollapsed: true },
                workspaces: [workspace(W2, 'beta')]
            }
        ];
        // tops: 4, 46, 88, 130, 172, 214, header 256 — a 2px gap between 40px rows.
        const tops = new Map(ids.map((id, index) => [id, 4 + index * 42]));
        const headerTop = 4 + ids.length * 42;

        const original = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function stub(this: HTMLElement): DOMRect {
            const box = (top: number, height: number): DOMRect =>
                ({
                    x: 0,
                    y: top,
                    top,
                    left: 0,
                    right: 200,
                    bottom: top + height,
                    width: 200,
                    height,
                    toJSON: () => ({})
                }) as unknown as DOMRect;
            if (this.getAttribute('role') === 'listbox') return box(0, 600);
            if (this.dataset['testid'] === 'group-header') return box(headerTop, 40);
            const id = this.dataset['workspaceId'];
            if (this.dataset['testid'] === 'workspace-row' && id !== undefined) return box(tops.get(id) ?? 0, 40);
            return box(0, 0);
        };
        try {
            const onMoveWorkspace = vi.fn();
            render(
                <Sidebar
                    {...baseProps()}
                    entries={tall}
                    rowHeight={40}
                    springLoadMs={100_000}
                    onMoveWorkspace={onMoveWorkspace}
                />
            );

            fireEvent.mouseDown(rowFor(W1), { clientY: 24 });
            fireEvent.mouseMove(window, { clientY: headerTop + 30 });

            // The diagnostic says what the drag loop decided, so a future regression names
            // itself instead of showing up as "the header did not tint".
            const list = screen.getByRole('listbox');
            expect(list.dataset['dragActive']).toBe('true');
            expect(list.dataset['dragTarget']).toBe(`ontoGroupHeader:${G1}`);

            expect(screen.getByTestId('group-header').dataset['dropPreview']).toBe('true');
            expect(rowFor(W1).dataset['nestPreview']).toBe('true');
            // Preview-only: the order under the cursor has not moved.
            expect(rowIDs()).toEqual(ids);

            fireEvent.mouseUp(window);
            expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: W1, groupID: G1, index: 1 });
        } finally {
            Element.prototype.getBoundingClientRect = original;
        }
    });
});

// ── Change Icon (§5.6) ──────────────────────────────────────────────────────────────

describe('change icon', () => {
    function openIconSubmenu(row: HTMLElement): HTMLElement {
        fireEvent.contextMenu(row);
        fireEvent.mouseEnter(screen.getByTestId('context-menu').querySelector('[data-menu-item="icon"]') as HTMLElement);
        return screen.getByTestId('context-submenu');
    }

    it('sets an SF Symbol token, passing the name through untouched', () => {
        const onSetWorkspaceIcon = vi.fn();
        render(<Sidebar {...baseProps()} entries={entries()} onSetWorkspaceIcon={onSetWorkspaceIcon} />);

        const submenu = openIconSubmenu(rowFor(W1));
        fireEvent.click(submenu.querySelector('[data-menu-item="icon:symbol:hammer"]') as HTMLElement);

        expect(onSetWorkspaceIcon).toHaveBeenCalledWith(W1, 'system:hammer');
    });

    it('sets a curated emoji and offers "Reset to Letter" only when an icon is set', () => {
        const onSetWorkspaceIcon = vi.fn();
        const view = render(
            <Sidebar
                {...baseProps()}
                entries={entries({ alphaIcon: { kind: 'emoji', grapheme: '🔥' } })}
                onSetWorkspaceIcon={onSetWorkspaceIcon}
            />
        );

        let submenu = openIconSubmenu(rowFor(W1));
        expect((submenu.querySelector('[data-menu-item="icon:reset"]') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(submenu.querySelector('[data-menu-item="icon:emoji:📁"]') as HTMLElement);
        expect(onSetWorkspaceIcon).toHaveBeenCalledWith(W1, 'emoji:📁');

        view.rerender(
            <Sidebar {...baseProps()} entries={entries()} onSetWorkspaceIcon={onSetWorkspaceIcon} />
        );
        submenu = openIconSubmenu(rowFor(W1));
        expect((submenu.querySelector('[data-menu-item="icon:reset"]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('clears the icon back to the letter avatar', () => {
        const onSetWorkspaceIcon = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries({ alphaIcon: { kind: 'system', name: 'star' } })}
                onSetWorkspaceIcon={onSetWorkspaceIcon}
            />
        );

        const submenu = openIconSubmenu(rowFor(W1));
        fireEvent.click(submenu.querySelector('[data-menu-item="icon:reset"]') as HTMLElement);
        expect(onSetWorkspaceIcon).toHaveBeenCalledWith(W1, null);
    });

    it('truncates to one grapheme and rejects a non-emoji one (§WS-072/§WS-073)', () => {
        const onSetWorkspaceIcon = vi.fn();
        render(<Sidebar {...baseProps()} entries={entries()} onSetWorkspaceIcon={onSetWorkspaceIcon} />);

        const submenu = openIconSubmenu(rowFor(W1));
        fireEvent.click(submenu.querySelector('[data-menu-item="icon:custom"]') as HTMLElement);

        const sheet = screen.getByTestId('emoji-sheet');
        const input = within(sheet).getByTestId('emoji-input') as HTMLInputElement;
        const submit = within(sheet).getByTestId('emoji-submit') as HTMLButtonElement;

        expect(submit.disabled).toBe(true);
        // The field TRUNCATES rather than refusing a long value — `ab` becomes `a`…
        fireEvent.change(input, { target: { value: 'ab' } });
        expect(input.value).toBe('a');
        // …and `a` is still not an icon, so Set Icon stays disabled and says why.
        expect(submit.disabled).toBe(true);
        expect(within(sheet).getByTestId('emoji-hint').textContent).toContain('not icons');

        // Digits and punctuation are rejected for the same reason.
        for (const rejected of ['7', '-', 'Ω']) {
            fireEvent.change(input, { target: { value: rejected } });
            expect(submit.disabled, rejected).toBe(true);
        }

        // A ZWJ sequence is ONE grapheme; `[...value].length` would call it five.
        fireEvent.change(input, { target: { value: '👩‍👩‍👧' } });
        expect(input.value).toBe('👩‍👩‍👧');
        expect(submit.disabled).toBe(false);
        fireEvent.click(submit);

        expect(onSetWorkspaceIcon).toHaveBeenCalledWith(W1, 'emoji:👩‍👩‍👧');
        expect(screen.queryByTestId('emoji-sheet')).toBeNull();
    });

    it('the browse grid fills the field with a curated emoji (the palette stand-in)', () => {
        const onSetWorkspaceIcon = vi.fn();
        render(<Sidebar {...baseProps()} entries={entries()} onSetWorkspaceIcon={onSetWorkspaceIcon} />);

        const submenu = openIconSubmenu(rowFor(W1));
        fireEvent.click(submenu.querySelector('[data-menu-item="icon:custom"]') as HTMLElement);
        const sheet = screen.getByTestId('emoji-sheet');

        fireEvent.click(within(sheet).getByTestId('emoji-browse-🚀'));
        expect((within(sheet).getByTestId('emoji-input') as HTMLInputElement).value).toBe('🚀');
        fireEvent.click(within(sheet).getByTestId('emoji-submit'));
        expect(onSetWorkspaceIcon).toHaveBeenCalledWith(W1, 'emoji:🚀');
    });

    it('every curated emoji the menu offers passes the heuristic', () => {
        for (const grapheme of CURATED_EMOJI) {
            expect(normalizeEmojiInput(grapheme), grapheme).toBe(grapheme);
        }
    });

    it('sets a group icon from the group menu', () => {
        const onSetGroupIcon = vi.fn();
        render(<Sidebar {...baseProps()} entries={entries()} onSetGroupIcon={onSetGroupIcon} />);

        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.mouseEnter(
            screen.getByTestId('context-menu').querySelector('[data-menu-item="icon"]') as HTMLElement
        );
        fireEvent.click(
            screen.getByTestId('context-submenu').querySelector('[data-menu-item="icon:symbol:folder"]') as HTMLElement
        );

        expect(onSetGroupIcon).toHaveBeenCalledWith(G1, 'system:folder');
    });
});

// ── L12: no shortcut hints in any sidebar menu ──────────────────────────────────────

describe('menu shortcut hints', () => {
    /*
     * The register's L12 is a whole-app class: every sidebar menu is a `.contextMenu` of plain
     * `Button`s (`WorkspaceListView.swift:897`, `:1183`, `:344-350`), none of which carries
     * `.keyboardShortcut`, so `NSMenu` draws no key-equivalent column at all. The port
     * advertised ⇧⌘R on Rename…, ⌘N on New Workspace and ⌘⇧G on New Group. The keys still fire;
     * the menus no longer restate them, and `keyBindings` stopped being a `SidebarProps` field
     * because the hints were the only thing it fed.
     */
    it('draws no hint on a row menu or a group menu', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);

        fireEvent.contextMenu(rowFor(W1));
        expect(screen.getByTestId('context-menu').querySelector('[data-menu-item="rename"]')).not.toBeNull();
        expect(screen.queryByTestId('menu-shortcut')).toBeNull();
        fireEvent.keyDown(globalThis.document, { key: 'Escape' });

        fireEvent.contextMenu(screen.getByTestId('group-header'));
        expect(screen.getByTestId('context-menu').querySelector('[data-menu-item="new-workspace"]')).not.toBeNull();
        expect(screen.queryByTestId('menu-shortcut')).toBeNull();
    });
});

// ── §WS-007 / §WS-008 / §WS-088 / §WS-094: the drag affordances ─────────────────────

describe('sidebar drag affordances', () => {
    it('joins an expanded group’s children with a continuous guide rule (§WS-007)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const guides = screen.getAllByTestId('group-guide');
        // Two children, two segments — and none on the two top-level rows.
        expect(guides).toHaveLength(2);
        expect(screen.getAllByTestId('workspace-row').map((row) => row.dataset['guide'])).toEqual([
            undefined,
            undefined,
            'true',
            'true'
        ]);

        // The rule sits at the 18px leading inset: 6px back from the row's 24px indent…
        for (const guide of guides) {
            expect(guide.style.left).toBe('-6px');
            expect(guide.style.width).toBe('1.5px');
        }
        // …and each segment bridges the gap to the sibling it has, so the run reads as one
        // line: the first child extends DOWN only, the last extends UP only.
        expect([guides[0]?.style.top, guides[0]?.style.bottom]).toEqual(['0px', '-2px']);
        expect([guides[1]?.style.top, guides[1]?.style.bottom]).toEqual(['-2px', '0px']);
    });

    it('tints the guide with the group’s colour, or the divider when it has none (§WS-007)', () => {
        const { rerender } = render(<Sidebar {...baseProps()} entries={entries()} />);
        const tinted = (screen.getAllByTestId('group-guide')[0] as HTMLElement).style.background;

        const colourless = entries();
        colourless[2] = {
            kind: 'group',
            group: { id: G1, name: 'squad', color: null, icon: null, isCollapsed: false },
            workspaces: [workspace(W2, 'beta'), workspace(W3, 'gamma')]
        };
        rerender(<Sidebar {...baseProps()} entries={colourless} />);
        const plain = (screen.getAllByTestId('group-guide')[0] as HTMLElement).style.background;

        expect(tinted).not.toBe('');
        expect(plain).not.toBe('');
        expect(tinted).not.toBe(plain);
    });

    /**
     * REPLACES "marks the landing slot with a 2px accent rule while dragging (§WS-088)", and is
     * strictly stronger than it: where that asserted the line's presence at ONE phase and its
     * absence at three, this asserts its absence at EVERY phase of a whole gesture — press,
     * top-level slot, group header, a slot inside the group, and release — by two independent
     * queries (the node's `data-testid` and the row attribute that used to flag it), and adds
     * the assertion the old one could not make: that nothing inside a gap paints at all.
     *
     * Parity, not preference. `dropIndicatorOverlay` (`WorkspaceListView.swift:1864`) is gated
     * on `!shouldLiveApplyDropTarget(target)`, which is false for every SLOT target — so the
     * `case .topLevel, .intoGroup` branch that draws the 2pt `Rectangle` is unreachable in the
     * shipped app, and `dropIndicatorLineY` returns `nil` for the one target that does reach
     * the overlay. The original draws a header tint and nothing else, which is now what this
     * does. The slot indicator in both apps is the row movement itself — here, the vacated gap.
     */
    it('draws NO insertion line at any phase of a drag; the gap is the slot indicator (§WS-088)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);

        /** Every way the removed rule could still be on screen, at once. */
        const lineNodes = (): number =>
            document.querySelectorAll('[data-testid="drop-insert-line"]').length +
            document.querySelectorAll('[data-insert-line]').length;
        const gaps = (): HTMLElement[] =>
            screen.getAllByTestId('workspace-row').filter((row) => row.dataset['dragGap'] === 'true');
        /**
         * The gap hides by `visibility: hidden`, which a CHILD can opt back out of — that is
         * exactly how the line used to stay painted inside an invisible row. Nothing may do
         * that any more, so the empty slot is empty in the strong sense.
         */
        const optOuts = (): number =>
            gaps().flatMap((gap) =>
                Array.from(gap.querySelectorAll<HTMLElement>('*')).filter(
                    (child) => child.style.visibility === 'visible'
                )
            ).length;

        // Phase 1 — a press is not a drag: no line, and no gap either.
        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        expect(lineNodes()).toBe(0);
        expect(gaps()).toHaveLength(0);

        // Phase 2 — y=30 is delta's zone (24–44): a `topLevel` SLOT target. The old line's one
        // and only case, and the indicator here is the vacated gap.
        fireEvent.mouseMove(window, { clientY: 30 });
        expect(lineNodes()).toBe(0);
        expect(optOuts()).toBe(0);
        expect(gaps()).toHaveLength(1);
        expect(gaps()[0]?.dataset['workspaceId']).toBe(W1);
        expect(gaps()[0]?.style.visibility).toBe('hidden');
        // …and a slot target tints no header, so the two indicators never overlap.
        expect(screen.getByTestId('group-header').dataset['dropPreview']).toBe('false');

        // Phase 3 — over a group HEADER (44–64) the indicator is the band tint, which stays.
        fireEvent.mouseMove(window, { clientY: 58 });
        expect(lineNodes()).toBe(0);
        expect(optOuts()).toBe(0);
        expect(screen.getByTestId('group-header').dataset['dropPreview']).toBe('true');
        expect(gaps()).toHaveLength(1);

        // Phase 4 — a slot INSIDE the group (beta 64–84): still a gap, now at the nested depth,
        // and still no line. This is the case that would have lost its only indicator if the
        // gap did not follow the resolution.
        fireEvent.mouseMove(window, { clientY: 78 });
        expect(lineNodes()).toBe(0);
        expect(optOuts()).toBe(0);
        expect(gaps()).toHaveLength(1);
        expect(gaps()[0]?.dataset['depth']).toBe('1');
        expect(screen.getByTestId('group-header').dataset['dropPreview']).toBe('false');

        // Phase 5 — release.
        fireEvent.mouseUp(window);
        expect(lineNodes()).toBe(0);
        expect(gaps()).toHaveLength(0);
    });

    /**
     * The other half of the removal: the cursor clone is minted by `cloneNode(true)` off a live
     * row, so anything the row paints rides the pointer unless it is taken out. There is one
     * such thing left (§WS-007's guide rail, re-minted per resolved container by
     * `styleDragGhost`) and the insertion line is no longer one of them — this proves the clone
     * carries neither, from either origin.
     */
    it('the cursor clone carries no insertion line and no inherited rail (§WS-088 × §WS-084)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);

        for (const [id, y] of [
            [W1, 10],
            [W2, 70]
        ] as const) {
            fireEvent.mouseDown(rowFor(id), { clientY: y });
            fireEvent.mouseMove(window, { clientY: 30 });
            const ghost = document.querySelector<HTMLElement>('[data-testid="sidebar-drag-ghost"]');
            expect(ghost, id).not.toBeNull();
            expect(ghost?.querySelectorAll('[data-testid="drop-insert-line"]')).toHaveLength(0);
            expect(ghost?.querySelectorAll('[data-insert-line]')).toHaveLength(0);
            expect(ghost?.querySelectorAll('[data-testid="group-guide"]')).toHaveLength(0);
            fireEvent.mouseUp(window);
        }
    });

    /**
     * §WS-008. jsdom reports `offsetTop === 0` for everything, so the FLIP pass measures no
     * movement here and only the INSERT half is observable — which is the honest split. The
     * reorder half is a spring now, and it is exercised where it can be: `spring.test.ts` for
     * the physics, `sidebar-spring.test.tsx` for the wiring (which supplies the box model this
     * file deliberately does not), and the `sidebar-spring` audit step for the real renderer.
     */
    it('plays the entry animation for a row that appears, not for one that was there (§WS-008)', () => {
        const { rerender } = render(<Sidebar {...baseProps()} entries={entries()} />);
        expect(screen.getAllByTestId('workspace-row').map((row) => row.dataset['entering'])).toEqual([
            undefined,
            undefined,
            undefined,
            undefined
        ]);

        const grown = entries();
        grown.splice(1, 0, { kind: 'workspace', workspace: workspace(W5, 'epsilon') });
        rerender(<Sidebar {...baseProps()} entries={grown} />);

        const rows = screen.getAllByTestId('workspace-row');
        const fresh = rows.find((row) => row.dataset['workspaceId'] === W5);
        expect(fresh?.dataset['entering']).toBe('true');
        expect(fresh?.style.animation).toContain('kelpi-sidebar-row-enter');
        // The rows that were already there do NOT replay their entry.
        expect(rows.filter((row) => row.dataset['entering'] === 'true')).toHaveLength(1);
    });

    it('declares the reorder channel and the lift transition on every settled row (§WS-008)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        for (const row of screen.getAllByTestId('workspace-row')) {
            // The lift's `scale(1.03)` relaxing when a gesture ends — all that is left on
            // `transform` now that the reorder is the spring.
            expect(row.style.transition).toContain('transform');
            expect(row.dataset['reorder']).toBe('spring');
            // A settled row carries no offset at all.
            expect(row.style.translate).toBe('');
        }
        const header = screen.getByTestId('group-header');
        expect(header.style.transition).toContain('transform');
        expect(header.dataset['reorder']).toBe('spring');
        expect(header.style.translate).toBe('');
    });

    /**
     * §WS-094. The port holds a group's height open by CONSTRUCTION rather than with a phantom
     * row: rows are re-derived from the shadow, so the frame that takes the last child out is
     * the frame that puts the "No workspaces" placeholder in. This asserts the consequence the
     * phantom exists for — the group does not collapse to a bare header mid-drag — which the
     * item records as untested.
     */
    it('keeps a group’s body open when its last child is dragged out (§WS-094)', () => {
        const single: ChromeSidebarEntry[] = [
            { kind: 'workspace', workspace: workspace(W1, 'alpha') },
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
                workspaces: [workspace(W2, 'beta')]
            }
        ];
        render(<Sidebar {...baseProps()} entries={single} onMoveWorkspace={vi.fn()} />);
        // rows: alpha 4–24 · header 24–44 · beta 44–64.
        expect(screen.queryByTestId('group-empty')).toBeNull();

        fireEvent.mouseDown(rowFor(W2), { clientY: 54 });
        fireEvent.mouseMove(window, { clientY: 8 }); // alpha's top half → top level, index 0

        // The child left the group in the shadow, and the placeholder took its place in the
        // SAME frame, so the group still occupies a header plus a body row.
        expect(rowIDs()).toEqual([W2, W1]);
        expect(screen.getByTestId('group-empty')).toBeTruthy();
        fireEvent.mouseUp(window);
    });
});

// ── §WS-095: a dragged group moves as one block ─────────────────────────────────────

describe('group drag', () => {
    it('renders the dragged group as collapsed, without touching its stored state', () => {
        const onToggleGroupCollapse = vi.fn();
        const onMoveGroup = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                onMoveGroup={onMoveGroup}
                onToggleGroupCollapse={onToggleGroupCollapse}
            />
        );
        const header = screen.getByTestId('group-header');
        expect(header.dataset['collapsed']).toBe('false');
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);

        // A press alone is not a drag — the children must not vanish under a stray click.
        fireEvent.mouseDown(header, { clientY: 50 });
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);

        // Past the threshold the block folds to its header and moves as one row.
        fireEvent.mouseMove(window, { clientY: 10 });
        expect(screen.getByTestId('group-header').dataset['collapsed']).toBe('true');
        expect(rowIDs()).toEqual([W1, W4]);

        fireEvent.mouseUp(window);
        // Released: the children are back — now at the top, because the block landed there —
        // and the persisted collapse was never written.
        expect(screen.getByTestId('group-header').dataset['collapsed']).toBe('false');
        expect(rowIDs()).toEqual([W2, W3, W1, W4]);
        expect(onToggleGroupCollapse).not.toHaveBeenCalled();
        expect(onMoveGroup).toHaveBeenCalledTimes(1);
        expect(onMoveGroup).toHaveBeenCalledWith({ groupID: G1, index: 0 });
    });
});

// ── §WS-008 removals / §WS-084 the drag ghost / §WS-020 + §WS-102 the reveal ────────

/**
 * A box model for jsdom, which has none.
 *
 * Rows are laid out at 4 · 24 · 44 · 64 · 84 with a height of 20 — the same arithmetic the drag
 * tests above already read the zones off — and both `getBoundingClientRect` and the `offset*`
 * family are stubbed, because the sidebar measures with both: the drag geometry and §WS-093's
 * gate read rects, while the FLIP pass and §WS-102's reveal read `offsetTop` (which no
 * transform can move).
 */
function stubRowGeometry(options: { unmeasured?: readonly HTMLElement[] } = {}): void {
    const list = screen.getByRole('listbox');
    const rows = Array.from(list.querySelectorAll('[data-testid="sidebar-list"] > *'));
    rows.forEach((node, index) => {
        const element = node as HTMLElement;
        const zero = options.unmeasured?.includes(element) === true;
        const top = 4 + index * 20;
        const height = zero ? 0 : 20;
        Object.defineProperty(element, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({
                x: 8,
                y: top,
                left: 8,
                top,
                right: 208,
                bottom: top + height,
                width: 200,
                height,
                toJSON: () => ({})
            })
        });
        for (const [name, value] of [
            ['offsetTop', top],
            ['offsetLeft', 8],
            ['offsetWidth', 200],
            ['offsetHeight', height]
        ] as const) {
            Object.defineProperty(element, name, { configurable: true, value });
        }
    });
}

/** The scroller: a real viewport, and a `scrollTop` that actually remembers what it is told. */
function stubViewport(height: number): HTMLElement {
    const list = screen.getByRole('listbox');
    Object.defineProperty(list, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 220,
            bottom: height,
            width: 220,
            height,
            toJSON: () => ({})
        })
    });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: height });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 0 });
    return list;
}

describe('row removal animates (§WS-008)', () => {
    /**
     * The constraint this is designed around: a dead row may not be held alive in the list,
     * because §WS-093's measure gate trusts the rendered rows and a phantom would be measured
     * as one. So the model loses the row instantly and a CLONE animates in a layer that is out
     * of flow — which is what these assertions are really checking.
     */
    it('leaves a collapsing ghost behind, while the row itself is gone at once', () => {
        vi.useFakeTimers();
        const { rerender } = render(<Sidebar {...baseProps()} entries={entries()} />);
        expect(screen.queryAllByTestId('sidebar-row-ghost')).toHaveLength(0);

        const shrunk = entries().filter((entry) => entry.kind !== 'workspace' || entry.workspace.id !== W4);
        act(() => {
            rerender(<Sidebar {...baseProps()} entries={shrunk} />);
        });

        // The data model is already without it: the row is not a row any more.
        expect(rowIDs()).not.toContain(W4);
        expect(screen.getAllByTestId('workspace-row')).toHaveLength(3);

        const ghost = screen.getByTestId('sidebar-row-ghost');
        // A ghost answers to nothing: no workspace id, no role, no row testid.
        expect(ghost.getAttribute('data-workspace-id')).toBeNull();
        expect(ghost.getAttribute('role')).toBeNull();
        expect(ghost.parentElement?.dataset['testid']).toBe('sidebar-ghost-layer');
        // Out of flow and untouchable — the two properties that keep it out of the geometry.
        expect(ghost.style.position).toBe('absolute');
        expect(ghost.style.pointerEvents).toBe('none');
        expect(ghost.style.transition).toContain('350ms');
        expect(ghost.style.opacity).toBe('1');

        // One frame later it is collapsing: opacity and height are both on their way to zero,
        // and the node is still mounted while they get there.
        act(() => {
            vi.advanceTimersByTime(20);
        });
        expect(ghost.style.opacity).toBe('0');
        expect(ghost.style.height).toBe('0px');
        expect(screen.queryAllByTestId('sidebar-row-ghost')).toHaveLength(1);

        // …and then it is gone, with nothing left in the layer.
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(screen.queryAllByTestId('sidebar-row-ghost')).toHaveLength(0);
        expect(screen.getByTestId('sidebar-ghost-layer').children).toHaveLength(0);
    });

    it('animates the collapse of an EMPTY group, which used to cut (§WS-008)', () => {
        vi.useFakeTimers();
        const withEmpty: ChromeSidebarEntry[] = [
            { kind: 'workspace', workspace: workspace(W1, 'alpha') },
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
                workspaces: []
            }
        ];
        render(<Sidebar {...baseProps()} entries={withEmpty} />);
        expect(screen.getByTestId('group-empty')).toBeTruthy();

        act(() => {
            fireEvent.click(screen.getByTestId('group-header'));
        });
        expect(screen.queryByTestId('group-empty')).toBeNull();
        const ghost = screen.getByTestId('sidebar-row-ghost');
        expect(ghost.textContent).toContain('No workspaces');
        act(() => {
            vi.advanceTimersByTime(20);
        });
        expect(ghost.style.opacity).toBe('0');
    });

    it('collapsing a POPULATED group ghosts every child it takes away', () => {
        vi.useFakeTimers();
        render(<Sidebar {...baseProps()} entries={entries()} />);
        expect(rowIDs()).toEqual([W1, W4, W2, W3]);

        act(() => {
            fireEvent.click(screen.getByTestId('group-header'));
        });
        expect(rowIDs()).toEqual([W1, W4]);
        expect(screen.getAllByTestId('sidebar-row-ghost')).toHaveLength(2);
    });

    it('skips the ghost entirely under prefers-reduced-motion', () => {
        const media = globalThis.matchMedia;
        Object.defineProperty(globalThis, 'matchMedia', {
            configurable: true,
            writable: true,
            value: () => ({ matches: true }) as unknown as MediaQueryList
        });
        try {
            const { rerender } = render(<Sidebar {...baseProps()} entries={entries()} />);
            const shrunk = entries().filter((entry) => entry.kind !== 'workspace' || entry.workspace.id !== W4);
            act(() => {
                rerender(<Sidebar {...baseProps()} entries={shrunk} />);
            });
            expect(screen.queryAllByTestId('sidebar-row-ghost')).toHaveLength(0);
            expect(rowIDs()).not.toContain(W4);
        } finally {
            Object.defineProperty(globalThis, 'matchMedia', { configurable: true, writable: true, value: media });
        }
    });

    /**
     * §WS-093's gate, with a ghost on screen. This is the assertion the whole design exists for:
     * a drag started while a removal is still animating resolves against the LIVE rows only.
     */
    it('keeps a ghost out of the drag geometry, so the measure gate still passes', () => {
        const onMoveWorkspace = vi.fn();
        const { rerender } = render(
            <Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={onMoveWorkspace} />
        );
        const shrunk = entries().filter((entry) => entry.kind !== 'workspace' || entry.workspace.id !== W4);
        act(() => {
            rerender(<Sidebar {...baseProps()} entries={shrunk} onMoveWorkspace={onMoveWorkspace} />);
        });
        expect(screen.getAllByTestId('sidebar-row-ghost')).toHaveLength(1);
        // rows are now alpha 4–24 · header 24–44 · beta 44–64 · gamma 64–84.
        stubRowGeometry();

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 78 }); // gamma's bottom half → after gamma
        expect(screen.getByRole('listbox').dataset['dragActive']).toBe('true');
        fireEvent.mouseUp(window);
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
    });
});

describe('the dragged row follows the cursor (§WS-084)', () => {
    function grab(): HTMLElement {
        const row = rowFor(W1);
        fireEvent.mouseDown(row, { clientX: 30, clientY: 10 });
        return row;
    }

    it('lifts a ghost with a drop shadow that tracks the pointer, and drops it on release', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);
        stubRowGeometry();
        grab();

        // A press is not a drag: nothing has been lifted yet (§WS-084's 5px threshold).
        expect(screen.queryByTestId('sidebar-drag-ghost')).toBeNull();

        fireEvent.mouseMove(window, { clientX: 34, clientY: 30 });
        const ghost = screen.getByTestId('sidebar-drag-ghost');
        expect(ghost.style.position).toBe('fixed');
        expect(ghost.style.boxShadow).not.toBe('');
        expect(ghost.style.pointerEvents).toBe('none');
        /*
         * §WS-084's LIFT, which the clone now carries whole because the row it came off is the
         * gap: 1.03 scale (in the transform below), 0.8 opacity and the shadow above — the three
         * `WorkspaceListView.swift:1361-1368` puts on the dragged row itself.
         */
        expect(ghost.style.opacity).toBe('0.8');
        expect(ghost.style.visibility).toBe('visible');
        // The grab point stays under the cursor: the press was 22px right of the row's left
        // edge and 6px below its top, so the ghost sits at (34-22, 30-6).
        expect(ghost.style.transform).toBe('translate3d(12px, 24px, 0) scale(1.03)');

        fireEvent.mouseMove(window, { clientX: 90, clientY: 120 });
        expect(ghost.style.transform).toBe('translate3d(68px, 114px, 0) scale(1.03)');

        // It is a picture, not a row: it must not answer to any row selector.
        expect(screen.getAllByTestId('workspace-row')).toHaveLength(4);
        expect(ghost.getAttribute('data-workspace-id')).toBeNull();

        fireEvent.mouseUp(window);
        expect(screen.queryByTestId('sidebar-drag-ghost')).toBeNull();
    });

    it('lifts a ghost for a dragged GROUP header too', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveGroup={vi.fn()} />);
        stubRowGeometry();
        fireEvent.mouseDown(screen.getByTestId('group-header'), { clientX: 30, clientY: 50 });
        fireEvent.mouseMove(window, { clientX: 30, clientY: 10 });
        expect(screen.getByTestId('sidebar-drag-ghost').textContent).toContain('squad');
        fireEvent.mouseUp(window);
        expect(screen.queryByTestId('sidebar-drag-ghost')).toBeNull();
    });

    it('leaves nothing behind when the gesture never becomes a drag', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);
        stubRowGeometry();
        grab();
        fireEvent.mouseMove(window, { clientX: 31, clientY: 12 }); // 2px: below the threshold
        expect(screen.queryByTestId('sidebar-drag-ghost')).toBeNull();
        // …and a press is not a gap either: the row under the cursor is still painted.
        expect(rowFor(W1).dataset['dragGap']).toBeUndefined();
        expect(rowFor(W1).style.visibility).toBe('');
        fireEvent.mouseUp(window);
        expect(screen.queryByTestId('sidebar-drag-ghost')).toBeNull();
    });

    /**
     * THE SINGLE-REPRESENTATION INVARIANT, at the two moments it can be observed.
     *
     * Mid-drag there is exactly one picture of the item — the clone — and the row it came off
     * keeps its box but paints nothing. On release the clone is gone and the row is back, in the
     * same synchronous handler: the browser cannot paint between `endDragGhost()` and the state
     * flip beside it, so no painted frame carries two copies and none carries zero.
     */
    it('shows exactly one picture of the dragged item, before and after release (§WS-084)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);
        stubRowGeometry();
        const visible = (): number => {
            const rows = screen
                .getAllByTestId('workspace-row')
                .filter((row) => row.dataset['workspaceId'] === W1 && row.style.visibility !== 'hidden');
            return rows.length + document.querySelectorAll('[data-testid="sidebar-drag-ghost"]').length;
        };
        expect(visible()).toBe(1);

        fireEvent.mouseDown(rowFor(W1), { clientX: 30, clientY: 10 });
        fireEvent.mouseMove(window, { clientX: 30, clientY: 78 });
        // The gap keeps the row's box — the height is what makes it a slot rather than a hole.
        expect(rowFor(W1).getBoundingClientRect().height).toBe(20);
        expect(visible()).toBe(1);

        fireEvent.mouseMove(window, { clientX: 30, clientY: 30 });
        expect(visible()).toBe(1);

        fireEvent.mouseUp(window);
        expect(visible()).toBe(1);
        expect(screen.queryByTestId('sidebar-drag-ghost')).toBeNull();
        expect(rowFor(W1).style.visibility).toBe('');
    });

    /**
     * The gap is not hit-testable, so the `click` that follows a drag no longer lands on the row
     * that used to retire the "do not activate" flag. A window-level listener retires it
     * instead; without that, the user's KELPIT click on any row would be swallowed.
     */
    it('does not swallow the click AFTER the one that ends a drag', () => {
        const onActivateWorkspace = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                onMoveWorkspace={vi.fn()}
                onActivateWorkspace={onActivateWorkspace}
            />
        );
        stubRowGeometry();

        fireEvent.mouseDown(rowFor(W1), { clientX: 30, clientY: 10 });
        fireEvent.mouseMove(window, { clientX: 30, clientY: 78 });
        fireEvent.mouseUp(window);
        // The browser's click after a drag lands on the scroller, not on the (hidden) row.
        fireEvent.click(screen.getByRole('listbox'));
        expect(onActivateWorkspace).not.toHaveBeenCalled();

        // A genuine click, afterwards, still activates.
        fireEvent.click(rowFor(W4));
        expect(onActivateWorkspace).toHaveBeenCalledWith(W4);
    });
});

/**
 * The user's second refinement: "dragging around on the sidebar selects the text, it shouldn't
 * do that."
 *
 * Parity is the stronger statement. An AppKit/SwiftUI list row's labels are drawn `Text` and
 * drawn `Text` has no selection model at all — the shipped app cannot smear a workspace name
 * however hard you drag it, and cannot double-click one to highlight a word either. The port
 * renders real text nodes, so it inherited the browser default and every drag left a blue smear
 * trailing the cursor clone.
 *
 * Three clauses, and the third is the one a container rule cannot cover on its own:
 *
 *   1. the container is `user-select: none`, which is the parity behaviour AND the root cure
 *      (a `mousedown` on unselectable text never starts a selection to begin with);
 *   2. every editable INSIDE it opts back in, or the rule would silently break caret dragging
 *      and double-click-to-word in the rename editor, the filter field and the create form;
 *   3. a selection made ELSEWHERE still extends *through* an unselectable region, so the drag
 *      drops it as the gesture crosses the 5px threshold.
 */
describe('the sidebar’s text is never selectable, and a drag never smears one', () => {
    const selection = (): Selection | null => globalThis.getSelection?.() ?? null;

    afterEach(() => {
        selection()?.removeAllRanges();
    });

    it('the container is unselectable, and says so in one place', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const sidebar = screen.getByTestId('sidebar');
        expect(sidebar.style.userSelect).toBe('none');
        // It is on the CONTAINER, so it inherits to everything row-shaped rather than being
        // re-stated per component — the rows, the group headers, the label chips, the footer.
        expect(rowFor(W1).style.userSelect).toBe('');
        expect(screen.getByTestId('group-header').style.userSelect).toBe('');
    });

    it('every editable in the sidebar opts back IN, and still accepts typing and selection', () => {
        const onFilterChange = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                onFilterChange={onFilterChange}
                entries={entries()}
                renameRequest={{ kind: 'workspace', id: W1 }}
            />
        );

        // 1 — the filter field.
        const filter = screen.getByTestId('sidebar-filter') as HTMLInputElement;
        expect(filter.style.userSelect).toBe('text');
        fireEvent.change(filter, { target: { value: 'gam' } });
        expect(onFilterChange).toHaveBeenCalledWith('gam');

        // 2 — the inline rename editor (the same component backs the group rename).
        const rename = screen.getByTestId('inline-editor') as HTMLInputElement;
        expect(rename.style.userSelect).toBe('text');
        fireEvent.change(rename, { target: { value: 'alpha renamed' } });
        expect(rename.value).toBe('alpha renamed');
        // …and a caret selection inside it still resolves, which is what `user-select: none`
        // would have taken away on a WebKit engine.
        rename.setSelectionRange(0, 5);
        expect(rename.selectionStart).toBe(0);
        expect(rename.selectionEnd).toBe(5);
    });

    it('the create form’s fields opt back in too', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onCreateWorkspace={vi.fn()} />);
        fireEvent.click(screen.getByTestId('sidebar-new-workspace'));

        const name = screen.getByLabelText('New workspace name') as HTMLInputElement;
        expect(name.style.userSelect).toBe('text');
        fireEvent.change(name, { target: { value: 'epsilon' } });
        expect(name.value).toBe('epsilon');
    });

    it('a drag across several rows clears a selection made elsewhere and leaves none behind', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);

        // A selection the user made SOMEWHERE ELSE, before the drag — the case `user-select:
        // none` cannot answer, because the ranges already exist and simply extend through the
        // unselectable region as the pointer travels.
        const elsewhere = document.createElement('p');
        elsewhere.textContent = 'a selection made outside the sidebar';
        document.body.append(elsewhere);
        const range = document.createRange();
        range.selectNodeContents(elsewhere);
        selection()?.addRange(range);
        expect(selection()?.rangeCount).toBe(1);

        // A press alone must NOT destroy it — the user may simply be clicking a row.
        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        expect(selection()?.rangeCount).toBe(1);

        // Crossing the threshold does. rows: alpha 4–24 · delta 24–44 · header 44–64 ·
        // beta 64–84 · gamma 84–104 — a real traverse of the whole list.
        for (const clientY of [30, 58, 78, 100, 58, 8]) {
            fireEvent.mouseMove(window, { clientY });
            expect(selection()?.rangeCount, String(clientY)).toBe(0);
            expect(selection()?.toString(), String(clientY)).toBe('');
        }

        fireEvent.mouseUp(window);
        expect(selection()?.rangeCount).toBe(0);
        elsewhere.remove();
    });
});

describe('the reveal, measured (§WS-020, §WS-102)', () => {
    let scrolled: HTMLElement[] = [];

    beforeEach(() => {
        scrolled = [];
        Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement): void {
            scrolled.push(this);
        };
    });

    /** §WS-020: only the main list has a live scroll view, so a queued request is dropped. */
    it('consumes and DROPS a scroll request while the filter is active', () => {
        const onScrollHandled = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                filter="gam"
                entries={entries()}
                scrollToWorkspaceID={W3}
                onScrollHandled={onScrollHandled}
            />
        );
        // The filtered row is on screen under the same key…
        expect(screen.getAllByTestId('workspace-row')).toHaveLength(1);
        // …and it is deliberately NOT scrolled to; the one-shot is cleared instead.
        expect(scrolled).toHaveLength(0);
        expect(onScrollHandled).toHaveBeenCalledTimes(1);
    });

    it('waits for the row to measure, then animates the minimum scroll (§WS-102)', async () => {
        const onScrollHandled = vi.fn();
        const view = render(<Sidebar {...baseProps()} entries={entries()} onScrollHandled={onScrollHandled} />);
        const list = stubViewport(100);
        const gamma = rowFor(W3);
        stubRowGeometry({ unmeasured: [gamma] });

        view.rerender(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                scrollToWorkspaceID={W3}
                onScrollHandled={onScrollHandled}
            />
        );
        // Not yet: the row exists but has no height, so the reveal would scroll to a position
        // nothing has measured. The one-shot stays pending rather than being spent.
        expect(onScrollHandled).not.toHaveBeenCalled();
        expect(list.scrollTop).toBe(0);
        expect(scrolled).toHaveLength(0);

        // It lays out; the next frame retries and the reveal goes ahead.
        stubRowGeometry();
        await waitFor(() => {
            expect(onScrollHandled).toHaveBeenCalledTimes(1);
        });

        // gamma occupies 84–104 in a 100px viewport, so the minimum move is 4px — and it is
        // ANIMATED: the target is not there the moment the reveal is dispatched.
        expect(list.scrollTop).toBeLessThan(4);
        await waitFor(() => {
            expect(Math.round(list.scrollTop)).toBe(4);
        });
    });

    /**
     * §N34 — the reveal is a promise about a ROW, and rows move after they are measured.
     *
     * The live case is the group header the reveal is computed against at 36 px, which mounts
     * its inline rename field a commit later and becomes 38: the one-shot landed 2 px short and
     * the header's foot sat past the fold for good, because a row moving is not a focus change
     * and nothing re-armed the reveal (`docs/audit/n34-n35-reveal-focus/`).
     */
    it('re-aims when the row it is revealing GROWS under it (N34)', async () => {
        const onScrollHandled = vi.fn();
        const view = render(<Sidebar {...baseProps()} entries={entries()} onScrollHandled={onScrollHandled} />);
        const list = stubViewport(100);
        stubRowGeometry();

        view.rerender(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                scrollToWorkspaceID={W3}
                onScrollHandled={onScrollHandled}
            />
        );
        await waitFor(() => {
            expect(onScrollHandled).toHaveBeenCalledTimes(1);
        });

        // gamma occupies 84–104 in a 100px viewport: the reveal is aiming at 4. Now it grows,
        // the way a header does when its rename field mounts.
        const gamma = rowFor(W3);
        Object.defineProperty(gamma, 'offsetHeight', { configurable: true, value: 24 });
        await waitFor(() => {
            expect(Math.round(list.scrollTop)).toBe(8);
        });
    });

    it('no-ops when the row is already fully visible, and still reports it handled', async () => {
        const onScrollHandled = vi.fn();
        const view = render(<Sidebar {...baseProps()} entries={entries()} onScrollHandled={onScrollHandled} />);
        const list = stubViewport(400);
        stubRowGeometry();

        view.rerender(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                scrollToWorkspaceID={W3}
                onScrollHandled={onScrollHandled}
            />
        );
        await waitFor(() => {
            expect(onScrollHandled).toHaveBeenCalledTimes(1);
        });
        expect(list.scrollTop).toBe(0);
        // The measured path took it, so the platform's own scroller was never asked.
        expect(scrolled).toHaveLength(0);
    });

    /** §WS-100's other half: a group target resolves to the header a group actually has. */
    it('reveals a newly created GROUP by its header', () => {
        const onScrollHandled = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                scrollToGroupID={G1}
                onScrollHandled={onScrollHandled}
            />
        );
        expect(scrolled).toHaveLength(1);
        expect(scrolled[0]?.getAttribute('data-testid')).toBe('group-header');
        expect(onScrollHandled).toHaveBeenCalledTimes(1);
    });

    it('drops a group target this client cannot see', () => {
        const onScrollHandled = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                scrollToGroupID="not-a-group"
                onScrollHandled={onScrollHandled}
            />
        );
        expect(scrolled).toHaveLength(0);
        expect(onScrollHandled).toHaveBeenCalledTimes(1);
    });
});

// ── §WS-027 / §WS-031 / §WS-041 / §WS-043 / §WS-068: row states, rename, prompts ────

describe('row background states stack (§WS-027)', () => {
    /**
     * The Swift draws these as a ZStack, not a switch: a row that is BOTH selected and active
     * carries both fills and both strokes, and reads brighter than either state alone. The port
     * used to make them ternaries, so an active row silently lost its selection ring — the one
     * state where losing it matters, because that is the row a bulk action is about to act on.
     */
    it('a row that is selected AND active keeps both fills and both strokes', () => {
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                activeWorkspaceID={W1}
                selectedWorkspaceIDs={new Set([W1])}
            />
        );
        const row = rowFor(W1);
        // The 1.5px accent takes the outer edge …
        expect(row.style.outline).toBe('1.5px solid var(--kelpi-selection-stroke, #5276B8)');
        // … and the selection's 1px stroke at 0.7 opacity survives as the inner ring. §H22: the
        // 0.7 now rides the LIVE `--kelpi-selection-stroke` (`WorkspaceRowView.swift:161` is
        // `theme.selectionStroke.opacity(0.7)`), where it used to be the dark preset's `#5276B8`
        // frozen into the source — a dark periwinkle on a light sidebar whose stroke is `#5e8ac4`.
        expect(row.style.boxShadow).toBe(
            'inset 0 0 0 1px color-mix(in srgb, var(--kelpi-selection-stroke, #5276B8) 70%, transparent)'
        );
        // Both fills: the selection fill as the colour, the active tint layered over it. Read off
        // `backgroundColor` rather than the `background` shorthand, which is what the row now
        // writes — a shorthand goes unreadable the moment a layered `background-image` joins it.
        expect(row.style.backgroundColor).toContain('--kelpi-selection-fill');
        expect(row.style.backgroundImage).toContain('linear-gradient');
    });

    it('and either state alone is unchanged', () => {
        const { rerender } = render(
            <Sidebar {...baseProps()} entries={entries()} activeWorkspaceID={W1} />
        );
        expect(rowFor(W1).style.outline).toBe('1.5px solid var(--kelpi-selection-stroke, #5276B8)');
        expect(rowFor(W1).style.boxShadow).toBe('');
        expect(rowFor(W1).style.backgroundImage).toBe('');

        rerender(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                activeWorkspaceID={W2}
                selectedWorkspaceIDs={new Set([W1])}
            />
        );
        expect(rowFor(W1).style.outline).toBe(
            '1px solid color-mix(in srgb, var(--kelpi-selection-stroke, #5276B8) 70%, transparent)'
        );
        expect(rowFor(W1).style.boxShadow).toBe('');
    });

    /**
     * §H6: the ACTIVE fill is the neutral `selectionFill` at 0.7, not the workspace's colour.
     *
     * `WorkspaceRowView.swift:164` is `.fill(theme.selectionFill.opacity(0.7))` — the very fill a
     * selected row uses at full strength four lines above it, dimmed. The port used to tint it
     * with `workspaceColorHex(workspace.color, bucket)` at 16 %, so the active-workspace
     * highlight changed HUE on every switch, which the shipped app never does. Two workspaces of
     * different colours are made active in turn: same fill both times, and neither is the
     * workspace's own hex.
     */
    it('§H6: the active fill is the neutral selection fill at 0.7, whatever colour the row is', () => {
        const expected =
            'color-mix(in srgb, var(--kelpi-selection-fill, rgba(82, 118, 184, 0.24)) 70%, transparent)';
        // Two rows of DIFFERENT colours, so a fill that read the workspace could not match twice.
        const coloured: ChromeSidebarEntry[] = [
            { kind: 'workspace', workspace: workspace(W1, 'alpha', { color: 'blue' }) },
            { kind: 'workspace', workspace: workspace(W4, 'delta', { color: 'orange' }) }
        ];
        const { rerender } = render(
            <Sidebar {...baseProps()} entries={coloured} activeWorkspaceID={W1} />
        );
        expect(rowFor(W1).style.backgroundColor).toBe(expected);
        // The colour is still doing its job on the AVATAR — this is about the row fill only.
        expect(rowFor(W1).querySelector('span[aria-hidden]')?.getAttribute('style')).toContain('#');

        rerender(<Sidebar {...baseProps()} entries={coloured} activeWorkspaceID={W4} />);
        expect(rowFor(W4).style.backgroundColor).toBe(expected);
        // No workspace hex anywhere in the fill, in either state.
        expect(rowFor(W4).style.backgroundColor).not.toMatch(/#[0-9A-Fa-f]{6}\s/);
    });
});

// ── §WS-027: the air around the ring ────────────────────────────────────────────────

/**
 * "The highlight touches the group" (2026-08-23).
 *
 * §WS-027 measured the ring's stroke widths and opacities and never measured its CLEARANCE, so
 * the port shipped an active row whose accent ran into the group band above it. The numbers here
 * are all the Swift's, and the derivation is the point — a test that hard-codes `3.25` proves
 * nothing about the geometry that produces it:
 *
 *   - `WorkspaceRowView.swift:97` — every row carries `.padding(.vertical, 2)` OUTSIDE its
 *     background and ring, `GroupHeaderRow.swift:110` gives a band the same, and the list is
 *     `VStack(spacing: 0)` (`WorkspaceListView.swift:291`). SwiftUI padding does not collapse,
 *     so two adjacent items sit `2 * ROW_OUTER_GAP_PX` apart;
 *   - `WorkspaceRowView.swift:168` — the accent is `.stroke(lineWidth: 1.5)`, CENTRED on the
 *     background rect, so it paints `ringBleedPx(1.5)` = 0.75pt outside it.
 *
 * jsdom has no box model, so what is asserted here is the two inputs (the margins the DOM really
 * carries, and the outline offset/width the ring really has) plus the arithmetic they force. The
 * pixels themselves are settled by `docs/audit/sidebar-ring-clearance`, which measures painted
 * edges in a real engine with the active row directly under a group band.
 *
 * One number differs between the two layers, and it is the engine's rather than this component's:
 * Blink rounds a painted outline onto the device pixel grid, so the −0.75px specified here is
 * painted at −0.5px on a 2× display — 1px of bleed instead of 0.75px, 3px of air instead of 3.25px,
 * still three times the 1px floor. What is SPECIFIED is exact and asserted exactly; the audit step
 * probes the rounding in the live document rather than assuming it.
 */
describe('the ring keeps clear air from its neighbours (§WS-027)', () => {
    /** What a CSS outline paints beyond the border box: it starts at the offset, extends outward. */
    const paintedBleed = (width: number, offset: number): number => Math.max(0, width + offset);
    /**
     * jsdom's `cssstyle` stores the `outline` shorthand verbatim and never expands it, so
     * `style.outlineWidth` is the empty string here where a browser answers `1.5px`. The width is
     * the shorthand's leading length; `outline-offset` is a real longhand and reads back directly.
     */
    const ringWidthOf = (element: HTMLElement): number => Number.parseFloat(element.style.outline);
    const ringOffsetOf = (element: HTMLElement): number => Number.parseFloat(element.style.outlineOffset);

    it('derives the ring offset from the stroke width, the way a centred SwiftUI stroke does', () => {
        expect(ringOffsetPx(ROW_ACTIVE_RING_PX)).toBe(-0.75);
        expect(ringOffsetPx(ROW_SELECTION_RING_PX)).toBe(-0.5);
        expect(ringBleedPx(ROW_ACTIVE_RING_PX)).toBe(0.75);
        expect(ringBleedPx(ROW_SELECTION_RING_PX)).toBe(0.5);
    });

    it('gives every row and every group band the Swift’s 2px of outer margin, on BOTH edges', () => {
        render(<Sidebar {...baseProps()} entries={entries()} activeWorkspaceID={W1} />);
        for (const element of [...screen.getAllByTestId('workspace-row'), screen.getByTestId('group-header')]) {
            expect(element.style.marginTop).toBe(`${String(ROW_OUTER_GAP_PX)}px`);
            expect(element.style.marginBottom).toBe(`${String(ROW_OUTER_GAP_PX)}px`);
        }
    });

    /**
     * The margins above are only worth 4px if nothing collapses them, and a block container
     * collapses them to 2px — which is the defect, expressed in one CSS keyword.
     */
    it('lays the rows out as a FLEX column, so the two margins cannot collapse into one', () => {
        render(<Sidebar {...baseProps()} entries={entries()} activeWorkspaceID={W1} />);
        const list = screen.getByTestId('sidebar-list');
        expect(list.className).toContain('flex');
        expect(list.className).toContain('flex-col');
    });

    it('centres the active accent on the row box, and the selection stroke likewise', () => {
        const { rerender } = render(<Sidebar {...baseProps()} entries={entries()} activeWorkspaceID={W1} />);
        expect(ringWidthOf(rowFor(W1))).toBe(ROW_ACTIVE_RING_PX);
        expect(rowFor(W1).style.outlineOffset).toBe('-0.75px');

        rerender(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                activeWorkspaceID={W2}
                selectedWorkspaceIDs={new Set([W1])}
            />
        );
        expect(ringWidthOf(rowFor(W1))).toBe(ROW_SELECTION_RING_PX);
        expect(rowFor(W1).style.outlineOffset).toBe('-0.5px');
    });

    it('rounds the row to the Swift’s 7pt and the group band to its 8pt', () => {
        render(<Sidebar {...baseProps()} entries={entries()} activeWorkspaceID={W1} />);
        expect(rowFor(W1).style.borderRadius).toBe(`${String(ROW_CORNER_RADIUS_PX)}px`);
        expect(screen.getByTestId('group-header').style.borderRadius).toBe(
            `${String(GROUP_BAND_CORNER_RADIUS_PX)}px`
        );
    });

    /**
     * The contract itself, computed from the values the tests above just read off the DOM: the
     * ring's painted outer edge keeps at least 1px of air from a neighbour's painted edge,
     * whether that neighbour is a group band or a plain row.
     */
    it('leaves the Swift’s 3.25px of air on both sides — never less than 1px', () => {
        render(<Sidebar {...baseProps()} entries={entries()} activeWorkspaceID={W1} />);
        const row = rowFor(W1);
        const boxGap = Number.parseFloat(row.style.marginBottom) + Number.parseFloat(row.style.marginTop);
        const bleed = paintedBleed(ringWidthOf(row), ringOffsetOf(row));
        expect(boxGap).toBe(2 * ROW_OUTER_GAP_PX);
        expect(bleed).toBe(ringBleedPx(ROW_ACTIVE_RING_PX));
        expect(boxGap - bleed).toBe(3.25);
        expect(boxGap - bleed).toBeGreaterThanOrEqual(1);
    });

    /**
     * A neighbour that ALSO paints past its box is the worst case, and there is exactly one:
     * a selected row beside the active one. Both bleeds come out of the same 4px.
     */
    it('still clears a selected neighbour, whose own stroke eats into the same gap', () => {
        render(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                activeWorkspaceID={W1}
                selectedWorkspaceIDs={new Set([W4])}
            />
        );
        const bleedOf = (element: HTMLElement): number =>
            paintedBleed(ringWidthOf(element), ringOffsetOf(element));
        const clear = 2 * ROW_OUTER_GAP_PX - bleedOf(rowFor(W1)) - bleedOf(rowFor(W4));
        expect(clear).toBe(2.75);
        expect(clear).toBeGreaterThanOrEqual(1);
    });

    /**
     * A nested row indents by 24px and the ring indents with it (§WS-028) — the vertical air is
     * untouched by that, which is what stops a group's members from being a special case.
     */
    it('is the same air for a row inside a group as for one at top level', () => {
        render(<Sidebar {...baseProps()} entries={entries()} activeWorkspaceID={W2} />);
        const member = rowFor(W2);
        expect(member.style.marginLeft).toBe('24px');
        expect(member.style.marginTop).toBe(`${String(ROW_OUTER_GAP_PX)}px`);
        expect(member.style.marginBottom).toBe(`${String(ROW_OUTER_GAP_PX)}px`);
        expect(member.style.outlineOffset).toBe('-0.75px');
    });
});

describe('rename commits when the focus leaves (§WS-031)', () => {
    /** Stable across renders: a fresh literal would re-arm the one-shot on every commit. */
    const renameSquad = { kind: 'group', id: G1 } as const;

    /**
     * jsdom does not implement click→focus, so the focus move a real click performs is done
     * explicitly here; what is being tested is the rule the Swift states as "resigning first
     * responder commits" — the field is not abandoned just because the user clicked elsewhere.
     */
    it('clicking another row commits the group rename in flight', () => {
        const onRenameGroup = vi.fn();
        // The entry list is hoisted for the same reason as the request above: a fresh array on
        // every render re-runs the one-shot effect and re-opens the field behind the assertion.
        const list = entries();
        render(
            <Sidebar
                {...baseProps()}
                entries={list}
                renameRequest={renameSquad}
                onRenameGroup={onRenameGroup}
            />
        );
        const field = screen.getByLabelText('Rename squad') as HTMLInputElement;
        fireEvent.change(field, { target: { value: 'platform' } });

        const other = rowFor(W1);
        fireEvent.mouseDown(other);
        // `focus()` is a raw DOM call, so the blur handler's state update needs flushing.
        act(() => {
            other.focus();
        });

        expect(onRenameGroup).toHaveBeenCalledWith(G1, 'platform');
        expect(screen.queryByLabelText('Rename squad')).toBeNull();
    });

    it('an unchanged or empty value cancels instead of committing', () => {
        const onRenameGroup = vi.fn();
        const list = entries();
        render(
            <Sidebar
                {...baseProps()}
                entries={list}
                renameRequest={renameSquad}
                onRenameGroup={onRenameGroup}
            />
        );
        const field = screen.getByLabelText('Rename squad') as HTMLInputElement;
        fireEvent.change(field, { target: { value: '   ' } });
        act(() => {
            rowFor(W1).focus();
        });
        expect(onRenameGroup).not.toHaveBeenCalled();
        expect(screen.queryByLabelText('Rename squad')).toBeNull();
    });
});

describe('the chevron is hidden while a group is renamed (§WS-041)', () => {
    it('drops the collapse control for the length of the edit', () => {
        const { rerender } = render(<Sidebar {...baseProps()} entries={entries()} />);
        expect(screen.getByTestId('group-chevron')).toBeTruthy();

        rerender(
            <Sidebar {...baseProps()} entries={entries()} renameRequest={{ kind: 'group', id: G1 }} />
        );
        expect(screen.getByLabelText('Rename squad')).toBeTruthy();
        expect(screen.queryByTestId('group-chevron')).toBeNull();
        // The context menu is still reachable — the item is explicit that only the drag and the
        // chevron go away.
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        expect(screen.getByTestId('context-menu')).toBeTruthy();
    });
});

describe('the selection header hides Select All once everything is selected (§WS-043)', () => {
    it('shows it for a partial selection and drops it for a complete one', () => {
        const { rerender } = render(
            <Sidebar {...baseProps()} entries={entries()} selectedWorkspaceIDs={new Set([W1])} />
        );
        const header = screen.getByTestId('selection-header');
        expect(header.textContent).toContain('1 selected');
        expect(within(header).getByText('Select All')).toBeTruthy();
        expect(within(header).getByText('Clear')).toBeTruthy();

        rerender(
            <Sidebar
                {...baseProps()}
                entries={entries()}
                selectedWorkspaceIDs={new Set([W1, W2, W3, W4])}
            />
        );
        const full = screen.getByTestId('selection-header');
        expect(full.textContent).toContain('4 selected');
        expect(within(full).queryByText('Select All')).toBeNull();
        // Clear stays: it is the only way out.
        expect(within(full).getByText('Clear')).toBeTruthy();
    });
});

describe('the group delete prompt takes its shape from membership (§WS-068)', () => {
    function openGroupDelete(entryList: ChromeSidebarEntry[], onDeleteGroup = vi.fn()) {
        render(<Sidebar {...baseProps()} entries={entryList} onDeleteGroup={onDeleteGroup} />);
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.click(screen.getByText('Delete Group…'));
        return onDeleteGroup;
    }

    it('a POPULATED group offers both outcomes, counted, with the safer one named', () => {
        const onDeleteGroup = openGroupDelete(entries());
        const dialog = screen.getByTestId('confirm-dialog');
        expect(within(dialog).getByTestId('confirm-group-detail').dataset['members']).toBe('2');
        expect(dialog.textContent).toContain('also delete the 2 workspaces inside this group');
        expect(dialog.textContent).toContain('safer option');

        const cascade = screen.getByTestId('confirm-delete-cascade');
        const promote = screen.getByTestId('confirm-delete');
        expect(cascade.textContent).toBe('Delete Group and 2 Workspaces');
        expect(promote.textContent).toBe('Move Workspaces to Top Level');
        // Both outcomes are destructive, so both are styled that way.
        expect(cascade.style.color).toBe('rgb(224, 101, 92)');
        expect(promote.style.color).toBe('rgb(224, 101, 92)');

        fireEvent.click(cascade);
        expect(onDeleteGroup).toHaveBeenCalledWith(G1, true);
    });

    it('an EMPTY group offers one button and says so', () => {
        const empty: ChromeSidebarEntry[] = [
            { kind: 'workspace', workspace: workspace(W1, 'alpha') },
            {
                kind: 'group',
                group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
                workspaces: []
            }
        ];
        const onDeleteGroup = openGroupDelete(empty);
        const dialog = screen.getByTestId('confirm-dialog');
        expect(dialog.textContent).toContain('This group is empty and will be removed.');
        expect(screen.queryByTestId('confirm-delete-cascade')).toBeNull();
        const only = screen.getByTestId('confirm-delete');
        expect(only.textContent).toBe('Delete Group');

        fireEvent.click(only);
        expect(onDeleteGroup).toHaveBeenCalledWith(G1, false);
    });

    it('the count is SNAPSHOTTED when the prompt is raised, not read live', () => {
        const onDeleteGroup = vi.fn();
        const view = render(
            <Sidebar {...baseProps()} entries={entries()} onDeleteGroup={onDeleteGroup} />
        );
        fireEvent.contextMenu(screen.getByTestId('group-header'));
        fireEvent.click(screen.getByText('Delete Group…'));
        expect(screen.getByTestId('confirm-delete-cascade').textContent).toBe('Delete Group and 2 Workspaces');

        // Another client empties the group while the prompt is up: the button the user is
        // reading must not relabel itself under their cursor.
        const emptied = entries();
        emptied[2] = {
            kind: 'group',
            group: { id: G1, name: 'squad', color: 'green', icon: null, isCollapsed: false },
            workspaces: []
        };
        view.rerender(<Sidebar {...baseProps()} entries={emptied} onDeleteGroup={onDeleteGroup} />);
        expect(screen.getByTestId('confirm-delete-cascade').textContent).toBe('Delete Group and 2 Workspaces');
    });
});

// ── §H21 / §H22 / §H23: the sidebar reads the THEME, at the Swift's metrics ──────────

/**
 * Six sidebar colours were hardcoded dark-theme hex, and the filter pill was about half the
 * shipped height. Both are settled here against `WorkspaceListView.swift` / `GroupHeaderRow.swift`.
 *
 * The colour assertions look for the CSS VARIABLE rather than a resolved value on purpose: a
 * `var(--kelpi-x, …)` read is the whole fix — it is what makes the colour follow the live theme
 * instead of freezing one bucket's palette into the source — and it is the thing a hex literal
 * cannot be mistaken for. The audit's own light/dark renders carry the resolved numbers.
 */
describe('the sidebar reads theme tokens, not frozen hex (§H21/§H22)', () => {
    const pill = (): HTMLElement => {
        const input = screen.getByTestId('sidebar-filter');
        const element = input.parentElement;
        if (element === null) throw new Error('the filter pill has no parent');
        return element;
    };

    it('§H21: the filter pill is at the Swift’s paddings, font and gap', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        // `WorkspaceListView.swift:672-673` — 12pt horizontal, 10pt vertical on the pill…
        expect(pill().className).toContain('px-3');
        expect(pill().className).toContain('py-2.5');
        // …`:628`'s `HStack(spacing: 8)`…
        expect(pill().className).toContain('gap-2');
        // …`:635`'s 13pt field…
        expect(screen.getByTestId('sidebar-filter').className).toContain('text-[13px]');
        // …and `:682-683`'s 10pt/8pt margin around it.
        const wrap = pill().parentElement;
        expect(wrap?.className).toContain('px-2.5');
        expect(wrap?.className).toContain('py-2');
    });

    it('§H22: the pill’s fill and border are textPrimary, not a dark-preset hex', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        // `:676` / `:679` — `chromeTheme.textPrimary.opacity(0.05 / 0.08)`.
        //
        // A hex still appears in these strings, and that is correct: `tokens.ts` gives every
        // read a `var(--kelpi-x, <dark preset>)` FALLBACK so a component mounted outside a
        // provider still renders. So the assertion is about POSITION — the variable is what is
        // read and the hex is only its fallback — which is exactly the difference between this
        // and the frozen `withAlpha('#E6E6EA', …)` it replaced.
        expect(pill().style.background).toMatch(/^color-mix\(in srgb, var\(--kelpi-fg,[^)]*\) 5%/);
        expect(pill().style.border).toMatch(
            /^1px solid color-mix\(in srgb, var\(--kelpi-fg,[^)]*\) 8%/
        );
    });

    it('§H22: the selection strip is the live accent at 12%', () => {
        render(
            <Sidebar {...baseProps()} entries={entries()} selectedWorkspaceIDs={new Set([W1])} />
        );
        // `WorkspaceListView.swift:850` — `Color.accentColor.opacity(0.12)`.
        const strip = screen.getByTestId('selection-header');
        expect(strip.style.background).toMatch(/^color-mix\(in srgb, var\(--kelpi-accent,[^)]*\) 12%/);
    });

    it('§H22: a colourless group band is textTertiary at the band opacity, like a coloured one', () => {
        const uncoloured: ChromeSidebarEntry[] = [
            {
                kind: 'group',
                group: { id: G1, name: 'plain', color: null, icon: null, isCollapsed: false },
                workspaces: [workspace(W2, 'beta')]
            }
        ];
        render(<Sidebar {...baseProps()} entries={uncoloured} activeWorkspaceID={W2} />);
        const band = screen.getByTestId('group-header');
        // `GroupHeaderRow.swift:27-30` is ONE expression — `(color?.color ?? theme.textTertiary)`
        // at the resolved band fill — so the colourless case is not a branch with its own
        // opacity: it goes through the same `--kelpi-group-fill` × `--kelpi-sidebar-intensity` mix a
        // coloured band does, which is what lets SET-037/038 and light mode's 0.3 reach it.
        expect(band.style.background).toContain('--kelpi-fg-tertiary');
        expect(band.style.background).toContain('--kelpi-group-fill');
        expect(band.style.background).toContain('--kelpi-sidebar-intensity');
        expect(band.style.background).not.toContain('#8A8A92');
    });

    it('§H23: the group name’s wrapper is a flex CONTAINER, so `truncate` can bite', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        const name = screen.getByTestId('group-name');
        expect(name.className).toContain('truncate');
        const wrapper = name.parentElement;
        // `min-w-0 flex-1` alone made the wrapper a flex ITEM but not a flex CONTAINER, which
        // left this span an inline box — and `overflow`/`text-overflow` do nothing to one.
        expect(wrapper?.className).toContain('flex');
        expect(wrapper?.className).toContain('min-w-0');
    });
});
