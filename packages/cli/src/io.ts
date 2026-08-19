/**
 * Process exit + stdout/stderr discipline (cli.md §6.6, port note 10).
 *
 * Two rules the whole CLI is built on:
 *
 *  1. **Nothing advisory may reach stdout.** Acks and data go to stdout (scripts pipe
 *     `pane capture` and `web capture --mode screenshot | base64 -D`); usage errors,
 *     `Repair:` lines, `(next_since=…)`, `(dropped …)` and the follow banner go to stderr.
 *  2. **`exit(n)` is a throw, never `process.exit(n)`.** On macOS a piped stdout is an async
 *     stream, so `process.exit` can truncate the very output a test or a shell pipeline is
 *     reading. `ExitError` unwinds to `main`, which sets `process.exitCode` and lets Node
 *     flush on its own. Every socket is destroyed on the way out so the loop drains promptly.
 *
 * `setIO` exists so renderers can be unit-tested without spawning a process; production keeps
 * the default sinks.
 */

export class ExitError extends Error {
    readonly code: number;

    constructor(code: number) {
        super(`exit ${String(code)}`);
        this.name = 'ExitError';
        this.code = code;
    }
}

/** Unwind to `main` with this exit code. Never returns. */
export function exit(code: number): never {
    throw new ExitError(code);
}

export interface IO {
    out(text: string): void;
    err(text: string): void;
}

const defaultIO: IO = {
    out: (text) => {
        process.stdout.write(text);
    },
    err: (text) => {
        process.stderr.write(text);
    }
};

let io: IO = defaultIO;

export function setIO(next: IO): void {
    io = next;
}

export function resetIO(): void {
    io = defaultIO;
}

/** `print(...)` — one line to stdout. */
export function printLine(text = ''): void {
    io.out(`${text}\n`);
}

/** Raw stdout bytes, no newline added (`pane capture`). */
export function writeOut(text: string): void {
    io.out(text);
}

/** One line to stderr. */
export function errLine(text: string): void {
    io.err(`${text}\n`);
}

/** A pre-formatted stderr block (usage blocks already carry their newlines). */
export function writeErr(text: string): void {
    io.err(text);
}
