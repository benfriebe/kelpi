import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PHONE_SHEET_HISTORY_STATE, isSheetHistoryState, useSheetHistory, type SheetHistoryLike } from './sheet-history';

function fakeHistory(): SheetHistoryLike & { entries: unknown[]; pops: number } {
    const listeners = new Set<() => void>();
    const fake = {
        entries: [null] as unknown[],
        pops: 0,
        get state() {
            return fake.entries[fake.entries.length - 1];
        },
        pushState(data: unknown) {
            fake.entries.push(data);
        },
        back() {
            if (fake.entries.length <= 1) return;
            fake.entries.pop();
            fake.pops += 1;
            for (const listener of [...listeners]) listener();
        },
        addEventListener(_type: 'popstate', listener: () => void) {
            listeners.add(listener);
        },
        removeEventListener(_type: 'popstate', listener: () => void) {
            listeners.delete(listener);
        }
    };
    return fake;
}

describe('a sheet owns one history entry', () => {
    it('pushes on open, and the back gesture closes the sheet', () => {
        const history = fakeHistory();
        const onBack = vi.fn();
        const { result } = renderHook(() => useSheetHistory(onBack, history));
        act(() => result.current.sync(true));
        expect(history.entries).toHaveLength(2);
        expect(isSheetHistoryState(history.state)).toBe(true);
        act(() => result.current.sync(true)); // a second sheet replacing the first: still one entry
        expect(history.entries).toHaveLength(2);
        act(() => history.back());
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(history.entries).toHaveLength(1);
    });

    it('closing from the UI pops the entry, so the history is what it was', () => {
        const history = fakeHistory();
        const onBack = vi.fn();
        const { result } = renderHook(() => useSheetHistory(onBack, history));
        act(() => result.current.sync(true));
        act(() => result.current.close());
        expect(history.entries).toHaveLength(1);
        expect(history.pops).toBe(1);
        // Closed once: by the tap, not again by the popstate the pop raised.
        expect(onBack).toHaveBeenCalledTimes(1);
        // A later back with nothing open is the browser's own business: nothing is closed twice.
        act(() => history.back());
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('closes directly when there is no history to own', () => {
        const onBack = vi.fn();
        const { result } = renderHook(() => useSheetHistory(onBack, null));
        act(() => result.current.sync(true));
        act(() => result.current.close());
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('names its state so a reload cannot mistake a stale entry for an open sheet', () => {
        expect(isSheetHistoryState({ [PHONE_SHEET_HISTORY_STATE]: true })).toBe(true);
        expect(isSheetHistoryState(null)).toBe(false);
        expect(isSheetHistoryState({ other: true })).toBe(false);
    });
});
