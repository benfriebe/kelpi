import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaneStatus } from '@kelpi/core/layout';

import { FOCUS_DWELL_MS, FocusRing, useFocusDwell, type FocusDwellOptions } from './FocusRing';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('FocusRing', () => {
    it('draws only for the focused pane', () => {
        const view = render(<FocusRing focused={false} />);
        expect(screen.queryByTestId('focus-ring')).toBeNull();
        view.rerender(<FocusRing focused />);
        const ring = screen.getByTestId('focus-ring');
        expect(ring.style.border).toContain('2px solid');
        expect(ring.getAttribute('aria-hidden')).toBe('true');
    });
});

function Dwell(props: FocusDwellOptions): null {
    useFocusDwell(props);
    return null;
}

describe('useFocusDwell', () => {
    it('fires once, 600ms after focusing a non-idle pane', () => {
        vi.useFakeTimers();
        const onDwellClear = vi.fn();
        render(<Dwell paneID="a" status="waitingForInput" onDwellClear={onDwellClear} />);
        act(() => vi.advanceTimersByTime(FOCUS_DWELL_MS - 1));
        expect(onDwellClear).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(1));
        expect(onDwellClear).toHaveBeenCalledExactlyOnceWith('a');
        act(() => vi.advanceTimersByTime(10 * FOCUS_DWELL_MS));
        expect(onDwellClear).toHaveBeenCalledTimes(1);
    });

    it('never schedules for an idle pane, or when nothing is focused', () => {
        vi.useFakeTimers();
        const onDwellClear = vi.fn();
        const view = render(<Dwell paneID="a" status="idle" onDwellClear={onDwellClear} />);
        act(() => vi.advanceTimersByTime(5000));
        view.rerender(<Dwell paneID={null} status="running" onDwellClear={onDwellClear} />);
        act(() => vi.advanceTimersByTime(5000));
        view.rerender(<Dwell paneID="a" status={null} onDwellClear={onDwellClear} />);
        act(() => vi.advanceTimersByTime(5000));
        expect(onDwellClear).not.toHaveBeenCalled();
    });

    it('reschedules on a focus change, cancelling the pane that lost focus', () => {
        vi.useFakeTimers();
        const onDwellClear = vi.fn();
        const status: PaneStatus = 'running';
        const view = render(<Dwell paneID="a" status={status} onDwellClear={onDwellClear} />);
        act(() => vi.advanceTimersByTime(400));
        view.rerender(<Dwell paneID="b" status={status} onDwellClear={onDwellClear} />);
        act(() => vi.advanceTimersByTime(400));
        expect(onDwellClear).not.toHaveBeenCalled(); // "a"'s timer was torn down at 400ms
        act(() => vi.advanceTimersByTime(200));
        expect(onDwellClear).toHaveBeenCalledExactlyOnceWith('b');
    });

    it('stops when the daemon answers with idle, and does not restart on a callback change', () => {
        vi.useFakeTimers();
        const first = vi.fn();
        const second = vi.fn();
        const view = render(<Dwell paneID="a" status="waitingForInput" onDwellClear={first} />);
        act(() => vi.advanceTimersByTime(300));
        // A parent re-render with a fresh closure must NOT restart the countdown.
        view.rerender(<Dwell paneID="a" status="waitingForInput" onDwellClear={second} />);
        act(() => vi.advanceTimersByTime(300));
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledExactlyOnceWith('a');

        view.rerender(<Dwell paneID="a" status="idle" onDwellClear={second} />);
        act(() => vi.advanceTimersByTime(5000));
        expect(second).toHaveBeenCalledTimes(1);
    });

    /**
     * §AGNT-056: the Swift schedules the SAME 600 ms clear again on `didBecomeActive`, so a
     * badge raised while the user was in another app is acknowledged after they come back —
     * not 600 ms after an event they never saw.
     */
    it('suspends while the app is inactive and schedules a fresh 600 ms on activation', () => {
        vi.useFakeTimers();
        const onDwellClear = vi.fn();
        const props = { paneID: 'a', status: 'waitingForInput' as PaneStatus, onDwellClear };

        // The stop lands while the window is in the background: nothing is acknowledged, no
        // matter how long it sits there.
        const view = render(<Dwell {...props} enabled={false} />);
        act(() => vi.advanceTimersByTime(10 * FOCUS_DWELL_MS));
        expect(onDwellClear).not.toHaveBeenCalled();

        // The user comes back. The countdown starts NOW, from zero.
        view.rerender(<Dwell {...props} enabled />);
        act(() => vi.advanceTimersByTime(FOCUS_DWELL_MS - 1));
        expect(onDwellClear).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(1));
        expect(onDwellClear).toHaveBeenCalledExactlyOnceWith('a');
    });

    it('tears a pending clear down when the app is deactivated mid-countdown', () => {
        vi.useFakeTimers();
        const onDwellClear = vi.fn();
        const props = { paneID: 'a', status: 'waitingForInput' as PaneStatus, onDwellClear };

        const view = render(<Dwell {...props} enabled />);
        act(() => vi.advanceTimersByTime(FOCUS_DWELL_MS - 100));
        // Alt-tab away with 100 ms to go: the acknowledgment must not fire behind their back.
        view.rerender(<Dwell {...props} enabled={false} />);
        act(() => vi.advanceTimersByTime(10 * FOCUS_DWELL_MS));
        expect(onDwellClear).not.toHaveBeenCalled();

        // And coming back gives the full delay again, not the 100 ms that were left.
        view.rerender(<Dwell {...props} enabled />);
        act(() => vi.advanceTimersByTime(FOCUS_DWELL_MS - 1));
        expect(onDwellClear).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(1));
        expect(onDwellClear).toHaveBeenCalledExactlyOnceWith('a');
    });

    it('honours a custom delay and the enabled switch', () => {
        vi.useFakeTimers();
        const onDwellClear = vi.fn();
        const view = render(<Dwell paneID="a" status="running" onDwellClear={onDwellClear} delayMs={50} />);
        act(() => vi.advanceTimersByTime(50));
        expect(onDwellClear).toHaveBeenCalledTimes(1);

        view.rerender(
            <Dwell paneID="b" status="running" onDwellClear={onDwellClear} delayMs={50} enabled={false} />
        );
        act(() => vi.advanceTimersByTime(5000));
        expect(onDwellClear).toHaveBeenCalledTimes(1);
    });
});
