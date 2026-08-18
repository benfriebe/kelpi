import { describe, expect, it } from 'vitest';

import { G1, NOW, W1, W2, harness, seedSplit, seedWorkspace, testID } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const P3 = testID('3', 3);
const MD = testID('D', 4);
const SESSION = testID('5', 5);

/** NOW (epoch ms) as the wire's seconds-precision ISO 8601. */
const NOW_ISO = '2025-08-18T06:53:20Z';

function seeded() {
    const h = harness();
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1, path: '/repo' });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    return h;
}

function panesOf(reply: Record<string, unknown>): Record<string, unknown>[] {
    return reply['panes'] as Record<string, unknown>[];
}

describe('pane-list', () => {
    it('emits the documented keys, omitting every unset optional', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1, path: '/repo' });

        const entries = panesOf(h.run({ command: 'pane-list' }).only());

        expect(entries).toEqual([
            {
                id: P1,
                type: 'shell',
                workspace_id: W1,
                workspace_name: 'dev',
                working_directory: '/repo',
                status: 'idle',
                is_focused: true,
                is_active_workspace: true,
                created_at: NOW_ISO,
                last_activity_at: NOW_ISO
            }
        ]);
    });

    it('carries label, title, branch, session, agent kind, background tasks and group', () => {
        const h = seeded();
        h.store.dispatch({ type: 'create-group', id: G1, name: 'Client X', now: NOW, initialWorkspaceIDs: [W1] });
        h.store.dispatch({
            type: 'pane-agent-event',
            paneID: P2,
            event: { type: 'sessionStarted', sessionID: SESSION, agent: 'codex' },
            now: NOW
        });
        h.store.dispatch({
            type: 'pane-agent-event',
            paneID: P2,
            event: { type: 'agentStarted', agent: 'codex' },
            now: NOW
        });
        h.store.dispatch({
            type: 'pane-agent-event',
            paneID: P2,
            event: { type: 'agentStopped', backgroundTaskCount: 2 },
            now: NOW
        });
        h.store.dispatch({ type: 'pane-title-changed', paneID: P2, title: 'zsh — proj', now: NOW });
        h.store.dispatch({ type: 'pane-branch-changed', paneID: P2, branch: 'main' });

        const entry = panesOf(h.run({ command: 'pane-list' }).only())[1];

        expect(entry).toEqual({
            id: P2,
            type: 'shell',
            workspace_id: W1,
            workspace_name: 'dev',
            working_directory: '/repo',
            // background work keeps the pane running instead of flipping it to waiting.
            status: 'running',
            is_focused: true,
            is_active_workspace: true,
            created_at: NOW_ISO,
            last_activity_at: NOW_ISO,
            label: 'worker-1',
            title: 'zsh — proj',
            git_branch: 'main',
            agent_session_id: SESSION,
            agent: 'codex',
            background_tasks: 2,
            group_id: G1,
            group_name: 'Client X'
        });
    });

    it('reports the camelCase waiting status and omits background_tasks at zero', () => {
        const h = seeded();
        h.store.dispatch({
            type: 'pane-agent-event',
            paneID: P2,
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW
        });
        h.store.dispatch({
            type: 'pane-agent-event',
            paneID: P2,
            event: { type: 'agentStopped', backgroundTaskCount: 0 },
            now: NOW
        });

        const entry = panesOf(h.run({ command: 'pane-list' }).only())[1];
        expect(entry).toMatchObject({ status: 'waitingForInput' });
        expect(entry).not.toHaveProperty('background_tasks');
    });

    it('lists panes in LAYOUT order, not append order', () => {
        const h = seeded();
        seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P3 });
        // Layout is now P1 | P3 | P2's subtree order: P1, P3, P2 (P3 split off P1).
        h.store.dispatch({
            type: 'move-pane-adjacent',
            workspaceID: W1,
            paneID: P2,
            targetPaneID: P1,
            zone: 'left'
        });

        const ids = panesOf(h.run({ command: 'pane-list' }).only()).map((entry) => entry['id']);
        expect(ids).toEqual([P2, P1, P3]);
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1, P2, P3]);
    });

    it('reports markdown panes with their type and file path, and never lists parked panes', () => {
        const h = seeded();
        h.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: MD,
            filePath: '/notes/todo.md',
            now: NOW
        });
        h.store.dispatch({ type: 'park-pane', workspaceID: W1, paneID: P2 });

        const entries = panesOf(h.run({ command: 'pane-list' }).only());
        expect(entries.map((entry) => entry['id'])).toEqual([P1, MD]);
        expect(entries[1]).toMatchObject({
            type: 'markdown',
            file_path: '/notes/todo.md',
            label: 'todo.md',
            title: 'todo.md'
        });
    });

    it('lists every workspace in state order by default and one with --workspace', () => {
        const h = seeded();
        seedWorkspace(h, { id: W2, name: 'beta', paneID: P3 });

        const all = panesOf(h.run({ command: 'pane-list' }).only());
        expect(all.map((entry) => entry['workspace_name'])).toEqual(['dev', 'dev', 'beta']);
        expect(all.map((entry) => entry['is_active_workspace'])).toEqual([false, false, true]);

        const scoped = panesOf(h.run({ command: 'pane-list', workspace: 'dev' }).only());
        expect(scoped.map((entry) => entry['id'])).toEqual([P1, P2]);
    });

    it('scope=current lists the requesting pane\'s workspace', () => {
        const h = seeded();
        seedWorkspace(h, { id: W2, name: 'beta', paneID: P3 });

        const entries = panesOf(h.run({ command: 'pane-list', pane_id: P1, scope: 'current' }).only());
        expect(entries.map((entry) => entry['id'])).toEqual([P1, P2]);
    });

    it('rejects the mutually exclusive, unknown and unowned scopes', () => {
        const h = seeded();

        expect(h.run({ command: 'pane-list', workspace: 'dev', scope: 'current' }).only()).toEqual({
            ok: false,
            error: 'workspace and --current are mutually exclusive'
        });
        expect(h.run({ command: 'pane-list', scope: 'current' }).only()).toEqual({
            ok: false,
            error: 'no workspace contains the requesting pane'
        });
        expect(h.run({ command: 'pane-list', pane_id: P3, scope: 'current' }).only()).toEqual({
            ok: false,
            error: 'no workspace contains the requesting pane'
        });
        expect(h.run({ command: 'pane-list', scope: 'weird' }).only()).toEqual({
            ok: false,
            error: 'unknown scope: weird'
        });
        expect(h.run({ command: 'pane-list', workspace: 'nope' }).only()).toEqual({
            ok: false,
            error: 'workspace not found: nope'
        });
    });

    it('returns an empty array for a workspace with no panes', () => {
        const h = seeded();
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P2 });

        expect(h.run({ command: 'pane-list' }).only()).toEqual({ ok: true, panes: [] });
    });

    it('is a no-op without a reply handle', () => {
        const h = seeded();
        expect(() => h.runSilent({ command: 'pane-list' })).not.toThrow();
    });
});
