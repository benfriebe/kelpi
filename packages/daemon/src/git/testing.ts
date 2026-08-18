/**
 * A complete no-op `GitService` for tests that only care about one or two methods.
 *
 * Lives as a real module (not inline in a spec) so widening `GitService` — which M7 did, and
 * later milestones will again — is a one-file change instead of a sweep through every stub.
 */

import type { GitService } from './service.js';

export function stubGitService(overrides: Partial<GitService> = {}): GitService {
    const base: GitService = {
        getCurrentBranch: async () => 'main',
        getDiff: async () => '',
        getRemoteURL: async () => null,
        defaultBranch: async () => 'main',
        fetch: async () => {},
        createWorktree: async () => {},
        createWorktreeFromBase: async () => {},
        worktreeAdd: async () => {},
        toplevel: async () => null,
        resolveRepoRoot: async () => null,
        getStatus: async () => ({ kind: 'clean' }),
        repoState: async () => 'clean',
        getHeadSha: async () => '0'.repeat(40),
        resolveHeadPath: async (worktreePath) => `${worktreePath}/.git/HEAD`,
        stashPushIncludeUntracked: async () => null,
        stashPopRef: async () => {},
        writeTreeForWorktree: async () => '1'.repeat(40),
        readTreeInto: async () => {},
        checkoutBranchForce: async () => {},
        checkoutHeadForce: async () => {},
        resetHard: async () => {},
        resetMixed: async () => {},
        listWorktrees: async () => [],
        removeWorktree: async () => {},
        pruneWorktrees: async () => {}
    };
    return { ...base, ...overrides };
}
