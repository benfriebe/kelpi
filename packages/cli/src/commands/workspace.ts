/**
 * `kelpi workspace …` (cli.md §10).
 *
 * Three shapes of output live here and scripts depend on all three staying distinct:
 *   - `list` unwraps the array;
 *   - `create` and `label` print the FULL reply including `ok`;
 *   - `delete` prints a bespoke per-id record array, and exits 1 when any DELETE failed
 *     (a failed *prune* is a warning, never an exit code — the workspace is gone either way).
 *
 * `--prune-worktree` is the one place the CLI shells out to git on the caller's machine: it
 * keys off the `path` the delete reply carries (a shell pane's current cwd) and runs a
 * deliberately NON-forcing `git worktree remove`, so a dirty or locked worktree is refused by
 * git and reported as a warning rather than losing someone's uncommitted work.
 */

import path from 'node:path';

import { hasHelpFlag, isHelpToken, parseFlag, parseFlagAll, parseIntStrict, popSwitch, rejectLeftoverArgs } from '../args.js';
import { errLine, exit, printLine, writeErr, writeOut } from '../io.js';
import { asBool, asInt, asString, asStringArray, stableStringify, type JsonObject, type JsonValue } from '../json.js';
import { runProcess, type ProcessRunner } from '../proc.js';
import { decodeReply, decodeReplyAllowingFailure } from '../reply.js';
import { printWorkspaceTable, replyArray } from '../table.js';
import { sendJSON } from '../transport.js';
import {
    workspaceCreateUsage,
    workspaceDeleteUsage,
    workspaceLabelUsage,
    workspaceListUsage,
    workspaceMoveUsage,
    workspaceProfileUsage,
    workspaceUsage
} from '../usage.js';

export async function handleWorkspace(args: string[]): Promise<void> {
    const action = args.shift();
    if (action === undefined) {
        writeErr(workspaceUsage);
        exit(1);
    }
    if (isHelpToken(action)) {
        writeOut(workspaceUsage);
        exit(0);
    }

    switch (action) {
        case 'list':
            return handleWorkspaceList(args);
        case 'create':
            return handleWorkspaceCreate(args);
        case 'move':
            return handleWorkspaceMove(args);
        case 'delete':
            return handleWorkspaceDelete(args);
        case 'profile':
            return handleWorkspaceProfile(args);
        case 'label':
            return handleWorkspaceLabel(args);
        default:
            errLine(`Unknown workspace action: ${action}`);
            errLine('Valid actions: list, create, move, delete, profile, label');
            exit(1);
    }
}

async function handleWorkspaceList(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceListUsage);
        exit(0);
    }
    const asJSON = popSwitch('--json', args);
    const noHeader = popSwitch('--no-header', args);
    const group = parseFlag('--group', args);
    rejectLeftoverArgs(args, 'kelpi workspace list', { usage: (write) => write(workspaceListUsage) });

    const payload: JsonObject = { command: 'workspace-list' };
    if (group !== null) payload['group'] = group;
    const reply = await decodeReply(payload, 'kelpi workspace list');
    const workspaces = replyArray(reply, 'workspaces');
    if (asJSON) {
        printLine(stableStringify(workspaces));
        return;
    }
    printWorkspaceTable(workspaces, noHeader);
}

async function handleWorkspaceCreate(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceCreateUsage);
        exit(0);
    }
    const name = parseFlag('--name', args);
    const dir = parseFlag('--path', args);
    const color = parseFlag('--color', args);
    const group = parseFlag('--group', args);
    const profile = parseFlag('--profile', args);
    const worktree = parseFlag('--worktree', args);
    const branch = parseFlag('--branch', args);
    const repo = parseFlag('--repo', args);
    const updateMain = popSwitch('--update-main', args);
    const asJSON = popSwitch('--json', args);
    rejectLeftoverArgs(args, 'kelpi workspace create', { usage: (write) => write(workspaceCreateUsage) });

    const payload: JsonObject = { command: 'workspace-create' };
    if (name !== null) payload['name'] = name;
    if (dir !== null) payload['path'] = dir;
    if (color !== null) payload['color'] = color;
    if (group !== null) payload['group'] = group;
    if (profile !== null) payload['profile'] = profile;
    if (worktree !== null) {
        payload['worktree'] = worktree;
        if (branch !== null) payload['branch'] = branch;
        if (updateMain) payload['update_main'] = true;
        // Always send the source repo so the daemon can branch from it; default to the cwd.
        payload['repo'] = repo ?? process.cwd();
    }

    // `git worktree add` (plus a network fetch with --update-main) runs well past the 5s
    // default, and a slow-but-succeeding create must not read as a failure.
    const reply = await decodeReply(
        payload,
        'kelpi workspace create',
        worktree !== null ? { timeoutSeconds: 120 } : {}
    );
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const workspaceName = asString(reply['workspace_name']) ?? name ?? 'Workspace';
    const workspaceID = asString(reply['workspace_id']) ?? '?';
    const worktreePath = asString(reply['worktree_path']);
    const groupName = asString(reply['group']);
    if (worktreePath !== undefined) {
        const resolvedBranch = asString(reply['branch']) ?? '?';
        const inGroup = groupName !== undefined ? ` in group ${groupName}` : '';
        printLine(
            `created workspace ${workspaceName} (${workspaceID})${inGroup} with worktree ${worktreePath} on branch ${resolvedBranch}`
        );
    } else if (groupName !== undefined) {
        printLine(`created workspace ${workspaceName} (${workspaceID}) in group ${groupName}`);
    } else {
        printLine(`created workspace ${workspaceName} (${workspaceID})`);
    }
}

async function handleWorkspaceMove(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceMoveUsage);
        exit(0);
    }
    const nameOrID = args.shift();
    if (nameOrID === undefined) {
        writeErr(workspaceMoveUsage);
        exit(1);
    }
    const group = parseFlag('--group', args);
    const topLevel = popSwitch('--top-level', args);
    const indexRaw = parseFlag('--index', args);

    if (group === null && !topLevel) {
        errLine('workspace move requires --group <name> or --top-level');
        exit(1);
    }
    if (group !== null && topLevel) {
        errLine("workspace move can't take both --group and --top-level");
        exit(1);
    }

    const payload: JsonObject = { command: 'workspace-move', name: nameOrID };
    // `--top-level` is expressed by OMITTING `group` entirely.
    if (group !== null) payload['group'] = group;
    if (indexRaw !== null) {
        const index = parseIntStrict(indexRaw);
        if (index === null) {
            errLine('--index must be an integer');
            exit(1);
        }
        payload['index'] = index;
    }
    await sendJSON(payload);
}

export interface DeleteOptions {
    /** Injected in tests so the prune can be exercised without a real repo. */
    readonly runner?: ProcessRunner | undefined;
}

async function handleWorkspaceDelete(args: string[], options: DeleteOptions = {}): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceDeleteUsage);
        exit(0);
    }
    // Popped unconditionally so both are consumed when passed together.
    const forceFlag = popSwitch('--force', args);
    const yFlag = popSwitch('-y', args);
    const force = forceFlag || yFlag;
    const prune = popSwitch('--prune-worktree', args);
    const asJSON = popSwitch('--json', args);

    const bad = args.find((token) => token.startsWith('-'));
    if (bad !== undefined) {
        errLine(`Unknown option for workspace delete: ${bad}`);
        errLine(
            'Usage: kelpi workspace delete <name-or-id> [<name-or-id> ...] [--force|-y] [--prune-worktree] [--json]'
        );
        exit(1);
    }
    // Dedupe exact duplicates, first-seen order, so a repeated argument does not resolve to
    // "not found" the second time.
    const ids = [...new Set(args)];
    if (ids.length === 0) {
        errLine(
            'Usage: kelpi workspace delete <name-or-id> [<name-or-id> ...] [--force|-y] [--prune-worktree] [--json]'
        );
        exit(1);
    }

    const results: JsonObject[] = [];
    let anyFailed = false;
    for (const id of ids) {
        const reply = await decodeReplyAllowingFailure(
            { command: 'workspace-delete', name: id, force },
            'kelpi workspace delete'
        );
        const ok = asBool(reply['ok']) ?? false;
        const workspaceName = asString(reply['workspace_name']) ?? id;
        const record: JsonObject = { id, ok };

        if (ok) {
            const workspaceID = asString(reply['workspace_id']);
            if (workspaceID !== undefined) record['workspace_id'] = workspaceID;
            record['workspace_name'] = workspaceName;
            const workspacePath = asString(reply['path']);
            if (workspacePath !== undefined) record['path'] = workspacePath;

            if (!asJSON) printLine(`deleted workspace ${workspaceName}`);

            if (prune) {
                if (workspacePath !== undefined) {
                    const { removed, message } = await pruneWorktree(workspacePath, options.runner ?? runProcess);
                    record['worktree_pruned'] = removed;
                    if (!removed) record['worktree_error'] = message;
                    if (!asJSON) {
                        if (removed) printLine(`  ${message}`);
                        else errLine(`Warning: ${message}`);
                    }
                } else {
                    const message = `workspace ${workspaceName} had no panes; no directory to prune`;
                    record['worktree_pruned'] = false;
                    record['worktree_error'] = message;
                    if (!asJSON) errLine(`Warning: ${message}`);
                }
            }
        } else {
            anyFailed = true;
            const error = asString(reply['error']) ?? 'unknown error';
            record['error'] = error;
            const activeAgents = asInt(reply['active_agents']);
            if (activeAgents !== undefined) record['active_agents'] = activeAgents;
            if (!asJSON) errLine(`kelpi workspace delete: ${error}`);
        }
        results.push(record);
    }

    if (asJSON) printLine(stableStringify(results as unknown as JsonValue));
    if (anyFailed) exit(1);
}

/**
 * Best-effort `git worktree remove` for a just-deleted workspace's directory.
 * Non-forcing on purpose: git refuses a dirty or locked worktree and the primary checkout,
 * and every refusal comes back as a message the caller renders as a `Warning:` with git's own
 * stderr folded in. The workspace stays deleted regardless.
 */
export async function pruneWorktree(
    directory: string,
    run: ProcessRunner = runProcess
): Promise<{ readonly removed: boolean; readonly message: string }> {
    const env = '/usr/bin/env';
    const top = await run(env, ['git', '-C', directory, 'rev-parse', '--show-toplevel']);
    if (top.exitCode !== 0) {
        const detail = top.stderr.trim();
        return {
            removed: false,
            message: `not a git worktree, skipped prune: ${directory}${detail.length === 0 ? '' : ` (${detail})`}`
        };
    }
    const root = top.stdout.trim();

    // Run the removal from the MAIN worktree so git is not invoked inside the tree it is
    // removing. `--git-common-dir` is `<main>/.git`; its parent is the main worktree.
    const common = await run(env, [
        'git',
        '-C',
        directory,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir'
    ]);
    const runDir = common.exitCode === 0 ? path.dirname(common.stdout.trim()) : root;

    const removal = await run(env, ['git', '-C', runDir, 'worktree', 'remove', root]);
    if (removal.exitCode === 0) return { removed: true, message: `removed worktree: ${root}` };
    const detail = removal.stderr.trim();
    return {
        removed: false,
        message: `git worktree remove failed for ${root}${detail.length === 0 ? '' : `: ${detail}`}`
    };
}

async function handleWorkspaceProfile(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceProfileUsage);
        exit(0);
    }
    const nameOrID = args.shift();
    if (nameOrID === undefined) {
        writeErr(workspaceProfileUsage);
        exit(1);
    }
    const clear = popSwitch('--clear', args);
    const profile = args.shift();
    if (clear === (profile !== undefined)) {
        errLine('workspace profile requires either <profile> or --clear');
        exit(1);
    }
    if (args.length > 0) {
        errLine(`workspace profile: unexpected argument(s): ${args.join(' ')}`);
        exit(1);
    }
    const payload: JsonObject = { command: 'workspace-profile', name: nameOrID };
    // `--clear` omits `profile` entirely; the server treats missing/empty as "clear".
    if (profile !== undefined) payload['profile'] = profile;
    await sendJSON(payload);
}

async function handleWorkspaceLabel(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceLabelUsage);
        exit(0);
    }
    const nameOrID = args.shift();
    if (nameOrID === undefined) {
        writeErr(workspaceLabelUsage);
        exit(1);
    }
    const setValues = parseFlagAll('--set', args);
    const addValues = parseFlagAll('--add', args);
    const removeValues = parseFlagAll('--remove', args);
    const clear = popSwitch('--clear', args);
    const asJSON = popSwitch('--json', args);
    if (args.includes('--style')) {
        errLine('workspace label: --style is not yet supported; set label colors in Settings ▸ Labels');
        exit(1);
    }
    rejectLeftoverArgs(args, 'kelpi workspace label', { usage: (write) => write(workspaceLabelUsage) });

    const operations = [setValues.length > 0, addValues.length > 0, removeValues.length > 0, clear].filter(Boolean).length;
    if (operations !== 1) {
        errLine('workspace label requires exactly one of --set / --add / --remove / --clear');
        exit(1);
    }

    let op = 'clear';
    let values: string[] = [];
    if (clear) {
        op = 'clear';
    } else if (setValues.length > 0) {
        op = 'set';
        values = setValues;
    } else if (addValues.length > 0) {
        op = 'add';
        values = addValues;
    } else {
        op = 'remove';
        values = removeValues;
    }

    const reply = await decodeReply(
        { command: 'workspace-label', name: nameOrID, label_op: op, label_values: values },
        'kelpi workspace label'
    );
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const workspaceName = asString(reply['workspace_name']) ?? nameOrID;
    const labels = asStringArray(reply['labels']) ?? [];
    printLine(`${workspaceName} labels: ${labels.length === 0 ? '(none)' : labels.join(', ')}`);
}
