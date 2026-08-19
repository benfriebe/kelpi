/**
 * The four argument-parsing primitives (cli.md §7), bug-for-bug.
 *
 * There is no argv framework in the Swift CLI and a rewrite must not introduce one: the
 * primitives interact, and the order in which a subcommand consumes them is observable.
 * Specifically:
 *
 *   - a flag may appear ANYWHERE in argv, before or after positionals;
 *   - a flag's value is the next token **even when it starts with `-`**, so
 *     `--name --json` sets the name to the literal `--json`;
 *   - a flag in FINAL position has no value: it returns null and is LEFT in argv, where the
 *     leftover check rejects it as an unknown option;
 *   - `--` tails exist only for `web click|type|select`;
 *   - `rejectLeftoverArgs` is what makes `nex pane capture <uuid>` fail loudly instead of
 *     silently capturing the caller (issue #237).
 *
 * All helpers mutate the argv array in place, exactly like the Swift `inout ArraySlice`.
 */

import { errLine, exit, writeErr } from './io.js';

export type UsagePrinter = (write: (text: string) => void) => void;

/** First occurrence of `name` + the token after it, both removed. See the module note. */
export function parseFlag(name: string, args: string[]): string | null {
    const index = args.indexOf(name);
    if (index < 0) return null;
    if (index + 1 >= args.length) return null; // flag with no value: LEFT in args on purpose
    const value = args[index + 1] as string;
    args.splice(index, 2);
    return value;
}

/** Repeatable flags (`--add a --add b`): drain `parseFlag` until it runs dry. */
export function parseFlagAll(name: string, args: string[]): string[] {
    const values: string[] = [];
    for (;;) {
        const value = parseFlag(name, args);
        if (value === null) break;
        values.push(value);
    }
    return values;
}

/** Presence-only boolean; consumes no value. */
export function popSwitch(name: string, args: string[]): boolean {
    const index = args.indexOf(name);
    if (index < 0) return false;
    args.splice(index, 1);
    return true;
}

/**
 * `--grow` / `--shrink`: null when absent; when present, eats the next token only if it
 * parses as a float, else keeps it and uses `fallback`.
 */
export function parseOptionalAmountFlag(name: string, fallback: number, args: string[]): number | null {
    const index = args.indexOf(name);
    if (index < 0) return null;
    let amount = fallback;
    const next = args[index + 1];
    if (next !== undefined) {
        const parsed = parseDouble(next);
        if (parsed !== null) {
            amount = parsed;
            args.splice(index + 1, 1);
        }
    }
    args.splice(index, 1);
    return amount;
}

/** POSIX `--` terminator: removes it and everything after, returning the tail. */
export function extractPositionalTail(args: string[]): string[] {
    const index = args.indexOf('--');
    if (index < 0) return [];
    const tail = args.slice(index + 1);
    args.splice(index, args.length - index);
    return tail;
}

export interface LeftoverOptions {
    readonly positionalHint?: string | undefined;
    readonly usage?: UsagePrinter | undefined;
}

/** Reject whatever a subcommand did not consume. No-op on an empty argv. */
export function rejectLeftoverArgs(args: readonly string[], command: string, options: LeftoverOptions = {}): void {
    const first = args[0];
    if (first === undefined) return;
    if (first.startsWith('-')) {
        errLine(`${command}: unknown option ${first}`);
    } else if (options.positionalHint !== undefined) {
        errLine(`${command}: unexpected argument '${first}' — ${options.positionalHint}`);
    } else {
        errLine(`${command}: unexpected argument '${first}'`);
    }
    options.usage?.(writeErr);
    exit(1);
}

/** `-h` / `--help` / `help` — the token form used by group-level dispatchers. */
export function isHelpToken(token: string): boolean {
    return token === '-h' || token === '--help' || token === 'help';
}

/** `--help` / `-h` ANYWHERE in argv — the form `pane`/`workspace` subcommands use. */
export function hasHelpFlag(args: readonly string[]): boolean {
    return args.includes('--help') || args.includes('-h');
}

/**
 * Swift's `Double(_: String)`: strict, whole-string, no surrounding whitespace, and `inf`
 * / `nan` are real values rather than parse failures (which is why `--timeout inf` needs an
 * explicit `isFinite` check at the call site rather than a parse rejection).
 */
export function parseDouble(text: string): number | null {
    if (text.length === 0) return null;
    if (/^\s|\s$/.test(text)) return null;
    if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(text)) return NaN;
    const parsed = Number(text);
    return Number.isNaN(parsed) ? null : parsed;
}

/** Swift's `Int(_: String)`: optional sign, digits only, no whitespace, no exponent. */
export function parseIntStrict(text: string): number | null {
    if (!/^[+-]?\d+$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Swift's `UInt64(_: String)`: digits only, no sign. */
export function parseUIntStrict(text: string): number | null {
    if (!/^\d+$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Swift's `UUID(uuidString:)` — the canonical 8-4-4-4-12 form, case-insensitive. */
export function isUUID(text: string): boolean {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text);
}
