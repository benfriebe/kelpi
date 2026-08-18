/**
 * Test doubles for the connection layer — a scripted WebSocket plus the daemon's half of the
 * handshake. Exported (rather than hidden in a `__tests__` folder) so the terminal/grid work
 * packages can drive a connection in their own tests without re-implementing the protocol.
 */

import type { JsonObject } from '@nex/protocol';

import type { SocketCloseLike, SocketFactory, SocketLike } from './socket';

export class FakeWebSocket implements SocketLike {
    binaryType = 'blob';
    readyState = 0;

    onopen: ((event: unknown) => void) | null = null;
    onclose: ((event: SocketCloseLike) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;

    /** Text frames the client wrote, newest last. */
    readonly sent: string[] = [];
    /** Binary frames the client wrote. */
    readonly frames: Uint8Array[] = [];
    readonly closes: { code?: number | undefined; reason?: string | undefined }[] = [];

    constructor(readonly url: string) {}

    send(data: string | ArrayBufferLike | ArrayBufferView): void {
        if (typeof data === 'string') {
            this.sent.push(data);
            return;
        }
        if (ArrayBuffer.isView(data)) {
            const view = data;
            this.frames.push(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
            return;
        }
        this.frames.push(new Uint8Array(data as ArrayBuffer));
    }

    close(code?: number, reason?: string): void {
        this.closes.push({ code, reason });
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true });
    }

    // ── server-side driving ─────────────────────────────────────────────────────────

    /** Complete the TCP/WS open; the client answers with `hello`. Idempotent. */
    open(): void {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
    }

    /** Push one JSON text frame down to the client. */
    emit(message: JsonObject | Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }

    /** Push one binary frame down to the client (as an ArrayBuffer, like a real socket). */
    emitBinary(bytes: Uint8Array): void {
        const copy = bytes.slice();
        this.onmessage?.({ data: copy.buffer });
    }

    /** Server-initiated drop (`1006` = abnormal, what a killed daemon looks like). */
    serverClose(code = 1006, reason = 'gone'): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code, reason, wasClean: false });
    }

    /** The parsed text frames, for assertions. */
    messages(): Record<string, unknown>[] {
        return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    }

    /** The last text frame of the given `type`, if any. */
    lastOfType(type: string): Record<string, unknown> | undefined {
        return [...this.messages()].reverse().find((message) => message['type'] === type);
    }
}

export interface FakeSocketHarness {
    readonly factory: SocketFactory;
    readonly sockets: FakeWebSocket[];
    /** The most recent socket; throws when nothing has dialled yet. */
    last(): FakeWebSocket;
}

export function createFakeSocketFactory(): FakeSocketHarness {
    const sockets: FakeWebSocket[] = [];
    return {
        factory: (url: string) => {
            const socket = new FakeWebSocket(url);
            sockets.push(socket);
            return socket;
        },
        sockets,
        last(): FakeWebSocket {
            const socket = sockets[sockets.length - 1];
            if (socket === undefined) throw new Error('no socket has been created yet');
            return socket;
        }
    };
}

export interface HandshakeOptions {
    readonly clientID?: string;
    readonly seq?: number;
    readonly state?: JsonObject;
    /** Skip the snapshot (to test a client that must wait for one). */
    readonly snapshot?: boolean;
}

/** The daemon's `welcome` (+ `snapshot`) reply, matching `ws/sync.ts`. */
export function completeHandshake(socket: FakeWebSocket, options: HandshakeOptions = {}): void {
    socket.open();
    socket.emit({
        type: 'welcome',
        protocolVersion: 1,
        clientID: options.clientID ?? 'client-1',
        daemon: { version: '0.1.0', build: 'test', pid: 4242 }
    });
    if (options.snapshot === false) return;
    socket.emit({
        type: 'snapshot',
        seq: options.seq ?? 0,
        state: options.state ?? emptySnapshotState()
    });
}

/** A minimal serialized `DaemonState` (`ws/serialize.ts` `serializeState`). */
export function emptySnapshotState(): JsonObject {
    return {
        workspaces: [],
        groups: [],
        topLevelOrder: [],
        lastActiveWorkspaceID: null,
        repos: [],
        labelPresets: []
    };
}
