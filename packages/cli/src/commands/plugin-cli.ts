/**
 * Plugin CLI verbs (#391, cli.md "Plugin CLI verbs").
 *
 * A word `kelpi` does not dispatch itself may be a verb an installed plugin declared in
 * `contributes.cli`. `cli.ts` checks its own verbs first, so a built-in never pays for this
 * round trip; only an unknown word asks the daemon, through the `plugin` wire command's `cli`
 * action, which runs the plugin command mapped to the verb and hands back
 * `{ text?, json?, exitCode?, stderr? }`. `kelpi --help` lists the verbs through `cli-list`.
 *
 * What stays exactly as it was before plugin verbs existed:
 *   - a word no plugin could declare (`isCliVerbName` fails: empty, uppercase, spaced, too long,
 *     or starting with `-`, so `kelpi --bogus` is a typo, not a verb) is never sent;
 *   - a word no plugin declares prints `Unknown command: <x>` then the usage block, exit 1, so
 *     the first stderr line is still the one harnesses read a misspelled invocation from.
 *
 * Running a verb keeps the pane-route retry (transport.ts `ROUTE_RETRY_WINDOW_MS`) like any
 * built-in command, so a verb run in a pane while the daemon restarts waits for it to come back.
 * Only the `cli-list` request behind `kelpi --help` skips it: with no daemon up, help in a pane
 * answers at once instead of after five seconds, and its whole lookup, connect included, is
 * bounded to 2 s of wall clock (`deadlineMs`), so a peer that stalls or trickles bytes cannot
 * hold help open.
 */

import { isBuiltinCliVerb, isCliVerbName } from '@kelpi/protocol';

import { env, homeDirectory, originPaneID, setEnv } from '../env.js';
import { errLine, exit, printLine, writeErr, writeOut } from '../io.js';
import { asBool, asInt, asObjectArray, asString, parseJsonObject, type JsonObject, type JsonValue } from '../json.js';
import { printTransportFailure, sendJSONAndReadReply, takeLastTransportFailure, type ReadOptions } from '../transport.js';
import { globalUsage, pluginVerbsUsage, type PluginVerbListing } from '../usage.js';

/** The same read timeout as `kelpi plugin run`: the verb runs a plugin command. */
const VERB_TIMEOUT_SECONDS = 35;
/** `kelpi --help` prints its usage first; the plugin block is dropped past this, wall clock. */
const HELP_TIMEOUT_SECONDS = 2;

/** What a daemon from before plugin verbs answers to the `cli` action: it reads a plugin ID. */
const PRE_VERB_DAEMON_ERROR = 'missing or invalid pluginID';

/** `Unknown command: <x>`, an optional explanation, then the usage block; exit 1. */
export function unknownCommand(verb: string, note?: string): never {
    writeErr(`Unknown command: ${verb}\n`);
    if (note !== undefined) errLine(note);
    writeErr(globalUsage);
    exit(1);
}

/**
 * The verb's own argv and whether `--json` was given. Every `--json` before a `--` is the CLI's
 * and is removed; the `--` and everything after it reach the plugin untouched.
 */
export function splitJsonSwitch(args: readonly string[]): { argv: string[]; json: boolean } {
    const end = args.indexOf('--');
    const head = end < 0 ? args : args.slice(0, end);
    const kept = head.filter((word) => word !== '--json');
    return { argv: [...kept, ...args.slice(head.length)], json: kept.length !== head.length };
}

function pluginRequest(action: string, input: JsonObject, options: ReadOptions): Promise<string | null> {
    return sendJSONAndReadReply({ command: 'plugin', action, text: JSON.stringify(input) }, options);
}

/** `request` with the pane-route retry off, unless `KELPI_ROUTE_RETRY_MS` is set explicitly. */
async function withoutRouteRetry<T>(request: () => Promise<T>): Promise<T> {
    const saved = env();
    if (saved['KELPI_ROUTE_RETRY_MS'] === undefined) setEnv({ ...saved, KELPI_ROUTE_RETRY_MS: '0' });
    try {
        return await request();
    } finally {
        setEnv(saved);
    }
}

function objectOf(value: JsonValue | undefined): JsonObject | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/**
 * The caller's directory. `process.cwd()` throws once the shell's directory is removed (as a
 * deleted workspace's worktree is), so fall back to a non-empty `PWD`, then the home directory.
 */
function callerDirectory(): string {
    try {
        return process.cwd();
    } catch {
        const pwd = env()['PWD'];
        return pwd !== undefined && pwd.length > 0 ? pwd : homeDirectory();
    }
}

function withNewline(text: string): string {
    return text.endsWith('\n') ? text : `${text}\n`;
}

/** `exitCode` when it is a usable process exit code; absent is 0, anything else is 1. */
function exitCodeOf(value: JsonValue | undefined): number {
    if (value === undefined || value === null) return 0;
    const code = asInt(value);
    return code !== undefined && code >= 0 && code <= 255 ? code : 1;
}

/** `kelpi <verb> [argv...]` for a word that is not a built-in. Always exits. */
export async function handlePluginVerb(verb: string, args: readonly string[]): Promise<never> {
    if (!isCliVerbName(verb)) unknownCommand(verb);
    const label = `kelpi ${verb}`;
    const { argv, json } = splitJsonSwitch(args);
    const input: JsonObject = { verb, argv, cwd: callerDirectory(), isTTY: process.stdout.isTTY === true, json };
    const paneID = originPaneID();
    if (paneID !== undefined) input['paneID'] = paneID;

    const data = await pluginRequest('cli', input, { timeoutSeconds: VERB_TIMEOUT_SECONDS });
    if (data === null) {
        // Connected, then the socket failed before a byte came back: the verb may have run.
        if (takeLastTransportFailure()?.kind === 'emptyReply') {
            errLine(`${label}: no response from Kelpi`);
            exit(1);
        }
        // The harness guard refused the default socket: the same route error a built-in prints.
        if (takeLastTransportFailure()?.kind === 'requiredSocketUnmet') {
            printTransportFailure(label);
            exit(1);
        }
        unknownCommand(verb, 'Plugin verbs need a running Kelpi daemon, and none could be reached (`kelpi doctor` checks the connection).');
    }
    if (data.length === 0) {
        errLine(`${label}: no response from Kelpi (upgrade required?)`);
        exit(1);
    }
    const reply = parseJsonObject(data);
    if (reply === null) {
        errLine(`${label}: invalid JSON response`);
        exit(1);
    }
    if (asBool(reply['ok']) === false) {
        const error = asString(reply['error']) ?? 'unknown error';
        if (error === `unknown kelpi verb: ${verb}`) unknownCommand(verb);
        if (error === PRE_VERB_DAEMON_ERROR) {
            unknownCommand(verb, 'The running Kelpi daemon predates plugin verbs; `kelpi daemon restart` starts the current one.');
        }
        errLine(`${label}: ${error}`);
        exit(1);
    }

    const result = objectOf(reply['result']) ?? {};
    const stderr = asString(result['stderr']);
    if (stderr !== undefined && stderr.length > 0) writeErr(withNewline(stderr));
    const text = asString(result['text']);
    if (json) printLine(JSON.stringify('json' in result ? result['json'] : { text }, null, 2));
    else if (text !== undefined && text.length > 0) writeOut(withNewline(text));
    exit(exitCodeOf(result['exitCode']));
}

/**
 * The `Plugin commands:` block for `kelpi --help`, or an empty string when there is none to
 * show: no plugin verbs, no daemon, a daemon too old to answer, or no answer within 2 s.
 */
export async function pluginVerbsHelp(): Promise<string> {
    const data = await withoutRouteRetry(() =>
        pluginRequest('cli-list', {}, { timeoutSeconds: HELP_TIMEOUT_SECONDS, deadlineMs: HELP_TIMEOUT_SECONDS * 1000 })
    );
    const reply = data === null ? null : parseJsonObject(data);
    if (reply === null || reply['ok'] !== true) return '';
    const verbs = asObjectArray(objectOf(reply['result'])?.['verbs']).flatMap((entry): PluginVerbListing[] => {
        const name = asString(entry['name']);
        const summary = asString(entry['summary']);
        const pluginID = asString(entry['pluginID']);
        const enabled = asBool(entry['enabled']);
        if (name === undefined || summary === undefined || pluginID === undefined || enabled === undefined) return [];
        // A daemon a release behind this CLI can list a verb this CLI has since made built-in, and
        // nothing stops a daemon sending a name the manifest rule refuses. Neither is runnable from
        // here, so neither is listed.
        if (!isCliVerbName(name) || isBuiltinCliVerb(name)) return [];
        return [{ name, summary, pluginID, pluginName: asString(entry['pluginName']) || pluginID, enabled }];
    });
    return pluginVerbsUsage(verbs);
}
