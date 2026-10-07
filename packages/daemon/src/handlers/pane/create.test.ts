import { describe, expect, it, vi } from 'vitest';

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
        // #295: no `focus` on the wire is a background split, so focus stays on the caller.
        expect(workspace.focusedPaneID).toBe(P1);
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
            ['PATH', '/opt/kelpi/helpers:/usr/bin'],
            ['KELPI_PROFILE', 'default'],
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

    it('splits the resolved source at a path, not the focused pane, with focus: true', () => {
        const h = harness({ minted: [NEW] });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'other' });
        expect(h.workspace(W1).focusedPaneID).toBe(P2);

        h.run({ command: 'pane-split', pane_id: P1, target: P1, path: '/elsewhere', focus: true });

        // The at-path split hangs off P1 (the resolved target), not the previously focused P2.
        const layout = h.workspace(W1).layout;
        expect(layout).toMatchObject({
            kind: 'split',
            first: { kind: 'split', first: { kind: 'leaf', paneID: P1 }, second: { kind: 'leaf', paneID: NEW } },
            second: { kind: 'leaf', paneID: P2 }
        });
        // A focusing split still focuses the source first, so the history reads P2, P1 and
        // closing the new pane hands focus back to the pane it came from.
        expect(h.workspace(W1).focusedPaneID).toBe(NEW);
        expect(h.workspace(W1).focusHistory).toEqual([P2, P1]);
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

/**
 * #295: a create with no `focus` is a BACKGROUND create. The user is typing in P2 while an agent
 * in P1 (its `KELPI_PANE_ID`) spawns a pane: the pane lands beside P1, and neither the focused
 * pane nor its history moves. `focus: true` is the old behaviour, which the window's gestures
 * and `--focus` ask for.
 */
describe('background vs focusing creates (#295)', () => {
    function userTypingInP2() {
        const h = harness({ minted: [NEW] });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1, path: '/repo' });
        seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'user' });
        const before = h.workspace(W1);
        expect(before.focusedPaneID).toBe(P2);
        return { h, history: before.focusHistory };
    }

    const besideP1 = {
        kind: 'split',
        first: { kind: 'split', first: { kind: 'leaf', paneID: P1 }, second: { kind: 'leaf', paneID: NEW } },
        second: { kind: 'leaf', paneID: P2 }
    };

    const backgroundCases = [
        { label: 'pane-split', msg: { command: 'pane-split', pane_id: P1 } },
        { label: 'pane-split --path', msg: { command: 'pane-split', pane_id: P1, path: '/tmp/work' } },
        { label: 'pane-split focus:false', msg: { command: 'pane-split', pane_id: P1, focus: false } },
        { label: 'pane-create', msg: { command: 'pane-create', pane_id: P1 } },
        { label: 'pane-create --path', msg: { command: 'pane-create', pane_id: P1, path: '/tmp/work' } }
    ] as const;

    for (const { label, msg } of backgroundCases) {
        it(`${label}: lands beside the caller and leaves focus and its history alone`, () => {
            const { h, history } = userTypingInP2();
            const dispatch = vi.spyOn(h.store, 'dispatch');

            h.run(msg);

            const workspace = h.workspace(W1);
            expect(workspace.layout).toMatchObject(besideP1);
            expect(workspace.focusedPaneID).toBe(P2);
            expect(workspace.focusHistory).toEqual(history);
            // …and the caller was never focused on the way (no pre-focus of the source).
            const types = dispatch.mock.calls.map(([action]) => action.type);
            expect(types).not.toContain('focus-pane');
            expect(types.some((type) => type === 'split-pane' || type === 'split-pane-at-path')).toBe(true);
        });
    }

    it('a --workspace-alone background split hangs off that workspace\'s focused pane without focusing', () => {
        const { h, history } = userTypingInP2();
        h.run({ command: 'pane-split', workspace: 'dev' });
        const workspace = h.workspace(W1);
        expect(allPaneIDs(workspace.layout)).toEqual([P1, P2, NEW]);
        expect(workspace.focusedPaneID).toBe(P2);
        expect(workspace.focusHistory).toEqual(history);
    });

    for (const command of ['pane-split', 'pane-create'] as const) {
        it(`${command} with focus: true moves focus to the new pane, as it always did`, () => {
            const { h } = userTypingInP2();
            h.run({ command, pane_id: P1, focus: true });
            const workspace = h.workspace(W1);
            expect(workspace.layout).toMatchObject(besideP1);
            expect(workspace.focusedPaneID).toBe(NEW);
            expect(workspace.focusHistory.slice(-2)).toEqual([P2, P1]);
        });
    }

    it('the first pane of an empty workspace takes focus even in the background', () => {
        const h = harness({ minted: [NEW] });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        h.run({ command: 'pane-create', workspace: 'dev' });
        expect(h.workspace(W1).focusedPaneID).toBe(NEW);
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

describe("a split opens where the source's shell really is", () => {
    /** A lookup the test answers by hand, so it can look at the state while the split waits. */
    function deferredLookup() {
        const asked: string[] = [];
        let settle: { resolve: (value: string | null) => void; reject: (error: Error) => void } | undefined;
        const lookup = (paneID: string): Promise<string | null> => {
            asked.push(paneID);
            return new Promise((resolve, reject) => {
                settle = { resolve, reject };
            });
        };
        return {
            asked,
            lookup,
            answer: async (value: string | null) => {
                settle?.resolve(value);
                await new Promise((resolve) => setImmediate(resolve));
            },
            fail: async () => {
                settle?.reject(new Error('lsof timed out'));
                await new Promise((resolve) => setImmediate(resolve));
            }
        };
    }

    function seededWith(lookup: (paneID: string) => Promise<string | null>) {
        const h = harness({ minted: [NEW], liveWorkingDirectory: lookup });
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1, path: '/repo' });
        return h;
    }

    it('waits for the answer, then acks a pane that already exists there', async () => {
        const live = deferredLookup();
        const h = seededWith(live.lookup);
        const reply = h.run({ command: 'pane-split', pane_id: P1 });

        expect(live.asked).toEqual([P1]);
        expect(reply.payloads).toEqual([]);
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P1]);

        await live.answer('/repo/packages/daemon');
        expect(reply.only()).toEqual({ ok: true, pane_id: NEW, workspace_id: W1, workspace_name: 'dev' });
        expect(h.workspace(W1).panes[1]?.workingDirectory).toBe('/repo/packages/daemon');
        expect(h.pty.spawns[0]?.cwd).toBe('/repo/packages/daemon');
        // Only the new pane: the source keeps what it had.
        expect(h.workspace(W1).panes[0]?.workingDirectory).toBe('/repo');
    });

    it('inherits the stored directory when the OS has no answer or the lookup fails', async () => {
        for (const settle of ['none', 'fail'] as const) {
            const live = deferredLookup();
            const h = seededWith(live.lookup);
            const reply = h.run({ command: 'pane-split', pane_id: P1 });
            if (settle === 'none') await live.answer(null);
            else await live.fail();
            expect(reply.only()).toMatchObject({ ok: true, pane_id: NEW });
            expect(h.workspace(W1).panes[1]?.workingDirectory).toBe('/repo');
        }
    });

    it('never asks for a split given --path, and answers it at once', () => {
        const lookup = vi.fn(() => Promise.resolve('/elsewhere'));
        const h = seededWith(lookup);
        const reply = h.run({ command: 'pane-split', pane_id: P1, path: '/tmp/work' });

        expect(lookup).not.toHaveBeenCalled();
        expect(reply.only()).toMatchObject({ ok: true, pane_id: NEW });
        expect(h.workspace(W1).panes[1]?.workingDirectory).toBe('/tmp/work');
    });

    it('routes again after the wait: a source closed meanwhile is an error, not a split', async () => {
        const live = deferredLookup();
        const h = seededWith(live.lookup);
        seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2 });
        const reply = h.run({ command: 'pane-split', pane_id: P1 });

        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        await live.answer('/repo/sub');

        expect(reply.only()).toMatchObject({ ok: false });
        expect(h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P2]);
        expect(h.pty.spawns).toEqual([]);
    });

    it('applies to pane-create too, which splits the source beside it', async () => {
        const live = deferredLookup();
        const h = seededWith(live.lookup);
        const reply = h.run({ command: 'pane-create', pane_id: P1 });

        await live.answer('/repo/sub');
        expect(reply.only()).toMatchObject({ ok: true, pane_id: NEW });
        expect(h.workspace(W1).panes[1]?.workingDirectory).toBe('/repo/sub');
    });
});
