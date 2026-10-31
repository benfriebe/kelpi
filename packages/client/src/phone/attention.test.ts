import { afterEach, describe, expect, it } from 'vitest';

import { noteWaiting, phoneAttention, resetWaitingClock, waitedFor, workspaceKey } from './attention';
import { readHost } from './fleet';
import { fakeHost } from './testing-hosts';

afterEach(() => {
    resetWaitingClock();
});

describe('phoneAttention', () => {
    it('lists waiting panes on every host, counted per host and per workspace', () => {
        const origin = fakeHost('origin', [{ id: 'w1', name: 'kelpi', panes: [{ id: 'p1', status: 'waitingForInput', agentKind: 'claude' }, { id: 'p2', status: 'running' }] }]);
        const studio = fakeHost('phone:h1', [{ id: 'w2', name: 'site', panes: [{ id: 'p3', status: 'waitingForInput', agentKind: 'codex' }] }]);
        const attention = phoneAttention([readHost(origin), readHost(studio)]);
        expect(attention.waiting.map((item) => [item.key, item.paneTitle, item.workspaceName])).toEqual([
            ['origin/p1', 'claude', 'kelpi'],
            ['phone:h1/p3', 'codex', 'site']
        ]);
        expect(attention.running.map((item) => item.key)).toEqual(['origin/p2']);
        expect(attention.waitingByHost.get('origin')).toBe(1);
        expect(attention.waitingByWorkspace.get(workspaceKey('phone:h1', 'w2'))).toBe(1);
    });

    it('raises nothing for a muted workspace, but still lists its running panes', () => {
        const host = fakeHost('origin', [{ id: 'w1', name: 'dotfiles', muted: true, panes: [{ id: 'p1', status: 'waitingForInput' }, { id: 'p2', status: 'running' }] }]);
        const attention = phoneAttention([readHost(host)]);
        expect(attention.waiting).toEqual([]);
        expect(attention.waitingByHost.size).toBe(0);
        expect(attention.running.map((item) => item.paneID)).toEqual(['p2']);
    });

    it('counts nothing on a host that is not connected: its mirror is the last thing it said', () => {
        const host = fakeHost('phone:h1', [{ id: 'w1', name: 'site', panes: [{ id: 'p1', status: 'waitingForInput' }] }], false);
        expect(phoneAttention([readHost(host)]).waiting).toEqual([]);
    });
});

describe('the waiting clock', () => {
    it('counts from the moment the page first saw a pane waiting, and forgets panes that stopped', () => {
        const host = fakeHost('origin', [{ id: 'w1', name: 'kelpi', panes: [{ id: 'p1', status: 'waitingForInput' }] }]);
        const { waiting } = phoneAttention([readHost(host)]);
        noteWaiting(waiting, 0);
        expect(waitedFor('origin/p1', 30_000)).toBe('now');
        expect(waitedFor('origin/p1', 4 * 60_000)).toBe('4m');
        expect(waitedFor('origin/p1', 3 * 3_600_000)).toBe('3h');
        expect(waitedFor('origin/p1', 2 * 86_400_000)).toBe('2d');
        // A later sighting does not restart the clock.
        noteWaiting(waiting, 60 * 60_000);
        expect(waitedFor('origin/p1', 61 * 60_000)).toBe('1h');
        // Stopped waiting: forgotten, so its next wait starts again.
        noteWaiting([], 70 * 60_000);
        expect(waitedFor('origin/p1', 71 * 60_000)).toBe('now');
    });
});
