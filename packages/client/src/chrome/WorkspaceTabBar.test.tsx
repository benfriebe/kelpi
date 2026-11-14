import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setTabDropState } from './tab-drop';
import { TopBar } from './TopBar';
import { fitTabs, TAB_MIN_WIDTH_PX, WorkspaceTabBar, type WorkspaceTabBarProps } from './WorkspaceTabBar';
import type { WorkspaceTabView } from './workspace-tabs';

afterEach(() => {
    cleanup();
    setTabDropState({ dragging: false, target: null });
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
