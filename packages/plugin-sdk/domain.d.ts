import type { Data, Json } from './index.js';

/** Public JSON DTOs. No daemon store, React, Electron or Node types are required. */
export type WorkspaceColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray' | 'black' | 'white';
export type PaneType = 'shell' | 'markdown' | 'scratchpad' | 'diff' | 'web' | 'plugin';
export type PaneStatus = 'idle' | 'running' | 'waitingForInput';
export type AgentKind = 'claude' | 'codex';
export type SplitDirection = 'horizontal' | 'vertical';
export type MoveDirection = 'left' | 'right' | 'up' | 'down';
export type DropZone = 'above' | 'below' | 'left-of' | 'right-of';
export type LayoutKind = 'even-horizontal' | 'even-vertical' | 'main-horizontal' | 'main-vertical' | 'tiled';
export type NamedKey = 'enter' | 'return' | 'tab' | 'escape' | 'esc' | 'space' | 'backspace' | 'up' | 'down' | 'left' | 'right' | 'ctrl-c';
export type PaneTarget = string | { paneID: string; workspaceID?: string };
/** An explicit workspace wins over current scope; otherwise current uses the live caller context. */
export interface PaneListOptions { workspaceID?: string; scope?: 'all' | 'current' }
export interface PaneInfo {
    id: string; type: PaneType; workspaceID: string; workspaceName: string;
    workingDirectory: string; status: PaneStatus; isFocused: boolean; isActiveWorkspace: boolean;
    createdAt: string; lastActivityAt: string; label?: string; title?: string; gitBranch?: string;
    agentSessionID?: string; agent?: AgentKind; backgroundTasks?: number; filePath?: string;
    groupID?: string; groupName?: string;
}
export interface WorkspaceInfo {
    id: string; name: string; color: WorkspaceColor; paneCount: number; isActive: boolean;
    createdAt: string; lastAccessedAt: string; labels: string[]; lastActivityAt?: string;
    agentSessionID?: string; groupID?: string; groupName?: string;
}
export interface GroupInfo { id: string; name: string; color?: WorkspaceColor; workspaces: { id: string; name: string }[] }
export interface PaneMutation { paneID: string; workspaceID: string; workspaceName: string; label?: string }
export interface PaneResize extends PaneMutation { splitPath: string; ratio: number; targetShare: number }
export interface PanePlacement { paneID: string; workspaceID: string }
export interface GroupOrder { groupID: string; groupName: string; order: string[] }
export interface WorkspaceIdentity { workspaceID: string; workspaceName: string }
export interface WorkspaceCreateOptions {
    name?: string; path?: string; color?: WorkspaceColor; groupID?: string; profile?: string;
    worktree?: string; branch?: string; updateMain?: boolean; repo?: string;
}
export interface WorkspaceCreated extends WorkspaceIdentity { group?: string; worktreePath?: string; branch?: string }
export interface WorkspaceMoveOptions { groupID?: string; index?: number }
export interface WorkspacesAPI {
    list(options?: { groupID?: string }): Promise<WorkspaceInfo[]>;
    create(options?: WorkspaceCreateOptions): Promise<WorkspaceCreated>;
    rename(workspaceID: string, name: string): Promise<{ workspaceID: string; name: string }>;
    /** Uses the CLI deletion guard, including its refusal to remove the final workspace. */
    remove(workspaceID: string, options?: { force?: boolean }): Promise<WorkspaceIdentity & { path?: string }>;
    move(workspaceID: string, options?: WorkspaceMoveOptions): Promise<void>;
    moveMany(workspaceIDs: string[], options?: WorkspaceMoveOptions): Promise<{ workspaceIDs: string[]; groupID: string | null; index: number | null }>;
    setProfile(workspaceID: string, profile: string | null): Promise<void>;
    labels(workspaceID: string, operation: 'set' | 'add' | 'remove' | 'clear', values?: string[]): Promise<WorkspaceIdentity & { labels: string[] }>;
    setColor(workspaceIDs: string[], color: WorkspaceColor): Promise<{ workspaceIDs: string[]; color: WorkspaceColor }>;
    setIcon(workspaceID: string, icon: string | null): Promise<{ workspaceID: string; icon: string | null }>;
}
export interface GroupsAPI {
    list(): Promise<GroupInfo[]>;
    create(name: string, options?: { color?: WorkspaceColor; workspaceIDs?: string[] }): Promise<{ groupID: string; name: string; workspaceIDs: string[] }>;
    rename(groupID: string, name: string): Promise<void>;
    remove(groupID: string, options?: { cascade?: boolean }): Promise<void>;
    reorder(groupID: string, workspaceIDs: string[]): Promise<GroupOrder>;
    sort(groupID: string, by: 'name' | 'last-activity' | 'last-accessed' | 'last-modified', options?: { descending?: boolean }): Promise<GroupOrder>;
    setCollapsed(groupID: string, collapsed: boolean): Promise<{ groupID: string; collapsed: boolean }>;
    setColor(groupID: string, color: WorkspaceColor | null): Promise<{ groupID: string; color: WorkspaceColor | null }>;
    setIcon(groupID: string, icon: string | null): Promise<{ groupID: string; icon: string | null }>;
}
export interface PanesAPI {
    list(options?: PaneListOptions): Promise<PaneInfo[]>;
    create(options?: { paneID?: string; workspaceID?: string; path?: string; name?: string }): Promise<PaneMutation>;
    split(pane: PaneTarget, options?: { direction?: SplitDirection; path?: string; name?: string }): Promise<PaneMutation>;
    close(pane: PaneTarget): Promise<PaneMutation>;
    rename(pane: PaneTarget, name: string): Promise<PaneMutation>;
    resize(pane: PaneTarget, options: { ratio: number; delta?: never } | { delta: number; ratio?: never }): Promise<PaneResize>;
    moveAdjacent(pane: PaneTarget, anchor: string, zone: DropZone): Promise<PaneMutation & { anchorID: string; zone: DropZone }>;
    move(paneID: string, direction: MoveDirection): Promise<void>;
    moveToWorkspace(paneID: string, workspaceID: string, options?: { create?: boolean }): Promise<void>;
    reopen(workspaceID: string): Promise<PanePlacement & { type: PaneType }>;
    scratchpad(workspaceID: string): Promise<PanePlacement>;
}
export interface LayoutAPI {
    /** Layout cycle/select acknowledge dispatch; a nonexistent pane is a daemon no-op. */
    cycle(paneID: string): Promise<void>;
    select(paneID: string, name: LayoutKind): Promise<void>;
    zoom(paneID: string): Promise<PanePlacement & { zoomedPaneID: string | null }>;
    setSplitRatio(workspaceID: string, splitPath: string, ratio: number): Promise<{ workspaceID: string; splitPath: string; ratio: number }>;
}
export interface AgentsAPI {
    /** Lists attached or remembered agent sessions; this does not launch a process. */
    list(options?: PaneListOptions): Promise<PaneInfo[]>;
    restart(paneID: string): Promise<{ paneID: string; workspaceID?: string; agent?: AgentKind; command?: string }>;
    setStatus(paneID: string, status: PaneStatus): Promise<PanePlacement & { status: PaneStatus }>;
    clearStatus(paneID: string): Promise<PanePlacement & { status: PaneStatus }>;
    reportStart(paneID: string, agent: AgentKind): Promise<void>;
    reportStop(paneID: string, options?: { backgroundTasks?: number }): Promise<void>;
    reportError(paneID: string, message: string): Promise<void>;
    notify(paneID: string, title: string, body: string, options?: { backgroundTasks?: number }): Promise<void>;
    sessionStart(paneID: string, sessionID: string, agent: AgentKind, options?: { profile?: string }): Promise<void>;
    sessionEnd(paneID: string, sessionID: string): Promise<void>;
}
export interface TerminalSubscription { subscription: string; paneID: string; base64: string; cols: number; rows: number }
export interface TerminalSync extends WorkspaceIdentity { active: boolean; syncedPaneIDs: string[]; excluded: { id: string; label?: string }[] }
export interface TerminalSearch {
    workspaceID: string; paneID: string | null; needle: string; total: number | null;
    selected: number | null; caseSensitive: boolean;
    match: { line: number; col: number; length: number; linesFromBottom: number } | null;
}
export interface TerminalAPI {
    /** Snapshot plus subscription; listen for terminal.output events and unwatch on disposal. */
    watch(paneID: string): Promise<TerminalSubscription>;
    unwatch(subscription: string): Promise<void>;
    send(pane: PaneTarget, text: string, options?: { bare?: boolean }): Promise<PaneMutation & { bare: boolean }>;
    sendKey(pane: PaneTarget, key: NamedKey): Promise<PaneMutation & { key: NamedKey }>;
    capture(pane: PaneTarget, options?: { lines?: number; scrollback?: boolean }): Promise<string>;
    sync(workspaceID: string, action?: 'on' | 'off' | 'toggle' | 'status'): Promise<TerminalSync>;
    excludeFromSync(pane: PaneTarget, excluded: boolean): Promise<TerminalSync>;
    /** Workspace find UI: toggle starts on its focused pane; set/next/prev use its existing search pane. */
    search(workspaceID: string, action: 'toggle' | 'set' | 'next' | 'prev' | 'close' | 'status', options?: { needle?: string; caseSensitive?: boolean }): Promise<TerminalSearch>;
}
export interface Repository {
    id: string; name: string; path: string; remoteURL: string | null; isAutoDiscovered: boolean; worktreeBase: string;
}
export interface RepositoryAssociation {
    id: string; repoID: string; repoName: string; repoPath: string | null;
    worktreePath: string; worktreePathReal: string; branch: string | null;
    isAutoDetected: boolean; isWorktree: boolean;
    status: { kind: 'clean' | 'dirty' | 'unknown'; changedFiles: number; additions: number; deletions: number };
}
export interface WorktreeOptions { name: string; repoID?: string; repoPath?: string; branch?: string; updateMain?: boolean }
export interface GraftScope { workspaceID?: string; repo?: string; paneID?: string }
export interface GraftSession {
    associationID: string; worktreePath: string; parentRepoRoot: string; branch: string;
    status: 'starting' | 'watching' | 'syncing' | 'error'; error?: string; stashRef?: string; lastSync?: string;
}
export interface GitAPI {
    repositories(): Promise<Repository[]>;
    status(workspaceID: string, options?: { refresh?: boolean }): Promise<RepositoryAssociation[]>;
    addRepository(path: string, options?: { name?: string }): Promise<Repository>;
    removeRepository(repoID: string): Promise<{ repoID: string; name: string; path: string; removedAssociations: string[] }>;
    renameRepository(repoID: string, name: string): Promise<Repository>;
    scan(path: string, options?: { maxDepth?: number }): Promise<{ root: string; scanned: number; added: Repository[]; skipped: string[] }>;
    associate(workspaceID: string, path: string): Promise<RepositoryAssociation>;
    dissociate(workspaceID: string, associationID: string, options?: { deleteWorktree?: boolean }): Promise<{ workspaceID: string; associationID: string; worktreePath: string; worktreeDeleted: boolean }>;
    addWorktree(workspaceID: string, options: WorktreeOptions): Promise<{ workspaceID: string; repoID: string; worktreePath: string; branch: string; association: RepositoryAssociation }>;
    diff(repoPath: string, options?: { targetPath?: string; paneID?: string; workspaceID?: string }): Promise<void>;
    graft: {
        status(): Promise<GraftSession[]>;
        start(options?: GraftScope): Promise<{ started: { associationID: string; worktreePath: string; branch: string; parentRepoRoot: string }[]; partialError?: string }>;
        /** A partial failure rejects with KelpiError.details containing stopped/failed entries. */
        stop(options?: GraftScope): Promise<{ stopped: string[] }>;
    };
}
export interface Profile { name: string; env: Record<string, string> }
export interface RemoteDaemon { name: string; url: string }
export interface ApplicationSettings {
    keybindLines: string[];
    general: {
        focusFollowsMouse: boolean; focusFollowsMouseDelay: number; theme: string | null;
        confirmWorkspaceDeleteWhenActive: boolean; confirmQuitWhenActive: boolean; tcpPort: number;
        globalHotkey: string | null; globalHotkeyHideOnRepress: boolean; autoDetectRepos: boolean;
        worktreeBasePath: string; newWorkspacePlacement: string; newGroupPlacement: string;
        inheritGroupOnNewWorkspace: boolean; expandGroupOnWorkspaceDrop: boolean; clipboardWrite: boolean;
    };
    appearance: {
        backgroundColor: string; backgroundOpacity: number; fontFamily: string | null; fontSize: number | null;
        windowPaddingX: number | null; windowPaddingY: number | null; isDark: boolean; theme: string | null;
        terminalTheme: { name: string | null; path: string | null; palette: Record<string, string>; error: string | null };
    };
    chrome: Data; profiles: Profile[]; remoteDaemons: RemoteDaemon[];
}
export type GeneralSettingKey = 'focus-follows-mouse' | 'focus-follows-mouse-delay' | 'tcp-port' | 'global-hotkey'
    | 'global-hotkey-hide-on-repress' | 'confirm-workspace-delete' | 'confirm-quit-when-active' | 'chrome-appearance'
    | 'chrome-colors' | 'sidebar-color-intensity' | 'sidebar-avatar-fill' | 'sidebar-avatar-stroke' | 'sidebar-group-fill'
    | 'sidebar-group-stroke' | 'show-system-stats' | 'system-stats' | 'show-system-stat-graphs' | 'sparkline-style'
    | 'sparkline-color' | 'sparkline-width' | 'search-match-color' | 'search-match-text-color' | 'search-match-current-color'
    | 'search-match-current-text-color' | 'auto-detect-repos' | 'worktree-base-path' | 'new-workspace-placement'
    | 'new-group-placement' | 'inherit-group-on-new-workspace' | 'expand-group-on-workspace-drop' | 'clipboard-write';
export type AppearanceSettingKey = 'background' | 'background-opacity' | 'font-family' | 'font-size' | 'theme' | 'window-padding-x' | 'window-padding-y';
export interface ApplicationSettingsAPI {
    /** Daemon application settings. api.settings remains scoped to this plugin. */
    get(): Promise<ApplicationSettings>;
    setGeneral(key: GeneralSettingKey, value: string | number | boolean): Promise<ApplicationSettings>;
    setAppearance(key: AppearanceSettingKey, value: string | number | boolean | null): Promise<ApplicationSettings>;
    setKeybinding(action: string, trigger: string | null): Promise<ApplicationSettings>;
    resetKeybindings(action?: string | null): Promise<ApplicationSettings>;
    setProfiles(profiles: Profile[]): Promise<ApplicationSettings>;
    setRemoteDaemons(daemons: RemoteDaemon[]): Promise<ApplicationSettings>;
}
export interface SnapshotPane {
    id: string; type: PaneType; title: string | null; label: string | null; status: PaneStatus;
    workingDirectory: string; workingDirectoryReal: string; agentKind: AgentKind | null; agentSessionID: string | null;
    plugin?: { pluginID: string; viewID: string; stateVersion: number; state: Data } | null;
    [key: string]: Json | undefined;
}
export interface SnapshotWorkspace {
    id: string; name: string; color: WorkspaceColor; labels: string[]; panes: SnapshotPane[]; parkedPanes: SnapshotPane[];
    focusedPaneID: string | null; zoomedPaneID: string | null; layout: Json; recentlyClosedCount: number;
    [key: string]: unknown;
}
export interface StateSnapshot {
    workspaces: SnapshotWorkspace[]; groups: Data[]; topLevelOrder: Data[];
    lastActiveWorkspaceID: string | null; repos: Data[]; labelPresets: Data[];
}
export interface Snapshot { epoch: string; sequence: number; state: StateSnapshot }
