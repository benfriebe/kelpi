import { describe, expect, it, vi } from 'vitest';
import type { JsonObject, JsonValue } from '@kelpi/protocol';
import { createGitService, type GitService } from '../git/service.js';
import type { BuiltinServiceHost } from './builtin-services.js';
import { createPluginGitService } from './git-service.js';

const context = { daemonID: 'private-daemon' };

function harness() {
    // Every primitive is present, while any accidentally reached native process is visible.
    const run = vi.fn(async () => { throw new Error('unexpected native git process'); });
    const native = createGitService({ run });
    let selected = true;
    const callService = vi.fn<BuiltinServiceHost['callService']>(async () => null);
    const host: BuiltinServiceHost = { daemonID: context.daemonID, hasSelectedProvider: vi.fn(() => selected), callService };
    let currentHost: BuiltinServiceHost | undefined = host;
    const adapter = createPluginGitService(native, () => currentHost);
    return { ...adapter, native, host, callService, run, select: (value: boolean) => { selected = value; }, setHost: (value: BuiltinServiceHost | undefined) => { currentHost = value; } };
}

describe('native Git service provider adapter', () => {
    it('preserves the native promise, arguments and larger output when no provider is available', async () => {
        const h = harness(); const output = 'x'.repeat(400 * 1024);
        const promise = Promise.resolve(output);
        const read = vi.spyOn(h.native, 'getDiff').mockReturnValue(promise);
        const signal = new AbortController().signal;
        h.setHost(undefined);
        expect(h.git.getDiff('/repo', null, { signal })).toBe(promise);
        expect(read).toHaveBeenLastCalledWith('/repo', null, { signal });
        h.setHost(h.host); h.select(false);
        expect(h.git.getDiff('/repo')).toBe(promise);
        expect(read).toHaveBeenLastCalledWith('/repo');
        expect(await promise).toHaveLength(400 * 1024);
        expect(h.callService).not.toHaveBeenCalled();
        expect(h.run).not.toHaveBeenCalled();
    });

    it('routes native reads through the selected provider with the owning daemon context', async () => {
        const h = harness();
        h.callService.mockResolvedValue({ kind: 'dirty', changedFiles: 2, additions: 7, deletions: 3 });
        expect(await h.git.getStatus('/repo')).toEqual({ kind: 'dirty', changedFiles: 2, additions: 7, deletions: 3 });
        expect(h.callService).toHaveBeenCalledWith({ service: 'kelpi.git', version: 1, method: 'getStatus', args: { repoPath: '/repo' } }, context, undefined);
        expect(h.run).not.toHaveBeenCalled();
        expect(h.service).toMatchObject({ id: 'kelpi.git', title: 'Git', version: 1 });
        expect(Object.keys(h.service.methods)).toHaveLength(25);
    });

    it('keeps worktreeAdd as a named argument object and converts provider null to native void', async () => {
        const h = harness();
        await expect(h.git.worktreeAdd({ repoPath: '/repo', worktreePath: '/worktree', branchName: 'feature', updateMain: false, remote: undefined })).resolves.toBeUndefined();
        expect(h.callService).toHaveBeenCalledWith({ service: 'kelpi.git', version: 1, method: 'worktreeAdd', args: { repoPath: '/repo', worktreePath: '/worktree', branchName: 'feature', updateMain: false } }, context, undefined);
        expect(h.run).not.toHaveBeenCalled();
    });

    it('does not retry a failed provider mutation after its selection changes', async () => {
        const h = harness();
        let reject!: (error: Error) => void;
        h.callService.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
        const native = vi.spyOn(h.native, 'removeWorktree').mockResolvedValue();
        const pending = h.git.removeWorktree('/repo', '/worktree');
        const failed = expect(pending).rejects.toThrow('provider failed after changing files');
        h.select(false); reject(new Error('provider failed after changing files'));
        await failed;
        expect(native).not.toHaveBeenCalled();
        expect(h.callService).toHaveBeenCalledOnce();
        // Only a subsequent independent operation can use the current bundled fallback.
        await h.git.removeWorktree('/repo', '/worktree');
        expect(native).toHaveBeenCalledOnce();
    });

    it('delegates explicit bundled methods directly even while an external provider is selected', async () => {
        const h = harness();
        const add = vi.spyOn(h.native, 'worktreeAdd').mockResolvedValue();
        const read = vi.spyOn(h.native, 'getCurrentBranch').mockResolvedValue('native-branch');
        const args = { repoPath: '/repo', worktreePath: '/worktree', branchName: 'topic', updateMain: true, remote: 'upstream' };
        expect(await h.service.methods['worktreeAdd']!.run(args, context)).toBeNull();
        expect(add).toHaveBeenCalledWith(args);
        expect(await h.service.methods['getCurrentBranch']!.run({ repoPath: '/repo' }, context)).toBe('native-branch');
        expect(read).toHaveBeenCalledWith('/repo');
        expect(h.callService).not.toHaveBeenCalled();
        expect(h.run).not.toHaveBeenCalled();
    });

    it('preserves distinct arguments for worktree, stash, tree, and checkout mutations', async () => {
        const h = harness();
        const cases: Array<[keyof GitService, unknown[], JsonObject]> = [
            ['createWorktree', ['/repo', '/worktree', 'feature'], { repoPath: '/repo', worktreePath: '/worktree', branchName: 'feature' }],
            ['createWorktreeFromBase', ['/repo', '/worktree', 'feature', 'origin/main'], { repoPath: '/repo', worktreePath: '/worktree', branchName: 'feature', baseRef: 'origin/main' }],
            ['stashPopRef', ['/repo', 'stash-sha'], { repoPath: '/repo', stashRef: 'stash-sha' }],
            ['readTreeInto', ['/repo', 'tree-sha'], { repoPath: '/repo', treeSha: 'tree-sha' }],
            ['checkoutBranchForce', ['/repo', 'topic'], { repoPath: '/repo', branchOrSha: 'topic' }],
            ['resetHard', ['/repo', 'commit-sha'], { repoPath: '/repo', sha: 'commit-sha' }],
            ['resetMixed', ['/repo', 'commit-sha'], { repoPath: '/repo', sha: 'commit-sha' }],
            ['removeWorktree', ['/repo', '/worktree'], { repoPath: '/repo', worktreePath: '/worktree' }],
            ['fetch', ['/repo', 'upstream'], { repoPath: '/repo', remote: 'upstream' }]
        ];
        for (const [method, nativeArgs, args] of cases) {
            const native = vi.spyOn(h.native, method).mockResolvedValue(undefined as never);
            expect(await Reflect.apply(h.git[method], h.git, nativeArgs)).toBeUndefined();
            expect(h.callService).toHaveBeenLastCalledWith({ service: 'kelpi.git', version: 1, method, args }, context, undefined);
            expect(native).not.toHaveBeenCalled();
            expect(await h.service.methods[method]!.run(args, context)).toBeNull();
            expect(native).toHaveBeenLastCalledWith(...nativeArgs);
        }
    });

    it('uses worktreePath for tree writes and resolves root and HEAD paths without renaming fields', async () => {
        const h = harness();
        h.callService.mockResolvedValueOnce('tree-sha').mockResolvedValueOnce('/repo/.git/HEAD').mockResolvedValueOnce({ worktreeRoot: '/worktree', parentRepoRoot: '/repo' });
        expect(await h.git.writeTreeForWorktree('/worktree')).toBe('tree-sha');
        expect(h.callService).toHaveBeenLastCalledWith({ service: 'kelpi.git', version: 1, method: 'writeTreeForWorktree', args: { worktreePath: '/worktree' } }, context, undefined);
        expect(await h.git.resolveHeadPath('/worktree')).toBe('/repo/.git/HEAD');
        expect(h.callService).toHaveBeenLastCalledWith({ service: 'kelpi.git', version: 1, method: 'resolveHeadPath', args: { worktreePath: '/worktree' } }, context, undefined);
        expect(await h.git.resolveRepoRoot('/worktree/nested')).toEqual({ worktreeRoot: '/worktree', parentRepoRoot: '/repo' });
        expect(h.callService).toHaveBeenLastCalledWith({ service: 'kelpi.git', version: 1, method: 'resolveRepoRoot', args: { directory: '/worktree/nested' } }, context, undefined);
    });

    it('propagates diff cancellation to selected providers without serializing the signal', async () => {
        const h = harness(); const controller = new AbortController();
        h.callService.mockImplementation((_input, _context, signal) => new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); }));
        const pending = h.git.getDiff('/repo', 'notes.md', { signal: controller.signal });
        expect(h.callService).toHaveBeenCalledWith({ service: 'kelpi.git', version: 1, method: 'getDiff', args: { repoPath: '/repo', targetPath: 'notes.md' } }, context, controller.signal);
        const stopped = expect(pending).rejects.toThrow('superseded diff');
        controller.abort(new Error('superseded diff')); await stopped;
        expect(h.run).not.toHaveBeenCalled();
        await expect(h.git.getDiff('/repo', null, { signal: controller.signal })).rejects.toThrow('superseded diff');
        expect(h.callService).toHaveBeenCalledOnce();
    });

    it('passes an explicit bundled diff signal to native Git and refuses already cancelled operations', async () => {
        const h = harness(); const controller = new AbortController();
        const read = vi.spyOn(h.native, 'getDiff').mockResolvedValue('');
        expect(await h.service.methods['getDiff']!.run({ repoPath: '/repo', targetPath: null }, context, controller.signal)).toBe('');
        expect(read).toHaveBeenCalledWith('/repo', null, { signal: controller.signal });
        controller.abort(new Error('no longer needed'));
        await expect(h.service.methods['getDiff']!.run({ repoPath: '/repo' }, context, controller.signal)).rejects.toThrow('no longer needed');
        expect(read).toHaveBeenCalledOnce();
        expect(h.callService).not.toHaveBeenCalled();
    });

    it.each([
        ['getStatus', {}, 'repoPath'],
        ['getStatus', { repoPath: '/repo', force: true }, 'unexpected field'],
        ['getStatus', { repoPath: '/repo\0other' }, 'NUL'],
        ['getDiff', { repoPath: '/repo', targetPath: 7 }, 'targetPath'],
        ['worktreeAdd', { repoPath: '/repo', worktreePath: '/worktree', branchName: 'topic' }, 'updateMain'],
        ['worktreeAdd', { repoPath: '/repo', worktreePath: '/worktree', branchName: 'topic', updateMain: 'true' }, 'boolean'],
        ['fetch', { repoPath: '/repo', remote: null }, 'remote'],
        ['writeTreeForWorktree', { repoPath: '/repo' }, 'unexpected field'],
        ['resolveRepoRoot', { directory: '' }, 'nonempty']
    ] as const)('rejects malformed %s arguments before bundled execution', async (name, args, error) => {
        const h = harness();
        await expect(h.service.methods[name]!.run(args as JsonObject, context)).rejects.toThrow(error);
        expect(h.callService).not.toHaveBeenCalled();
        expect(h.run).not.toHaveBeenCalled();
    });

    it('validates provider results before they reach native callers', async () => {
        const h = harness();
        const cases: Array<[keyof GitService, JsonValue]> = [
            ['getStatus', { kind: 'dirty', changedFiles: -1, additions: 0, deletions: 0 }],
            ['getStatus', { kind: 'dirty', changedFiles: 1, additions: 1.5, deletions: 0 }],
            ['getStatus', { kind: 'clean', changedFiles: 0 }],
            ['getStatus', { kind: 'busy' }],
            ['repoState', 'cherry-pick'],
            ['getCurrentBranch', ''],
            ['getRemoteURL', false],
            ['resolveRepoRoot', { worktreeRoot: '/worktree' }],
            ['listWorktrees', [{ path: '/worktree', branch: null, isMain: 'true' }]],
            ['listWorktrees', [{ path: '/worktree', branch: false, isMain: true }]],
            ['resetHard', { ok: true }]
        ];
        for (const [method, result] of cases) {
            expect(() => h.service.methods[method]!.validateResult(result), method).toThrow('kelpi.git');
        }
        h.callService.mockResolvedValue({ kind: 'dirty', changedFiles: 1, additions: -1, deletions: 0 });
        await expect(h.git.getStatus('/repo')).rejects.toThrow('nonnegative integer');
        expect(h.run).not.toHaveBeenCalled();
        h.callService.mockResolvedValue({ ok: true });
        await expect(h.git.resetHard('/repo', 'commit')).rejects.toThrow('mutation result must be null');
        expect(h.run).not.toHaveBeenCalled();
    });

    it('accepts the native nullable, clean, dirty, and enum result variants', async () => {
        const h = harness();
        for (const name of ['getCurrentBranch', 'getRemoteURL', 'toplevel', 'resolveRepoRoot', 'stashPushIncludeUntracked']) h.service.methods[name]!.validateResult(null);
        for (const result of [{ kind: 'unknown' }, { kind: 'clean' }, { kind: 'dirty', changedFiles: 2, additions: 0, deletions: 5 }]) h.service.methods['getStatus']!.validateResult(result);
        for (const state of ['clean', 'merge', 'rebase', 'cherryPick', 'revert', 'bisect']) h.service.methods['repoState']!.validateResult(state);
        h.service.methods['listWorktrees']!.validateResult([{ path: '/repo', branch: 'main', isMain: true }, { path: '/worktree', branch: null, isMain: false }]);
        h.service.methods['getDiff']!.validateResult('');
        const read = vi.spyOn(h.native, 'getDiff').mockResolvedValue('native diff');
        expect(await h.service.methods['getDiff']!.run({ repoPath: '/repo', targetPath: '' }, context)).toBe('native diff');
        expect(read).toHaveBeenCalledWith('/repo', '', undefined);
    });
});
