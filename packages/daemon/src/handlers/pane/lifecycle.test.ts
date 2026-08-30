import { describe, expect, it } from 'vitest';

import { allPaneIDs } from '@kelpi/core/layout';

import { W1, W2, harness, seedSplit, seedWorkspace, testID } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const P3 = testID('3', 3);

function seeded() {
    const h = harness();
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    return h;
}

describe('pane-close', () => {
    it('acks the resolved pane, then removes it from panes, layout and focus', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-close', pane_id: P1, target: 'worker-1' });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            label: 'worker-1'
        });

        const workspace = h.workspace(W1);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P1]);
        expect(allPaneIDs(workspace.layout)).toEqual([P1]);
        expect(workspace.focusedPaneID).toBe(P1);
    });

    it('tears the surface down and refreshes the broadcast group', () => {
        const h = seeded();
        h.run({ command: 'pane-close', target: P2 });

        expect(h.pty.killed).toEqual([P2]);
        expect(h.term.disposed).toEqual([P2]);
        expect(h.pty.syncGroupCalls.at(-1)).toEqual({ workspaceID: W1, paneIDs: [] });
    });

    it('omits label for an unnamed pane', () => {
        const h = seeded();
        expect(h.run({ command: 'pane-close', target: P1 }).only()).toEqual({
            ok: true,
            pane_id: P1,
            workspace_id: W1,
            workspace_name: 'dev'
        });
    });

    it('closes a pane with a running agent (no active-agent guard on this path)', () => {
        const h = seeded();
        h.store.dispatch({
            type: 'pane-agent-event',
            paneID: P2,
            event: { type: 'agentStarted', agent: 'claude' },
            now: Date.now()
        });
        expect(h.workspace(W1).panes[1]?.status).toBe('running');

        expect(h.run({ command: 'pane-close', target: P2 }).only()).toMatchObject({ ok: true });
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1]);
    });

    it('reports an unknown UUID target verbatim and changes nothing', () => {
        const h = seeded();
        expect(h.run({ command: 'pane-close', target: P3 }).only()).toEqual({
            ok: false,
            error: `no pane with UUID '${P3}'`
        });
        expect(h.workspace(W1).panes).toHaveLength(2);
        expect(h.pty.killed).toEqual([]);
    });

    it('refuses a cross-workspace --workspace scope with the resolver error', () => {
        const h = seeded();
        seedWorkspace(h, { id: W2, name: 'beta', paneID: P3 });

        expect(h.run({ command: 'pane-close', target: P2, workspace: 'beta' }).only()).toEqual({
            ok: false,
            error: `no pane with UUID '${P2}' in workspace 'beta'`
        });
    });

    it('still closes for a legacy client with no reply handle', () => {
        const h = seeded();
        h.runSilent({ command: 'pane-close', target: P2 });
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1]);
    });
});

describe('pane-name', () => {
    it('renames the caller pane and echoes the new label', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-name', pane_id: P1, name: 'coordinator' });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P1,
            workspace_id: W1,
            workspace_name: 'dev',
            label: 'coordinator'
        });
        expect(h.workspace(W1).panes[0]?.label).toBe('coordinator');
    });

    it('renames a --target pane addressed by its current label', () => {
        const h = seeded();
        const reply = h.run({
            command: 'pane-name',
            pane_id: P1,
            target: 'worker-1',
            name: 'worker-2'
        });

        expect(reply.only()).toMatchObject({ pane_id: P2, label: 'worker-2' });
        expect(h.workspace(W1).panes[1]?.label).toBe('worker-2');
    });

    it('an empty name clears the label and omits it from the reply', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-name', target: P2, name: '' });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev'
        });
        expect(h.workspace(W1).panes[1]?.label).toBeNull();
    });

    it('reports an ambiguous label verbatim without renaming anything', () => {
        const h = seeded();
        seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P3, label: 'worker-1' });

        expect(h.run({ command: 'pane-name', pane_id: P1, target: 'worker-1', name: 'x' }).only()).toEqual({
            ok: false,
            error: "label 'worker-1' is ambiguous (2 matches); pass --workspace <name-or-id> to disambiguate"
        });
        expect(h.workspace(W1).panes.map((pane) => pane.label)).toEqual([null, 'worker-1', 'worker-1']);
    });
});
