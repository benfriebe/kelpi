/**
 * Boot restore: surfaces for every persisted shell pane, then the agent-session resume.
 *
 * Spec: agent-lifecycle.md §6.1 and app-state-core.md §12.3 steps 7–9. The ordering is the
 * whole point, and the steps before this module are the store's (`applyLoadReset` captures the
 * resume tuples and clears session ids + non-idle statuses BEFORE anything spawns):
 *
 *   3. spawn a PTY for every visible SHELL pane, with the owning workspace's profile env
 *      resolved from a single per-launch read of `~/.config/nex/config` — except a pane whose
 *      resume tuple recorded the session's launch profile AND whose session id passes the
 *      shell-safety allowlist, which spawns under the recorded profile instead;
 *   4. if any resume tuples exist, wait ~2 s (shells need to reach a prompt), then type
 *      `claude --resume <id>` / `codex resume <id>` into each pane — session ids that fail the
 *      shell-safety allowlist are skipped silently (`resumeCommand` returns null);
 *   5. only THEN persist, so a crash before the resume leaves the ids in the DB for the next
 *      launch. That last step is the caller's (`boot/compose.ts` gates saves until this
 *      pipeline resolves).
 *
 * Everything IO-shaped is injected — `sleep`, the profile list, the spawn grid — so the whole
 * sequence is testable without a real PTY or a 2 s wait.
 */

import { resumeCommand, RESUME_SETTLE_DELAY_MS, type ResumeTuple } from '@kelpi/core/agent';
import {
    buildPanePath,
    effectiveProfileName,
    FALLBACK_PATH,
    mergedEnvVars,
    normalizedAssignment,
    resolveProfileEnv,
    type EnvVar
} from '@kelpi/core/env';
import type { Profile } from '@kelpi/core/config';

import { DEFAULT_COLS, DEFAULT_ROWS } from '../pty/index.js';
import type { PtyManager, TerminalInput, TerminalStateService } from '../seams.js';
import type { DaemonState, WorkspaceState } from '../store/index.js';
import type { PaneSpawnDefaults } from '../handlers/pane/index.js';

export interface RestoreDeps {
    readonly pty: PtyManager;
    readonly term: TerminalStateService;
    /** Read ONCE per launch batch (app-state-core.md §12.3 step 7). */
    readonly profiles: readonly Profile[];
    readonly spawn?: PaneSpawnDefaults | undefined;
    /**
     * Spawn env for one pane. Boot passes the SAME builder the `pane-*` handlers use, so a
     * restored pane and a CLI-created one get byte-identical environments.
     * `sessionProfileName` is non-null for a pane that is about to type a resume command whose
     * session recorded the profile it was launched under — the env must resolve THAT profile
     * rather than the workspace's current assignment.
     */
    readonly envFor?:
        | ((
              paneID: string,
              workspace: WorkspaceState,
              sessionProfileName: string | null
          ) => readonly EnvVar[])
        | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface ResumeDeps extends RestoreDeps {
    readonly input: TerminalInput;
    /** Injected clock; production passes a real `setTimeout` sleep. */
    readonly sleep?: ((ms: number) => Promise<void>) | undefined;
    /** Defaults to `RESUME_SETTLE_DELAY_MS` (2 s). */
    readonly settleMs?: number | undefined;
}

export interface ResumeOutcome {
    /** Pane ids that got a PTY on this pass. */
    readonly spawned: readonly string[];
    /** Pane ids a resume command was typed into. */
    readonly resumed: readonly string[];
    /** Tuples skipped: unsafe session id, or the pane has no live PTY. */
    readonly skipped: readonly string[];
    /** True when the settle delay actually ran (i.e. there was something to resume). */
    readonly settled: boolean;
}

function realSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/**
 * The default env builder: the same composition `handlers/pane/support.ts` performs
 * (config-keybindings.md §9.1–9.3), including its rule that a missing helpers dir must not
 * produce a leading `:` in PATH — an empty PATH element means "the current directory".
 */
function restoreEnvVars(
    paneID: string,
    workspace: WorkspaceState,
    deps: RestoreDeps,
    sessionProfileName: string | null
): readonly EnvVar[] {
    const helpersDir = deps.spawn?.helpersDir;
    const inherited = deps.spawn?.inheritedPath ?? process.env['PATH'] ?? null;
    const path =
        helpersDir === undefined || helpersDir === ''
            ? (inherited === null || inherited === '' ? FALLBACK_PATH : inherited)
            : buildPanePath(helpersDir, inherited);
    // A pane whose resume tuple recorded the launch profile spawns with THAT profile
    // (agent-lifecycle.md §6.1 step 3 — the resumed agent must land in the environment the
    // session was launched under); every other pane resolves the workspace's current
    // assignment, as always.
    const profileEnv = resolveProfileEnv(
        deps.profiles,
        effectiveProfileName(normalizedAssignment(sessionProfileName ?? workspace.profileName))
    );
    const socketRoute = deps.spawn?.controlRoute?.() ?? null;
    return mergedEnvVars({ paneID, path, socketRoute, profileEnv });
}

/**
 * Step 3: one PTY + one server-side terminal per visible shell pane, in workspace order.
 *
 * Idempotent — `PtyManager.spawn` is a no-op for a pane that already has a child, so a pane
 * created by a CLI command racing this pass keeps the PTY it already got.
 */
export function spawnRestoredPanes(
    state: DaemonState,
    deps: RestoreDeps,
    tuples: readonly ResumeTuple[] = []
): string[] {
    const defaultCols = deps.spawn?.cols ?? DEFAULT_COLS;
    const defaultRows = deps.spawn?.rows ?? DEFAULT_ROWS;
    const envFor =
        deps.envFor ??
        ((paneID, workspace, sessionProfileName) =>
            restoreEnvVars(paneID, workspace, deps, sessionProfileName));
    // A pane with a captured resume tuple is about to type `claude --resume` / `codex resume`
    // into its fresh shell; when the tuple recorded the session's launch profile, the shell
    // must be spawned with that profile's env. Guarded on the same allowlist the typing step
    // applies (mirroring ws/panes.ts reopen): a tuple whose session id will never produce a
    // typed command must not drag its recorded profile into a pane that gets a fresh shell —
    // that pane belongs to the workspace's current assignment.
    const resumeProfiles = new Map<string, string>();
    for (const tuple of tuples) {
        if (tuple.profileName === null) continue;
        if (resumeCommand(tuple.kind, tuple.sessionID) === null) continue;
        resumeProfiles.set(tuple.paneID, tuple.profileName);
    }
    const spawned: string[] = [];

    for (const workspace of state.workspaces) {
        for (const pane of workspace.panes) {
            if (pane.type !== 'shell') continue; // markdown/scratchpad/diff/web have no PTY
            if (deps.pty.has(pane.id)) continue;
            const env = envFor(pane.id, workspace, resumeProfiles.get(pane.id) ?? null);
            // Boot is the worst case for a fixed grid: the shell prints its prompt seconds
            // before a window exists, so without the pane's remembered size that prompt is
            // 80 columns wide in a 200-column pane — forever, because the headless emulator
            // never reflows it (`pty/geometry.ts`).
            const spawnAt = (size: { cols: number; rows: number } | null): boolean => {
                if (deps.pty.has(pane.id)) return false;
                const remembered = deps.spawn?.sizeFor?.(pane.id) ?? null;
                const cols = size?.cols ?? remembered?.cols ?? defaultCols;
                const rows = size?.rows ?? remembered?.rows ?? defaultRows;
                try {
                    deps.pty.spawn({
                        paneID: pane.id,
                        cwd: pane.workingDirectory,
                        env: env.map((entry) => [entry.key, entry.value] as const),
                        cols,
                        rows,
                        ...(deps.spawn?.shell !== undefined ? { shell: deps.spawn.shell } : {})
                    });
                    deps.term.attach(pane.id, cols, rows);
                    return true;
                } catch (error) {
                    // One bad pane (vanished cwd, broken shell) must not abort the restore.
                    deps.onError?.(toError(error), `spawn ${pane.id}`);
                    return false;
                }
            };
            // A pane the geometry cache has never seen — a fresh install, or a state file that
            // outlived its cache — is held for the first client geometry report rather than
            // being born at 80×24 (`pty/spawn-gate.ts`). The gate declines when nothing is
            // there to report one, and boot is then byte-identical to what it always did.
            // `spawned` counts the panes this pass took responsibility for, deferred included:
            // the resume step that reads it re-checks `pty.has` (which a pending spawn answers
            // for) before it types anything.
            if (deps.spawn?.deferSpawn?.(pane.id, (size) => void spawnAt(size)) === true) {
                spawned.push(pane.id);
                continue;
            }
            if (spawnAt(null)) spawned.push(pane.id);
        }
    }
    return spawned;
}

/**
 * Steps 4: settle, then type each resume command. Returns once every command has been
 * written; the caller persists after it resolves (step 5).
 */
export async function typeResumeCommands(
    tuples: readonly ResumeTuple[],
    deps: ResumeDeps
): Promise<{ resumed: string[]; skipped: string[]; settled: boolean }> {
    const resumed: string[] = [];
    const skipped: string[] = [];
    if (tuples.length === 0) return { resumed, skipped, settled: false };

    const sleep = deps.sleep ?? realSleep;
    await sleep(deps.settleMs ?? RESUME_SETTLE_DELAY_MS);

    for (const tuple of tuples) {
        // `resumeCommand` applies the session-id allowlist; a failing id is skipped silently
        // because it is about to be typed into a shell (persisted command injection).
        const command = resumeCommand(tuple.kind, tuple.sessionID);
        if (command === null || !deps.pty.has(tuple.paneID)) {
            skipped.push(tuple.paneID);
            continue;
        }
        try {
            deps.input.sendText(tuple.paneID, command, { bare: false });
            resumed.push(tuple.paneID);
        } catch (error) {
            deps.onError?.(toError(error), `resume ${tuple.paneID}`);
            skipped.push(tuple.paneID);
        }
    }
    return { resumed, skipped, settled: true };
}

/** Steps 3 + 4 as one awaitable: spawn everything, settle, resume. */
export async function runRestorePipeline(
    state: DaemonState,
    tuples: readonly ResumeTuple[],
    deps: ResumeDeps
): Promise<ResumeOutcome> {
    const spawned = spawnRestoredPanes(state, deps, tuples);
    const { resumed, skipped, settled } = await typeResumeCommands(tuples, deps);
    return { spawned, resumed, skipped, settled };
}
