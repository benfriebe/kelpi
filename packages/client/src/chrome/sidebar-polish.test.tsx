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

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_KEYBINDINGS } from './keys';
import { CURATED_EMOJI, Sidebar, normalizeEmojiInput } from './index';
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
        // … but the row already shows the indentation it is about to have.
        const row = rowFor(W1);
        expect(row.dataset['nestPreview']).toBe('true');
        expect(row.style.marginLeft).toBe('24px');
        // §WS-084's lift: scale, opacity AND the drop shadow.
        expect(row.style.transform).toBe('scale(1.03)');
        expect(row.style.opacity).toBe('0.8');
        expect(row.style.boxShadow).not.toBe('');

        // Leaving the header for a real drop target takes the preview away again.
        fireEvent.mouseMove(window, { clientY: 30 });
        expect(rowFor(W1).dataset['nestPreview']).toBeUndefined();
        fireEvent.mouseUp(window);
    });

    it('plays the falls-into-the-group landing before committing (§WS-092)', () => {
        vi.useFakeTimers();
        const onMoveWorkspace = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries({ collapsed: true })}
                springLoadMs={100_000}
                landingMs={400}
                onMoveWorkspace={onMoveWorkspace}
            />
        );

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 58 }); // collapsed group's header
        fireEvent.mouseUp(window);

        // The row is pinned where it was and shrinks toward the header; nothing has committed.
        const row = rowFor(W1);
        expect(row.dataset['landing']).toBe('true');
        expect(row.style.transform).toBe('scale(0.2)');
        expect(onMoveWorkspace).not.toHaveBeenCalled();

        act(() => {
            vi.advanceTimersByTime(400);
        });
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: W1, groupID: G1, index: 2 });
        // The shadow applied with the commit, so the row is now inside the collapsed group.
        expect(rowIDs()).toEqual([W4]);
    });

    it('a new drag flushes a landing still in flight, so no drop is lost (§WS-092)', () => {
        vi.useFakeTimers();
        const onMoveWorkspace = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries({ collapsed: true })}
                springLoadMs={100_000}
                landingMs={400}
                onMoveWorkspace={onMoveWorkspace}
            />
        );

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 58 });
        fireEvent.mouseUp(window);
        expect(onMoveWorkspace).not.toHaveBeenCalled();

        // Grabbing another row mid-animation commits the pending drop immediately rather
        // than leaving a timer to race the new gesture.
        fireEvent.mouseDown(rowFor(W4), { clientY: 30 });
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
        expect(onMoveWorkspace).toHaveBeenCalledWith({ workspaceID: W1, groupID: G1, index: 2 });
        fireEvent.mouseUp(window);
        act(() => {
            vi.advanceTimersByTime(500);
        });
        // …and the flushed timer does not fire a second time.
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
    });

    it('skips the landing for a spring-loaded group, which is visibly open (§WS-092)', () => {
        vi.useFakeTimers();
        const onMoveWorkspace = vi.fn();
        render(
            <Sidebar
                {...baseProps()}
                entries={entries({ collapsed: true })}
                springLoadMs={650}
                landingMs={400}
                onMoveWorkspace={onMoveWorkspace}
            />
        );

        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        fireEvent.mouseMove(window, { clientY: 58 });
        act(() => {
            vi.advanceTimersByTime(700); // the group springs open
        });
        fireEvent.mouseUp(window);
        // No landing to wait for: the commit is immediate.
        expect(onMoveWorkspace).toHaveBeenCalledTimes(1);
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
     * Sidebar rows carry a 2px `my-0.5` margin that `getBoundingClientRect().height` does not
     * report, so walking the list by `y += height` puts every row a little higher than it
     * really is and the error compounds. This stubs a REAL layout (40px rows, a 2px gap, a
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
                    landingMs={0}
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

// ── shortcut hints (config-keybindings.md §3.3) ─────────────────────────────────────

describe('menu shortcut hints', () => {
    it('shows the display string for the actions the map covers', () => {
        render(<Sidebar {...baseProps()} entries={entries()} keyBindings={DEFAULT_KEYBINDINGS} />);
        fireEvent.contextMenu(rowFor(W1));

        const rename = screen.getByTestId('context-menu').querySelector('[data-menu-item="rename"]');
        expect(within(rename as HTMLElement).getByTestId('menu-shortcut').textContent).toBe('⇧⌘R');
    });

    it('shows nothing when assembly passes no binding map', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        fireEvent.contextMenu(rowFor(W1));
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

    it('marks the landing slot with a 2px accent rule while dragging (§WS-088)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} onMoveWorkspace={vi.fn()} />);

        // A press alone is not a drag: no line until the gesture passes the threshold.
        fireEvent.mouseDown(rowFor(W1), { clientY: 10 });
        expect(screen.queryByTestId('drop-insert-line')).toBeNull();

        // y=30 is delta's zone (24–44) — a `topLevel` slot target, not a group header.
        fireEvent.mouseMove(window, { clientY: 30 });
        const line = screen.getByTestId('drop-insert-line');
        expect(line.style.height).toBe('2px');
        expect(rowFor(W1).dataset['insertLine']).toBe('true');

        // Over a group HEADER the indicator is the band tint instead, never both.
        fireEvent.mouseMove(window, { clientY: 58 });
        expect(screen.queryByTestId('drop-insert-line')).toBeNull();
        expect(screen.getByTestId('group-header').dataset['dropPreview']).toBe('true');

        fireEvent.mouseUp(window);
        expect(screen.queryByTestId('drop-insert-line')).toBeNull();
    });

    /**
     * §WS-008. jsdom reports `offsetTop === 0` for everything, so the FLIP pass measures no
     * movement and only the INSERT half is observable here — which is the honest split: the
     * reorder half is asserted by the transition being declared on the row, and its motion is
     * a browser concern the audit photographs.
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
        expect(fresh?.style.animation).toContain('nex-sidebar-row-enter');
        // The rows that were already there do NOT replay their entry.
        expect(rows.filter((row) => row.dataset['entering'] === 'true')).toHaveLength(1);
    });

    it('declares the reorder transition on every settled row (§WS-008)', () => {
        render(<Sidebar {...baseProps()} entries={entries()} />);
        for (const row of screen.getAllByTestId('workspace-row')) {
            expect(row.style.transition).toContain('transform');
        }
        expect(screen.getByTestId('group-header').style.transition).toContain('transform');
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
