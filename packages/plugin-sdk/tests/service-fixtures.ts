import type { BuiltinServiceMap } from '../index.js';

/** Checked against standalone public types, then against native validators in services.test. */
export const gitServiceFixtures = {
    getCurrentBranch: { args: { repoPath: '/repo' }, result: 'feature' },
    getDiff: { args: { repoPath: '/repo', targetPath: null }, result: '' },
    getRemoteURL: { args: { repoPath: '/repo' }, result: null },
    defaultBranch: { args: { repoPath: '/repo' }, result: 'main' },
    fetch: { args: { repoPath: '/repo', remote: 'origin' }, result: null },
    createWorktree: { args: { repoPath: '/repo', worktreePath: '/worktree', branchName: 'feature' }, result: null },
    createWorktreeFromBase: { args: { repoPath: '/repo', worktreePath: '/worktree', branchName: 'feature', baseRef: 'main' }, result: null },
    worktreeAdd: { args: { repoPath: '/repo', worktreePath: '/worktree', branchName: 'feature', updateMain: false, remote: 'origin' }, result: null },
    toplevel: { args: { directory: '/repo/src' }, result: '/repo' },
    resolveRepoRoot: { args: { directory: '/worktree/src' }, result: { worktreeRoot: '/worktree', parentRepoRoot: '/repo' } },
    getStatus: { args: { repoPath: '/repo' }, result: { kind: 'dirty', changedFiles: 1, additions: 2, deletions: 3 } },
    repoState: { args: { repoPath: '/repo' }, result: 'cherryPick' },
    getHeadSha: { args: { repoPath: '/repo' }, result: 'abc123' },
    resolveHeadPath: { args: { worktreePath: '/worktree' }, result: '/repo/.git/worktrees/feature/HEAD' },
    stashPushIncludeUntracked: { args: { repoPath: '/repo', message: 'service test' }, result: null },
    stashPopRef: { args: { repoPath: '/repo', stashRef: 'abc123' }, result: null },
    writeTreeForWorktree: { args: { worktreePath: '/worktree' }, result: 'abc123' },
    readTreeInto: { args: { repoPath: '/repo', treeSha: 'abc123' }, result: null },
    checkoutBranchForce: { args: { repoPath: '/repo', branchOrSha: 'main' }, result: null },
    checkoutHeadForce: { args: { repoPath: '/repo' }, result: null },
    resetHard: { args: { repoPath: '/repo', sha: 'abc123' }, result: null },
    resetMixed: { args: { repoPath: '/repo', sha: 'abc123' }, result: null },
    listWorktrees: { args: { repoPath: '/repo' }, result: [{ path: '/repo', branch: null, isMain: true }] },
    removeWorktree: { args: { repoPath: '/repo', worktreePath: '/worktree' }, result: null },
    pruneWorktrees: { args: { repoPath: '/repo' }, result: null },
} satisfies BuiltinServiceMap['kelpi.git'];

export const contentServiceFixture = {
    args: { kind: 'markdown', source: '# Hello', backgroundColor: '#181818', fontSize: 14, assetBase: null },
    result: { html: '<!doctype html><html><head></head><body>Hello</body></html>' },
} satisfies BuiltinServiceMap['kelpi.content.render']['render'];

export const processServiceFixture = {
    args: { file: 'program', args: ['one'], cwd: '/repo' }, result: { stdout: 'hello', stderr: '' },
} satisfies BuiltinServiceMap['kelpi.process']['exec'];
