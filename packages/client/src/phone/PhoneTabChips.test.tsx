import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceTabView } from '../chrome/workspace-tabs';
import { LONG_PRESS_MS } from '../terminal';
import { PhoneTabChips } from './PhoneTabChips';

afterEach(() => {
    cleanup();
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

const TWO = [tab('main', 0), tab('workers', 1)];

/* jsdom has no `PointerEvent`: bubbling `MouseEvent`s with the pointer type names, as elsewhere. */
function pointer(type: string, target: Element, x = 10, y = 10): void {
    act(() => {
        target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
    });
}

describe('the phone tab chips', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('draw nothing with one tab, and a + after the chips with two', () => {
        const onNewTab = vi.fn();
        const one = render(<PhoneTabChips tabs={[tab('main', 0)]} onSelect={vi.fn()} onNewTab={onNewTab} />);
        expect(screen.queryByTestId('phone-tab-chips')).toBeNull();
        one.unmount();
        render(<PhoneTabChips tabs={TWO} onSelect={vi.fn()} onNewTab={onNewTab} />);
        fireEvent.click(screen.getByTestId('phone-tab-new'));
        expect(onNewTab).toHaveBeenCalledTimes(1);
    });

    it('show a tab on a tap', () => {
        const onSelect = vi.fn();
        render(<PhoneTabChips tabs={TWO} onSelect={onSelect} onTabMenu={vi.fn()} />);
        const chip = screen.getByTestId('phone-tab-chip-workers');
        pointer('pointerdown', chip);
        pointer('pointerup', chip);
        fireEvent.click(chip);
        expect(onSelect).toHaveBeenCalledWith('workers');
    });

    it('open the tab sheet on a long press, and the release is not also a tap', () => {
        const onSelect = vi.fn();
        const onTabMenu = vi.fn();
        render(<PhoneTabChips tabs={TWO} onSelect={onSelect} onTabMenu={onTabMenu} />);
        const chip = screen.getByTestId('phone-tab-chip-workers');
        pointer('pointerdown', chip);
        act(() => {
            vi.advanceTimersByTime(LONG_PRESS_MS);
        });
        expect(onTabMenu).toHaveBeenCalledWith(expect.objectContaining({ id: 'workers' }));
        pointer('pointerup', chip);
        fireEvent.click(chip);
        expect(onSelect).not.toHaveBeenCalled();
        // The next tap is a tap again.
        fireEvent.click(chip);
        expect(onSelect).toHaveBeenCalledWith('workers');
    });

    it('read a press that moves as the row scrolling, never a long press', () => {
        const onTabMenu = vi.fn();
        render(<PhoneTabChips tabs={TWO} onSelect={vi.fn()} onTabMenu={onTabMenu} />);
        const chip = screen.getByTestId('phone-tab-chip-workers');
        pointer('pointerdown', chip, 10, 10);
        pointer('pointermove', chip, 40, 10);
        act(() => {
            vi.advanceTimersByTime(LONG_PRESS_MS * 2);
        });
        expect(onTabMenu).not.toHaveBeenCalled();
    });

    it('open the tab sheet on a right-click too, once for a press a browser also answers', () => {
        const onTabMenu = vi.fn();
        render(<PhoneTabChips tabs={TWO} onSelect={vi.fn()} onTabMenu={onTabMenu} />);
        const chip = screen.getByTestId('phone-tab-chip-main');
        fireEvent.contextMenu(chip);
        expect(onTabMenu).toHaveBeenCalledTimes(1);
        // Every right-click opens it, however many in a row.
        fireEvent.contextMenu(chip);
        expect(onTabMenu).toHaveBeenCalledTimes(2);
        onTabMenu.mockClear();
        pointer('pointerdown', chip);
        act(() => {
            vi.advanceTimersByTime(LONG_PRESS_MS);
        });
        // A browser that answers a long press with its own contextmenu: the sheet is open already.
        fireEvent.contextMenu(chip);
        expect(onTabMenu).toHaveBeenCalledTimes(1);
    });
});
