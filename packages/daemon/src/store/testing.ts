/**
 * Test-only helpers for the store's specs. Not part of the daemon runtime path (nothing in
 * `src/` imports this outside `*.test.ts`), but kept as a real module so every colocated test
 * builds the same fixtures.
 */

import { workspaceSidebarID } from '@nex/core/codec';
import { createStore, type NexStore } from './store.js';
import { emptyDaemonState, type DaemonState, type DomainAction, type DomainEvent } from './types.js';

export const HOME = '/Users/test';

/** Deterministic, canonical-looking UUIDs: `id('w', 1)` -> "0000000w-0000-...-000000000001". */
export function id(prefix: string, n: number): string {
    const head = prefix.padEnd(8, '0').slice(0, 8);
    return `${head}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const W1 = id('aaaaaaaa', 1);
export const W2 = id('bbbbbbbb', 2);
export const G1 = id('cccccccc', 1);

let paneCounter = 0;
export function nextPaneID(): string {
    paneCounter += 1;
    return id('dddddddd', paneCounter);
}

export const NOW = 1_755_500_000_000; // epoch ms

export interface Harness {
    readonly store: NexStore;
    /** Every event batch the store has emitted, flattened. */
    readonly events: DomainEvent[];
    /** Event batches, unflattened (one entry per dispatch that changed something). */
    readonly batches: (readonly DomainEvent[])[];
    dispatch(...actions: readonly DomainAction[]): void;
    state(): DaemonState;
}

export function harness(initial: DaemonState = emptyDaemonState(HOME)): Harness {
    const store = createStore(initial);
    const events: DomainEvent[] = [];
    const batches: (readonly DomainEvent[])[] = [];
    store.subscribe((batch) => {
        batches.push(batch);
        events.push(...batch);
    });
    return {
        store,
        events,
        batches,
        dispatch: (...actions) => {
            for (const action of actions) store.dispatch(action);
        },
        state: () => store.getState()
    };
}

/** A state with one workspace holding one shell pane (the "new workspace" shape). */
export function seededState(
    workspaceID: string = W1,
    paneID: string = id('dddddddd', 100)
): DaemonState {
    const base = emptyDaemonState(HOME);
    const store = createStore(base);
    store.dispatch({
        type: 'create-workspace',
        id: workspaceID,
        paneID,
        name: 'dev',
        color: 'blue',
        now: NOW
    });
    return store.getState();
}

export function topLevelWorkspaceIDs(state: DaemonState): string[] {
    return state.topLevelOrder.filter((entry) => entry.kind === 'workspace').map((entry) => entry.id);
}

export function workspaceEntry(workspaceID: string) {
    return workspaceSidebarID(workspaceID);
}
