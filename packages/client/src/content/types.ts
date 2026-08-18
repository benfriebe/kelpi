/**
 * The client's mirror of the daemon's content-pane state (M5, `daemon/src/content/service.ts`).
 *
 * The daemon owns everything expensive — reading the file, watching it, running `git diff`, the
 * markdown/diff → HTML transformation and the authoritative edit buffer — and hands each
 * subscribed client this snapshot (content-panes.md port note 1). The client owns scroll state,
 * the copy button, the clipboard and the editor's keystrokes.
 *
 * The daemon does not export its type to the client (its package publishes `./store` only), so
 * the shape is restated here with a parse guard, exactly as `@nex/protocol` does for wire
 * messages: a field the daemon renames must fail loudly at the boundary rather than surface as
 * `undefined` three components deep.
 */

export type ContentPaneType = 'markdown' | 'diff' | 'scratchpad';

/** Scratchpads are always `edit`; diffs always `view` (content-panes.md §1.1). */
export type ContentMode = 'view' | 'edit';

/** The daemon message that carries a content change to a subscribed client. */
export const CONTENT_UPDATED_MESSAGE = 'content-updated';

export interface ContentPaneState {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly type: ContentPaneType;
    readonly mode: ContentMode;
    readonly filePath: string | null;
    /** The rendered HTML document (markdown + diff); null for scratchpads. */
    readonly html: string | null;
    /** The raw source — the edit buffer in edit mode, the markdown behind the preview in view mode. */
    readonly text: string | null;
    /** False when the last file read / git run failed; copy actions gate on it (§3.14). */
    readonly loaded: boolean;
    readonly error: string | null;
    /** True while the daemon's edit buffer holds unsaved changes. */
    readonly dirty: boolean;
    readonly fontSize: number;
    /** Derived from the ghostty background's luminance, NOT the OS theme (port note 9). */
    readonly isDark: boolean;
    /** Monotonic per pane: a state older than the one already held is dropped. */
    readonly revision: number;
    readonly updatedAt: number;
    /** `<base href>` for relative assets (markdown only), also embedded in `html`. */
    readonly assetBase: string | null;
}

const CONTENT_TYPES: ReadonlySet<string> = new Set(['markdown', 'diff', 'scratchpad']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function boolean(value: unknown): boolean {
    return value === true;
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Type-strict decode of a `state` payload; `null` for anything that is not one. */
export function parseContentState(value: unknown): ContentPaneState | null {
    if (!isRecord(value)) return null;
    const paneID = value['paneID'];
    const type = value['type'];
    const mode = value['mode'];
    if (typeof paneID !== 'string' || paneID.length === 0) return null;
    if (typeof type !== 'string' || !CONTENT_TYPES.has(type)) return null;
    if (mode !== 'view' && mode !== 'edit') return null;

    return {
        paneID,
        workspaceID: typeof value['workspaceID'] === 'string' ? value['workspaceID'] : '',
        type: type as ContentPaneType,
        mode,
        filePath: nullableText(value['filePath']),
        html: nullableText(value['html']),
        text: nullableText(value['text']),
        loaded: boolean(value['loaded']),
        error: nullableText(value['error']),
        dirty: boolean(value['dirty']),
        fontSize: numberOr(value['fontSize'], 14),
        isDark: boolean(value['isDark']),
        revision: numberOr(value['revision'], 0),
        updatedAt: numberOr(value['updatedAt'], 0),
        assetBase: nullableText(value['assetBase'])
    };
}

/**
 * Text/caret color for the plain-text editors (§4.2): the luminance rule against the ghostty
 * background, not a chrome token — the editor sits directly on the pane's terminal-colored fill.
 */
export function editorTextColor(isDark: boolean): string {
    return isDark ? 'rgba(255, 255, 255, 0.90)' : 'rgb(31, 31, 31)';
}
