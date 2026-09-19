import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetGestures } from '../chrome/gesture-reset';
import type { KelpiRuntime } from '../state';
import { createKelpiStore } from '../state';
import { RemoteDaemonSections } from './RemoteDaemonSections';
import type { RemoteDaemonRuntime } from './remote-daemons';

afterEach(cleanup);
beforeEach(() => {
    localStorage.clear();
});

const W1 = 'AAAAAAAA-0000-0000-0000-000000000001';
const W2 = 'AAAAAAAA-0000-0000-0000-000000000002';
const W3 = 'AAAAAAAA-0000-0000-0000-000000000003';
const W4 = 'AAAAAAAA-0000-0000-0000-000000000004';
const G1 = 'EEEEEEEE-0000-0000-0000-000000000001';

function workspace(id: string, name: string): Record<string, unknown> {
    return {
        id,
        name,
        slug: name,
        color: 'blue',
        icon: null,
        labels: [],
        profileName: null,
        repoAssociations: [],
        recentlyClosedCount: 0,
        webPanes: {},
        focusedPaneID: null,
        zoomedPaneID: null,
        isSyncInputActive: false,
        syncInputExcluded: [],
        parkedPaneIDs: [],
        panes: [],
        layout: { kind: 'leaf', paneID: `${id}-p` }
    };
}

function held(options: { collapsedGroup?: boolean } = {}): {
    held: RemoteDaemonRuntime;
    calls: string[];
} {
    const store = createKelpiStore();
    // The remote daemon's OWN structure: two top-level workspaces, then a group of two — the
    // exact `topLevelOrder`/`childOrder` shape its sidebar renders from.
    store.getState().applySnapshot(0, {
        workspaces: [workspace(W1, 'solo'), workspace(W2, 'grp-a'), workspace(W3, 'grp-b'), workspace(W4, 'tail')],
        groups: [
            {
                id: G1,
                name: 'squad',
                color: 'green',
                isCollapsed: options.collapsedGroup === true,
                childOrder: [W2, W3],
                createdAt: 0,
                icon: null
            }
        ],
        topLevelOrder: [
            { kind: 'workspace', id: W1 },
            { kind: 'group', id: G1 },
            { kind: 'workspace', id: W4 }
        ],
        lastActiveWorkspaceID: W1,
        repos: [],
        labelPresets: []
    });
    store.getState().setConnectionStatus('connected');
    const calls: string[] = [];
    const runtime = {
        store,
        commands: {
            setGroupCollapsed: vi.fn((input: { groupID: string; collapsed: boolean }) => {
                calls.push(`collapse:${input.groupID}:${String(input.collapsed)}`);
                return Promise.resolve({ ok: true });
            }),
            moveWorkspace: vi.fn((input: { workspace: string; group?: string; index: number }) => {
                calls.push(`move:${input.workspace}:${input.group ?? 'top'}:${String(input.index)}`);
                return Promise.resolve({ ok: true });
            })
        }
    };
    return {
        held: { name: 'werk', url: 'https://werk/?token=kd_a', runtime: runtime as unknown as KelpiRuntime },
        calls
    };
}

function setRowBox(workspaceID: string, top: number): void {
    const target = [...document.querySelectorAll(`[data-workspace-id="${workspaceID}"]`)][0] as HTMLElement;
    expect(target).toBeTruthy();
    Object.defineProperty(target, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top, height: 20, bottom: top + 20, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} })
    });
}

describe('RemoteDaemonSections (§1.7 accordion)', () => {
    it('renders the remote structure with the LOCAL sidebar’s own row components, in daemon order', () => {
        const h = held();
        render(
            <RemoteDaemonSections daemons={[h.held]} selection={null} onSelect={vi.fn()} bucket="dark" />
        );
        const body = screen.getByTestId('remote-daemon-body-werk');
        // The fidelity contract: remote rows ARE `workspace-row` / `group-header` — the same
        // components the local list renders — not remote-flavoured imitations.
        const rows = [...body.querySelectorAll('[data-testid="workspace-row"]')];
        expect(rows.map((row) => row.getAttribute('data-workspace-id'))).toEqual([W1, W2, W3, W4]);
        const header = body.querySelector('[data-testid="group-header"]');
        expect(header?.getAttribute('data-group-id')).toBe(G1);
        expect(header?.textContent).toContain('squad');
        // Top-level first, then the group and its members — the remote daemon's own order.
        expect(body.textContent?.indexOf('solo')).toBeLessThan(body.textContent?.indexOf('squad') ?? -1);
        // Members carry the nesting depth a local group child has.
        expect(rows[1]?.getAttribute('data-depth') ?? rows[1]?.className).toBeDefined();
    });

    it('honours the REMOTE group’s collapse state and toggles it over the remote connection', () => {
        const h = held({ collapsedGroup: true });
        render(
            <RemoteDaemonSections daemons={[h.held]} selection={null} onSelect={vi.fn()} bucket="dark" />
        );
        const body = screen.getByTestId('remote-daemon-body-werk');
        // Collapsed on the remote = members hidden here, exactly as on that machine.
        expect(body.querySelector(`[data-workspace-id="${W2}"]`)).toBeNull();
        fireEvent.click(body.querySelector('[data-testid="group-header"]') as HTMLElement);
        expect(h.calls).toEqual([`collapse:${G1}:false`]);
    });

    it('the host accordion collapses the whole section, and the choice survives a remount', () => {
        const h = held();
        const view = render(
            <RemoteDaemonSections daemons={[h.held]} selection={null} onSelect={vi.fn()} bucket="dark" />
        );
        expect(screen.getByTestId('remote-daemon-body-werk')).toBeTruthy();
        fireEvent.click(screen.getByTestId('remote-daemon-toggle-werk'));
        expect(screen.queryByTestId('remote-daemon-body-werk')).toBeNull();
        expect(screen.getByTestId('remote-daemon-toggle-werk').getAttribute('aria-expanded')).toBe('false');

        // A remount (sidebar re-created) reads the choice back from localStorage.
        view.unmount();
        render(
            <RemoteDaemonSections daemons={[h.held]} selection={null} onSelect={vi.fn()} bucket="dark" />
        );
        expect(screen.queryByTestId('remote-daemon-body-werk')).toBeNull();
    });

    it('selecting a member workspace hands (daemon, workspace) up, rendered as the ACTIVE row', () => {
        const h = held();
        const onSelect = vi.fn();
        render(
            <RemoteDaemonSections
                daemons={[h.held]}
                selection={{ daemon: 'werk', workspaceID: W2 }}
                onSelect={onSelect}
                bucket="dark"
            />
        );
        const body = screen.getByTestId('remote-daemon-body-werk');
        // The selected remote workspace renders exactly as a local ACTIVE row does.
        expect(body.querySelector(`[data-workspace-id="${W2}"]`)?.getAttribute('data-active')).toBe('true');
        fireEvent.click(body.querySelector(`[data-workspace-id="${W3}"]`) as HTMLElement);
        expect(onSelect).toHaveBeenCalledWith({ daemon: 'werk', workspaceID: W3 });
    });

    it('reorders a top-level remote workspace through that daemon, without activating it on drop', () => {
        const h = held();
        const onSelect = vi.fn();
        render(<RemoteDaemonSections daemons={[h.held]} selection={null} onSelect={onSelect} bucket="dark" />);
        setRowBox(W1, 10);
        setRowBox(W4, 140);
        const tail = document.querySelector(`[data-workspace-id="${W4}"]`) as HTMLElement;
        fireEvent.mouseDown(tail, { button: 0, buttons: 1, clientX: 50, clientY: 150 });
        fireEvent.mouseMove(window, { buttons: 1, clientX: 50, clientY: 15 });
        fireEvent.mouseUp(window, { button: 0, clientX: 50, clientY: 15 });
        fireEvent.click(tail);
        expect(h.calls).toEqual([`move:${W4}:top:0`]);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('keeps group slots in the remote daemon index when a top-level workspace crosses one', () => {
        const h = held();
        render(<RemoteDaemonSections daemons={[h.held]} selection={null} onSelect={vi.fn()} bucket="dark" />);
        setRowBox(W1, 10);
        setRowBox(W4, 140);
        const first = document.querySelector(`[data-workspace-id="${W1}"]`) as HTMLElement;
        fireEvent.mouseDown(first, { button: 0, buttons: 1, clientX: 50, clientY: 20 });
        fireEvent.mouseMove(window, { buttons: 1, clientX: 50, clientY: 155 });
        fireEvent.mouseUp(window, { button: 0, clientX: 50, clientY: 155 });
        // The intervening group is a top-level daemon slot: after removing W1, W4 is at 1,
        // so placing W1 after it is command index 2, not workspace-sibling index 1.
        expect(h.calls).toEqual([`move:${W1}:top:2`]);
    });

    it('reorders a remote group member within its persisted group list', () => {
        const h = held();
        render(<RemoteDaemonSections daemons={[h.held]} selection={null} onSelect={vi.fn()} bucket="dark" />);
        setRowBox(W2, 70);
        setRowBox(W3, 105);
        const first = document.querySelector(`[data-workspace-id="${W2}"]`) as HTMLElement;
        fireEvent.mouseDown(first, { button: 0, buttons: 1, clientX: 50, clientY: 80 });
        fireEvent.mouseMove(window, { buttons: 1, clientX: 50, clientY: 120 });
        fireEvent.mouseUp(window, { button: 0, clientX: 50, clientY: 120 });
        expect(h.calls).toEqual([`move:${W2}:${G1}:1`]);
    });
});

describe('remote reorder cancellation', () => {
    function start(workspaceID = W4, targetY = 15) {
        const h = held();
        const onSelect = vi.fn();
        const view = render(<RemoteDaemonSections daemons={[h.held]} selection={null} onSelect={onSelect} />);
        setRowBox(W1, 10); setRowBox(W2, 70); setRowBox(W3, 105); setRowBox(W4, 140);
        const row = document.querySelector(`[data-workspace-id="${workspaceID}"]`) as HTMLElement;
        fireEvent.mouseDown(row, { button: 0, buttons: 1, clientX: 50, clientY: workspaceID === W2 ? 80 : 150 });
        fireEvent.mouseMove(window, { buttons: 1, clientX: 50, clientY: targetY });
        return { ...h, onSelect, view, row };
    }
    function release(clientX = 50, clientY = 15) {
        fireEvent.mouseUp(window, { button: 0, clientX, clientY });
    }
    it.each([[900, 15], [50, 5], [50, 90], [50, 115], [50, 190]])(
        'rejects non-sibling drop at (%s, %s)', (x, y) => {
            const h = start(); release(x, y); expect(h.calls).toEqual([]);
        }
    );
    it.each(['escape', 'blur', 'pointercancel', 'lost-button', 'collapse', 'disconnect', 'recovery', 'hidden', 'unmount'])(
        'cancels on %s and allows the next ordinary click', (reason) => {
            const h = start();
            if (reason === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
            if (reason === 'blur') fireEvent.blur(window);
            if (reason === 'pointercancel') fireEvent.pointerCancel(window);
            if (reason === 'lost-button') fireEvent.mouseMove(window, { buttons: 0, clientX: 50, clientY: 15 });
            if (reason === 'collapse') fireEvent.click(screen.getByTestId('remote-daemon-toggle-werk'));
            if (reason === 'disconnect') act(() => h.held.runtime.store.getState().setConnectionStatus('reconnecting'));
            if (reason === 'recovery') act(() => { resetGestures(); });
            if (reason === 'hidden') {
                const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
                fireEvent(document, new Event('visibilitychange'));
                visibility.mockRestore();
            }
            if (reason === 'unmount') h.view.unmount();
            release(); expect(h.calls).toEqual([]);
            if (reason === 'collapse') fireEvent.click(screen.getByTestId('remote-daemon-toggle-werk'));
            if (reason !== 'unmount') {
                const row = document.querySelector(`[data-workspace-id="${W1}"]`) as HTMLElement;
                fireEvent.mouseDown(row, { button: 0, buttons: 1, clientX: 50, clientY: 20 });
                fireEvent.mouseUp(row, { button: 0, clientX: 50, clientY: 20 });
                fireEvent.click(row);
                expect(h.onSelect).toHaveBeenCalledWith({ daemon: 'werk', workspaceID: W1 });
            }
        }
    );
    it.each(['reparent', 'delete', 'reorder', 'collapse-group'])(
        'rejects a live source list change: %s', (change) => {
            const h = start(W2, 120);
            act(() => {
                const state = h.held.runtime.store.getState().daemon.state;
                h.held.runtime.store.getState().applySnapshot(1, {
                    ...state,
                    workspaces: change === 'delete' ? state.workspaces.filter(w => w.id !== W2) : state.workspaces,
                    groups: state.groups.map(group => ({ ...group,
                        isCollapsed: change === 'collapse-group',
                        childOrder: change === 'reorder' ? [W3, W2] : change === 'collapse-group' ? [W2, W3] : [W3]
                    })),
                    topLevelOrder: change === 'reparent' ? [...state.topLevelOrder, { kind: 'workspace', id: W2 }] : state.topLevelOrder
                });
            });
            release(50, 120); expect(h.calls).toEqual([]);
        }
    );
    it('rejects changed top-level group slots even if the workspace sibling order is unchanged', () => {
        const h = start();
        act(() => {
            const state = h.held.runtime.store.getState().daemon.state;
            h.held.runtime.store.getState().applySnapshot(1, { ...state, topLevelOrder: [
                { kind: 'group', id: G1 }, { kind: 'workspace', id: W1 }, { kind: 'workspace', id: W4 }
            ] });
        });
        release(); expect(h.calls).toEqual([]);
    });
    it('accepts an unrelated snapshot during the gesture', () => {
        const h = start();
        act(() => {
            const state = h.held.runtime.store.getState().daemon.state;
            h.held.runtime.store.getState().applySnapshot(1, { ...state, lastActiveWorkspaceID: W3 });
        });
        release(); expect(h.calls).toEqual([`move:${W4}:top:0`]);
    });
});
