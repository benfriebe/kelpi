/**
 * `kelpi group …` (cli.md §11).
 *
 * `create` / `rename` / `delete` are fire-and-forget: exit 0 with no output whether or not the
 * argument resolved, so every assertion about them goes through a following `group list`.
 * `reorder` / `sort` are request/response and share one renderer, whose `--json` prints the
 * FULL reply including `ok` (unlike the pane family, which strips it).
 */

import { hasHelpFlag, isHelpToken, parseFlag, popSwitch, rejectLeftoverArgs } from '../args.js';
import { errLine, exit, printLine, writeErr, writeOut } from '../io.js';
import { asString, asStringArray, stableStringify, type JsonObject } from '../json.js';
import { decodeReply } from '../reply.js';
import { printGroupTable, replyArray } from '../table.js';
import { sendJSON } from '../transport.js';
import { groupReorderUsage, groupSortUsage, groupUsage } from '../usage.js';

export async function handleGroup(args: string[]): Promise<void> {
    const action = args.shift();
    if (action === undefined) {
        errLine('Usage: kelpi group list|create|rename|delete|reorder|sort [...]');
        exit(1);
    }
    if (isHelpToken(action)) {
        writeOut(groupUsage);
        exit(0);
    }

    switch (action) {
        case 'list':
            return handleGroupList(args);
        case 'create':
            return handleGroupCreate(args);
        case 'rename':
            return handleGroupRename(args);
        case 'delete':
            return handleGroupDelete(args);
        case 'reorder':
            return handleGroupReorder(args);
        case 'sort':
            return handleGroupSort(args);
        default:
            errLine(`Unknown group action: ${action}`);
            errLine('Valid actions: list, create, rename, delete, reorder, sort');
            exit(1);
    }
}

async function handleGroupList(args: string[]): Promise<void> {
    const asJSON = popSwitch('--json', args);
    const noHeader = popSwitch('--no-header', args);
    if (args.length > 0) {
        errLine('Usage: kelpi group list [--json] [--no-header]');
        exit(1);
    }
    const reply = await decodeReply({ command: 'group-list' }, 'kelpi group list');
    const groups = replyArray(reply, 'groups');
    if (asJSON) {
        printLine(stableStringify(groups));
        return;
    }
    printGroupTable(groups, noHeader);
}

async function handleGroupCreate(args: string[]): Promise<void> {
    const name = args.shift();
    if (name === undefined) {
        errLine('Usage: kelpi group create <name> [--color blue]');
        exit(1);
    }
    const color = parseFlag('--color', args);
    const payload: JsonObject = { command: 'group-create', name };
    if (color !== null) payload['color'] = color;
    await sendJSON(payload);
}

async function handleGroupRename(args: string[]): Promise<void> {
    const nameOrID = args.shift();
    const newName = args.shift();
    if (nameOrID === undefined || newName === undefined) {
        errLine('Usage: kelpi group rename <name-or-id> <new-name>');
        exit(1);
    }
    await sendJSON({ command: 'group-rename', name: nameOrID, new_name: newName });
}

async function handleGroupDelete(args: string[]): Promise<void> {
    const nameOrID = args.shift();
    if (nameOrID === undefined) {
        errLine('Usage: kelpi group delete <name-or-id> [--cascade]');
        exit(1);
    }
    const cascade = popSwitch('--cascade', args);
    // `cascade` is always present as a native JSON boolean.
    await sendJSON({ command: 'group-delete', name: nameOrID, cascade });
}

async function handleGroupReorder(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(groupReorderUsage);
        exit(0);
    }
    const nameOrID = args.shift();
    if (nameOrID === undefined) {
        writeErr(groupReorderUsage);
        exit(1);
    }
    const orderRaw = parseFlag('--order', args);
    if (orderRaw === null) {
        errLine('group reorder requires --order <id1,id2,...>');
        exit(1);
    }
    const asJSON = popSwitch('--json', args);
    rejectLeftoverArgs(args, 'kelpi group reorder', { usage: (write) => write(groupReorderUsage) });

    // Comma- and/or space-separated, empties dropped.
    const order = orderRaw.split(/[, ]/).filter((token) => token.length > 0);
    if (order.length === 0) {
        errLine('group reorder: --order was empty');
        exit(1);
    }
    const reply = await decodeReply(
        { command: 'group-reorder', name: nameOrID, order },
        'kelpi group reorder'
    );
    printGroupOrderReply(reply, asJSON);
}

async function handleGroupSort(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(groupSortUsage);
        exit(0);
    }
    const nameOrID = args.shift();
    if (nameOrID === undefined) {
        writeErr(groupSortUsage);
        exit(1);
    }
    const by = parseFlag('--by', args);
    if (by === null) {
        errLine('group sort requires --by name|last-activity|last-accessed');
        exit(1);
    }
    const descending = popSwitch('--desc', args);
    const asJSON = popSwitch('--json', args);
    rejectLeftoverArgs(args, 'kelpi group sort', { usage: (write) => write(groupSortUsage) });

    const reply = await decodeReply(
        { command: 'group-sort', name: nameOrID, by, descending },
        'kelpi group sort'
    );
    printGroupOrderReply(reply, asJSON);
}

/** Shared by reorder/sort: full reply with `--json`, else the new order in full ids. */
export function printGroupOrderReply(reply: JsonObject, asJSON: boolean): void {
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const groupName = asString(reply['group_name']) ?? '?';
    const order = asStringArray(reply['order']) ?? [];
    printLine(`group ${groupName} order: ${order.join(', ')}`);
}
