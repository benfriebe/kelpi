/**
 * WP2.5b — the daemon's minimal git service.
 *
 * Spec: docs/current/graft-git.md §3 (process conventions + API), §8 (worktree flows);
 * docs/current/app-state-core.md §4.2 (worktree create), §4.2.1–4.2.3 (name/path/error helpers).
 */

export {
    createGitRunner,
    GitCommandError,
    isGitCommandError,
    longGitTimeout,
    MIN_LONG_GIT_TIMEOUT_MS,
    resolveGitExecutable
} from './exec.js';
export type { CreateGitRunnerOptions, GitRunner, RunGitOptions } from './exec.js';

export {
    DEFAULT_WORKTREE_BASE_PATH,
    expandTilde,
    resolvedWorktreeBasePath,
    sanitizedGitName,
    standardizePath,
    worktreeErrorMessage,
    worktreePathFor
} from './names.js';

export {
    createGitService,
    DETACHED_HEAD,
    FALLBACK_DEFAULT_BRANCH,
    parseSymrefLine,
    stripRemotePrefix
} from './service.js';
export type {
    CreateGitServiceOptions,
    GitService,
    RepoRootInfo,
    WorktreeAddRequest
} from './service.js';
