import { describe, expect, it } from 'vitest';
import { workspaceByID } from './derived.js';
import { createStore } from './store.js';
import { harness, HOME, id, NOW, W1 } from './testing.js';
import { emptyDaemonState, type DomainAction, type DomainEvent } from './types.js';

const P1 = id('dddddddd', 100);

function createWorkspace(): DomainAction {
    return { type: 'create-workspace', id: W1, paneID: P1, name: 'dev', color: 'blue', now: NOW };
}

describe('createStore', () => {
    it('applies actions synchronously and exposes the new state', () => {
        const h = harness();
        h.dispatch(createWorkspace());
        expect(h.state().workspaces).toHaveLength(1);
        expect(workspaceByID(h.state(), W1)?.panes[0]?.id).toBe(P1);
    });

    it('emits exactly one batch per state-changing dispatch', () => {
        const h = harness();
        h.dispatch(createWorkspace());
        expect(h.batches).toHaveLength(1);
        h.dispatch({ type: 'rename-workspace', id: W1, name: 'renamed' });
        expect(h.batches).toHaveLength(2);
    });

    it('is a no-op (identical state, no events) for actions that change nothing', () => {
        const h = harness();
        h.dispatch(createWorkspace());
        const before = h.state();
        h.dispatch({ type: 'rename-workspace', id: 'missing-workspace', name: 'x' });
        h.dispatch({ type: 'close-pane', workspaceID: 'missing-workspace', paneID: P1 });
        expect(h.state()).toBe(before);
        expect(h.batches).toHaveLength(1);
    });

    it('preserves object identity for untouched workspaces (structural sharing)', () => {
        const h = harness();
        h.dispatch(createWorkspace());
        h.dispatch({
            type: 'create-workspace',
            id: id('bbbbbbbb', 2),
            paneID: id('dddddddd', 200),
            name: 'other',
            color: 'red',
            now: NOW
        });
        const first = workspaceByID(h.state(), W1);
        h.dispatch({ type: 'rename-workspace', id: id('bbbbbbbb', 2), name: 'renamed' });
        expect(workspaceByID(h.state(), W1)).toBe(first);
    });

    it('unsubscribes listeners', () => {
        const store = createStore(emptyDaemonState(HOME));
        const seen: DomainEvent[][] = [];
        const stop = store.subscribe((events) => seen.push([...events]));
        store.dispatch(createWorkspace());
        stop();
        store.dispatch({ type: 'rename-workspace', id: W1, name: 'again' });
        expect(seen).toHaveLength(1);
    });

    it('queues re-entrant dispatches from listeners and drains them in order', () => {
        const store = createStore(emptyDaemonState(HOME));
        const names: string[] = [];
        let reentered = false;
        store.subscribe(() => {
            names.push(store.getState().workspaces[0]?.name ?? '');
            if (!reentered) {
                reentered = true;
                store.dispatch({ type: 'rename-workspace', id: W1, name: 'from-listener' });
            }
        });
        store.dispatch(createWorkspace());
        expect(names).toEqual(['dev', 'from-listener']);
        expect(store.getState().workspaces[0]?.name).toBe('from-listener');
    });
});
