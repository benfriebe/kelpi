/**
 * `ContentClient` — one multiplexer between the content panes on screen and the daemon's
 * per-connection content subscriptions (M5, `daemon/src/ws/sync.ts` `CONTENT_COMMANDS`).
 *
 * It exists because the daemon's subscription is per *connection*, while the UI's is per
 * *component*:
 *
 *   - **Refcounting.** Two views of one pane (a pane rendered twice, a re-mount racing an
 *     unmount) share one wire subscription; the daemon only hears `content-unsubscribe` when
 *     the last local listener goes away. Re-subscribing would silently replace the daemon-side
 *     handle, so the count is what keeps the stream honest.
 *   - **Reconnect.** A dropped socket takes every subscription with it (the daemon clears the
 *     session's map on close), so the panes still mounted re-subscribe on the next `connected`.
 *   - **Typing.** Keystrokes are debounced HERE rather than in the textarea, because the flush
 *     has to be orderable against other commands: leaving edit mode must push the buffer before
 *     `markdown-set-mode` asks the daemon to save it, or the daemon writes a stale buffer.
 *
 * Everything is fire-and-forget from React's point of view: failures come back through the
 * listener's `onError`, never as an unhandled rejection in an event handler.
 */

import type { CommandClient, CommandReply, NexConnection } from '../connection';
import { isOkReply, replyError } from '../connection';
import {
    CONTENT_UPDATED_MESSAGE,
    parseContentState,
    type ContentMode,
    type ContentPaneState
} from './types';

/** Keystroke coalescing before a `content-set-text` goes out (the daemon debounces the write). */
export const CONTENT_TEXT_DEBOUNCE_MS = 300;

export interface ContentListener {
    readonly onState: (state: ContentPaneState) => void;
    readonly onError?: ((message: string) => void) | undefined;
}

export interface ContentSubscription {
    unsubscribe(): void;
}

/**
 * What a content pane component needs. Structural on purpose: a test hands the components a
 * three-method fake instead of a socket.
 */
/** §3.16 — what the header's +/- buttons and the ⌘= / ⌘- / ⌘0 bindings ask for. */
export type FontSizeStep = 'increase' | 'decrease' | 'reset';

/** §3.16 bounds. Applied here so the daemon's clamp is never the thing the user notices. */
export const CONTENT_FONT_SIZE_MIN = 8;
export const CONTENT_FONT_SIZE_MAX = 32;
export const CONTENT_FONT_SIZE_DEFAULT = 14;

/** `increase → min(size+1, 32)`, `decrease → max(size-1, 8)`, `reset → 14` (§3.16). */
export function nextFontSize(current: number, step: FontSizeStep): number {
    if (step === 'reset') return CONTENT_FONT_SIZE_DEFAULT;
    const base = Number.isFinite(current) && current > 0 ? current : CONTENT_FONT_SIZE_DEFAULT;
    return step === 'increase'
        ? Math.min(base + 1, CONTENT_FONT_SIZE_MAX)
        : Math.max(base - 1, CONTENT_FONT_SIZE_MIN);
}

export interface ContentApi {
    subscribe(paneID: string, listener: ContentListener): ContentSubscription;
    /** Debounced; the last text within the window wins. */
    setText(paneID: string, text: string): void;
    /** Send whatever the debounce is still holding. */
    flush(paneID: string): Promise<void>;
    /** Markdown view ⇄ edit. Flushes pending text first. */
    setMode(paneID: string, mode: ContentMode): Promise<void>;
    /** Diff: re-run git. Markdown: re-read the file. */
    refresh(paneID: string): Promise<void>;
    /** Ask the daemon to write its buffer now. */
    save(paneID: string): Promise<void>;
    /**
     * §3.16 preview font size. The step is resolved against the state this client already
     * mirrors, so callers do not have to carry the current size — and the daemon's reducer
     * still owns the clamp and the "markdown, not editing" guard.
     */
    setFontSize(paneID: string, step: FontSizeStep): Promise<void>;
    /** The last state seen for a pane; null when nothing is (or was) subscribed. */
    peek(paneID: string): ContentPaneState | null;
}

export interface ContentClientOptions {
    readonly connection: NexConnection;
    readonly commands: CommandClient;
    readonly debounceMs?: number | undefined;
    readonly onError?: ((message: string, context: string) => void) | undefined;
}

export interface ContentClient extends ContentApi {
    /** Live local subscribers for a pane (tests / diagnostics). */
    listenerCount(paneID: string): number;
    dispose(): void;
}

interface PaneEntry {
    readonly listeners: Set<ContentListener>;
    /** The last state seen, replayed to a listener that joins an existing subscription. */
    last: ContentPaneState | null;
    /** A wire subscription is believed live for this pane on the current connection. */
    subscribed: boolean;
    pendingText: string | null;
    timer: ReturnType<typeof setTimeout> | null;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function createContentClient(options: ContentClientOptions): ContentClient {
    const { connection, commands } = options;
    const debounceMs = options.debounceMs ?? CONTENT_TEXT_DEBOUNCE_MS;
    const entries = new Map<string, PaneEntry>();
    /** A drop happened since the last `connected`, so live entries need re-subscribing. */
    let staleSubscriptions = false;
    let disposed = false;

    const entryFor = (paneID: string): PaneEntry => {
        const existing = entries.get(paneID);
        if (existing !== undefined) return existing;
        const created: PaneEntry = {
            listeners: new Set<ContentListener>(),
            last: null,
            subscribed: false,
            pendingText: null,
            timer: null
        };
        entries.set(paneID, created);
        return created;
    };

    const fail = (paneID: string, message: string, context: string): void => {
        options.onError?.(message, context);
        const entry = entries.get(paneID);
        if (entry === undefined) return;
        for (const listener of [...entry.listeners]) listener.onError?.(message);
    };

    /** Apply a state snapshot, dropping one that is older than what the pane already has. */
    const deliver = (paneID: string, state: ContentPaneState): void => {
        const entry = entries.get(paneID);
        if (entry === undefined) return;
        if (entry.last !== null && state.revision < entry.last.revision) return;
        entry.last = state;
        for (const listener of [...entry.listeners]) listener.onState(state);
    };

    /** Every content verb answers `{ok, pane_id, state}`; the state is applied when it parses. */
    const settle = (paneID: string, promise: Promise<CommandReply>, context: string): Promise<void> =>
        promise.then(
            (reply) => {
                if (!isOkReply(reply)) {
                    fail(paneID, replyError(reply), context);
                    return;
                }
                const state = parseContentState(reply['state']);
                if (state !== null) deliver(paneID, state);
            },
            (error: unknown) => {
                fail(paneID, messageOf(error), context);
            }
        );

    const sendSubscribe = (paneID: string): void => {
        const entry = entries.get(paneID);
        if (entry === undefined || entry.listeners.size === 0) return;
        entry.subscribed = true;
        void settle(paneID, commands.subscribeContent({ paneID }), 'content-subscribe');
    };

    const flushText = (paneID: string): Promise<void> => {
        const entry = entries.get(paneID);
        if (entry === undefined) return Promise.resolve();
        if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        const text = entry.pendingText;
        if (text === null) return Promise.resolve();
        entry.pendingText = null;
        return settle(paneID, commands.setContentText({ paneID, text }), 'content-set-text');
    };

    // ── daemon → client ─────────────────────────────────────────────────────────────

    const offMessage = connection.on('message', (message) => {
        if (message['type'] !== CONTENT_UPDATED_MESSAGE) return;
        const paneID = message['paneID'];
        if (typeof paneID !== 'string') return;
        const state = parseContentState(message['state']);
        if (state === null) return;
        deliver(paneID, state);
    });

    const offStatus = connection.on('status', (status) => {
        if (status === 'connected') {
            if (!staleSubscriptions) return;
            staleSubscriptions = false;
            // The daemon dropped this connection's subscriptions with the socket; the panes on
            // screen have to ask again or they mirror a frozen document forever.
            for (const [paneID, entry] of entries) {
                if (entry.listeners.size === 0) continue;
                entry.subscribed = false;
                sendSubscribe(paneID);
            }
            return;
        }
        if (status === 'connecting') return;
        staleSubscriptions = true;
        for (const entry of entries.values()) entry.subscribed = false;
    });

    // ── client → daemon ─────────────────────────────────────────────────────────────

    const client: ContentClient = {
        subscribe(paneID, listener) {
            const entry = entryFor(paneID);
            entry.listeners.add(listener);
            if (entry.last !== null) listener.onState(entry.last);
            if (!entry.subscribed && !disposed) sendSubscribe(paneID);

            let released = false;
            return {
                unsubscribe(): void {
                    if (released) return;
                    released = true;
                    const current = entries.get(paneID);
                    if (current === undefined) return;
                    current.listeners.delete(listener);
                    if (current.listeners.size > 0) return;
                    // Last view of this pane: push anything still buffered before the daemon
                    // stops talking to us about it, then release the entry.
                    void flushText(paneID);
                    const wasSubscribed = current.subscribed;
                    entries.delete(paneID);
                    if (wasSubscribed && !disposed) {
                        void commands
                            .unsubscribeContent({ paneID })
                            .catch((error: unknown) =>
                                options.onError?.(messageOf(error), 'content-unsubscribe')
                            );
                    }
                }
            };
        },

        setText(paneID, text) {
            if (disposed) return;
            const entry = entryFor(paneID);
            entry.pendingText = text;
            if (entry.timer !== null) clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
                entry.timer = null;
                void flushText(paneID);
            }, debounceMs);
        },

        flush(paneID) {
            return flushText(paneID);
        },

        setMode(paneID, mode) {
            // Order matters: the daemon flushes its buffer when leaving edit mode, so anything
            // the user typed in the last few hundred milliseconds has to arrive first. The
            // flush's *send* is synchronous and the socket is ordered, so the two land in that
            // order at the daemon — waiting for its ack would stall the toggle behind a round
            // trip for no extra guarantee.
            void flushText(paneID);
            return settle(paneID, commands.setMarkdownMode({ paneID, mode }), 'markdown-set-mode');
        },

        refresh(paneID) {
            return settle(paneID, commands.refreshContent({ paneID }), 'diff-refresh');
        },

        save(paneID) {
            void flushText(paneID);
            return settle(paneID, commands.saveContent({ paneID }), 'markdown-save');
        },

        setFontSize(paneID, step) {
            const current = entries.get(paneID)?.last?.fontSize ?? CONTENT_FONT_SIZE_DEFAULT;
            const size = nextFontSize(current, step);
            if (size === current) return Promise.resolve();
            return settle(paneID, commands.setContentFontSize({ paneID, size }), 'content-set-font-size');
        },

        peek(paneID) {
            return entries.get(paneID)?.last ?? null;
        },

        listenerCount(paneID) {
            return entries.get(paneID)?.listeners.size ?? 0;
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            offMessage();
            offStatus();
            // A closing tab still owes the daemon whatever the debounce is holding.
            for (const [paneID, entry] of entries) {
                if (entry.timer !== null) clearTimeout(entry.timer);
                entry.timer = null;
                const text = entry.pendingText;
                entry.pendingText = null;
                entry.listeners.clear();
                if (text === null) continue;
                void commands.setContentText({ paneID, text }).catch(() => undefined);
            }
            entries.clear();
        }
    };

    return client;
}
