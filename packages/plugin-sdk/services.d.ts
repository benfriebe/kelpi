import type { Context } from './index.js';

/** Native service contracts. These types do not depend on the daemon's implementation. */
export type NativeGitStatus = { kind: 'unknown' | 'clean' }
    | { kind: 'dirty'; changedFiles: number; additions: number; deletions: number };
export type NativeRepoState = 'clean' | 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'bisect';
export type NativeRepoRoot = { worktreeRoot: string; parentRepoRoot: string };
export type NativeWorktree = { path: string; branch: string | null; isMain: boolean };
export interface ContentRenderArgs {
    kind: 'markdown' | 'diff'; source: string; backgroundColor: string; fontSize: number;
    /** Host-provided base URL for native preview assets; null omits the bundled document's base element. */
    assetBase: string | null;
}
export interface ProcessExecArgs {
    file: string;
    /** Defaults to []; argv is passed directly, without a shell. */
    args?: string[];
    /** Defaults to the daemon account's home directory. */
    cwd?: string;
}
export type ProcessExecResult = { stdout: string; stderr: string };

type Contract<Args, Result> = { args: Args; result: Result };
type RepoArgs = { repoPath: string };
type WorktreeArgs = { repoPath: string; worktreePath: string; branchName: string };

/** Every listed service currently has version 1. Results are direct values, not command replies. */
export interface BuiltinServiceMap {
    'kelpi.files': {
        read: Contract<{ path: string }, string>;
        write: Contract<{ path: string; text: string }, null>;
    };
    'kelpi.process': {
        exec: Contract<ProcessExecArgs, ProcessExecResult>;
    };
    'kelpi.content.render': {
        render: Contract<ContentRenderArgs, { html: string }>;
    };
    'kelpi.git': {
        getCurrentBranch: Contract<RepoArgs, string | null>;
        getDiff: Contract<RepoArgs & { targetPath?: string | null }, string>;
        getRemoteURL: Contract<RepoArgs, string | null>;
        defaultBranch: Contract<RepoArgs, string>;
        fetch: Contract<RepoArgs & { remote?: string }, null>;
        createWorktree: Contract<WorktreeArgs, null>;
        createWorktreeFromBase: Contract<WorktreeArgs & { baseRef: string }, null>;
        worktreeAdd: Contract<WorktreeArgs & { updateMain: boolean; remote?: string }, null>;
        toplevel: Contract<{ directory: string }, string | null>;
        resolveRepoRoot: Contract<{ directory: string }, NativeRepoRoot | null>;
        getStatus: Contract<RepoArgs, NativeGitStatus>;
        repoState: Contract<RepoArgs, NativeRepoState>;
        getHeadSha: Contract<RepoArgs, string>;
        resolveHeadPath: Contract<{ worktreePath: string }, string>;
        stashPushIncludeUntracked: Contract<RepoArgs & { message: string }, string | null>;
        stashPopRef: Contract<RepoArgs & { stashRef: string }, null>;
        writeTreeForWorktree: Contract<{ worktreePath: string }, string>;
        readTreeInto: Contract<RepoArgs & { treeSha: string }, null>;
        checkoutBranchForce: Contract<RepoArgs & { branchOrSha: string }, null>;
        checkoutHeadForce: Contract<RepoArgs, null>;
        resetHard: Contract<RepoArgs & { sha: string }, null>;
        resetMixed: Contract<RepoArgs & { sha: string }, null>;
        listWorktrees: Contract<RepoArgs, NativeWorktree[]>;
        removeWorktree: Contract<RepoArgs & { worktreePath: string }, null>;
        pruneWorktrees: Contract<RepoArgs, null>;
    };
}
export type BuiltinServiceID = keyof BuiltinServiceMap;
export type BuiltinServiceMethod<S extends BuiltinServiceID> = keyof BuiltinServiceMap[S] & string;
export type BuiltinServiceArgs<S extends BuiltinServiceID, M extends BuiltinServiceMethod<S>> =
    BuiltinServiceMap[S][M] extends Contract<infer Args, unknown> ? Args : never;
export type BuiltinServiceResult<S extends BuiltinServiceID, M extends BuiltinServiceMethod<S>> =
    BuiltinServiceMap[S][M] extends Contract<unknown, infer Result> ? Result : never;
type ProviderResult<Result> = [Result] extends [null] ? null | void : Result;
/** A complete version-1 implementation; methods returning null may also return void. */
export type BuiltinProviderMethods<S extends BuiltinServiceID> = {
    [M in BuiltinServiceMethod<S>]: (args: BuiltinServiceArgs<S, M>, context: Context) =>
        ProviderResult<BuiltinServiceResult<S, M>> | Promise<ProviderResult<BuiltinServiceResult<S, M>>>;
};
