/**
 * Daemon domain state, actions and delta events.
 *
 * Specs: docs/workspace-feature.md (per-workspace state + actions),
 * docs/app-state-core.md (app-level state, groups, sidebar order, labels, boot),
 * docs/pane-layout.md (layout invariants — algorithms live in @kelpi/core/layout).
 *
 * Everything here is data only: the reducers (`./reducers/`) are pure
 * `(state, action) => state`, the store (`./store.ts`) turns each dispatch into a batch of
 * `DomainEvent`s, and side effects (PTY spawn/kill, git, persistence) are the caller's job —
 * handlers read the events (or already know what they dispatched) and act.
 *
 * Time: every action that timestamps carries `now` in **epoch milliseconds** (JS-native).
 * Persisted timestamps (`createdAt`, `lastActivityAt`, `lastAccessedAt`) are stored as epoch
 * *seconds* (the Swift/GRDB encoding); the transient `agentStartedAt` keeps the epoch-ms
 * contract declared by @kelpi/core/agent.
 */

import type { AgentEvent, AgentKind } from '@kelpi/core/agent';
import type { IconRef, SidebarID, WebTab } from '@kelpi/core/codec';
import type {
    Direction,
    DropZone,
    Pane,
    PaneLayout,
    PaneStatus,
    PaneType,
    PredefinedLayoutKind,
    SplitDirection
} from '@kelpi/core/layout';
import type { WorkspaceColor } from '@kelpi/protocol';

export type { AgentKind, Direction, DropZone, IconRef, Pane, PaneLayout, PaneStatus, PaneType };
export type { PredefinedLayoutKind, SidebarID, SplitDirection, WebTab, WorkspaceColor };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Sidecar for `.web` panes; only tabs/activeTabID/isPrivate persist (§1.8). */
export interface WebPaneState {
    readonly tabs: readonly WebTab[];
    readonly activeTabID: string | null;
    readonly isPrivate: boolean;
}

/** Captured at close time so `reopen-closed-pane` can rebuild the pane (§1.4). */
export interface ClosedPaneSnapshot {
    readonly workingDirectory: string;
    readonly label: string | null;
    readonly type: PaneType;
    readonly filePath: string | null;
    readonly scratchpadContent: string | null;
    readonly agentSessionID: string | null;
    readonly agentKind: AgentKind | null;
    /** The profile the recorded agent session was launched under; reopen resumes with it. */
    readonly agentProfileName: string | null;
    readonly markdownFontSize: number;
    /** null for private web panes — their tabs are deliberately dropped at close. */
    readonly webState: WebPaneState | null;
}

export interface RepoAssociation {
    readonly id: string;
    readonly repoID: string;
    readonly worktreePath: string;
    readonly branchName: string | null;
    readonly isAutoDetected: boolean;
}

export interface Repo {
    readonly id: string;
    readonly path: string;
    readonly name: string;
    readonly remoteURL: string | null;
    /** Epoch seconds. */
    readonly lastAccessedAt: number;
    readonly isAutoDiscovered: boolean;
}

export interface WorkspaceGroup {
    readonly id: string;
    readonly name: string;
    readonly color: WorkspaceColor | null;
    readonly isCollapsed: boolean;
    /** Member workspace ids in sidebar render order. */
    readonly childOrder: readonly string[];
    /** Epoch seconds. */
    readonly createdAt: number;
    readonly icon: IconRef | null;
}

export type LabelColor =
    | { readonly kind: 'named'; readonly color: WorkspaceColor }
    | { readonly kind: 'custom'; readonly hex: string };

export interface LabelPreset {
    /** Identity: unique, case-sensitive. */
    readonly name: string;
    readonly color: LabelColor;
    /** null = auto black/white by luminance. */
    readonly textColor: LabelColor | null;
}

/** Per-workspace state (§1.9). Fields flagged TRANSIENT never reach `PersistedSnapshot`. */
export interface WorkspaceState {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly color: WorkspaceColor;
    readonly icon: IconRef | null;
    /** null == the built-in "default" profile baseline. */
    readonly profileName: string | null;
    /** Visible panes, append order. */
    readonly panes: readonly Pane[];
    /** TRANSIENT: off-layout panes whose PTYs stay alive (`kelpi open --here` sources). */
    readonly parkedPanes: readonly Pane[];
    readonly layout: PaneLayout;
    readonly focusedPaneID: string | null;
    /** TRANSIENT: most-recent last, max 8, deduped. */
    readonly focusHistory: readonly string[];
    readonly repoAssociations: readonly RepoAssociation[];
    /** TRANSIENT: max 10, oldest dropped. */
    readonly recentlyClosedPanes: readonly ClosedPaneSnapshot[];
    /** Keyed by pane id; tabs/active/private persist, the rest is runtime state. */
    readonly webPanes: Readonly<Record<string, WebPaneState>>;
    /** TRANSIENT */
    readonly zoomedPaneID: string | null;
    /** TRANSIENT: pre-zoom layout; the un-zoomed tree is what gets persisted. */
    readonly savedLayout: PaneLayout | null;
    /** TRANSIENT */
    readonly searchingPaneID: string | null;
    /** TRANSIENT */
    readonly searchNeedle: string;
    /** TRANSIENT */
    readonly searchTotal: number | null;
    /** TRANSIENT */
    readonly searchSelected: number | null;
    /** TRANSIENT: index into the predefined-layout cycle; null = hand-modified layout. */
    readonly currentLayoutIndex: number | null;
    /** Epoch seconds. */
    readonly createdAt: number;
    /** Epoch seconds. */
    readonly lastAccessedAt: number;
    readonly labels: readonly string[];
    /** TRANSIENT */
    readonly isSyncInputActive: boolean;
    /** TRANSIENT: a set, stored as an ordered array so events/snapshots stay plain JSON. */
    readonly syncInputExcluded: readonly string[];
}

export interface DaemonState {
    /** Flat insertion order (identity lookups); sidebar order lives in `topLevelOrder`. */
    readonly workspaces: readonly WorkspaceState[];
    readonly groups: readonly WorkspaceGroup[];
    /** The sidebar's top level: ungrouped workspaces and group headers, interleaved. */
    readonly topLevelOrder: readonly SidebarID[];
    /**
     * The active workspace is per-CLIENT in the new architecture (PLAN.md); the daemon keeps
     * the last-active id so a fresh client restores where the user left off, and so
     * workspace-scoped CLI fallbacks keep the Swift app's semantics.
     */
    readonly lastActiveWorkspaceID: string | null;
    readonly repos: readonly Repo[];
    readonly labelPresets: readonly LabelPreset[];
    /**
     * app-state-core.md §6.5 / §13 — the one-shot legacy-label → preset marker. Persisted
     * (appState key `kelpid.labelPresetsMigrated`), server-only: `serializeState` never sends it.
     * Once true the boot back-fill never runs again, so a preset the user deletes while its
     * label is still applied somewhere is not resurrected by the next launch.
     */
    readonly labelPresetsMigrated: boolean;
    /** Environment, not persisted: the default cwd for new panes. */
    readonly homeDirectory: string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type WorkspaceLabelOp = 'set' | 'add' | 'remove' | 'clear';
export type GroupSortKey = 'name' | 'last-activity' | 'last-accessed';
export type NewWorkspacePlacement = 'end-of-list' | 'near-selection';

/**
 * Every id a reducer needs is pre-minted by the caller (the wire handlers reply with the
 * real pane/workspace id before the effect runs — wire-protocol.md §pre-minted UUIDs), which
 * also keeps the reducers pure and trivially testable.
 */
export type DomainAction =
    // ── boot / wholesale ────────────────────────────────────────────────────
    | { readonly type: 'replace-state'; readonly state: DaemonState }

    // ── workspace lifecycle ────────────────────────────────────────────────
    | {
          readonly type: 'create-workspace';
          readonly id: string;
          readonly paneID: string;
          readonly name: string;
          readonly now: number;
          readonly color?: WorkspaceColor | undefined;
          readonly workingDirectory?: string | undefined;
          readonly groupID?: string | undefined;
          readonly profileName?: string | null | undefined;
          readonly labels?: readonly string[] | undefined;
          readonly placement?: NewWorkspacePlacement | undefined;
          readonly repoAssociations?: readonly RepoAssociation[] | undefined;
      }
    | { readonly type: 'delete-workspace'; readonly id: string }
    | { readonly type: 'delete-workspaces'; readonly ids: readonly string[] }
    | { readonly type: 'rename-workspace'; readonly id: string; readonly name: string }
    | { readonly type: 'set-workspace-color'; readonly id: string; readonly color: WorkspaceColor }
    | { readonly type: 'set-workspace-icon'; readonly id: string; readonly icon: IconRef | null }
    | {
          readonly type: 'set-workspace-profile';
          readonly id: string;
          readonly profileName: string | null;
      }
    | {
          readonly type: 'workspace-labels';
          readonly id: string;
          readonly op: WorkspaceLabelOp;
          readonly values: readonly string[];
          /** CLI parity: `set`/`add` back-fill a gray preset for every introduced label. */
          readonly backfillPresets?: boolean | undefined;
      }
    | { readonly type: 'set-active-workspace'; readonly id: string; readonly now: number }
    | { readonly type: 'move-workspace'; readonly id: string; readonly toIndex: number }
    | {
          readonly type: 'move-workspace-to-group';
          readonly id: string;
          readonly groupID: string | null;
          readonly index?: number | null | undefined;
          readonly expandOnDrop?: boolean | undefined;
      }
    | {
          readonly type: 'move-workspaces-to-group';
          readonly ids: readonly string[];
          readonly groupID: string | null;
          readonly index?: number | null | undefined;
      }
    | {
          readonly type: 'set-bulk-color';
          readonly ids: readonly string[];
          readonly color: WorkspaceColor;
      }
    | {
          readonly type: 'set-bulk-label';
          readonly ids: readonly string[];
          readonly label: string;
          readonly apply: boolean;
      }

    // ── groups ─────────────────────────────────────────────────────────────
    | {
          readonly type: 'create-group';
          readonly id: string;
          readonly name: string;
          readonly now: number;
          readonly color?: WorkspaceColor | null | undefined;
          readonly insertAfter?: SidebarID | null | undefined;
          readonly initialWorkspaceIDs?: readonly string[] | undefined;
          readonly placement?: NewWorkspacePlacement | undefined;
      }
    | { readonly type: 'rename-group'; readonly id: string; readonly name: string }
    | {
          readonly type: 'set-group-color';
          readonly id: string;
          readonly color: WorkspaceColor | null;
      }
    | { readonly type: 'set-group-icon'; readonly id: string; readonly icon: IconRef | null }
    | { readonly type: 'toggle-group-collapse'; readonly id: string }
    | { readonly type: 'set-group-collapsed'; readonly id: string; readonly collapsed: boolean }
    | { readonly type: 'delete-group'; readonly id: string; readonly cascade: boolean }
    | { readonly type: 'move-group'; readonly id: string; readonly toIndex: number }
    | { readonly type: 'reorder-group'; readonly id: string; readonly order: readonly string[] }
    | {
          readonly type: 'sort-group';
          readonly id: string;
          readonly by: GroupSortKey;
          readonly descending?: boolean | undefined;
      }

    // ── label presets ──────────────────────────────────────────────────────
    | { readonly type: 'add-label-preset'; readonly name: string; readonly color: LabelColor }
    | {
          readonly type: 'update-label-preset';
          readonly id: string;
          readonly name: string;
          readonly color: LabelColor;
      }
    | {
          readonly type: 'set-label-preset-text-color';
          readonly id: string;
          readonly textColor: LabelColor | null;
      }
    | { readonly type: 'remove-label-preset'; readonly id: string }
    | { readonly type: 'move-label-preset'; readonly from: number; readonly to: number }
    | { readonly type: 'set-label-presets'; readonly presets: readonly LabelPreset[] }
    /**
     * app-state-core.md §6.5 — flip the one-shot legacy-label → preset marker. Dispatched by
     * the boot migration (`boot/labels.ts`) AFTER the back-fill presets have landed, so a crash
     * between the two leaves the migration still pending rather than half-done.
     */
    | { readonly type: 'set-label-presets-migrated' }

    // ── repo registry / associations ───────────────────────────────────────
    | { readonly type: 'add-repo'; readonly repo: Repo }
    | { readonly type: 'remove-repo'; readonly id: string }
    | { readonly type: 'rename-repo'; readonly id: string; readonly name: string }
    | {
          readonly type: 'set-repo-remote-url';
          readonly id: string;
          readonly remoteURL: string | null;
      }
    /**
     * graft-git.md §GIT-068: adding a repo that is already registered as AUTO-DISCOVERED
     * promotes it (`isAutoDiscovered = false`), so the auto-unlink GC can never collect a repo
     * the user asked for by hand. An already-manual repo is left alone by the caller.
     */
    | {
          readonly type: 'set-repo-auto-discovered';
          readonly id: string;
          readonly isAutoDiscovered: boolean;
      }
    | {
          readonly type: 'add-repo-association';
          readonly workspaceID: string;
          readonly association: RepoAssociation;
      }
    | {
          readonly type: 'remove-repo-association';
          readonly workspaceID: string;
          readonly associationID: string;
      }
    | {
          readonly type: 'set-repo-association-branch';
          readonly workspaceID: string;
          readonly associationID: string;
          readonly branchName: string | null;
      }

    // ── panes ──────────────────────────────────────────────────────────────
    | {
          readonly type: 'create-pane';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly now: number;
          readonly label?: string | null | undefined;
          readonly workingDirectory?: string | null | undefined;
      }
    | {
          readonly type: 'split-pane';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly direction: SplitDirection;
          readonly now: number;
          readonly sourcePaneID?: string | undefined;
          readonly label?: string | null | undefined;
      }
    | {
          readonly type: 'split-pane-at-path';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly path: string;
          readonly now: number;
          readonly direction?: SplitDirection | undefined;
          readonly label?: string | null | undefined;
      }
    | { readonly type: 'close-pane'; readonly workspaceID: string; readonly paneID: string }
    | {
          readonly type: 'set-pane-label';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly label: string | null;
      }
    | { readonly type: 'park-pane'; readonly workspaceID: string; readonly paneID: string }
    | {
          readonly type: 'unpark-pane';
          readonly workspaceID: string;
          readonly paneID: string;
          /** Visible pane whose leaf is replaced; defaults to a split of the focused pane. */
          readonly replacePaneID?: string | undefined;
      }
    | {
          readonly type: 'move-pane-adjacent';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly targetPaneID: string;
          readonly zone: DropZone;
      }
    | {
          readonly type: 'move-pane-direction';
          readonly workspaceID: string;
          readonly direction: Direction;
      }
    | {
          readonly type: 'move-pane-to-workspace';
          readonly paneID: string;
          readonly toWorkspaceID: string;
      }
    | {
          readonly type: 'resize-pane';
          readonly workspaceID: string;
          readonly paneID: string;
          /** The pane's own share of its enclosing split; clamped to [0.1, 0.9]. */
          readonly share: number;
      }
    | {
          readonly type: 'update-split-ratio';
          readonly workspaceID: string;
          readonly splitPath: string;
          readonly ratio: number;
      }
    | {
          readonly type: 'reopen-closed-pane';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly now: number;
      }
    | {
          readonly type: 'pane-process-terminated';
          readonly paneID: string;
          readonly workspaceID?: string | undefined;
      }

    // ── content panes (records + layout only; rendering is M5) ─────────────
    | {
          readonly type: 'open-markdown-pane';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly filePath: string;
          readonly now: number;
          readonly reusePaneID?: string | undefined;
      }
    | {
          readonly type: 'open-diff-pane';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly repoPath: string;
          readonly now: number;
          readonly targetPath?: string | null | undefined;
          readonly reusePaneID?: string | undefined;
      }
    | {
          readonly type: 'create-scratchpad';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly now: number;
      }
    | {
          readonly type: 'open-web-pane';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly tabID: string;
          readonly url: string;
          readonly now: number;
          readonly reusePaneID?: string | undefined;
          readonly isPrivate?: boolean | undefined;
          readonly sourcePaneID?: string | undefined;
          readonly direction?: SplitDirection | undefined;
      }
    // ── web panes (tabs live in the sidecar; the browser itself is the shell's) ─
    | {
          readonly type: 'web-tab-open';
          readonly workspaceID: string;
          readonly paneID: string;
          /** Pre-minted by the caller so a CLI reply can echo it (web-pane.md §17.1). */
          readonly tabID: string;
          readonly url: string;
          readonly makeActive?: boolean | undefined;
      }
    | {
          readonly type: 'web-tab-close';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly tabID: string;
      }
    | {
          readonly type: 'web-tab-select';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly tabID: string;
      }
    | {
          /**
           * Drag reorder of the tab strip (WEB-016). `order` must be an exact permutation of
           * the pane's current tab ids — anything else is dropped, never truncated.
           */
          readonly type: 'web-tab-reorder';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly order: readonly string[];
      }
    | {
          /** Optimistic URL write on the ACTIVE tab (web-pane.md §4.2). */
          readonly type: 'web-navigate';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly url: string;
      }
    | {
          readonly type: 'web-set-private';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly isPrivate: boolean;
      }
    | {
          /** Host mirror of a live URL/title change (web-pane.md §4.4). */
          readonly type: 'web-tab-state';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly tabID: string;
          readonly url?: string | undefined;
          readonly title?: string | undefined;
      }
    | {
          readonly type: 'scratchpad-content-changed';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly content: string;
      }
    | {
          readonly type: 'set-markdown-editing';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly editing: boolean;
          /**
           * CONT-081: entering edit mode with an external `$EDITOR` records the launch command
           * on the pane, which is what makes it host a PTY instead of the built-in textarea.
           * Omitted = the built-in editor; leaving edit mode always clears it (CONT-090).
           */
          readonly externalEditorCommand?: string | undefined;
      }
    | {
          readonly type: 'set-markdown-font-size';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly size: number;
      }

    // ── layout / focus / zoom ──────────────────────────────────────────────
    | { readonly type: 'cycle-layout'; readonly workspaceID: string }
    | {
          readonly type: 'select-layout';
          readonly workspaceID: string;
          readonly kind: PredefinedLayoutKind;
      }
    | { readonly type: 'toggle-zoom'; readonly workspaceID: string }
    | { readonly type: 'focus-pane'; readonly workspaceID: string; readonly paneID: string | null }
    | { readonly type: 'focus-next-pane'; readonly workspaceID: string }
    | { readonly type: 'focus-previous-pane'; readonly workspaceID: string }

    // ── sync input ─────────────────────────────────────────────────────────
    | { readonly type: 'toggle-sync-input'; readonly workspaceID: string }
    | {
          readonly type: 'set-sync-input-active';
          readonly workspaceID: string;
          readonly active: boolean;
      }
    | {
          readonly type: 'set-sync-input-excluded';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly excluded: boolean;
      }

    // ── agent lifecycle + live pane metadata ───────────────────────────────
    | {
          readonly type: 'pane-agent-event';
          readonly paneID: string;
          readonly event: AgentEvent;
          readonly now: number;
          readonly workspaceID?: string | undefined;
      }
    | {
          readonly type: 'pane-title-changed';
          readonly paneID: string;
          readonly title: string | null;
          readonly now: number;
      }
    | {
          readonly type: 'pane-directory-changed';
          readonly paneID: string;
          readonly directory: string;
          readonly now: number;
      }
    | {
          readonly type: 'pane-branch-changed';
          readonly paneID: string;
          readonly branch: string | null;
      }

    // ── search (daemon keeps the coordinates; backends live in the client) ─
    | { readonly type: 'toggle-search'; readonly workspaceID: string }
    | { readonly type: 'close-search'; readonly workspaceID: string }
    | { readonly type: 'set-search-needle'; readonly workspaceID: string; readonly needle: string }
    | {
          readonly type: 'set-search-counts';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly total?: number | null | undefined;
          readonly selected?: number | null | undefined;
      };

export type DomainActionType = DomainAction['type'];

// ---------------------------------------------------------------------------
// Events (the WS state-sync delta stream)
// ---------------------------------------------------------------------------

/**
 * The slice of a workspace carried by `workspace-upserted`: everything except the pane lanes
 * (their own events), the layout tuple (`layout-changed`), focus (`focus-changed`) and the
 * sync fields (`sync-changed`). Ownership is disjoint so a mirror converges by replay.
 */
export type WorkspaceEnvelope = Omit<
    WorkspaceState,
    | 'panes'
    | 'parkedPanes'
    | 'layout'
    | 'zoomedPaneID'
    | 'savedLayout'
    | 'currentLayoutIndex'
    | 'focusedPaneID'
    | 'focusHistory'
    | 'isSyncInputActive'
    | 'syncInputExcluded'
>;

export type PaneLane = 'visible' | 'parked';

export type DomainEvent =
    | { readonly kind: 'workspace-upserted'; readonly id: string; readonly workspace: WorkspaceEnvelope }
    | { readonly kind: 'workspace-removed'; readonly id: string }
    | {
          readonly kind: 'pane-upserted';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly lane: PaneLane;
          readonly index: number;
          readonly pane: Pane;
      }
    | { readonly kind: 'pane-removed'; readonly workspaceID: string; readonly paneID: string }
    | {
          readonly kind: 'layout-changed';
          readonly workspaceID: string;
          readonly layout: PaneLayout;
          readonly zoomedPaneID: string | null;
          readonly savedLayout: PaneLayout | null;
          readonly currentLayoutIndex: number | null;
      }
    | {
          readonly kind: 'focus-changed';
          readonly workspaceID: string;
          readonly focusedPaneID: string | null;
          readonly focusHistory: readonly string[];
      }
    | {
          readonly kind: 'sync-changed';
          readonly workspaceID: string;
          readonly isSyncInputActive: boolean;
          readonly syncInputExcluded: readonly string[];
          /** Derived broadcast group after the change (§1.10). */
          readonly syncedPaneIDs: readonly string[];
      }
    | {
          readonly kind: 'agent-status-changed';
          readonly workspaceID: string;
          readonly paneID: string;
          readonly status: PaneStatus;
          readonly agentSessionID: string | null;
          readonly agentKind: AgentKind | null;
          readonly agentStartedAt: number | null;
          readonly backgroundTaskCount: number;
      }
    | { readonly kind: 'group-upserted'; readonly id: string; readonly index: number; readonly group: WorkspaceGroup }
    | { readonly kind: 'group-removed'; readonly id: string }
    | {
          readonly kind: 'order-changed';
          readonly workspaceOrder: readonly string[];
          readonly groupOrder: readonly string[];
          readonly topLevelOrder: readonly SidebarID[];
      }
    | { readonly kind: 'active-workspace-changed'; readonly workspaceID: string | null }
    | { readonly kind: 'label-presets-changed'; readonly presets: readonly LabelPreset[] }
    | { readonly kind: 'repos-changed'; readonly repos: readonly Repo[] };

export type DomainEventKind = DomainEvent['kind'];

// ---------------------------------------------------------------------------
// Constructors / defaults
// ---------------------------------------------------------------------------

export const MAX_FOCUS_HISTORY = 8;
export const MAX_RECENTLY_CLOSED_PANES = 10;

export function emptyDaemonState(homeDirectory: string): DaemonState {
    return {
        workspaces: [],
        groups: [],
        topLevelOrder: [],
        lastActiveWorkspaceID: null,
        repos: [],
        labelPresets: [],
        // A state with no DB behind it has nothing legacy to migrate; boot sets the marker on
        // the fresh-install path (§6.5) rather than defaulting it true here, so a state built
        // from an UNREADABLE database still gets the same one-shot treatment.
        labelPresetsMigrated: false,
        homeDirectory
    };
}

export interface NewWorkspaceFields {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly color: WorkspaceColor;
    /** Epoch seconds. */
    readonly createdAt: number;
    readonly icon?: IconRef | null | undefined;
    readonly profileName?: string | null | undefined;
    readonly labels?: readonly string[] | undefined;
    readonly panes?: readonly Pane[] | undefined;
    readonly layout?: PaneLayout | undefined;
    readonly focusedPaneID?: string | null | undefined;
    readonly repoAssociations?: readonly RepoAssociation[] | undefined;
    readonly webPanes?: Readonly<Record<string, WebPaneState>> | undefined;
    readonly lastAccessedAt?: number | undefined;
}

/** Build a workspace with every transient field at its default (§1.9 / §2). */
export function makeWorkspaceState(fields: NewWorkspaceFields): WorkspaceState {
    return {
        id: fields.id,
        name: fields.name,
        slug: fields.slug,
        color: fields.color,
        icon: fields.icon ?? null,
        profileName: fields.profileName ?? null,
        panes: fields.panes ?? [],
        parkedPanes: [],
        layout: fields.layout ?? { kind: 'empty' },
        focusedPaneID: fields.focusedPaneID ?? null,
        focusHistory: [],
        repoAssociations: fields.repoAssociations ?? [],
        recentlyClosedPanes: [],
        webPanes: fields.webPanes ?? {},
        zoomedPaneID: null,
        savedLayout: null,
        searchingPaneID: null,
        searchNeedle: '',
        searchTotal: null,
        searchSelected: null,
        currentLayoutIndex: null,
        createdAt: fields.createdAt,
        lastAccessedAt: fields.lastAccessedAt ?? fields.createdAt,
        labels: fields.labels ?? [],
        isSyncInputActive: false,
        syncInputExcluded: []
    };
}

export * from './snapshot.js';
