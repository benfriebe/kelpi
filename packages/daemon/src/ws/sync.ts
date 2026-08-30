/**
 * The state-sync half of the client socket (WP2.7).
 *
 * Per connection: `hello` → `welcome` → one `snapshot` → an ordered `delta` stream, plus
 * client→daemon commands (the control-protocol verbs), focus/visibility reports, and the
 * daemon→client notification fan-out.
 *
 * Design rules taken from PLAN.md / ARCHITECTURE.md:
 *   - **Clients are views.** They mirror `DaemonState` and apply `DomainEvent`s; no domain
 *     logic runs client-side, so the deltas are the store's own events (serialized by
 *     `./serialize.ts`, which strips the server-only fields).
 *   - **Active workspace is per client**, workspace focus is daemon-canonical: a
 *     `focus-report` moves the workspace's `focusedPaneID` (last report from any client
 *     wins) so `layout select main-*` and friends keep their CLI semantics, while each
 *     connection's own active workspace lives here and only nudges the daemon's persisted
 *     `lastActiveWorkspaceID`.
 *   - **Notifications are decided by the daemon and broadcast**; a client that has the
 *     pane focused and visible reports it, and that report suppresses delivery to that
 *     client (agent-lifecycle.md §7 + Port note 2: with nothing attached, "app active" is
 *     false, so headless operation still notifies).
 *   - **Commands** ride the same decode path as the control socket, dual-fire included, so
 *     a WS client and the `kelpi` CLI cannot drift.
 *   - **This is where authentication happens.** The `/ws` upgrade classifies a connection
 *     (authenticated / anonymous) but no longer refuses one, because a refused upgrade reaches
 *     a browser as an anonymous close 1006 that it can only retry. The handshake can instead
 *     answer `rejected` with a reason the user can act on, then close with a coded frame. An
 *     un-helloed connection is closed after `DEFAULT_HELLO_TIMEOUT_MS`, and nothing at all —
 *     JSON or binary — is accepted before `welcome`.
 */

import { randomUUID } from 'node:crypto';

import {
    WS_CLIENT_KINDS,
    WS_HOTKEY_STATUS_MESSAGE,
    WS_PROTOCOL_VERSION,
    WS_SHELL_ACTIVATION_MESSAGE,
    WS_WORKSPACE_SELECTION_MESSAGE,
    WS_SETTINGS_CHANGED_MESSAGE,
    WS_SETTINGS_COMMANDS,
    decodeWireObject,
    dispatchSequence,
    errorReply,
    isWsSettingsCommand,
    parseWorkspaceColor,
    type JsonObject,
    type WsClientInfo,
    type WsClientKind,
    type WsProfile,
    type WsRejectionCode,
    type WsRejectionReason,
    type WsSettingsCommand,
    type WsSettingsSnapshot,
    type WsTransportStatus
} from '@kelpi/protocol';

import { formatIconString, newUUID, normalizeIconEmoji, parseIconString } from '@kelpi/core/codec';
import { ratioAtPath } from '@kelpi/core/layout';

import type { ContentMode, ContentPaneState, ContentSubscription } from '../content/index.js';
import { dualFireMessage } from '../control/server.js';
import type { ControlDispatcher, DomainStore, ReplyHandle } from '../seams.js';
import {
    findPaneAnywhere,
    groupByID,
    groupIDForWorkspace,
    workspaceByID,
    workspaceContainingVisiblePane
} from '../store/derived.js';
import type { DaemonState, DomainAction, DomainEvent, LabelColor, WorkspaceColor } from '../store/types.js';
import {
    isDesktopCommand,
    type DesktopChannel,
    type DesktopCommand
} from './desktop.js';
import {
    isPaneLifecycleCommand,
    type PaneLifecycleChannel,
    type PaneLifecycleCommand
} from './panes.js';
import { handleRepoCommand, isRepoCommand, type RepoChannel, type RepoCommand } from './repos.js';
import {
    FAVOURITE_COMMANDS,
    WEB_BATCH_MESSAGE,
    WEB_FAVOURITES_MESSAGE,
    WEB_NAV_STATE_MESSAGE,
    WEB_VIEW_FOCUS_MESSAGE,
    favouritesCommand,
    webPaneGuiCommand
} from './web-ui.js';
import {
    handleGraftUiCommand,
    isGraftUiCommand,
    type GraftChannel,
    type GraftUiCommand
} from './graft.js';
import { isTerminalSearchCommand, type TerminalSearchChannel } from './search.js';
import { parseGeometryRect } from '../webpane/geometry.js';
import type { HostRegistration } from '../webpane/host.js';
import type { WebPaneService } from '../webpane/service.js';
import { serializeDomainEvents, serializeLabelPreset, serializeState } from './serialize.js';

export type KelpiDomainStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

/** WS close codes for the rejection reasons (4000-4999 is the app-defined range). */
export const WS_CLOSE_CODES = {
    protocolMismatch: 4001,
    unauthorized: 4003,
    serverError: 4500
} as const;

/**
 * How long a connection may sit open without completing a handshake before the daemon closes
 * it. The upgrade no longer authenticates (`ws/http.ts` `authorizeUpgrade`), so this bounds
 * what an anonymous socket can hold: a real client sends `hello` in the same tick it opens.
 */
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** The message a client sees when its hello carries no usable token. */
export const BAD_TOKEN_MESSAGE = "invalid or missing daemon token — open the client via 'kelpid url'";

export interface SyncTransport {
    sendJson(message: JsonObject): void;
    close(code?: number, reason?: string): void;
}

/** What a connection's PTY streams need from the sync channel (see `./streams.ts`). */
export interface SyncPaneBridge {
    attach(paneID: string, size?: { cols: number; rows: number } | undefined): void | Promise<void>;
    detach(paneID: string): void;
    resize(paneID: string, cols: number, rows: number): void;
    close(): void;
}

export interface SyncSession {
    readonly clientID: string;
    /** True once the handshake succeeded (snapshot sent, deltas flowing). */
    readonly ready: boolean;
    readonly client: WsClientInfo | null;
    /** This connection's active workspace (per-client, PLAN decision). */
    readonly activeWorkspaceID: string | null;
    readonly focusedPaneID: string | null;
    readonly visiblePaneIDs: ReadonlySet<string>;
    readonly documentVisible: boolean;
    /** One text frame from the client. */
    handleMessage(raw: string): void;
    /** Peer went away (or we are shutting down): release everything this connection held. */
    close(): void;
}

export interface SyncHubOptions {
    readonly store: KelpiDomainStore;
    /** Where client `command` messages go — the same dispatcher the control socket uses. */
    readonly dispatcher: ControlDispatcher;
    readonly daemon: { readonly version: string; readonly build: string; readonly pid?: number | undefined };
    /**
     * §SET-021: control-listener state for `welcome.transport`. A getter, not a value, because
     * `restart-control-server` can re-bind while clients are attached and the next handshake has
     * to report what is true THEN. Absent = nothing to say (a handler-level test).
     */
    readonly transport?: (() => WsTransportStatus) | undefined;
    /** Defaults to the protocol's compiled-in version. */
    readonly protocolVersion?: number | undefined;
    /** M5 content panes; absent = the `content-*` verbs answer "not available". */
    readonly content?: ContentChannel | undefined;
    /**
     * M6 web panes. This is where the Electron shell claims the host role and where its RPC
     * replies + console/page events arrive, so it MUST be the same service instance the
     * `web-*` command handlers got. Absent = no connection can become a host.
     */
    readonly webPanes?: WebPaneChannel | undefined;
    /** The pane header's restart button; absent = `restart-pane-agent` says "not available". */
    readonly agents?: AgentChannel | undefined;
    /**
     * M9 workspace inspector: the repo registry + association verbs (`ws/repos.ts`). Absent =
     * they answer "repo commands are not available", which is what a daemon booted without a
     * git service should say rather than pretending an association was written.
     */
    readonly repos?: RepoChannel | undefined;
    /**
     * The inspector's graft verbs (`ws/graft.ts`): the per-association toggle, the typed
     * `alreadyActive` rejection the swap prompt reads, and orphan recover/dismiss. Absent =
     * they answer "graft is not available", which is honest for a daemon composed without the
     * graft engine.
     */
    readonly graftUi?: GraftChannel | undefined;
    /**
     * Terminal scrollback search (`ws/search.ts`) — the daemon side of ⌘F over a shell pane.
     * Absent = `terminal-search` answers "terminal search is not available".
     */
    readonly search?: TerminalSearchChannel | undefined;
    /**
     * Reopen-closed-pane, create-scratchpad and reveal-path (`ws/panes.ts`). Absent = those
     * three verbs answer "not available", which is what a daemon composed without a pane
     * handler context should say rather than silently dropping the gesture.
     */
    readonly panes?: PaneLifecycleChannel | undefined;
    /**
     * The desktop gestures (`ws/desktop.ts`): the ⌘O picker relay, ⌘-click path opening, the
     * external `$EDITOR` host and `restart-control-server`. Absent = those verbs answer
     * "not available".
     */
    readonly desktop?: DesktopChannel | undefined;
    /**
     * M8 settings sync. Supplies the `welcome.settings` payload and backs the three
     * `settings-*` mutation verbs; absent = `welcome` carries no settings and the verbs answer
     * "not available" (which is what a daemon booted without a settings service should say
     * rather than silently pretending the write happened).
     */
    readonly settings?: SettingsChannel | undefined;
    /**
     * The token check. The upgrade no longer refuses a bad token (it cannot say why to a
     * browser), so for an anonymous connection this IS the gate. Absent = accept whatever
     * upgraded (a tokenless / `allowAnonymous` daemon).
     */
    readonly validateToken?: ((token: string) => boolean) | undefined;
    /** Handshake deadline; defaults to `DEFAULT_HELLO_TIMEOUT_MS`. `0` disables it. */
    readonly helloTimeoutMs?: number | undefined;
    readonly now?: (() => number) | undefined;
    readonly newClientID?: (() => string) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface SyncPresence {
    readonly clients: number;
    /** Clients whose document is visible — the port's "app is active" (agent-lifecycle §7). */
    readonly visibleClients: number;
    readonly anyVisible: boolean;
}

export interface SessionOptions {
    /**
     * True when the HTTP upgrade already presented a valid token (`?token=` or a bearer
     * header). Such a connection may omit the token from its `hello` — which is what the
     * Electron shell's status and web-host sockets would do if they ever stopped sending one.
     * Default false: the hello must authenticate itself.
     */
    readonly authenticated?: boolean | undefined;
}

export interface SyncHub {
    createSession(
        transport: SyncTransport,
        panes?: SyncPaneBridge | undefined,
        options?: SessionOptions | undefined
    ): SyncSession;
    /** The `HandlerContext.broadcast` seam: fan a daemon event out to attached clients. */
    broadcast(event: Record<string, unknown>): void;
    readonly sessions: readonly SyncSession[];
    /** Deltas emitted so far; the anchor a snapshot is taken at. */
    readonly seq: number;
    presence(): SyncPresence;
    /** True when some visible client shows that pane as its focused pane (§7 suppression). */
    isPaneAttended(workspaceID: string, paneID: string): boolean;
    close(): void;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseClientInfo(value: unknown): WsClientInfo {
    const fallback: WsClientInfo = { kind: 'browser' };
    if (!isRecord(value)) return fallback;
    const kind = value['kind'];
    const known = WS_CLIENT_KINDS.includes(kind as WsClientKind) ? (kind as WsClientKind) : 'browser';
    const name = text(value['name']);
    const version = text(value['version']);
    const rawCapabilities = value['capabilities'];
    const capabilities = Array.isArray(rawCapabilities)
        ? rawCapabilities.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
    const windowID = text(value['windowID']);
    return {
        kind: known,
        ...(name !== undefined ? { name } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
        ...(windowID !== undefined ? { windowID } : {})
    };
}

// ── WS-only commands (WP3.6) ────────────────────────────────────────────────────────

/**
 * Store mutations the GUI needs that the **control protocol has no verb for** — the CLI never
 * grew one because they are direct-manipulation gestures (a zoom button, a disclosure triangle,
 * an inline rename field).
 *
 * They are deliberately NOT added to `@kelpi/protocol`'s `WIRE_COMMANDS`: a new CLI verb is a
 * compatibility surface we would owe the Swift CLI forever, and `kelpi` has no way to send these.
 * So they are handled here, *before* `decodeWireObject` (which would reject an unknown command),
 * and each one simply dispatches the store action that already exists. Field names follow the
 * wire's snake_case convention so a client speaks one dialect for both kinds of command.
 *
 *   toggle-zoom          `pane_id`                       → focus-pane (if needed) + toggle-zoom
 *   set-split-ratio      `workspace_id`, `split_path`, `ratio` → update-split-ratio
 *   set-group-collapsed  `group_id`, `collapsed`         → set-group-collapsed
 *   rename-workspace     `workspace_id`, `name`          → rename-workspace
 *   set-workspace-icon   `workspace_id`, `icon`          → set-workspace-icon
 *   set-group-icon       `group_id`, `icon`              → set-group-icon
 *   set-group-color      `group_id`, `color?`            → set-group-color
 *   move-workspaces      `workspace_ids`, `group_id?`, `index?` → move-workspaces-to-group
 *   clear-pane-status    `pane_id`                       → pane-agent-event(clearPaneStatus)
 *   set-pane-status      `pane_id`, `status`             → pane-agent-event(setPaneStatus)
 *   add-label-preset     `name`, `color?`, `text_color?` → add-label-preset (+ text colour)
 *   update-label-preset  `id`, `name?`, `color`, `text_color?` → update-label-preset (+ text colour)
 *   remove-label-preset  `id`                            → remove-label-preset
 *   move-label-preset    `id`, `index`                   → move-label-preset
 *
 * The three label-preset verbs are Settings ▸ Labels (app-state-core.md §6.4). The CLI's
 * `workspace label` back-fill already dispatches `addLabelPreset` daemon-side, but nothing
 * could RECOLOR or delete a preset over the wire — that is a Settings-window gesture, so it
 * lands here rather than in `WIRE_COMMANDS`. `color` is the serialized `LabelColor` string the
 * DB stores: a `WorkspaceColor` raw value (`"blue"`) or a `#rrggbb` hex (§6.2's one-string
 * encoding), absent = gray. Every rule the reducer enforces (empty/duplicate name is a silent
 * no-op, a rename into another preset's name is refused, deleting never touches a workspace's
 * `labels`) is left where it is; this is pure routing.
 *
 * `icon` is the flat prefix string the DB stores (`"emoji:🔥"` / `"system:star"`), decoded by
 * `@kelpi/core/codec`'s `parseIconString`; `null` (or anything unparseable) clears the icon back
 * to the letter avatar. An SF Symbol name is therefore an OPAQUE token end to end — a legacy DB
 * value the client cannot draw still round-trips through a client that never touches it. An
 * `emoji:` payload is the one thing NOT taken on trust: it is re-validated against §WS-073's
 * heuristic here (§WS-074), so no frame can store a letter as an icon.
 */
export const WS_ONLY_COMMANDS = [
    'toggle-zoom',
    // §LAY-061: the GUI divider drag, addressed the way the LAYOUT MODEL addresses a resize —
    // by split path. `pane-resize` can only name a pane, and `enclosingSplitPath` only ever
    // resolves the split whose direct child is that pane's leaf, so a divider whose BOTH
    // children are splits (the root divider of a 2×2 `tiled` layout) had no spelling on the
    // wire at all: the grid previewed the drag and the daemon never heard about it. Swift's
    // GUI dispatches `updateSplitRatio(splitPath:ratio:)` directly, which is what this is.
    'set-split-ratio',
    'set-group-collapsed',
    'rename-workspace',
    'set-workspace-icon',
    'set-group-icon',
    // §WS-065: a group's colour is optional and only `group create --color` could ever set it,
    // so a group created any other way was stuck grey for life. The reducer action has always
    // existed; this is the verb the sidebar's "Color ▸" submenu needed.
    'set-group-color',
    'move-workspaces',
    'create-group-for-workspaces',
    'set-bulk-color',
    'set-bulk-label',
    'clear-pane-status',
    'set-pane-status',
    'add-label-preset',
    'update-label-preset',
    'remove-label-preset',
    'move-label-preset'
] as const;
export type WsOnlyCommand = (typeof WS_ONLY_COMMANDS)[number];

/**
 * §WS-156 / §APP-067 — the GUI's workspace delete, which may reach ZERO workspaces.
 *
 * WS-only like the list above, but it is not IN the list: `handleWsOnlyCommand` answers from the
 * store alone, and a delete has to tear down PTYs and persist. It is routed straight into the
 * app dispatcher instead (`guiDeleteWorkspace`), which is why it carries its own constant.
 */
export const GUI_DELETE_WORKSPACE_COMMAND = 'delete-workspace';

export function isWsOnlyCommand(command: string): command is WsOnlyCommand {
    return (WS_ONLY_COMMANDS as readonly string[]).includes(command);
}

function failure(error: string): JsonObject {
    return { ok: false, error };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * §6.2's one-string `LabelColor` encoding: a `WorkspaceColor` raw value (`"blue"`) or a
 * `#rrggbb` hex. Absent / unrecognized → gray, which is exactly what the CLI back-fill and a
 * malformed custom hex already render as (§6.2: "never crashes").
 */
export function decodeLabelColorToken(raw: unknown): LabelColor {
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        const named = parseWorkspaceColor(trimmed);
        if (named !== undefined) return { kind: 'named', color: named };
        if (HEX_COLOR.test(trimmed)) return { kind: 'custom', hex: trimmed.toLowerCase() };
    }
    return { kind: 'named', color: 'gray' };
}

/**
 * §6.2's `textColor` slot (SET-062): the same one-string encoding as `color`, plus two meanings
 * `color` does not have.
 *
 *   absent (`undefined`)  → leave the stored text colour alone
 *   `null` / `"auto"`     → AUTO: black or white by the background's luminance
 *   a colour token        → an explicit override
 *
 * Returned as a discriminated result rather than `LabelColor | null` because "leave it alone"
 * and "set it to auto" are different instructions and both have to survive the trip.
 */
export function decodeLabelTextColorToken(
    raw: unknown
): { readonly present: false } | { readonly present: true; readonly value: LabelColor | null } {
    if (raw === undefined) return { present: false };
    if (raw === null) return { present: true, value: null };
    if (typeof raw === 'string') {
        const trimmed = raw.trim().toLowerCase();
        if (trimmed === '' || trimmed === 'auto') return { present: true, value: null };
        const named = parseWorkspaceColor(raw.trim());
        if (named !== undefined) return { present: true, value: { kind: 'named', color: named } };
        if (HEX_COLOR.test(raw.trim())) {
            return { present: true, value: { kind: 'custom', hex: raw.trim().toLowerCase() } };
        }
    }
    // Anything else is not a colour Kelpi can store; treat it as "auto" rather than refusing the
    // whole command, which is what `decodeLabelColorToken` does for the background.
    return { present: true, value: null };
}

/** The reply shape all three preset verbs share: the post-mutation list, wire-serialized. */
function presetsReply(store: KelpiDomainStore, extra: JsonObject): JsonObject {
    return {
        ok: true,
        ...extra,
        label_presets: store.getState().labelPresets.map(serializeLabelPreset)
    };
}

/**
 * Executes one WS-only command against the store and returns the reply object. Pure routing +
 * dispatch: every mutation is an existing `DomainAction`, so the delta stream, persistence and
 * the CLI's view of the world all stay identical to a GUI-driven change.
 */
export interface WsOnlyCommandOptions {
    /** Epoch-ms clock for the actions that stamp one (`clear-pane-status`). */
    readonly now?: (() => number) | undefined;
    /** Id source for the verbs that mint one (`create-group-for-workspaces`); tests inject. */
    readonly uuid?: (() => string) | undefined;
}

export function handleWsOnlyCommand(
    store: KelpiDomainStore,
    command: WsOnlyCommand,
    payload: Record<string, unknown>,
    options: WsOnlyCommandOptions = {}
): JsonObject {
    const state = store.getState();

    if (command === 'set-workspace-icon' || command === 'set-group-icon') {
        const workspaceScoped = command === 'set-workspace-icon';
        const id = text(payload[workspaceScoped ? 'workspace_id' : 'group_id']);
        if (id === undefined) {
            return failure(`${command} requires ${workspaceScoped ? 'workspace_id' : 'group_id'}`);
        }
        const exists = workspaceScoped ? workspaceByID(state, id) !== null : groupByID(state, id) !== null;
        if (!exists) return failure(`no ${workspaceScoped ? 'workspace' : 'group'} matches '${id}'`);
        // Anything that is not a well-formed icon string clears the icon; that is the
        // "Reset to Letter" menu item and the only way back to the avatar.
        const raw = payload['icon'];
        const icon = typeof raw === 'string' ? parseIconString(raw) : null;
        // §WS-074: an `emoji:` payload is RE-VALIDATED here against the same heuristic the
        // sheet uses (§WS-073). The client already refuses a letter, but a hand-written frame
        // would otherwise store `emoji:a` and every client would render a letter that cannot
        // be told from the avatar it replaced. A refusal leaves the icon untouched, which is
        // the reducer's "clears the prompt without changing the icon".
        if (icon !== null && icon.kind === 'emoji' && normalizeIconEmoji(icon.grapheme) !== icon.grapheme) {
            return failure(`'${icon.grapheme}' is not a usable icon: give one emoji or symbol`);
        }
        store.dispatch(
            workspaceScoped
                ? { type: 'set-workspace-icon', id, icon }
                : { type: 'set-group-icon', id, icon }
        );
        return {
            ok: true,
            ...(workspaceScoped ? { workspace_id: id } : { group_id: id }),
            icon: icon === null ? null : formatIconString(icon)
        };
    }

    if (command === 'set-group-color') {
        // §WS-065. Unlike a workspace, a group's colour is OPTIONAL: the submenu leads with
        // "None", so a missing/`null`/empty `color` clears it back to the theme's divider
        // tint rather than being an error. An unrecognised name IS an error — silently
        // clearing on a typo would look like the menu had picked "None".
        const id = text(payload['group_id']);
        if (id === undefined) return failure('set-group-color requires group_id');
        if (groupByID(state, id) === null) return failure(`no group matches '${id}'`);
        const raw = payload['color'];
        let color: WorkspaceColor | null = null;
        if (typeof raw === 'string' && raw.trim() !== '') {
            const parsed = parseWorkspaceColor(raw.trim());
            if (parsed === undefined) return failure(`'${raw}' is not a known color`);
            color = parsed;
        }
        store.dispatch({ type: 'set-group-color', id, color });
        return { ok: true, group_id: id, color };
    }

    if (command === 'add-label-preset') {
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        if (name === '') return failure('add-label-preset requires name');
        // §6.4: a duplicate is a SILENT no-op in the reducer (that is what makes the CLI
        // back-fill safe), so the caller is told plainly rather than being left to diff lists.
        if (state.labelPresets.some((preset) => preset.name === name)) {
            return failure(`label preset '${name}' already exists`);
        }
        store.dispatch({ type: 'add-label-preset', name, color: decodeLabelColorToken(payload['color']) });
        // SET-059: the chosen text colour is applied only when the add ACTUALLY created a
        // preset — the duplicate case returned above, so reaching here means it did. The
        // reducer normalizes the name (trim + clamp), so the id to address is the normalized
        // one, which is the name the new preset now carries.
        const textColor = decodeLabelTextColorToken(payload['text_color']);
        if (textColor.present) {
            const created = store.getState().labelPresets.at(-1);
            if (created !== undefined) {
                store.dispatch({
                    type: 'set-label-preset-text-color',
                    id: created.name,
                    textColor: textColor.value
                });
            }
        }
        return presetsReply(store, { name });
    }

    if (command === 'update-label-preset') {
        const id = text(payload['id']);
        if (id === undefined) return failure('update-label-preset requires id');
        const preset = state.labelPresets.find((candidate) => candidate.name === id);
        if (preset === undefined) return failure(`no label preset matches '${id}'`);
        // Recolor-only is the common call: `name` absent keeps the current one.
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : preset.name;
        if (name === '') return failure('update-label-preset requires a non-empty name');
        if (name !== id && state.labelPresets.some((candidate) => candidate.name === name)) {
            return failure(`label preset '${name}' already exists`);
        }
        const color =
            payload['color'] === undefined ? preset.color : decodeLabelColorToken(payload['color']);
        store.dispatch({ type: 'update-label-preset', id, name, color });
        // AFTER the rename: a preset's identity is its name, so the text colour has to be
        // addressed by the name the preset now has, not the one it arrived with.
        const textColor = decodeLabelTextColorToken(payload['text_color']);
        if (textColor.present) {
            store.dispatch({ type: 'set-label-preset-text-color', id: name, textColor: textColor.value });
        }
        return presetsReply(store, { id, name });
    }

    if (command === 'remove-label-preset') {
        const id = text(payload['id']);
        if (id === undefined) return failure('remove-label-preset requires id');
        if (!state.labelPresets.some((preset) => preset.name === id)) {
            return failure(`no label preset matches '${id}'`);
        }
        // §6.4: removal never touches a workspace's `labels` — the string keeps existing and
        // its chip simply renders neutral. That is why no workspace is inspected here.
        store.dispatch({ type: 'remove-label-preset', id });
        return presetsReply(store, { id });
    }

    if (command === 'move-label-preset') {
        // SET-065's reorder. The wire carries the preset's NAME and a target index rather than
        // a from/to pair: the client's index can be one delta stale, the name cannot, so the
        // source position is computed here from the authoritative list.
        const id = text(payload['id']);
        if (id === undefined) return failure('move-label-preset requires id');
        const from = state.labelPresets.findIndex((preset) => preset.name === id);
        if (from < 0) return failure(`no label preset matches '${id}'`);
        const raw = payload['index'];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            return failure('move-label-preset requires a numeric index');
        }
        // Clamped rather than refused: "move the last one down" is a no-op, not an error, and
        // that is what an ↑/↓ button at the end of the list sends.
        const to = Math.min(state.labelPresets.length - 1, Math.max(0, Math.round(raw)));
        store.dispatch({ type: 'move-label-preset', from, to });
        return presetsReply(store, { id, index: to });
    }

    if (command === 'move-workspaces') {
        const raw = payload['workspace_ids'];
        const ids = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
        if (ids.length === 0) return failure('move-workspaces requires workspace_ids');
        const unknown = ids.find((id) => workspaceByID(state, id) === null);
        if (unknown !== undefined) return failure(`no workspace matches '${unknown}'`);
        const groupID = text(payload['group_id']) ?? null;
        if (groupID !== null && groupByID(state, groupID) === null) {
            return failure(`no group matches '${groupID}'`);
        }
        const index = count(payload['index']);
        // ONE dispatch for the whole selection: a multi-row sidebar drag must land as a single
        // atomic move, not N moves each of which the next one re-indexes (shell-ui.md §5.5).
        store.dispatch({
            type: 'move-workspaces-to-group',
            ids,
            groupID,
            ...(index === undefined ? {} : { index })
        });
        return { ok: true, workspace_ids: ids, group_id: groupID, index: index ?? null };
    }

    if (command === 'create-group-for-workspaces') {
        // §5.6 bulk "Group N Workspaces…" (WS-058). The wire's `group-create` cannot carry
        // members — it is fire-and-forget and adding a field to it would be a CLI compatibility
        // surface forever — so the GUI path is this verb, which dispatches the SAME
        // `create-group` action with its `initialWorkspaceIDs` so the group and its membership
        // land in one atomic change (never create-then-move, which the sidebar would render
        // as two jumps).
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        if (name === '') return failure('create-group-for-workspaces requires a non-empty name');
        const raw = payload['workspace_ids'];
        const requested = Array.isArray(raw)
            ? raw.filter((entry): entry is string => typeof entry === 'string')
            : [];
        /*
         * §WS-123 — an EMPTY member list is legal, and it is the ⌘⇧G path.
         *
         * The chord mints a placeholder name and drops into inline rename on the new header,
         * which needs the id back; `group-create` is fire-and-forget and its ack carries
         * nothing, so ⌘⇧G created a group and then silently did neither the rename nor the
         * reveal (caught live by the `workspace-edges` audit flow, which timed out waiting for
         * a rename field that never opened). This verb already answers with `group_id`, and a
         * group created around no workspaces is the same `create-group` action with an empty
         * `initialWorkspaceIDs` — so the guard that used to reject it is gone and unknown ids
         * are still refused below.
         */
        const unknown = requested.find((id) => workspaceByID(state, id) === null);
        if (unknown !== undefined) return failure(`no workspace matches '${unknown}'`);
        const color =
            typeof payload['color'] === 'string' ? parseWorkspaceColor(payload['color'].trim()) : undefined;
        const id = (options.uuid ?? newUUID)();
        store.dispatch({
            type: 'create-group',
            id,
            name,
            now: (options.now ?? Date.now)(),
            initialWorkspaceIDs: requested,
            ...(color === undefined ? {} : { color })
        });
        const created = groupByID(store.getState(), id);
        return {
            ok: true,
            group_id: id,
            name,
            workspace_ids: created?.childOrder ?? requested
        };
    }

    if (command === 'set-bulk-color' || command === 'set-bulk-label') {
        // The multi-select context menu (§5.6 bulk variant, WS-056/WS-057). ONE dispatch for
        // the whole selection so N rows recolour/relabel in a single delta, exactly as the
        // Swift `setBulkColor` / `setBulkLabel` reducers do.
        const raw = payload['workspace_ids'];
        const ids = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
        if (ids.length === 0) return failure(`${command} requires workspace_ids`);
        const unknown = ids.find((id) => workspaceByID(state, id) === null);
        if (unknown !== undefined) return failure(`no workspace matches '${unknown}'`);
        if (command === 'set-bulk-color') {
            const color = parseWorkspaceColor(typeof payload['color'] === 'string' ? payload['color'].trim() : '');
            if (color === undefined) return failure('set-bulk-color requires a known color');
            store.dispatch({ type: 'set-bulk-color', ids, color });
            return { ok: true, workspace_ids: ids, color };
        }
        const label = typeof payload['label'] === 'string' ? payload['label'].trim() : '';
        if (label === '') return failure('set-bulk-label requires label');
        // Tri-state menus send the state they want, never a per-row toggle: `apply` is what
        // every selected workspace ends up at.
        const apply = payload['apply'] === true;
        store.dispatch({ type: 'set-bulk-label', ids, label, apply });
        return { ok: true, workspace_ids: ids, label, apply };
    }

    if (command === 'clear-pane-status') {
        const paneID = text(payload['pane_id']);
        if (paneID === undefined) return failure('clear-pane-status requires pane_id');
        const found = findPaneAnywhere(state, paneID);
        if (found === null) return failure(`no pane matches '${paneID}'`);
        // The 600 ms focus-dwell acknowledgment (agent-lifecycle.md §5.8): the timer is a
        // client concern, the mutation is not, so the client reports and the daemon decides.
        store.dispatch({
            type: 'pane-agent-event',
            paneID,
            event: { type: 'clearPaneStatus' },
            now: (options.now ?? Date.now)(),
            workspaceID: found.workspaceID
        });
        const after = findPaneAnywhere(store.getState(), paneID);
        return {
            ok: true,
            pane_id: paneID,
            workspace_id: found.workspaceID,
            status: after?.pane.status ?? 'idle'
        };
    }

    if (command === 'set-pane-status') {
        const paneID = text(payload['pane_id']);
        if (paneID === undefined) return failure('set-pane-status requires pane_id');
        const status = text(payload['status']);
        if (status !== 'idle' && status !== 'running' && status !== 'waitingForInput') {
            return failure("set-pane-status requires status 'idle', 'running' or 'waitingForInput'");
        }
        const found = findPaneAnywhere(state, paneID);
        if (found === null) return failure(`no pane matches '${paneID}'`);
        // The pane header's Status submenu (agent-lifecycle.md §5.10 / TERM-107). The whole
        // rule — shell-only, the elapsed clock arms only on a FRESH transition into running,
        // and the background count is zeroed so no stale "N running" lingers — lives in
        // `core/src/agent/machine.ts`; this is pure routing, and a non-shell pane is a complete
        // no-op there rather than an error here.
        store.dispatch({
            type: 'pane-agent-event',
            paneID,
            event: { type: 'setPaneStatus', status },
            now: (options.now ?? Date.now)(),
            workspaceID: found.workspaceID
        });
        const after = findPaneAnywhere(store.getState(), paneID);
        return {
            ok: true,
            pane_id: paneID,
            workspace_id: found.workspaceID,
            status: after?.pane.status ?? 'idle'
        };
    }

    if (command === 'toggle-zoom') {
        const paneID = text(payload['pane_id']);
        if (paneID === undefined) return failure('toggle-zoom requires pane_id');
        const workspace = workspaceContainingVisiblePane(state, paneID);
        if (workspace === null) return failure(`no pane matches '${paneID}'`);
        // The reducer zooms the workspace's FOCUSED pane, so a zoom raised on another pane has
        // to move focus first — which is what clicking that pane's zoom button does anyway.
        if (workspace.zoomedPaneID === null && workspace.focusedPaneID !== paneID) {
            store.dispatch({ type: 'focus-pane', workspaceID: workspace.id, paneID });
        }
        store.dispatch({ type: 'toggle-zoom', workspaceID: workspace.id });
        const after = workspaceByID(store.getState(), workspace.id);
        return {
            ok: true,
            pane_id: paneID,
            workspace_id: workspace.id,
            zoomed_pane_id: after?.zoomedPaneID ?? null
        };
    }

    if (command === 'set-split-ratio') {
        const workspaceID = text(payload['workspace_id']);
        if (workspaceID === undefined) return failure('set-split-ratio requires workspace_id');
        const workspace = workspaceByID(state, workspaceID);
        if (workspace === null) return failure(`no workspace matches '${workspaceID}'`);
        const splitPath = text(payload['split_path']);
        if (splitPath === undefined) return failure('set-split-ratio requires split_path');
        const ratio = payload['ratio'];
        if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
            return failure('set-split-ratio requires a numeric ratio');
        }
        // A stale path is a no-op in the model (§9.1: "never an error"), which over a wire
        // would look like a silent success. Refuse it here instead: the client has just
        // previewed a drag against a tree it can now be told it no longer shares.
        if (ratioAtPath(workspace.layout, splitPath) === null) {
            return failure(`no split at path '${splitPath}'`);
        }
        store.dispatch({ type: 'update-split-ratio', workspaceID, splitPath, ratio });
        const after = workspaceByID(store.getState(), workspaceID);
        return {
            ok: true,
            workspace_id: workspaceID,
            split_path: splitPath,
            // The STORED ratio, post-clamp — the drag can ask for 0.02 and get 0.1 back.
            ratio: after === null ? ratio : (ratioAtPath(after.layout, splitPath) ?? ratio)
        };
    }

    if (command === 'set-group-collapsed') {
        const groupID = text(payload['group_id']);
        if (groupID === undefined) return failure('set-group-collapsed requires group_id');
        if (groupByID(state, groupID) === null) return failure(`no group matches '${groupID}'`);
        const collapsed = payload['collapsed'] === true;
        store.dispatch({ type: 'set-group-collapsed', id: groupID, collapsed });
        return { ok: true, group_id: groupID, collapsed };
    }

    const workspaceID = text(payload['workspace_id']);
    if (workspaceID === undefined) return failure('rename-workspace requires workspace_id');
    const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
    if (name.length === 0) return failure('rename-workspace requires a non-empty name');
    if (workspaceByID(state, workspaceID) === null) return failure(`no workspace matches '${workspaceID}'`);
    store.dispatch({ type: 'rename-workspace', id: workspaceID, name });
    return { ok: true, workspace_id: workspaceID, name };
}

// ── content-pane commands (M5) ──────────────────────────────────────────────────────

/**
 * The content-pane verbs. Same reasoning as `WS_ONLY_COMMANDS` (no CLI equivalent, so they are
 * matched before `decodeWireObject`), with one difference: they are **asynchronous** — reading a
 * file or running `git diff` cannot answer inside the message handler — so they answer through
 * `command-reply` when the promise settles rather than returning a reply object.
 *
 *   content-subscribe    `pane_id`          → `{ok, pane_id, state}` + `content-updated` events
 *   content-unsubscribe  `pane_id`          → `{ok, pane_id}` (stops this client's events)
 *   markdown-set-mode    `pane_id`, `mode`  → `{ok, pane_id, state}` ("view" | "edit")
 *   content-set-text     `pane_id`, `text`  → `{ok, pane_id, state}` (the edit buffer)
 *   diff-refresh         `pane_id`          → `{ok, pane_id, state}` (re-runs git)
 *   markdown-save        `pane_id`          → `{ok, pane_id, state}` (flush the debounce)
 *   content-set-font-size `pane_id`, `size` → `{ok, pane_id, state}` (§3.16, re-render only)
 *
 * `content-updated` (`{type, paneID, state}`) goes ONLY to sessions subscribed to that pane.
 */
export const CONTENT_COMMANDS = [
    'content-subscribe',
    'content-unsubscribe',
    'markdown-set-mode',
    'content-set-text',
    'diff-refresh',
    'markdown-save',
    'content-set-font-size'
] as const;
export type ContentCommand = (typeof CONTENT_COMMANDS)[number];

export function isContentCommand(command: string): command is ContentCommand {
    return (CONTENT_COMMANDS as readonly string[]).includes(command);
}

/** The message type carrying a content change to a subscribed client. */
export const CONTENT_UPDATED_MESSAGE = 'content-updated';

/** The slice of `ContentService` the sync hub uses (so tests can stub it). */
export interface ContentChannel {
    subscribe(
        paneID: string,
        listener: (state: ContentPaneState) => void
    ): Promise<ContentSubscription>;
    setMode(paneID: string, mode: ContentMode): Promise<ContentPaneState>;
    setText(paneID: string, text: string): Promise<ContentPaneState>;
    save(paneID: string): Promise<ContentPaneState>;
    refresh(paneID: string): Promise<ContentPaneState>;
    setFontSize(paneID: string, size: number): Promise<ContentPaneState>;
    /**
     * §AGNT-114's step 1, moved to the side that owns the buffers.
     *
     * The Swift `applicationShouldTerminate` flushed pending markdown autosaves before showing
     * the quit dialog, because quitting killed the app that held them. Here the daemon holds
     * them and outlives the shell — but the shell can still ASK, and it does, so a ⌘Q taken
     * mid-keystroke has the file on disk *before* the dialog appears rather than 500 ms later.
     * Synchronous, idempotent, and a no-op with nothing dirty. Structurally the same
     * `flushSync` the daemon's own SIGTERM path calls, so boot passes the service unchanged.
     */
    flushSync?(): void;
}

/**
 * `flush-saves-request` → `flush-saves-result`: the quit gate's pre-flight (§AGNT-114).
 *
 * Its own message pair rather than a `command` verb for the same reason `reveal-request` is: the
 * Electron main process's status socket is a near-read-only connection with no command/reply
 * plumbing, and adding some for one synchronous "write the dirty buffers" would be more
 * machinery than the thing it carries. `id` is echoed so the shell can await exactly its own
 * answer, and the shell never blocks on it for more than its own timeout — a quit that hangs on
 * a flush would be worse than a quit that loses the last 500 ms of typing.
 */
export const FLUSH_SAVES_REQUEST_MESSAGE = 'flush-saves-request';
export const FLUSH_SAVES_RESULT_MESSAGE = 'flush-saves-result';

// ── agent restart (WS-only) ─────────────────────────────────────────────────────────

/**
 * `restart-pane-agent` — the pane header's restart button.
 *
 * It is WS-only for the usual reason (a direct-manipulation gesture the CLI never grew a verb
 * for) and lives on its own channel rather than in `handleWsOnlyCommand` because, unlike every
 * other WS-only verb, it is not a store mutation: it types `claude --resume <id>` /
 * `codex resume <id>` into the pane's PTY through `TerminalInput`, with the session id passed
 * through `isSafeSessionID` first — the same allowlist the boot-time resume applies, for the
 * same reason (the id came off a local socket and is about to reach a shell).
 */
export const AGENT_COMMANDS = ['restart-pane-agent'] as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[number];

export function isAgentCommand(command: string): command is AgentCommand {
    return (AGENT_COMMANDS as readonly string[]).includes(command);
}

export interface AgentRestartResult {
    readonly ok: boolean;
    readonly error?: string | undefined;
    readonly paneID?: string | undefined;
    readonly workspaceID?: string | undefined;
    readonly agent?: string | undefined;
    readonly command?: string | undefined;
}

export interface AgentChannel {
    restart(paneID: string): AgentRestartResult;
}

// ── web panes (M6) ──────────────────────────────────────────────────────────────────

/**
 * The web-pane host channel and the client-side console subscription.
 *
 * Two different roles share this socket type:
 *   - a **host** (the Electron shell) sends `host-register`, then answers `host-rpc` with
 *     `host-rpc-reply` and pushes `host-event`s (console lines, URL/title changes, picked
 *     elements). Exactly one host is active; a second registration takes over and the previous
 *     host is told with `host-revoked`. Dropping the connection releases the slot.
 *   - any **client** (the web UI) can subscribe to a pane's console with
 *     `web-console-subscribe` and receive `web-console-line` messages — the WS twin of the
 *     control socket's `kelpi web console --follow`, reading the same daemon ring buffer.
 *
 * Contract for the host side: `daemon/src/webpane/HOST_PROTOCOL.md`.
 */
export type WebPaneChannel = Pick<
    WebPaneService,
    | 'registerHost'
    | 'settleHostReply'
    | 'handleHostEvent'
    | 'subscribeConsole'
    | 'console'
    | 'notifyGeometry'
    | 'call'
    // The GUI-only halves (§10 find, §4.2 zoom, §12 batch pickup, §14 favourites): no CLI verb
    // exists for any of them, so the client drives them straight over this channel.
    | 'runFind'
    | 'retargetFind'
    | 'find'
    | 'batch'
    | 'armBatch'
    | 'publishBatch'
    | 'focusBatchItem'
    | 'sendBatch'
    | 'cancelBatch'
    | 'favourites'
>;

/**
 * `web-devtools` joins the console pair for the same reason they are here: it is a GUI gesture
 * (the chrome's `</>` button, web-pane.md §16.5) with no CLI equivalent, so giving it a wire
 * verb would mean owing the Swift CLI a command it will never send. It forwards straight to the
 * host — the only process with a `webContents` to open dev tools on.
 */
export const WEB_COMMANDS = [
    'web-console-subscribe',
    'web-console-unsubscribe',
    'web-devtools',
    // §10 find-in-page and §4.2 page zoom. The host has always answered `find` and `zoom` as
    // RPCs; these are the verbs that finally reach them, and both are GUI-only in the Swift app
    // too (⌘F and the ⌘= / ⌘- / ⌘0 layer — there is no `kelpi web find`).
    'web-find',
    'web-zoom',
    // WEB-016's tab drag-reorder, WEB-032's stop glyph and WEB-043's focus handoff: three more
    // GUI gestures with no CLI verb (in the Swift app they were a SwiftUI drag, an NSButton
    // that called `stopLoading()`, and `makeFirstResponder`).
    'web-tab-reorder',
    'web-stop',
    'web-focus-view',
    // §12 batch "element pickup". All pane-scoped, all direct manipulation.
    'web-batch-state',
    'web-batch-toggle',
    'web-batch-cancel',
    'web-batch-send',
    'web-batch-remove',
    'web-batch-comment',
    'web-batch-focus',
    // §13.2's write half — the storage panel's add/edit form.
    'web-cookie-set',
    // §14 favourites. The only web verbs with NO pane: they are a global list, so they are
    // matched before the `pane_id` guard.
    'web-favourites-list',
    'web-favourite-toggle',
    'web-favourite-remove',
    'web-favourite-rename',
    'web-favourite-move'
] as const;
export type WebCommand = (typeof WEB_COMMANDS)[number];

export function isWebCommand(command: string): command is WebCommand {
    return (WEB_COMMANDS as readonly string[]).includes(command);
}

/**
 * The GUI-only web verbs' bodies live in `./web-ui.ts` — find, zoom, batch pickup, favourites
 * and the cookie write are a feature's vocabulary rather than the hub's, and keeping them out of
 * here is what stops this file growing a second time the size of the protocol it serves.
 */
export {
    FAVOURITE_COMMANDS,
    WEB_BATCH_MESSAGE,
    WEB_FAVOURITES_MESSAGE,
    WEB_NAV_STATE_MESSAGE,
    WEB_VIEW_FOCUS_MESSAGE,
    favouritesCommand,
    webPaneGuiCommand
};

/** The client → daemon report that carries an embedded web pane's page-area rect. */
export const WEB_GEOMETRY_REPORT_MESSAGE = 'web-geometry-report';

/** Client → daemon "take the user to this pane", and the daemon's fan-out of it. */
export const REVEAL_REQUEST_MESSAGE = 'reveal-request';
export const REVEAL_PANE_MESSAGE = 'reveal-pane';

/**
 * Shell → daemon → client: a native menu item whose behaviour the CLIENT owns (⌘O's picker
 * entry point, "Kelpi Help"). The mirror image of `reveal-request`, for the same reason — the
 * Electron shell has no preload, so the daemon is the only channel between the main process and
 * the page (`ws/desktop.ts` documents both directions).
 */
export const MENU_REQUEST_MESSAGE = 'menu-request';
export const MENU_COMMAND_MESSAGE = 'menu-command';

/** The message type carrying one streamed console line to a subscribed client. */
export const WEB_CONSOLE_LINE_MESSAGE = 'web-console-line';

/** Capability token a `hello` can carry to claim the host role without a second message. */
export const WEB_HOST_CAPABILITY = 'web-pane-host';

// ── settings (M8) ───────────────────────────────────────────────────────────────────

/**
 * The settings verbs. Same reasoning as `WS_ONLY_COMMANDS` (direct-manipulation gestures the
 * CLI has no vocabulary for, matched before `decodeWireObject`), with one rule of their own:
 * **they write through the config file**. Nothing is kept in memory here — the service applies
 * a `@kelpi/core/config` writer to the file's current contents, re-reads it, and the reply
 * carries the re-read snapshot. That is why a hand-edit and a UI edit cannot disagree.
 *
 *   set-keybinding       `action`, `trigger` (config string, or null to unbind the action)
 *   reset-keybindings    `action` (or null / absent for the whole map)
 *   set-general-setting  `key`, `value`
 *
 * Every reply is `{ok:true, settings}` so a client can apply the result without waiting for
 * the `settings-changed` broadcast that follows.
 */
export { WS_SETTINGS_COMMANDS, isWsSettingsCommand, type WsSettingsCommand };

/** The message type carrying a settings change to every attached client. */
export { WS_SETTINGS_CHANGED_MESSAGE, type WsSettingsSnapshot };

/** The slice of `SettingsService` the sync hub uses (so tests can stub it). */
export interface SettingsChannel {
    readonly snapshot: WsSettingsSnapshot;
    setKeybinding(action: string, trigger: string | null): WsSettingsSnapshot;
    resetKeybindings(action: string | null): WsSettingsSnapshot;
    setGeneralSetting(key: string, value: string): WsSettingsSnapshot;
    setProfiles(profiles: readonly WsProfile[]): WsSettingsSnapshot;
    /** The GHOSTTY file's writer (`WS_WRITABLE_GHOSTTY_KEYS`); `null` removes the key. */
    setGhosttySetting(key: string, value: string | null): WsSettingsSnapshot;
}

/**
 * `set-profiles`'s payload → the writer's input. Anything that is not a `{name, env}` object of
 * strings is REJECTED rather than coerced: the write replaces the file's whole profile section,
 * so a half-understood payload would silently delete a user's definitions.
 */
export function decodeProfilesPayload(raw: unknown): readonly WsProfile[] | null {
    if (!Array.isArray(raw)) return null;
    const profiles: WsProfile[] = [];
    for (const entry of raw) {
        if (!isRecord(entry)) return null;
        const name = entry['name'];
        if (typeof name !== 'string') return null;
        const rawEnv = entry['env'];
        const env: Record<string, string> = {};
        if (rawEnv !== undefined && rawEnv !== null) {
            if (!isRecord(rawEnv)) return null;
            for (const [key, value] of Object.entries(rawEnv)) {
                if (typeof value !== 'string') return null;
                env[key] = value;
            }
        }
        profiles.push({ name, env });
    }
    return profiles;
}

/**
 * Executes one settings verb and returns the reply object. Errors from the service (unknown
 * action, unparseable trigger, unwritable key, a failed write) become `{ok:false,error}` with
 * the service's own wording — these are user-fixable mistakes, not daemon faults.
 */
export function handleSettingsCommand(
    settings: SettingsChannel,
    command: WsSettingsCommand,
    payload: Record<string, unknown>
): JsonObject {
    const optionalText = (value: unknown): string | null =>
        typeof value === 'string' && value.length > 0 ? value : null;

    try {
        if (command === 'set-keybinding') {
            const action = text(payload['action']);
            if (action === undefined) return failure('set-keybinding requires action');
            const next = settings.setKeybinding(action, optionalText(payload['trigger']));
            return { ok: true, settings: next as unknown as JsonObject };
        }
        if (command === 'reset-keybindings') {
            const next = settings.resetKeybindings(optionalText(payload['action']));
            return { ok: true, settings: next as unknown as JsonObject };
        }
        if (command === 'set-profiles') {
            const profiles = decodeProfilesPayload(payload['profiles']);
            if (profiles === null) return failure('set-profiles requires profiles: [{name, env}]');
            return { ok: true, settings: settings.setProfiles(profiles) as unknown as JsonObject };
        }
        if (command === 'set-ghostty-setting') {
            const ghosttyKey = text(payload['key']);
            if (ghosttyKey === undefined) return failure('set-ghostty-setting requires key');
            // `null` is MEANINGFUL here (remove the key), so it is not folded into the
            // "requires value" guard the way it is for `set-general-setting`; only an absent
            // field or a non-scalar is an error.
            const rawValue = payload['value'];
            if (rawValue === undefined) return failure('set-ghostty-setting requires value');
            const ghosttyValue =
                rawValue === null
                    ? null
                    : typeof rawValue === 'string'
                      ? rawValue
                      : typeof rawValue === 'number' || typeof rawValue === 'boolean'
                        ? String(rawValue)
                        : undefined;
            if (ghosttyValue === undefined) return failure('set-ghostty-setting requires value');
            return {
                ok: true,
                settings: settings.setGhosttySetting(ghosttyKey, ghosttyValue) as unknown as JsonObject
            };
        }
        const key = text(payload['key']);
        if (key === undefined) return failure('set-general-setting requires key');
        const raw = payload['value'];
        const value =
            typeof raw === 'string'
                ? raw
                : typeof raw === 'number' || typeof raw === 'boolean'
                  ? String(raw)
                  : undefined;
        if (value === undefined) return failure('set-general-setting requires value');
        return { ok: true, settings: settings.setGeneralSetting(key, value) as unknown as JsonObject };
    } catch (error) {
        return failure(toError(error).message);
    }
}

/** A `ReplyHandle` whose lines ride the WS channel as `command-reply` messages. */
class WsReplyHandle implements ReplyHandle {
    private sends = 0;
    private dead = false;
    private callbacks: (() => void)[] = [];

    constructor(
        private readonly transport: SyncTransport,
        private readonly id: string,
        private readonly release: (handle: WsReplyHandle) => void
    ) {}

    send(payload: Record<string, unknown>): void {
        if (this.dead) return;
        this.sends += 1;
        this.transport.sendJson({
            type: 'command-reply',
            id: this.id,
            reply: payload as JsonObject
        });
    }

    close(): void {
        if (this.dead) return;
        // A handler that answers nothing would hang the client's RPC; the control socket can
        // afford silence (EOF ends the read) but a multiplexed socket cannot.
        if (this.sends === 0) this.send({ ...errorReply('daemon produced no reply') });
        this.finish();
    }

    get closed(): boolean {
        return this.dead;
    }

    onDisconnect(callback: () => void): void {
        if (this.dead) {
            callback();
            return;
        }
        this.callbacks.push(callback);
    }

    /** Peer vanished: fire the disconnect callbacks without writing anything. */
    peerGone(): void {
        this.finish();
    }

    private finish(): void {
        if (this.dead) return;
        this.dead = true;
        const pending = this.callbacks;
        this.callbacks = [];
        for (const callback of pending) callback();
        this.release(this);
    }
}

export function createSyncHub(options: SyncHubOptions): SyncHub {
    const { store, dispatcher } = options;
    const protocolVersion = options.protocolVersion ?? WS_PROTOCOL_VERSION;
    const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    const now = options.now ?? (() => Date.now());
    const newClientID = options.newClientID ?? (() => randomUUID());
    const sessions = new Set<SessionImpl>();
    let seq = 0;
    let closed = false;
    /**
     * §SET-200/§SET-201: the last `hotkey-status` the shell reported, replayed to every client
     * that attaches afterwards. Null until a shell has registered anything — a browser-only
     * daemon has no registrar, so there is nothing to say and Settings shows no warning.
     */
    let lastHotkeyStatus: JsonObject | null = null;

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    class SessionImpl implements SyncSession {
        readonly clientID = newClientID();
        ready = false;
        client: WsClientInfo | null = null;
        activeWorkspaceID: string | null = null;
        focusedPaneID: string | null = null;
        visiblePaneIDs: ReadonlySet<string> = new Set<string>();
        documentVisible = false;
        private disposed = false;
        private readonly handles = new Set<WsReplyHandle>();
        /** paneID → this connection's content subscription (events go nowhere else). */
        private readonly contentSubs = new Map<string, ContentSubscription>();
        /** Bumped on every subscribe/unsubscribe so an in-flight subscribe can be voided. */
        private readonly contentEpoch = new Map<string, number>();
        /** Set while THIS connection holds the web-pane host role (M6). */
        private hostRegistration: HostRegistration | null = null;
        /** paneID → unsubscribe for this connection's console streams. */
        private readonly consoleSubs = new Map<string, () => void>();
        /**
         * Web panes this connection has placed a view for (`web-geometry-report`). A client
         * that goes away without saying "hidden" would otherwise leave a browser view parked
         * over a window nobody is driving, so its panes are released on close.
         */
        private readonly geometryPanes = new Set<string>();
        /** The shell window this connection claims to be; needed to release on its behalf. */
        private geometryWindowID: string | null = null;
        /** Fires when the connection has held a socket open without ever saying hello. */
        private helloTimer: ReturnType<typeof setTimeout> | null = null;

        constructor(
            private readonly transport: SyncTransport,
            private readonly panes: SyncPaneBridge | undefined,
            /** The upgrade presented a valid token; see `SessionOptions`. */
            private readonly upgradeAuthenticated: boolean
        ) {
            if (helloTimeoutMs > 0) {
                this.helloTimer = setTimeout(() => {
                    this.helloTimer = null;
                    if (this.disposed || this.ready) return;
                    this.reject(
                        'server-error',
                        `no hello within ${String(helloTimeoutMs)}ms`,
                        'hello-timeout'
                    );
                }, helloTimeoutMs);
                // Never hold the daemon's event loop open for an idle stranger.
                this.helloTimer.unref?.();
            }
        }

        private clearHelloTimer(): void {
            if (this.helloTimer === null) return;
            clearTimeout(this.helloTimer);
            this.helloTimer = null;
        }

        handleMessage(raw: string): void {
            if (this.disposed) return;
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                report(new Error('client sent a non-JSON text frame'), 'ws-parse');
                return;
            }
            if (!isRecord(parsed)) return;
            const type = parsed['type'];
            if (typeof type !== 'string') return;

            if (!this.ready) {
                // Nothing is accepted before the handshake (protocol `ws/messages.ts`) — and
                // since the upgrade may have let an anonymous socket through, "nothing" is
                // now load-bearing rather than merely tidy. Binary frames are refused by the
                // same rule, gated where they arrive (`ws/server.ts`).
                if (type !== 'hello') {
                    this.reject('server-error', 'expected hello as the first message', 'expected-hello');
                    return;
                }
                this.hello(parsed);
                return;
            }

            switch (type) {
                case 'hello':
                    // A second hello is a confused client; ignore rather than resnapshot.
                    return;
                case 'attach-pane':
                    this.attachPane(parsed);
                    return;
                case 'detach-pane': {
                    const paneID = text(parsed['paneID']);
                    if (paneID !== undefined) this.panes?.detach(paneID);
                    return;
                }
                case 'resize-pane': {
                    const paneID = text(parsed['paneID']);
                    const cols = count(parsed['cols']);
                    const rows = count(parsed['rows']);
                    if (paneID === undefined || cols === undefined || rows === undefined) return;
                    this.panes?.resize(paneID, cols, rows);
                    return;
                }
                case 'focus-report':
                    this.focusReport(parsed);
                    return;
                case 'visibility-report':
                    this.visibilityReport(parsed);
                    return;
                case 'command':
                    this.command(parsed);
                    return;
                case WEB_GEOMETRY_REPORT_MESSAGE:
                    this.geometryReport(parsed);
                    return;
                case REVEAL_REQUEST_MESSAGE:
                    this.revealRequest(parsed);
                    return;
                case MENU_REQUEST_MESSAGE:
                    this.menuRequest(parsed);
                    return;
                case FLUSH_SAVES_REQUEST_MESSAGE:
                    this.flushSavesRequest(parsed);
                    return;
                case WS_HOTKEY_STATUS_MESSAGE:
                    hotkeyStatusReport(parsed);
                    return;
                case WS_SHELL_ACTIVATION_MESSAGE:
                    shellActivationReport(parsed);
                    return;
                case WS_WORKSPACE_SELECTION_MESSAGE:
                    workspaceSelectionReport(parsed);
                    return;
                case 'ping': {
                    const id = text(parsed['id']);
                    this.send({ type: 'pong', id: id ?? '' });
                    return;
                }
                case 'host-register':
                    this.registerHost(text(parsed['name']), text(parsed['windowID']));
                    return;
                case 'host-unregister':
                    this.releaseHost();
                    return;
                case 'host-rpc-reply': {
                    const id = text(parsed['id']);
                    const payload = parsed['reply'];
                    // Only the connection that currently holds the role may answer RPCs; a
                    // superseded host's late reply must not settle its successor's call.
                    if (id === undefined || !isRecord(payload) || this.hostRegistration === null) return;
                    options.webPanes?.settleHostReply(id, payload as JsonObject);
                    return;
                }
                case 'host-event': {
                    if (this.hostRegistration === null) return;
                    const event = text(parsed['event']);
                    const paneID = text(parsed['paneID']);
                    const payload = parsed['payload'];
                    if (event === undefined || paneID === undefined) return;
                    options.webPanes?.handleHostEvent({
                        event,
                        paneID,
                        ...(text(parsed['tabID']) !== undefined ? { tabID: text(parsed['tabID']) } : {}),
                        payload: isRecord(payload) ? payload : {}
                    });
                    return;
                }
                default:
                    // Forward compatibility: unknown message types are ignored, not fatal.
                    return;
            }
        }

        close(): void {
            if (this.disposed) return;
            this.disposed = true;
            this.ready = false;
            this.clearHelloTimer();
            for (const handle of [...this.handles]) handle.peerGone();
            this.handles.clear();
            // A dropped connection must not leave the daemon watching a file for nobody.
            for (const subscription of this.contentSubs.values()) {
                try {
                    subscription.unsubscribe();
                } catch (error) {
                    report(error, 'content-unsubscribe');
                }
            }
            this.contentSubs.clear();
            this.contentEpoch.clear();
            // A dropped host must free the slot (a later shell can then take over), a dropped
            // VIEWER must give back the browser views it had placed, and every console follower
            // must stop writing into a socket that is gone.
            this.releaseGeometry();
            this.releaseHost();
            for (const unsubscribe of this.consoleSubs.values()) {
                try {
                    unsubscribe();
                } catch (error) {
                    report(error, 'web-console-unsubscribe');
                }
            }
            this.consoleSubs.clear();
            this.panes?.close();
            sessions.delete(this);
        }

        // ── web-pane host (M6) ──────────────────────────────────────────────

        private registerHost(name: string | undefined, windowID?: string | undefined): void {
            const channel = options.webPanes;
            if (channel === undefined) return;
            // Re-registering on the same connection is idempotent from the caller's side: the
            // old registration is released first, so the registry never leaks a stale slot.
            this.releaseHost();
            try {
                this.hostRegistration = channel.registerHost(
                    {
                        sendJson: (message) => {
                            // The registry revokes by writing to the OUTGOING host's transport;
                            // seeing that frame is how this session learns it lost the role and
                            // must stop being trusted for replies and events.
                            if (message['type'] === 'host-revoked') this.hostRegistration = null;
                            this.send(message);
                        }
                    },
                    {
                        ...(name === undefined ? {} : { name }),
                        // The window this host renders into: what a client's geometry report is
                        // matched against so a host only ever moves views in its OWN window.
                        ...(windowID === undefined ? {} : { windowID })
                    }
                );
            } catch (error) {
                report(error, 'host-register');
            }
        }

        private releaseHost(): void {
            const registration = this.hostRegistration;
            this.hostRegistration = null;
            if (registration === null) return;
            try {
                registration.release('unregistered');
            } catch (error) {
                report(error, 'host-unregister');
            }
        }

        /** True while this connection holds the host role (tests / diagnostics). */
        get isWebPaneHost(): boolean {
            return this.hostRegistration !== null;
        }

        // ── handshake ───────────────────────────────────────────────────────────────

        private hello(message: Record<string, unknown>): void {
            const version = count(message['protocolVersion']);
            if (version !== protocolVersion) {
                this.reject(
                    'protocol-mismatch',
                    `daemon speaks client protocol v${protocolVersion}, client speaks v${version ?? 'unknown'}`,
                    'protocol-mismatch'
                );
                return;
            }

            // Where authentication actually happens now. Three cases:
            //   - no `validateToken`: the daemon has no token (dev / `allowAnonymous`);
            //   - the hello carries a token: it must be the right one, whatever the upgrade
            //     said — an authenticated upgrade must not launder a bogus hello token;
            //   - the hello carries none: allowed only when the UPGRADE authenticated, which
            //     is the bearer-header path both Electron shell sockets use.
            const token = typeof message['token'] === 'string' ? message['token'] : '';
            if (options.validateToken !== undefined) {
                const exempt = this.upgradeAuthenticated && token.length === 0;
                if (!exempt && !options.validateToken(token)) {
                    this.reject('unauthorized', BAD_TOKEN_MESSAGE, 'bad-token');
                    return;
                }
            }

            this.clearHelloTimer();
            this.client = parseClientInfo(message['client']);

            this.send({
                type: 'welcome',
                protocolVersion,
                clientID: this.clientID,
                daemon: {
                    version: options.daemon.version,
                    build: options.daemon.build,
                    pid: options.daemon.pid ?? process.pid,
                    // §APP-069, additive: the daemon HOST's home, for display only.
                    // `homeDirectory` is stripped from the MIRROR because a browser on another
                    // machine must not read it as its own — but every path the client renders
                    // (a pane's cwd, a worktree root) is the daemon's, so abbreviating one to
                    // `~` needs the daemon's home rather than the viewer's. Absent on an older
                    // daemon, which a client reads as "no abbreviation", never as `/`.
                    home: options.store.getState().homeDirectory
                },
                // M8: settings ride the handshake, not the snapshot — they are not domain
                // state and must not enter the delta-replayed mirror (`ws/settings.ts`).
                // Every reconnect re-sends them, so a client is never rendering without.
                ...(options.settings !== undefined
                    ? { settings: options.settings.snapshot as unknown as JsonObject }
                    : {}),
                // §SET-021: the config file says which port was ASKED for; only the daemon
                // knows whether it bound. Rides here for the same reason settings do.
                ...(options.transport !== undefined
                    ? { transport: options.transport() as unknown as JsonObject }
                    : {})
            });

            // `resumeFromSeq` is accepted by the protocol but cannot be served safely yet:
            // `seq` is per daemon PROCESS, so a client resuming across a daemon restart
            // would splice deltas onto a mirror of the previous daemon's state. Until the
            // handshake carries an instance id (WP3.1), say so and send a snapshot.
            if (message['resumeFromSeq'] !== undefined && message['resumeFromSeq'] !== null) {
                this.send({ type: 'resync-required', reason: 'seq-gap' });
            }
            this.snapshot();
            // Deltas only start flowing once the snapshot they extend has been written, so
            // the client can never see delta N before the snapshot anchored at N.
            this.ready = true;

            /*
             * §SET-200 / §SET-201: the last global-hotkey registration outcome the shell
             * reported.
             *
             * It cannot ride `welcome`, because the shell reports it over its OWN connection —
             * which may well attach after this window did — so the daemon keeps the last one
             * and replays it here. A window opened an hour after a rejected registration still
             * shows the warning, which is the point: a claimed hotkey is a standing condition,
             * not an event that happened once.
             */
            if (lastHotkeyStatus !== null) this.send(lastHotkeyStatus);

            // Sugar for the Electron shell: claiming the host role in the handshake saves a
            // round-trip and removes the window where the daemon has a client but no host.
            if (this.client?.capabilities?.includes(WEB_HOST_CAPABILITY) === true) {
                this.registerHost(this.client.name, this.client.windowID);
            }
        }

        private snapshot(): void {
            this.send({ type: 'snapshot', seq, state: serializeState(store.getState()) });
        }

        /**
         * Say no, in words, then close cleanly. Both halves matter: the `rejected` frame is the
         * only channel that can explain a refusal to a browser, and the coded close (4000-4999,
         * the app-defined range) is what stops the client reading the drop as an abnormal 1006
         * and retrying forever.
         */
        private reject(code: WsRejectionCode, message: string, reason?: WsRejectionReason): void {
            this.send({
                type: 'rejected',
                code,
                message,
                protocolVersion,
                ...(reason !== undefined ? { reason } : {})
            });
            const closeCode =
                code === 'protocol-mismatch'
                    ? WS_CLOSE_CODES.protocolMismatch
                    : code === 'unauthorized'
                      ? WS_CLOSE_CODES.unauthorized
                      : WS_CLOSE_CODES.serverError;
            this.transport.close(closeCode, reason ?? code);
            this.close();
        }

        // ── reports ─────────────────────────────────────────────────────────────────

        private focusReport(message: Record<string, unknown>): void {
            const workspaceID = text(message['workspaceID']);
            if (workspaceID === undefined) return;
            const rawPane = message['paneID'];
            const paneID = typeof rawPane === 'string' && rawPane.length > 0 ? rawPane : null;

            this.focusedPaneID = paneID;
            this.setActiveWorkspace(workspaceID);

            const workspace = workspaceByID(store.getState(), workspaceID);
            if (workspace === null || workspace.focusedPaneID === paneID) return;
            // Focus is daemon-canonical: the last report from any client wins.
            store.dispatch({ type: 'focus-pane', workspaceID, paneID });
        }

        private visibilityReport(message: Record<string, unknown>): void {
            const workspaceID = text(message['workspaceID']);
            const raw = message['visiblePaneIDs'];
            const visible = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
            this.visiblePaneIDs = new Set(visible);
            this.documentVisible = message['documentVisible'] === true;
            // A backgrounded tab must not claim the active workspace back from a visible one.
            if (workspaceID !== undefined && this.documentVisible) this.setActiveWorkspace(workspaceID);
        }

        /**
         * `web-geometry-report` → the host's `pane-geometry` notify.
         *
         * A pure forward: the daemon owns no pixels and does no layout, it only tags the report
         * with who sent it (`./webpane/geometry.ts`) so the host can tell its own window's
         * geometry from a remote browser's. Nothing is stored — a report is a fact about
         * *right now*, and a stale one would place a view against a window that has moved.
         */
        private geometryReport(message: Record<string, unknown>): void {
            const channel = options.webPanes;
            if (channel === undefined) return;
            const paneID = text(message['paneID']);
            if (paneID === undefined) return;
            const visible = message['visible'] === true;
            const shellWindowID = text(message['shellWindowID']);
            if (shellWindowID !== undefined) this.geometryWindowID = shellWindowID;
            if (visible) this.geometryPanes.add(paneID);
            else this.geometryPanes.delete(paneID);
            try {
                channel.notifyGeometry({
                    paneID,
                    ...(text(message['tabID']) !== undefined ? { tabID: text(message['tabID']) } : {}),
                    rect: parseGeometryRect(message['rect']),
                    visible,
                    devicePixelRatio: count(message['devicePixelRatio']) ?? 1,
                    ...(shellWindowID === undefined ? {} : { shellWindowID }),
                    clientID: this.clientID
                });
            } catch (error) {
                report(error, 'web-geometry-report');
            }
        }

        /**
         * The reporting client vanished (tab closed, reload, crash): every view it placed goes
         * back to the host's holder. Without this a stale page would sit over a window whose
         * UI is gone — and the next client's first report cannot undo a view it never placed.
         */
        private releaseGeometry(): void {
            const channel = options.webPanes;
            if (channel === undefined || this.geometryPanes.size === 0) return;
            const panes = [...this.geometryPanes];
            this.geometryPanes.clear();
            for (const paneID of panes) {
                try {
                    channel.notifyGeometry({
                        paneID,
                        rect: { x: 0, y: 0, w: 0, h: 0 },
                        visible: false,
                        devicePixelRatio: 1,
                        ...(this.geometryWindowID === null ? {} : { shellWindowID: this.geometryWindowID }),
                        clientID: this.clientID
                    });
                } catch (error) {
                    report(error, 'web-geometry-release');
                }
            }
        }

        /**
         * `reveal-request` → a `reveal-pane` fan-out.
         *
         * The Electron shell raises the window itself but cannot switch workspace or move focus
         * — that is the client's job, and agent-lifecycle.md §8.5 pins the ORDER (workspace
         * first, pane last) because the window restoring its old first responder otherwise
         * reverts the selection. So the shell asks, every client hears, and the one running in
         * the named window acts.
         */
        private revealRequest(message: Record<string, unknown>): void {
            const workspaceID = text(message['workspaceID']);
            const paneID = text(message['paneID']);
            if (workspaceID === undefined || paneID === undefined) return;
            const windowID = text(message['windowID']);
            revealPane({
                type: REVEAL_PANE_MESSAGE,
                workspaceID,
                paneID,
                ...(windowID === undefined ? {} : { windowID })
            });
        }

        /**
         * `menu-request` → a `menu-command` fan-out (the shell's native menu bar).
         *
         * Same fan-out-and-let-the-client-filter rule as `reveal-request`: `windowID` scoping is
         * the client's own check, so a browser attached from another machine ignores a ⌘O raised
         * in someone's desktop window.
         */
        private menuRequest(message: Record<string, unknown>): void {
            const command = text(message['command']);
            if (command === undefined) return;
            const windowID = text(message['windowID']);
            revealPane({
                type: MENU_COMMAND_MESSAGE,
                command,
                ...(windowID === undefined ? {} : { windowID })
            });
        }

        /**
         * `flush-saves-request` → `flush-saves-result`: force out every debounced editor save.
         *
         * §AGNT-114's step 1. The reply is unconditional — a daemon with no content service, or
         * one that threw, still answers, because the shell is holding a quit open waiting for
         * it and silence would be indistinguishable from a hang.
         */
        private flushSavesRequest(message: Record<string, unknown>): void {
            const id = text(message['id']);
            let ok = true;
            try {
                options.content?.flushSync?.();
            } catch {
                ok = false;
            }
            this.send({ type: FLUSH_SAVES_RESULT_MESSAGE, ok, ...(id === undefined ? {} : { id }) });
        }

        /**
         * A client says "this is the workspace I am looking at".
         *
         * The per-connection value and the daemon's persisted `lastActiveWorkspaceID` are
         * updated INDEPENDENTLY, and that separation is the fix for the audit's
         * "daemon and window disagree indefinitely" (run-B L3). The daemon's last-active is
         * moved by other things too — `workspace-create` from the CLI marks the new workspace
         * active — so this connection's own value being unchanged says nothing about whether
         * the global one still agrees with it. Returning early on `this.activeWorkspaceID ===
         * workspaceID` (as this used to) meant a client re-asserting the workspace it was
         * already showing could never pull the daemon's answer back, and
         * `kelpi workspace list`'s ACTIVE column stayed wrong for the rest of the session.
         *
         * So: the last activation from ANY source wins, and a client re-assert is a real
         * activation (the client sends one on every sidebar click, even an idempotent one).
         */
        private setActiveWorkspace(workspaceID: string): void {
            this.activeWorkspaceID = workspaceID;
            const state = store.getState();
            /*
             * §WS-112 — the churn guard must not swallow the EXPAND.
             *
             * `set-active-workspace` does two things: it stamps `lastAccessedAt`, and it opens
             * the parent group when the destination is hidden inside a COLLAPSED one
             * (`reducers/workspaces.ts`; the Swift's `AppReducer.swift:1434-1452` step 3). The
             * guard below exists so the activation report a client sends on every click is not
             * a state change every time — but a workspace can be the daemon's last-active AND
             * sit inside a group the user has since collapsed, and then re-activating it
             * (⌘1–9, the palette, a status-popover row, `reveal-pane`) had nothing to do and
             * left the group shut around the workspace the user was just told they arrived in.
             *
             * So the guard asks whether there is anything to DO rather than only whether the id
             * changed: a collapsed parent is work, and the dispatch goes out.
             */
            const parentID = groupIDForWorkspace(state, workspaceID);
            const parentCollapsed = parentID !== null && groupByID(state, parentID)?.isCollapsed === true;
            if (state.lastActiveWorkspaceID === workspaceID && !parentCollapsed) return;
            if (workspaceByID(state, workspaceID) === null) return;
            // The daemon keeps the last-active workspace so a fresh client restores where
            // the user left off (PLAN.md); the per-client value above is the live one.
            store.dispatch({ type: 'set-active-workspace', id: workspaceID, now: now() });
        }

        // ── commands ────────────────────────────────────────────────────────────────

        private attachPane(message: Record<string, unknown>): void {
            const paneID = text(message['paneID']);
            if (paneID === undefined || this.panes === undefined) return;
            const cols = count(message['cols']);
            const rows = count(message['rows']);
            const size = cols !== undefined && rows !== undefined ? { cols, rows } : undefined;
            try {
                const result = this.panes.attach(paneID, size);
                if (result instanceof Promise) result.catch((error: unknown) => report(error, `attach-pane ${paneID}`));
            } catch (error) {
                report(error, `attach-pane ${paneID}`);
            }
        }

        private command(message: Record<string, unknown>): void {
            const id = text(message['id']);
            if (id === undefined) return;
            const payload = message['payload'];

            // WS-only verbs are matched before the wire decode, which would reject them as
            // unknown commands (they are deliberately not part of the CLI's vocabulary).
            if (isRecord(payload)) {
                const name = text(payload['command']);
                if (name !== undefined && isContentCommand(name)) {
                    this.contentCommand(id, name, payload);
                    return;
                }
                if (name !== undefined && isWebCommand(name)) {
                    this.webCommand(id, name, payload);
                    return;
                }
                if (name !== undefined && isAgentCommand(name)) {
                    this.agentCommand(id, payload);
                    return;
                }
                if (name !== undefined && isWsSettingsCommand(name)) {
                    const channel = options.settings;
                    let reply: JsonObject;
                    if (channel === undefined) reply = failure('settings are not available');
                    else {
                        try {
                            reply = handleSettingsCommand(channel, name, payload);
                        } catch (error) {
                            report(error, `ws-command ${name}`);
                            reply = { ...errorReply('handler failed') };
                        }
                    }
                    this.send({ type: 'command-reply', id, reply });
                    return;
                }
                if (name !== undefined && isWsOnlyCommand(name)) {
                    let reply: JsonObject;
                    try {
                        reply = handleWsOnlyCommand(store, name, payload, { now });
                    } catch (error) {
                        report(error, `ws-command ${name}`);
                        reply = { ...errorReply('handler failed') };
                    }
                    this.send({ type: 'command-reply', id, reply });
                    return;
                }
                if (name !== undefined && isRepoCommand(name)) {
                    this.repoCommand(id, name, payload);
                    return;
                }
                if (name !== undefined && isGraftUiCommand(name)) {
                    this.graftCommand(id, name, payload);
                    return;
                }
                if (name !== undefined && isTerminalSearchCommand(name)) {
                    this.searchCommand(id, payload);
                    return;
                }
                if (name !== undefined && isPaneLifecycleCommand(name)) {
                    this.paneLifecycleCommand(id, name, payload);
                    return;
                }
                if (name !== undefined && isDesktopCommand(name)) {
                    this.desktopCommand(id, name, payload);
                    return;
                }
                if (name === GUI_DELETE_WORKSPACE_COMMAND) {
                    this.guiDeleteWorkspace(id, payload);
                    return;
                }
            }

            const decoded = decodeWireObject(payload);

            if (!decoded.ok) {
                // Deliberate divergence from the control socket's silent drop (PLAN.md
                // "deliberate fixes"): a WS command is an RPC and must always settle.
                this.send({ type: 'command-reply', id, reply: { ...errorReply(decoded.detail) } });
                return;
            }

            let answered = false;
            for (const item of dispatchSequence(decoded)) {
                const wire = item.kind === 'message' ? item.message : dualFireMessage(item.event);
                let handle: WsReplyHandle | null = null;
                if (item.reply && !answered) {
                    answered = true;
                    handle = new WsReplyHandle(this.transport, id, (h) => this.handles.delete(h));
                    this.handles.add(handle);
                }
                try {
                    dispatcher(wire, handle);
                } catch (error) {
                    report(error, `ws-command ${wire.command}`);
                    if (handle !== null && !handle.closed) {
                        handle.send({ ...errorReply('handler failed') });
                        handle.close();
                    }
                }
            }

            // Fire-and-forget verbs get an acknowledgement so the client's promise settles.
            if (!answered) this.send({ type: 'command-reply', id, reply: { ok: true } });
        }

        // ── inspector repo verbs (M9) ───────────────────────────────────────────────

        /**
         * The five `repos.ts` verbs. Async (every one shells out to git), so the reply lands
         * through `command-reply` when the promise settles — the content verbs' shape.
         */
        private repoCommand(id: string, command: RepoCommand, payload: Record<string, unknown>): void {
            const channel = options.repos;
            if (channel === undefined) {
                this.send({ type: 'command-reply', id, reply: failure('repo commands are not available') });
                return;
            }
            void handleRepoCommand(channel, command, payload)
                .then((reply) => {
                    this.send({ type: 'command-reply', id, reply });
                })
                .catch((error: unknown) => {
                    report(error, `ws-command ${command}`);
                    this.send({ type: 'command-reply', id, reply: { ...errorReply('handler failed') } });
                });
        }

        // ── inspector graft verbs ───────────────────────────────────────────────────

        /**
         * `ws/graft.ts`'s five verbs. Async like the repo family (start/stop drive git and a
         * recursive watcher), so the reply lands through `command-reply` when it settles.
         */
        private graftCommand(id: string, command: GraftUiCommand, payload: Record<string, unknown>): void {
            const channel = options.graftUi;
            if (channel === undefined) {
                this.send({ type: 'command-reply', id, reply: failure('graft is not available') });
                return;
            }
            void handleGraftUiCommand(channel, command, payload)
                .then((reply) => {
                    this.send({ type: 'command-reply', id, reply });
                })
                .catch((error: unknown) => {
                    report(error, `ws-command ${command}`);
                    this.send({ type: 'command-reply', id, reply: { ...errorReply('handler failed') } });
                });
        }

        // ── terminal search ─────────────────────────────────────────────────────────

        /**
         * `terminal-search`. Async for the same reason the content verbs are: the buffer read
         * flushes `@xterm/headless`'s write queue first, so a needle typed a heartbeat after
         * the output it looks for still finds it.
         */
        private searchCommand(id: string, payload: Record<string, unknown>): void {
            const channel = options.search;
            if (channel === undefined) {
                this.send({ type: 'command-reply', id, reply: failure('terminal search is not available') });
                return;
            }
            void channel.run(payload).then(
                (reply) => {
                    this.send({ type: 'command-reply', id, reply });
                },
                (error: unknown) => {
                    report(error, 'ws-command terminal-search');
                    this.send({ type: 'command-reply', id, reply: { ...errorReply('handler failed') } });
                }
            );
        }

        // ── reopen / scratchpad / reveal ────────────────────────────────────────────

        private paneLifecycleCommand(
            id: string,
            command: PaneLifecycleCommand,
            payload: Record<string, unknown>
        ): void {
            const channel = options.panes;
            if (channel === undefined) {
                this.send({ type: 'command-reply', id, reply: failure(`${command} is not available`) });
                return;
            }
            let reply: JsonObject;
            try {
                reply = channel.run(command, payload);
            } catch (error) {
                report(error, `ws-command ${command}`);
                reply = { ...errorReply('handler failed') };
            }
            this.send({ type: 'command-reply', id, reply });
        }

        /**
         * The desktop gestures (`ws/desktop.ts`): the ⌘O picker relay, ⌘-click path opening,
         * `$EDITOR` hosting and the control-socket rebind. Asynchronous — a shell probe and a
         * listener rebind both take longer than a message handler — so the reply settles when
         * the promise does, like the content verbs.
         */
        /**
         * §WS-156 / §APP-067 — the GUI's own workspace delete.
         *
         * It exists for one reason: the shipped app lets ⌘W on the last pane of the LAST
         * workspace reach zero workspaces (and land on "No workspace selected"), while
         * `kelpi workspace delete` refuses at one. The port had both routes on one verb, so the
         * GUI inherited the CLI's refusal and the empty state had no gesture that could reach it.
         *
         * Rather than put a flag on the wire — `allow_last` is not in wire-protocol.md §7's field
         * dictionary and must never be settable from the control socket — this is a WS-ONLY verb,
         * exactly like `rename-workspace` and for the same stated reason: a new CLI verb would be
         * a compatibility surface owed to the Swift CLI forever. It CONSTRUCTS the delete message
         * instead of decoding one, so `allow_last` can only ever come from a window.
         *
         * Everything after that is the existing handler: the same running-agents guard, the same
         * PTY teardown, the same reply.
         */
        private guiDeleteWorkspace(id: string, payload: Record<string, unknown>): void {
            const workspaceID = text(payload['workspace_id']) ?? text(payload['name']);
            if (workspaceID === undefined) {
                this.send({
                    type: 'command-reply',
                    id,
                    reply: failure(`${GUI_DELETE_WORKSPACE_COMMAND} requires workspace_id`)
                });
                return;
            }
            const handle = new WsReplyHandle(this.transport, id, (h) => this.handles.delete(h));
            this.handles.add(handle);
            try {
                dispatcher(
                    {
                        command: 'workspace-delete',
                        name: workspaceID,
                        force: payload['force'] === true,
                        allow_last: payload['allow_last'] === true
                    },
                    handle
                );
            } catch (error) {
                report(error, `ws-command ${GUI_DELETE_WORKSPACE_COMMAND}`);
                if (!handle.closed) {
                    handle.send({ ...errorReply('handler failed') });
                    handle.close();
                }
            }
        }

        private desktopCommand(
            id: string,
            command: DesktopCommand,
            payload: Record<string, unknown>
        ): void {
            const channel = options.desktop;
            if (channel === undefined) {
                this.send({ type: 'command-reply', id, reply: failure(`${command} is not available`) });
                return;
            }
            void channel.run(command, payload).then(
                (reply) => {
                    this.send({ type: 'command-reply', id, reply });
                },
                (error: unknown) => {
                    report(error, `ws-command ${command}`);
                    this.send({ type: 'command-reply', id, reply: { ...errorReply('handler failed') } });
                }
            );
        }

        // ── agent restart ───────────────────────────────────────────────────────────

        private agentCommand(id: string, payload: Record<string, unknown>): void {
            const channel = options.agents;
            if (channel === undefined) {
                this.send({ type: 'command-reply', id, reply: failure('agent restart is not available') });
                return;
            }
            const paneID = text(payload['pane_id']);
            if (paneID === undefined) {
                this.send({ type: 'command-reply', id, reply: failure('restart-pane-agent requires pane_id') });
                return;
            }
            let result: AgentRestartResult;
            try {
                result = channel.restart(paneID);
            } catch (error) {
                report(error, 'restart-pane-agent');
                result = { ok: false, error: 'handler failed' };
            }
            const reply: JsonObject = result.ok
                ? {
                      ok: true,
                      pane_id: result.paneID ?? paneID,
                      ...(result.workspaceID === undefined ? {} : { workspace_id: result.workspaceID }),
                      ...(result.agent === undefined ? {} : { agent: result.agent }),
                      ...(result.command === undefined ? {} : { command: result.command })
                  }
                : failure(result.error ?? 'restart failed');
            this.send({ type: 'command-reply', id, reply });
        }

        // ── content panes (M5) ──────────────────────────────────────────────────────

        private contentReply(id: string, reply: JsonObject): void {
            this.send({ type: 'command-reply', id, reply });
        }

        /** Release this pane's subscription (if any) and return the new epoch. */
        private dropContentSub(paneID: string): number {
            this.contentSubs.get(paneID)?.unsubscribe();
            this.contentSubs.delete(paneID);
            const epoch = (this.contentEpoch.get(paneID) ?? 0) + 1;
            this.contentEpoch.set(paneID, epoch);
            return epoch;
        }

        private contentCommand(id: string, command: ContentCommand, payload: Record<string, unknown>): void {
            const content = options.content;
            if (content === undefined) {
                this.contentReply(id, failure('content panes are not available'));
                return;
            }
            const paneID = text(payload['pane_id']);
            if (paneID === undefined) {
                this.contentReply(id, failure(`${command} requires pane_id`));
                return;
            }

            if (command === 'content-unsubscribe') {
                this.dropContentSub(paneID);
                this.contentReply(id, { ok: true, pane_id: paneID });
                return;
            }

            const settle = (promise: Promise<ContentPaneState>): void => {
                promise.then(
                    (state) => {
                        this.contentReply(id, {
                            ok: true,
                            pane_id: paneID,
                            state: state as unknown as JsonObject
                        });
                    },
                    (error: unknown) => {
                        this.contentReply(id, failure(toError(error).message));
                    }
                );
            };

            switch (command) {
                case 'content-subscribe': {
                    // Re-subscribing replaces the old handle so a client that lost track of its
                    // subscription cannot end up with two event streams for one pane.
                    const epoch = this.dropContentSub(paneID);
                    content
                        .subscribe(paneID, (state) => {
                            this.send({
                                type: CONTENT_UPDATED_MESSAGE,
                                paneID,
                                state: state as unknown as JsonObject
                            });
                        })
                        .then(
                            (subscription) => {
                                // Voided while the load was in flight (closed, unsubscribed, or
                                // superseded by a newer subscribe): release it, answer honestly.
                                if (this.disposed || this.contentEpoch.get(paneID) !== epoch) {
                                    subscription.unsubscribe();
                                    this.contentReply(id, failure('subscription was cancelled'));
                                    return;
                                }
                                this.contentSubs.set(paneID, subscription);
                                this.contentReply(id, {
                                    ok: true,
                                    pane_id: paneID,
                                    state: subscription.state as unknown as JsonObject
                                });
                            },
                            (error: unknown) => {
                                this.contentReply(id, failure(toError(error).message));
                            }
                        );
                    return;
                }
                case 'markdown-set-mode': {
                    const mode = text(payload['mode']);
                    if (mode !== 'view' && mode !== 'edit') {
                        this.contentReply(id, failure("markdown-set-mode requires mode 'view' or 'edit'"));
                        return;
                    }
                    settle(content.setMode(paneID, mode));
                    return;
                }
                case 'content-set-text': {
                    const value = payload['text'];
                    if (typeof value !== 'string') {
                        this.contentReply(id, failure('content-set-text requires text'));
                        return;
                    }
                    settle(content.setText(paneID, value));
                    return;
                }
                case 'content-set-font-size': {
                    const size = count(payload['size']);
                    if (size === undefined) {
                        this.contentReply(id, failure('content-set-font-size requires size'));
                        return;
                    }
                    settle(content.setFontSize(paneID, size));
                    return;
                }
                case 'diff-refresh':
                    settle(content.refresh(paneID));
                    return;
                default:
                    settle(content.save(paneID));
                    return;
            }
        }

        // ── web-pane console subscriptions (M6) ─────────────────────────────

        /**
         * `web-console-subscribe` is the WS twin of `kelpi web console --follow`: the reply is
         * the same catch-up drain object, and every later line arrives as its own
         * `web-console-line` message. Both readers share one ring buffer per pane, so a drop
         * notice is delivered to whoever consumes it first (web-pane.md §9.3).
         */
        private webCommand(id: string, command: WebCommand, payload: Record<string, unknown>): void {
            const channel = options.webPanes;
            if (channel === undefined) {
                this.send({ type: 'command-reply', id, reply: failure('web panes are not available') });
                return;
            }
            const settle = (reply: JsonObject): void => {
                this.send({ type: 'command-reply', id, reply });
            };

            // §14 favourites are a global list, not a pane's: matched before the pane guard.
            if (FAVOURITE_COMMANDS.has(command)) {
                settle(favouritesCommand(channel, command, payload));
                return;
            }

            const paneID = text(payload['pane_id']);
            if (paneID === undefined) {
                this.send({
                    type: 'command-reply',
                    id,
                    reply: failure(`${command} requires pane_id`)
                });
                return;
            }

            if (
                command === 'web-find' ||
                command === 'web-zoom' ||
                command === 'web-cookie-set' ||
                command === 'web-tab-reorder' ||
                command === 'web-stop' ||
                command === 'web-focus-view' ||
                command.startsWith('web-batch-')
            ) {
                void webPaneGuiCommand(channel, store, command, paneID, payload).then(settle, (error: unknown) => {
                    report(error, `ws-command ${command}`);
                    settle(failure('handler failed'));
                });
                return;
            }

            if (command === 'web-devtools') {
                // Straight through to the host — the daemon has no `webContents` to open dev
                // tools on, and the client already knows which tab it means (§16.5). `open`
                // absent means "toggle", which is what the chrome button does.
                const tabID = text(payload['tab_id']);
                void channel
                    .call('devtools', {
                        paneID,
                        ...(tabID === undefined ? {} : { tabID }),
                        ...(typeof payload['open'] === 'boolean' ? { open: payload['open'] } : {})
                    })
                    .then((reply) => {
                        this.send({
                            type: 'command-reply',
                            id,
                            reply: { ...reply, pane_id: paneID }
                        });
                    });
                return;
            }

            const drop = (): void => {
                this.consoleSubs.get(paneID)?.();
                this.consoleSubs.delete(paneID);
            };

            if (command === 'web-console-unsubscribe') {
                drop();
                this.send({ type: 'command-reply', id, reply: { ok: true, pane_id: paneID } });
                return;
            }

            // Re-subscribing replaces the old handle so a client that lost track of its
            // subscription cannot end up with two streams for one pane.
            drop();
            const since = count(payload['since']);
            const level = text(payload['level']);
            const drain = channel.console.drain(paneID, {
                ...(since !== undefined ? { since } : {}),
                ...(level !== undefined ? { level } : {}),
                ...(payload['clear'] === true ? { clear: true } : {})
            });
            const unsubscribe = channel.subscribeConsole(paneID, {
                push: (line) => {
                    this.send({ type: WEB_CONSOLE_LINE_MESSAGE, paneID, line });
                },
                end: () => {
                    drop();
                }
            });
            this.consoleSubs.set(paneID, unsubscribe);
            this.send({
                type: 'command-reply',
                id,
                reply: {
                    ok: true,
                    pane_id: paneID,
                    lines: drain.lines,
                    next_since: drain.next_since,
                    dropped: drain.dropped,
                    follow: true
                }
            });
        }

        // ── output ──────────────────────────────────────────────────────────────────

        send(message: JsonObject): void {
            if (this.disposed) return;
            try {
                this.transport.sendJson(message);
            } catch (error) {
                report(error, 'ws-send');
            }
        }

        /** Daemon shutdown: say goodbye, then release the connection's resources. */
        shutdown(): void {
            if (this.disposed) return;
            try {
                this.transport.close(1001, 'daemon shutting down');
            } catch (error) {
                report(error, 'ws-close');
            }
            this.close();
        }

        /** Suppression rule for pane notifications (agent-lifecycle.md §7.1/§7.4). */
        attends(workspaceID: string, paneID: string): boolean {
            if (!this.ready || !this.documentVisible) return false;
            if (this.activeWorkspaceID !== workspaceID) return false;
            if (this.focusedPaneID !== paneID) return false;
            // An empty visibility set means the client never reported one; trust focus.
            return this.visiblePaneIDs.size === 0 || this.visiblePaneIDs.has(paneID);
        }
    }

    /**
     * Fan a reveal out to every attached client. Deliberately unfiltered here: `windowID`
     * scoping is the CLIENT's check (it knows which window it is running in), so a browser
     * that is not the named window ignores the message and the daemon needs no map of which
     * connection lives in which window.
     */
    function revealPane(message: JsonObject): void {
        if (closed) return;
        for (const session of sessions) {
            if (session.ready) session.send(message);
        }
    }

    /**
     * §SET-200 / §SET-201: `hotkey-status` from the shell → every client, and remembered.
     *
     * The daemon does not interpret it — it registers nothing itself and has no opinion about
     * accelerators. It is the only party every window shares, so it is where the last outcome
     * is kept so a window that attaches later can still be told (see the replay in `hello`).
     * A malformed report is dropped rather than stored: a remembered bad frame would be
     * re-sent to every future client.
     */
    function hotkeyStatusReport(message: Record<string, unknown>): void {
        if (typeof message['ok'] !== 'boolean') return;
        const source = text(message['source']);
        const relayed: JsonObject = {
            type: WS_HOTKEY_STATUS_MESSAGE,
            accelerator: text(message['accelerator']) ?? null,
            configString: text(message['configString']) ?? null,
            ok: message['ok'],
            error: text(message['error']) ?? null,
            source: source === 'launch' || source === 'settings' ? source : 'settings'
        };
        lastHotkeyStatus = relayed;
        revealPane(relayed);
    }

    /**
     * §AGNT-056: `shell-activation` from a shell → every client, and NOT remembered.
     *
     * The daemon has no opinion about activation either — it is a routing hint about a window,
     * like `reveal-request`, and it is relayed with its `windowID` intact so the client running
     * in that window is the one that acts on it. Nothing is stored: unlike the hotkey outcome
     * (a durable fact about the machine), this describes a moment, and replaying "window W lost
     * focus" into a client that attaches an hour later would suspend timers on a false premise.
     *
     * A malformed report is dropped rather than defaulted: guessing `active: true` here would
     * silently re-arm every client's dwell clear on a frame nobody understood.
     */
    function shellActivationReport(message: Record<string, unknown>): void {
        if (typeof message['active'] !== 'boolean') return;
        const windowID = text(message['windowID']);
        revealPane({
            type: WS_SHELL_ACTIVATION_MESSAGE,
            active: message['active'],
            ...(windowID === undefined ? {} : { windowID })
        });
    }

    /**
     * §WS-151: `workspace-selection` from a client → every attached party, and NOT remembered.
     *
     * `shell-activation` with the arrow reversed, and the daemon has exactly as little opinion
     * about it: a workspace multi-selection is the sidebar's own client-local state, and this is
     * a routing hint so the shell that owns that window's menu bar can grey (or un-grey) File ▸
     * Deselect All Workspaces. Nothing is stored — a client that has said nothing has nothing
     * selected, which is the state a freshly built menu is already in.
     *
     * A malformed or negative count is dropped rather than defaulted: guessing 0 would silently
     * grey a row over a frame nobody understood, and guessing 1 would un-grey one.
     */
    function workspaceSelectionReport(message: Record<string, unknown>): void {
        const selected = message['selected'];
        if (typeof selected !== 'number' || !Number.isFinite(selected) || selected < 0) return;
        const windowID = text(message['windowID']);
        revealPane({
            type: WS_WORKSPACE_SELECTION_MESSAGE,
            selected: Math.floor(selected),
            ...(windowID === undefined ? {} : { windowID })
        });
    }

    const unsubscribe = store.subscribe((events) => {
        if (closed || events.length === 0) return;
        seq += 1;
        const message: JsonObject = { type: 'delta', seq, events: serializeDomainEvents(events) };
        for (const session of sessions) {
            if (session.ready) session.send(message);
        }
    });

    return {
        createSession(transport, panes, sessionOptions) {
            const session = new SessionImpl(transport, panes, sessionOptions?.authenticated === true);
            if (closed) {
                transport.close(WS_CLOSE_CODES.serverError, 'shutting down');
                // Disposes the handshake deadline too: a session nobody registered must not
                // keep a timer alive waiting for a hello it will never accept.
                session.close();
                return session;
            }
            sessions.add(session);
            return session;
        },
        broadcast(event) {
            if (closed) return;
            const type = typeof event['type'] === 'string' ? (event['type'] as string) : 'notification';
            const message = { ...event, type } as JsonObject;
            const workspaceID = typeof event['workspaceID'] === 'string' ? (event['workspaceID'] as string) : undefined;
            const paneID = typeof event['paneID'] === 'string' ? (event['paneID'] as string) : undefined;
            const suppressible = type === 'notification' && workspaceID !== undefined && paneID !== undefined;
            for (const session of sessions) {
                if (!session.ready) continue;
                if (suppressible && session.attends(workspaceID, paneID)) continue;
                session.send(message);
            }
        },
        get sessions() {
            return [...sessions];
        },
        get seq() {
            return seq;
        },
        presence() {
            let visibleClients = 0;
            for (const session of sessions) {
                if (session.ready && session.documentVisible) visibleClients += 1;
            }
            return { clients: sessions.size, visibleClients, anyVisible: visibleClients > 0 };
        },
        isPaneAttended(workspaceID, paneID) {
            for (const session of sessions) {
                if (session.attends(workspaceID, paneID)) return true;
            }
            return false;
        },
        close() {
            if (closed) return;
            closed = true;
            unsubscribe();
            for (const session of [...sessions]) session.shutdown();
            sessions.clear();
        }
    };
}
