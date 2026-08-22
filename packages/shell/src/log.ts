/**
 * Main-process logging.
 *
 * One prefix, one stream, no dependency: `[shell] …` on stdout so `electron .` in a terminal,
 * a packaged app's `Console.app` output and `scripts/smoke.mjs` all read the same lines. The
 * smoke asserts on these strings, so treat them as a (loose) contract: keep the existing
 * prefixes stable and add new lines rather than rewording old ones.
 *
 * Writes never throw. When the shell is launched by another process (the audit harness, a
 * terminal that closed, a probe script that crashed), stdout/stderr are pipes whose reader can
 * die before the shell does — from then on every `write` raises EPIPE, and an uncaught EPIPE
 * in the main process puts an "Uncaught Exception" dialog over a perfectly healthy window.
 * Logging is best-effort by definition: a dead log pipe silences the log, it does not crash
 * the app. Both the synchronous throw and the async 'error' event are swallowed (Node reports
 * EPIPE either way depending on timing).
 */

export type LogStream = { write(chunk: string): unknown };

for (const stream of [process.stdout, process.stderr]) {
    // A stream with no 'error' listener turns EPIPE into an uncaught exception.
    stream.on('error', () => {});
}

let out: LogStream = process.stdout;
let err: LogStream = process.stderr;

/** Tests/hosts can capture the log without monkey-patching `process`. */
export function setLogStreams(streams: { out?: LogStream; err?: LogStream }): void {
    if (streams.out !== undefined) out = streams.out;
    if (streams.err !== undefined) err = streams.err;
}

function write(stream: LogStream, chunk: string): void {
    try {
        stream.write(chunk);
    } catch {
        // Dead pipe (EPIPE/EBADF): the log goes quiet, the app stays up.
    }
}

export function log(message: string): void {
    write(out, `[shell] ${message}\n`);
}

export function warn(message: string): void {
    write(err, `[shell] warning: ${message}\n`);
}

export function logError(message: string, error?: unknown): void {
    const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
    write(err, `[shell] error: ${message}${detail}\n`);
}
