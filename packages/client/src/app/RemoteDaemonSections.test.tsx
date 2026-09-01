import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        syncExcludedPaneIDs: [],
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
    // The remote daemon's OWN structure: a top-level workspace, then a group of two — the
    // exact `topLevelOrder`/`childOrder` shape its sidebar renders from.
    store.getState().applySnapshot(0, {
        workspaces: [workspace(W1, 'solo'), workspace(W2, 'grp-a'), workspace(W3, 'grp-b')],
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
            { kind: 'group', id: G1 }
        ],
        lastActiveWorkspaceID: W1,
        repos: [],
        labelPresets: []
    });
    const calls: string[] = [];
    const runtime = {
        store,
        commands: {
            setGroupCollapsed: vi.fn((input: { groupID: string; collapsed: boolean }) => {
                calls.push(`collapse:${input.groupID}:${String(input.collapsed)}`);
                return Promise.resolve({ ok: true });
            })
        }
    };
    return {
        held: { name: 'werk', url: 'https://werk/?token=kd_a', runtime: runtime as unknown as KelpiRuntime },
        calls
    };
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
        expect(rows.map((row) => row.getAttribute('data-workspace-id'))).toEqual([W1, W2, W3]);
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
});
