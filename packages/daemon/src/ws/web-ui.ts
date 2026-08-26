/**
 * The web pane's GUI-only verbs (web-pane.md §10 find, §4.2 zoom, §12 batch pickup, §13.2's
 * cookie write, §14 favourites).
 *
 * They are WS-only for the reason `web-devtools` is: **the Swift app has no CLI verb for any of
 * them**, so giving them a wire command would owe the compat CLI a vocabulary it will never
 * send. They live here rather than inside `./sync.ts`'s session class because they are a
 * feature's vocabulary, not the hub's transport — `sync.ts` matches the name and calls in.
 *
 * Everything below is a thin translation layer: the *state* is the web-pane service's
 * (`webpane/find.ts`, `webpane/batch.ts`, `webpane/favourites.ts`), and the page-side effects are
 * the host's. What this module owns is the wire shape and the refusals — which is why the batch
 * send re-checks its destination against the store even though the client only ever offers a
 * legal one (§17.9: only a shell pane has a PTY to paste into).
 */

import type { JsonObject } from '@nex/protocol';

import { findPaneAnywhere, workspaceByID } from '../store/derived.js';
import type { DomainStore } from '../seams.js';
import type { DaemonState, DomainAction, DomainEvent } from '../store/types.js';
import { isFindAction, serializeBatchSession, serializeFavourite } from '../webpane/index.js';
import type { WebPaneChannel } from './sync.js';

type WebStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

/** Web verbs that address the whole favourites list rather than one pane. */
export const FAVOURITE_COMMANDS: ReadonlySet<string> = new Set([
    'web-favourites-list',
    'web-favourite-toggle',
    'web-favourite-remove',
    'web-favourite-rename',
    'web-favourite-move'
]);

/** Broadcast type for the favourites list (every client's URL-bar star + bookmarks menu). */
export const WEB_FAVOURITES_MESSAGE = 'web-favourites';
/** Broadcast type for one pane's batch session (the panel's rows, its focus, its destination). */
export const WEB_BATCH_MESSAGE = 'web-batch';
/**
 * Broadcast type for one TAB's loading + history state (WEB-032/WEB-033/WEB-034).
 *
 * Per tab, not per pane: WEB-034's rule is that switching tabs snaps the progress strip to the
 * newly-active tab's live state, which a pane-keyed message could not express.
 */
export const WEB_NAV_STATE_MESSAGE = 'web-nav-state';
/**
 * §N29: broadcast type for "the user clicked into this pane's PAGE".
 *
 * A web pane's page is a native view composited over the client's renderer, so a click inside it
 * reaches Chromium and nobody else — the client never learns the pane was touched and the focus
 * ring stays where it was. The host reports the gesture as a `host-event`, this is the daemon's
 * fan-out of it, and the client in that window then runs the same focus path a terminal body
 * click runs. Scoped by `windowID` exactly as `shell-activation` is: a second window's ring must
 * not move because this one was clicked.
 */
export const WEB_VIEW_FOCUS_MESSAGE = 'web-view-focus';

function failure(error: string): JsonObject {
    return { ok: false, error };
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function integer(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

// ── §14 favourites ──────────────────────────────────────────────────────────────────

/** The reply every mutation shares: the post-mutation list, so no client has to re-read. */
export function favouritesReply(channel: WebPaneChannel, extra: JsonObject = {}): JsonObject {
    return {
        ok: true,
        ...extra,
        favourites: channel.favourites.list().map(serializeFavourite)
    };
}

export function favouritesCommand(
    channel: WebPaneChannel,
    command: string,
    payload: Record<string, unknown>
): JsonObject {
    const favourites = channel.favourites;
    switch (command) {
        case 'web-favourites-list':
            return favouritesReply(channel);
        case 'web-favourite-toggle': {
            // WEB-037: an empty URL is ignored rather than saved — the star is disabled for it
            // in the chrome, and a scripted caller gets the same answer.
            const url = payload['url'];
            if (typeof url !== 'string' || url.trim() === '') {
                return failure('web-favourite-toggle requires url');
            }
            const title = typeof payload['title'] === 'string' ? payload['title'] : '';
            const outcome = favourites.toggle(url, title);
            return favouritesReply(channel, {
                added: outcome.added,
                ...(outcome.id === null ? {} : { favourite_id: outcome.id })
            });
        }
        case 'web-favourite-remove': {
            const id = text(payload['id']);
            if (id === undefined) return failure('web-favourite-remove requires id');
            favourites.remove(id);
            return favouritesReply(channel, { favourite_id: id });
        }
        case 'web-favourite-rename': {
            const id = text(payload['id']);
            if (id === undefined) return failure('web-favourite-rename requires id');
            const title = typeof payload['title'] === 'string' ? payload['title'] : '';
            // SET-099: trimmed, and a no-op when the value did not actually change.
            favourites.rename(id, title);
            return favouritesReply(channel, { favourite_id: id });
        }
        default: {
            const from = integer(payload['from']);
            const to = integer(payload['to']);
            if (from === undefined || to === undefined) {
                return failure('web-favourite-move requires from and to');
            }
            favourites.move(from, to);
            return favouritesReply(channel);
        }
    }
}

// ── §12 batch pickup, §10 find, §4.2 zoom, §13.2 cookie write ───────────────────────

/** The `{ok, pane_id, batch}` shape every batch verb answers with. */
function batchReply(channel: WebPaneChannel, paneID: string, extra: JsonObject = {}): JsonObject {
    return {
        ok: true,
        pane_id: paneID,
        ...extra,
        batch: serializeBatchSession(channel.batch.sessionOf(paneID))
    };
}

/**
 * §17.9's destination rule, re-checked here: `--send-to` and the panel's picker both refuse
 * anything that is not a **shell** pane, because only a shell has a PTY to paste into. The
 * client's picker already lists nothing else (WEB-133); this is the guard that makes that a
 * contract rather than a convention.
 */
function resolveSendTo(store: WebStore, sendTo: string): { ok: true; paneID: string } | { ok: false; error: string } {
    const state = store.getState();
    const location = findPaneAnywhere(state, sendTo);
    if (location === null) return { ok: false, error: `pane not found: ${sendTo}` };
    const workspace = workspaceByID(state, location.workspaceID);
    const pane = workspace?.panes.find((candidate) => candidate.id === sendTo) ?? null;
    if (pane === null) return { ok: false, error: `pane not found: ${sendTo}` };
    if (pane.type !== 'shell') {
        return { ok: false, error: `destination must be a shell pane (got: ${pane.type})` };
    }
    return { ok: true, paneID: pane.id };
}

/** The workspace a pane lives in, for the verbs that dispatch a store action. */
function workspaceOfPane(store: WebStore, paneID: string): string | null {
    return findPaneAnywhere(store.getState(), paneID)?.workspaceID ?? null;
}

/** `{tabID}` when the caller named a tab; `{}` otherwise, so the host uses the active one. */
function tabArg(payload: Record<string, unknown>): JsonObject {
    const tabID = text(payload['tab_id']);
    return tabID === undefined ? {} : { tabID };
}

export async function webPaneGuiCommand(
    channel: WebPaneChannel,
    store: WebStore,
    command: string,
    paneID: string,
    payload: Record<string, unknown>
): Promise<JsonObject> {
    switch (command) {
        // ── tab strip drag reorder (WEB-016) ────────────────────────────────
        case 'web-tab-reorder': {
            const raw = payload['order'];
            if (!Array.isArray(raw)) return failure('web-tab-reorder requires order');
            const order = raw.filter((entry): entry is string => typeof entry === 'string');
            if (order.length !== raw.length) return failure('web-tab-reorder order must be tab ids');
            const workspaceID = workspaceOfPane(store, paneID);
            if (workspaceID === null) return failure(`pane not found: ${paneID}`);
            store.dispatch({ type: 'web-tab-reorder', workspaceID, paneID, order });
            // The post-mutation order, read back out of the store: the reducer drops a
            // non-permutation whole (WEB-016), and the caller must be able to see that it did.
            const state = store.getState();
            const workspace = workspaceByID(state, workspaceID);
            const tabs = workspace?.webPanes[paneID]?.tabs ?? [];
            const applied = tabs.map((tab) => tab.id);
            return {
                ok: true,
                pane_id: paneID,
                order: applied,
                applied: applied.join(',') === order.join(',')
            };
        }

        // ── stop the current load (WEB-032's ✕ glyph) ───────────────────────
        case 'web-stop': {
            const envelope = await channel.call('stop', {
                paneID,
                ...tabArg(payload)
            });
            return { ...envelope, ok: envelope['ok'] === true, pane_id: paneID };
        }

        // ── hand keyboard focus to the page (WEB-043) ───────────────────────
        case 'web-focus-view': {
            const envelope = await channel.call('focus-view', {
                paneID,
                ...tabArg(payload)
            });
            return { ...envelope, ok: envelope['ok'] === true, pane_id: paneID };
        }

        // ── find (§10) ──────────────────────────────────────────────────────
        case 'web-find': {
            const action = typeof payload['action'] === 'string' ? payload['action'] : 'search';
            if (!isFindAction(action)) {
                return failure(`unknown find action '${action}' (allowed: search, next, prev, clear)`);
            }
            const tabID = text(payload['tab_id']);
            if (tabID === undefined) return failure('web-find requires tab_id');
            const needle = typeof payload['needle'] === 'string' ? payload['needle'] : '';
            const envelope = await channel.runFind(paneID, tabID, action, needle);
            return { ...envelope, ok: envelope['ok'] === true, pane_id: paneID };
        }

        // ── zoom (§4.2) ─────────────────────────────────────────────────────
        case 'web-zoom': {
            const tabID = text(payload['tab_id']);
            if (tabID === undefined) return failure('web-zoom requires tab_id');
            const direction = typeof payload['direction'] === 'string' ? payload['direction'] : '';
            // ±0.1 per step and `reset` → 1.0, exactly as `NexCommands.swift`'s ⌘= / ⌘- / ⌘0
            // layer sends them. The host clamps to [0.5, 3.0] either way.
            const args: JsonObject =
                direction === 'in'
                    ? { paneID, tabID, delta: 0.1 }
                    : direction === 'out'
                      ? { paneID, tabID, delta: -0.1 }
                      : direction === 'reset'
                        ? { paneID, tabID, reset: true }
                        : {
                              paneID,
                              tabID,
                              ...(typeof payload['factor'] === 'number' ? { factor: payload['factor'] } : {}),
                              ...(typeof payload['delta'] === 'number' ? { delta: payload['delta'] } : {})
                          };
            const envelope = await channel.call('zoom', args);
            return { ...envelope, ok: envelope['ok'] === true, pane_id: paneID, tab_id: tabID };
        }

        // ── batch pickup (§12) ──────────────────────────────────────────────
        case 'web-batch-state':
            return batchReply(channel, paneID);

        case 'web-batch-toggle': {
            // WEB-126's three-way. `started`/`shown` re-arm the sticky picker (the page's own
            // arm does not survive a hide), `hidden` disarms it and drops the markers.
            const outcome = channel.batch.toggle(paneID);
            if (outcome === 'hidden') {
                channel.publishBatch(paneID);
                // Fire-and-forget: a disarm for a pane whose views are gone has nothing to do,
                // and the reply is the batch, not the page's opinion of it.
                void channel.call('inspect-disarm', { paneID }).catch(() => undefined);
                return batchReply(channel, paneID, { armed: false, toggled: outcome });
            }
            channel.publishBatch(paneID);
            const armed = await channel.armBatch(paneID);
            if (armed['ok'] !== true) {
                // The arm failed (no host, no tab): tear the session back down rather than
                // leaving a panel open over a picker that will never fire.
                channel.cancelBatch(paneID);
                return { ...armed, ok: false, pane_id: paneID, batch: null };
            }
            return batchReply(channel, paneID, { armed: true, toggled: outcome });
        }

        case 'web-batch-cancel':
            channel.cancelBatch(paneID);
            return batchReply(channel, paneID, { cancelled: true });

        case 'web-batch-remove': {
            const itemID = text(payload['item_id']);
            if (itemID === undefined) return failure('web-batch-remove requires item_id');
            channel.batch.remove(paneID, itemID);
            channel.publishBatch(paneID);
            return batchReply(channel, paneID, { item_id: itemID });
        }

        case 'web-batch-comment': {
            const itemID = text(payload['item_id']);
            if (itemID === undefined) return failure('web-batch-comment requires item_id');
            const comment = typeof payload['comment'] === 'string' ? payload['comment'] : '';
            channel.batch.setComment(paneID, itemID, comment);
            // WEB-141: push the panel's edit into the page popover. The page-side write is
            // itself guarded — it refuses while the textarea has focus, so the two editors
            // cannot fight over the cursor.
            const session = channel.batch.sessionOf(paneID);
            if (session !== null) {
                const tabID = text(payload['tab_id']);
                if (tabID !== undefined) {
                    void channel.call('batch-comment', { paneID, tabID, itemID, comment }).catch(() => undefined);
                }
            }
            channel.publishBatch(paneID);
            return batchReply(channel, paneID, { item_id: itemID });
        }

        case 'web-batch-focus': {
            const itemID = text(payload['item_id']) ?? null;
            const origin = payload['origin'] === 'page' ? 'page' : 'panel';
            channel.focusBatchItem(paneID, itemID, origin);
            return batchReply(channel, paneID, { item_id: itemID, origin });
        }

        case 'web-batch-send': {
            const sendTo = text(payload['send_to']) ?? null;
            if (sendTo !== null) {
                const resolved = resolveSendTo(store, sendTo);
                if (!resolved.ok) return failure(resolved.error);
            }
            const outcome = channel.sendBatch(paneID, sendTo);
            if (!outcome.ok) return failure(outcome.error ?? 'failed to send batch');
            return batchReply(channel, paneID, {
                sent: outcome.sent,
                send_to: outcome.sendTo ?? ''
            });
        }

        // ── cookie write (§13.2) ────────────────────────────────────────────
        default: {
            const cookie = payload['cookie'];
            if (typeof cookie !== 'object' || cookie === null || Array.isArray(cookie)) {
                return failure('web-cookie-set requires cookie');
            }
            const original = payload['original'];
            const envelope = await channel.call('cookies-set', {
                paneID,
                cookie: cookie as JsonObject,
                ...(typeof original === 'object' && original !== null && !Array.isArray(original)
                    ? { original: original as JsonObject }
                    : {})
            });
            return { ...envelope, ok: envelope['ok'] === true, pane_id: paneID };
        }
    }
}
