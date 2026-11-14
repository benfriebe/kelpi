import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TAB_SPRING_MS, setTabDropState, setTabSpring, tabSpring } from './tab-drop';
import { TopBar } from './TopBar';
import { fitTabs, TAB_MIN_WIDTH_PX, WorkspaceTabBar, type WorkspaceTabBarProps } from './WorkspaceTabBar';
import type { WorkspaceTabView } from './workspace-tabs';

afterEach(() => {
    cleanup();
    setTabDropState({ dragging: false, target: null });
    setTabSpring(null);
    vi.useRealTimers();
});

function tab(id: string, index: number, extra: Partial<WorkspaceTabView> = {}): WorkspaceTabView {
    return {
        id,
        index,
        title: id,
        named: false,
        kind: 'terminal',
        status: 'idle',
        paneCount: 1,
        paneIDs: [`${id}-pane`],
        active: index === 0,
        attention: false,
        unvisited: false,
        zoomed: false,
        ...extra
    };
}

function props(tabs: readonly WorkspaceTabView[], extra: Partial<WorkspaceTabBarProps> = {}): WorkspaceTabBarProps {
    return {
        tabs,
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onRename: vi.fn(),
        onMove: vi.fn(),
        onNewTab: vi.fn(),
        newTabMenuItems: [{ id: 'new-web-tab', label: 'New Web Tab', onSelect: vi.fn() }],
        tabMenuItems: () => [{ id: 'close-tab', label: 'Close Tab', onSelect: vi.fn() }],
        ...extra
    };
}

const TWO = [tab('main', 0), tab('workers', 1, { paneCount: 2 })];

describe('the tabs', () => {
    it('draws each tab as a tab, the one on screen selected, with its split count', () => {
        render(<WorkspaceTabBar {...props(TWO)} />);
        const tabs = screen.getAllByRole('tab');
        expect(tabs.map((element) => element.getAttribute('aria-selected'))).toEqual(['true', 'false']);
        expect(screen.getByTestId('workspace-tab-count-workers').textContent).toContain('2');
        expect(screen.queryByTestId('workspace-tab-count-main')).toBeNull();
    });

    it('shows a tab on click, and leaves the one on screen alone', () => {
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        fireEvent.click(screen.getByTestId('workspace-tab-workers'));
        fireEvent.click(screen.getByTestId('workspace-tab-main'));
        expect(p.onSelect).toHaveBeenCalledExactlyOnceWith('workers');
    });

    it('closes with its ×, or a middle click, but never the only tab', () => {
        const p = props(TWO);
        const view = render(<WorkspaceTabBar {...p} />);
        fireEvent.click(screen.getByTestId('workspace-tab-close-workers'));
        fireEvent(screen.getByTestId('workspace-tab-main'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
        expect(p.onClose).toHaveBeenNthCalledWith(1, 'workers');
        expect(p.onClose).toHaveBeenNthCalledWith(2, 'main');
        view.rerender(<WorkspaceTabBar {...props([tab('main', 0)])} />);
        expect(screen.queryByTestId('workspace-tab-close-main')).toBeNull();
    });

    it('renames in place on double-click: Enter keeps, blank clears, Escape cancels', () => {
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        fireEvent.doubleClick(screen.getByTestId('workspace-tab-workers'));
        const field = screen.getByTestId('workspace-tab-rename') as HTMLInputElement;
        fireEvent.change(field, { target: { value: '  cart workers ' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(p.onRename).toHaveBeenLastCalledWith('workers', 'cart workers');

        fireEvent.doubleClick(screen.getByTestId('workspace-tab-workers'));
        fireEvent.change(screen.getByTestId('workspace-tab-rename'), { target: { value: '' } });
        fireEvent.keyDown(screen.getByTestId('workspace-tab-rename'), { key: 'Enter' });
        expect(p.onRename).toHaveBeenLastCalledWith('workers', null);

        fireEvent.doubleClick(screen.getByTestId('workspace-tab-main'));
        fireEvent.keyDown(screen.getByTestId('workspace-tab-rename'), { key: 'Escape' });
        expect(p.onRename).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId('workspace-tab-rename')).toBeNull();
    });

    it('opens the tab menu on right-click, Rename Tab… first', () => {
        render(<WorkspaceTabBar {...props(TWO)} />);
        fireEvent.contextMenu(screen.getByTestId('workspace-tab-workers'));
        const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
        expect(items[0]).toContain('Rename Tab…');
        expect(items.some((text) => text?.includes('Close Tab'))).toBe(true);
    });

    it('opens a tab from + and offers the kinds on its chevron', () => {
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        fireEvent.click(screen.getByTestId('workspace-tab-new'));
        expect(p.onNewTab).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId('workspace-tab-new-menu'));
        expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toContain('New Web Tab');
    });

    it('marks attention, an unvisited tab, and a zoomed one', () => {
        render(
            <WorkspaceTabBar
                {...props([
                    tab('main', 0),
                    tab('waiting', 1, { active: false, status: 'waitingForInput', attention: true }),
                    tab('agent', 2, { active: false, unvisited: true }),
                    tab('zoomed', 3, { active: false, zoomed: true })
                ])}
            />
        );
        expect(screen.getByTestId('workspace-tab-waiting').getAttribute('data-attention')).toBe('true');
        expect(screen.getByTestId('workspace-tab-agent').getAttribute('data-unvisited')).toBe('true');
        expect(screen.getByTestId('workspace-tab-zoomed').textContent).toContain('ZOOM');
    });

    it('shows ⌥⌘N while ⌥⌘ is held', () => {
        render(<WorkspaceTabBar {...props(TWO)} />);
        expect(screen.getByTestId('workspace-tab-workers').textContent).not.toContain('⌥⌘2');
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', altKey: true, metaKey: true }));
        });
        expect(screen.getByTestId('workspace-tab-workers').textContent).toContain('⌥⌘2');
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', altKey: false, metaKey: true }));
        });
        expect(screen.getByTestId('workspace-tab-workers').textContent).not.toContain('⌥⌘2');
    });

    it('moves the selection with the arrow keys', () => {
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        fireEvent.keyDown(screen.getByTestId('workspace-tab-main'), { key: 'ArrowRight' });
        expect(p.onSelect).toHaveBeenLastCalledWith('workers');
    });
});

describe('a pane dragged over the bar', () => {
    it('draws the new-tab slot and the target tab while the grid says a pane is in flight', () => {
        render(<WorkspaceTabBar {...props(TWO)} />);
        expect(screen.queryByTestId('workspace-tab-drop-slot')).toBeNull();
        act(() => {
            setTabDropState({ dragging: true, target: { kind: 'tab', tabID: 'workers' } });
        });
        const slot = screen.getByTestId('workspace-tab-drop-slot');
        expect(slot.getAttribute('data-tab-drop-slot')).toBe('2');
        expect(screen.getByTestId('workspace-tab-workers').style.outline).toContain('dashed');
        act(() => {
            setTabDropState({ dragging: true, target: { kind: 'slot', index: 1 } });
        });
        expect(screen.getAllByTestId('workspace-tab-insertion')).toHaveLength(1);
    });
});

describe('a tab dragged', () => {
    /*
     * jsdom has no `PointerEvent`, and Testing Library's stand-ins arrive without coordinates or
     * buttons, so these are bubbling `MouseEvent`s with the pointer type names (as
     * `sidebar-resizer-lockout.test.tsx` does).
     */
    const press = (tabID: string, x = 10): void => {
        act(() => {
            screen.getByTestId(`workspace-tab-${tabID}`).dispatchEvent(
                new MouseEvent('pointerdown', { clientX: x, clientY: 10, button: 0, buttons: 1, bubbles: true })
            );
        });
    };
    const moveTo = (x: number, buttons = 1): void => {
        act(() => {
            window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: 10, buttons }));
        });
    };
    const release = (x: number, y = 10): void => {
        act(() => {
            window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y }));
        });
    };

    it('turns the window handle off while it moves, and back on at the release, wherever that is', () => {
        const onDraggingChange = vi.fn();
        render(<WorkspaceTabBar {...props(TWO, { onDraggingChange })} />);
        press('main');
        moveTo(40);
        expect(onDraggingChange).toHaveBeenLastCalledWith(true);
        // Released off every tab: the window still hears it.
        release(400, 300);
        expect(onDraggingChange).toHaveBeenLastCalledWith(false);
    });

    it('never wakes up from a press whose release it missed', () => {
        const onDraggingChange = vi.fn();
        render(<WorkspaceTabBar {...props(TWO, { onDraggingChange })} />);
        press('main');
        // A move with no button held: the release went somewhere else, so the press is over.
        moveTo(40, 0);
        moveTo(80, 1);
        expect(onDraggingChange).not.toHaveBeenCalled();
    });

    it('is cancelled by Escape, which moves nothing', () => {
        const p = props(TWO, { onDraggingChange: vi.fn() });
        render(<WorkspaceTabBar {...p} />);
        press('main');
        moveTo(40);
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(p.onDraggingChange).toHaveBeenLastCalledWith(false);
        release(400);
        expect(p.onMove).not.toHaveBeenCalled();
    });

    it('ends when the bar goes away mid-drag', () => {
        const onDraggingChange = vi.fn();
        const view = render(<WorkspaceTabBar {...props(TWO, { onDraggingChange })} />);
        press('main');
        moveTo(40);
        view.unmount();
        expect(onDraggingChange).toHaveBeenLastCalledWith(false);
    });

    it('moves nothing when the tab it carries closed in flight', () => {
        const p = props(TWO, { onDraggingChange: vi.fn() });
        const view = render(<WorkspaceTabBar {...p} />);
        press('workers');
        moveTo(40);
        view.rerender(<WorkspaceTabBar {...p} tabs={[tab('main', 0)]} />);
        release(0);
        expect(p.onMove).not.toHaveBeenCalled();
        expect(p.onDraggingChange).toHaveBeenLastCalledWith(false);
    });

    it('leaves the click that ends it unanswered, and the next click answered', async () => {
        const p = props(TWO, { onDraggingChange: vi.fn() });
        render(<WorkspaceTabBar {...p} />);
        press('workers');
        moveTo(40);
        release(400, 300);
        fireEvent.click(screen.getByTestId('workspace-tab-workers'));
        expect(p.onSelect).not.toHaveBeenCalled();
        await new Promise((resolve) => setTimeout(resolve, 0));
        fireEvent.click(screen.getByTestId('workspace-tab-workers'));
        expect(p.onSelect).toHaveBeenCalledWith('workers');
    });
});

describe('a tab dropped on a sidebar row', () => {
    /*
     * A sidebar with this daemon's row (W-LOCAL) and a paired daemon "werk"'s row (W-REMOTE), and
     * jsdom's missing `elementsFromPoint` answering with whichever row the pointer is over.
     */
    const sidebar = (): { local: HTMLElement; remote: HTMLElement; restore: () => void } => {
        const row = (id: string): HTMLElement => {
            const element = document.createElement('div');
            element.setAttribute('data-testid', 'workspace-row');
            element.setAttribute('data-workspace-id', id);
            return element;
        };
        const local = row('W-LOCAL');
        const sections = document.createElement('div');
        sections.setAttribute('data-testid', 'remote-daemon-sections');
        const section = document.createElement('div');
        section.setAttribute('data-remote-daemon', 'werk');
        const remote = row('W-REMOTE');
        section.append(remote);
        sections.append(section);
        document.body.append(local, sections);
        const original = (document as { elementsFromPoint?: unknown }).elementsFromPoint;
        (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = (x) =>
            x >= 1000 ? [remote] : x >= 500 ? [local] : [];
        return {
            local,
            remote,
            restore: () => {
                local.remove();
                sections.remove();
                (document as { elementsFromPoint?: unknown }).elementsFromPoint = original;
            }
        };
    };
    const drag = (tabID: string, x: number): void => {
        act(() => {
            screen.getByTestId(`workspace-tab-${tabID}`).dispatchEvent(
                new MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, buttons: 1, bubbles: true })
            );
        });
        act(() => {
            window.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 10, buttons: 1 }));
        });
        act(() => {
            window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: 300, buttons: 1 }));
        });
        act(() => {
            window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: 300 }));
        });
    };

    it("moves this daemon's tab onto this daemon's row, and never onto a paired daemon's", () => {
        const rows = sidebar();
        try {
            const onMoveToWorkspace = vi.fn();
            render(<WorkspaceTabBar {...props(TWO, { onMoveToWorkspace })} />);
            drag('workers', 600);
            expect(onMoveToWorkspace).toHaveBeenLastCalledWith('workers', 'W-LOCAL');
            drag('workers', 1200);
            expect(onMoveToWorkspace).toHaveBeenCalledTimes(1);
        } finally {
            rows.restore();
        }
    });

    it("moves a paired daemon's tab onto that daemon's row only", () => {
        const rows = sidebar();
        try {
            const onMoveToWorkspace = vi.fn();
            render(<WorkspaceTabBar {...props(TWO, { onMoveToWorkspace, rowDaemon: 'werk' })} />);
            drag('workers', 1200);
            expect(onMoveToWorkspace).toHaveBeenLastCalledWith('workers', 'W-REMOTE');
            drag('workers', 600);
            expect(onMoveToWorkspace).toHaveBeenCalledTimes(1);
        } finally {
            rows.restore();
        }
    });

    it("refuses another paired daemon's rows", () => {
        const rows = sidebar();
        try {
            const onMoveToWorkspace = vi.fn();
            render(<WorkspaceTabBar {...props(TWO, { onMoveToWorkspace, rowDaemon: 'elsewhere' })} />);
            drag('workers', 1200);
            drag('workers', 600);
            expect(onMoveToWorkspace).not.toHaveBeenCalled();
        } finally {
            rows.restore();
        }
    });
});

describe('the tabs and the caret', () => {
    it('never take the caret from the pane on a press', () => {
        render(<WorkspaceTabBar {...props(TWO)} />);
        const pressed = fireEvent.mouseDown(screen.getByTestId('workspace-tab-workers'));
        expect(pressed).toBe(false);
    });

    it('hand the caret back when a rename ends with Enter or Escape', () => {
        const onReleaseCaret = vi.fn();
        render(<WorkspaceTabBar {...props(TWO, { onReleaseCaret })} />);
        fireEvent.doubleClick(screen.getByTestId('workspace-tab-workers'));
        fireEvent.keyDown(screen.getByTestId('workspace-tab-rename'), { key: 'Enter' });
        expect(onReleaseCaret).toHaveBeenCalledTimes(1);
        fireEvent.doubleClick(screen.getByTestId('workspace-tab-main'));
        fireEvent.keyDown(screen.getByTestId('workspace-tab-rename'), { key: 'Escape' });
        expect(onReleaseCaret).toHaveBeenCalledTimes(2);
    });

    it('a click inside the rename field of a tab behind does not show that tab', () => {
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        fireEvent.doubleClick(screen.getByTestId('workspace-tab-workers'));
        fireEvent.click(screen.getByTestId('workspace-tab-rename'));
        expect(p.onSelect).not.toHaveBeenCalled();
    });
});

describe('the tab bar controls', () => {
    it('a double-click on × is two closes, not a rename', () => {
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        fireEvent.doubleClick(screen.getByTestId('workspace-tab-close-main'));
        expect(screen.queryByTestId('workspace-tab-rename')).toBeNull();
    });

    it('closes the kinds menu from its own chevron', () => {
        render(<WorkspaceTabBar {...props(TWO)} />);
        const chevron = screen.getByTestId('workspace-tab-new-menu');
        fireEvent.click(chevron);
        expect(screen.getByText('New Web Tab')).toBeTruthy();
        fireEvent.mouseDown(chevron);
        fireEvent.click(chevron);
        expect(screen.queryByText('New Web Tab')).toBeNull();
    });
});

describe('a pane held over a tab (spring-loading)', () => {
    const hover = (target: Parameters<typeof setTabDropState>[0]['target']): void => {
        act(() => {
            setTabDropState({ dragging: true, target });
        });
    };

    it('opens a tab behind after the hold, filling it meanwhile, and remembers where the drag began', () => {
        vi.useFakeTimers();
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        hover({ kind: 'tab', tabID: 'workers' });
        expect(screen.getByTestId('workspace-tab-workers').querySelector('[data-testid="workspace-tab-spring"]')).not.toBeNull();
        act(() => {
            vi.advanceTimersByTime(TAB_SPRING_MS - 1);
        });
        expect(p.onSelect).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(p.onSelect).toHaveBeenCalledWith('workers');
        expect(tabSpring()).toMatchObject({ originTabID: 'main', tabID: 'workers' });
        // Going back is showing the tab the drag started in, asked for even though the window
        // may not show the opened tab yet (its request can still be on the way).
        tabSpring()?.returnHome();
        expect(p.onSelect).toHaveBeenLastCalledWith('main', { force: true });
    });

    it('starts over when the pointer leaves the tab before the hold is up', () => {
        vi.useFakeTimers();
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        hover({ kind: 'tab', tabID: 'workers' });
        act(() => {
            vi.advanceTimersByTime(TAB_SPRING_MS - 100);
        });
        hover(null);
        act(() => {
            vi.advanceTimersByTime(TAB_SPRING_MS);
        });
        expect(p.onSelect).not.toHaveBeenCalled();
        expect(screen.queryByTestId('workspace-tab-spring')).toBeNull();
    });

    it('never springs the tab on screen, a gap between tabs or the new-tab slot', () => {
        vi.useFakeTimers();
        const p = props(TWO);
        render(<WorkspaceTabBar {...p} />);
        for (const target of [{ kind: 'tab' as const, tabID: 'main' }, { kind: 'slot' as const, index: 1 }, { kind: 'slot' as const, index: 2 }]) {
            hover(target);
            act(() => {
                vi.advanceTimersByTime(TAB_SPRING_MS * 2);
            });
        }
        expect(p.onSelect).not.toHaveBeenCalled();
        expect(tabSpring()).toBeNull();
    });

    it('keeps the tab the drag began in when it springs on to a third tab, and forgets it back home', () => {
        vi.useFakeTimers();
        const three = [tab('main', 0), tab('workers', 1), tab('docs', 2)];
        const p = props(three);
        const view = render(<WorkspaceTabBar {...p} />);
        hover({ kind: 'tab', tabID: 'workers' });
        act(() => {
            vi.advanceTimersByTime(TAB_SPRING_MS);
        });
        // The window shows `workers` now.
        view.rerender(<WorkspaceTabBar {...p} tabs={[tab('main', 0, { active: false }), tab('workers', 1, { active: true }), tab('docs', 2)]} />);
        hover({ kind: 'tab', tabID: 'docs' });
        act(() => {
            vi.advanceTimersByTime(TAB_SPRING_MS);
        });
        expect(tabSpring()).toMatchObject({ originTabID: 'main', tabID: 'docs' });
        view.rerender(<WorkspaceTabBar {...p} tabs={[tab('main', 0, { active: false }), tab('workers', 1), tab('docs', 2, { active: true })]} />);
        hover({ kind: 'tab', tabID: 'main' });
        act(() => {
            vi.advanceTimersByTime(TAB_SPRING_MS);
        });
        expect(p.onSelect).toHaveBeenLastCalledWith('main');
        expect(tabSpring()).toBeNull();
    });
});

describe('fitTabs', () => {
    const many = Array.from({ length: 10 }, (_, index) => tab(`t${String(index)}`, index, { active: index === 8 }));

    it('keeps every tab while they fit at their minimum width', () => {
        expect(fitTabs(many.slice(0, 3), 1000).hidden).toEqual([]);
        expect(fitTabs(many, null).hidden).toEqual([]);
    });

    it('overflows the rest, never hiding the tab on screen', () => {
        const room = (TAB_MIN_WIDTH_PX + 2) * 5 + 48 + 46;
        const fitted = fitTabs(many, room);
        expect(fitted.visible.length + fitted.hidden.length).toBe(10);
        expect(fitted.visible.map((entry) => entry.id)).toContain('t8');
        expect(fitted.hidden.map((entry) => entry.id)).not.toContain('t8');
    });

    it('folds every tab into "+N" when not even one fits, so none is drawn over the bar', () => {
        const fitted = fitTabs(many.slice(0, 3), 40);
        expect(fitted.visible).toEqual([]);
        expect(fitted.hidden.length).toBe(3);
    });

    it('leaves room for the pane-drop slot while a pane is dragged', () => {
        const room = (TAB_MIN_WIDTH_PX + 2) * 3 + 48;
        expect(fitTabs(many.slice(0, 3), room).hidden).toEqual([]);
        expect(fitTabs(many.slice(0, 3), room, 72).hidden.length).toBeGreaterThan(0);
    });

    it('reports how wide the tabs come out, capped at the maximum', () => {
        expect(fitTabs(many.slice(0, 2), 2000).width).toBe(220);
        expect(fitTabs(many.slice(0, 2), 48 + 2 * 120 + 2).width).toBe(120);
    });
});

describe('the title bar with tabs', () => {
    const base = { workspaceName: 'dev', panes: [], connection: 'connected' as const, onToggleSidebar: vi.fn() };

    it('draws the tabs instead of the centred identity, after a separator as wide as the sidebar', () => {
        render(<TopBar {...base} tabs={props(TWO)} leadWidth={232} trafficLightInset={80} dragRegion />);
        expect(screen.queryByTestId('top-bar-identity')).toBeNull();
        const lead = screen.getByTestId('top-bar-lead');
        expect(lead.style.minWidth).toBe('232px');
        expect(lead.style.paddingLeft).toBe('80px');
        expect(lead.className).toContain('border-r');
        expect(screen.getByTestId('top-bar').style.paddingLeft).toBe('0px');
        expect(screen.getByTestId('top-bar-drag-gap').style.width).toBe('56px');
    });

    it('keeps the identity where there are no tabs to draw', () => {
        render(<TopBar {...base} />);
        expect(screen.getByTestId('top-bar-identity').textContent).toContain('dev');
    });

    it('stops being the window drag handle while a pane is dragged', () => {
        render(<TopBar {...base} tabs={props(TWO)} dragRegion />);
        expect(screen.getByTestId('top-bar').getAttribute('data-titlebar-drag')).toBe('true');
        act(() => {
            setTabDropState({ dragging: true, target: null });
        });
        expect(screen.getByTestId('top-bar').getAttribute('data-titlebar-drag')).toBe('false');
    });
});
