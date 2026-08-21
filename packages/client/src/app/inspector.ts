/**
 * The inspector's data feed: the repo registry and the per-association git status.
 *
 * The panel itself (`chrome/Inspector.tsx`) never touches a socket, so this is the seam that
 * does. Two reads, both WS-only verbs the daemon answers asynchronously:
 *
 *   - `repo-registry` — the registry plus each repo's RESOLVED worktree base path, which the
 *     client cannot compute (the daemon host's home directory is stripped from the mirror).
 *   - `workspace-repo-status` — branch, dirtiness and diff stats per association.
 *
 * When it re-reads, and why:
 *   - the inspector opening, or the active workspace changing — the panel must never show the
 *     previous workspace's repos;
 *   - the workspace's association set or branch changing — that arrives as a delta, and a HEAD
 *     move that changes the branch is exactly one of those, so the sidebar and the inspector
 *     agree without a second push channel;
 *   - a 30 s poll while it is open, matching the daemon's own `GIT_STATUS_POLL_MS` — a commit
 *     that leaves the branch alone produces no delta, and dirtiness still has to catch up.
 *
 * Every read is `refresh: true`: opening the inspector is precisely the moment a stale badge is
 * worth a `git status`. Failures are swallowed into the previous values — a panel that blanks
 * because git was briefly busy is worse than one that is a few seconds stale.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { InspectorAssociation, InspectorGitStatus, InspectorRepo } from '../chrome';
import type { CommandReply } from '../connection';

/** The daemon's association-status poll, mirrored so the two cannot drift far apart. */
export const INSPECTOR_POLL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A malformed / absent status is `unknown`, which is what the gray dot already means. */
export function parseGitStatus(raw: unknown): InspectorGitStatus {
    if (!isRecord(raw)) return { kind: 'unknown', changedFiles: 0, additions: 0, deletions: 0 };
    const kind = text(raw['kind']);
    if (kind !== 'clean' && kind !== 'dirty') {
        return { kind: 'unknown', changedFiles: 0, additions: 0, deletions: 0 };
    }
    return {
        kind,
        changedFiles: count(raw['changed_files']),
        additions: count(raw['additions']),
        deletions: count(raw['deletions'])
    };
}

export function parseAssociations(reply: CommandReply): readonly InspectorAssociation[] {
    const rows = reply['associations'];
    if (!Array.isArray(rows)) return [];
    const parsed: InspectorAssociation[] = [];
    for (const row of rows) {
        if (!isRecord(row)) continue;
        const id = text(row['id']);
        if (id === '') continue;
        parsed.push({
            id,
            repoID: text(row['repo_id']),
            repoName: text(row['repo_name']),
            repoPath: typeof row['repo_path'] === 'string' ? row['repo_path'] : null,
            worktreePath: text(row['worktree_path']),
            // §APP-071 / §GIT-092: the symlink-resolved twin the daemon computes for us. An
            // older daemon omits it and every consumer falls back to `worktreePath`.
            worktreePathReal: text(row['worktree_path_real']),
            branch: typeof row['branch'] === 'string' && row['branch'] !== '' ? row['branch'] : null,
            isWorktree: row['is_worktree'] === true,
            status: parseGitStatus(row['status'])
        });
    }
    return parsed;
}

export function parseRepos(reply: CommandReply): readonly InspectorRepo[] {
    const rows = reply['repos'];
    if (!Array.isArray(rows)) return [];
    const parsed: InspectorRepo[] = [];
    for (const row of rows) {
        if (!isRecord(row)) continue;
        const id = text(row['id']);
        if (id === '') continue;
        parsed.push({
            id,
            name: text(row['name']),
            path: text(row['path']),
            worktreeBase: text(row['worktree_base'])
        });
    }
    return parsed;
}

export interface InspectorReader {
    listRepos(): Promise<CommandReply>;
    workspaceRepoStatus(input: { workspaceID: string; refresh?: boolean }): Promise<CommandReply>;
}

export interface UseInspectorDataInput {
    readonly commands: InspectorReader;
    readonly workspaceID: string | null;
    /** False = no association reads and no timer (nothing on screen wants them). */
    readonly enabled: boolean;
    /**
     * §APP-071's second consumer: the status footer wants the same per-association dirtiness
     * while the *panel* is shut, so `enabled` is no longer "the inspector is open".
     *
     * `refresh` is what separates the two. Open, the panel asks the daemon to re-run git before
     * replying — opening the inspector is exactly the moment a stale badge is worth a `git
     * status`. Closed, the footer reads the watcher's LAST KNOWN values (`refresh: false`),
     * which the daemon's own 30 s poll keeps warm — so a permanently-visible footer never
     * doubles the git the daemon was already running. Defaults to true (the panel's behaviour).
     */
    readonly refreshOnRead?: boolean | undefined;
    /**
     * A signature of the mirror's repo registry (its ids). The REGISTRY is read even while the
     * inspector is closed — it is a cheap, git-free read, and the New Workspace form's "Create
     * git worktree" section needs each repo's resolved base path to preview a path at all
     * (§WS-078). It re-reads whenever a repo is registered or dropped.
     */
    readonly registryKey?: string | undefined;
    /**
     * A signature of the workspace's associations from the mirror (ids + paths + branches). A
     * change means the daemon told us something moved — including a HEAD change that renamed the
     * branch — so the panel re-reads git.
     */
    readonly associationsKey: string;
    readonly pollMs?: number | undefined;
}

export interface InspectorData {
    readonly associations: readonly InspectorAssociation[];
    readonly repos: readonly InspectorRepo[];
    readonly refreshing: boolean;
    /** Force a re-read (after an add / remove / worktree create). */
    readonly refresh: () => void;
}

export function useInspectorData(input: UseInspectorDataInput): InspectorData {
    const { commands, workspaceID, enabled, associationsKey } = input;
    const refreshOnRead = input.refreshOnRead ?? true;
    const pollMs = input.pollMs ?? INSPECTOR_POLL_MS;
    const [associations, setAssociations] = useState<readonly InspectorAssociation[]>(EMPTY_ASSOCIATIONS);
    const [repos, setRepos] = useState<readonly InspectorRepo[]>(EMPTY_REPOS);
    const [refreshing, setRefreshing] = useState(false);
    const [nonce, setNonce] = useState(0);
    /** Guards a late reply from a workspace the user has already left. */
    const generation = useRef(0);

    const refresh = useCallback(() => {
        setNonce((value) => value + 1);
    }, []);

    // The registry: git-free, so it is read whether or not the inspector is open.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const reply = await commands.listRepos();
                if (cancelled) return;
                if (reply['ok'] === true) setRepos(parseRepos(reply));
            } catch {
                // Keep the last good list; the connection banner already says what happened.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [commands, input.registryKey, nonce]);

    useEffect(() => {
        if (!enabled || workspaceID === null) {
            setAssociations(EMPTY_ASSOCIATIONS);
            setRefreshing(false);
            return;
        }
        generation.current += 1;
        const mine = generation.current;
        let cancelled = false;
        const read = async (): Promise<void> => {
            setRefreshing(true);
            try {
                const status = await commands.workspaceRepoStatus({ workspaceID, refresh: refreshOnRead });
                if (cancelled || generation.current !== mine) return;
                if (status['ok'] === true) setAssociations(parseAssociations(status));
            } catch {
                // Keep the last good values: a dropped connection already has its own banner.
            } finally {
                if (!cancelled && generation.current === mine) setRefreshing(false);
            }
        };
        void read();
        if (pollMs <= 0) {
            return () => {
                cancelled = true;
            };
        }
        const timer = setInterval(() => {
            void read();
        }, pollMs);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [commands, enabled, workspaceID, associationsKey, nonce, pollMs, refreshOnRead]);

    return { associations, repos, refreshing, refresh };
}

const EMPTY_ASSOCIATIONS: readonly InspectorAssociation[] = [];
const EMPTY_REPOS: readonly InspectorRepo[] = [];
