/**
 * The daemon's host spawner, usable before the host connection exists (`docs/terminal-host.md` §5).
 *
 * The PTY manager needs a synchronous `PtySpawner` when the daemon is built, but the host is
 * connected later, in `start()`, and only once the daemon knows it owns the run dir (attaching
 * first would take the host from a live daemon). A spawn that arrives in between (a `pane-create`
 * racing the boot, or one issued while a lost host is being relaunched, §8.2) gets a
 * `PendingHostHandle`: every call on it is queued, and it becomes a real host terminal when the
 * slot is bound. A handle that never binds (the host could not be started) exits with -1, which
 * is exactly how the manager reports a failed spawn.
 */

import type { PtyProcessHandle, PtySpawner, PtySpawnRequest } from '../pty/types.js';
import type { HostPtyHandle, TerminalHostClient } from './client.js';

type DataListener = (data: Uint8Array) => void;
type ExitListener = (exitCode: number, signal: number | undefined) => void;

export class PendingHostHandle implements PtyProcessHandle {
    private real: PtyProcessHandle | undefined;
    private readonly ops: ((handle: PtyProcessHandle) => void)[] = [];
    private dataListener: DataListener | undefined;
    private exitListener: ExitListener | undefined;
    private failed = false;

    constructor(readonly request: PtySpawnRequest) {}

    get pid(): number {
        return this.real?.pid ?? 0;
    }

    /** The host terminal behind this handle, once bound. */
    get bound(): PtyProcessHandle | undefined {
        return this.real;
    }

    /** Killed (or given up on) before it ever started: it must never start now. */
    get isFailed(): boolean {
        return this.failed;
    }

    write(data: string | Uint8Array): void {
        this.forward((handle) => handle.write(data));
    }

    resize(cols: number, rows: number): void {
        this.forward((handle) => handle.resize(cols, rows));
    }

    pause(): void {
        this.forward((handle) => handle.pause?.());
    }

    resume(): void {
        this.forward((handle) => handle.resume?.());
    }

    kill(signal?: string): void {
        if (this.real === undefined && !this.failed) {
            // Killed before it ever existed: it simply never starts.
            this.fail();
            return;
        }
        this.forward((handle) => handle.kill(signal));
    }

    onData(listener: DataListener): void {
        this.dataListener = listener;
        this.real?.onData(listener);
    }

    onExit(listener: ExitListener): void {
        this.exitListener = listener;
        if (this.failed) listener(-1, undefined);
        else this.real?.onExit(listener);
    }

    /** @internal */
    bind(real: PtyProcessHandle): void {
        if (this.failed || this.real !== undefined) return;
        this.real = real;
        if (this.dataListener !== undefined) real.onData(this.dataListener);
        if (this.exitListener !== undefined) real.onExit(this.exitListener);
        for (const op of this.ops.splice(0)) op(real);
    }

    /** @internal The host never came: report the spawn as failed. */
    fail(): void {
        if (this.failed || this.real !== undefined) return;
        this.failed = true;
        this.ops.length = 0;
        this.exitListener?.(-1, undefined);
    }

    private forward(op: (handle: PtyProcessHandle) => void): void {
        if (this.failed) return;
        if (this.real !== undefined) op(this.real);
        else this.ops.push(op);
    }
}

export class HostSpawnerSlot {
    private client: TerminalHostClient | undefined;
    private local: PtySpawner | undefined;
    private queued: PendingHostHandle[] = [];

    /** `fallbackFile` is the shell tried when the requested one fails to start. */
    constructor(private readonly fallbackFile: string) {}

    readonly spawner: PtySpawner = (request: PtySpawnRequest) => {
        const client = this.client;
        if (client !== undefined && !client.isClosed) return client.createSpawner(this.fallbackFile)(request);
        if (this.local !== undefined) return this.local(request);
        const pending = new PendingHostHandle(request);
        this.queued.push(pending);
        return pending;
    };

    /** Whether spawns currently go to in-process PTYs because no host could be started. */
    get degraded(): boolean {
        return this.local !== undefined;
    }

    /**
     * No host could be started: run PTYs in-process (today's behaviour, shells die with the
     * daemon) rather than lose every pane. Waiting spawns start locally.
     */
    useLocal(spawner: PtySpawner): void {
        this.client = undefined;
        this.local = spawner;
        for (const pending of this.queued.splice(0)) {
            if (pending.isFailed) continue;
            try {
                pending.bind(spawner(pending.request));
            } catch {
                pending.fail();
            }
        }
    }

    get current(): TerminalHostClient | undefined {
        return this.client;
    }

    /** Route spawns to `client`, starting every spawn that was waiting for it. */
    bind(client: TerminalHostClient): void {
        this.client = client;
        this.local = undefined;
        const spawn = client.createSpawner(this.fallbackFile);
        for (const pending of this.queued.splice(0)) {
            // A pane closed while its spawn waited must not get a shell nobody owns.
            if (!pending.isFailed) pending.bind(spawn(pending.request));
        }
    }

    /** No host for now (it was lost): spawns queue until the next `bind`. */
    unbind(): void {
        this.client = undefined;
    }

    /** No host is coming: every waiting spawn fails. */
    failPending(): void {
        for (const pending of this.queued.splice(0)) pending.fail();
    }
}

/** The host terminal behind a manager's handle, if it is one (unwrapping a bound pending handle). */
export function hostHandleOf(handle: PtyProcessHandle | undefined): HostPtyHandle | undefined {
    const inner = handle instanceof PendingHostHandle ? handle.bound : handle;
    return inner !== undefined && 'tid' in inner && 'received' in inner ? (inner as HostPtyHandle) : undefined;
}
