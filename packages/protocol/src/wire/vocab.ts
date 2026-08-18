/**
 * Wire vocabularies (wire-protocol.md §5, §9 port note 14).
 *
 * Each vocabulary documents its own invalid-value handling because the handling differs
 * per field: an invalid split `direction` is treated as absent, an invalid move
 * `direction` drops the whole message, an invalid `color` is treated as absent, and an
 * unknown named `key` is answered with a structured error (not a drop).
 */

export const AGENT_KINDS = ['claude', 'codex'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Case-insensitive; absent or unrecognized → `claude` (pre-Codex CLIs keep working). */
export function parseAgentKind(raw: string | undefined): AgentKind {
    if (raw === undefined) return 'claude';
    const lowered = raw.toLowerCase();
    return AGENT_KINDS.find((kind) => kind === lowered) ?? 'claude';
}

export const SPLIT_DIRECTIONS = ['horizontal', 'vertical'] as const;
export type SplitDirection = (typeof SPLIT_DIRECTIONS)[number];

/** `pane-split`: an unrecognized value parses as **absent** (handler default), never a drop. */
export function parseSplitDirection(raw: string | undefined): SplitDirection | undefined {
    return SPLIT_DIRECTIONS.find((value) => value === raw);
}

export const MOVE_DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

/** `pane-move`: an unrecognized value **drops** the message (caller enforces). */
export function parseMoveDirection(raw: string | undefined): MoveDirection | undefined {
    return MOVE_DIRECTIONS.find((value) => value === raw);
}

export const DROP_ZONES = ['above', 'below', 'left-of', 'right-of'] as const;
export type DropZone = (typeof DROP_ZONES)[number];

/** `pane-move-adjacent`: missing or unrecognized **drops** the message. */
export function parseDropZone(raw: string | undefined): DropZone | undefined {
    return DROP_ZONES.find((value) => value === raw);
}

export const WORKSPACE_COLORS = [
    'red',
    'orange',
    'yellow',
    'green',
    'blue',
    'purple',
    'pink',
    'gray',
    'black',
    'white'
] as const;
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/** Unrecognized → absent (the handler picks a random color); never a drop. Exact match. */
export function parseWorkspaceColor(raw: string | undefined): WorkspaceColor | undefined {
    return WORKSPACE_COLORS.find((value) => value === raw);
}

export const NAMED_KEYS = [
    'enter',
    'return',
    'tab',
    'escape',
    'esc',
    'space',
    'backspace',
    'up',
    'down',
    'left',
    'right',
    'ctrl-c'
] as const;
export type NamedKey = (typeof NAMED_KEYS)[number];

/** `pane-send-key`: lowercase, then validate. Unknown → structured error reply, not a drop. */
export function parseNamedKey(raw: string): NamedKey | undefined {
    const lowered = raw.toLowerCase();
    return NAMED_KEYS.find((value) => value === lowered);
}

/** The exact `{"ok":false,"error":…}` text for an unknown `pane-send-key` key. */
export function unknownNamedKeyError(raw: string): string {
    return `unknown key '${raw.toLowerCase()}' (valid: ${NAMED_KEYS.join(', ')})`;
}

export const PANE_TYPES = ['shell', 'markdown', 'scratchpad', 'diff', 'web'] as const;
export type PaneType = (typeof PANE_TYPES)[number];

export const PANE_STATUSES = ['idle', 'running', 'waitingForInput'] as const;
export type PaneStatus = (typeof PANE_STATUSES)[number];

export const SYNC_ACTIONS = ['on', 'off', 'toggle', 'status'] as const;
export type SyncAction = (typeof SYNC_ACTIONS)[number];

export const LABEL_OPS = ['set', 'add', 'remove', 'clear'] as const;
export type LabelOp = (typeof LABEL_OPS)[number];

export const GROUP_SORT_KEYS = ['name', 'last-activity', 'last-accessed', 'last-modified'] as const;
export type GroupSortKey = (typeof GROUP_SORT_KEYS)[number];

export const PANE_LIST_SCOPES = ['all', 'current'] as const;
export type PaneListScope = (typeof PANE_LIST_SCOPES)[number];

/** web-pane.md §8.2 / cli.md §15.6 (`meta, text, screenshot, dom, all`). */
export const WEB_CAPTURE_MODES = ['meta', 'text', 'screenshot', 'dom', 'all'] as const;
export type WebCaptureMode = (typeof WEB_CAPTURE_MODES)[number];

export const WEB_CONSOLE_LEVELS = ['log', 'debug', 'info', 'warn', 'error'] as const;
export type WebConsoleLevel = (typeof WEB_CONSOLE_LEVELS)[number];

export const WEB_SCROLL_BLOCKS = ['start', 'center', 'end'] as const;
export type WebScrollBlock = (typeof WEB_SCROLL_BLOCKS)[number];

export const WEB_SCROLL_BEHAVIORS = ['instant', 'smooth'] as const;
export type WebScrollBehavior = (typeof WEB_SCROLL_BEHAVIORS)[number];

/** `count=N` / `text=X` suffixes are parsed downstream, not at the wire. */
export const WEB_WAIT_CONDITIONS = ['visible', 'hidden', 'exists', 'url-match'] as const;

export const GRAFT_STATUSES = ['starting', 'watching', 'syncing', 'error'] as const;
export type GraftStatus = (typeof GRAFT_STATUSES)[number];

export const PREDEFINED_LAYOUTS = [
    'even-horizontal',
    'even-vertical',
    'main-horizontal',
    'main-vertical',
    'tiled'
] as const;
export type PredefinedLayout = (typeof PREDEFINED_LAYOUTS)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Foundation `UUID(uuidString:)` semantics: case-insensitive canonical 8-4-4-4-12 only. */
export function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

/** Parsed UUIDs are canonicalized to uppercase, matching the casing replies emit. */
export function normalizeUuid(value: string): string | undefined {
    return isUuid(value) ? value.toUpperCase() : undefined;
}
