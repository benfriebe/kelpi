import { describe, expect, it } from 'vitest';

import { allPaneIDs } from '@kelpi/core/layout';

import { NOW, W1, W2, harness, seedSplit, seedWorkspace, testID } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const NEW = testID('9', 9);

function seeded() {
    const h = harness({ minted: [NEW] });
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1, path: '/repo' });
    return h;
}

describe('pane-split', () => {
    it('acks the pre-minted id before the pane exists and creates it with that id', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-split', pane_id: P1 });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: NEW,
            workspace_id: W1,
            workspace_name: 'dev'
        });
        expect(reply.closeCount).toBe(1);

        const workspace = h.workspace(W1);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P1, NEW]);
        expect(allPaneIDs(workspace.layout)).toEqual([P1, NEW]);
        expect(workspace.layout).toMatchObject({ kind: 'split', direction: 'horizontal' });
        expect(workspace.focusedPaneID).toBe(NEW);
    });

    it('spawns the new shell pane with the source cwd, merged env and terminal state', () => {
        const h = seeded();
        h.run({ command: 'pane-split', pane_id: P1 });

        expect(h.pty.spawns).toHaveLength(1);
        const spawn = h.pty.spawns[0];
        expect(spawn?.paneID).toBe(NEW);
        expect(spawn?.cwd).toBe('/repo');
        expect(spawn?.env).toEqual([
            ['KELPI_PANE_ID', NEW],
            ['NEX_PANE_ID', NEW],
            ['PATH', '/opt/kelpi/helpers:/usr/bin'],
            ['KELPI_PROFILE', 'default'],
        ['NEX_PROFILE', 'default']
        ]);
        expect(h.term.attached).toEqual([{ paneID: NEW, cols: 80, rows: 24 }]);
        expect(h.pty.syncGroupCalls.at(-1)?.workspaceID).toBe(W1);
    });

    it('includes label only when --name is given, and puts it on the pane', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-split', pane_id: P1, name: 'worker-1' });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: NEW,
            workspace_id: W1,
            workspace_name: 'dev',
            label: 'worker-1'
        });
        expect(h.workspace(W1).panes[1]?.label).toBe('worker-1');
    });

    it('honours --direction and --path (split-at-path gives the new pane that cwd)', () => {
        const h = seeded();
        h.run({ command: 'pane-split', pane_id: P1, direction: 'vertical', path: '/tmp/work' });

        const workspace = h.workspace(W1);
        expect(workspace.layout).toMatchObject({ kind: 'split', direction: 'vertical' });
        expect(workspace.panes[1]?.workingDirectory).toBe('/tmp/work');
        expect(h.pty.spawns[0]?.cwd).toBe('/tmp/work');
    });

    it('focuses the resolved source before splitting so split-at-path targets it', () => {
        const h = harness({ minted: [NEW] });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'other' });
        expect(h.workspace(W1).focusedPaneID).toBe(P2);

        h.run({ command: 'pane-split', pane_id: P1, target: P1, path: '/elsewhere' });

        // The at-path split hangs off P1 (the resolved target), not the previously focused P2.
        const layout = h.workspace(W1).layout;
        expect(layout).toMatchObject({
            kind: 'split',
            first: { kind: 'split', first: { kind: 'leaf', paneID: P1 }, second: { kind: 'leaf', paneID: NEW } },
            second: { kind: 'leaf', paneID: P2 }
        });
    });

    it('--workspace alone beats the caller pane and picks the destination workspace', () => {
        const h = harness({ minted: [NEW] });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        seedWorkspace(h, { id: W2, name: 'beta', paneID: P2 });

        const reply = h.run({ command: 'pane-split', pane_id: P1, workspace: 'beta' });

        expect(reply.only()).toMatchObject({ workspace_id: W2, workspace_name: 'beta' });
        expect(h.workspace(W2).panes.map((pane) => pane.id)).toEqual([P2, NEW]);
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1]);
    });

    it('refuses an empty --workspace destination with the create hint', () => {
        const h = harness({ minted: [NEW] });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });

        const reply = h.run({ command: 'pane-split', workspace: 'dev' });

        // Byte-for-byte from socket-handlers.md §4.1 (the em dash and backticks are contract).
        expect(reply.only()).toEqual({
            ok: false,
            error: "workspace 'dev' has no pane to split — use `kelpi pane create --workspace dev`"
        });
    });

    it('reports an unknown workspace verbatim', () => {
        const h = seeded();
        expect(h.run({ command: 'pane-split', pane_id: P1, workspace: 'nope' }).only()).toEqual({
            ok: false,
            error: 'workspace not found: nope'
        });
    });

    it('rejects a caller with no pane_id, target or workspace', () => {
        const h = seeded();
        expect(h.run({ command: 'pane-split' }).only()).toEqual({
            ok: false,
            error: 'pane split requires --target or --workspace when called from outside a Kelpi pane'
        });
        expect(h.workspace(W1).panes).toHaveLength(1);
    });

    it('passes pane-target resolution errors through byte-for-byte', () => {
        const h = seeded();
        expect(h.run({ command: 'pane-split', target: 'ghost' }).only()).toEqual({
            ok: false,
            error: "label 'ghost' requires --workspace <name-or-id> when called from outside a Kelpi pane"
        });
    });

    it('still splits for a legacy client with no reply handle', () => {
        const h = seeded();
        h.runSilent({ command: 'pane-split', pane_id: P1 });
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1, NEW]);
    });
});

describe('pane-create', () => {
    it('splits a populated workspace horizontally', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-create', pane_id: P1, name: 'worker' });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: NEW,
            workspace_id: W1,
            workspace_name: 'dev',
            label: 'worker'
        });
        expect(h.workspace(W1).layout).toMatchObject({ kind: 'split', direction: 'horizontal' });
    });

    it('lays out the first pane of an EMPTY workspace with the acked id, label and path', () => {
        const h = harness({ minted: [NEW] });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        expect(h.workspace(W1).panes).toHaveLength(0);

        const reply = h.run({
            command: 'pane-create',
            workspace: 'dev',
            name: 'first',
            path: '/srv/app'
        });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: NEW,
            workspace_id: W1,
            workspace_name: 'dev',
            label: 'first'
        });
        const workspace = h.workspace(W1);
        expect(workspace.layout).toEqual({ kind: 'leaf', paneID: NEW });
        expect(workspace.panes[0]).toMatchObject({
            id: NEW,
            label: 'first',
            workingDirectory: '/srv/app',
            createdAt: NOW / 1000
        });
        expect(h.pty.spawns[0]?.cwd).toBe('/srv/app');
    });

    it('names create in its outside-caller error', () => {
        const h = seeded();
        expect(h.run({ command: 'pane-create' }).only()).toEqual({
            ok: false,
            error: 'pane create requires --target or --workspace when called from outside a Kelpi pane'
        });
    });
});
