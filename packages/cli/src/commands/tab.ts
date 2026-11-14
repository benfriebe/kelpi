/**
 * `kelpi tab …` (cli.md §12a, workspace-feature.md §12): every workspace has tabs, and each tab
 * its own split layout. These are the window's tab gestures for scripts and agents.
 *
 * Every verb is request/response. A tab is named by its 1-based number, its id or the title the
 * tab bar shows; without one, the calling pane's own tab is meant. The daemon resolves both the
 * workspace and the tab (`handlers/pane/tabs.ts`), so the CLI only forwards what was typed, plus
 * the caller pane as the default. Creations and moves happen in the background unless `--focus`
 * (#295), as `pane split` does; `select` always shows. `--json` prints the reply without `ok`,
 * the pane family's shape; `list --json` prints the array.
 */

import { extractPositionalTail, hasHelpFlag, isHelpToken, parseFlag, parseIntStrict, popSwitch, rejectLeftoverArgs, type UsagePrinter } from '../args.js';
import { originPaneID } from '../env.js';
import { errLine, exit, printLine, writeErr, writeOut } from '../io.js';
import { asArray, asInt, asString, stableStringify, type JsonObject } from '../json.js';
import { decodeReply } from '../reply.js';
import { printWorkspaceTabTable, replyArray } from '../table.js';
import {
    tabCloseOthersUsage,
    tabCloseUsage,
    tabDuplicateUsage,
    tabListUsage,
    tabMergeUsage,
    tabMoveToWorkspaceUsage,
    tabMoveUsage,
    tabNewUsage,
    tabRenameUsage,
    tabSelectUsage,
    tabSplitUsage,
    tabUsage
} from '../usage.js';

const NEW_TAB_KINDS = ['terminal', 'same', 'agent', 'web', 'scratchpad'];

export async function handleTab(args: string[]): Promise<void> {
    const action = args.shift();
    if (action === undefined) {
        errLine('Usage: kelpi tab list|new|select|rename|move|close|close-others|duplicate|merge|split|move-to-workspace [...]');
        exit(1);
    }
    if (isHelpToken(action)) {
        writeOut(tabUsage);
        exit(0);
    }
    switch (action) {
        case 'list':
            return handleTabList(args);
        case 'new':
            return handleTabNew(args);
        case 'select':
        case 'show':
            return handleOneTab(args, 'select', 'workspace-tab-select', tabSelectUsage, (reply) => `showing ${where(reply)}`);
        case 'close':
            return handleOneTab(args, 'close', 'workspace-tab-close', tabCloseUsage, (reply) => `closed tab ${asString(reply['tab_id']) ?? '?'} in workspace ${asString(reply['workspace_name']) ?? '?'}${panes(reply)}`);
        case 'close-others':
            return handleOneTab(args, 'close-others', 'workspace-tab-close-others', tabCloseOthersUsage, (reply) => `closed every tab but ${where(reply)}${panes(reply)}`);
        case 'duplicate':
            return handleOneTab(args, 'duplicate', 'workspace-tab-duplicate', tabDuplicateUsage, (reply) => `duplicated as ${where(reply)}`, true);
        case 'merge':
            return handleOneTab(args, 'merge', 'workspace-tab-merge-previous', tabMergeUsage, (reply) => `merged into ${where(reply)}`);
        case 'split':
            return handleOneTab(args, 'split', 'workspace-tab-split-panes', tabSplitUsage, (reply) => {
                const numbers = [asInt(reply['tab_number']), ...(asArray(reply['tab_numbers']) ?? []).map((value) => asInt(value))];
                return `split into tabs ${numbers.map((value) => String(value ?? '?')).join(', ')} in workspace ${asString(reply['workspace_name']) ?? '?'}`;
            });
        case 'rename':
            return handleTabRename(args);
        case 'move':
            return handleTabMove(args);
        case 'move-to-workspace':
            return handleTabMoveToWorkspace(args);
        default:
            errLine(`Unknown tab action: ${action}`);
            errLine('Valid actions: list, new, select, show, rename, move, close, close-others, duplicate, merge, split, move-to-workspace');
            exit(1);
    }
}

/** `tab 3 (<id>) in workspace dev`: where a tab stands after the change. */
function where(reply: JsonObject): string {
    const number = asInt(reply['tab_number']);
    const id = asString(reply['tab_id']) ?? '?';
    const workspace = asString(reply['workspace_name']);
    return `tab ${number === undefined ? '?' : String(number)} (${id})${workspace === undefined ? '' : ` in workspace ${workspace}`}`;
}

/** ` (3 panes)` after a close. */
function panes(reply: JsonObject): string {
    const closed = asInt(reply['closed']) ?? 0;
    return ` (${String(closed)} ${closed === 1 ? 'pane' : 'panes'})`;
}

/** The reply minus `ok`, compact and sorted: the pane family's `--json` shape. */
function printReplyWithoutOk(reply: JsonObject): void {
    const clean: JsonObject = { ...reply };
    delete clean['ok'];
    printLine(stableStringify(clean));
}

/** The caller pane and the named workspace and tab: what every verb sends. */
function scoped(command: string, workspace: string | null, tab: string | undefined): JsonObject {
    const payload: JsonObject = { command };
    const origin = originPaneID();
    if (origin !== undefined) payload['pane_id'] = origin;
    if (workspace !== null) payload['workspace'] = workspace;
    if (tab !== undefined) payload['tab'] = tab;
    return payload;
}

/** The positionals left once the flags are taken (`--` lets a name start with a dash). */
function positionals(args: string[]): string[] {
    const tail = extractPositionalTail(args);
    const words: string[] = [];
    while (args.length > 0 && !(args[0] as string).startsWith('-')) words.push(args.shift() as string);
    return [...words, ...tail];
}

/** Outside a pane there is no "own tab": say so here rather than send a request that cannot work. */
function requireTabOutsidePane(tab: string | undefined, verb: string, usage: string): void {
    if (tab !== undefined || originPaneID() !== undefined) return;
    errLine(`kelpi tab ${verb}: name a tab (a number, id or title) when not in a Kelpi pane`);
    writeErr(usage);
    exit(1);
}

/** `--at <n>` / `--to <n>`: 1-based, so a 0-based index for the wire; exit 1 on anything else. */
function position(flag: string, raw: string | null, verb: string): number | undefined {
    if (raw === null) return undefined;
    const parsed = parseIntStrict(raw);
    if (parsed === null || parsed < 1) {
        errLine(`kelpi tab ${verb}: ${flag} takes a position from 1`);
        exit(1);
    }
    return parsed - 1;
}

function usagePrinter(usage: string): UsagePrinter {
    return (write) => write(usage);
}

async function handleTabList(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(tabListUsage);
        exit(0);
    }
    const workspace = parseFlag('--workspace', args);
    const all = popSwitch('--all', args);
    const asJSON = popSwitch('--json', args);
    const noHeader = popSwitch('--no-header', args);
    rejectLeftoverArgs(args, 'kelpi tab list', { usage: usagePrinter(tabListUsage) });
    if (all && workspace !== null) {
        errLine('kelpi tab list: --workspace and --all are mutually exclusive');
        exit(1);
    }
    const payload = scoped('workspace-tab-list', workspace, undefined);
    if (all) payload['all'] = true;
    const reply = await decodeReply(payload, 'kelpi tab list');
    const tabs = replyArray(reply, 'tabs');
    if (asJSON) {
        printLine(stableStringify(tabs));
        return;
    }
    printWorkspaceTabTable(tabs, noHeader, all);
}

async function handleTabNew(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(tabNewUsage);
        exit(0);
    }
    const kind = parseFlag('--kind', args);
    const name = parseFlag('--name', args);
    const at = position('--at', parseFlag('--at', args), 'new');
    const end = popSwitch('--end', args);
    const workspace = parseFlag('--workspace', args);
    const focus = popSwitch('--focus', args);
    const asJSON = popSwitch('--json', args);
    rejectLeftoverArgs(args, 'kelpi tab new', { usage: usagePrinter(tabNewUsage) });
    if (kind !== null && !NEW_TAB_KINDS.includes(kind)) {
        errLine(`kelpi tab new: unknown kind '${kind}'; use ${NEW_TAB_KINDS.join(', ')}`);
        exit(1);
    }
    if (at !== undefined && end) {
        errLine('kelpi tab new: --at and --end are mutually exclusive');
        exit(1);
    }
    const payload = scoped('workspace-tab-new', workspace, undefined);
    if (kind !== null) payload['kind'] = kind;
    if (name !== null) payload['name'] = name;
    if (at !== undefined) payload['index'] = at;
    if (end) payload['at_end'] = true;
    if (focus) payload['focus'] = true;
    const reply = await decodeReply(payload, 'kelpi tab new');
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    printLine(`created ${where(reply)}`);
}

/**
 * The verbs that take one tab and nothing else: select, close, close-others, duplicate, merge,
 * split. `canFocus` lets `--focus` through for the one that opens something (duplicate).
 */
async function handleOneTab(
    args: string[],
    verb: string,
    command: string,
    usage: string,
    ack: (reply: JsonObject) => string,
    canFocus = false
): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(usage);
        exit(0);
    }
    const workspace = parseFlag('--workspace', args);
    const focus = canFocus && popSwitch('--focus', args);
    const asJSON = popSwitch('--json', args);
    const words = positionals(args);
    const tab = words.shift();
    rejectLeftoverArgs([...words, ...args], `kelpi tab ${verb}`, { usage: usagePrinter(usage) });
    requireTabOutsidePane(tab, verb, usage);
    const payload = scoped(command, workspace, tab);
    if (focus) payload['focus'] = true;
    const reply = await decodeReply(payload, `kelpi tab ${verb}`);
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    printLine(ack(reply));
}

async function handleTabRename(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(tabRenameUsage);
        exit(0);
    }
    const workspace = parseFlag('--workspace', args);
    const clear = popSwitch('--clear', args);
    const asJSON = popSwitch('--json', args);
    const words = positionals(args);
    rejectLeftoverArgs(args, 'kelpi tab rename', { usage: usagePrinter(tabRenameUsage) });
    // `rename <tab> <name>`, `rename <name>` (the caller's tab), `rename [<tab>] --clear`.
    let tab: string | undefined;
    let name: string | undefined;
    if (clear) {
        if (words.length > 1) rejectLeftoverArgs(words.slice(1), 'kelpi tab rename', { usage: usagePrinter(tabRenameUsage) });
        tab = words[0];
    } else if (words.length === 2) {
        [tab, name] = words;
    } else if (words.length === 1) {
        name = words[0];
    } else {
        if (words.length > 2) rejectLeftoverArgs(words.slice(2), 'kelpi tab rename', { usage: usagePrinter(tabRenameUsage) });
        writeErr(tabRenameUsage);
        exit(1);
    }
    requireTabOutsidePane(tab, 'rename', tabRenameUsage);
    const payload = scoped('workspace-tab-rename', workspace, tab);
    if (clear) payload['clear'] = true;
    else payload['name'] = name ?? '';
    const reply = await decodeReply(payload, 'kelpi tab rename');
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    const newName = asString(reply['name']);
    printLine(newName === undefined ? `${where(reply)} is named after its pane again` : `renamed ${where(reply)} to ${newName}`);
}

async function handleTabMove(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(tabMoveUsage);
        exit(0);
    }
    const workspace = parseFlag('--workspace', args);
    const to = position('--to', parseFlag('--to', args), 'move');
    const end = popSwitch('--end', args);
    const asJSON = popSwitch('--json', args);
    const words = positionals(args);
    const tab = words.shift();
    rejectLeftoverArgs([...words, ...args], 'kelpi tab move', { usage: usagePrinter(tabMoveUsage) });
    if ((to === undefined) === !end) {
        errLine('kelpi tab move: give exactly one of --to <n> or --end');
        writeErr(tabMoveUsage);
        exit(1);
    }
    requireTabOutsidePane(tab, 'move', tabMoveUsage);
    const payload = scoped('workspace-tab-move', workspace, tab);
    if (to !== undefined) payload['index'] = to;
    if (end) payload['at_end'] = true;
    const reply = await decodeReply(payload, 'kelpi tab move');
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    printLine(`moved to ${where(reply)}`);
}

async function handleTabMoveToWorkspace(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(tabMoveToWorkspaceUsage);
        exit(0);
    }
    const workspace = parseFlag('--workspace', args);
    const destination = parseFlag('--to-workspace', args);
    const focus = popSwitch('--focus', args);
    const asJSON = popSwitch('--json', args);
    const words = positionals(args);
    const tab = words.shift();
    rejectLeftoverArgs([...words, ...args], 'kelpi tab move-to-workspace', { usage: usagePrinter(tabMoveToWorkspaceUsage) });
    if (destination === null) {
        errLine('kelpi tab move-to-workspace: requires --to-workspace <name-or-id>');
        writeErr(tabMoveToWorkspaceUsage);
        exit(1);
    }
    requireTabOutsidePane(tab, 'move-to-workspace', tabMoveToWorkspaceUsage);
    const payload = scoped('workspace-tab-move-to-workspace', workspace, tab);
    payload['to_workspace'] = destination;
    if (focus) payload['focus'] = true;
    const reply = await decodeReply(payload, 'kelpi tab move-to-workspace');
    if (asJSON) {
        printReplyWithoutOk(reply);
        return;
    }
    printLine(`moved to ${where(reply)}`);
}
