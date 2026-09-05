/**
 * PtyManager — one node-pty child per shell pane, owned by the daemon.
 *
 * Spec: docs/terminal-surface.md
 *   §1.2  registry semantics: idempotent create (first caller wins), explicit destroy
 *   §1.3  teardown hazard: SIGHUP → short grace → SIGKILL, never blocking, never
 *         serializing one stuck teardown behind another (the flaw the port must not keep)
 *   §2    spawn config: cwd, merged env (ordered overlay on the inherited env), shell
 *   §5    resize applies cols/rows to the PTY (one SIGWINCH; debouncing is the client's job)
 *   §8    sync input: per-workspace groups, wholesale replace, best-effort byte mirroring
 *
 * Byte mirroring (§8.2) is faithful to the Swift app's "translate once, replay to siblings"
 * rule: `write()` mirrors the exact bytes written to the source PTY into its siblings.
 * `writeDirect()` is the un-mirrored path used by programmatic sends (`pane send`,
 * `pane send-key`), replay, and resume typing — those target exactly one pane (§8.2).
 */

import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import type { PtyManager, PtySpawnOptions } from '../seams.js';
import { nodePtySpawner } from './spawner.js';
import type { PtyProcessHandle, PtySpawner } from './types.js';

/** Escalation delay between SIGHUP and SIGKILL (§1.3: "wait briefly"). */
export const DEFAULT_KILL_GRACE_MS = 300;

/** Upper bound on `killAll()` — it resolves even if a child never reaps. */
export const DEFAULT_KILL_ALL_TIMEOUT_MS = 2_000;

export const DEFAULT_TERM = 'xterm-256color';
export const FALLBACK_SHELL = '/bin/sh';
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export interface PtyManagerOptions {
    /** Injected for tests; defaults to the node-pty adapter. */
    readonly spawner?: PtySpawner | undefined;
    readonly killGraceMs?: number | undefined;
    readonly killAllTimeoutMs?: number | undefined;
    /** `$TERM` handed to children that don't carry one in their env overlay. */
    readonly term?: string | undefined;
    /** Overrides `os.homedir()` for the cwd fallback (tests). */
    readonly homeDir?: string | undefined;
    /** Overrides the real filesystem probe for the cwd fallback (tests). */
    readonly isDirectory?: ((path: string) => boolean) | undefined;
    /** Spawn failures are surfaced here (the pane still gets a synthetic exit event). */
    readonly onError?: ((paneID: string, error: unknown) => void) | undefined;
}

/** Widened seam: everything `PtyManager` promises plus read-only introspection. */
export interface KelpiPtyManager extends PtyManager {
    /** Live child pid, or undefined when the pane has no PTY. */
    pid(paneID: string): number | undefined;
    /** Number of live PTYs (terminal-surface.md §14 `activeSurfaceCount`). */
    count(): number;
    paneIDs(): string[];
    /** Group membership query backing the pane-header sync badge (§8.1). */
    isSyncing(paneID: string): boolean;
    /** Union of every group containing the source, minus the source itself (§8.1). */
    syncTargetIDs(sourcePaneID: string): Set<string>;
}

interface PtyEntry {
    readonly paneID: string;
    readonly proc: PtyProcessHandle;
    readonly pid: number;
    readonly exited: Promise<void>;
    settleExit: () => void;
    hasExited: boolean;
    escalation: NodeJS.Timeout | undefined;
}

function toBytes(data: Uint8Array | string): Uint8Array {
    return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

function isDirectoryOnDisk(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/**
 * §2.2: the pane's working directory is passed straight to the spawn — but a directory that
 * no longer exists makes the child die instantly (posix_spawn's chdir fails), so a missing
 * or non-directory cwd falls back to `$HOME`, then to `/` if even that is gone.
 */
/**
 * Which inherited daemon-env keys a pane may see — see `buildEnv`'s note. The class, not a
 * fixed list: every `CLAUDE_*` marker (session id, child flag, messaging socket, config dir,
 * pid, effort), the bare `CLAUDECODE` flag, and the `AI_AGENT` tag are all descriptions of
 * whatever Claude session happened to launch the daemon, and none of them describes a pane.
 */
export function inheritableEnvKey(key: string): boolean {
    return !(key.startsWith('CLAUDE_') || key === 'CLAUDECODE' || key === 'AI_AGENT');
}

export function resolveSpawnCwd(
    requested: string | undefined,
    options: { home?: string | undefined; isDirectory?: ((path: string) => boolean) | undefined } = {}
): string {
    const isDirectory = options.isDirectory ?? isDirectoryOnDisk;
    const trimmed = requested?.trim();
    if (trimmed !== undefined && trimmed !== '' && isDirectory(trimmed)) return trimmed;
    const home = options.home ?? process.env['HOME'] ?? homedir();
    if (home !== '' && isDirectory(home)) return home;
    return '/';
}

/**
 * `shell === undefined` means "the user's login shell" (§2.2). Resolution order mirrors what
 * libghostty does via passwd/$SHELL, ending at `/bin/sh` which always exists on POSIX.
 */
export function resolveShell(
    shell: string | undefined,
    env: Readonly<Record<string, string>>
): string {
    const explicit = shell?.trim();
    if (explicit !== undefined && explicit !== '') return explicit;
    const fromEnv = env['SHELL']?.trim();
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    return FALLBACK_SHELL;
}

class PtyManagerImpl implements KelpiPtyManager {
    private readonly entries = new Map<string, PtyEntry>();
    private readonly syncGroups = new Map<string, Set<string>>();
    private readonly dataListeners = new Set<(paneID: string, data: Uint8Array) => void>();
    private readonly exitListeners = new Set<(paneID: string, exitCode: number) => void>();
    private readonly spawner: PtySpawner;
    private readonly killGraceMs: number;
    private readonly killAllTimeoutMs: number;
    private readonly term: string;
    private readonly homeDir: string | undefined;
    private readonly isDirectory: ((path: string) => boolean) | undefined;
    private readonly onError: ((paneID: string, error: unknown) => void) | undefined;

    constructor(options: PtyManagerOptions = {}) {
        this.spawner = options.spawner ?? nodePtySpawner;
        this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
        this.killAllTimeoutMs = options.killAllTimeoutMs ?? DEFAULT_KILL_ALL_TIMEOUT_MS;
        this.term = options.term ?? DEFAULT_TERM;
        this.homeDir = options.homeDir;
        this.isDirectory = options.isDirectory;
        this.onError = options.onError;
    }

    // -- lifecycle ---------------------------------------------------------

    spawn(opts: PtySpawnOptions): void {
        // §1.2 duplicate-create guard: two racing creators exist by design; first wins and
        // the second must not replace the live PTY.
        if (this.entries.has(opts.paneID)) return;

        const { env, term } = this.buildEnv(opts.env);
        const cwd = resolveSpawnCwd(opts.cwd, {
            home: this.homeDir,
            isDirectory: this.isDirectory
        });
        const file = resolveShell(opts.shell, env);
        const cols = normalizeDimension(opts.cols, DEFAULT_COLS);
        const rows = normalizeDimension(opts.rows, DEFAULT_ROWS);
        // A hosted command (`$EDITOR <file>`, CONT-081) rides the same shell as `-c`, exactly
        // as libghostty runs `ghostty_surface_config_s.command`. Empty/whitespace is ignored so
        // a blank field can never turn an interactive pane into `sh -c ''` (an instant exit).
        const command = opts.command?.trim();
        const args = command === undefined || command === '' ? [] : ['-c', command];

        let proc: PtyProcessHandle;
        try {
            proc = this.spawner({ file, args, cwd, env, cols, rows, name: term });
        } catch (error) {
            // A broken $SHELL must not cost the user their pane: retry once on /bin/sh.
            if (file === FALLBACK_SHELL) {
                this.reportSpawnFailure(opts.paneID, error);
                return;
            }
            this.onError?.(opts.paneID, error);
            try {
                proc = this.spawner({
                    file: FALLBACK_SHELL,
                    args,
                    cwd,
                    env,
                    cols,
                    rows,
                    name: term
                });
            } catch (fallbackError) {
                this.reportSpawnFailure(opts.paneID, fallbackError);
                return;
            }
        }

        let settleExit: () => void = () => {};
        const exited = new Promise<void>((resolve) => {
            settleExit = resolve;
        });
        const entry: PtyEntry = {
            paneID: opts.paneID,
            proc,
            pid: proc.pid,
            exited,
            settleExit,
            hasExited: false,
            escalation: undefined
        };
        this.entries.set(opts.paneID, entry);

        proc.onData((data) => {
            this.emitData(opts.paneID, data);
        });
        proc.onExit((exitCode) => {
            this.handleExit(entry, exitCode);
        });
    }

    has(paneID: string): boolean {
        return this.entries.has(paneID);
    }

    pid(paneID: string): number | undefined {
        return this.entries.get(paneID)?.pid;
    }

    count(): number {
        return this.entries.size;
    }

    paneIDs(): string[] {
        return [...this.entries.keys()];
    }

    // -- input -------------------------------------------------------------

    write(paneID: string, data: Uint8Array | string): void {
        const bytes = toBytes(data);
        this.writeDirect(paneID, bytes);
        // §8.2: best-effort fan-out of the exact bytes; dead siblings are skipped silently.
        for (const target of this.syncTargetIDs(paneID)) {
            this.writeDirect(target, bytes);
        }
    }

    writeDirect(paneID: string, data: Uint8Array | string): void {
        const entry = this.entries.get(paneID);
        if (entry === undefined || entry.hasExited) return;
        try {
            entry.proc.write(toBytes(data));
        } catch (error) {
            this.onError?.(paneID, error);
        }
    }

    resize(paneID: string, cols: number, rows: number): void {
        const entry = this.entries.get(paneID);
        if (entry === undefined || entry.hasExited) return;
        // §15.4: never size a surface to zero — a transient zero layout must not reach the PTY.
        const safeCols = normalizeDimension(cols, 0);
        const safeRows = normalizeDimension(rows, 0);
        if (safeCols <= 0 || safeRows <= 0) return;
        try {
            entry.proc.resize(safeCols, safeRows);
        } catch (error) {
            this.onError?.(paneID, error);
        }
    }

    // -- teardown ----------------------------------------------------------

    /**
     * §1.3/§15.18: SIGHUP, then SIGKILL after a short grace if the child trapped it. The
     * pane leaves the registry immediately (so `has()` is false and a fresh spawn may reuse
     * the id) while the escalation runs on its own unref'd timer — no teardown ever blocks
     * or serializes behind another.
     */
    kill(paneID: string): void {
        const entry = this.entries.get(paneID);
        if (entry === undefined) return;
        this.entries.delete(paneID);
        if (entry.hasExited) return;

        try {
            entry.proc.kill('SIGHUP');
        } catch (error) {
            this.onError?.(paneID, error);
        }

        const escalation = setTimeout(() => {
            if (entry.hasExited) return;
            try {
                entry.proc.kill('SIGKILL');
            } catch (error) {
                this.onError?.(paneID, error);
            }
        }, this.killGraceMs);
        escalation.unref?.();
        entry.escalation = escalation;
    }

    /** Bounded: every child is signalled in one pass, then we wait at most one timeout. */
    async killAll(): Promise<void> {
        const pending = [...this.entries.values()];
        this.syncGroups.clear();
        for (const entry of pending) this.kill(entry.paneID);
        if (pending.length === 0) return;

        let timer: NodeJS.Timeout | undefined;
        const bound = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.killAllTimeoutMs);
            timer.unref?.();
        });
        try {
            await Promise.race([Promise.all(pending.map((entry) => entry.exited)), bound]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    // -- sync groups -------------------------------------------------------

    /** §8.1: wholesale replacement per workspace; an empty set removes the entry. */
    setSyncGroup(workspaceID: string, paneIDs: ReadonlySet<string>): void {
        if (paneIDs.size === 0) {
            this.syncGroups.delete(workspaceID);
            return;
        }
        this.syncGroups.set(workspaceID, new Set(paneIDs));
    }

    isSyncing(paneID: string): boolean {
        for (const group of this.syncGroups.values()) {
            if (group.has(paneID)) return true;
        }
        return false;
    }

    syncTargetIDs(sourcePaneID: string): Set<string> {
        const targets = new Set<string>();
        for (const group of this.syncGroups.values()) {
            if (!group.has(sourcePaneID)) continue;
            for (const member of group) {
                if (member !== sourcePaneID) targets.add(member);
            }
        }
        return targets;
    }

    // -- events ------------------------------------------------------------

    onData(cb: (paneID: string, data: Uint8Array) => void): () => void {
        this.dataListeners.add(cb);
        return () => {
            this.dataListeners.delete(cb);
        };
    }

    onExit(cb: (paneID: string, exitCode: number) => void): () => void {
        this.exitListeners.add(cb);
        return () => {
            this.exitListeners.delete(cb);
        };
    }

    // -- internals ---------------------------------------------------------

    /**
     * Inherited process env, overlaid with the caller's ordered pairs (§2.1).
     *
     * `TERM` is deliberately NOT inherited: the daemon's own `$TERM` describes whatever
     * terminal happened to launch it, while the pane's terminal is the client renderer.
     * Only an explicit caller override wins over the configured default.
     *
     * Claude-session markers are not inherited either (`inheritableEnvKey`): a daemon that
     * was launched from inside a Claude Code session — a self-upgrade restarter descends
     * from the promoting session's shell, and macOS `open` propagates the caller's env —
     * carries that session's `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
     * messaging socket and config dir. A pane is a fresh terminal; leaking those into it
     * made every post-promote `claude --resume` think it was a CHILD of a session that no
     * longer exists and lose the conversation it was resuming (measured, 2026-09-01). A
     * profile that deliberately sets `CLAUDE_CONFIG_DIR` still lands: profile vars ride the
     * caller's overlay pairs, which apply after this filter.
     */
    private buildEnv(pairs: ReadonlyArray<readonly [string, string]>): {
        env: Record<string, string>;
        term: string;
    } {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined && inheritableEnvKey(key)) env[key] = value;
        }
        let term = this.term;
        for (const [key, value] of pairs) {
            env[key] = value;
            if (key === 'TERM') term = value;
        }
        env['TERM'] = term;
        env['COLORTERM'] = env['COLORTERM'] ?? 'truecolor';
        return { env, term };
    }

    private handleExit(entry: PtyEntry, exitCode: number): void {
        if (entry.hasExited) return;
        entry.hasExited = true;
        if (entry.escalation !== undefined) {
            clearTimeout(entry.escalation);
            entry.escalation = undefined;
        }
        entry.settleExit();
        const current = this.entries.get(entry.paneID);
        if (current === entry) this.entries.delete(entry.paneID);
        // A pane killed and then re-spawned before its old child reaped must not report the
        // stale exit — that would tear down the fresh PTY.
        if (current !== undefined && current !== entry) return;
        this.emitExit(entry.paneID, exitCode);
    }

    private reportSpawnFailure(paneID: string, error: unknown): void {
        this.onError?.(paneID, error);
        // The pane exists in the store but has no child: report it as an exit so the caller
        // runs its normal process-exited path (§7.3) instead of waiting forever.
        setImmediate(() => {
            this.emitExit(paneID, -1);
        });
    }

    private emitData(paneID: string, data: Uint8Array): void {
        for (const listener of [...this.dataListeners]) {
            try {
                listener(paneID, data);
            } catch (error) {
                this.onError?.(paneID, error);
            }
        }
    }

    private emitExit(paneID: string, exitCode: number): void {
        for (const listener of [...this.exitListeners]) {
            try {
                listener(paneID, exitCode);
            } catch (error) {
                this.onError?.(paneID, error);
            }
        }
    }
}

function normalizeDimension(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    const floored = Math.floor(value);
    return floored > 0 ? floored : fallback;
}

export function createPtyManager(options: PtyManagerOptions = {}): KelpiPtyManager {
    return new PtyManagerImpl(options);
}
