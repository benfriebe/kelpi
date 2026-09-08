import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { StorageLike } from '../app/config';
import {
    DEFAULT_PHONE_VIEW_MODE,
    PHONE_VIEW_MODE_KEY,
    isPhoneViewMode,
    phoneVisiblePaneIDs,
    readStoredViewMode,
    resolveShownPane,
    usePhoneView,
    writeStoredViewMode
} from './view';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly map: Map<string, string> } {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        }
    };
}

function blockedStorage(): StorageLike {
    return {
        getItem: () => {
            throw new Error('SecurityError');
        },
        setItem: () => {
            throw new Error('SecurityError');
        },
        removeItem: () => {
            throw new Error('SecurityError');
        }
    };
}

describe('the remembered view mode', () => {
    it('defaults to one pane at a time', () => {
        expect(DEFAULT_PHONE_VIEW_MODE).toBe('pane');
        expect(readStoredViewMode(memoryStorage())).toBe('pane');
        expect(readStoredViewMode(null)).toBe('pane');
    });

    it('reads a stored layout choice back, and ignores garbage', () => {
        expect(readStoredViewMode(memoryStorage({ [PHONE_VIEW_MODE_KEY]: 'layout' }))).toBe('layout');
        expect(readStoredViewMode(memoryStorage({ [PHONE_VIEW_MODE_KEY]: 'grid' }))).toBe('pane');
        expect(isPhoneViewMode('pane')).toBe(true);
        expect(isPhoneViewMode('layout')).toBe(true);
        expect(isPhoneViewMode(undefined)).toBe(false);
    });

    it('writes the choice, and a blocked store is a convenience lost rather than an error', () => {
        const storage = memoryStorage();
        writeStoredViewMode('layout', storage);
        expect(storage.map.get(PHONE_VIEW_MODE_KEY)).toBe('layout');
        expect(() => writeStoredViewMode('layout', blockedStorage())).not.toThrow();
        expect(readStoredViewMode(blockedStorage())).toBe('pane');
    });
});

describe('the shown pane', () => {
    it('is the focused pane while it is in the layout', () => {
        expect(resolveShownPane('b', ['a', 'b', 'c'])).toBe('b');
    });

    it('falls back to the first pane when nothing (or something gone) holds focus', () => {
        expect(resolveShownPane(null, ['a', 'b'])).toBe('a');
        expect(resolveShownPane('zzz', ['a', 'b'])).toBe('a');
    });

    it('is null for an empty workspace', () => {
        expect(resolveShownPane(null, [])).toBeNull();
        expect(resolveShownPane('a', [])).toBeNull();
    });
});

describe('the visible-pane report on a phone', () => {
    const layoutVisible = ['a', 'b', 'c'];

    it('names the one pane on screen in pane mode', () => {
        expect(phoneVisiblePaneIDs({ mode: 'pane', shownPaneID: 'b', layoutVisible, remoteSelected: false })).toEqual(['b']);
        expect(phoneVisiblePaneIDs({ mode: 'pane', shownPaneID: null, layoutVisible, remoteSelected: false })).toEqual([]);
    });

    it('is the layout’s own set in layout mode', () => {
        expect(phoneVisiblePaneIDs({ mode: 'layout', shownPaneID: 'b', layoutVisible, remoteSelected: false })).toBe(layoutVisible);
    });

    it('is empty while a remote host’s workspace is on screen, whatever the mode', () => {
        expect(phoneVisiblePaneIDs({ mode: 'layout', shownPaneID: 'b', layoutVisible, remoteSelected: true })).toEqual([]);
        expect(phoneVisiblePaneIDs({ mode: 'pane', shownPaneID: 'b', layoutVisible, remoteSelected: true })).toEqual([]);
    });
});

describe('usePhoneView', () => {
    it('holds defaults and touches no storage on a desktop', () => {
        const storage = memoryStorage({ [PHONE_VIEW_MODE_KEY]: 'layout' });
        const getItem = vi.spyOn(storage, 'getItem');
        const { result } = renderHook(() => usePhoneView({ enabled: false, focusedPaneID: 'a', paneOrder: ['a'], storage }));
        expect(result.current.mode).toBe('pane');
        expect(result.current.remote).toBeNull();
        expect(result.current.shownPaneID).toBe('a');
        expect(getItem).not.toHaveBeenCalled();
    });

    it('reads the remembered mode on a phone, and the toggle writes it back', () => {
        const storage = memoryStorage({ [PHONE_VIEW_MODE_KEY]: 'layout' });
        const { result } = renderHook(() => usePhoneView({ enabled: true, focusedPaneID: null, paneOrder: ['a', 'b'], storage }));
        expect(result.current.mode).toBe('layout');
        act(() => result.current.toggleMode());
        expect(result.current.mode).toBe('pane');
        expect(storage.map.get(PHONE_VIEW_MODE_KEY)).toBe('pane');
        act(() => result.current.setMode('layout'));
        expect(result.current.mode).toBe('layout');
        expect(storage.map.get(PHONE_VIEW_MODE_KEY)).toBe('layout');
    });

    it('re-reads the mode on the desktop-to-phone edge, and drops the remote selection on the way back', () => {
        const storage = memoryStorage({ [PHONE_VIEW_MODE_KEY]: 'layout' });
        const { result, rerender } = renderHook(
            ({ enabled }: { enabled: boolean }) => usePhoneView({ enabled, focusedPaneID: 'a', paneOrder: ['a'], storage }),
            { initialProps: { enabled: false } }
        );
        expect(result.current.mode).toBe('pane');
        rerender({ enabled: true });
        expect(result.current.mode).toBe('layout');
        act(() => result.current.selectRemote({ host: 'phone:x', workspaceID: 'w' }));
        expect(result.current.remote).toEqual({ host: 'phone:x', workspaceID: 'w' });
        rerender({ enabled: false });
        expect(result.current.remote).toBeNull();
    });

    it('follows the focused pane, and the first pane when focus is gone', () => {
        const { result, rerender } = renderHook(
            ({ focused, order }: { focused: string | null; order: readonly string[] }) =>
                usePhoneView({ enabled: true, focusedPaneID: focused, paneOrder: order, storage: null }),
            { initialProps: { focused: 'b' as string | null, order: ['a', 'b'] as readonly string[] } }
        );
        expect(result.current.shownPaneID).toBe('b');
        rerender({ focused: 'b', order: ['a'] });
        expect(result.current.shownPaneID).toBe('a');
        rerender({ focused: null, order: [] });
        expect(result.current.shownPaneID).toBeNull();
    });
});
