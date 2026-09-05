/**
 * The Pane record.
 * Spec: docs/pane-layout.md §13.
 *
 * The layout tree stores pane IDs only; this is the metadata the workspace's
 * pane collection holds alongside it. The two can legitimately disagree
 * (parked panes, `movingPane` edge cases).
 */

import type { PaneID } from './types.js';

/** Only `shell` panes have terminal surfaces / sync input / can be captured. */
export type PaneType = 'shell' | 'markdown' | 'scratchpad' | 'diff' | 'web';

export const PANE_TYPES: readonly PaneType[] = [
    'shell',
    'markdown',
    'scratchpad',
    'diff',
    'web'
];

/** Persisted as these exact rawValue strings — note camelCase waitingForInput. */
export type PaneStatus = 'idle' | 'running' | 'waitingForInput';

export const PANE_STATUSES: readonly PaneStatus[] = ['idle', 'running', 'waitingForInput'];

export type AgentKind = 'claude' | 'codex';

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex'];

/** Markdown preview body font size; ⌘0 resets to this. */
export const DEFAULT_MARKDOWN_FONT_SIZE = 14;

/** Unix seconds (float) — the persistence encoding for pane timestamps. */
export type EpochSeconds = number;

/**
 * Unix milliseconds — the JS-native clock the transient agent fields use (@kelpi/core/agent's
 * state machine stamps them with `Date.now()`). Named apart from `EpochSeconds` because
 * confusing the two silently renders a "0s" elapsed clock rather than failing.
 */
export type EpochMilliseconds = number;

export interface Pane {
    /** Keys the layout leaf, the PTY surface, `--target`, `KELPI_PANE_ID`. */
    id: PaneID;
    label: string | null;
    type: PaneType;
    /** Transient: live OSC title, display-only. */
    title: string | null;
    workingDirectory: string;
    /** Transient: recomputed live from workingDirectory. */
    gitBranch: string | null;
    status: PaneStatus;
    /** Markdown file path, or diff scope path; null for shells. */
    filePath: string | null;
    /** Transient: markdown view/edit toggle (⌘E). */
    isEditing: boolean;
    /** Transient: $EDITOR command run in an attached surface instead of the built-in editor. */
    externalEditorCommand: string | null;
    /** Persisted in the `content` column; never written to a file. */
    scratchpadContent: string | null;
    agentSessionID: string | null;
    /** Persisted; deliberately NOT cleared when agentSessionID is cleared on load. */
    agentKind: AgentKind | null;
    /**
     * Persisted; the effective profile name (`KELPI_PROFILE`) the agent session was launched
     * under, so a resume can rebuild the same environment. Null = unknown → resume uses the
     * workspace's current profile. Last-known value, like `agentKind`.
     */
    agentProfileName: string | null;
    /** Transient: per-pane markdown font size. */
    markdownFontSize: number;
    /** Transient: `kelpi open --here` parked source pane. */
    parkedSourcePaneID: PaneID | null;
    /** Transient: set only on a non-running → running transition. Epoch MILLISECONDS. */
    agentStartedAt: EpochMilliseconds | null;
    /** Transient: in-flight Claude Code background units; non-zero keeps status running. */
    backgroundTaskCount: number;
    createdAt: EpochSeconds;
    lastActivityAt: EpochSeconds;
}

/** Fields that survive a restart, with their DB column names (§13.2). */
export const PANE_PERSISTED_COLUMNS: Readonly<Record<string, string>> = {
    id: 'id',
    label: 'label',
    type: 'type',
    workingDirectory: 'workingDirectory',
    status: 'status',
    filePath: 'filePath',
    scratchpadContent: 'content',
    agentSessionID: 'agentSessionID',
    agentKind: 'agentKind',
    agentProfileName: 'agentProfileName',
    createdAt: 'createdAt',
    lastActivityAt: 'lastActivityAt'
};

export const PANE_PERSISTED_FIELDS: readonly (keyof Pane)[] = [
    'id',
    'label',
    'type',
    'workingDirectory',
    'status',
    'filePath',
    'scratchpadContent',
    'agentSessionID',
    'agentKind',
    'agentProfileName',
    'createdAt',
    'lastActivityAt'
];

/** Must be reconstructed as empty/defaults on load (§15.10). */
export const PANE_TRANSIENT_FIELDS: readonly (keyof Pane)[] = [
    'title',
    'gitBranch',
    'isEditing',
    'externalEditorCommand',
    'markdownFontSize',
    'parkedSourcePaneID',
    'agentStartedAt',
    'backgroundTaskCount'
];

export interface NewPaneFields {
    id: PaneID;
    workingDirectory: string;
    createdAt: EpochSeconds;
    lastActivityAt: EpochSeconds;
    label?: string | null;
    type?: PaneType;
    status?: PaneStatus;
    filePath?: string | null;
    scratchpadContent?: string | null;
    agentSessionID?: string | null;
    agentKind?: AgentKind | null;
    agentProfileName?: string | null;
}

/** Build a pane with spec defaults; transient fields always start empty. */
export function makePane(fields: NewPaneFields): Pane {
    return {
        id: fields.id,
        label: fields.label ?? null,
        type: fields.type ?? 'shell',
        title: null,
        workingDirectory: fields.workingDirectory,
        gitBranch: null,
        status: fields.status ?? 'idle',
        filePath: fields.filePath ?? null,
        isEditing: false,
        externalEditorCommand: null,
        scratchpadContent: fields.scratchpadContent ?? null,
        agentSessionID: fields.agentSessionID ?? null,
        agentKind: fields.agentKind ?? null,
        agentProfileName: fields.agentProfileName ?? null,
        markdownFontSize: DEFAULT_MARKDOWN_FONT_SIZE,
        parkedSourcePaneID: null,
        agentStartedAt: null,
        backgroundTaskCount: 0,
        createdAt: fields.createdAt,
        lastActivityAt: fields.lastActivityAt
    };
}

/** Reset every transient field to its default (load path, §15.10). */
export function resetTransientPaneFields(pane: Pane): Pane {
    return {
        ...pane,
        title: null,
        gitBranch: null,
        isEditing: false,
        externalEditorCommand: null,
        markdownFontSize: DEFAULT_MARKDOWN_FONT_SIZE,
        parkedSourcePaneID: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

export function isUsingExternalEditor(pane: Pane): boolean {
    return pane.externalEditorCommand !== null;
}

/** Only shell panes carry a terminal surface. */
export function isTerminalPane(pane: Pane): boolean {
    return pane.type === 'shell';
}
