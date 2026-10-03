/**
 * Opening a csv file safely (#324, docs/csv-pane.md).
 *
 *   - `O_RDONLY | O_NONBLOCK`: opening a FIFO never blocks the daemon waiting for a writer, and
 *     the `fstat` that follows refuses anything that is not a regular file (FIFOs, devices,
 *     directories) before a byte is read;
 *   - the realpath is resolved once and kept: saves rename a temp file over the REAL file, so a
 *     symlinked csv stays a symlink (the same rule as `editor.ts` `writeFileAtomic`);
 *   - `(dev, ino, size, mtimeMs)` are recorded at open; the scan stops at that size and every
 *     later check compares against them;
 *   - orphaned temp files a crashed daemon left beside the file (`.<base>.kelpi-<pid>-<n>.tmp`
 *     with a dead pid) are swept.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface FileIdentity {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly mode: number;
}

export interface OpenedCsvFile {
    readonly fd: number;
    readonly realpath: string;
    readonly identity: FileIdentity;
}

export class CsvNotRegularError extends Error {
    constructor(filePath: string, what: string) {
        super(`${filePath} is ${what}, not a regular file.`);
        this.name = 'CsvNotRegularError';
    }
}

export function identityOf(stat: fs.Stats): FileIdentity {
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode };
}

function describe(stat: fs.Stats): string {
    if (stat.isDirectory()) return 'a directory';
    if (stat.isFIFO()) return 'a named pipe';
    if (stat.isSocket()) return 'a socket';
    if (stat.isCharacterDevice() || stat.isBlockDevice()) return 'a device';
    return 'not a regular file';
}

const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

function checkRegular(fd: number, realpath: string): FileIdentity {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
        fs.closeSync(fd);
        throw new CsvNotRegularError(realpath, describe(stat));
    }
    return identityOf(stat);
}

/** Open an already-resolved real path (after a save's rename, or a reload). */
export function openRealpathSync(realpath: string): OpenedCsvFile {
    const fd = fs.openSync(realpath, OPEN_FLAGS);
    return { fd, realpath, identity: checkRegular(fd, realpath) };
}

export async function openCsvFile(filePath: string): Promise<OpenedCsvFile> {
    const realpath = await fs.promises.realpath(filePath);
    const fd = await new Promise<number>((resolve, reject) => {
        fs.open(realpath, OPEN_FLAGS, (error, opened) => {
            if (error) reject(error);
            else resolve(opened);
        });
    });
    return { fd, realpath, identity: checkRegular(fd, realpath) };
}

export function closeQuietly(fd: number | null): void {
    if (fd === null) return;
    try {
        fs.closeSync(fd);
    } catch {
        // Already closed.
    }
}

let tempCounter = 1_000_000;

/** `.<base>.kelpi-<pid>-<n>.tmp` beside the real file (the `writeFileAtomic` convention). */
export function tempPathFor(realpath: string): string {
    tempCounter += 1;
    return path.join(path.dirname(realpath), `.${path.basename(realpath)}.kelpi-${String(process.pid)}-${String(tempCounter)}.tmp`);
}

export function processAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove `.<base>.kelpi-<pid>-<n>.tmp` siblings whose pid is gone. Returns what was removed. */
export function sweepOrphanTemps(realpath: string, alive: (pid: number) => boolean = processAlive): string[] {
    const directory = path.dirname(realpath);
    const pattern = new RegExp(`^\\.${escapeRegExp(path.basename(realpath))}\\.kelpi-(\\d+)-\\d+\\.tmp$`);
    const removed: string[] = [];
    let names: string[];
    try {
        names = fs.readdirSync(directory);
    } catch {
        return removed;
    }
    for (const name of names) {
        const match = pattern.exec(name);
        if (match === null) continue;
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid === process.pid || alive(pid)) continue;
        const target = path.join(directory, name);
        try {
            if (!fs.lstatSync(target).isFile()) continue;
            fs.rmSync(target, { force: true });
            removed.push(target);
        } catch {
            // Someone else got there first, or it is not ours to remove.
        }
    }
    return removed;
}

/** The message a pane shows when its file cannot be opened. */
export function openFailureMessage(filePath: string, error: unknown): string {
    if (error instanceof CsvNotRegularError) return error.message;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return `${filePath} does not exist.`;
    if (code === 'EACCES' || code === 'EPERM') return `${filePath} can't be read (permission denied).`;
    return error instanceof Error ? error.message : String(error);
}
