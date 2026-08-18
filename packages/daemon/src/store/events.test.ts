import { describe, expect, it } from 'vitest';
import { applyDomainEvents } from './events.js';
import { createStore } from './store.js';
import { harness, HOME, id, NOW, seededState, W1, W2 } from './testing.js';
import { emptyDaemonState, type DaemonState, type DomainAction, type DomainEvent } from './types.js';

const P0 = id('dddddddd', 100);
const P1 = id('dddddddd', 200);
const PA = id('eeeeeeee', 1);
const PB = id('eeeeeeee', 2);
const PC = id('eeeeeeee', 3);
const G1 = id('cccccccc', 1);

/** The full port script: every family of action, applied to a mirror via events alone. */
const SCRIPT: readonly DomainAction[] = [
    { type: 'create-workspace', id: W1, paneID: P0, name: 'alpha', color: 'blue', now: NOW },
    { type: 'create-workspace', id: W2, paneID: P1, name: 'beta', color: 'red', now: NOW },
    { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
    { type: 'split-pane', workspaceID: W1, paneID: PB, direction: 'vertical', now: NOW },
    { type: 'set-pane-label', workspaceID: W1, paneID: PA, label: 'agent' },
    { type: 'pane-title-changed', paneID: PA, title: 'claude', now: NOW + 1_000 },
    { type: 'pane-directory-changed', paneID: PA, directory: '/repo', now: NOW + 2_000 },
    { type: 'pane-branch-changed', paneID: PA, branch: 'main' },
    {
        type: 'pane-agent-event',
        paneID: PA,
        event: { type: 'agentStarted', agent: 'codex' },
        now: NOW + 3_000
    },
    {
        type: 'pane-agent-event',
        paneID: PA,
        event: { type: 'agentStopped', backgroundTaskCount: 2 },
        now: NOW + 4_000
    },
    {
        type: 'pane-agent-event',
        paneID: PA,
        event: { type: 'sessionStarted', sessionID: 'sess-1', agent: 'codex' },
        now: NOW + 5_000
    },
    { type: 'set-sync-input-active', workspaceID: W1, active: true },
    { type: 'set-sync-input-excluded', workspaceID: W1, paneID: PB, excluded: true },
    { type: 'cycle-layout', workspaceID: W1 },
    { type: 'select-layout', workspaceID: W1, kind: 'main-vertical' },
    { type: 'toggle-zoom', workspaceID: W1 },
    { type: 'toggle-zoom', workspaceID: W1 },
    { type: 'update-split-ratio', workspaceID: W1, splitPath: 'd', ratio: 0.3 },
    { type: 'resize-pane', workspaceID: W1, paneID: PA, share: 0.8 },
    { type: 'focus-pane', workspaceID: W1, paneID: P0 },
    { type: 'focus-next-pane', workspaceID: W1 },
    { type: 'move-pane-adjacent', workspaceID: W1, paneID: PB, targetPaneID: P0, zone: 'top' },
    { type: 'move-pane-direction', workspaceID: W1, direction: 'down' },
    { type: 'open-markdown-pane', workspaceID: W1, paneID: PC, filePath: '/docs/a.md', reusePaneID: P0, now: NOW },
    { type: 'create-scratchpad', workspaceID: W1, paneID: id('eeeeeeee', 4), now: NOW },
    {
        type: 'scratchpad-content-changed',
        workspaceID: W1,
        paneID: id('eeeeeeee', 4),
        content: 'notes'
    },
    {
        type: 'open-web-pane',
        workspaceID: W1,
        paneID: id('eeeeeeee', 5),
        tabID: id('eeeeeeee', 6),
        url: 'example.com',
        now: NOW
    },
    { type: 'open-diff-pane', workspaceID: W1, paneID: id('eeeeeeee', 7), repoPath: '/repo', now: NOW },
    { type: 'close-pane', workspaceID: W1, paneID: PC }, // unpark branch
    { type: 'close-pane', workspaceID: W1, paneID: id('eeeeeeee', 7) },
    { type: 'reopen-closed-pane', workspaceID: W1, paneID: id('eeeeeeee', 8), now: NOW },
    { type: 'move-pane-to-workspace', paneID: PB, toWorkspaceID: W2 },
    { type: 'pane-process-terminated', paneID: PA },
    { type: 'create-group', id: G1, name: 'Client', now: NOW, initialWorkspaceIDs: [W2] },
    { type: 'rename-group', id: G1, name: 'Client X' },
    { type: 'set-group-color', id: G1, color: 'purple' },
    { type: 'toggle-group-collapse', id: G1 },
    { type: 'move-workspaces-to-group', ids: [W1], groupID: G1, index: 0 },
    { type: 'reorder-group', id: G1, order: [W2, W1] },
    { type: 'sort-group', id: G1, by: 'name' },
    { type: 'workspace-labels', id: W1, op: 'add', values: ['wip', 'client-x'] },
    { type: 'workspace-labels', id: W1, op: 'remove', values: ['wip'] },
    { type: 'set-bulk-color', ids: [W1, W2], color: 'green' },
    { type: 'rename-workspace', id: W1, name: 'alpha renamed' },
    { type: 'set-workspace-icon', id: W1, icon: { kind: 'emoji', grapheme: '🚀' } },
    { type: 'set-active-workspace', id: W2, now: NOW + 60_000 },
    {
        type: 'add-repo',
        repo: {
            id: id('99999999', 1),
            path: '/repo',
            name: 'repo',
            remoteURL: null,
            lastAccessedAt: 1,
            isAutoDiscovered: false
        }
    },
    {
        type: 'add-repo-association',
        workspaceID: W1,
        association: {
            id: id('88888888', 1),
            repoID: id('99999999', 1),
            worktreePath: '/repo',
            branchName: 'main',
            isAutoDetected: false
        }
    },
    { type: 'move-workspace-to-group', id: W1, groupID: null, index: 0 },
    { type: 'move-group', id: G1, toIndex: 0 },
    { type: 'delete-group', id: G1, cascade: false },
    { type: 'delete-workspace', id: W2 }
];

describe('event replay', () => {
    it('converges a mirror store onto the source state after every dispatch', () => {
        const store = createStore(emptyDaemonState(HOME));
        let mirror: DaemonState = emptyDaemonState(HOME);
        let batches = 0;
        store.subscribe((events) => {
            batches += 1;
            mirror = applyDomainEvents(mirror, events);
        });

        for (const action of SCRIPT) {
            store.dispatch(action);
            expect(mirror).toEqual(store.getState());
        }
        expect(batches).toBeGreaterThan(SCRIPT.length / 2);
    });

    // Deterministic LCG so a failure is reproducible; several seeds, since ordering bugs in the
    // delta stream only show up for particular interleavings.
    it.each([0x2f6e2b1, 1, 12_345, 987_654_321, 42])('converges under fuzz (seed %i)', (start) => {
        let seed = start >>> 0;
        const random = (): number => {
            seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
            return seed / 0x1_0000_0000;
        };
        const pick = <T>(items: readonly T[]): T | undefined =>
            items.length === 0 ? undefined : items[Math.floor(random() * items.length)];

        const store = createStore(emptyDaemonState(HOME));
        let mirror: DaemonState = emptyDaemonState(HOME);
        store.subscribe((events) => {
            mirror = applyDomainEvents(mirror, events);
        });
        store.dispatch({
            type: 'create-workspace',
            id: W1,
            paneID: P0,
            name: 'alpha',
            color: 'blue',
            now: NOW
        });
        store.dispatch({
            type: 'create-workspace',
            id: W2,
            paneID: P1,
            name: 'beta',
            color: 'red',
            now: NOW
        });

        let minted = 0;
        for (let step = 0; step < 500; step += 1) {
            const state = store.getState();
            const workspace = pick(state.workspaces);
            if (workspace === undefined) break;
            const panes = workspace.panes.map((pane) => pane.id);
            const paneID = pick(panes);
            const fresh = id('7777aaaa', (minted += 1));
            const roll = Math.floor(random() * 12);
            const now = NOW + step * 1_000;
            switch (roll) {
                case 0:
                    store.dispatch({
                        type: 'split-pane',
                        workspaceID: workspace.id,
                        paneID: fresh,
                        direction: random() < 0.5 ? 'horizontal' : 'vertical',
                        now
                    });
                    break;
                case 1:
                    if (paneID !== undefined) {
                        store.dispatch({
                            type: 'close-pane',
                            workspaceID: workspace.id,
                            paneID
                        });
                    }
                    break;
                case 2:
                    if (paneID !== undefined) {
                        store.dispatch({
                            type: 'open-markdown-pane',
                            workspaceID: workspace.id,
                            paneID: fresh,
                            filePath: `/docs/${step}.md`,
                            reusePaneID: paneID,
                            now
                        });
                    }
                    break;
                case 3:
                    store.dispatch({
                        type: 'create-scratchpad',
                        workspaceID: workspace.id,
                        paneID: fresh,
                        now
                    });
                    break;
                case 4:
                    if (paneID !== undefined) {
                        store.dispatch({
                            type: 'move-pane-to-workspace',
                            paneID,
                            toWorkspaceID: (pick(state.workspaces) ?? workspace).id
                        });
                    }
                    break;
                case 5:
                    store.dispatch({ type: 'cycle-layout', workspaceID: workspace.id });
                    break;
                case 6:
                    store.dispatch({ type: 'toggle-zoom', workspaceID: workspace.id });
                    break;
                case 7:
                    if (paneID !== undefined) {
                        store.dispatch({ type: 'focus-pane', workspaceID: workspace.id, paneID });
                    }
                    break;
                case 8:
                    if (paneID !== undefined) {
                        store.dispatch({
                            type: 'pane-agent-event',
                            paneID,
                            event:
                                random() < 0.5
                                    ? { type: 'agentStarted', agent: 'claude' }
                                    : { type: 'agentStopped', backgroundTaskCount: 0 },
                            now
                        });
                    }
                    break;
                case 9:
                    if (paneID !== undefined) {
                        store.dispatch({ type: 'pane-process-terminated', paneID });
                    }
                    break;
                case 10:
                    store.dispatch({
                        type: 'reopen-closed-pane',
                        workspaceID: workspace.id,
                        paneID: fresh,
                        now
                    });
                    break;
                default:
                    if (paneID !== undefined) {
                        store.dispatch({
                            type: 'pane-title-changed',
                            paneID,
                            title: `t${step}`,
                            now
                        });
                    }
                    break;
            }
            expect(mirror).toEqual(store.getState());
        }
    });

    it('emits nothing for actions that change nothing', () => {
        const h = harness(seededState());
        const before = h.events.length;
        h.dispatch(
            { type: 'rename-workspace', id: 'ghost', name: 'x' },
            { type: 'focus-pane', workspaceID: W1, paneID: P0 },
            { type: 'set-sync-input-excluded', workspaceID: W1, paneID: 'ghost', excluded: true }
        );
        expect(h.events).toHaveLength(before);
    });
});

describe('event precision', () => {
    function kinds(events: readonly DomainEvent[]): string[] {
        return events.map((event) => event.kind);
    }

    it('renaming a workspace touches only the workspace envelope', () => {
        const h = harness(seededState());
        const before = h.events.length;
        h.dispatch({ type: 'rename-workspace', id: W1, name: 'renamed' });
        expect(kinds(h.events.slice(before))).toEqual(['workspace-upserted']);
    });

    it('a focus change emits only focus-changed', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW });
        const before = h.events.length;
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: P0 });
        expect(kinds(h.events.slice(before))).toEqual(['focus-changed']);
    });

    it('a title change emits one pane upsert and no agent event', () => {
        const h = harness(seededState());
        const before = h.events.length;
        h.dispatch({ type: 'pane-title-changed', paneID: P0, title: 'zsh', now: NOW });
        const emitted = h.events.slice(before);
        expect(kinds(emitted)).toEqual(['pane-upserted']);
        expect(emitted[0]).toMatchObject({ workspaceID: W1, paneID: P0, lane: 'visible', index: 0 });
    });

    it('an agent event emits the pane upsert plus the narrow agent-status event', () => {
        const h = harness(seededState());
        const before = h.events.length;
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW
        });
        const emitted = h.events.slice(before);
        expect(kinds(emitted)).toEqual(['pane-upserted', 'agent-status-changed']);
        expect(emitted[1]).toMatchObject({ status: 'running', agentKind: 'claude' });
    });

    it('closing a pane removes it before any re-index upsert', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'split-pane', workspaceID: W1, paneID: PB, direction: 'horizontal', now: NOW }
        );
        const before = h.events.length;
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P0 });
        const emitted = h.events.slice(before);
        const removedAt = emitted.findIndex((event) => event.kind === 'pane-removed');
        const upsertAt = emitted.findIndex((event) => event.kind === 'pane-upserted');
        expect(removedAt).toBeGreaterThanOrEqual(0);
        if (upsertAt >= 0) expect(removedAt).toBeLessThan(upsertAt);
    });

    it('parking a pane reports it in the parked lane', () => {
        const h = harness(seededState());
        const before = h.events.length;
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PA,
            filePath: '/docs/a.md',
            reusePaneID: P0,
            now: NOW
        });
        const lanes = h.events
            .slice(before)
            .filter((event) => event.kind === 'pane-upserted')
            .map((event) => (event.kind === 'pane-upserted' ? `${event.paneID}:${event.lane}` : ''));
        expect(lanes).toContain(`${PA}:visible`);
        expect(lanes).toContain(`${P0}:parked`);
    });
});
