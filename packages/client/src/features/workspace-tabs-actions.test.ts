import { createStore, emptyDaemonState, type DaemonState, type WorkspaceState } from '@kelpi/daemon/store';
import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceTabActions, tabCloseOwner, type TabCloseOwner, type WorkspaceTabActionHost } from './workspace-tabs-actions';

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

describe('duplicating a tab', () => {
    it('asks the daemon for a copy of the named tab, or of the tab on screen', () => {
        const h = host();
        const actions = createWorkspaceTabActions(h);
        actions.duplicateTab(T1);
        actions.duplicateActiveTab();
        expect(h.raw.mock.calls.map(([payload]) => payload)).toEqual([
            expect.objectContaining({ command: 'workspace-tab-duplicate', workspace_id: W, tab_id: T1 }),
            expect.objectContaining({ command: 'workspace-tab-duplicate', workspace_id: W, tab_id: T2 })
        ]);
    });
});

describe('a pane dropped onto a tab', () => {
    it('goes into the tab, beside a pane in the wire spelling, or into a new tab at a bar position', () => {
        const h = host();
        const actions = createWorkspaceTabActions(h);
        actions.movePaneOntoTab(P0, { kind: 'tab', tabID: T1 });
        actions.movePaneOntoTab(P0, { kind: 'tab', tabID: T1, beside: { paneID: P1, zone: 'left' } });
        actions.movePaneOntoTab(P0, { kind: 'slot', index: 2 });
        const sent = h.raw.mock.calls.map(([payload]) => payload as Record<string, unknown>);
        expect(sent[0]).toMatchObject({ command: 'pane-move-to-tab', pane_id: P0, tab_id: T1 });
        expect(sent[0]?.['target_pane_id']).toBeUndefined();
        expect(sent[1]).toMatchObject({ command: 'pane-move-to-tab', pane_id: P0, tab_id: T1, target_pane_id: P1, zone: 'left-of' });
        expect(sent[2]).toMatchObject({ command: 'pane-move-to-new-tab', pane_id: P0, index: 2 });
    });
    it('never names a pane beside which is not in that tab (a grid that still drew another tab)', () => {
        const h = host();
        createWorkspaceTabActions(h).movePaneOntoTab(P0, { kind: 'tab', tabID: T1, beside: { paneID: P2, zone: 'right' } });
        const sent = h.raw.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(sent).toMatchObject({ command: 'pane-move-to-tab', pane_id: P0, tab_id: T1 });
        expect(sent['target_pane_id']).toBeUndefined();
        expect(sent['zone']).toBeUndefined();
    });
});

describe('selecting a tab', () => {
    it('asks nothing for the tab on screen, unless forced (a spring going home)', () => {
        const h = host();
        const actions = createWorkspaceTabActions(h);
        // T2 is on screen (the last tab created).
        expect(actions.selectTab(T2)).toBe(true);
        expect(h.raw).not.toHaveBeenCalled();
        actions.selectTab(T2, true);
        expect(h.raw.mock.calls.map(([payload]) => payload)).toEqual([
            expect.objectContaining({ command: 'workspace-tab-select', workspace_id: W, tab_id: T2 })
        ]);
    });
});

describe("a paired daemon's close-tab setting", () => {
    it("asks under the tabs' own daemon's setting, and turns that one off", () => {
        const setGeneralSetting = vi.fn(() => Promise.resolve({ ok: true }));
        const paired = {
            store: { getState: () => ({ settings: { value: { general: { confirmWorkspaceDeleteWhenActive: false } } } }) },
            commands: { setGeneralSetting }
        } as unknown as Parameters<typeof tabCloseOwner>[0];
        const owner = tabCloseOwner(paired);
        const confirmClose = vi.fn((_workspace: WorkspaceState, _tabIDs: readonly string[], close: () => boolean, _owner?: TabCloseOwner) => close());
        const h = host({ confirmClose, closeOwner: () => owner });
        createWorkspaceTabActions(h).closeTab(T1);
        expect(confirmClose.mock.calls[0]?.[3]).toBe(owner);
        expect(owner.confirmWhenActive()).toBe(false);
        owner.suppress();
        expect(setGeneralSetting).toHaveBeenCalledExactlyOnceWith({ key: 'confirm-workspace-delete', value: 'false' });
    });
});

describe('renaming a tab', () => {
    it("names the tab's own workspace, even when another one is on screen by then", () => {
        const owner = threeTabs();
        const elsewhere = { ...owner, id: 'AAAAAAAA-0000-4000-8000-000000000002', tabs: [] } as unknown as WorkspaceState;
        const h = host({ activeWorkspace: () => elsewhere, workspaces: () => [elsewhere, owner] });
        createWorkspaceTabActions(h).renameTab(T1, 'api');
        expect(h.raw.mock.calls.map(([payload]) => payload)).toEqual([
            expect.objectContaining({ command: 'workspace-tab-rename', workspace_id: W, tab_id: T1, name: 'api' })
        ]);
        // A tab no workspace holds names nothing.
        expect(createWorkspaceTabActions(h).renameTab('FFFFFFFF-0000-4000-8000-0000000000ff', 'x')).toBe(false);
    });
});

describe('the palette rows for the tab on screen', () => {
    it("offers the daemon's other workspaces as Move Tab targets, and acts on the tab on screen", () => {
        const owner = threeTabs();
        const other = { ...owner, id: 'AAAAAAAA-0000-4000-8000-000000000003', name: 'ops' } as WorkspaceState;
        const h = host({ workspaces: () => [owner, other] });
        const actions = createWorkspaceTabActions(h);
        expect(actions.moveTabTargets()).toEqual([{ id: other.id, name: 'ops' }]);
        expect(actions.moveActiveTabToWorkspace(owner.id)).toBe(false);
        actions.moveActiveTabToWorkspace(other.id);
        expect(h.raw.mock.calls.at(-1)?.[0]).toEqual(
            expect.objectContaining({ command: 'workspace-tab-move-to-workspace', workspace_id: W, to_workspace_id: other.id })
        );
    });
});
