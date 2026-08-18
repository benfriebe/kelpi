/**
 * Per-pane console capture (web-pane.md §9).
 *
 * Lines are produced by the host (injected page script / CDP events), appended to that pane's
 * ring buffer here, and read two ways:
 *
 *   - **poll drain** — `nex web console [--since N] [--level L] [--clear]` → one reply carrying
 *     the matching lines, `next_since` and the drop count;
 *   - **follow stream** — `nex web console --follow` → the same drain object as line 1 (the
 *     handle is NOT closed), then one JSON object per appended line until the client hangs up.
 *
 * Two behaviours are deliberate quirks carried over from the Swift app (§9.3, §17.5):
 *   - streamed lines are NOT filtered by the `--level` given at subscribe time — only the
 *     catch-up drain is;
 *   - a drop count rides on the NEXT streamed line (`"dropped": N`) rather than being its own
 *     notice, so ordering between "lines were lost" and the live lines is unambiguous. It is
 *     acknowledged by exactly two paths: a poll drain, and that fan-out.
 */

import type { JsonObject } from '@nex/protocol';

import { createRingBuffer, type RingBuffer } from './ring.js';

/** §2 capacity of the console buffer. */
export const CONSOLE_BUFFER_CAPACITY = 1000;

export const CONSOLE_LEVELS = ['log', 'debug', 'info', 'warn', 'error'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export function isConsoleLevel(value: string): value is ConsoleLevel {
    return (CONSOLE_LEVELS as readonly string[]).includes(value);
}

/** CDP levels that are not one of ours (`warning`, `verbose`, `assert`) map in. */
export function normalizeConsoleLevel(raw: string): ConsoleLevel {
    const value = raw.toLowerCase();
    if (isConsoleLevel(value)) return value;
    if (value === 'warning') return 'warn';
    if (value === 'verbose' || value === 'trace') return 'debug';
    if (value === 'assert' || value === 'exception') return 'error';
    return 'log';
}

export interface ConsoleLine {
    readonly tabID: string;
    readonly level: ConsoleLevel;
    readonly message: string;
    readonly url: string;
    readonly lineNumber?: number | undefined;
    readonly columnNumber?: number | undefined;
    /** Epoch ms, stamped daemon-side on receipt (§2). */
    readonly capturedAt: number;
}

export interface ConsoleDrainOptions {
    readonly since?: number | undefined;
    readonly level?: string | undefined;
    readonly clear?: boolean | undefined;
}

export interface ConsoleDrain {
    readonly lines: readonly JsonObject[];
    readonly next_since: number;
    readonly dropped: number;
}

/** A live follower: a control-socket `--follow` handle, or a subscribed WS client. */
export interface ConsoleSubscriber {
    push(line: JsonObject): void;
    /** The pane went away: it can never catch up, so the stream ends (§9.3 teardown b). */
    end?(): void;
}

export interface ConsoleStore {
    append(paneID: string, line: ConsoleLine): void;
    drain(paneID: string, options?: ConsoleDrainOptions): ConsoleDrain;
    subscribe(paneID: string, subscriber: ConsoleSubscriber): () => void;
    /** Live subscriber count for a pane (tests / diagnostics). */
    subscribers(paneID: string): number;
    /** Pane closed: end every stream and forget the buffer. */
    disposePane(paneID: string): void;
    /** Daemon shutdown. */
    close(): void;
}

/** The wire shape of one line: also exactly what a streamed line looks like (§9.2/§9.3). */
export function serializeConsoleLine(seq: number, line: ConsoleLine): JsonObject {
    return {
        seq,
        tab_id: line.tabID,
        level: line.level,
        message: line.message,
        url: line.url,
        // §9.2: ISO8601 WITH fractional seconds (unlike the seconds-precision pane timestamps).
        captured_at: new Date(line.capturedAt).toISOString(),
        ...(line.lineNumber !== undefined ? { line: line.lineNumber } : {}),
        ...(line.columnNumber !== undefined ? { column: line.columnNumber } : {})
    };
}

export function createConsoleStore(
    options: { readonly capacity?: number | undefined } = {}
): ConsoleStore {
    const capacity = options.capacity ?? CONSOLE_BUFFER_CAPACITY;
    const buffers = new Map<string, RingBuffer<ConsoleLine>>();
    const followers = new Map<string, Set<ConsoleSubscriber>>();

    const bufferFor = (paneID: string): RingBuffer<ConsoleLine> => {
        const existing = buffers.get(paneID);
        if (existing !== undefined) return existing;
        const created = createRingBuffer<ConsoleLine>(capacity);
        buffers.set(paneID, created);
        return created;
    };

    const disposePane = (paneID: string): void => {
        const set = followers.get(paneID);
        followers.delete(paneID);
        buffers.delete(paneID);
        if (set === undefined) return;
        for (const subscriber of [...set]) subscriber.end?.();
    };

    return {
        append(paneID, line) {
            const buffer = bufferFor(paneID);
            // §9.1: the append is committed BEFORE the fan-out, which then reads the entry —
            // load-bearing ordering, a follower must never see a line the buffer lacks.
            const entry = buffer.append(line);
            const subscribers = followers.get(paneID);
            if (subscribers === undefined || subscribers.size === 0) return;
            const dropped = buffer.acknowledgeDrops();
            const payload =
                dropped > 0
                    ? { ...serializeConsoleLine(entry.seq, line), dropped }
                    : serializeConsoleLine(entry.seq, line);
            for (const subscriber of [...subscribers]) subscriber.push(payload);
        },

        drain(paneID, drainOptions = {}) {
            const buffer = buffers.get(paneID);
            if (buffer === undefined) {
                return { lines: [], next_since: 0, dropped: 0 };
            }
            const since = drainOptions.since ?? 0;
            const level = drainOptions.level;
            const entries = buffer
                .entriesSince(since)
                .filter((entry) => level === undefined || entry.value.level === level);
            const lines = entries.map((entry) => serializeConsoleLine(entry.seq, entry.value));
            const nextSince = buffer.nextSeq;
            // §9.2: the drain always acknowledges, so the next call reports only NEW drops.
            const dropped = buffer.acknowledgeDrops();
            if (drainOptions.clear === true) buffer.clear();
            return { lines, next_since: nextSince, dropped };
        },

        subscribe(paneID, subscriber) {
            const set = followers.get(paneID) ?? new Set<ConsoleSubscriber>();
            set.add(subscriber);
            followers.set(paneID, set);
            return () => {
                const current = followers.get(paneID);
                if (current === undefined) return;
                current.delete(subscriber);
                if (current.size === 0) followers.delete(paneID);
            };
        },

        subscribers(paneID) {
            return followers.get(paneID)?.size ?? 0;
        },

        disposePane,

        close() {
            for (const paneID of [...followers.keys()]) disposePane(paneID);
            buffers.clear();
        }
    };
}
