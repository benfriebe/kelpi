import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tickerListenerCount, useSecondsTicker } from './index';

afterEach(cleanup);

describe('the shared seconds ticker', () => {
    it('advances once per second and stops when the last consumer unmounts', () => {
        vi.useFakeTimers();
        try {
            const first = renderHook(() => useSecondsTicker(true));
            const second = renderHook(() => useSecondsTicker(true));
            // One interval, however many badges subscribe (agent-lifecycle.md §12 rule 12).
            expect(tickerListenerCount()).toBe(2);

            const start = first.result.current;
            expect(second.result.current).toBe(start);

            act(() => {
                vi.advanceTimersByTime(2_000);
            });
            expect(first.result.current).toBe(start + 2);
            expect(second.result.current).toBe(start + 2);

            first.unmount();
            expect(tickerListenerCount()).toBe(1);
            second.unmount();
            expect(tickerListenerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('holds no timer while inactive', () => {
        vi.useFakeTimers();
        try {
            const view = renderHook(() => useSecondsTicker(false));
            expect(tickerListenerCount()).toBe(0);
            const value = view.result.current;
            act(() => {
                vi.advanceTimersByTime(5_000);
            });
            expect(view.result.current).toBe(value);
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });
});
