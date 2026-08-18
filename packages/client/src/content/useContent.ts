/**
 * `useContent` — one content pane's subscription, expressed as a hook.
 *
 * The lifecycle is the whole point: a content pane subscribes when its body mounts (the grid
 * mounts the panes of the workspace this client is looking at) and unsubscribes when it goes —
 * a workspace switch, a pane close, an eviction. Nothing subscribes for a pane the user cannot
 * see, so a daemon with fifty markdown panes only watches the handful on somebody's screen.
 *
 * State arrives two ways and both land here: the `content-subscribe` reply carries the current
 * snapshot, and every later change (a disk write the daemon's watcher saw, an autosave, a
 * refresh, a mode switch) arrives as a `content-updated` event. `ContentClient` drops a
 * snapshot older than the one already held, so the two paths cannot race backwards.
 */

import { useEffect, useState } from 'react';

import type { ContentApi } from './client';
import type { ContentPaneState } from './types';

export interface UseContentResult {
    /** null until the first snapshot lands (or after a pane id change). */
    readonly state: ContentPaneState | null;
    /** The last failure from a content command, cleared by the next good state. */
    readonly error: string | null;
}

export function useContent(api: ContentApi, paneID: string): UseContentResult {
    const [state, setState] = useState<ContentPaneState | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        setState(null);
        setError(null);
        const subscription = api.subscribe(paneID, {
            onState: (next) => {
                if (!live) return;
                setState(next);
                setError(null);
            },
            onError: (message) => {
                if (!live) return;
                setError(message);
            }
        });
        return () => {
            live = false;
            subscription.unsubscribe();
        };
    }, [api, paneID]);

    return { state, error };
}
