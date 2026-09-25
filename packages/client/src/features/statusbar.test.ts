import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { describe, expect, it } from 'vitest';

import { statusItems } from './statusbar';

describe('status bucket rows', () => {
    it('lists a muted workspace\'s waiting panes under muted, never under waiting (agent-lifecycle §7.6)', () => {
        const daemon = createDaemonStore(emptyDaemonState('/home/test'));
        daemon.dispatch({ type: 'create-workspace', id: 'loud', paneID: 'loud-pane', name: 'loud', color: 'blue', now: 1 });
        daemon.dispatch({ type: 'create-workspace', id: 'quiet', paneID: 'quiet-pane', name: 'quiet', color: 'red', now: 2 });
        daemon.dispatch({ type: 'set-workspace-muted', id: 'quiet', muted: true });
        for (const [workspaceID, paneID] of [['loud', 'loud-pane'], ['quiet', 'quiet-pane']] as const) {
            daemon.dispatch({ type: 'pane-agent-event', paneID, workspaceID, now: 3, event: { type: 'agentStopped', backgroundTaskCount: 0 } });
        }
        const workspaces = daemon.getState().workspaces;
        expect(statusItems(workspaces, 'waiting').map((item) => item.paneID)).toEqual(['loud-pane']);
        expect(statusItems(workspaces, 'muted').map((item) => item.paneID)).toEqual(['quiet-pane']);
        expect(statusItems(workspaces, 'running')).toEqual([]);
    });
});
