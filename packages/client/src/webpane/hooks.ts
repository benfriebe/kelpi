/**
 * The two subscriptions the web-pane chrome needs, as one hook.
 *
 * Favourites and batch sessions are daemon state that the delta stream does not carry, so each
 * one is a **broadcast plus a read**: the read seeds this client (a window that opened after the
 * fact still sees the list), and the broadcast keeps every window in step from then on. A
 * reconnect re-reads, because a daemon restart can have a different list.
 */

import { useEffect, useState } from 'react';

import type { WebPaneCommands } from './commands';
import {
    parseBatchMessage,
    parseBatchSession,
    parseFavourites,
    parseFavouritesMessage,
    type WebBatchSession,
    type WebFavourite
} from './state';

/** The slice of `NexConnection` this hook uses — a fixture satisfies it in tests. */
export interface WebUIConnection {
    on(event: 'message', listener: (message: Record<string, unknown>) => void): () => void;
    on(event: 'status', listener: (status: string) => void): () => void;
}

export interface WebPaneUIState {
    readonly favourites: readonly WebFavourite[];
    /** Per pane; a pane with no live batch is absent (not `null`), so the panel is not drawn. */
    readonly batches: Readonly<Record<string, WebBatchSession>>;
}

function replyFavourites(reply: unknown): readonly WebFavourite[] | null {
    if (typeof reply !== 'object' || reply === null) return null;
    const record = reply as Record<string, unknown>;
    if (record['ok'] !== true) return null;
    return parseFavourites(record['favourites']);
}

/** The `batch` field of any `web-batch-*` reply (they all carry the post-mutation session). */
export function replyBatch(reply: unknown): WebBatchSession | null {
    if (typeof reply !== 'object' || reply === null) return null;
    const record = reply as Record<string, unknown>;
    if (record['ok'] !== true) return null;
    return parseBatchSession(record['batch']);
}

export function useWebPaneUI(options: {
    readonly connection: WebUIConnection;
    readonly commands: WebPaneCommands;
    /** Panes whose batch state should be read on mount / reconnect (the visible web panes). */
    readonly webPaneIDs: readonly string[];
}): WebPaneUIState {
    const { connection, commands } = options;
    const [favourites, setFavourites] = useState<readonly WebFavourite[]>([]);
    const [batches, setBatches] = useState<Readonly<Record<string, WebBatchSession>>>({});

    // Broadcasts. One listener for both, because they arrive on the same channel and the
    // parsers are the discriminator.
    useEffect(() => {
        const off = connection.on('message', (message) => {
            const list = parseFavouritesMessage(message);
            if (list !== null) {
                setFavourites(list);
                return;
            }
            const batch = parseBatchMessage(message);
            if (batch === null) return;
            setBatches((current) => {
                const next = { ...current };
                if (batch.batch === null) delete next[batch.paneID];
                else next[batch.paneID] = batch.batch;
                return next;
            });
        });
        return off;
    }, [connection]);

    // The seed read, re-run on every (re)connect.
    useEffect(() => {
        let cancelled = false;
        const load = (): void => {
            void commands
                .favouritesList()
                .then((reply) => {
                    const list = replyFavourites(reply);
                    if (!cancelled && list !== null) setFavourites(list);
                })
                // A seed read that never lands is not an error worth surfacing — the most
                // common cause IS the disconnect this effect re-runs on. Without the catch it
                // is an UNHANDLED rejection: `void` discards the value, not the rejection, so
                // every teardown mid-flight logged one (191 of them across the client suite,
                // enough to fail the run on unhandled errors alone).
                .catch(() => undefined);
        };
        load();
        const off = connection.on('status', (status) => {
            if (status === 'connected') load();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [connection, commands]);

    // A batch survives a client reload (it is daemon state), so an attaching window has to ask.
    const paneKey = options.webPaneIDs.join(',');
    useEffect(() => {
        let cancelled = false;
        for (const paneID of paneKey === '' ? [] : paneKey.split(',')) {
            void commands
                .batchState(paneID)
                .then((reply) => {
                    const batch = replyBatch(reply);
                    if (cancelled || batch === null) return;
                    setBatches((current) => ({ ...current, [paneID]: batch }));
                })
                // Same rule as the seed read above: a disconnect mid-flight is the ordinary
                // case, and an uncaught rejection here fails the whole test run.
                .catch(() => undefined);
        }
        return () => {
            cancelled = true;
        };
    }, [paneKey, commands]);

    return { favourites, batches };
}
