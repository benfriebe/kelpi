/**
 * The poller's git reads (workspace-feature.md §11.1), on the daemon's git runner.
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
        async headRelation(worktreePath, commit, branch) {
            // Each probe answers by exit code: 0 yes, anything else no.
            const holds = async (args: readonly string[]): Promise<boolean> => {
                try {
                    await read(args, worktreePath);
                    return true;
                } catch {
                    return false;
                }
            };
            if (!await holds(['cat-file', '-e', `${commit}^{commit}`])) return 'unknown';
            const local = `refs/heads/${branch}`;
            if (await holds(['merge-base', '--is-ancestor', commit, local])) return 'contained';
            if (await holds(['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${branch}`])) return 'contained';
            if (await holds(['merge-base', '--is-ancestor', local, commit])) return 'ahead';
            return 'unrelated';
        }
    };
}
