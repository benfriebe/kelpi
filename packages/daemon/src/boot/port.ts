/**
 * The HTTP/WS port file in the run directory.
 *
 * The run dir already carries the protocol-versioned `.sock` / `.token` / `.pid` triple
 * (`lifecycle/rundir.ts`); the WS listener adds `daemon-v<PROTO>.port`, holding the decimal
 * port and nothing else. Two reasons it is a file of its own rather than only a field of the
 * `.pid` record:
 *
 *  - a client (or `tailscale serve` config, or a shell one-liner) can `cat` it without
 *    parsing JSON, and it is the discovery half of the token file it sits next to;
 *  - the daemon REUSES it on the next boot, so a browser tab left open on
 *    `http://127.0.0.1:<port>` keeps working across restarts. The port is a preference, not a
 *    promise: if the bind fails the caller falls back to an ephemeral port and rewrites it.
 *
 * Mode 0600 like every other run-dir file, and every read is failure-tolerant: a missing,
 * empty or garbage file simply means "no preference".
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensureRunDir, RUN_FILE_MODE, type RunPaths } from '../lifecycle/rundir.js';

/** `<run dir>/daemon-v<PROTO>.port`. */
export function portFilePath(paths: RunPaths): string {
    return path.join(paths.dir, `daemon-v${String(paths.protocol)}.port`);
}

function parsePort(raw: string): number | undefined {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return undefined;
    const port = Number.parseInt(trimmed, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/** The previously bound port, when one was recorded and still looks like a port. */
export function readPortFile(paths: RunPaths): number | undefined {
    try {
        return parsePort(fs.readFileSync(portFilePath(paths), 'utf8'));
    } catch {
        return undefined;
    }
}

/** Record the port the listener actually bound. Best effort: never throws. */
export function writePortFile(paths: RunPaths, port: number): void {
    const target = portFilePath(paths);
    try {
        ensureRunDir(paths);
        const temporary = `${target}.tmp-${String(process.pid)}`;
        fs.writeFileSync(temporary, `${String(port)}\n`, { mode: RUN_FILE_MODE });
        fs.chmodSync(temporary, RUN_FILE_MODE);
        fs.renameSync(temporary, target);
    } catch {
        // A read-only run dir costs discovery, not the daemon.
    }
}

/** Clean-shutdown tidy-up (the port is only meaningful while a daemon is listening). */
export function clearPortFile(paths: RunPaths): void {
    try {
        fs.unlinkSync(portFilePath(paths));
    } catch {
        // Missing file is the desired end state.
    }
}
