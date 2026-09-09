import { pluginRecord, type JsonObject, type JsonValue } from '@kelpi/protocol';
import type { GitService, WorktreeAddRequest } from '../git/service.js';
import type { BuiltinPluginService, BuiltinServiceHost, BuiltinServiceMethod } from './builtin-services.js';

const SERVICE = 'kelpi.git';
const VERSION = 1;
type Check = (value: unknown) => void;
type Fields = Readonly<Record<string, Check>>;

function invalid(detail: string): never { throw new Error(`${SERVICE}: ${detail}`); }
const string: Check = value => { if (typeof value !== 'string' || value.includes('\0')) invalid('expected a string without NUL characters'); };
const diffText: Check = value => { if (typeof value !== 'string') invalid('expected diff text'); };
const nonempty: Check = value => { string(value); if ((value as string).length === 0) invalid('expected a nonempty string'); };
const argumentText: Check = value => { nonempty(value); if ((value as string).length > 8192) invalid('argument exceeds 8192 characters'); };
const boolean: Check = value => { if (typeof value !== 'boolean') invalid('expected a boolean'); };
const nullable = (check: Check): Check => value => { if (value !== null) check(value); };
const optional = (check: Check): Check => value => { if (value !== undefined) check(value); };
const nullResult: Check = value => { if (value !== null) invalid('mutation result must be null'); };
const natural: Check = value => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('expected a nonnegative integer'); };
const object = (fields: Fields): Check => value => {
    if (!pluginRecord(value)) invalid('expected an object');
    for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) invalid(`unexpected field ${key}`);
    for (const [key, check] of Object.entries(fields)) {
        try { check(value[key]); }
        catch (error) { invalid(`${key}: ${error instanceof Error ? error.message : String(error)}`); }
    }
};
const status: Check = value => {
    if (!pluginRecord(value)) invalid('expected repository status');
    if (value['kind'] === 'unknown' || value['kind'] === 'clean') object({ kind: nonempty })(value);
    else if (value['kind'] === 'dirty') object({ kind: nonempty, changedFiles: natural, additions: natural, deletions: natural })(value);
    else invalid('unknown repository status kind');
};
const repositoryState: Check = value => { if (typeof value !== 'string' || !['clean', 'merge', 'rebase', 'cherryPick', 'revert', 'bisect'].includes(value)) invalid('unknown repository state'); };
const worktrees: Check = value => {
    if (!Array.isArray(value)) invalid('expected a worktree array');
    const check = object({ path: nonempty, branch: nullable(nonempty), isMain: boolean });
    for (const entry of value) check(entry);
};
const clean = (value: Record<string, JsonValue | undefined>): JsonObject => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as JsonObject;
const text = (args: JsonObject, key: string): string => args[key] as string;
const repo = { repoPath: argumentText };
const worktree = { worktreePath: argumentText };
const branch = { ...repo, ...worktree, branchName: argumentText };

interface MethodAdapter<K extends keyof GitService> {
    readonly wrapped: GitService[K];
    readonly definition: BuiltinServiceMethod;
}

/**
 * The daemon keeps its native guards, state and transport lifetimes. Only Git primitives
 * cross the provider boundary. Bundled delegation calls this injected implementation
 * directly, so it cannot select the same provider recursively.
 */
export function createPluginGitService(bundled: GitService, getHost: () => BuiltinServiceHost | undefined): { git: GitService; service: BuiltinPluginService } {
    const method = <K extends keyof GitService>(
        name: K,
        fields: Fields,
        encode: (...args: Parameters<GitService[K]>) => JsonObject,
        decode: (args: JsonObject, signal?: AbortSignal) => Parameters<GitService[K]>,
        validateResult: Check,
        mutation = false,
        getSignal?: (...args: Parameters<GitService[K]>) => AbortSignal | undefined
    ): MethodAdapter<K> => {
        const validateArgs = object(fields);
        const native = (...args: Parameters<GitService[K]>): ReturnType<GitService[K]> => Reflect.apply(bundled[name], bundled, args) as ReturnType<GitService[K]>;
        const definition: BuiltinServiceMethod = {
            validateArgs,
            validateResult,
            async run(args, _context, signal) {
                validateArgs(args);
                signal?.throwIfAborted();
                const result = await native(...decode(args, signal));
                const value = mutation && result === undefined ? null : result;
                validateResult(value);
                return value as JsonValue;
            }
        };
        const wrapped = ((...args: Parameters<GitService[K]>) => {
            const host = getHost();
            // Preserve native limits, return values and the original Promise when no
            // available external provider is selected, including before daemon startup.
            if (!host?.hasSelectedProvider(SERVICE, VERSION)) return native(...args);
            try {
                const input = encode(...args);
                validateArgs(input);
                const signal = getSignal?.(...args);
                signal?.throwIfAborted();
                return host.callService({ service: SERVICE, version: VERSION, method: name, args: input }, { daemonID: host.daemonID }, signal).then(result => {
                    validateResult(result);
                    return mutation ? undefined : result;
                });
            } catch (error) { return Promise.reject(error); }
        }) as GitService[K];
        return { wrapped, definition };
    };

    const adapters = {
        getCurrentBranch: method('getCurrentBranch', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], nullable(nonempty)),
        getDiff: method('getDiff', { ...repo, targetPath: optional(nullable(string)) }, (repoPath, targetPath) => clean({ repoPath, targetPath }),
            (args, signal) => [text(args, 'repoPath'), args['targetPath'] as string | null | undefined, signal ? { signal } : undefined], diffText, false, (_repoPath, _targetPath, options) => options?.signal),
        getRemoteURL: method('getRemoteURL', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], nullable(nonempty)),
        defaultBranch: method('defaultBranch', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], nonempty),
        fetch: method('fetch', { ...repo, remote: optional(argumentText) }, (repoPath, remote) => clean({ repoPath, remote }), args => [text(args, 'repoPath'), args['remote'] as string | undefined], nullResult, true),
        createWorktree: method('createWorktree', branch, (repoPath, worktreePath, branchName) => ({ repoPath, worktreePath, branchName }), args => [text(args, 'repoPath'), text(args, 'worktreePath'), text(args, 'branchName')], nullResult, true),
        createWorktreeFromBase: method('createWorktreeFromBase', { ...branch, baseRef: argumentText }, (repoPath, worktreePath, branchName, baseRef) => ({ repoPath, worktreePath, branchName, baseRef }), args => [text(args, 'repoPath'), text(args, 'worktreePath'), text(args, 'branchName'), text(args, 'baseRef')], nullResult, true),
        worktreeAdd: method('worktreeAdd', { ...branch, updateMain: boolean, remote: optional(argumentText) }, request => clean({ ...request }), args => [args as unknown as WorktreeAddRequest], nullResult, true),
        toplevel: method('toplevel', { directory: argumentText }, directory => ({ directory }), args => [text(args, 'directory')], nullable(nonempty)),
        resolveRepoRoot: method('resolveRepoRoot', { directory: argumentText }, directory => ({ directory }), args => [text(args, 'directory')], nullable(object({ worktreeRoot: nonempty, parentRepoRoot: nonempty }))),
        getStatus: method('getStatus', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], status),
        repoState: method('repoState', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], repositoryState),
        getHeadSha: method('getHeadSha', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], nonempty),
        resolveHeadPath: method('resolveHeadPath', worktree, worktreePath => ({ worktreePath }), args => [text(args, 'worktreePath')], nonempty),
        stashPushIncludeUntracked: method('stashPushIncludeUntracked', { ...repo, message: string }, (repoPath, message) => ({ repoPath, message }), args => [text(args, 'repoPath'), text(args, 'message')], nullable(nonempty)),
        stashPopRef: method('stashPopRef', { ...repo, stashRef: argumentText }, (repoPath, stashRef) => ({ repoPath, stashRef }), args => [text(args, 'repoPath'), text(args, 'stashRef')], nullResult, true),
        writeTreeForWorktree: method('writeTreeForWorktree', worktree, worktreePath => ({ worktreePath }), args => [text(args, 'worktreePath')], nonempty),
        readTreeInto: method('readTreeInto', { ...repo, treeSha: argumentText }, (repoPath, treeSha) => ({ repoPath, treeSha }), args => [text(args, 'repoPath'), text(args, 'treeSha')], nullResult, true),
        checkoutBranchForce: method('checkoutBranchForce', { ...repo, branchOrSha: argumentText }, (repoPath, branchOrSha) => ({ repoPath, branchOrSha }), args => [text(args, 'repoPath'), text(args, 'branchOrSha')], nullResult, true),
        checkoutHeadForce: method('checkoutHeadForce', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], nullResult, true),
        resetHard: method('resetHard', { ...repo, sha: argumentText }, (repoPath, sha) => ({ repoPath, sha }), args => [text(args, 'repoPath'), text(args, 'sha')], nullResult, true),
        resetMixed: method('resetMixed', { ...repo, sha: argumentText }, (repoPath, sha) => ({ repoPath, sha }), args => [text(args, 'repoPath'), text(args, 'sha')], nullResult, true),
        listWorktrees: method('listWorktrees', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], worktrees),
        removeWorktree: method('removeWorktree', { ...repo, ...worktree }, (repoPath, worktreePath) => ({ repoPath, worktreePath }), args => [text(args, 'repoPath'), text(args, 'worktreePath')], nullResult, true),
        pruneWorktrees: method('pruneWorktrees', repo, repoPath => ({ repoPath }), args => [text(args, 'repoPath')], nullResult, true)
    } satisfies { [K in keyof GitService]: MethodAdapter<K> };

    return {
        git: Object.fromEntries(Object.entries(adapters).map(([name, adapter]) => [name, adapter.wrapped])) as unknown as GitService,
        service: { id: SERVICE, title: 'Git', version: VERSION, methods: Object.fromEntries(Object.entries(adapters).map(([name, adapter]) => [name, adapter.definition])) }
    };
}
