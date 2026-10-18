/**
 * Read-only git facts about a registered repository, for the ticket resolve
 * (docs/integrations.md §9.6): which remotes it has and where they point, which local branches
 * exist and what their `branch.<b>.*` config says, where each branch is checked out, and
 * whether the registered path is the repository's own root.
 *
 * Why this exists beside `GitService`: `getRemoteURL` reads `origin` only (a fork clone's base
 * repository is usually `upstream`, docs/integrations.md §9.6, and P2 of the phase 2 plan), and
 * the `kelpi.git` plugin provider contract has no method for any of this. These are direct git
 * reads, never routed through a plugin provider; a pull request checkout is refused while a
 * plugin owns `kelpi.git` anyway.
 *
 * It is the ONE reader of a repository's remotes, branches and worktrees for everything a ticket
 * does: the resolve reads through the cache below (`createRepoFacts`); the create's plan and the
 * pull request checkout read the same facts uncached and strict (`readRemoteFacts`,
 * `readBranchFacts`), since they decide right before git changes something. A remote carries its
 * URLs as git uses them (`git remote -v`, `url.<base>.insteadOf` applied) AND as written in the
 * config: a `gh:acme/api` alias only names GitHub once rewritten, a GitHub URL rewritten onto a
 * mirror only as written, and the ticket rules (`@kelpi/core/tickets` tracking.ts) count both.
 *
 * Contract:
 *
 *   - read-only and offline: `git remote -v`, `git config --get-regexp`, `git for-each-ref`,
 *     `git worktree list --porcelain` and `git rev-parse`; nothing that fetches, prompts or
 *     takes a lock (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`);
 *   - bounded: every git call has a timeout (`REPO_FACTS_GIT_TIMEOUT_MS`), and a repository
 *     whose read fails (a moved folder, a corrupt checkout) has no remotes, no branches and no
 *     layout rather than an error, so one broken registry row never fails a search;
 *   - cached briefly: remotes and layout change rarely (`REPO_FACTS_REMOTES_TTL_MS`), branches
 *     and worktrees often (`REPO_FACTS_BRANCHES_TTL_MS`). A cached read is shared by concurrent
 *     callers, so a caller's cancel only stops ITS wait (`signal`), never the shared read.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createGitRunner, type GitRunner } from './exec.js';

/** One git call of this module may take at most this long. */
export const REPO_FACTS_GIT_TIMEOUT_MS = 5_000;
/** How long a repository's remotes and layout are reused. */
export const REPO_FACTS_REMOTES_TTL_MS = 30_000;
/** How long a repository's branches and worktrees are reused. */
export const REPO_FACTS_BRANCHES_TTL_MS = 2_000;
/** Cache entries kept per kind; the oldest is dropped beyond this. */
const MAX_CACHE_ENTRIES = 256;

/** The environment every read runs with, over the daemon's own. */
const READ_ONLY_ENV: Readonly<Record<string, string>> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0'
};

/** One remote: its URLs as git uses them, and as written in the config (module note). */
export interface RemoteFact {
    readonly name: string;
    /** Where it fetches from, as `git remote -v` prints it (`url.<base>.insteadOf` applied). */
    readonly fetchURL: string;
    /** The push URL, the same way; the fetch URL when the remote has no `pushurl`. */
    readonly pushURL: string;
    /** `remote.<name>.url` as written, before any rewrite; null when unset or unread. */
    readonly configuredFetchURL: string | null;
    /** `remote.<name>.pushurl` as written; null when unset or unread. */
    readonly configuredPushURL: string | null;
    /** Every URL it fetches from: `fetchURL`, then `configuredFetchURL` when that differs (`TicketRemote`). */
    readonly fetchURLs: readonly string[];
}

/** `branch.<name>.*`, as configured; null where the key is absent. */
export interface BranchConfigFact {
    /** A remote name, `.` for a local upstream, or a URL (a fork's push target). */
    readonly remote: string | null;
    /** `refs/heads/<head>` or `refs/pull/<n>/head`, usually. */
    readonly merge: string | null;
    readonly pushRemote: string | null;
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeFact {
    readonly path: string;
    /** The checked-out branch (without `refs/heads/`); null when detached or bare. */
    readonly branch: string | null;
    /** The repository's main checkout (git lists it first). */
    readonly isMain: boolean;
    readonly bare: boolean;
    /** Its directory is gone and `git worktree prune` would remove it. */
    readonly prunable: boolean;
}

export interface BranchFacts {
    /** Every local branch, with its config (all null when it has none). */
    readonly branches: ReadonlyMap<string, BranchConfigFact>;
    readonly worktrees: readonly WorktreeFact[];
    /**
     * The checkout `branch` is checked out in, or null. A prunable worktree does not count: its
     * directory is gone, so a workspace cannot open there.
     */
    checkedOutAt(branch: string): string | null;
}

export interface RepoLayoutFact {
    /** `git rev-parse --show-toplevel`: the checkout the registered path is in. */
    readonly toplevel: string;
    /** The repository's common git directory (the main checkout's `.git`). */
    readonly commonDir: string;
    /**
     * The registered path IS the main checkout's root: not a subfolder of it (a monorepo row),
     * and not a linked worktree. Repository matching prefers such rows (docs/integrations.md §9.6).
     */
    readonly isRoot: boolean;
}

export interface RepoFacts {
    /** Never rejects except with `signal.reason`; a repository git cannot read has none. */
    remotes(repoPath: string, signal?: AbortSignal): Promise<readonly RemoteFact[]>;
    /** Never rejects except with `signal.reason`; a repository git cannot read has none. */
    branches(repoPath: string, signal?: AbortSignal): Promise<BranchFacts>;
    /** Null when the path is not a checkout git can read. */
    layout(repoPath: string, signal?: AbortSignal): Promise<RepoLayoutFact | null>;
    /** Forget the cached facts of one repository, or of every repository. */
    invalidate(repoPath?: string): void;
}

export interface CreateRepoFactsOptions {
    readonly run?: GitRunner | undefined;
    readonly now?: (() => number) | undefined;
    readonly remotesTTLms?: number | undefined;
    readonly branchesTTLms?: number | undefined;
    readonly timeoutMs?: number | undefined;
}

/** What `remote.<name>.url` / `.pushurl` say as written, by remote. */
export type ConfiguredRemoteURLs = ReadonlyMap<string, { readonly url: string | null; readonly pushURL: string | null }>;

/**
 * `git config -z --get-regexp '^remote\..*\.(url|pushurl)$'` → the URLs as written, by remote.
 * Each record is `key\nvalue\0`; git lowercases the variable (`pushurl`) and keeps the remote's
 * name (which may hold dots) as written. The FIRST value of a repeated key is the one git fetches
 * from, so it is the one kept.
 */
export function parseRemoteConfig(text: string): Map<string, { url: string | null; pushURL: string | null }> {
    const config = new Map<string, { url: string | null; pushURL: string | null }>();
    for (const record of text.split('\0')) {
        const newline = record.indexOf('\n');
        if (newline <= 0) continue;
        const match = /^remote\.(.+)\.(url|pushurl)$/.exec(record.slice(0, newline));
        const value = record.slice(newline + 1).trim();
        if (match === null || value === '') continue;
        const name = match[1] as string;
        const entry = config.get(name) ?? { url: null, pushURL: null };
        if (match[2] === 'url') entry.url ??= value;
        else entry.pushURL ??= value;
        config.set(name, entry);
    }
    return config;
}

/** `git remote -v` → one fact per remote, in the order git lists them, with what the config wrote. */
export function parseRemoteVerbose(text: string, configured: ConfiguredRemoteURLs = new Map()): RemoteFact[] {
    const byName = new Map<string, { fetchURL: string | null; pushURL: string | null }>();
    for (const line of text.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab <= 0) continue;
        const name = line.slice(0, tab);
        const rest = line.slice(tab + 1);
        const match = /^(.*) \((fetch|push)\)$/.exec(rest);
        if (match === null) continue;
        const url = (match[1] as string).trim();
        if (url === '') continue;
        const entry = byName.get(name) ?? { fetchURL: null, pushURL: null };
        if (match[2] === 'fetch') entry.fetchURL ??= url;
        else entry.pushURL ??= url;
        byName.set(name, entry);
    }
    const remotes: RemoteFact[] = [];
    for (const [name, entry] of byName) {
        const fetchURL = entry.fetchURL ?? entry.pushURL;
        if (fetchURL === null) continue;
        const written = configured.get(name);
        const configuredFetchURL = written?.url ?? null;
        remotes.push({
            name,
            fetchURL,
            pushURL: entry.pushURL ?? fetchURL,
            configuredFetchURL,
            configuredPushURL: written?.pushURL ?? null,
            fetchURLs: configuredFetchURL !== null && configuredFetchURL !== fetchURL ? [fetchURL, configuredFetchURL] : [fetchURL]
        });
    }
    return remotes;
}

/**
 * `git config -z --get-regexp ^branch\.` → config by branch. Each record is `key\nvalue\0` (or
 * `key\0` for a valueless key). Git prints the variable name lowercased and the branch name (the
 * subsection) as written; a branch name may hold dots, so the variable is the LAST segment.
 */
export function parseBranchConfig(text: string): Map<string, BranchConfigFact> {
    const config = new Map<string, { remote: string | null; merge: string | null; pushRemote: string | null }>();
    for (const record of text.split('\0')) {
        if (record === '') continue;
        const newline = record.indexOf('\n');
        const key = newline === -1 ? record : record.slice(0, newline);
        const value = newline === -1 ? '' : record.slice(newline + 1);
        const match = /^branch\.(.+)\.(remote|merge|pushremote)$/.exec(key);
        if (match === null) continue;
        const branch = match[1] as string;
        const entry = config.get(branch) ?? { remote: null, merge: null, pushRemote: null };
        // The last value wins, as it does for git itself.
        if (match[2] === 'remote') entry.remote = value;
        else if (match[2] === 'merge') entry.merge = value;
        else entry.pushRemote = value;
        config.set(branch, entry);
    }
    return config;
}

/**
 * `git worktree list --porcelain` → one fact per worktree. Unlike `parseWorktreeList`
 * (`status.ts`) this keeps `prunable` and `bare`, and never trims a path.
 */
export function parseWorktreePorcelain(text: string): WorktreeFact[] {
    const worktrees: WorktreeFact[] = [];
    let current: { path: string; branch: string | null; bare: boolean; prunable: boolean } | null = null;
    const flush = (): void => {
        if (current !== null) worktrees.push({ ...current, isMain: worktrees.length === 0 });
        current = null;
    };
    for (const line of text.split('\n')) {
        if (line === '') {
            flush();
            continue;
        }
        if (line.startsWith('worktree ')) {
            flush();
            current = { path: line.slice('worktree '.length), branch: null, bare: false, prunable: false };
            continue;
        }
        if (current === null) continue;
        if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length);
        else if (line === 'bare') current.bare = true;
        else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
    }
    flush();
    return worktrees;
}

function branchFacts(names: readonly string[], config: ReadonlyMap<string, BranchConfigFact>, worktrees: readonly WorktreeFact[]): BranchFacts {
    const branches = new Map<string, BranchConfigFact>();
    for (const name of names) branches.set(name, config.get(name) ?? { remote: null, merge: null, pushRemote: null });
    const checkedOut = new Map<string, string>();
    for (const worktree of worktrees) {
        if (worktree.branch === null || worktree.prunable || worktree.bare) continue;
        if (!checkedOut.has(worktree.branch)) checkedOut.set(worktree.branch, worktree.path);
    }
    return { branches, worktrees, checkedOutAt: (branch) => checkedOut.get(branch) ?? null };
}

/** What a repository git cannot read has. */
export const NO_BRANCH_FACTS: BranchFacts = branchFacts([], new Map(), []);

/** One git read in the repository: the arguments in, stdout out; a failure rejects with git's error. */
export type GitRead = (args: readonly string[]) => Promise<string>;

/** A config read whose "nothing configured" exit (1) is an empty answer, not a failure. */
async function readConfig(read: GitRead, args: readonly string[]): Promise<string> {
    try {
        return await read(args);
    } catch (error) {
        if ((error as { exitCode?: unknown }).exitCode === 1) return '';
        throw error;
    }
}

/**
 * Every remote of the repository `read` runs in, uncached and STRICT: a repository git cannot
 * read rejects (with git's error) instead of answering "no remotes". What the create's plan and
 * the pull request checkout read, right before git changes something; the cache below reads the
 * same way.
 */
export async function readRemoteFacts(read: GitRead): Promise<RemoteFact[]> {
    const [verbose, written] = await Promise.all([read(['remote', '-v']), readConfig(read, ['config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'])]);
    return parseRemoteVerbose(verbose, parseRemoteConfig(written));
}

/** Every local branch, its config and the worktrees, uncached and strict (`readRemoteFacts`). */
export async function readBranchFacts(read: GitRead): Promise<BranchFacts> {
    const [refs, config, worktrees] = await Promise.all([
        read(['for-each-ref', '--format=%(refname)', 'refs/heads/']),
        readConfig(read, ['config', '-z', '--get-regexp', '^branch\\.']),
        read(['worktree', 'list', '--porcelain'])
    ]);
    const names = refs
        .split('\n')
        .filter((line) => line.startsWith('refs/heads/'))
        .map((line) => line.slice('refs/heads/'.length));
    return branchFacts(names, parseBranchConfig(config), parseWorktreePorcelain(worktrees));
}

function realpathOrSelf(value: string): string {
    try {
        return fs.realpathSync(value);
    } catch {
        return path.resolve(value);
    }
}

/** Wait for `promise`, or stop waiting (rejecting with the signal's reason) when `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return promise;
    if (signal.aborted) return Promise.reject(signal.reason as unknown);
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason as unknown);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

interface CacheEntry<T> {
    readonly at: number;
    readonly value: Promise<T>;
}

function createCache<T>(ttl: number, now: () => number): {
    get(key: string, load: () => Promise<T>): Promise<T>;
    delete(key?: string): void;
} {
    const entries = new Map<string, CacheEntry<T>>();
    return {
        get(key, load) {
            const hit = entries.get(key);
            if (hit !== undefined && now() - hit.at < ttl) return hit.value;
            const value = load();
            entries.delete(key);
            entries.set(key, { at: now(), value });
            while (entries.size > MAX_CACHE_ENTRIES) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) break;
                entries.delete(oldest);
            }
            return value;
        },
        delete(key) {
            if (key === undefined) entries.clear();
            else entries.delete(key);
        }
    };
}

export function createRepoFacts(options: CreateRepoFactsOptions = {}): RepoFacts {
    const run = options.run ?? createGitRunner();
    const now = options.now ?? (() => Date.now());
    const timeoutMs = options.timeoutMs ?? REPO_FACTS_GIT_TIMEOUT_MS;
    const remotesCache = createCache<readonly RemoteFact[]>(options.remotesTTLms ?? REPO_FACTS_REMOTES_TTL_MS, now);
    const layoutCache = createCache<RepoLayoutFact | null>(options.remotesTTLms ?? REPO_FACTS_REMOTES_TTL_MS, now);
    const branchesCache = createCache<BranchFacts>(options.branchesTTLms ?? REPO_FACTS_BRANCHES_TTL_MS, now);

    const read = (args: readonly string[], cwd: string): Promise<string> => run(args, { cwd, env: READ_ONLY_ENV, timeoutMs });
    const isDirectory = (value: string): boolean => {
        try {
            return fs.statSync(value).isDirectory();
        } catch {
            return false;
        }
    };

    // The cached reads are the strict ones made lenient: one broken registry row never fails a search.
    const loadRemotes = async (repoPath: string): Promise<readonly RemoteFact[]> => {
        if (!isDirectory(repoPath)) return [];
        try {
            return await readRemoteFacts((args) => read(args, repoPath));
        } catch {
            return [];
        }
    };

    const loadBranches = async (repoPath: string): Promise<BranchFacts> => {
        if (!isDirectory(repoPath)) return NO_BRANCH_FACTS;
        try {
            return await readBranchFacts((args) => read(args, repoPath));
        } catch {
            return NO_BRANCH_FACTS;
        }
    };

    const loadLayout = async (repoPath: string): Promise<RepoLayoutFact | null> => {
        if (!isDirectory(repoPath)) return null;
        let out: string;
        try {
            out = await read(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], repoPath);
        } catch {
            return null;
        }
        const [toplevelRaw, commonRaw] = out.split('\n').filter((line) => line.trim() !== '');
        if (toplevelRaw === undefined || commonRaw === undefined) return null;
        const toplevel = realpathOrSelf(toplevelRaw.trim());
        const commonDir = realpathOrSelf(commonRaw.trim());
        const isRoot =
            realpathOrSelf(repoPath) === toplevel && path.basename(commonDir) === '.git' && path.dirname(commonDir) === toplevel;
        return { toplevel, commonDir, isRoot };
    };

    const key = (repoPath: string): string => path.resolve(repoPath);

    return {
        remotes: (repoPath, signal) => untilAborted(remotesCache.get(key(repoPath), () => loadRemotes(repoPath)), signal),
        branches: (repoPath, signal) => untilAborted(branchesCache.get(key(repoPath), () => loadBranches(repoPath)), signal),
        layout: (repoPath, signal) => untilAborted(layoutCache.get(key(repoPath), () => loadLayout(repoPath)), signal),
        invalidate(repoPath) {
            const target = repoPath === undefined ? undefined : key(repoPath);
            remotesCache.delete(target);
            branchesCache.delete(target);
            layoutCache.delete(target);
        }
    };
}
