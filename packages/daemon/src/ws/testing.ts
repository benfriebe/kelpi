/**
 * Test-only doubles for the WS server's specs (mirrors `store/testing.ts`: a real module so
 * every colocated test builds the same fixtures, imported by nothing in the runtime path).
 */

import type { PtyManager, PtySpawnOptions, TerminalStateService, VtModes } from '../seams.js';

export const PANE_A = '11111111-2222-4333-8444-555555555555';
export const PANE_B = '66666666-7777-4888-8999-AAAAAAAAAAAA';

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
    return encoder.encode(text);
}

export function textOf(data: Uint8Array): string {
    return Buffer.from(data).toString('utf8');
}

export interface StubPty {
    readonly manager: PtyManager;
    readonly writes: { paneID: string; data: string }[];
    /** The subset of `writes` that took the un-mirrored `writeDirect` path (§8.2, #51). */
    readonly directWrites: { paneID: string; data: string }[];
    readonly resizes: { paneID: string; cols: number; rows: number }[];
    readonly spawns: PtySpawnOptions[];
    /** Simulate PTY output. */
    emit(paneID: string, data: string | Uint8Array): void;
    exit(paneID: string, code: number): void;
}

export function stubPty(): StubPty {
    const dataListeners = new Set<(paneID: string, data: Uint8Array) => void>();
    const exitListeners = new Set<(paneID: string, code: number) => void>();
    const writes: { paneID: string; data: string }[] = [];
    const directWrites: { paneID: string; data: string }[] = [];
    const resizes: { paneID: string; cols: number; rows: number }[] = [];
    const spawns: PtySpawnOptions[] = [];
    const live = new Set<string>();

    const manager: PtyManager = {
        spawn(options) {
            spawns.push(options);
            live.add(options.paneID);
        },
        has: (paneID) => live.has(paneID),
        write(paneID, data) {
            writes.push({ paneID, data: typeof data === 'string' ? data : textOf(data) });
        },
        writeDirect(paneID, data) {
            const entry = { paneID, data: typeof data === 'string' ? data : textOf(data) };
            writes.push(entry);
            directWrites.push(entry);
        },
        resize(paneID, cols, rows) {
            resizes.push({ paneID, cols, rows });
        },
        kill(paneID) {
            live.delete(paneID);
        },
        killAll: async () => {
            live.clear();
        },
        setSyncGroup: () => {},
        onData(callback) {
            dataListeners.add(callback);
            return () => dataListeners.delete(callback);
        },
        onExit(callback) {
            exitListeners.add(callback);
            return () => exitListeners.delete(callback);
        }
    };

    return {
        manager,
        writes,
        directWrites,
        resizes,
        spawns,
        emit(paneID, data) {
            const payload = typeof data === 'string' ? bytes(data) : data;
            for (const listener of [...dataListeners]) listener(paneID, payload);
        },
        exit(paneID, code) {
            for (const listener of [...exitListeners]) listener(paneID, code);
        }
    };
}

export interface StubTerm {
    readonly service: TerminalStateService;
    readonly resizes: { paneID: string; cols: number; rows: number }[];
    readonly fed: { paneID: string; data: string }[];
    /** What the next `snapshot()` returns for a pane. */
    setSnapshot(paneID: string, data: string): void;
    /**
     * A chunk that has REACHED the emulator but has not been parsed yet.
     *
     * This is the difference the flow-control re-seed turns on (N23), and the stub could not
     * express it: `feed()` only queues — xterm parses asynchronously — so the sync `snapshot()`
     * describes everything parsed *so far* and silently omits a chunk fed a moment ago, while
     * `snapshotAsync()` settles the write chain first and therefore includes it. Two snapshots
     * that read alike cannot tell the pre-fix path from the fixed one, which is what made the
     * "re-seeds from the flushing snapshot" test pass either way.
     *
     * Absent from `snapshot()` and from `capture()`; folded into the parsed text by the next
     * `snapshotAsync()` — the settle IS the parse, exactly as it is in `term/service.ts`.
     */
    feedMidParse(paneID: string, data: string): void;
    /** Resolve `snapshotAsync` on the next microtask instead of immediately. */
    asyncSnapshots: boolean;
    /** What `modes()` reports from here on (§TERM-037's `pane-modes` stream). */
    setModes(modes: VtModes): void;
}

export function stubTerm(): StubTerm {
    const snapshots = new Map<string, string>();
    const resizes: { paneID: string; cols: number; rows: number }[] = [];
    const fed: { paneID: string; data: string }[] = [];
    const state = {
        asyncSnapshots: false,
        modes: { applicationCursorKeys: false, bracketedPaste: false } as VtModes
    };

    const read = (paneID: string): { data: Uint8Array; cols: number; rows: number } => ({
        data: bytes(snapshots.get(paneID) ?? ''),
        cols: 80,
        rows: 24
    });

    /**
     * Panes the emulator has thrown away. The real service answers `has()` false for these and
     * hands back an EMPTY snapshot, which is the difference the resync path cares about (an
     * empty replay would wipe a client's screen), so the stub has to be able to be in that
     * state too.
     */
    const disposed = new Set<string>();

    /** Fed but not parsed (`feedMidParse`): what only a FLUSHING snapshot can see. */
    const midParse = new Map<string, string>();
    const flush = (paneID: string): void => {
        const pending = midParse.get(paneID);
        if (pending === undefined) return;
        midParse.delete(paneID);
        if (disposed.has(paneID)) return;
        snapshots.set(paneID, (snapshots.get(paneID) ?? '') + pending);
    };

    const service: TerminalStateService & {
        snapshotAsync(paneID: string): Promise<{ data: Uint8Array; cols: number; rows: number }>;
        has(paneID: string): boolean;
    } = {
        attach: (paneID) => {
            disposed.delete(paneID);
        },
        has: (paneID) => !disposed.has(paneID),
        feed(paneID, data) {
            fed.push({ paneID, data: textOf(data) });
            snapshots.set(paneID, (snapshots.get(paneID) ?? '') + textOf(data));
        },
        resize(paneID, cols, rows) {
            resizes.push({ paneID, cols, rows });
        },
        capture: (paneID) => snapshots.get(paneID) ?? '',
        snapshot: read,
        async snapshotAsync(paneID) {
            if (state.asyncSnapshots) await new Promise<void>((resolve) => setImmediate(resolve));
            // Settling the write chain is what parses the pending chunk — after this the sync
            // snapshot can see it too, just as it can in the real service.
            flush(paneID);
            return read(paneID);
        },
        modes: () => state.modes,
        dispose: (paneID) => {
            snapshots.delete(paneID);
            midParse.delete(paneID);
            disposed.add(paneID);
        }
    };

    return {
        service,
        resizes,
        fed,
        setSnapshot(paneID, data) {
            snapshots.set(paneID, data);
        },
        feedMidParse(paneID, data) {
            fed.push({ paneID, data });
            midParse.set(paneID, (midParse.get(paneID) ?? '') + data);
        },
        get asyncSnapshots() {
            return state.asyncSnapshots;
        },
        set asyncSnapshots(value: boolean) {
            state.asyncSnapshots = value;
        },
        setModes(modes) {
            state.modes = modes;
        }
    };
}

export interface RecordedTransport {
    readonly json: Record<string, unknown>[];
    readonly frames: Uint8Array[];
    readonly closes: { code?: number | undefined; reason?: string | undefined }[];
    sendJson(message: Record<string, unknown>): void;
    sendFrame(frame: Uint8Array): void;
    close(code?: number, reason?: string): void;
    /** Every message of a given `type`, in order. */
    ofType(type: string): Record<string, unknown>[];
}

export function recordingTransport(): RecordedTransport {
    const json: Record<string, unknown>[] = [];
    const frames: Uint8Array[] = [];
    const closes: { code?: number | undefined; reason?: string | undefined }[] = [];
    return {
        json,
        frames,
        closes,
        sendJson(message) {
            json.push(message);
        },
        sendFrame(frame) {
            frames.push(frame);
        },
        close(code, reason) {
            closes.push({ code, reason });
        },
        ofType(type) {
            return json.filter((message) => message['type'] === type);
        }
    };
}
