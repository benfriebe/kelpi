/**
 * `kelpi web …` (cli.md §15) — the browser-automation surface.
 *
 * Reply rendering splits three ways and the split is contract:
 *   - `decodeWebReply` (actuators, read verbs, exec) pretty-prints the FULL envelope with
 *     `--json` **before** the `ok` check, so a failure is still machine-readable, and keeps
 *     `exists`'s 0/1 exit even under `--json` so `until` loops survive;
 *   - the list-ish verbs (`tabs`, `console`, `inspect-result`, `cookies list`) unwrap their
 *     array (or dump the whole reply compactly, for `console`);
 *   - the one-line verbs (`open`, `navigate`, `back`, `forward`, `reload`, `tab-*`) print
 *     `<verb> ok: <pane_id> (<url>)`.
 *
 * Two deliberate divergences from `cli.md`, both documented in the package README:
 *   - **`capture` keeps the SHIPPED 0.32.0 flag set** (`--mode meta|text|screenshot`, no
 *     `--json`). `cli.md` §15.6 documents `dom`/`all`/`--json`, but the binary that ships
 *     rejects them, the compat suite pins that refusal (../kelpi-docs/compat-status.md delta 8), and a
 *     drop-in replacement must behave like the thing it replaces.
 *   - **`console --follow` IS implemented** (the shipped binary predates it). It is the one
 *     documented extension this port adds, and the daemon has spoken it since M6.
 */

import fs from 'node:fs';

import { extractPositionalTail, isUUID, parseDouble, parseFlag, parseIntStrict, parseUIntStrict, popSwitch } from '../args.js';
import { homeDirectory, originPaneID, replyTimeoutSeconds } from '../env.js';
import { errLine, exit, printLine, writeErr, writeOut } from '../io.js';
import {
    asBool,
    asInt,
    asNumber,
    asString,
    prettyStringify,
    stableStringify,
    type JsonObject,
    type JsonValue
} from '../json.js';
import { decodeReply, readReplyOrExit } from '../reply.js';
import { localFileURL } from '../routing.js';
import { printCookiesTable, printTabsTable, replyArray } from '../table.js';
import { printTransportFailure, streamJSON, type ReadOptions } from '../transport.js';
import { webCookiesUsage, webUsage } from '../usage.js';

function routingContext(): { cwd: string; home: string } {
    return { cwd: process.cwd(), home: homeDirectory() };
}

/** `localFileURL` or the raw argument (the app treats what is left as a URL / hostname). */
function resolveWebArg(argument: string): string {
    return localFileURL(argument, routingContext()) ?? argument;
}

/**
 * `--target` / `--workspace` / `KELPI_PANE_ID` scoping, enforced CLIENT-side so a scope mistake
 * never costs a socket round trip (cli.md §15.1).
 */
function attachWebTargetScope(
    payload: JsonObject,
    target: string | null,
    workspace: string | null,
    command: string
): void {
    if (target !== null) payload['target'] = target;
    if (workspace !== null) payload['workspace'] = workspace;
    const origin = originPaneID();
    if (origin !== undefined) payload['pane_id'] = origin;

    const hasOrigin = origin !== undefined;
    if (target !== null && !isUUID(target) && workspace === null && !hasOrigin) {
        errLine(
            `kelpi web ${command}: --target by label requires --workspace <name-or-id> when called outside a Kelpi pane`
        );
        exit(1);
    }
    if (target === null && !hasOrigin) {
        // Names the variable `originPaneID()` actually reads (cli.md §15.1, §4); the pre-rename
        // `NEX_PANE_ID` wording sent users exporting a variable nothing honours (#46).
        errLine(`kelpi web ${command}: no --target supplied and KELPI_PANE_ID is not set`);
        exit(1);
    }
}

/** The envelope handler for actuator / read / exec verbs. */
async function decodeWebReply(
    payload: JsonObject,
    command: string,
    asJSON: boolean,
    options: ReadOptions = {}
): Promise<JsonObject> {
    const data = await readReplyOrExit(payload, `kelpi web ${command}`, options);
    let json: JsonObject | null;
    try {
        const parsed: unknown = JSON.parse(data);
        json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
    } catch {
        json = null;
    }
    if (json === null) {
        errLine(`kelpi web ${command}: invalid JSON response`);
        exit(1);
    }
    // Dumped BEFORE the ok check so failures stay machine-readable.
    if (asJSON) printLine(prettyStringify(json));
    if (asBool(json['ok']) === false) {
        if (!asJSON) errLine(`kelpi web ${command}: ${asString(json['error']) ?? 'unknown error'}`);
        exit(1);
    }
    return json;
}

/** `<verb> ok: <pane_id>[ (<url>)]`. */
export async function printBasicWebReply(payload: JsonObject, command: string): Promise<void> {
    const reply = await decodeReply(payload, `kelpi web ${command}`);
    const paneID = asString(reply['pane_id']) ?? '?';
    const url = asString(reply['url']);
    printLine(`${command} ok: ${paneID}${url !== undefined ? ` (${url})` : ''}`);
}

/** `kelpi open`'s web route reuses `web open`'s wire command and printer. */
export async function sendWebOpen(url: string): Promise<void> {
    const payload: JsonObject = { command: 'web-open', url };
    const origin = originPaneID();
    if (origin !== undefined) payload['pane_id'] = origin;
    await printBasicWebReply(payload, 'open');
}

export async function handleWeb(args: string[]): Promise<void> {
    const action = args.shift();
    if (action === undefined) {
        writeErr(webUsage);
        exit(1);
    }
    if (action === '-h' || action === '--help' || action === 'help') {
        writeOut(webUsage);
        exit(0);
    }

    switch (action) {
        case 'open':
            return webOpen(args);
        case 'navigate':
            return webNavigate(args);
        case 'url':
            return webURL(args);
        case 'back':
        case 'forward':
            return webHistory(args, action);
        case 'reload':
            return webReload(args);
        case 'capture':
            return webCapture(args);
        case 'tabs':
            return webTabs(args);
        case 'tab-new':
            return webTabNew(args);
        case 'tab-close':
        case 'tab-select':
            return webTabRef(args, action);
        case 'console':
            return webConsole(args);
        case 'inspect':
            return webInspect(args);
        case 'inspect-result':
            return webInspectResult(args);
        case 'private':
            return webPrivate(args);
        case 'cookies':
            return handleWebCookies(args);
        case 'click':
            return webClick(args);
        case 'type':
            return webType(args);
        case 'select':
            return webSelect(args);
        case 'scroll':
            return webScroll(args);
        case 'hover':
            return webHover(args);
        case 'key':
            return webKey(args);
        case 'text':
        case 'attr':
        case 'count':
        case 'exists':
        case 'dom':
            return webRead(args, action);
        case 'exec':
            return webExec(args);
        case 'wait':
            return webWait(args);
        default:
            errLine(`Unknown web action: ${action}`);
            writeErr(webUsage);
            exit(1);
    }
}

async function webOpen(args: string[]): Promise<void> {
    const isPrivate = popSwitch('--private', args);
    if (args.includes('--target') || args.includes('--workspace')) {
        errLine('kelpi web open: --target / --workspace are not supported (open always creates a new pane).');
        errLine(
            '       Use `kelpi web navigate <url> --target X [--workspace Y]` to redirect an existing pane\'s active tab,'
        );
        errLine('       or `kelpi web tab-new <url> --target X` to open in a new tab.');
        exit(1);
    }
    const url = args.shift();
    if (url === undefined || url.length === 0) {
        errLine('Usage: kelpi web open [--private] <url>');
        exit(1);
    }
    if (url.startsWith('-')) {
        errLine(`kelpi web open: unexpected option '${url}' (URL must not start with '-')`);
        exit(1);
    }
    const payload: JsonObject = { command: 'web-open', url: resolveWebArg(url) };
    if (isPrivate) payload['private'] = true;
    const origin = originPaneID();
    if (origin !== undefined) payload['pane_id'] = origin;
    await printBasicWebReply(payload, 'open');
}

async function webNavigate(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const url = args.shift();
    if (url === undefined || url.length === 0) {
        errLine('Usage: kelpi web navigate <url> [--target <name-or-uuid>] [--workspace <name-or-uuid>]');
        exit(1);
    }
    if (url.startsWith('-')) {
        errLine(`kelpi web navigate: unexpected option '${url}' (URL must not start with '-')`);
        exit(1);
    }
    const payload: JsonObject = { command: 'web-navigate', url: resolveWebArg(url) };
    attachWebTargetScope(payload, target, workspace, 'navigate');
    await printBasicWebReply(payload, 'navigate');
}

async function webURL(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const payload: JsonObject = { command: 'web-url' };
    attachWebTargetScope(payload, target, workspace, 'url');
    const reply = await decodeReply(payload, 'kelpi web url');
    const url = asString(reply['url']) ?? '';
    const title = asString(reply['title']) ?? '';
    printLine(title.length > 0 ? `${url}\t${title}` : url);
}

async function webHistory(args: string[], action: 'back' | 'forward'): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const payload: JsonObject = { command: `web-${action}` };
    attachWebTargetScope(payload, target, workspace, action);
    await printBasicWebReply(payload, action);
}

async function webReload(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const hard = popSwitch('--hard', args);
    const payload: JsonObject = { command: 'web-reload' };
    attachWebTargetScope(payload, target, workspace, 'reload');
    if (hard) payload['hard'] = true;
    await printBasicWebReply(payload, 'reload');
}

/** The shipped 0.32.0 mode set — see the module note. */
const CAPTURE_MODES = new Set(['meta', 'text', 'screenshot']);

async function webCapture(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const mode = parseFlag('--mode', args) ?? 'meta';
    if (!CAPTURE_MODES.has(mode)) {
        errLine(`kelpi web capture: unknown --mode '${mode}' (allowed: meta, text, screenshot)`);
        exit(1);
    }
    const payload: JsonObject = { command: 'web-capture', mode };
    attachWebTargetScope(payload, target, workspace, 'capture');
    const reply = await decodeReply(payload, 'kelpi web capture');
    switch (asString(reply['mode']) ?? 'meta') {
        case 'text': {
            const text = asString(reply['text']);
            if (text !== undefined) printLine(text);
            return;
        }
        case 'dom': {
            const html = asString(reply['html']);
            if (html !== undefined) printLine(html);
            return;
        }
        case 'screenshot': {
            const capturePath = asString(reply['path']);
            if (capturePath !== undefined) {
                printLine(capturePath);
                return;
            }
            const base64 = asString(reply['png_base64']);
            if (base64 !== undefined) printLine(base64);
            return;
        }
        case 'all':
            printLine(stableStringify(reply));
            return;
        default: {
            const url = asString(reply['url']) ?? '';
            const title = asString(reply['title']) ?? '';
            printLine(`url:    ${url}`);
            if (title.length > 0) printLine(`title:  ${title}`);
            const bytes = asInt(reply['byte_count']);
            if (bytes !== undefined) printLine(`bytes:  ${String(bytes)}`);
        }
    }
}

async function webTabs(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const asJSON = popSwitch('--json', args);
    const noHeader = popSwitch('--no-header', args);
    const payload: JsonObject = { command: 'web-tabs' };
    attachWebTargetScope(payload, target, workspace, 'tabs');
    const reply = await decodeReply(payload, 'kelpi web tabs');
    const tabs = replyArray(reply, 'tabs');
    if (asJSON) {
        printLine(stableStringify(tabs));
        return;
    }
    printTabsTable(tabs, noHeader);
}

async function webTabNew(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const noFocus = popSwitch('--no-focus', args);
    const url = args.shift() ?? '';
    const payload: JsonObject = {
        command: 'web-tab-new',
        url: url.length === 0 ? url : resolveWebArg(url),
        make_active: !noFocus
    };
    attachWebTargetScope(payload, target, workspace, 'tab-new');
    await printBasicWebReply(payload, 'tab-new');
}

async function webTabRef(args: string[], action: 'tab-close' | 'tab-select'): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const ref = args.shift();
    if (ref === undefined || ref.length === 0) {
        errLine(`Usage: kelpi web ${action} <ref> [--target X] [--workspace Y]`);
        exit(1);
    }
    const payload: JsonObject = { command: `web-${action}`, tab: ref };
    attachWebTargetScope(payload, target, workspace, action);
    await printBasicWebReply(payload, action);
}

const CONSOLE_LEVELS = new Set(['log', 'debug', 'info', 'warn', 'error']);

function formatConsoleLine(line: JsonObject): string {
    const seq = asNumber(line['seq']) ?? 0;
    const level = asString(line['level']) ?? 'log';
    const message = asString(line['message']) ?? '';
    return `[${String(seq)}] ${level}: ${message}`;
}

async function webConsole(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const sinceArg = parseFlag('--since', args);
    const level = parseFlag('--level', args);
    const clear = popSwitch('--clear', args);
    const asJSON = popSwitch('--json', args);
    const follow = popSwitch('--follow', args);

    const payload: JsonObject = { command: 'web-console' };
    if (sinceArg !== null) {
        const since = parseUIntStrict(sinceArg);
        if (since === null) {
            errLine(`kelpi web console: --since must be an unsigned integer (got '${sinceArg}')`);
            exit(1);
        }
        payload['since'] = since;
    }
    if (level !== null) {
        if (!CONSOLE_LEVELS.has(level)) {
            errLine('kelpi web console: --level must be one of log|debug|info|warn|error');
            exit(1);
        }
        payload['level'] = level;
    }
    if (clear) payload['clear'] = true;
    if (follow) payload['follow'] = true;
    attachWebTargetScope(payload, target, workspace, 'console');

    if (follow) return webConsoleFollow(payload, asJSON);

    const reply = await decodeReply(payload, 'kelpi web console');
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const dropped = asInt(reply['dropped']);
    if (dropped !== undefined && dropped > 0) {
        errLine(`(dropped ${String(dropped)} lines before this batch — buffer was full)`);
    }
    for (const line of replyArray(reply, 'lines')) printLine(formatConsoleLine(line));
    const next = asNumber(reply['next_since']);
    if (next !== undefined) errLine(`(next_since=${String(next)})`);
}

/**
 * The streaming half (cli.md §15.8): line 1 is the catch-up drain in the non-follow envelope,
 * every later line is one console entry. No read timeout, and Ctrl-C exits 130 after closing
 * the socket so the daemon releases the held reply handle.
 */
async function webConsoleFollow(payload: JsonObject, asJSON: boolean): Promise<void> {
    let first = true;
    const outcome = await streamJSON(payload, (raw) => {
        let json: JsonObject | null;
        try {
            const parsed: unknown = JSON.parse(raw);
            json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
        } catch {
            json = null;
        }
        if (json === null) return; // unparseable stream lines are silently skipped
        if (first) {
            first = false;
            if (asBool(json['ok']) === false) {
                errLine(`kelpi web console: ${asString(json['error']) ?? 'unknown error'}`);
                exit(1);
            }
            if (asJSON) {
                printLine(stableStringify(json));
                return;
            }
            const dropped = asInt(json['dropped']);
            if (dropped !== undefined && dropped > 0) {
                errLine(`(dropped ${String(dropped)} lines before this batch — buffer was full)`);
            }
            for (const line of replyArray(json, 'lines')) printLine(formatConsoleLine(line));
            errLine('(following — press Ctrl-C to stop)');
            return;
        }
        if (asJSON) {
            printLine(stableStringify(json));
            return;
        }
        const dropped = asInt(json['dropped']);
        if (dropped !== undefined && dropped > 0) errLine(`(dropped ${String(dropped)} lines)`);
        printLine(formatConsoleLine(json));
    });
    if (outcome === 'failed') {
        printTransportFailure('kelpi web console --follow');
        exit(1);
    }
    if (outcome === 'interrupted') exit(130);
}

async function webInspect(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const sendTo = parseFlag('--send-to', args);
    const submit = popSwitch('--submit', args);
    const disarm = popSwitch('--disarm', args);
    const payload: JsonObject = { command: 'web-inspect' };
    if (sendTo !== null) payload['send_to'] = sendTo;
    if (submit) payload['submit'] = true;
    if (disarm) payload['disarm'] = true;
    attachWebTargetScope(payload, target, workspace, 'inspect');

    const reply = await decodeReply(payload, 'kelpi web inspect');
    const paneID = asString(reply['pane_id']) ?? '?';
    if (asBool(reply['armed']) !== true) {
        printLine(`inspect disarmed: ${paneID}`);
        return;
    }
    const resolvedSendTo = asString(reply['send_to']) ?? '';
    if (resolvedSendTo.length === 0) {
        printLine(`inspect armed: ${paneID} — click an element in the web pane to capture`);
        return;
    }
    printLine(
        `inspect armed: ${paneID} → will paste to ${resolvedSendTo}${asBool(reply['submit']) === true ? ' (+submit)' : ''}`
    );
}

async function webInspectResult(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const clear = popSwitch('--clear', args);
    const asJSON = popSwitch('--json', args);
    const payload: JsonObject = { command: 'web-inspect-result' };
    if (clear) payload['clear'] = true;
    attachWebTargetScope(payload, target, workspace, 'inspect-result');

    const reply = await decodeReply(payload, 'kelpi web inspect-result');
    const results = replyArray(reply, 'results');
    if (asJSON) {
        printLine(stableStringify(results));
        return;
    }
    if (results.length === 0) {
        printLine('(no pending inspect results)');
        return;
    }
    for (const result of results) {
        const selector = asString(result['selector']) ?? '';
        const url = asString(result['url']) ?? '';
        const tag = asString(result['tag']) ?? '';
        printLine(`${tag}  ${selector}  (${url})`);
    }
}

async function webPrivate(args: string[]): Promise<void> {
    const mode = args.shift();
    if (mode === undefined || mode.length === 0) {
        errLine('Usage: kelpi web private on|off [--target X] [--workspace Y]');
        exit(1);
    }
    let enabled: boolean;
    switch (mode.toLowerCase()) {
        case 'on':
        case 'true':
        case '1':
        case 'yes':
            enabled = true;
            break;
        case 'off':
        case 'false':
        case '0':
        case 'no':
            enabled = false;
            break;
        default:
            errLine(`kelpi web private: expected 'on' or 'off' (got '${mode}')`);
            exit(1);
    }
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const payload: JsonObject = { command: 'web-private', private: enabled };
    attachWebTargetScope(payload, target, workspace, 'private');

    const reply = await decodeReply(payload, 'kelpi web private');
    const isPrivate = asBool(reply['private']) ?? false;
    const changed = asBool(reply['changed']) ?? false;
    const paneID = asString(reply['pane_id']) ?? '?';
    printLine(`private ${isPrivate ? 'on' : 'off'}: ${paneID}${changed ? '' : ' (no change)'}`);
}

async function handleWebCookies(args: string[]): Promise<void> {
    const action = args.shift();
    if (action === undefined) {
        writeErr(webCookiesUsage);
        exit(1);
    }
    if (action === '-h' || action === '--help' || action === 'help') {
        writeOut(webCookiesUsage);
        exit(0);
    }

    if (action === 'list') {
        const target = parseFlag('--target', args);
        const workspace = parseFlag('--workspace', args);
        const asJSON = popSwitch('--json', args);
        const payload: JsonObject = { command: 'web-cookies-list' };
        attachWebTargetScope(payload, target, workspace, 'cookies list');
        const reply = await decodeReply(payload, 'kelpi web cookies list');
        const cookies = replyArray(reply, 'cookies');
        if (asJSON) {
            printLine(stableStringify(cookies));
            return;
        }
        if (cookies.length === 0) {
            printLine('(no cookies)');
            return;
        }
        printCookiesTable(cookies);
        return;
    }

    if (action === 'clear') {
        const target = parseFlag('--target', args);
        const workspace = parseFlag('--workspace', args);
        const domain = parseFlag('--domain', args);
        const all = popSwitch('--all', args);
        if (all && domain !== null) {
            errLine('kelpi web cookies clear: --all and --domain are mutually exclusive');
            exit(1);
        }
        const payload: JsonObject = { command: 'web-cookies-clear' };
        if (domain !== null) payload['domain'] = domain;
        if (all) payload['all'] = true;
        attachWebTargetScope(payload, target, workspace, 'cookies clear');
        const reply = await decodeReply(payload, 'kelpi web cookies clear');
        if (all || asBool(reply['cleared_site_data']) === true) {
            printLine('cleared all site data');
            return;
        }
        const deleted = asInt(reply['deleted']) ?? 0;
        const replyDomain = asString(reply['domain']) ?? '';
        const plural = deleted === 1 ? '' : 's';
        printLine(
            replyDomain.length === 0
                ? `deleted ${String(deleted)} cookie${plural}`
                : `deleted ${String(deleted)} cookie${plural} for ${replyDomain}`
        );
        return;
    }

    if (action === 'delete') {
        const target = parseFlag('--target', args);
        const workspace = parseFlag('--workspace', args);
        const domain = parseFlag('--domain', args);
        const name = parseFlag('--name', args) ?? args.shift();
        if (name === undefined || name.length === 0) {
            errLine('Usage: kelpi web cookies delete <name> [--domain <d>] [--target X] [--workspace Y]');
            exit(1);
        }
        const payload: JsonObject = { command: 'web-cookies-delete', name };
        if (domain !== null) payload['domain'] = domain;
        attachWebTargetScope(payload, target, workspace, 'cookies delete');
        const reply = await decodeReply(payload, 'kelpi web cookies delete');
        const deleted = asInt(reply['deleted']) ?? 0;
        const replyName = asString(reply['name']) ?? '?';
        if (deleted === 0) {
            printLine(`no cookie matched name '${replyName}'`);
            exit(1);
        }
        printLine(`deleted ${String(deleted)} cookie${deleted === 1 ? '' : 's'} named '${replyName}'`);
        return;
    }

    errLine(`Unknown cookies action: ${action}`);
    writeErr(webCookiesUsage);
    exit(1);
}

async function webClick(args: string[]): Promise<void> {
    const tail = extractPositionalTail(args);
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const double = popSwitch('--double', args);
    const right = popSwitch('--right', args);
    const atArg = parseFlag('--at', args);
    const asJSON = popSwitch('--json', args);
    const positional = [...args, ...tail];
    const selector = positional.shift();
    if (selector === undefined || selector.length === 0) {
        errLine(
            'Usage: kelpi web click [--target X] [--workspace Y] <selector> [--double] [--right] [--at x,y] [--json]'
        );
        exit(1);
    }
    const payload: JsonObject = { command: 'web-click', selector };
    if (double) payload['double'] = true;
    if (right) payload['right'] = true;
    if (atArg !== null) {
        const parts = atArg.split(',');
        const x = parts.length === 2 ? parseDouble((parts[0] ?? '').trim()) : null;
        const y = parts.length === 2 ? parseDouble((parts[1] ?? '').trim()) : null;
        if (x === null || y === null) {
            errLine(`kelpi web click: --at must be 'x,y' numbers (got '${atArg}')`);
            exit(1);
        }
        payload['at_x'] = x;
        payload['at_y'] = y;
    }
    attachWebTargetScope(payload, target, workspace, 'click');
    const reply = await decodeWebReply(payload, 'click', asJSON);
    if (asJSON) return;
    const text = asString(reply['text']) ?? '';
    printLine(text.length === 0 ? 'clicked' : `clicked: "${text}"`);
}

async function webType(args: string[]): Promise<void> {
    const tail = extractPositionalTail(args);
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const submit = popSwitch('--submit', args);
    const noReplace = popSwitch('--no-replace', args);
    const asJSON = popSwitch('--json', args);
    const positional = [...args, ...tail];
    const selector = positional.shift();
    const usage =
        'Usage: kelpi web type [--target X] [--workspace Y] <selector> <text> [--submit] [--no-replace] [--json]';
    if (selector === undefined || selector.length === 0) {
        errLine(usage);
        exit(1);
    }
    const text = positional.shift();
    if (text === undefined) {
        errLine(usage);
        exit(1);
    }
    const payload: JsonObject = { command: 'web-type', selector, text };
    if (submit) payload['submit'] = true;
    if (noReplace) payload['replace'] = false;
    attachWebTargetScope(payload, target, workspace, 'type');
    const reply = await decodeWebReply(payload, 'type', asJSON);
    if (asJSON) return;
    printLine(`typed: ${asString(reply['value']) ?? ''}`);
}

async function webSelect(args: string[]): Promise<void> {
    const tail = extractPositionalTail(args);
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const asJSON = popSwitch('--json', args);
    const positional = [...args, ...tail];
    const selector = positional.shift();
    const valueOrLabel = positional.shift();
    if (selector === undefined || selector.length === 0 || valueOrLabel === undefined) {
        errLine('Usage: kelpi web select [--target X] [--workspace Y] <selector> <value-or-label> [--json]');
        exit(1);
    }
    const payload: JsonObject = { command: 'web-select', selector, value_or_label: valueOrLabel };
    attachWebTargetScope(payload, target, workspace, 'select');
    const reply = await decodeWebReply(payload, 'select', asJSON);
    if (asJSON) return;
    const label = asString(reply['label']) ?? '';
    const value = asString(reply['value']) ?? '';
    printLine(`selected: ${label.length === 0 ? value : label}`);
}

async function webScroll(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const top = popSwitch('--top', args);
    const bottom = popSwitch('--bottom', args);
    const smooth = popSwitch('--smooth', args);
    const asJSON = popSwitch('--json', args);
    const selector = args.shift();
    if (selector === undefined || selector.length === 0) {
        errLine('Usage: kelpi web scroll [--target X] [--workspace Y] <selector> [--top|--bottom|--smooth] [--json]');
        exit(1);
    }
    if (top && bottom) {
        errLine('kelpi web scroll: --top and --bottom are mutually exclusive');
        exit(1);
    }
    const payload: JsonObject = {
        command: 'web-scroll',
        selector,
        block: top ? 'start' : bottom ? 'end' : 'center',
        behavior: smooth ? 'smooth' : 'instant'
    };
    attachWebTargetScope(payload, target, workspace, 'scroll');
    await decodeWebReply(payload, 'scroll', asJSON);
    if (asJSON) return;
    printLine('scrolled');
}

async function webHover(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const asJSON = popSwitch('--json', args);
    const selector = args.shift();
    if (selector === undefined || selector.length === 0) {
        errLine('Usage: kelpi web hover [--target X] [--workspace Y] <selector> [--json]');
        exit(1);
    }
    const payload: JsonObject = { command: 'web-hover', selector };
    attachWebTargetScope(payload, target, workspace, 'hover');
    await decodeWebReply(payload, 'hover', asJSON);
    if (asJSON) return;
    printLine('hovered');
}

async function webKey(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const selector = parseFlag('--selector', args);
    const asJSON = popSwitch('--json', args);
    const keyName = args.shift();
    if (keyName === undefined || keyName.length === 0) {
        errLine('Usage: kelpi web key [--target X] [--workspace Y] <key-name> [--selector <sel>] [--json]');
        exit(1);
    }
    const payload: JsonObject = { command: 'web-key', key: keyName };
    if (selector !== null) payload['selector'] = selector;
    attachWebTargetScope(payload, target, workspace, 'key');
    const reply = await decodeWebReply(payload, 'key', asJSON);
    if (asJSON) return;
    printLine(`key: ${asString(reply['key']) ?? ''}`);
}

type ReadVerb = 'text' | 'attr' | 'count' | 'exists' | 'dom';

async function webRead(args: string[], verb: ReadVerb): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const maxBytesArg = verb === 'text' || verb === 'dom' ? parseFlag('--max-bytes', args) : null;
    const asJSON = popSwitch('--json', args);
    const selector = args.shift();
    if (selector === undefined || selector.length === 0) {
        errLine(usageForReadVerb(verb));
        exit(1);
    }
    const payload: JsonObject = { command: `web-q-${verb}`, selector };
    if (verb === 'attr') {
        const attribute = args.shift();
        if (attribute === undefined || attribute.length === 0) {
            errLine(usageForReadVerb(verb));
            exit(1);
        }
        payload['attribute'] = attribute;
    }
    if (maxBytesArg !== null) {
        const maxBytes = parseIntStrict(maxBytesArg);
        if (maxBytes === null || maxBytes <= 0) {
            errLine(`kelpi web ${verb}: --max-bytes must be a positive integer (got '${maxBytesArg}')`);
            exit(1);
        }
        payload['max_bytes'] = maxBytes;
    }
    attachWebTargetScope(payload, target, workspace, verb);

    const reply = await decodeWebReply(payload, verb, asJSON);
    if (asJSON) {
        // `exists` keeps its exit-code semantics even under --json so until-loops survive.
        if (verb === 'exists' && asBool(reply['found']) !== true) exit(1);
        return;
    }
    if (verb === 'text') {
        printLine(asString(reply['text']) ?? '');
        return;
    }
    if (verb === 'attr') {
        // `present` distinguishes "absent" (exit 1, no output) from "present but empty".
        if (asBool(reply['present']) !== true) exit(1);
        printLine(asString(reply['value']) ?? '');
        return;
    }
    if (verb === 'count') {
        printLine(String(asInt(reply['count']) ?? 0));
        return;
    }
    if (verb === 'exists') {
        exit(asBool(reply['found']) === true ? 0 : 1);
    }
    printLine(asString(reply['outer_html']) ?? '');
}

function usageForReadVerb(verb: ReadVerb): string {
    switch (verb) {
        case 'text':
            return 'Usage: kelpi web text [--target X] [--workspace Y] <selector> [--max-bytes N] [--json]';
        case 'attr':
            return 'Usage: kelpi web attr [--target X] [--workspace Y] <selector> <attribute> [--json]';
        case 'count':
            return 'Usage: kelpi web count [--target X] [--workspace Y] <selector> [--json]';
        case 'exists':
            return 'Usage: kelpi web exists [--target X] [--workspace Y] <selector> [--json]';
        case 'dom':
            return 'Usage: kelpi web dom [--target X] [--workspace Y] <selector> [--max-bytes N] [--json]';
    }
}

async function webExec(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const file = parseFlag('--file', args);
    const timeoutText = parseFlag('--timeout', args);
    const asJSON = popSwitch('--json', args);

    // Default 30s: exec scripts routinely chain `kelpi.wait`, which alone defaults to 10s.
    let timeoutSeconds = 30;
    if (timeoutText !== null) {
        const parsed = parseDouble(timeoutText);
        if (parsed === null || !(parsed > 0) || !Number.isFinite(parsed)) {
            errLine(`kelpi web exec: --timeout must be a positive finite number of seconds (got '${timeoutText}')`);
            exit(1);
        }
        timeoutSeconds = parsed;
    }

    let script: string;
    if (file !== null) {
        try {
            script = fs.readFileSync(file, 'utf8');
        } catch {
            errLine(`kelpi web exec: cannot read --file '${file}'`);
            exit(1);
        }
    } else {
        const positional = args.shift();
        if (positional === undefined || positional.length === 0) {
            errLine('Usage: kelpi web exec [--target X] [--workspace Y] [--timeout S] (--file <path> | <js>) [--json]');
            exit(1);
        }
        script = positional;
    }

    const payload: JsonObject = { command: 'web-exec', script };
    attachWebTargetScope(payload, target, workspace, 'exec');
    // The timeout is NOT shipped on the wire; it only pads the socket read window.
    const readTimeout = Math.max(Math.ceil(timeoutSeconds) + 5, replyTimeoutSeconds());
    const reply = await decodeWebReply(payload, 'exec', asJSON, { timeoutSeconds: readTimeout });
    if (asJSON) return;
    const result: JsonValue | undefined = reply['result'];
    if (result === undefined || result === null) return;
    if (typeof result === 'string') {
        printLine(result);
        return;
    }
    if (typeof result === 'boolean') {
        printLine(result ? 'true' : 'false');
        return;
    }
    if (typeof result === 'number') {
        // Integer-preserving: no trailing `.0`, matching NSNumber.stringValue.
        printLine(String(result));
        return;
    }
    printLine(stableStringify(result));
}

async function webWait(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const selector = parseFlag('--selector', args);
    const forCondition = parseFlag('--for', args);
    const urlMatch = parseFlag('--url-match', args);
    const timeoutText = parseFlag('--timeout', args);
    const asJSON = popSwitch('--json', args);

    if (selector === null && urlMatch === null) {
        errLine('kelpi web wait: one of --selector or --url-match is required');
        exit(1);
    }
    if (selector !== null && urlMatch !== null) {
        errLine('kelpi web wait: --selector and --url-match are mutually exclusive');
        exit(1);
    }
    let timeoutSeconds = 10;
    if (timeoutText !== null) {
        const parsed = parseDouble(timeoutText);
        if (parsed === null || !(parsed > 0) || !Number.isFinite(parsed)) {
            errLine(`kelpi web wait: --timeout must be a positive finite number of seconds (got '${timeoutText}')`);
            exit(1);
        }
        timeoutSeconds = parsed;
    }

    const payload: JsonObject = { command: 'web-wait', timeout_ms: Math.trunc(timeoutSeconds * 1000) };
    if (selector !== null) payload['selector'] = selector;
    if (urlMatch !== null) payload['url_match'] = urlMatch;
    if (forCondition !== null) payload['for'] = forCondition;
    attachWebTargetScope(payload, target, workspace, 'wait');

    // The server can legitimately hold the reply for the whole wait; pad past it.
    const readTimeout = Math.max(Math.ceil(timeoutSeconds) + 5, replyTimeoutSeconds());
    const reply = await decodeWebReply(payload, 'wait', asJSON, { timeoutSeconds: readTimeout });
    if (asJSON) return;
    const condition = asString(reply['condition']) ?? 'exists';
    const waited = asInt(reply['waited_ms']) ?? 0;
    printLine(`matched ${condition} in ${String(waited)} ms`);
}
