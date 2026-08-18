import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chromeElapsedLabel, tickerListenerCount, useSecondsTicker } from './elapsed';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('chromeElapsedLabel', () => {
    it('formats seconds, minutes and hours (shell-ui.md §2)', () => {
        const table: [number, string][] = [
            [0, '0s'],
            [9, '9s'],
            [59, '59s'],
            [60, '1m 0s'],
            [249, '4m 9s'],
            [3599, '59m 59s'],
            [3600, '1h 0m'],
            [3661, '1h 1m'],
            [90_061, '25h 1m']
        ];
        for (const [elapsed, expected] of table) {
            expect(chromeElapsedLabel(1000, 1000 + elapsed)).toBe(expected);
        }
    });

    it('clamps a clock that ran backwards', () => {
        expect(chromeElapsedLabel(1000, 900)).toBe('0s');
    });

    it('floors fractional epoch seconds', () => {
        expect(chromeElapsedLabel(1000.25, 1009.75)).toBe('9s');
    });
});

function Clock({ active }: { active: boolean }): ReactElement {
    const second = useSecondsTicker(active);
    return createElement('span', { 'data-testid': 'clock' }, String(second));
}

describe('useSecondsTicker', () => {
    it('re-renders once a second while active and stops when it is not', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000_000);
        const view = render(createElement(Clock, { active: true }));
        const start = Number(view.getByTestId('clock').textContent);
        act(() => vi.advanceTimersByTime(3000));
        expect(Number(view.getByTestId('clock').textContent)).toBe(start + 3);

        view.rerender(createElement(Clock, { active: false }));
        expect(tickerListenerCount()).toBe(0);
        act(() => vi.advanceTimersByTime(5000));
        expect(Number(view.getByTestId('clock').textContent)).toBe(start + 3);
    });

    it('shares one interval across every subscriber and releases it on unmount', () => {
        vi.useFakeTimers();
        const clearInterval = vi.spyOn(globalThis, 'clearInterval');
        const setInterval = vi.spyOn(globalThis, 'setInterval');
        const view = render(
            createElement('div', null, [
                createElement(Clock, { active: true, key: '1' }),
                createElement(Clock, { active: true, key: '2' }),
                createElement(Clock, { active: true, key: '3' })
            ])
        );
        expect(tickerListenerCount()).toBe(3);
        expect(setInterval).toHaveBeenCalledTimes(1);
        view.unmount();
        expect(tickerListenerCount()).toBe(0);
        expect(clearInterval).toHaveBeenCalledTimes(1);
    });
});
