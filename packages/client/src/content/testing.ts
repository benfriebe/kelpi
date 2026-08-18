/**
 * Test doubles for the content layer: a scriptable `ContentApi` and a state builder.
 *
 * Exported (rather than hidden in the test files) for the same reason `connection/testing.ts`
 * and `grid/testing.ts` are — assembly tests need to drive a content pane without standing up a
 * socket, and every one of them would otherwise re-invent this fake.
 */

import type { ContentApi, ContentListener, ContentSubscription } from './client';
import type { ContentPaneState } from './types';

export interface SentText {
    readonly paneID: string;
    readonly text: string;
}

export interface SentMode {
    readonly paneID: string;
    readonly mode: 'view' | 'edit';
}

export interface FakeContentApi extends ContentApi {
    /** Pane ids in subscribe order (one entry per `subscribe` call). */
    readonly subscribes: string[];
    readonly unsubscribes: string[];
    readonly texts: SentText[];
    readonly modes: SentMode[];
    readonly refreshes: string[];
    readonly saves: string[];
    readonly flushes: string[];
    listenerCount(paneID: string): number;
    /** Deliver a state snapshot to a pane's listeners. */
    push(state: ContentPaneState): void;
    /** Deliver a failure to a pane's listeners. */
    fail(paneID: string, message: string): void;
}

export function createFakeContentApi(): FakeContentApi {
    const listeners = new Map<string, Set<ContentListener>>();
    const subscribes: string[] = [];
    const unsubscribes: string[] = [];
    const texts: SentText[] = [];
    const modes: SentMode[] = [];
    const refreshes: string[] = [];
    const saves: string[] = [];
    const flushes: string[] = [];

    return {
        subscribes,
        unsubscribes,
        texts,
        modes,
        refreshes,
        saves,
        flushes,

        subscribe(paneID: string, listener: ContentListener): ContentSubscription {
            subscribes.push(paneID);
            const set = listeners.get(paneID) ?? new Set<ContentListener>();
            set.add(listener);
            listeners.set(paneID, set);
            return {
                unsubscribe(): void {
                    unsubscribes.push(paneID);
                    set.delete(listener);
                    if (set.size === 0) listeners.delete(paneID);
                }
            };
        },

        setText(paneID: string, text: string): void {
            texts.push({ paneID, text });
        },

        flush(paneID: string): Promise<void> {
            flushes.push(paneID);
            return Promise.resolve();
        },

        setMode(paneID: string, mode: 'view' | 'edit'): Promise<void> {
            modes.push({ paneID, mode });
            return Promise.resolve();
        },

        refresh(paneID: string): Promise<void> {
            refreshes.push(paneID);
            return Promise.resolve();
        },

        save(paneID: string): Promise<void> {
            saves.push(paneID);
            return Promise.resolve();
        },

        listenerCount(paneID: string): number {
            return listeners.get(paneID)?.size ?? 0;
        },

        push(state: ContentPaneState): void {
            for (const listener of [...(listeners.get(state.paneID) ?? [])]) listener.onState(state);
        },

        fail(paneID: string, message: string): void {
            for (const listener of [...(listeners.get(paneID) ?? [])]) listener.onError?.(message);
        }
    };
}

/** A content snapshot with sane defaults; override only what a test is about. */
export function contentState(overrides: Partial<ContentPaneState> & { paneID: string }): ContentPaneState {
    return {
        workspaceID: 'WS',
        type: 'markdown',
        mode: 'view',
        filePath: '/repo/README.md',
        html: '<!DOCTYPE html>\n<html class="dark">\n<head>\n</head>\n<body>\n<h1>Doc</h1>\n</body>\n</html>\n',
        text: '# Doc\n',
        loaded: true,
        error: null,
        dirty: false,
        fontSize: 14,
        isDark: true,
        revision: 1,
        updatedAt: 1,
        assetBase: `/pane-assets/${overrides.paneID}/`,
        ...overrides
    };
}
