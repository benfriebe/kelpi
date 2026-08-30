/**
 * `createStore` — the daemon's single source of truth.
 *
 * Implements `DomainStore<DaemonState, DomainAction, DomainEvent>` from `../seams.ts`:
 * synchronous reducer, one batched event notification per dispatch, structural sharing (an
 * action that changes nothing returns the identical state object and notifies nobody).
 *
 * Ordering: dispatch is synchronous and re-entrant-safe — an action dispatched from a listener
 * is queued and applied after the current one drains, so listeners always observe batches in
 * causal order and per-workspace ordering is total (the daemon runs one event loop; PTY/git
 * work is async and re-enters through further dispatches, all of which tolerate a pane having
 * gone away, per workspace-feature.md §Port notes 7).
 */

import type { DomainStore } from '../seams.js';
import { deriveEvents } from './events.js';
import { reduce } from './reducers/index.js';
import type { DaemonState, DomainAction, DomainEvent } from './types.js';

export type KelpiStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

export function createStore(initial: DaemonState): KelpiStore {
    let state = initial;
    const listeners = new Set<(events: readonly DomainEvent[]) => void>();
    const queue: DomainAction[] = [];
    let draining = false;

    const emit = (events: readonly DomainEvent[]): void => {
        if (events.length === 0) return;
        for (const listener of [...listeners]) listener(events);
    };

    const dispatch = (action: DomainAction): void => {
        queue.push(action);
        if (draining) return;
        draining = true;
        try {
            while (queue.length > 0) {
                const next = queue.shift() as DomainAction;
                const previous = state;
                const updated = reduce(previous, next);
                if (updated === previous) continue;
                state = updated;
                emit(deriveEvents(previous, updated));
            }
        } finally {
            // A throwing listener must not wedge the store: anything still queued drains on the
            // next dispatch rather than being lost.
            draining = false;
        }
    };

    return {
        getState: () => state,
        dispatch,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        }
    };
}
