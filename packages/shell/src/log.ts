/**
 * Main-process logging.
 *
 * One prefix, one stream, no dependency: `[shell] …` on stdout so `electron .` in a terminal,
 * a packaged app's `Console.app` output and `scripts/smoke.mjs` all read the same lines. The
 * smoke asserts on these strings, so treat them as a (loose) contract: keep the existing
 * prefixes stable and add new lines rather than rewording old ones.
 */

export type LogStream = { write(chunk: string): unknown };

let out: LogStream = process.stdout;
let err: LogStream = process.stderr;

/** Tests/hosts can capture the log without monkey-patching `process`. */
export function setLogStreams(streams: { out?: LogStream; err?: LogStream }): void {
    if (streams.out !== undefined) out = streams.out;
    if (streams.err !== undefined) err = streams.err;
}

export function log(message: string): void {
    out.write(`[shell] ${message}\n`);
}

export function warn(message: string): void {
    err.write(`[shell] warning: ${message}\n`);
}

export function logError(message: string, error?: unknown): void {
    const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`;
    err.write(`[shell] error: ${message}${detail}\n`);
}
