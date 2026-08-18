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
            writes.push({ paneID, data: typeof data === 'string' ? data : textOf(data) });
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
    /** Resolve `snapshotAsync` on the next microtask instead of immediately. */
    asyncSnapshots: boolean;
}

export function stubTerm(): StubTerm {
    const snapshots = new Map<string, string>();
    const resizes: { paneID: string; cols: number; rows: number }[] = [];
    const fed: { paneID: string; data: string }[] = [];
    const modes: VtModes = { applicationCursorKeys: false, bracketedPaste: false };
    const state = {
        asyncSnapshots: false
    };

    const read = (paneID: string): { data: Uint8Array; cols: number; rows: number } => ({
        data: bytes(snapshots.get(paneID) ?? ''),
        cols: 80,
        rows: 24
    });

    const service: TerminalStateService & {
        snapshotAsync(paneID: string): Promise<{ data: Uint8Array; cols: number; rows: number }>;
    } = {
        attach: () => {},
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
            return read(paneID);
        },
        modes: () => modes,
        dispose: (paneID) => {
            snapshots.delete(paneID);
        }
    };

    return {
        service,
        resizes,
        fed,
        setSnapshot(paneID, data) {
            snapshots.set(paneID, data);
        },
        get asyncSnapshots() {
            return state.asyncSnapshots;
        },
        set asyncSnapshots(value: boolean) {
            state.asyncSnapshots = value;
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
