/**
 * The poller's three git reads (workspace-feature.md §11.1), on the daemon's git runner.
 *
 * Background reads: no prompt may be shown (`BACKGROUND_GIT_ENV`) and none may hang a lookup
 * slot, so each has a short budget. All of them answer null/false rather than throw.
 */

import { BACKGROUND_GIT_ENV } from '../git/fetch-cache.js';
import type { GitRunner } from '../git/exec.js';
import { resolveDefaultBranch, worktreeGitOps } from '../git/worktree-add.js';
import type { PullRequestGit } from './pr-poller.js';

export const PR_GIT_TIMEOUT_MS = 15_000;

export function createPullRequestGit(run: GitRunner): PullRequestGit {
    const read = async (args: readonly string[], cwd: string): Promise<string> =>
        run(args, { cwd, env: BACKGROUND_GIT_ENV, timeoutMs: PR_GIT_TIMEOUT_MS });
    const ops = worktreeGitOps(run, { short: PR_GIT_TIMEOUT_MS });
    return {
        async remoteURL(repoPath) {
            try {
                const out = (await read(['remote', 'get-url', 'origin'], repoPath)).trim();
                return out === '' ? null : out;
            } catch {
                return null;
            }
        },
        async defaultBranch(repoPath) {
            try {
                return (await resolveDefaultBranch(ops, repoPath, 'origin', undefined, BACKGROUND_GIT_ENV)).branch;
            } catch {
                return null;
            }
        },
        async isAncestor(worktreePath, commit, branch) {
            // Exit 0: an ancestor (or the tip itself). Exit 1: not one. Anything else, a commit
            // this repo has never had included: not ours either.
            try {
                await read(['merge-base', '--is-ancestor', commit, `refs/heads/${branch}`], worktreePath);
                return true;
            } catch {
                return false;
            }
        }
    };
}
