/**
 * `kelpi graft start|stop|status` (cli.md §14).
 *
 * Two renderings that look like error handling but are not:
 *   - `start` with a `partial_error` prints `Partial failure: …` to STDERR and still exits 0 —
 *     a scope holding two associations of one parent starts the first and reports the second;
 *   - `stop` with a non-empty `failed` list prints each entry to stderr and exits 1.
 *
 * The graft help block goes to stderr (a shipped quirk) and still exits 0.
 */

import { popSwitch, parseFlag } from '../args.js';
import { rawPaneID } from '../env.js';
import { errLine, exit, printLine, writeErr } from '../io.js';
import { asString, stableStringify, type JsonObject } from '../json.js';
import { decodeReply } from '../reply.js';
import { replyArray } from '../table.js';
import { graftUsage } from '../usage.js';

export async function handleGraft(args: string[]): Promise<void> {
    const action = args.shift();
    if (action === undefined) {
        errLine('Usage: kelpi graft start|stop|status');
        exit(1);
    }
    switch (action) {
        case 'start':
            return handleGraftCommand('graft-start', args);
        case 'stop':
            return handleGraftCommand('graft-stop', args);
        case 'status':
            return handleGraftStatus(args);
        case '-h':
        case '--help':
        case 'help':
            // Deliberately stderr, and a plain return (exit 0).
            writeErr(graftUsage);
            return;
        default:
            errLine(`Unknown graft action: ${action}`);
            errLine('Valid actions: start, stop, status');
            exit(1);
    }
}

async function handleGraftCommand(command: string, args: string[]): Promise<void> {
    const workspace = parseFlag('--workspace', args);
    const repo = parseFlag('--repo', args);

    const payload: JsonObject = { command };
    if (workspace !== null) payload['workspace'] = workspace;
    if (repo !== null) payload['repo'] = repo;
    // With NEITHER filter the default scope is the caller's workspace.
    if (workspace === null && repo === null) {
        const paneID = rawPaneID();
        if (paneID !== undefined) payload['pane_id'] = paneID;
    }

    const reply = await decodeReply(payload, `kelpi ${command}`);

    if (command === 'graft-start') {
        const started = replyArray(reply, 'started');
        if (started.length === 0) {
            printLine('No associations started.');
        } else {
            for (const entry of started) {
                const association = asString(entry['association_id']) ?? '-';
                const branch = asString(entry['branch']) ?? '-';
                const worktreePath = asString(entry['worktree_path']) ?? '-';
                printLine(`started ${branch} (${association}) at ${worktreePath}`);
            }
        }
        const partial = asString(reply['partial_error']);
        if (partial !== undefined) errLine(`Partial failure: ${partial}`);
        return;
    }

    const stopped = Array.isArray(reply['stopped'])
        ? (reply['stopped'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [];
    if (stopped.length === 0) {
        printLine('No active sessions in scope.');
    } else {
        for (const id of stopped) printLine(`stopped ${id}`);
    }
    const failed = replyArray(reply, 'failed');
    if (failed.length > 0) {
        for (const entry of failed) {
            errLine(`failed ${asString(entry['association_id']) ?? '?'}: ${asString(entry['error']) ?? '?'}`);
        }
        exit(1);
    }
}

async function handleGraftStatus(args: string[]): Promise<void> {
    const asJSON = popSwitch('--json', args);
    const reply = await decodeReply({ command: 'graft-status' }, 'kelpi graft status');
    const sessions = replyArray(reply, 'sessions');
    if (asJSON) {
        printLine(stableStringify(sessions));
        return;
    }
    if (sessions.length === 0) {
        printLine('No active graft sessions.');
        return;
    }
    for (const session of sessions) {
        const branch = asString(session['branch']) ?? '-';
        const worktreePath = asString(session['worktree_path']) ?? '-';
        const status = asString(session['status']) ?? '-';
        printLine(`${branch} [${status}] ${worktreePath}`);
    }
}
