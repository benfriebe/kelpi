/**
 * WP2.5b — the daemon's minimal git service.
 *
 * Spec: docs/graft-git.md §3 (process conventions + API), §8 (worktree flows);
 * docs/app-state-core.md §4.2 (worktree create), §4.2.1–4.2.3 (name/path/error helpers).
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
    GRAFT_TEMP_INDEX_PREFIX,
    parseSymrefLine,
    stripRemotePrefix,
    sweepGraftTempIndexes
} from './service.js';

/** Settings ▸ Repositories' "Scan Directory" walk (§GIT-066). */
export { REPO_SCAN_MAX_DEPTH, scanForRepos } from './scan.js';
export type { ScanForReposOptions, ScannedRepo } from './scan.js';

/** Repo auto-detect: auto-link on a pane's pwd change, auto-unlink + GC (§GIT-074…§GIT-081). */
export {
    AUTO_LINK_DEBOUNCE_MS,
    AUTO_UNLINK_DEBOUNCE_MS,
    createRepoAutoDetect,
    isPathInside
} from './autodetect.js';
export type {
    AutoDetectGit,
    AutoDetectStore,
    CreateRepoAutoDetectOptions,
    RepoAutoDetectService
} from './autodetect.js';

/**
 * The pane-branch producer: `git rev-parse --abbrev-ref HEAD` chained behind every path that
 * moves a pane's working directory, plus a HEAD-change re-resolve (§GIT-091 / §TERM-145).
 */
export {
    BRANCH_CACHE_TTL_MS,
    BRANCH_RESOLVE_DEBOUNCE_MS,
    createPaneBranchWatch
} from './branch.js';
export type {
    BranchGit,
    BranchStore,
    CreatePaneBranchWatchOptions,
    PaneBranchWatchService
} from './branch.js';

export {
    describeRepoState,
    NOTHING_TO_STASH,
    parseShortstat,
    parseStashList,
    parseWorktreeList,
    porcelainLines
} from './status.js';
export type { RepoGitStatus, RepoState, ShortstatCounts, WorktreeInfo } from './status.js';
export type {
    CreateGitServiceOptions,
    GitService,
    RepoRootInfo,
    WorktreeAddRequest
} from './service.js';
