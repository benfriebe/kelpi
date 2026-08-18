/**
 * Test-only harness for the pane handlers: a REAL store plus stub PTY / terminal / input /
 * reply seams, so every spec assertion is made against actual state transitions and the exact
 * JSON a client would read off the socket.
 *
 * Nothing in the daemon runtime path imports this (only `*.test.ts` does), but it lives in
 * `src/` as a real module so every colocated test builds the same fixtures, the same
 * convention `store/testing.ts` follows.
 */

import type { WireMessage } from '@nex/protocol';

import type {
    PtyManager,
    PtySpawnOptions,
    ReplyHandle,
    TerminalInput,
    TerminalStateService,
    VtModes
} from '../../seams.js';
import {
    createStore,
    emptyDaemonState,
    type DaemonState,
    type NexStore,
    type WorkspaceState
} from '../../store/index.js';
import type { PaneHandlerContext } from './context.js';
import { paneHandlers } from './index.js';

export const HOME = '/Users/test';
export const NOW = 1_755_500_000_000; // epoch ms

/** Canonical uppercase UUIDs that stay readable in failure output. */
export function testID(hexChar: string, n: number): string {
    return `${hexChar.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const W1 = testID('A', 1);
export const W2 = testID('B', 2);
export const G1 = testID('C', 1);

// ---------------------------------------------------------------------------
// Stub seams
// ---------------------------------------------------------------------------

export interface RecordedWrite {
    readonly paneID: string;
    readonly data: string;
}

export class StubPtyManager implements PtyManager {
    readonly spawns: PtySpawnOptions[] = [];
    readonly killed: string[] = [];
    readonly writes: RecordedWrite[] = [];
    readonly resizes: { paneID: string; cols: number; rows: number }[] = [];
    readonly syncGroups = new Map<string, string[]>();
    /** Every `setSyncGroup` call, so tests can assert the refresh happened at all. */
    readonly syncGroupCalls: { workspaceID: string; paneIDs: string[] }[] = [];
    private readonly live = new Set<string>();

    spawn(opts: PtySpawnOptions): void {
        if (this.live.has(opts.paneID)) return;
        this.live.add(opts.paneID);
        this.spawns.push(opts);
    }

    has(paneID: string): boolean {
        return this.live.has(paneID);
    }

    write(paneID: string, data: Uint8Array | string): void {
        this.writes.push({ paneID, data: asText(data) });
    }

    writeDirect(paneID: string, data: Uint8Array | string): void {
        this.writes.push({ paneID, data: asText(data) });
    }

    resize(paneID: string, cols: number, rows: number): void {
        this.resizes.push({ paneID, cols, rows });
    }

    kill(paneID: string): void {
        this.live.delete(paneID);
        this.killed.push(paneID);
    }

    async killAll(): Promise<void> {
        for (const paneID of [...this.live]) this.kill(paneID);
    }

    setSyncGroup(workspaceID: string, paneIDs: ReadonlySet<string>): void {
        this.syncGroupCalls.push({ workspaceID, paneIDs: [...paneIDs] });
        if (paneIDs.size === 0) this.syncGroups.delete(workspaceID);
        else this.syncGroups.set(workspaceID, [...paneIDs]);
    }

    onData(): () => void {
        return () => undefined;
    }

    onExit(): () => void {
        return () => undefined;
    }
}

const IDLE_MODES: VtModes = { applicationCursorKeys: false, bracketedPaste: false };

export class StubTerminalState implements TerminalStateService {
    /** Viewport text per pane. */
    readonly viewport = new Map<string, string>();
    /** Viewport + scrollback text per pane; falls back to `viewport`. */
    readonly scrollback = new Map<string, string>();
    readonly attached: { paneID: string; cols: number; rows: number }[] = [];
    readonly disposed: string[] = [];
    /** Set to make `capture` throw (surface-died race). */
    failCapture: Error | null = null;

    attach(paneID: string, cols: number, rows: number): void {
        this.attached.push({ paneID, cols, rows });
    }

    feed(paneID: string, data: Uint8Array): void {
        this.viewport.set(paneID, (this.viewport.get(paneID) ?? '') + asText(data));
    }

    resize(): void {
        /* no-op */
    }

    capture(paneID: string, opts: { scrollback: boolean }): string {
        if (this.failCapture !== null) throw this.failCapture;
        if (opts.scrollback) return this.scrollback.get(paneID) ?? this.viewport.get(paneID) ?? '';
        return this.viewport.get(paneID) ?? '';
    }

    async captureAsync(paneID: string, opts: { scrollback: boolean }): Promise<string> {
        return this.capture(paneID, opts);
    }

    has(paneID: string): boolean {
        return this.viewport.has(paneID) || this.scrollback.has(paneID);
    }

    snapshot(): { data: Uint8Array; cols: number; rows: number } {
        return { data: new Uint8Array(0), cols: 80, rows: 24 };
    }

    modes(): VtModes {
        return IDLE_MODES;
    }

    dispose(paneID: string): void {
        this.disposed.push(paneID);
        this.viewport.delete(paneID);
        this.scrollback.delete(paneID);
    }
}

export class StubTerminalInput implements TerminalInput {
    readonly texts: { paneID: string; text: string; bare: boolean }[] = [];
    readonly keys: { paneID: string; key: string }[] = [];

    sendText(paneID: string, text: string, opts: { bare: boolean }): void {
        this.texts.push({ paneID, text, bare: opts.bare });
    }

    sendNamedKey(paneID: string, key: string): void {
        this.keys.push({ paneID, key });
    }
}

export interface TestReply extends ReplyHandle {
    /** Every payload written, in order. */
    readonly payloads: Record<string, unknown>[];
    /** The single payload a request/response command must have produced. */
    only(): Record<string, unknown>;
    readonly closeCount: number;
}

export function stubReply(): TestReply {
    const payloads: Record<string, unknown>[] = [];
    let closed = false;
    let closeCount = 0;
    const callbacks: (() => void)[] = [];
    const handle: TestReply = {
        payloads,
        send(payload) {
            if (closed) return;
            // Round-trip through JSON so tests see exactly what the client reads (undefined
            // members vanish, ordering is preserved).
            payloads.push(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>);
        },
        close() {
            if (closed) return;
            closed = true;
            closeCount += 1;
            for (const callback of callbacks.splice(0)) callback();
        },
        get closed() {
            return closed;
        },
        get closeCount() {
            return closeCount;
        },
        onDisconnect(callback) {
            if (closed) callback();
            else callbacks.push(callback);
        },
        only() {
            if (payloads.length !== 1) {
                throw new Error(`expected exactly one reply line, got ${payloads.length}`);
            }
            return payloads[0] as Record<string, unknown>;
        }
    };
    return handle;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface HarnessOptions {
    readonly initial?: DaemonState;
    /** Pane ids handed out by the handlers, in order. Defaults to `N1, N2, …`. */
    readonly minted?: readonly string[];
    readonly now?: number;
}

export interface Harness {
    readonly store: NexStore;
    readonly pty: StubPtyManager;
    readonly term: StubTerminalState;
    readonly input: StubTerminalInput;
    readonly ctx: PaneHandlerContext;
    readonly broadcasts: Record<string, unknown>[];
    state(): DaemonState;
    workspace(id: string): WorkspaceState;
    /** Dispatch through the real handler table; returns the captured reply. */
    run(msg: WireMessage): TestReply;
    /** Dispatch with NO reply handle (legacy fire-and-forget client). */
    runSilent(msg: WireMessage): void;
    /** The next id the handlers will mint. */
    nextMinted(): string;
}

export function harness(options: HarnessOptions = {}): Harness {
    const store = createStore(options.initial ?? emptyDaemonState(HOME));
    const pty = new StubPtyManager();
    const term = new StubTerminalState();
    const input = new StubTerminalInput();
    const broadcasts: Record<string, unknown>[] = [];
    const minted = [...(options.minted ?? [])];
    let mintCounter = 0;
    const mint = (): string => {
        const next = minted.shift();
        if (next !== undefined) return next;
        mintCounter += 1;
        return testID('E', mintCounter);
    };

    const ctx: PaneHandlerContext = {
        store,
        pty,
        term,
        input,
        version: { version: '0.1.0', build: '1', protocol: 1 },
        broadcast: (event) => {
            broadcasts.push(event);
        },
        clock: () => options.now ?? NOW,
        mintPaneID: mint,
        profiles: () => [],
        spawn: { helpersDir: '/opt/nex/helpers', inheritedPath: '/usr/bin', cols: 80, rows: 24 }
    };

    const dispatch = (msg: WireMessage, reply: ReplyHandle | null): void => {
        const handler = paneHandlers.get(msg.command);
        if (handler === undefined) throw new Error(`no handler for ${msg.command}`);
        handler(msg, ctx, reply);
    };

    return {
        store,
        pty,
        term,
        input,
        ctx,
        broadcasts,
        state: () => store.getState(),
        workspace(id) {
            const found = store.getState().workspaces.find((workspace) => workspace.id === id);
            if (found === undefined) throw new Error(`no workspace ${id}`);
            return found;
        },
        run(msg) {
            const reply = stubReply();
            dispatch(msg, reply);
            return reply;
        },
        runSilent(msg) {
            dispatch(msg, null);
        },
        nextMinted() {
            return minted[0] ?? testID('E', mintCounter + 1);
        }
    };
}

/** A workspace with one shell pane: the shape `workspace create` produces. */
export function seedWorkspace(
    harnessInstance: Harness,
    fields: { id: string; name: string; paneID: string; path?: string }
): void {
    harnessInstance.store.dispatch({
        type: 'create-workspace',
        id: fields.id,
        paneID: fields.paneID,
        name: fields.name,
        color: 'blue',
        now: NOW,
        ...(fields.path === undefined ? {} : { workingDirectory: fields.path })
    });
}

/** Split `sourcePaneID` horizontally, giving the new pane `label`. */
export function seedSplit(
    harnessInstance: Harness,
    fields: { workspaceID: string; sourcePaneID: string; paneID: string; label?: string }
): void {
    harnessInstance.store.dispatch({
        type: 'split-pane',
        workspaceID: fields.workspaceID,
        paneID: fields.paneID,
        direction: 'horizontal',
        sourcePaneID: fields.sourcePaneID,
        label: fields.label ?? null,
        now: NOW
    });
}

function asText(data: Uint8Array | string): string {
    return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
}
