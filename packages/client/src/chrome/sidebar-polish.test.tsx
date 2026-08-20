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
