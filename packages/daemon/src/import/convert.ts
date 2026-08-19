/**
 * Legacy state → the daemon's `PersistedSnapshot`.
 *
 * Spec: docs/current/persistence.md §5.4 (web-pane field mapping), §6.2 steps 3–5 (the load
 * fixups the app performs), §7.1–7.3 (persisted vs transient, and the resume contract),
 * §9.4/§9.10 (repo uniqueness, private web panes).
 *
 * The two halves of the transient rule are easy to get backwards, so state them plainly:
 *
 *   - `status` is reset to `idle` for every pane. A status describes a live PTY, and no PTY
 *     survives an import (§7.2). A persisted `running` would make the fresh daemon believe it
 *     has agents it never spawned — the quit dialog, the status bar and the
 *     `workspace delete` guard all read it.
 *   - `agentSessionID` and `agentKind` are KEPT. They are precisely what makes the first boot
 *     after an import behave like a Swift-app restart: `applyLoadReset` captures them into
 *     resume tuples, `boot/resume.ts` types `claude --resume <id>` / `codex resume <id>` into
 *     the restored pane, and only then are the ids cleared and persisted. Dropping them here
 *     would silently break the one feature that makes importing worth doing.
 *
 * Everything else is either verbatim or a repair the daemon's own load path would perform
 * anyway (`fromSnapshot`), done here so the report can mention it.
 */

import { isSafeSessionID } from '@nex/core/agent';
import { workspaceSidebarID, type WebTab } from '@nex/core/codec';

import type {
    LabelPreset,
    PersistedGroup,
    PersistedPane,
    PersistedSnapshot,
    PersistedWorkspace,
    Repo,
    RepoAssociation
} from '../store/index.js';
import { PERSISTED_SNAPSHOT_VERSION } from '../store/index.js';

export interface ConvertOptions {
    /**
     * The Swift app keeps label presets in UserDefaults, not in `nex.db`, so an import would
     * otherwise land labels with no managed preset behind them — invisible in Settings ▸ Labels
     * and un-recolorable. Back-filling a gray preset per label mirrors what the CLI's
     * `workspace label` back-fill does. Default true.
     */
    readonly backfillLabelPresets?: boolean | undefined;
}

export interface ConvertResult {
    readonly snapshot: PersistedSnapshot;
    readonly warnings: readonly string[];
    /** Panes the first boot will actually resume (the shell-safety allowlist applied). */
    readonly resumable: readonly { readonly paneID: string; readonly sessionID: string }[];
    /** Label names that got a gray preset because the legacy DB had none. */
    readonly backfilledPresets: readonly string[];
}

/** §7.2: a status describes a live PTY; the private-tab rule is re-asserted defensively. */
function convertPane(pane: PersistedPane): PersistedPane {
    const isWeb = pane.type === 'web';
    const isPrivate = isWeb && pane.webIsPrivate;
    const tabs: readonly WebTab[] | null = isWeb && !isPrivate ? (pane.webTabs ?? []) : null;
    const activeTabID =
        tabs === null
            ? null
            : tabs.some((tab) => tab.id === pane.webActiveTabID)
              ? pane.webActiveTabID
              : (tabs[0]?.id ?? null);

    return {
        ...pane,
        status: 'idle',
        // Kept on purpose — the resume contract (§7.3) lives on these two fields.
        agentSessionID: pane.agentSessionID,
        agentKind: pane.agentKind,
        webTabs: tabs,
        webActiveTabID: activeTabID,
        webIsPrivate: isWeb && pane.webIsPrivate
    };
}

/**
 * Drop rows the write path would drop anyway (duplicate primary keys, duplicate `repo.path`,
 * associations pointing at an unregistered repo), so the report's counts are what actually
 * lands rather than what was decoded. The reader has already explained each of these in
 * `skipped`.
 */
function pruneRepos(repos: readonly Repo[]): { repos: Repo[]; ids: Set<string> } {
    const kept: Repo[] = [];
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const repo of repos) {
        if (ids.has(repo.id) || paths.has(repo.path)) continue;
        ids.add(repo.id);
        paths.add(repo.path);
        kept.push(repo);
    }
    return { repos: kept, ids };
}

function convertWorkspace(
    workspace: PersistedWorkspace,
    repoIDs: ReadonlySet<string>,
    seenPanes: Set<string>
): PersistedWorkspace {
    const panes: PersistedPane[] = [];
    for (const pane of workspace.panes) {
        if (seenPanes.has(pane.id)) continue;
        seenPanes.add(pane.id);
        panes.push(convertPane(pane));
    }
    const seenAssociations = new Set<string>();
    const repoAssociations: RepoAssociation[] = [];
    for (const association of workspace.repoAssociations) {
        if (seenAssociations.has(association.id)) continue;
        if (!repoIDs.has(association.repoID)) continue;
        seenAssociations.add(association.id);
        repoAssociations.push({ ...association });
    }
    return { ...workspace, panes, repoAssociations };
}

/**
 * Mirrors the back-fill in `store/reducers/workspaces.ts`: an empty name or a case-sensitive
 * duplicate is a silent no-op, so calling this opportunistically can never overwrite a color
 * the user chose.
 */
function addPreset(presets: LabelPreset[], name: string): boolean {
    if (name === '') return false;
    if (presets.some((preset) => preset.name === name)) return false;
    presets.push({ name, color: { kind: 'named', color: 'gray' }, textColor: null });
    return true;
}

export function convertLegacySnapshot(legacy: PersistedSnapshot, options: ConvertOptions = {}): ConvertResult {
    const warnings: string[] = [];
    const resumable: { paneID: string; sessionID: string }[] = [];

    const { repos, ids: repoIDs } = pruneRepos(legacy.repos);

    const seenWorkspaces = new Set<string>();
    const seenPanes = new Set<string>();
    const workspaces: PersistedWorkspace[] = [];
    for (const workspace of legacy.workspaces) {
        if (seenWorkspaces.has(workspace.id)) continue;
        seenWorkspaces.add(workspace.id);
        workspaces.push(convertWorkspace(workspace, repoIDs, seenPanes));
    }

    // §9.13: the boot types these into a shell, so an id outside the allowlist is skipped
    // there. Counting it as "will resume" would make the report promise something that never
    // happens — the id is still carried over, and the reader has already named the pane.
    let unsafeSessions = 0;
    for (const workspace of workspaces) {
        for (const pane of workspace.panes) {
            if (pane.agentSessionID === null) continue;
            if (isSafeSessionID(pane.agentSessionID)) {
                resumable.push({ paneID: pane.id, sessionID: pane.agentSessionID });
            } else {
                unsafeSessions += 1;
            }
        }
    }

    const seenGroups = new Set<string>();
    const groups: PersistedGroup[] = [];
    for (const group of legacy.groups) {
        if (seenGroups.has(group.id)) continue;
        seenGroups.add(group.id);
        groups.push({ ...group, childOrder: [...group.childOrder] });
    }

    // §6.2 step 3 — a pre-groups database has no sidebar order at all.
    const topLevelOrder =
        legacy.topLevelOrder.length > 0
            ? [...legacy.topLevelOrder]
            : workspaces.map((workspace) => workspaceSidebarID(workspace.id));

    // §6.2 step 2 — the same repair `fromSnapshot` performs, done here so it is reportable.
    const activeWorkspaceID =
        legacy.activeWorkspaceID !== null && seenWorkspaces.has(legacy.activeWorkspaceID)
            ? legacy.activeWorkspaceID
            : (workspaces[0]?.id ?? null);

    const labelPresets: LabelPreset[] = legacy.labelPresets.map((preset) => ({ ...preset }));
    const backfilledPresets: string[] = [];
    if (options.backfillLabelPresets !== false) {
        for (const workspace of workspaces) {
            for (const label of workspace.labels) {
                if (addPreset(labelPresets, label)) backfilledPresets.push(label);
            }
        }
        if (backfilledPresets.length > 0) {
            warnings.push(
                `created ${String(backfilledPresets.length)} gray label preset(s) (${backfilledPresets.join(', ')}) — the Swift app keeps preset colors outside nex.db, so recolor them in Settings ▸ Labels`
            );
        }
    }

    // Counted on the LEGACY side: `convertPane` has already idled them.
    const resetStatuses = legacy.workspaces.reduce(
        (total, workspace) => total + workspace.panes.filter((pane) => pane.status !== 'idle').length,
        0
    );
    if (resetStatuses > 0) {
        warnings.push(
            `reset ${String(resetStatuses)} non-idle pane status(es) to idle (no PTY survives an import)`
        );
    }
    if (resumable.length > 0) {
        warnings.push(
            `kept ${String(resumable.length)} agent session id(s); the first daemon boot after the import will resume them`
        );
    }
    if (unsafeSessions > 0) {
        warnings.push(
            `${String(unsafeSessions)} agent session id(s) fail the shell-safety allowlist and will not be resumed (they are still carried over)`
        );
    }

    return {
        snapshot: {
            version: PERSISTED_SNAPSHOT_VERSION,
            workspaces,
            groups,
            topLevelOrder,
            activeWorkspaceID,
            repos,
            labelPresets
        },
        warnings,
        resumable,
        backfilledPresets
    };
}
