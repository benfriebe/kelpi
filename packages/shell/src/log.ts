/**
 * Main-process logging.
 *
 * One prefix, two sinks: `[shell] …` on stdout so `electron .` in a terminal, a packaged app's
 * `Console.app` output and `scripts/smoke.mjs` all read the same lines, and (issue #77) the same
 * bytes appended to a bounded file under the app's own state directory, because a packaged app
 * launched from the Dock has no stdout anybody will ever read. `log()`, `warn()` and `logError()`
 * stay the only entry points: nothing else in the shell knows the file exists. The
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

import { createFileSink, shellLogFile, type FileSink, type FileSinkOptions } from './log-file.js';

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

let file: FileSink | null = null;

/**
 * Start appending every line to `<userDataDir>/logs/shell.log` as well as to stdout (#77).
 *
 * Called once, as early in the launch as the process has a user-data directory, and returns the
 * path so the caller can put it on stdout for whoever IS reading stdout. A sink that cannot be
 * opened comes back dead rather than throwing, and this returns null: no directory, no file,
 * same shell.
 *
 * Idempotent by replacement: a second call closes the first sink, which is what makes it safe
 * for tests to install one per case.
 */
export function startLogFile(userDataDir: string, options: FileSinkOptions = {}): string | null {
    stopLogFile();
    const sink = createFileSink(shellLogFile(userDataDir), options);
    if (!sink.live) return null;
    file = sink;
    return sink.file;
}

/** Close the file sink; `log()` and friends keep working on stdout. */
export function stopLogFile(): void {
    file?.close();
    file = null;
}

/** The live file's path, or null when there is no sink (diagnostics, and the tests). */
export function logFilePath(): string | null {
    return file === null || !file.live ? null : file.file;
}

function write(stream: LogStream, chunk: string): void {
    try {
        stream.write(chunk);
    } catch {
        // Dead pipe (EPIPE/EBADF): the log goes quiet, the app stays up.
    }
    // Second, and never in a way that can disturb the first: the sink swallows its own
    // failures, so a full disk costs the file and not the line on stdout.
    file?.write(chunk);
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
