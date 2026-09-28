/**
 * Where a daemon launches the terminal host from (`docs/terminal-host.md` §9).
 *
 * The host outlives the daemon, and so it outlives app updates: Squirrel replaces `Kelpi.app`
 * while a host launched from inside it is still running. The running process keeps its loaded
 * code, but it execs node-pty's `spawn-helper` for every new terminal, by path, and that path
 * would now point into a different (or half-written) bundle. So a packaged daemon copies the
 * host's runtime (its bundle, the ESM scope file and node-pty) into a directory named by the
 * content hash under the data root, and launches it from there. A development daemon launches
 * in place.
 *
 * The Node binary is not copied: it is only executed once, at launch, and a running process
 * keeps its mapped image when the file is replaced.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isProcessAlive } from '../lifecycle/rundir.js';

export const HOST_BUNDLE_NAME = 'terminal-host.js';
/** Copies kept besides the current one and the one a live host is running from. */
export const KEEP_RUNTIME_COPIES = 3;

const COPY_NAME = /^[0-9a-f]{16}$/;
const LEASE_NAME = /^\.lease-(\d+)$/;

export interface HostRuntime {
    /** The entry to launch. */
    readonly entry: string;
    readonly runtimeDir: string;
    /** True when the runtime was copied out of an app bundle. */
    readonly copied: boolean;
}

export interface PrepareHostRuntimeOptions {
    /** The directory the daemon's own bundle is in; the host bundle sits beside it. */
    readonly daemonDir: string;
    /** Where per-version copies live (`<data root>/<hash>/`). */
    readonly dataRoot: string;
    /** The runtime directory a live host is using, which pruning must keep (leases cover others). */
    readonly inUse?: string | undefined;
}

/** True for a daemon running from inside an app bundle's Resources. */
export function isPackagedDir(dir: string): boolean {
    return /\.app\/Contents\/Resources(\/|$)/.test(dir.split(path.sep).join('/'));
}

/** The host runtime for this daemon, copied out of the app bundle when packaged. */
export function prepareHostRuntime(options: PrepareHostRuntimeOptions): HostRuntime {
    const entry = path.join(options.daemonDir, HOST_BUNDLE_NAME);
    if (!fs.existsSync(entry)) throw new Error(`no terminal host bundle at ${entry}`);
    if (!isPackagedDir(options.daemonDir)) return { entry, runtimeDir: options.daemonDir, copied: false };

    const sources = runtimeSources(options.daemonDir);
    const target = path.join(options.dataRoot, contentHash(options.daemonDir, sources));
    if (!fs.existsSync(path.join(target, HOST_BUNDLE_NAME))) {
        fs.mkdirSync(options.dataRoot, { recursive: true, mode: 0o700 });
        const staging = `${target}.tmp-${process.pid}`;
        fs.rmSync(staging, { recursive: true, force: true });
        for (const source of sources) {
            fs.cpSync(path.join(options.daemonDir, source), path.join(staging, source), {
                recursive: true,
                dereference: true
            });
        }
        restoreExecBits(staging);
        stripQuarantine(staging);
        try {
            fs.renameSync(staging, target);
        } catch (error) {
            // Another daemon won the race to the same content; theirs is identical.
            fs.rmSync(staging, { recursive: true, force: true });
            if (!fs.existsSync(path.join(target, HOST_BUNDLE_NAME))) throw error;
        }
    }
    pruneRuntimeCopies(options.dataRoot, [target, options.inUse]);
    return { entry: path.join(target, HOST_BUNDLE_NAME), runtimeDir: target, copied: true };
}

/**
 * node-pty ships `spawn-helper` without its execute bit on some installs
 * (`scripts/node-pty-exec-bit.mjs`); a copy must have it or every spawn fails with
 * `posix_spawnp failed`.
 */
function restoreExecBits(dir: string): void {
    const visit = (current: string): void => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (entry.name === 'spawn-helper') fs.chmodSync(full, 0o755);
        }
    };
    visit(dir);
}

/** A copy of a downloaded app's files may carry its quarantine flag; the host's must not. */
function stripQuarantine(dir: string): void {
    if (process.platform !== 'darwin') return;
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', dir], { stdio: 'ignore' });
}

/**
 * A running host marks the copy it runs from, so pruning never deletes a runtime from under a
 * live host (another run dir's included). Returns the lease file, removed by `releaseRuntime`.
 */
export function leaseRuntime(runtimeDir: string, pid: number = process.pid): string | undefined {
    const lease = path.join(runtimeDir, `.lease-${pid}`);
    try {
        fs.writeFileSync(lease, `${new Date().toISOString()}\n`, { mode: 0o600 });
        return lease;
    } catch {
        return undefined;
    }
}

export function releaseRuntime(lease: string | undefined): void {
    if (lease === undefined) return;
    try {
        fs.unlinkSync(lease);
    } catch {
        // already gone
    }
}

function isLeased(dir: string): boolean {
    try {
        return fs.readdirSync(dir).some((name) => {
            const match = LEASE_NAME.exec(name);
            return match !== null && isProcessAlive(Number(match[1]));
        });
    } catch {
        return false;
    }
}

/** What the host needs at run time, relative to the daemon directory. */
function runtimeSources(daemonDir: string): string[] {
    return [HOST_BUNDLE_NAME, 'package.json', path.join('node_modules', 'node-pty')].filter((source) =>
        fs.existsSync(path.join(daemonDir, source))
    );
}

function contentHash(root: string, sources: readonly string[]): string {
    const hash = createHash('sha256');
    const visit = (relative: string): void => {
        const full = path.join(root, relative);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
        } else {
            hash.update(relative);
            hash.update(fs.readFileSync(full));
        }
    };
    for (const source of sources) visit(source);
    return hash.digest('hex').slice(0, 16);
}

/** Delete old copies, keeping `keep`, any a live host holds a lease on, and the newest few. Never throws. */
export function pruneRuntimeCopies(dataRoot: string, keep: readonly (string | undefined)[]): void {
    try {
        const kept = new Set(keep.filter((dir): dir is string => dir !== undefined).map((dir) => path.resolve(dir)));
        const copies = fs
            .readdirSync(dataRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && COPY_NAME.test(entry.name))
            .map((entry) => {
                const dir = path.join(dataRoot, entry.name);
                return { dir, mtime: fs.statSync(dir).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
        let spare = KEEP_RUNTIME_COPIES;
        for (const copy of copies) {
            if (kept.has(path.resolve(copy.dir)) || isLeased(copy.dir)) continue;
            if (spare > 0) {
                spare -= 1;
                continue;
            }
            fs.rmSync(copy.dir, { recursive: true, force: true });
        }
    } catch {
        // Pruning is housekeeping; a failure costs disk, not the daemon.
    }
}
