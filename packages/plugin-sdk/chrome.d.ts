/** The primary daemon's toolbar/status model in this window. No connection credentials. */
export interface ChromeSnapshot {
    readonly connection: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'rejected';
    readonly ready: boolean;
    /** Window chrome belongs to the primary daemon even while its grid shows a remote. */
    readonly remoteWorkspaceSelected: boolean;
    readonly workspace: {
        readonly id: string; readonly name: string; readonly color: string; readonly paneCount: number;
        readonly layout: string | null; readonly syncInputActive: boolean; readonly syncedPaneCount: number;
    } | null;
    readonly focusedPane: {
        readonly id: string; readonly title: string; readonly type: string;
        readonly workingDirectory: string; readonly gitBranch: string | null;
        readonly status: 'running' | 'waitingForInput' | 'idle';
        readonly agentKind: string | null; readonly agentStartedAt: number | null;
    } | null;
    readonly sidebars: Readonly<Record<'left' | 'right', { readonly viewID: string; readonly title: string; readonly visible: boolean }>>;
    readonly sizeControl: 'unclaimed' | 'this-window' | 'other-window';
    readonly layouts: readonly { readonly id: string; readonly title: string }[];
    /** The same current command declarations used by bundled chrome. */
    readonly commands: readonly ChromeCommand[];
    readonly agents: { readonly running: number; readonly waiting: number; readonly inactive: number };
    readonly agentPanes: readonly {
        readonly workspaceID: string; readonly workspaceName: string; readonly paneID: string;
        readonly title: string; readonly bucket: 'running' | 'waiting' | 'inactive'; readonly agentStartedAt: number | null;
    }[];
    readonly git: { readonly changedFiles: number; readonly additions: number; readonly deletions: number } | null;
    /** Null until the primary daemon supplies a sample. Values are display-ready, daemon-owned metrics. */
    readonly systemStats: readonly { readonly id: string; readonly title: string; readonly text: string; readonly detail: string }[] | null;
    readonly items: readonly ChromeItem[];
    /** The live keyboard map Help draws, native and plugin. Read-only: rebinding stays in Settings. */
    readonly keymap: ChromeKeymap;
}
/**
 * Every shortcut in this window's own spelling (`⌘D` on macOS, `Ctrl+D` elsewhere), after the
 * user's rebinds and unbinds. Nothing here can change a binding.
 */
export interface ChromeKeymap {
    /** Native actions by Settings category, in Help's order. */
    readonly sections: readonly ChromeKeymapSection[];
    /**
     * The primary daemon's enabled, running plugins in plugin and declaration order (the order that
     * wins a collision), each command listed whatever its `when`.
     */
    readonly plugins: readonly ChromeKeymapPlugin[];
    /** Plugin commands after the carried ones that this snapshot had no room for. Usually zero. */
    readonly withheld: number;
}
export interface ChromeKeymapSection {
    readonly category: string;
    readonly actions: readonly { readonly action: string; readonly title: string; readonly shortcut: string | null }[];
}
export interface ChromeKeymapPlugin {
    /** The plugin's display name. */
    readonly name: string;
    readonly commands: readonly ChromeKeymapCommand[];
}
export interface ChromeKeymapCommand {
    readonly id: string;
    readonly title: string;
    /** The chord that runs this command while it applies; null when it has none, or loses it. */
    readonly shortcut: string | null;
    /**
     * Set when the command's own shortcut runs something else first: a native action, or an
     * earlier plugin command (`plugin` names its plugin). `shortcut` is then null.
     */
    readonly shadowed: { readonly shortcut: string; readonly by: string; readonly plugin: string | null } | null;
    /**
     * Set when the command does not apply right now and a later plugin command holds its
     * `shortcut` meanwhile: pressing it runs that command until this one applies again.
     */
    readonly currently: { readonly by: string; readonly plugin: string } | null;
}
export interface ChromeCommand {
    readonly id: string; readonly title: string; readonly enabled: boolean;
    readonly checked?: boolean;
    readonly group: 'layout' | 'window' | 'menu';
    /** Adjacent menu entries in different sections receive a separator. */
    readonly section?: string;
}
export interface ChromeItem {
    readonly id: string; readonly placement: 'workspace.header' | 'statusbar'; readonly text: string;
    readonly tooltip?: string; readonly badge?: string;
    readonly tone: 'default' | 'info' | 'success' | 'warning' | 'error';
    readonly enabled: boolean; readonly commandID: string | null;
}
export interface ChromeCommandTarget {
    /** Required by layout/input commands. A stale selection rejects instead of acting on another workspace. */
    readonly workspaceID?: string;
    /** Required, with workspaceID, by kelpi.pane.focus. */
    readonly paneID?: string;
}
export interface WindowChromeAPI {
    getChrome(): Promise<ChromeSnapshot>;
    /** Initial/latest snapshots, with bounded delivery. Disposal releases awaited listeners. */
    onChrome(listener: (value: ChromeSnapshot) => void | Promise<void>, onError?: (error: Error) => void | Promise<void>): () => void;
    /** Runs a currently available chrome command, rechecking its target and enablement. */
    executeChromeCommand(id: string, target?: ChromeCommandTarget): Promise<void>;
}
