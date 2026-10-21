import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fleetDigest, usePhoneFleet } from './fleet';
import { fakeHost } from './testing-hosts';

describe('usePhoneFleet', () => {
    it('keeps one value while nothing it carries changes, and a new one when something does', () => {
        const origin = fakeHost('origin', [{ id: 'w1', name: 'kelpi', panes: [{ id: 'p1', title: 'zsh' }] }]);
        const hosts = [origin];
        const { result } = renderHook(() => usePhoneFleet(hosts));
        const first = result.current;
        expect(first[0]?.workspaces[0]?.name).toBe('kelpi');

        // A title animating is not something the fleet draws: same value, no re-render upstream.
        act(() => origin.setWorkspaces([{ id: 'w1', name: 'kelpi', panes: [{ id: 'p1', title: '✳ thinking' }] }]));
        expect(result.current).toBe(first);

        // A pane starting to wait is.
        act(() => origin.setWorkspaces([{ id: 'w1', name: 'kelpi', panes: [{ id: 'p1', status: 'waitingForInput' }] }]));
        expect(result.current).not.toBe(first);
        expect(result.current[0]?.workspaces[0]?.panes[0]?.status).toBe('waitingForInput');

        // …and so is the host's connection.
        const before = result.current;
        act(() => origin.runtime.store.getState().setConnectionStatus('reconnecting'));
        expect(result.current).not.toBe(before);
        expect(result.current[0]?.connection).toBe('reconnecting');
    });

    it('digests what the cross-host surfaces read and nothing else', () => {
        const host = fakeHost('origin', [{ id: 'w1', name: 'kelpi', panes: [{ id: 'p1', title: 'a' }] }]);
        const digest = fleetDigest(host.runtime.store.getState().daemon.state.workspaces);
        host.setWorkspaces([{ id: 'w1', name: 'kelpi', panes: [{ id: 'p1', title: 'b' }] }]);
        expect(fleetDigest(host.runtime.store.getState().daemon.state.workspaces)).toBe(digest);
        host.setWorkspaces([{ id: 'w1', name: 'renamed', panes: [{ id: 'p1', title: 'b' }] }]);
        expect(fleetDigest(host.runtime.store.getState().daemon.state.workspaces)).not.toBe(digest);
    });
});
