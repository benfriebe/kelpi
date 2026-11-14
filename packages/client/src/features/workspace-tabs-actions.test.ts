import { createStore, emptyDaemonState, type DaemonState, type WorkspaceState } from '@kelpi/daemon/store';
import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceTabActions, type WorkspaceTabActionHost } from './workspace-tabs-actions';

const W = 'AAAAAAAA-0000-4000-8000-000000000001';
const P0 = 'DDDDDDDD-0000-4000-8000-000000000100';
const P1 = 'EEEEEEEE-0000-4000-8000-000000000001';
const P2 = 'EEEEEEEE-0000-4000-8000-000000000002';
const T1 = 'FFFFFFFF-0000-4000-8000-000000000001';
const T2 = 'FFFFFFFF-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

function threeTabs(): WorkspaceState {
    const store = createStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W, paneID: P0, name: 'dev', color: 'blue', now: NOW, workingDirectory: '/Users/test' });
    store.dispatch({ type: 'create-tab', workspaceID: W, tabID: T1, create: { type: 'create-pane', workspaceID: W, paneID: P1, now: NOW, workingDirectory: '/Users/test' } });
    store.dispatch({ type: 'create-tab', workspaceID: W, tabID: T2, create: { type: 'create-pane', workspaceID: W, paneID: P2, now: NOW, workingDirectory: '/Users/test' } });
    return (store.getState() as DaemonState).workspaces[0] as WorkspaceState;
}

function host(extra: Partial<WorkspaceTabActionHost> = {}): WorkspaceTabActionHost & { readonly raw: ReturnType<typeof vi.fn> } {
    const workspace = threeTabs();
    const raw = vi.fn(() => Promise.resolve({ ok: true }));
    return {
        raw,
        commands: { raw } as unknown as WorkspaceTabActionHost['commands'],
        activeWorkspace: () => workspace,
        focusedPaneID: () => P2,
        run: () => true,
        ...extra
    };
}

describe('closing tabs', () => {
    it('closes at once when nothing asks', () => {
        const h = host();
        expect(createWorkspaceTabActions(h).closeTab(T1)).toBe(true);
        expect(h.raw).toHaveBeenCalledTimes(1);
    });

    it('lets the host ask first, with the tabs a close would take, and closes only when it says so', () => {
        const asked: string[][] = [];
        let later: (() => boolean) | null = null;
        const h = host({
            confirmClose: (_workspace, tabIDs, close) => {
                asked.push([...tabIDs]);
                later = close;
                return true;
            }
        });
        const actions = createWorkspaceTabActions(h);
        actions.closeActiveTab();
        actions.closeOtherTabs(T1);
        expect(asked).toEqual([[T2], [W, T2]]);
        expect(h.raw).not.toHaveBeenCalled();
        (later as unknown as () => boolean)();
        expect(h.raw).toHaveBeenCalledTimes(1);
    });
});
