/**
 * Image panes (content-panes.md §12): the one file a pane may serve, and the watch that tells
 * clients it changed.
 *
 * An image pane has no content entry, no edit buffer and nothing to render: the client draws
 * the file with an `<img>` that loads it from the credentialed `/pane-assets/` route, the same
 * route a markdown preview's sibling images use. So the daemon's whole job is two answers:
 *
 *   - **which file** `/pane-assets/<paneID>/<name>` may return for an image pane: the pane's
 *     own file, asked for by its own name, and nothing else (`imageAssetPath`). A markdown
 *     pane exposes its directory because a document links its siblings; an image links
 *     nothing, so nothing beside it is reachable through it.
 *   - **when it changed** (`createImageWatchService`). Every visible image pane's file is
 *     watched, and a change is broadcast as `image-changed`, so a screenshot an agent
 *     regenerates redraws in place. The broadcast names the pane and nothing else: a client
 *     not showing that pane drops it, and one that is fetches the file again under a new URL.
 *
 * Watching every visible image pane, rather than the ones a client subscribed to, keeps the
 * protocol to one broadcast with no per-session bookkeeping. Image panes are few, and a watch
 * is one file handle.
 */

import fs from 'node:fs';
import path from 'node:path';

import { IMAGE_CHANGED_MESSAGE } from '@kelpi/protocol';

import type { DomainStore } from '../seams.js';
import type { DaemonState, DomainAction, DomainEvent, Pane } from '../store/types.js';
import { watchFile, type FileWatcher, type WatchFn } from './watcher.js';

/**
 * The file `/pane-assets/<paneID>/<relativePath>` returns for an image pane, or null (a 404).
 *
 * Only the pane's own file, only by its own base name, and only while it is a regular file. The
 * path itself is returned, not its real path, because the response's `content-type` comes from
 * the extension and only the opened name is known to have an image one.
 */
export function imageAssetPath(pane: Pane, relativePath: string): string | null {
    const filePath = pane.filePath;
    if (pane.type !== 'image' || filePath === null || !path.isAbsolute(filePath)) return null;
    if (relativePath !== path.basename(filePath)) return null;
    try {
        return fs.statSync(filePath).isFile() ? filePath : null;
    } catch {
        return null;
    }
}

/**
 * A burst of writes (a screenshot tool writing in chunks, then renaming) is one change. Long
 * enough to swallow the burst, short enough that the redraw still feels immediate.
 */
export const IMAGE_CHANGE_DEBOUNCE_MS = 120;

export interface ImageWatchOptions {
    readonly store: DomainStore<DaemonState, DomainAction, DomainEvent>;
    /** The WS hub's broadcast; called with `{type: 'image-changed', paneID, workspaceID}`. */
    readonly broadcast: (event: Record<string, unknown>) => void;
    readonly debounceMs?: number | undefined;
    readonly reattachDelayMs?: number | undefined;
    /** Injection point for tests; defaults to `fs.watch`. */
    readonly watch?: WatchFn | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface ImageWatchService {
    /** The panes being watched and their files (tests, diagnostics). */
    watched(): ReadonlyMap<string, string>;
    dispose(): void;
}

interface Watched {
    readonly filePath: string;
    readonly workspaceID: string;
    readonly watcher: FileWatcher;
    timer: ReturnType<typeof setTimeout> | null;
}

export function createImageWatchService(options: ImageWatchOptions): ImageWatchService {
    const debounceMs = options.debounceMs ?? IMAGE_CHANGE_DEBOUNCE_MS;
    const watched = new Map<string, Watched>();
    let disposed = false;

    const stop = (paneID: string): void => {
        const entry = watched.get(paneID);
        if (entry === undefined) return;
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.watcher.close();
        watched.delete(paneID);
    };

    const changed = (paneID: string): void => {
        const entry = watched.get(paneID);
        if (disposed || entry === undefined) return;
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            entry.timer = null;
            if (disposed || watched.get(paneID) !== entry) return;
            options.broadcast({ type: IMAGE_CHANGED_MESSAGE, paneID, workspaceID: entry.workspaceID });
        }, debounceMs);
        // A pending broadcast must never hold the daemon open.
        entry.timer.unref?.();
    };

    const start = (paneID: string, workspaceID: string, filePath: string): void => {
        const watcher = watchFile({
            path: filePath,
            onChange: () => changed(paneID),
            ...(options.reattachDelayMs !== undefined ? { reattachDelayMs: options.reattachDelayMs } : {}),
            ...(options.watch !== undefined ? { watch: options.watch } : {}),
            ...(options.onError !== undefined ? { onError: options.onError } : {})
        });
        watched.set(paneID, { filePath, workspaceID, watcher, timer: null });
    };

    /** Make the watch set match the store's visible image panes exactly. */
    const reconcile = (): void => {
        if (disposed) return;
        const wanted = new Map<string, { workspaceID: string; filePath: string }>();
        for (const workspace of options.store.getState().workspaces) {
            for (const pane of workspace.panes) {
                if (pane.type !== 'image' || pane.filePath === null || !path.isAbsolute(pane.filePath)) continue;
                wanted.set(pane.id, { workspaceID: workspace.id, filePath: pane.filePath });
            }
        }
        for (const [paneID, entry] of [...watched]) {
            const want = wanted.get(paneID);
            if (want === undefined || want.filePath !== entry.filePath || want.workspaceID !== entry.workspaceID) stop(paneID);
        }
        for (const [paneID, want] of wanted) {
            if (!watched.has(paneID)) start(paneID, want.workspaceID, want.filePath);
        }
    };

    const relevant = (event: DomainEvent): boolean =>
        event.kind === 'pane-removed' ||
        event.kind === 'workspace-removed' ||
        event.kind === 'workspace-upserted' ||
        (event.kind === 'pane-upserted' && (event.pane.type === 'image' || watched.has(event.paneID)));

    const unsubscribe = options.store.subscribe((events) => {
        if (events.some(relevant)) reconcile();
    });
    reconcile();

    return {
        watched: () => new Map([...watched].map(([paneID, entry]) => [paneID, entry.filePath])),
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe();
            for (const paneID of [...watched.keys()]) stop(paneID);
        }
    };
}
