/**
 * `kelpi pane …` (cli.md §9) — the orchestration surface agents actually drive.
 *
 * Two families of defensive parsing live here and both exist because of real incidents:
 *   - **positional targets are rejected** (`close`, `capture`, `name`, `send-key`): a typo'd
 *     positional used to fall through to "the calling pane", which closed the caller (#108)
 *     or captured the wrong screen (#237);
 *   - **outside-pane guards**: `split`/`create`/`name`/`resize` need `--target`/`--workspace`
 *     when `KELPI_PANE_ID` is absent and say so, while the caller-subject verbs (`close` with no
 *     target, directional `move`, `move-to-workspace`, `list --current`, `capture` with no
 *     target) silently exit 0 instead.
 *
 * Empty replies are a mixed-version shim: `send` treats one as success (pre-request/response
 * servers acted, then closed silently), everything else as "this Kelpi is too old".
 */

import {
    hasHelpFlag,
    parseFlag,
    parseIntStrict,
    parseOptionalAmountFlag,
    popSwitch,
    parseDouble,
    rejectLeftoverArgs
} from '../args.js';
import { homeDirectory, originPaneID, requirePaneID } from '../env.js';
import { errLine, exit, printLine, writeErr, writeOut } from '../io.js';
import { asBool, asNumber, asString, stableStringify, type JsonObject } from '../json.js';
import { decodeReply, parseReplyOrExit } from '../reply.js';
import { printPaneTable, replyArray } from '../table.js';
import { printTransportFailure, sendJSON, sendJSONAndReadReply } from '../transport.js';
import {
    paneCaptureUsage,
    paneCloseUsage,
    paneCreateUsage,
    paneListUsage,
    paneMoveUsage,
    paneNameUsage,
    paneResizeUsage,
    paneSendUsage,
    paneSplitUsage,
    paneSyncUsage
} from '../usage.js';

/** Reply minus `ok`, compact + sorted — the pane-family `--json` shape. */
function printReplyWithoutOk(reply: JsonObject): void {
    const clean: JsonObject = { ...reply };
    delete clean['ok'];
    printLine(stableStringify(clean));
}

/** The shared `split`/`create`/`name` printer: `<verb>: <pane_id> (<label>) in workspace <ws>`. */
async function sendPaneMutationReply(payload: JsonObject, command: string, asJSON: boolean, verb: string): Promise<void> {
    const reply = await decodeReply(payload, `kelpi pane ${command}`);
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    const id = asString(reply['pane_id']) ?? '?';
    const label = asString(reply['label']);
    const workspace = asString(reply['workspace_name']);
    let line = `${verb}: ${id}`;
    if (label !== undefined) line += ` (${label})`;
    if (workspace !== undefined) line += ` in workspace ${workspace}`;
    printLine(line);
}

/** The bespoke empty-reply path: "this Kelpi is too old", exit 1 (cli.md §6.5). */
async function readReplyOrEmptyError(payload: JsonObject, command: string): Promise<JsonObject> {
    const data = await sendJSONAndReadReply(payload);
    if (data === null) {
        printTransportFailure(command);
        exit(1);
    }
    if (data.length === 0) {
        errLine(`${command}: empty reply (Kelpi version may not support this command)`);
        exit(1);
    }
    return parseReplyOrExit(data, command);
}

export async function handlePane(args: string[]): Promise<void> {
    const action = args.shift();
    if (action === undefined) {
        errLine('Usage: kelpi pane split|create|close|name|send|send-key|move|list|capture|sync|id [...]');
        exit(1);
    }

    switch (action) {
        case 'id':
            return handlePaneID();
        case 'split':
            return handlePaneSplit(args);
        case 'create':
            return handlePaneCreate(args);
        case 'close':
            return handlePaneClose(args);
        case 'name':
            return handlePaneName(args);
        case 'resize':
            return handlePaneResize(args);
        case 'send':
            return handlePaneSend(args);
        case 'send-key':
            return handlePaneSendKey(args);
        case 'move':
            return handlePaneMove(args);
        case 'move-to-workspace':
            return handlePaneMoveToWorkspace(args);
        case 'list':
            return handlePaneList(args);
        case 'capture':
            return handlePaneCapture(args);
        case 'sync':
            return handlePaneSync(args);
        default:
            errLine(`Unknown pane action: ${action}`);
            errLine(
                'Valid actions: split, create, close, name, send, send-key, move, move-to-workspace, list, capture, sync, id'
            );
            exit(1);
    }
}

/**
 * Local only, never touches the socket. Reads the same `KELPI_PANE_ID` every other command
 * does (cli.md §9.1, §4): this used to read the pre-rename `NEX_PANE_ID`, which the daemon
 * never injects, so `kelpi pane id` exited 1 inside every Kelpi pane (#46).
 */
function handlePaneID(): void {
    const paneID = originPaneID();
    if (paneID === undefined) exit(1);
    printLine(paneID);
}

async function handlePaneSplit(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneSplitUsage);
        exit(0);
    }
    const direction = parseFlag('--direction', args);
    const path = parseFlag('--path', args);
    const name = parseFlag('--name', args);
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const asJSON = popSwitch('--json', args);
    rejectLeftoverArgs(args, 'kelpi pane split', { usage: (write) => write(paneSplitUsage) });

    const origin = originPaneID();
    if (target === null && workspace === null && origin === undefined) {
        errLine(
            'kelpi pane split: requires --target <name-or-uuid> or --workspace <name-or-id> when called from outside a Kelpi pane'
        );
        writeErr(paneSplitUsage);
        exit(1);
    }
    const payload: JsonObject = { command: 'pane-split' };
    if (direction !== null) payload['direction'] = direction;
    if (path !== null) payload['path'] = path;
    if (name !== null) payload['name'] = name;
    if (target !== null) payload['target'] = target;
    if (workspace !== null) payload['workspace'] = workspace;
    if (origin !== undefined) payload['pane_id'] = origin;
    await sendPaneMutationReply(payload, 'split', asJSON, 'split pane');
}

async function handlePaneCreate(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneCreateUsage);
        exit(0);
    }
    const path = parseFlag('--path', args);
    const name = parseFlag('--name', args);
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const asJSON = popSwitch('--json', args);
    rejectLeftoverArgs(args, 'kelpi pane create', { usage: (write) => write(paneCreateUsage) });

    const origin = originPaneID();
    if (target === null && workspace === null && origin === undefined) {
        errLine(
            'kelpi pane create: requires --workspace <name-or-id> or --target <name-or-uuid> when called from outside a Kelpi pane'
        );
        writeErr(paneCreateUsage);
        exit(1);
    }
    const payload: JsonObject = { command: 'pane-create' };
    if (path !== null) payload['path'] = path;
    if (name !== null) payload['name'] = name;
    if (target !== null) payload['target'] = target;
    if (workspace !== null) payload['workspace'] = workspace;
    if (origin !== undefined) payload['pane_id'] = origin;
    await sendPaneMutationReply(payload, 'create', asJSON, 'created pane');
}

async function handlePaneClose(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneCloseUsage);
        exit(0);
    }
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    // Issue #108: a positional target is rejected outright so a typo can never fall through
    // to closing the caller.
    const known = new Set(['--target', '--workspace', '--help', '-h']);
    const leftover = args.filter((token) => !known.has(token));
    const first = leftover[0];
    if (first !== undefined) {
        if (first.startsWith('-')) {
            errLine(`kelpi pane close: unknown option ${first}`);
        } else {
            errLine(`kelpi pane close: unexpected argument '${first}' — use --target <name-or-uuid> to address a specific pane`);
        }
        writeErr(paneCloseUsage);
        exit(1);
    }
    if (target === null && workspace !== null) {
        errLine('kelpi pane close: --workspace requires --target <name-or-uuid>');
        writeErr(paneCloseUsage);
        exit(1);
    }

    const payload: JsonObject = { command: 'pane-close' };
    if (target !== null) {
        payload['target'] = target;
        const origin = originPaneID();
        if (origin !== undefined) payload['pane_id'] = origin;
    } else {
        payload['pane_id'] = requirePaneID();
    }
    if (workspace !== null) payload['workspace'] = workspace;

    const reply = await decodeReply(payload, 'kelpi pane close');
    const id = asString(reply['pane_id']) ?? '?';
    const label = asString(reply['label']);
    const workspaceName = asString(reply['workspace_name']);
    let line = `pane deleted: ${id}`;
    if (label !== undefined) line += ` (${label})`;
    if (workspaceName !== undefined) line += ` in workspace ${workspaceName}`;
    printLine(line);
}

async function handlePaneName(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneNameUsage);
        exit(0);
    }
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const asJSON = popSwitch('--json', args);
    const unknown = args.find((token) => token.startsWith('-'));
    if (unknown !== undefined) {
        errLine(`kelpi pane name: unknown option ${unknown}`);
        writeErr(paneNameUsage);
        exit(1);
    }
    const positionals = args.filter((token) => !token.startsWith('-'));
    const name = positionals[0];
    if (name === undefined || positionals.length !== 1 || name.length === 0) {
        errLine('kelpi pane name: exactly one <name> argument is required');
        writeErr(paneNameUsage);
        exit(1);
    }
    const origin = originPaneID();
    if (target === null && origin === undefined) {
        errLine('kelpi pane name: requires --target <name-or-uuid> when called from outside a Kelpi pane');
        writeErr(paneNameUsage);
        exit(1);
    }
    const payload: JsonObject = { command: 'pane-name', name };
    if (target !== null) payload['target'] = target;
    if (workspace !== null) payload['workspace'] = workspace;
    if (origin !== undefined) payload['pane_id'] = origin;
    await sendPaneMutationReply(payload, 'name', asJSON, 'renamed pane');
}

async function handlePaneResize(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneResizeUsage);
        exit(0);
    }
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const asJSON = popSwitch('--json', args);
    const ratioText = parseFlag('--ratio', args);
    const grow = parseOptionalAmountFlag('--grow', 0.05, args);
    const shrink = parseOptionalAmountFlag('--shrink', 0.05, args);

    const directives = [ratioText !== null, grow !== null, shrink !== null].filter(Boolean).length;
    if (directives !== 1) {
        errLine('kelpi pane resize: exactly one of --ratio / --grow / --shrink is required');
        writeErr(paneResizeUsage);
        exit(1);
    }
    rejectLeftoverArgs(args, 'pane resize', {
        positionalHint: 'size panes with --ratio / --grow / --shrink',
        usage: (write) => write(paneResizeUsage)
    });

    const origin = originPaneID();
    if (target === null && origin === undefined) {
        errLine('kelpi pane resize: requires --target <name-or-uuid> when called from outside a Kelpi pane');
        writeErr(paneResizeUsage);
        exit(1);
    }

    const payload: JsonObject = { command: 'pane-resize' };
    if (ratioText !== null) {
        const ratio = parseDouble(ratioText);
        if (ratio === null || !(ratio > 0) || !(ratio < 1)) {
            errLine('kelpi pane resize: --ratio must be a number between 0 and 1 (exclusive)');
            exit(1);
        }
        payload['ratio'] = ratio;
    } else if (grow !== null) {
        payload['delta'] = grow;
    } else if (shrink !== null) {
        payload['delta'] = -shrink;
    }
    if (target !== null) payload['target'] = target;
    if (workspace !== null) payload['workspace'] = workspace;
    if (origin !== undefined) payload['pane_id'] = origin;

    const reply = await readReplyOrEmptyError(payload, 'kelpi pane resize');
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    const id = asString(reply['pane_id']) ?? '?';
    const label = asString(reply['label']);
    const workspaceName = asString(reply['workspace_name']);
    let ack = `resized ${id}`;
    if (label !== undefined) ack += ` (${label})`;
    const share = asNumber(reply['target_share']);
    if (share !== undefined) ack += ` to ${(share * 100).toFixed(0)}% of its split`;
    if (workspaceName !== undefined) ack += ` in workspace ${workspaceName}`;
    printLine(ack);
}

async function handlePaneSend(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneSendUsage);
        exit(0);
    }
    // `--to` is the original flag, kept as a quiet alias.
    const target = parseFlag('--target', args) ?? parseFlag('--to', args);
    if (target === null) {
        writeErr(paneSendUsage);
        exit(1);
    }
    const workspace = parseFlag('--workspace', args);
    const bare = popSwitch('--bare', args);
    const asJSON = popSwitch('--json', args);

    // Everything left is the text. There is deliberately no `--` terminator here, so a
    // literal `--json` inside the text is eaten as a flag (known, kept for compatibility).
    const text = args.join(' ');
    if (text.length === 0) {
        writeErr(paneSendUsage);
        exit(1);
    }

    const payload: JsonObject = { command: 'pane-send', target, text, bare };
    const origin = originPaneID();
    if (origin !== undefined) payload['pane_id'] = origin;
    if (workspace !== null) payload['workspace'] = workspace;

    const data = await sendJSONAndReadReply(payload);
    if (data === null) {
        printTransportFailure('kelpi pane send');
        exit(1);
    }
    // Empty reply = a pre-request/response Kelpi that acted then closed. Treat as success.
    if (data.length === 0) return;

    const reply = parseReplyOrExit(data, 'kelpi pane send');
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    const id = asString(reply['pane_id']) ?? '?';
    const label = asString(reply['label']);
    const workspaceName = asString(reply['workspace_name']);
    const bareAck = asBool(reply['bare']) ?? false;
    let ack = bareAck ? `sent (bare) to ${id}` : `sent to ${id}`;
    if (label !== undefined) ack += ` (${label})`;
    if (workspaceName !== undefined) ack += ` in workspace ${workspaceName}`;
    printLine(ack);
}

const SEND_KEY_USAGE = 'Usage: kelpi pane send-key --target <name-or-uuid> [--workspace <name-or-uuid>] <key>';

async function handlePaneSendKey(args: string[]): Promise<void> {
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    if (target === null || target.length === 0) {
        errLine(SEND_KEY_USAGE);
        exit(1);
    }
    const unknown = args.find((token) => token.startsWith('-'));
    if (unknown !== undefined) {
        errLine(`kelpi pane send-key: unknown option ${unknown}`);
        errLine(SEND_KEY_USAGE);
        exit(1);
    }
    const keyTokens = args.filter((token) => !token.startsWith('-'));
    const key = keyTokens[0];
    if (key === undefined || keyTokens.length !== 1) {
        errLine(SEND_KEY_USAGE);
        errLine(
            '       <key> is one of: enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c'
        );
        exit(1);
    }

    const payload: JsonObject = { command: 'pane-send-key', target, key };
    const origin = originPaneID();
    if (origin !== undefined) payload['pane_id'] = origin;
    if (workspace !== null && workspace.length > 0) payload['workspace'] = workspace;

    const reply = await readReplyOrEmptyError(payload, 'kelpi pane send-key');
    const id = asString(reply['pane_id']) ?? '?';
    const label = asString(reply['label']);
    const workspaceName = asString(reply['workspace_name']);
    const resolvedKey = asString(reply['key']) ?? key.toLowerCase();
    let ack = `sent ${resolvedKey} to ${id}`;
    if (label !== undefined) ack += ` (${label})`;
    if (workspaceName !== undefined) ack += ` in workspace ${workspaceName}`;
    printLine(ack);
}

const ZONE_FLAGS: readonly (readonly [string, string])[] = [
    ['above', '--above'],
    ['below', '--below'],
    ['left-of', '--left-of'],
    ['right-of', '--right-of']
];

async function handlePaneMove(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneMoveUsage);
        exit(0);
    }
    const target = parseFlag('--target', args);
    const zones = ZONE_FLAGS.map(([zone, flag]) => [zone, parseFlag(flag, args)] as const);
    const given = zones.filter(([, anchor]) => anchor !== null);

    if (target !== null || given.length > 0) {
        // Adjacent form (issue #241) — the CLI equivalent of GUI drag-and-drop.
        const workspace = parseFlag('--workspace', args);
        const asJSON = popSwitch('--json', args);
        if (target === null) {
            errLine('kelpi pane move: the adjacent form requires --target <name-or-uuid>');
            writeErr(paneMoveUsage);
            exit(1);
        }
        const entry = given[0];
        if (given.length !== 1 || entry === undefined || entry[1] === null) {
            errLine('kelpi pane move: exactly one of --above / --below / --left-of / --right-of <anchor> is required');
            writeErr(paneMoveUsage);
            exit(1);
        }
        const [zoneName, anchor] = entry;
        rejectLeftoverArgs(args, 'pane move', {
            positionalHint: 'dock a pane with --target X --below/--above/--left-of/--right-of Y',
            usage: (write) => write(paneMoveUsage)
        });
        const payload: JsonObject = { command: 'pane-move-adjacent', target, anchor, zone: zoneName };
        if (workspace !== null) payload['workspace'] = workspace;
        const origin = originPaneID();
        if (origin !== undefined) payload['pane_id'] = origin;

        const reply = await readReplyOrEmptyError(payload, 'kelpi pane move');
        if (asJSON) {
            printReplyWithoutOk(reply);
            return;
        }
        const movedID = asString(reply['pane_id']) ?? target;
        const anchorID = asString(reply['anchor_id']) ?? anchor;
        const label = asString(reply['label']);
        const workspaceName = asString(reply['workspace_name']);
        let ack = `moved ${movedID}`;
        if (label !== undefined) ack += ` (${label})`;
        ack += ` ${zoneName} ${anchorID}`;
        if (workspaceName !== undefined) ack += ` in workspace ${workspaceName}`;
        printLine(ack);
        return;
    }

    // Directional form (fire-and-forget, caller pane).
    const paneID = requirePaneID();
    const direction = args.shift();
    if (direction === undefined) {
        writeErr(paneMoveUsage);
        exit(1);
    }
    if (!['left', 'right', 'up', 'down'].includes(direction)) {
        errLine(`Invalid direction: ${direction}`);
        errLine('Valid directions: left, right, up, down');
        exit(1);
    }
    await sendJSON({ command: 'pane-move', pane_id: paneID, direction });
}

async function handlePaneMoveToWorkspace(args: string[]): Promise<void> {
    const paneID = requirePaneID();
    const destination = parseFlag('--to-workspace', args);
    if (destination === null) {
        errLine('Usage: kelpi pane move-to-workspace --to-workspace <name-or-uuid> [--create]');
        exit(1);
    }
    // Legacy field names, kept exactly: `name` for the destination and the STRING "true" for
    // --create (cli.md port note 4).
    const payload: JsonObject = { command: 'pane-move-to-workspace', pane_id: paneID, name: destination };
    if (popSwitch('--create', args)) payload['text'] = 'true';
    await sendJSON(payload);
}

async function handlePaneList(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneListUsage);
        exit(0);
    }
    const workspace = parseFlag('--workspace', args);
    const currentOnly = popSwitch('--current', args);
    const asJSON = popSwitch('--json', args);
    const noHeader = popSwitch('--no-header', args);
    rejectLeftoverArgs(args, 'kelpi pane list', { usage: (write) => write(paneListUsage) });

    if (workspace !== null && currentOnly) {
        errLine('pane list: --workspace and --current are mutually exclusive');
        exit(1);
    }

    const payload: JsonObject = { command: 'pane-list' };
    if (workspace !== null) payload['workspace'] = workspace;
    if (currentOnly) {
        payload['pane_id'] = requirePaneID();
        payload['scope'] = 'current';
    }

    const reply = await decodeReply(payload, 'kelpi pane list');
    const panes = replyArray(reply, 'panes');
    if (asJSON) {
        printLine(stableStringify(panes));
        return;
    }
    printPaneTable(panes, noHeader, homeDirectory());
}

async function handlePaneCapture(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(paneCaptureUsage);
        exit(0);
    }
    const target = parseFlag('--target', args);
    const workspace = parseFlag('--workspace', args);
    const linesArg = parseFlag('--lines', args);
    const scrollback = popSwitch('--scrollback', args);
    rejectLeftoverArgs(args, 'kelpi pane capture', {
        positionalHint: 'target panes with --target <name-or-uuid>',
        usage: (write) => write(paneCaptureUsage)
    });

    let lines: number | null = null;
    if (linesArg !== null) {
        const parsed = parseIntStrict(linesArg);
        if (parsed === null || parsed <= 0) {
            errLine('kelpi pane capture: --lines must be a positive integer');
            exit(1);
        }
        lines = parsed;
    }

    const payload: JsonObject = { command: 'pane-capture' };
    if (target !== null) {
        payload['target'] = target;
        const origin = originPaneID();
        if (origin !== undefined) payload['pane_id'] = origin;
    } else {
        payload['pane_id'] = requirePaneID();
    }
    if (workspace !== null) payload['workspace'] = workspace;
    if (lines !== null) payload['lines'] = lines;
    if (scrollback) payload['scrollback'] = true;

    const reply = await decodeReply(payload, 'kelpi pane capture');
    // Raw bytes, no added trailing newline — captured output usually ends in one already.
    writeOut(asString(reply['text']) ?? '');
}

async function handlePaneSync(args: string[]): Promise<void> {
    const mode = args.shift();
    if (mode === undefined) {
        writeErr(paneSyncUsage);
        exit(1);
    }
    if (mode === '-h' || mode === '--help' || mode === 'help') {
        writeOut(paneSyncUsage);
        exit(0);
    }

    // Parsed BEFORE the mode switch, so they may appear anywhere.
    const workspace = parseFlag('--workspace', args);
    const asJSON = popSwitch('--json', args);

    if (mode === 'on' || mode === 'off' || mode === 'toggle' || mode === 'status') {
        const stray = parseFlag('--target', args);
        if (stray !== null) {
            errLine(
                `kelpi pane sync ${mode}: --target ${stray} is not valid here (the toggle is workspace-wide). ` +
                    'Use `kelpi pane sync exclude --target ...` to opt a pane out.'
            );
            exit(1);
        }
        const leftover = args[0];
        if (leftover !== undefined) {
            errLine(`kelpi pane sync ${mode}: unexpected argument '${leftover}'`);
            exit(1);
        }
        const payload: JsonObject = { command: 'pane-sync', action: mode };
        if (workspace !== null && workspace.length > 0) payload['workspace'] = workspace;
        const origin = originPaneID();
        if (origin !== undefined) payload['pane_id'] = origin;
        return sendPaneSyncReply(payload, `sync ${mode}`, asJSON);
    }

    if (mode === 'exclude' || mode === 'include') {
        const target = parseFlag('--target', args);
        if (target === null || target.length === 0) {
            errLine(`Usage: kelpi pane sync ${mode} --target <name-or-uuid> [--workspace <name-or-uuid>]`);
            exit(1);
        }
        const leftover = args[0];
        if (leftover !== undefined) {
            errLine(`kelpi pane sync ${mode}: unexpected argument '${leftover}'`);
            exit(1);
        }
        const payload: JsonObject = { command: 'pane-sync-exclude', target, excluded: mode === 'exclude' };
        if (workspace !== null && workspace.length > 0) payload['workspace'] = workspace;
        const origin = originPaneID();
        if (origin !== undefined) payload['pane_id'] = origin;
        return sendPaneSyncReply(payload, `sync ${mode}`, asJSON);
    }

    errLine(`Unknown sync mode: ${mode}`);
    writeErr(paneSyncUsage);
    exit(1);
}

async function sendPaneSyncReply(payload: JsonObject, command: string, asJSON: boolean): Promise<void> {
    const reply = await readReplyOrEmptyError(payload, `kelpi pane ${command}`);
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    const active = asBool(reply['active']) ?? false;
    const synced = replyArrayOfStrings(reply['synced_pane_ids']);
    const excluded = replyArray(reply, 'excluded');
    const workspaceName = asString(reply['workspace_name']) ?? '?';

    printLine(`workspace: ${workspaceName}`);
    printLine(`sync     : ${active ? 'on' : 'off'}`);
    if (active) {
        printLine(`synced   : ${String(synced.length)} pane${synced.length === 1 ? '' : 's'}`);
        if (excluded.length > 0) {
            const labels = excluded.map((entry) => {
                const label = asString(entry['label']);
                if (label !== undefined && label.length > 0) return label;
                return asString(entry['id']) ?? '?';
            });
            printLine(`excluded : ${labels.join(', ')}`);
        }
    }
}

function replyArrayOfStrings(value: JsonObject[string] | undefined): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
}
