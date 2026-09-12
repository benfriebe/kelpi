/**
 * What a window interaction request IS, who may raise one, and what a presenter may be told.
 *
 * This module is the only place the option shapes are parsed, and it is deliberately free of
 * React, of the client store and of the daemon mirror: everything in here is data, so the rules
 * can be asserted without mounting a window. `surface.ts` owns the behaviour; this owns the
 * vocabulary.
 *
 * The validation below moved verbatim out of `plugins/ui-services.ts` (the `options()` funnel and
 * its five helpers). It copies and FREEZES author data on the way in - a view that mutates the
 * object it passed must not be able to change the choice the user is looking at - and it rejects
 * before any queue capacity is reserved.
 *
 * ── Owner identity ──────────────────────────────────────────────────────────────────
 *
 * An owner is a window-local scope: the view nonce for a plugin, `native:<verb>` for one of the
 * client's own verbs. `displayName` is the ONLY identity a presenter may render. `pluginID` stays
 * on the internal record (the request router needs it) and never reaches a presenter DTO, because
 * a replaceable presenter that can read it can enumerate the other plugins in the window.
 */

import type { JsonObject, JsonValue, WorkspaceColor } from '@kelpi/protocol';
import type {
    UIDialogOptions,
    UIInputOptions,
    UINotificationOptions,
    UIQuickPickItem,
    UIQuickPickOptions
} from '../../../plugin-sdk/ui.js';

/** The four request methods a plugin view may send at its window. */
export const INTERACTION_PROMPT_METHODS = [
    'ui.showQuickPick',
    'ui.showInput',
    'ui.showDialog',
    'ui.showNotification'
] as const;

export const INTERACTION_LIMITS = Object.freeze({
    scopes: 128,
    scopePending: 8,
    windowPending: 32,
    notifications: 4,
    notificationMs: 10_000,
    items: 200,
    actions: 8,
    input: 16_384,
    payloadBytes: 256 * 1024
});

/**
 * §10.4's "wait 200 ms, then imperatively focus the target pane's surface" - the same number
 * `chrome/CommandPalette.tsx` exports as `FOCUS_HANDOFF_MS`, restated here so the surface can
 * schedule the handoff without importing a React component.
 */
export const INTERACTION_HANDOFF_MS = 200;

// ── owners ──────────────────────────────────────────────────────────────────────────

export interface InteractionOwner {
    /** Scope id: the view nonce for a plugin, `native:<verb>` for one of the client's verbs. */
    readonly id: string;
    readonly kind: 'plugin' | 'native';
    /** Plugin owners only, and never copied into a presenter DTO. */
    readonly pluginID?: string | undefined;
    /** What a presenter may render (a plugin's `pluginName`, or the verb's own label). */
    readonly displayName: string;
}

/**
 * What a caller hands `createScope` / `palette.open`.
 *
 * The plugin arm keeps the exact shape `PluginView` has always passed (`{ id, pluginID,
 * pluginName }`), so the plugin host changes by nothing at all.
 */
export type InteractionOwnerInput =
    | { readonly id: string; readonly kind: 'native'; readonly displayName: string }
    | {
          readonly id: string;
          readonly kind?: 'plugin' | undefined;
          readonly pluginID: string;
          readonly pluginName: string;
      };

export function normalizeInteractionOwner(raw: InteractionOwnerInput): InteractionOwner {
    const id = text(raw.id, 'Scope ID', 200);
    if (raw.kind === 'native') {
        return Object.freeze({ id, kind: 'native' as const, displayName: text(raw.displayName, 'Owner name', 200) });
    }
    return Object.freeze({
        id,
        kind: 'plugin' as const,
        pluginID: text(raw.pluginID, 'Plugin ID', 160),
        displayName: text(raw.pluginName, 'Plugin name', 200)
    });
}

// ── requests ────────────────────────────────────────────────────────────────────────

interface RequestBase {
    readonly id: string;
    readonly owner: InteractionOwner;
}

/**
 * Kind and options WITHOUT the identity - what `validateInteractionOptions` produces.
 *
 * Spelled as its own union rather than as `Pick<InteractionRequest, 'kind' | 'options'>`, because
 * `Pick` over a union collapses to one member with unioned property types and a caller can then no
 * longer narrow `options` by switching on `kind`.
 */
export type InteractionModalBody =
    | { readonly kind: 'quickPick'; readonly options: UIQuickPickOptions }
    | { readonly kind: 'input'; readonly options: UIInputOptions }
    | { readonly kind: 'dialog'; readonly options: UIDialogOptions };

export type InteractionNotificationBody = { readonly kind: 'notification'; readonly options: UINotificationOptions };

export type InteractionRequestBody = InteractionModalBody | InteractionNotificationBody;

export type InteractionModalRequest = RequestBase & InteractionModalBody;

export type InteractionNotification = RequestBase & InteractionNotificationBody;

export type InteractionRequest = InteractionModalRequest | InteractionNotification;

// ── the palette session ─────────────────────────────────────────────────────────────

export type InteractionPaletteScope = 'all' | 'workspace' | 'pane';

/**
 * A palette row as a presenter may see it: `chrome/palette.ts`'s `PaletteItem` with every
 * function-valued field removed. The `run` closure a command row used to carry is exactly what a
 * replaceable presenter must never hold - it is an unchecked call into the window - so activation
 * goes back through `surface.palette.activate(sessionID, itemID)` instead.
 */
export interface InteractionPaletteItem {
    readonly id: string;
    readonly kind: 'workspace' | 'pane' | 'command';
    readonly icon: string;
    readonly title: string;
    readonly subtitle: string;
    readonly workspaceID: string | null;
    readonly workspaceName: string;
    readonly paneID: string | null;
    readonly workspaceColor: WorkspaceColor | null;
    readonly disabled?: boolean | undefined;
    readonly shortcut?: string | undefined;
}

/** The projection itself: named fields only, so no closure can survive the copy. */
export function interactionPaletteItem(item: InteractionPaletteItem): InteractionPaletteItem {
    return Object.freeze({
        id: item.id,
        kind: item.kind,
        icon: item.icon,
        title: item.title,
        subtitle: item.subtitle,
        workspaceID: item.workspaceID,
        workspaceName: item.workspaceName,
        paneID: item.paneID,
        workspaceColor: item.workspaceColor,
        ...(item.disabled === undefined ? {} : { disabled: item.disabled }),
        ...(item.shortcut === undefined ? {} : { shortcut: item.shortcut })
    });
}

export interface InteractionPaletteSnapshot {
    /** Minted on open, cleared on dismissal. Every session-scoped call is checked against it. */
    readonly sessionID: string | null;
    readonly open: boolean;
    readonly query: string;
    readonly scope: InteractionPaletteScope;
    /** The whole universe; the presenter applies the matching rule itself. */
    readonly items: readonly InteractionPaletteItem[];
    readonly selectedID: string | null;
    /** Mirrors `ChromeSnapshot.remoteWorkspaceSelected`: a remote grid fills the window. */
    readonly remoteWorkspaceSelected: boolean;
}

export interface InteractionPaletteSourceSnapshot {
    readonly items: readonly InteractionPaletteItem[];
}

/**
 * The seam onto `features/palette-source.ts`: descriptors out, an id back in.
 *
 * `execute` re-resolves the id against a fresh read and re-checks enablement, plugin availability
 * and target existence before it dispatches - the same discipline `features/chrome-source.ts`
 * applies to a chrome command id.
 */
export interface InteractionPaletteSource {
    subscribe(listener: () => void): () => void;
    snapshot(): InteractionPaletteSourceSnapshot;
    execute(itemID: string, target: JsonObject): Promise<void>;
}

export type InteractionDismissReason = 'user' | 'activated' | 'presenter-failed' | 'window-disposed';

// ── the window's snapshot ───────────────────────────────────────────────────────────

export interface InteractionSnapshot {
    readonly activeModal: InteractionModalRequest | null;
    /** Modal requests waiting behind the active prompt. Notifications have a separate queue. */
    readonly queued: number;
    readonly notifications: readonly InteractionNotification[];
    readonly palette: InteractionPaletteSnapshot;
}

// ── validation (moved verbatim from plugins/ui-services.ts) ─────────────────────────

type Data = Record<string, unknown>;

function record(value: unknown, keys: readonly string[]): Data {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
        throw new Error('UI options must be a plain object.');
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unknown UI option.');
    return value as Data;
}

function text(value: unknown, label: string, maximum: number, empty = false): string {
    if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()))
        throw new Error(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${maximum} characters.`);
    return value;
}

function optionalText(data: Data, key: string, maximum: number): Record<string, string> {
    return data[key] === undefined ? {} : { [key]: text(data[key], key, maximum, true) };
}

function optionalBoolean(data: Data, key: string): Record<string, boolean> {
    if (data[key] === undefined) return {};
    if (typeof data[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
    return { [key]: data[key] };
}

function rows(value: unknown, maximum: number, minimum = 0): unknown[] {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
        throw new Error(`UI items must contain ${minimum}–${maximum} entries.`);
    return value;
}

function distinct<T extends { readonly id: string }>(items: T[]): readonly T[] {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('UI item IDs must be unique.');
    return Object.freeze(items.map((item) => Object.freeze(item)));
}

/** The one parser: a method name plus author data in, a frozen request body out. */
export function validateInteractionOptions(method: string, raw: unknown): InteractionRequestBody {
    if (method === 'ui.showQuickPick') {
        const data = record(raw, ['title', 'placeholder', 'items', 'selectedID']);
        const items = distinct(
            rows(data['items'], INTERACTION_LIMITS.items).map((value): UIQuickPickItem => {
                const row = record(value, ['id', 'label', 'description', 'disabled']);
                return {
                    id: text(row['id'], 'Item ID', 128),
                    label: text(row['label'], 'Item label', 200),
                    ...optionalText(row, 'description', 1024),
                    ...optionalBoolean(row, 'disabled')
                };
            })
        );
        const selectedID = data['selectedID'];
        if (selectedID !== undefined && !items.some((item) => item.id === selectedID && !item.disabled))
            throw new Error('selectedID must identify an enabled item.');
        return {
            kind: 'quickPick',
            options: Object.freeze({
                title: text(data['title'], 'Title', 200),
                items,
                ...optionalText(data, 'placeholder', 200),
                ...optionalText(data, 'selectedID', 128)
            })
        };
    }
    if (method === 'ui.showInput') {
        const data = record(raw, ['title', 'prompt', 'value', 'placeholder', 'password', 'maxLength']);
        const maxLength = data['maxLength'] ?? 4096;
        if (
            typeof maxLength !== 'number' ||
            !Number.isSafeInteger(maxLength) ||
            maxLength < 1 ||
            maxLength > INTERACTION_LIMITS.input
        )
            throw new Error(`maxLength must be an integer from 1 to ${INTERACTION_LIMITS.input}.`);
        return {
            kind: 'input',
            options: Object.freeze({
                title: text(data['title'], 'Title', 200),
                maxLength,
                ...optionalText(data, 'prompt', 2048),
                ...optionalText(data, 'value', maxLength),
                ...optionalText(data, 'placeholder', 200),
                ...optionalBoolean(data, 'password')
            })
        };
    }
    if (method === 'ui.showDialog') {
        const data = record(raw, ['title', 'message', 'detail', 'actions', 'cancelID']);
        const actions = distinct(
            rows(data['actions'], INTERACTION_LIMITS.actions, 1).map((value) => {
                const row = record(value, ['id', 'label', 'kind']);
                if (
                    row['kind'] !== undefined &&
                    (typeof row['kind'] !== 'string' || !['default', 'primary', 'danger'].includes(row['kind']))
                )
                    throw new Error('Unknown dialog action kind.');
                return {
                    id: text(row['id'], 'Action ID', 128),
                    label: text(row['label'], 'Action label', 200),
                    ...(row['kind'] === undefined ? {} : { kind: row['kind'] as 'default' | 'primary' | 'danger' })
                };
            })
        );
        if (data['cancelID'] !== undefined && !actions.some((item) => item.id === data['cancelID']))
            throw new Error('cancelID must identify a dialog action.');
        return {
            kind: 'dialog',
            options: Object.freeze({
                title: text(data['title'], 'Title', 200),
                message: text(data['message'], 'Message', 2048),
                actions,
                ...optionalText(data, 'detail', 8192),
                ...optionalText(data, 'cancelID', 128)
            })
        };
    }
    if (method === 'ui.showNotification') {
        const data = record(raw, ['message', 'detail', 'tone', 'actions']);
        const tone = data['tone'] ?? 'info';
        if (typeof tone !== 'string' || !['info', 'success', 'warning', 'error'].includes(tone))
            throw new Error('Unknown notification tone.');
        const actions = distinct(
            rows(data['actions'] ?? [], INTERACTION_LIMITS.actions).map((value) => {
                const row = record(value, ['id', 'label']);
                return { id: text(row['id'], 'Action ID', 128), label: text(row['label'], 'Action label', 200) };
            })
        );
        return {
            kind: 'notification',
            options: Object.freeze({
                message: text(data['message'], 'Message', 2048),
                ...optionalText(data, 'detail', 8192),
                tone: tone as NonNullable<UINotificationOptions['tone']>,
                actions
            })
        };
    }
    throw new Error('Unknown window UI method.');
}

/**
 * The answer side of the same funnel: a result is re-checked against the request it claims to
 * settle, because the presenter that supplies it is replaceable and the caller's promise is not.
 */
export function validateInteractionAnswer(request: InteractionRequest, value: string | null): void {
    if (value === null) return;
    if (request.kind === 'input') {
        text(value, 'Input', request.options.maxLength ?? 4096, true);
        return;
    }
    if (request.kind === 'quickPick') {
        if (!request.options.items.some((item) => item.id === value && !item.disabled))
            throw new Error('Choose an enabled item.');
        return;
    }
    if (!request.options.actions?.some((action) => action.id === value)) throw new Error('Unknown UI action.');
}

export type { JsonValue };
