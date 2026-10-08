/**
 * `kelpi workspace …` (cli.md §10).
 *
 * Three shapes of output live here and scripts depend on all three staying distinct:
 *   - `list` unwraps the array;
 *   - `create`, `label`, `mute`, `rename` and `icon` print the FULL reply including `ok` under
 *     `--json`;
 *   - `delete` prints a bespoke per-id record array, and exits 1 when any DELETE failed
 *     (a failed *prune* is a warning, never an exit code: the workspace is gone either way).
 *
 * `--prune-worktree` asks the DAEMON to remove the worktrees Kelpi made for the workspace
 * (`prune_worktrees`, graft-git.md §8.7): it runs git on its own host, which is where the
 * worktrees are, from the workspace's repo associations and the worktree its shell was in, and
 * never forcing, so a dirty or locked worktree is kept and reported as a warning. Only a daemon that
 * predates the field (its reply has no `worktrees`) falls back to the old CLI-side prune of the
 * reply's `path`.
 */

import path from 'node:path';

import { normalizeIconEmoji } from '@kelpi/core/codec';

import {
    absoluteUserPath,
    hasHelpFlag,
    isHelpToken,
    parseFlag,
    parseFlagAll,
    parseIntStrict,
    popSwitch,
    rejectLeftoverArgs
} from '../args.js';
import { errLine, exit, printLine, writeErr, writeOut } from '../io.js';
import { asBool, asInt, asString, asStringArray, stableStringify, type JsonObject, type JsonValue } from '../json.js';
import { runProcess, type ProcessRunner } from '../proc.js';
import { decodeReply, decodeReplyAllowingFailure } from '../reply.js';
import { printWorkspaceTable, replyArray } from '../table.js';
import { sendJSON } from '../transport.js';
import {
    workspaceCreateUsage,
    workspaceDeleteUsage,
    workspaceIconUsage,
    workspaceLabelUsage,
    workspaceListUsage,
    workspaceMoveUsage,
    workspaceMuteUsage,
    workspaceProfileUsage,
    workspaceRenameUsage,
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
        case 'mute':
            return handleWorkspaceMute(args);
        case 'rename':
            return handleWorkspaceRename(args);
        case 'icon':
            return handleWorkspaceIcon(args);
        default:
            errLine(`Unknown workspace action: ${action}`);
            errLine('Valid actions: list, create, move, delete, profile, label, mute, rename, icon');
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
    const noRepo = popSwitch('--no-repo', args);
    const updateMain = popSwitch('--update-main', args);
    const noUpdateMain = popSwitch('--no-update-main', args);
    const muted = popSwitch('--muted', args);
    const iconFlag = parseFlag('--icon', args);
    const asJSON = popSwitch('--json', args);
    rejectLeftoverArgs(args, 'kelpi workspace create', { usage: (write) => write(workspaceCreateUsage) });
    const icon = iconFlag === null ? null : wireIcon(iconFlag, 'kelpi workspace create');
    if (updateMain && noUpdateMain) {
        errLine("workspace create can't take both --update-main and --no-update-main");
        exit(1);
    }
    if (repo !== null && noRepo) {
        errLine("workspace create can't take both --repo and --no-repo");
        exit(1);
    }

    const payload: JsonObject = { command: 'workspace-create' };
    if (name !== null) payload['name'] = name;
    // Absolute here, like --repo: the daemon's cwd is not the shell's, and with --group
    // --worktree on a repo-less group this path is the worktree's source repo.
    if (dir !== null) payload['path'] = absoluteUserPath(dir);
    if (color !== null) payload['color'] = color;
    if (group !== null) payload['group'] = group;
    if (profile !== null) payload['profile'] = profile;
    if (muted) payload['muted'] = true;
    if (icon !== null) payload['icon'] = icon;
    // app-state-core.md §5.5: an explicit repo is associated even without --worktree, and
    // --no-repo is the one-off opt-out from the group's default repository.
    // Made absolute here: a relative path means the shell's cwd, not the daemon's.
    if (repo !== null) payload['repo'] = absoluteUserPath(repo);
    if (noRepo) payload['group_defaults'] = false;
    if (worktree !== null) {
        payload['worktree'] = worktree;
        if (branch !== null) payload['branch'] = branch;
        // Only an explicit flag is sent: absent lets a group whose worktree switch is on make
        // update main the default, which `--no-update-main` then opts out of.
        if (updateMain) payload['update_main'] = true;
        if (noUpdateMain) payload['update_main'] = false;
        if (repo === null) {
            if (group !== null && !noRepo) {
                // Leave the source to the group's default repository, with the cwd as the
                // fallback the daemon reaches for when the group has none (`repo ?? group ?? path`).
                if (dir === null) payload['path'] = process.cwd();
            } else {
                // No group to defer to: the source repo is the cwd, as it always was.
                payload['repo'] = process.cwd();
            }
        }
    }

    // `git worktree add` (plus a network fetch with --update-main) runs well past the 5s
    // default, and a slow-but-succeeding create must not read as a failure. A create that
    // associates a repository (explicitly, or the group's) reads git too, though only briefly.
    const reply = await decodeReply(
        payload,
        'kelpi workspace create',
        worktree !== null ? { timeoutSeconds: 120 } : repo !== null || group !== null ? { timeoutSeconds: 30 } : {}
    );
    const workspaceName = asString(reply['workspace_name']) ?? name ?? 'Workspace';
    const workspaceID = asString(reply['workspace_id']) ?? '?';
    // A daemon that predates `muted` drops the field and creates the workspace unmuted, which is
    // the one outcome a conductor spawning quiet children must not miss: say so and fail.
    if (muted && asBool(reply['muted']) !== true) {
        if (asJSON) printLine(stableStringify(reply));
        errLine(
            `kelpi workspace create: the daemon did not apply --muted; restart it on this build ` +
                `(workspace ${workspaceName} (${workspaceID}) was created unmuted)`
        );
        exit(1);
    }
    // The same for `icon`: an older daemon ignores the key and leaves the first letter.
    if (icon !== null && asString(reply['icon']) !== icon) {
        if (asJSON) printLine(stableStringify(reply));
        errLine(
            `kelpi workspace create: the daemon did not apply --icon; restart it on this build ` +
                `(workspace ${workspaceName} (${workspaceID}) was created without an icon)`
        );
        exit(1);
    }
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const worktreePath = asString(reply['worktree_path']);
    const groupName = asString(reply['group']);
    const inGroup = groupName !== undefined ? ` in group ${groupName}` : '';
    if (worktreePath !== undefined) {
        const resolvedBranch = asString(reply['branch']) ?? '?';
        // §5.5: a group's switch can choose update main on the caller's behalf, so say so.
        const fromMain = asBool(reply['update_main']) === true ? ' off the latest main' : '';
        printLine(
            `created workspace ${workspaceName} (${workspaceID})${inGroup} with worktree ${worktreePath} on branch ${resolvedBranch}${fromMain}`
        );
        return;
    }
    const repoPath = asString(reply['repo_path']);
    const withRepo = repoPath !== undefined ? ` with repo ${repoPath}` : '';
    printLine(`created workspace ${workspaceName} (${workspaceID})${inGroup}${withRepo}`);
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
    const deleteBranch = popSwitch('--delete-branch', args);
    const asJSON = popSwitch('--json', args);

    const bad = args.find((token) => token.startsWith('-'));
    if (bad !== undefined) {
        errLine(`Unknown option for workspace delete: ${bad}`);
        errLine(DELETE_USAGE_LINE);
        exit(1);
    }
    if (deleteBranch && !prune) {
        errLine('--delete-branch requires --prune-worktree');
        errLine(DELETE_USAGE_LINE);
        exit(1);
    }
    // Dedupe exact duplicates, first-seen order, so a repeated argument does not resolve to
    // "not found" the second time.
    const ids = [...new Set(args)];
    if (ids.length === 0) {
        errLine(DELETE_USAGE_LINE);
        exit(1);
    }

    const results: JsonObject[] = [];
    let anyFailed = false;
    for (const id of ids) {
        const reply = await decodeReplyAllowingFailure(
            {
                command: 'workspace-delete',
                name: id,
                force,
                ...(prune ? { prune_worktrees: true } : {}),
                ...(deleteBranch ? { delete_branches: true } : {})
            },
            'kelpi workspace delete',
            // The prune's reply waits for git, and removing a worktree deletes every file in it
            // (a `node_modules` is a lot of files): well past the 5 s default.
            prune ? { timeoutSeconds: PRUNE_TIMEOUT_SECONDS } : {}
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

            const worktrees = reply['worktrees'];
            if (prune && Array.isArray(worktrees)) {
                recordDaemonPrune(record, workspaceName, worktrees, asJSON);
            } else if (prune) {
                // A daemon that predates `prune_worktrees`: the old CLI-side prune of `path`.
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
            for (const key of ['active_agents', 'running', 'waiting', 'inactive']) {
                const count = asInt(reply[key]);
                if (count !== undefined) record[key] = count;
            }
            if (!asJSON) errLine(`kelpi workspace delete: ${error}`);
        }
        results.push(record);
    }

    if (asJSON) printLine(stableStringify(results as unknown as JsonValue));
    if (anyFailed) exit(1);
}

const DELETE_USAGE_LINE =
    'Usage: kelpi workspace delete <name-or-id> [<name-or-id> ...] [--force|-y] [--prune-worktree [--delete-branch]] [--json]';

/** How long a `--prune-worktree` delete waits for the daemon's git work. */
const PRUNE_TIMEOUT_SECONDS = 300;

/**
 * Fold the daemon's per-worktree results (`worktrees`, wire-protocol.md §6.3) into the record
 * and the human output. `worktree_pruned` / `worktree_error` keep the meaning scripts read:
 * true only when every linked worktree went, with every reason it did not otherwise.
 */
function recordDaemonPrune(record: JsonObject, workspaceName: string, worktrees: readonly unknown[], asJSON: boolean): void {
    const entries = worktrees.filter((entry): entry is JsonObject => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
    record['worktrees'] = entries;
    if (entries.length === 0) {
        const message = `workspace ${workspaceName} has no worktree Kelpi created to prune`;
        record['worktree_pruned'] = false;
        record['worktree_error'] = message;
        if (!asJSON) errLine(`Warning: ${message}`);
        return;
    }
    const errors: string[] = [];
    for (const entry of entries) {
        const worktreePath = asString(entry['worktree_path']) ?? asString(entry['association_id']) ?? '?';
        const branch = asString(entry['branch']);
        if (asBool(entry['removed']) === true) {
            if (!asJSON) printLine(`  removed worktree: ${worktreePath}`);
            if (asBool(entry['branch_deleted']) === true && branch !== undefined && !asJSON) {
                printLine(`  deleted branch: ${branch}`);
            }
            const branchError = asString(entry['branch_error']);
            if (branchError !== undefined && branch !== undefined && !asJSON) {
                errLine(`Warning: kept branch ${branch}: ${branchError}`);
            }
        } else {
            const message = `worktree ${worktreePath} not removed: ${asString(entry['error']) ?? 'unknown error'}`;
            errors.push(message);
            if (!asJSON) errLine(`Warning: ${message}`);
        }
    }
    record['worktree_pruned'] = errors.length === 0;
    if (errors.length > 0) record['worktree_error'] = errors.join('; ');
}

/**
 * Best-effort `git worktree remove` for a just-deleted workspace's directory: the fallback for
 * a daemon too old to prune on its own host (its delete reply has no `worktrees`).
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

async function handleWorkspaceMute(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceMuteUsage);
        exit(0);
    }
    const off = popSwitch('--off', args);
    const toggle = popSwitch('--toggle', args);
    const asJSON = popSwitch('--json', args);
    if (off && toggle) {
        errLine("workspace mute can't take both --off and --toggle");
        exit(1);
    }
    const nameOrID = args.shift();
    if (nameOrID === undefined || nameOrID.startsWith('-')) {
        if (nameOrID !== undefined) errLine(`kelpi workspace mute: unknown option ${nameOrID}`);
        writeErr(workspaceMuteUsage);
        exit(1);
    }
    rejectLeftoverArgs(args, 'kelpi workspace mute', { usage: (write) => write(workspaceMuteUsage) });

    const payload: JsonObject = { command: 'workspace-mute', name: nameOrID };
    // `--toggle` omits `muted`: the daemon flips the live state and reports the result.
    if (!toggle) payload['muted'] = !off;
    const reply = await decodeReply(payload, 'kelpi workspace mute');
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const workspaceName = asString(reply['workspace_name']) ?? nameOrID;
    const muted = asBool(reply['muted']) ?? false;
    printLine(`${workspaceName}: notifications ${muted ? 'muted' : 'unmuted'}`);
}

/**
 * `kelpi workspace rename` (cli.md §10.8): the sidebar's inline rename, for agents. Unlike the
 * fire-and-forget `group rename` it waits for the reply, so a name that does not resolve (or
 * resolves to two workspaces) exits 1 with the daemon's reason instead of silently doing nothing.
 */
async function handleWorkspaceRename(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceRenameUsage);
        exit(0);
    }
    const asJSON = popSwitch('--json', args);
    const nameOrID = args.shift();
    const newName = args.shift();
    for (const positional of [nameOrID, newName]) {
        // Checked after trimming, the same trim the new name gets below: `' -draft'` would
        // otherwise slip past as a name and become `-draft`, a workspace named like a flag.
        if (positional !== undefined && positional.trim().startsWith('-')) {
            errLine(`kelpi workspace rename: unknown option ${positional}`);
            writeErr(workspaceRenameUsage);
            exit(1);
        }
    }
    if (nameOrID === undefined || newName === undefined) {
        writeErr(workspaceRenameUsage);
        exit(1);
    }
    rejectLeftoverArgs(args, 'kelpi workspace rename', {
        usage: (write) => write(workspaceRenameUsage),
        positionalHint: 'quote a new name that contains spaces'
    });
    // The daemon refuses this too; saying so here spares the round trip and names the argument.
    const trimmed = newName.trim();
    if (trimmed === '') {
        errLine('kelpi workspace rename: the new name cannot be empty');
        exit(1);
    }

    const reply = await decodeReply(
        { command: 'workspace-rename', name: nameOrID, new_name: trimmed },
        'kelpi workspace rename'
    );
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const workspaceID = asString(reply['workspace_id']) ?? '?';
    const workspaceName = asString(reply['workspace_name']) ?? trimmed;
    const oldName = asString(reply['old_name']) ?? nameOrID;
    printLine(
        oldName === workspaceName
            ? `workspace ${workspaceName} (${workspaceID}) already has that name`
            : `renamed workspace ${oldName} to ${workspaceName} (${workspaceID})`
    );
}

/**
 * The wire spelling of an icon typed on the command line: `emoji:<grapheme>`, after the check the
 * daemon (and the GUI's emoji sheet) makes, so a typo exits 1 here with the argument named. The
 * CLI takes the bare emoji only; a literal `emoji:🔥` or `system:star` is refused like any other
 * text, since nothing a script needs is missing without them.
 */
function wireIcon(value: string, command: string): string {
    const trimmed = value.trim();
    if (trimmed === '') {
        errLine(`${command}: the icon cannot be empty`);
        exit(1);
    }
    // `normalizeIconEmoji` keeps the FIRST grapheme, so two emoji come back as one: equality is
    // what refuses them, as it is daemon-side.
    if (normalizeIconEmoji(trimmed) !== trimmed) {
        errLine(`${command}: '${trimmed}' is not a usable icon: give one emoji or symbol`);
        exit(1);
    }
    return `emoji:${trimmed}`;
}

/**
 * `kelpi workspace icon` (cli.md §10.9): the sidebar's Change Icon / Reset to Letter, for agents.
 * Request/response like `workspace rename`, so a name that does not resolve exits 1 with the
 * daemon's reason.
 */
async function handleWorkspaceIcon(args: string[]): Promise<void> {
    if (hasHelpFlag(args)) {
        writeOut(workspaceIconUsage);
        exit(0);
    }
    const clear = popSwitch('--clear', args);
    const asJSON = popSwitch('--json', args);
    const nameOrID = args.shift();
    const emoji = clear ? undefined : args.shift();
    for (const positional of [nameOrID, emoji]) {
        if (positional !== undefined && positional.trim().startsWith('-')) {
            errLine(`kelpi workspace icon: unknown option ${positional}`);
            writeErr(workspaceIconUsage);
            exit(1);
        }
    }
    if (nameOrID === undefined || (!clear && emoji === undefined)) {
        writeErr(workspaceIconUsage);
        exit(1);
    }
    if (clear && args.length > 0 && !(args[0] ?? '').startsWith('-')) {
        errLine("workspace icon can't take both an emoji and --clear");
        exit(1);
    }
    rejectLeftoverArgs(args, 'kelpi workspace icon', {
        usage: (write) => write(workspaceIconUsage),
        positionalHint: 'an icon is one emoji'
    });
    const icon = emoji === undefined ? null : wireIcon(emoji, 'kelpi workspace icon');

    // An absent `icon` is the daemon's "clear".
    const payload: JsonObject = { command: 'workspace-icon', name: nameOrID };
    if (icon !== null) payload['icon'] = icon;
    const reply = await decodeReply(payload, 'kelpi workspace icon');
    if (asJSON) {
        printLine(stableStringify(reply));
        return;
    }
    const workspaceName = asString(reply['workspace_name']) ?? nameOrID;
    const current = asString(reply['icon']);
    if (current === undefined) {
        printLine(`${workspaceName}: icon cleared`);
        return;
    }
    const shown = current.startsWith('emoji:') ? current.slice('emoji:'.length) : current;
    printLine(`${workspaceName}: icon set to ${shown}`);
}
