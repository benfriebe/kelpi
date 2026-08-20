/**
 * The pane-branch producer (terminal-panes.md §TERM-145/§TERM-146, graft-git.md §GIT-091,
 * app-shell.md §APP-070, content-panes.md §CONT-140).
 *
 * `pane-branch-changed` has had a reducer, a type and a routing entry since M2 and **no
 * producer**, so `pane.gitBranch` was permanently null and all three renderers that read it —
 * the pane header's branch chip, the status footer's branch glyph, and a markdown/diff pane's
 * header — never drew anything. This module is that producer.
 *
 * The Swift app chains the lookup off two call sites (`WorkspaceFeature.swift:1377-1386` for a
 * pwd report, `:696-699` / `:766-769` at markdown/diff open time). Here it is **one store
 * reconciler** instead, for the same reason `graft/associations.ts` is one: every path that can
 * change a pane's working directory — an OSC 7 report, a split inheriting a cwd, `open-markdown-
 * pane` setting `dirname(filePath)`, `open-diff-pane` setting the repo path, a restore at boot —
 * is, from the store's point of view, the same event. Subscribing once covers all of them and
 * cannot drift the way five call sites can.
 *
 * Rules, all of them the Swift original's:
 *
 *   - `git rev-parse --abbrev-ref HEAD` in the pane's own working directory, **async** and
 *     never on the dispatch path.
 *   - A **detached HEAD** keeps git's own literal answer, `"HEAD"` (§GIT-091) — the port does
 *     not translate it into a short sha or a placeholder.
 *   - A directory that is not a checkout (or a git that fails) yields `null`, which is how the
 *     renderers know to draw nothing.
 *   - The dispatch is **conditional**: a re-resolve that agrees with what the pane already
 *     carries writes nothing, so the branch chip cannot flicker and the delta stream stays quiet
 *     while a pane sits still.
 *
 * Two things the Swift app had no need for, because it ran one lookup per event on a single
 * pane:
 *
 *   - a **per-pane debounce**, so a burst of `cd`s (or the split → focus → resize storm that
 *     follows a new pane) costs one `git rev-parse` rather than five;
 *   - a **per-directory cache** with a short TTL, so N panes sharing a cwd — the common shape of
 *     a fanned-out agent workspace — cost one `git rev-parse` between them.
 *
 * `repoChanged(worktreePath)` is the second trigger: `graft/associations.ts` already watches
 * every association's HEAD **file** (§9.2) and refreshes on a checkout, so this hangs off that
 * watcher rather than adding a second one. It drops the cache for every directory inside the
 * worktree and re-resolves the panes sitting in it, which is what makes a `git checkout` in one
 * pane move the branch chip in every pane of that tree.
 */

import { canonicalizePath } from '../graft/paths.js';
import type { DomainStore } from '../seams.js';
import type { DaemonState, DomainAction, DomainEvent } from '../store/types.js';

/** A burst of `cd`s, or a split's create → focus → resize storm, is one lookup. */
export const BRANCH_RESOLVE_DEBOUNCE_MS = 120;

/**
 * How long a resolved directory answer is reused.
 *
 * Long enough that a workspace of panes in one repo shares a single `git rev-parse`, short
 * enough that a checkout made outside any watched association is picked up on the next pwd
 * report rather than being cached forever. A HEAD change on a watched worktree invalidates
 * immediately via `repoChanged`, so this TTL is the backstop, not the mechanism.
 */
export const BRANCH_CACHE_TTL_MS = 3_000;

export type BranchStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

/** The one `GitService` member this needs; the rest is not its business. */
export interface BranchGit {
    /** `git rev-parse --abbrev-ref HEAD`; trimmed, empty → null, `"HEAD"` = detached. */
    getCurrentBranch(repoPath: string): Promise<string | null>;
}

export interface PaneBranchWatchService {
    /** Subscribe to the store and resolve whatever is already there. */
    start(): void;
    /**
     * A watched worktree's HEAD moved: forget its cached answers and re-resolve every pane
     * sitting inside it.
     */
    repoChanged(worktreePath: string): void;
    /** Resolve one pane now, ignoring the debounce (test seam / explicit refresh). */
    refresh(paneID: string): Promise<void>;
    /** Test seam: settle everything currently in flight. */
    idle(): Promise<void>;
    dispose(): void;
}

export interface CreatePaneBranchWatchOptions {
    readonly store: BranchStore;
    readonly git: BranchGit;
    readonly debounceMs?: number | undefined;
    readonly cacheTtlMs?: number | undefined;
    readonly now?: (() => number) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

interface PaneTarget {
    readonly paneID: string;
    readonly directory: string;
    readonly branch: string | null;
}

/** Visible panes only: a parked pane has no header and no footer to draw a branch in. */
function panesWithDirectories(state: DaemonState): readonly PaneTarget[] {
    const targets: PaneTarget[] = [];
    for (const workspace of state.workspaces) {
        for (const pane of workspace.panes) {
            const directory = pane.workingDirectory;
            if (typeof directory !== 'string' || directory.length === 0) continue;
            targets.push({ paneID: pane.id, directory, branch: pane.gitBranch ?? null });
        }
    }
    return targets;
}

function findPane(state: DaemonState, paneID: string): PaneTarget | null {
    for (const target of panesWithDirectories(state)) {
        if (target.paneID === paneID) return target;
    }
    return null;
}

export function createPaneBranchWatch(
    options: CreatePaneBranchWatchOptions
): PaneBranchWatchService {
    const { store, git } = options;
    const now = options.now ?? Date.now;
    const debounceMs = options.debounceMs ?? BRANCH_RESOLVE_DEBOUNCE_MS;
    const cacheTtlMs = options.cacheTtlMs ?? BRANCH_CACHE_TTL_MS;

    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    /** directory → last answer, so panes sharing a cwd share one `git rev-parse`. */
    const cache = new Map<string, { branch: string | null; at: number }>();
    /** paneID → the directory we last DISPATCHED for, which is what stops a resolve loop. */
    const settled = new Map<string, string>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const inFlight = new Set<Promise<void>>();
    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    const lookup = async (directory: string): Promise<string | null> => {
        const cached = cache.get(directory);
        if (cached !== undefined && now() - cached.at < cacheTtlMs) return cached.branch;
        let branch: string | null;
        try {
            // §GIT-091: git's own answer, verbatim. A detached HEAD prints the literal "HEAD"
            // and that is exactly what the chip must show.
            branch = await git.getCurrentBranch(directory);
        } catch {
            branch = null;
        }
        cache.set(directory, { branch, at: now() });
        return branch;
    };

    const resolve = async (paneID: string): Promise<void> => {
        if (disposed) return;
        const target = findPane(store.getState(), paneID);
        if (target === null) {
            settled.delete(paneID);
            return;
        }
        const directory = target.directory;
        const branch = await lookup(directory);
        if (disposed) return;
        // Re-read: the pane may have moved (or vanished) while git ran.
        const current = findPane(store.getState(), paneID);
        if (current === null || current.directory !== directory) return;
        settled.set(paneID, directory);
        if (current.branch === branch) return;
        store.dispatch({ type: 'pane-branch-changed', paneID, branch });
    };

    const run = (paneID: string): void => {
        const promise = resolve(paneID)
            .catch((error: unknown) => {
                report(error, `branch resolve ${paneID}`);
            })
            .finally(() => {
                inFlight.delete(promise);
            });
        inFlight.add(promise);
    };

    const schedule = (paneID: string): void => {
        if (disposed) return;
        const existing = timers.get(paneID);
        if (existing !== undefined) clearTimeout(existing);
        const timer = setTimeout(() => {
            timers.delete(paneID);
            run(paneID);
        }, debounceMs);
        timer.unref?.();
        timers.set(paneID, timer);
    };

    /**
     * Schedule every pane whose directory is not the one we last dispatched for. Panes that
     * have not moved are skipped, which is what makes this safe to run on every store event
     * (including the `pane-branch-changed` this module itself dispatches).
     */
    const reconcile = (): void => {
        if (disposed) return;
        const live = new Set<string>();
        for (const target of panesWithDirectories(store.getState())) {
            live.add(target.paneID);
            if (settled.get(target.paneID) === target.directory) continue;
            schedule(target.paneID);
        }
        for (const paneID of [...settled.keys()]) {
            if (live.has(paneID)) continue;
            settled.delete(paneID);
            const timer = timers.get(paneID);
            if (timer !== undefined) {
                clearTimeout(timer);
                timers.delete(paneID);
            }
        }
    };

    return {
        start() {
            if (disposed || unsubscribe !== null) return;
            unsubscribe = store.subscribe(() => {
                reconcile();
            });
            reconcile();
        },

        repoChanged(worktreePath) {
            if (disposed) return;
            const root = canonicalizePath(worktreePath);
            if (root === '') return;
            for (const directory of [...cache.keys()]) {
                const candidate = canonicalizePath(directory);
                if (candidate === root || candidate.startsWith(`${root}/`)) cache.delete(directory);
            }
            for (const target of panesWithDirectories(store.getState())) {
                const candidate = canonicalizePath(target.directory);
                if (candidate !== root && !candidate.startsWith(`${root}/`)) continue;
                // Force a re-resolve: the directory has not changed, only what git says about it.
                settled.delete(target.paneID);
                schedule(target.paneID);
            }
        },

        async refresh(paneID) {
            const timer = timers.get(paneID);
            if (timer !== undefined) {
                clearTimeout(timer);
                timers.delete(paneID);
            }
            settled.delete(paneID);
            await resolve(paneID);
        },

        async idle() {
            // Two passes: a settled resolve can dispatch, which reconciles, which can schedule.
            for (let pass = 0; pass < 4; pass += 1) {
                for (const timer of [...timers.values()]) clearTimeout(timer);
                const pending = [...timers.keys()];
                timers.clear();
                for (const paneID of pending) run(paneID);
                if (inFlight.size === 0 && pending.length === 0) return;
                await Promise.all([...inFlight]);
            }
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe?.();
            unsubscribe = null;
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
            cache.clear();
            settled.clear();
        }
    };
}
