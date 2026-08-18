/**
 * The narrow process seam the PTY manager talks to.
 *
 * `manager.ts` never touches node-pty directly: it drives `PtyProcessHandle`, and the
 * default spawner (`nodePtySpawner`) adapts node-pty onto it. That keeps the sync-group
 * mirroring, kill-escalation, and registry logic testable with a stub transport while the
 * real integration tests spawn real shells through the same code path.
 *
 * Spec: docs/current/terminal-surface.md §1.2 (registry), §2 (spawn config), §8 (sync).
 */

/** One live pseudoterminal. Listener registration is single-consumer (the manager). */
export interface PtyProcessHandle {
    readonly pid: number;
    write(data: string | Uint8Array): void;
    resize(cols: number, rows: number): void;
    /** Best-effort signal delivery; must never throw (a dead child is not an error). */
    kill(signal?: string): void;
    onData(listener: (data: Uint8Array) => void): void;
    onExit(listener: (exitCode: number, signal: number | undefined) => void): void;
}

/** Fully-resolved spawn request: cwd already fallback-checked, env already merged. */
export interface PtySpawnRequest {
    readonly file: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly cols: number;
    readonly rows: number;
    /** `$TERM` for the child. */
    readonly name: string;
}

/** Throws on spawn failure; the manager catches and reports it. */
export type PtySpawner = (request: PtySpawnRequest) => PtyProcessHandle;
