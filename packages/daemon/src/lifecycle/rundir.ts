/**
 * The daemon run directory (ARCHITECTURE.md "Daemon lifecycle").
 *
 * Everything a client needs to find and authenticate a running daemon lives in one
 * per-user directory, and every entry in it is **protocol-versioned**:
 *
 *   <run dir>/daemon-v<PROTOCOL_VERSION>.sock    control/discovery socket
 *   <run dir>/daemon-v<PROTOCOL_VERSION>.token   0600 shared secret for local WS clients
 *   <run dir>/daemon-v<PROTOCOL_VERSION>.pid     JSON record: pid, start time, ports
 *
 * A protocol bump therefore spawns a *new* daemon side by side with the old one; nothing is
 * ever killed by an update. The directory is 0700 and every file 0600 — the trust model is
 * "same UID on the same box".
 *
 * Locations: `KELPID_RUN_DIR` wins everywhere; otherwise
 *   darwin → ~/Library/Application Support/nexd/run
 *   linux  → $XDG_RUNTIME_DIR/nexd, else ~/.local/state/kelpid/run
 *
 * Note this is NOT `/tmp/kelpi.sock`: that path stays the CLI-compat control socket (PLAN
 * decisions) and is configured separately (`control/endpoints.ts`).
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION } from '@kelpi/protocol';

export const RUN_DIR_ENV = 'KELPID_RUN_DIR';
export const RUN_DIR_MODE = 0o700;
export const RUN_FILE_MODE = 0o600;

/** Expand a leading `~` (alone or as `~/…`) against `home`. */
export function expandTilde(value: string, home: string = homedir()): string {
    if (value === '~') return home;
    if (value.startsWith('~/')) return path.join(home, value.slice(2));
    return value;
}

export interface RunDirLookup {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    readonly home?: string | undefined;
}

/** Absolute run directory for this platform / environment. Does not create it. */
export function resolveRunDir(lookup: RunDirLookup = {}): string {
    const env = lookup.env ?? process.env;
    const platform = lookup.platform ?? process.platform;
    const home = lookup.home ?? homedir();

    const override = env[RUN_DIR_ENV]?.trim();
    if (override !== undefined && override.length > 0) return path.resolve(expandTilde(override, home));

    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'kelpid', 'run');

    const xdg = env['XDG_RUNTIME_DIR']?.trim();
    if (xdg !== undefined && xdg.length > 0) return path.join(path.resolve(expandTilde(xdg, home)), 'kelpid');

    return path.join(home, '.local', 'state', 'kelpid', 'run');
}

export interface RunPaths {
    readonly dir: string;
    readonly protocol: number;
    readonly socket: string;
    readonly token: string;
    readonly pid: string;
}

export interface RunPathsOptions extends RunDirLookup {
    /** Use this directory verbatim instead of resolving one. */
    readonly dir?: string | undefined;
    /** Defaults to the compiled-in `PROTOCOL_VERSION`. */
    readonly protocol?: number | undefined;
}

/** The versioned `daemon-v<N>.{sock,token,pid}` triple inside the run directory. */
export function resolveRunPaths(options: RunPathsOptions = {}): RunPaths {
    const dir = options.dir !== undefined ? path.resolve(expandTilde(options.dir, options.home ?? homedir())) : resolveRunDir(options);
    const protocol = options.protocol ?? PROTOCOL_VERSION;
    const stem = path.join(dir, `daemon-v${protocol}`);
    return {
        dir,
        protocol,
        socket: `${stem}.sock`,
        token: `${stem}.token`,
        pid: `${stem}.pid`
    };
}

/** Create the run directory if needed and force 0700 on it. */
export function ensureRunDir(paths: RunPaths): void {
    fs.mkdirSync(paths.dir, { recursive: true, mode: RUN_DIR_MODE });
    // mkdir's mode is umask-masked; be explicit.
    fs.chmodSync(paths.dir, RUN_DIR_MODE);
}

function writeRunFile(paths: RunPaths, file: string, contents: string): void {
    ensureRunDir(paths);
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, contents, { mode: RUN_FILE_MODE });
    fs.chmodSync(temporary, RUN_FILE_MODE);
    fs.renameSync(temporary, file);
}

// ── token ───────────────────────────────────────────────────────────────────────────

/** 64 hex chars of CSPRNG output by default. */
export function generateToken(bytes = 32): string {
    return randomBytes(bytes).toString('hex');
}

export function readToken(paths: RunPaths): string | undefined {
    try {
        const token = fs.readFileSync(paths.token, 'utf8').trim();
        return token.length > 0 ? token : undefined;
    } catch {
        return undefined;
    }
}

export function writeToken(paths: RunPaths, token: string): string {
    writeRunFile(paths, paths.token, `${token}\n`);
    return token;
}

/** Read the existing token, or mint and persist one. Stable across daemon restarts. */
export function ensureToken(paths: RunPaths): string {
    return readToken(paths) ?? writeToken(paths, generateToken());
}

// ── pid record ──────────────────────────────────────────────────────────────────────

export interface PidRecord {
    readonly pid: number;
    readonly protocol: number;
    /** ISO 8601 UTC. */
    readonly started_at: string;
    /** The daemon's control socket (the run-dir one, not `/tmp/kelpi.sock`). */
    readonly socket?: string | undefined;
    /** HTTP/WS listener port, once bound. */
    readonly http_port?: number | undefined;
    readonly version?: string | undefined;
}

export interface PidRecordInput {
    readonly pid?: number | undefined;
    readonly protocol?: number | undefined;
    readonly started_at?: string | undefined;
    readonly socket?: string | undefined;
    readonly http_port?: number | undefined;
    readonly version?: string | undefined;
}

export function writePidRecord(paths: RunPaths, input: PidRecordInput = {}): PidRecord {
    const record: PidRecord = {
        pid: input.pid ?? process.pid,
        protocol: input.protocol ?? paths.protocol,
        started_at: input.started_at ?? new Date().toISOString(),
        ...(input.socket !== undefined ? { socket: input.socket } : { socket: paths.socket }),
        ...(input.http_port !== undefined ? { http_port: input.http_port } : {}),
        ...(input.version !== undefined ? { version: input.version } : {})
    };
    writeRunFile(paths, paths.pid, `${JSON.stringify(record)}\n`);
    return record;
}

/** Parse the pid record; a missing/corrupt file reads as "no record" (never throws). */
export function readPidRecord(paths: RunPaths): PidRecord | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(paths.pid, 'utf8');
    } catch {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const source = parsed as Record<string, unknown>;
    const pid = source['pid'];
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
    const protocol = source['protocol'];
    const startedAt = source['started_at'];
    const socket = source['socket'];
    const httpPort = source['http_port'];
    const version = source['version'];
    return {
        pid,
        protocol: typeof protocol === 'number' ? protocol : paths.protocol,
        started_at: typeof startedAt === 'string' ? startedAt : '',
        ...(typeof socket === 'string' ? { socket } : {}),
        ...(typeof httpPort === 'number' ? { http_port: httpPort } : {}),
        ...(typeof version === 'string' ? { version } : {})
    };
}

/** `kill(pid, 0)`: EPERM means alive but owned by someone else. */
export function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** True when there is no record, or the process it names is gone. */
export function isPidRecordStale(record: PidRecord | undefined): boolean {
    if (record === undefined) return true;
    return !isProcessAlive(record.pid);
}

export interface ClearRunFilesOptions {
    /** Also unlink the socket file (only when this process bound it). */
    readonly socket?: boolean | undefined;
    /** Also unlink the token (normally kept so it stays stable across restarts). */
    readonly token?: boolean | undefined;
}

/** Clean-shutdown tidy-up: drop the pid record (and optionally the socket/token). */
export function clearRunFiles(paths: RunPaths, options: ClearRunFilesOptions = {}): void {
    const targets = [paths.pid];
    if (options.socket === true) targets.push(paths.socket);
    if (options.token === true) targets.push(paths.token);
    for (const target of targets) {
        try {
            fs.unlinkSync(target);
        } catch {
            // best effort: a missing file is the desired end state
        }
    }
}
