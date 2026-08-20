/**
 * The batch "element pickup" session (web-pane.md §12; WEB-126…WEB-145).
 *
 * The single-shot picker (`nex web inspect`) arms once, takes one element and disarms. A *batch*
 * keeps the picker armed (`sticky`), collects elements as the user clicks them, lets each one be
 * annotated, and finally pastes the whole set into a shell pane as one fenced JSON array.
 *
 * In the Swift app this state lived in the workspace reducer because the panel was SwiftUI. Here
 * it is **daemon** state, for the same reason the find needle is: the page-side half (the
 * numbered badges, the focus ring, the comment popover) lives in a page the *host* owns, so a
 * second window looking at the same pane has to see the same items and the same numbering. The
 * client renders this state and pushes intents at it; it never keeps its own copy.
 *
 * The pieces, and the item they come from:
 *
 *   - `toggle` is the three-way chrome button — no batch → start, visible → hide, hidden → show,
 *     with the items surviving hide/show (WEB-126);
 *   - `hide` keeps the items but the caller disarms the picker and clears the page markers, so a
 *     hidden batch is *paused*: a single-shot `web inspect --send-to` arm takes the next pick
 *     instead of the batch (WEB-127/WEB-128);
 *   - `lastTarget` is an in-session memory of the last destination, seeded ONLY from a real pane
 *     send — never from the local-queue branch, and re-validated by the client against the live
 *     pane list (WEB-132);
 *   - `formatBatchForPaste` is the payload (WEB-134): a `# nex inspect batch <ts> (N items)`
 *     header over one pretty-printed, sorted-key JSON array whose entries carry the sanitised
 *     inspect fields plus the 4 KB-clamped comment.
 *
 * Transient, never persisted (§15.1) — a batch is a live editing session.
 */

import type { JsonObject } from '@nex/protocol';

import { clampField, INSPECT_LIMITS, type InspectResult } from './inspect.js';

export interface BatchItem {
    readonly id: string;
    readonly result: InspectResult;
    readonly comment: string;
}

export interface BatchSession {
    /** False = paused: items kept, picker disarmed, no page markers (WEB-127). */
    readonly visible: boolean;
    readonly items: readonly BatchItem[];
    /** The item whose focus ring + popover the page is drawing, and whose row is highlighted. */
    readonly focusedID: string | null;
    /** In-session destination memory; a pane id, never a "queue locally" marker (WEB-132). */
    readonly lastTarget: string | null;
    /** `--submit` carried over from an armed `web inspect --submit` (WEB-134). */
    readonly submit: boolean;
}

export type BatchToggleOutcome = 'started' | 'shown' | 'hidden';

export interface BatchState {
    sessionOf(paneID: string): BatchSession | null;
    /** WEB-126's three-way. Returns what happened so the caller can arm/disarm accordingly. */
    toggle(paneID: string): BatchToggleOutcome;
    start(paneID: string): BatchSession;
    show(paneID: string): BatchSession | null;
    hide(paneID: string): BatchSession | null;
    /** A pick landed while the panel was visible: append + focus it (page origin). */
    add(paneID: string, item: BatchItem): BatchSession | null;
    remove(paneID: string, itemID: string): BatchSession | null;
    setComment(paneID: string, itemID: string, comment: string): BatchSession | null;
    /** `null` unfocuses (the popover's Done / Escape). */
    focus(paneID: string, itemID: string | null): BatchSession | null;
    setSubmit(paneID: string, submit: boolean): BatchSession | null;
    /** Send/cancel teardown: the session is dropped and its items returned. */
    take(paneID: string, options?: { readonly rememberTarget?: string | undefined }): BatchSession | null;
    disposePane(paneID: string): void;
    /** Every pane with a live session (host re-registration replays their markers). */
    panes(): readonly string[];
}

function emptySession(lastTarget: string | null): BatchSession {
    return { visible: true, items: [], focusedID: null, lastTarget, submit: false };
}

export function createBatchState(): BatchState {
    const sessions = new Map<string, BatchSession>();
    /**
     * Survives the session it came from: the memory is per PANE for the whole daemon run, so a
     * second batch on the same pane defaults to the destination the first one used. A fresh
     * daemon always starts unselected (never persisted), exactly as the Swift `.local` memory.
     */
    const lastTargets = new Map<string, string>();

    const put = (paneID: string, session: BatchSession): BatchSession => {
        sessions.set(paneID, session);
        return session;
    };

    const patch = (paneID: string, change: Partial<BatchSession>): BatchSession | null => {
        const current = sessions.get(paneID);
        if (current === undefined) return null;
        return put(paneID, { ...current, ...change });
    };

    return {
        sessionOf(paneID) {
            return sessions.get(paneID) ?? null;
        },

        toggle(paneID) {
            const current = sessions.get(paneID);
            if (current === undefined) {
                put(paneID, emptySession(lastTargets.get(paneID) ?? null));
                return 'started';
            }
            if (current.visible) {
                put(paneID, { ...current, visible: false, focusedID: null });
                return 'hidden';
            }
            put(paneID, { ...current, visible: true });
            return 'shown';
        },

        start(paneID) {
            return put(paneID, emptySession(lastTargets.get(paneID) ?? null));
        },

        show(paneID) {
            return patch(paneID, { visible: true });
        },

        hide(paneID) {
            return patch(paneID, { visible: false, focusedID: null });
        },

        add(paneID, item) {
            const current = sessions.get(paneID);
            if (current === undefined || !current.visible) return null;
            return put(paneID, {
                ...current,
                items: [...current.items, item],
                focusedID: item.id
            });
        },

        remove(paneID, itemID) {
            const current = sessions.get(paneID);
            if (current === undefined) return null;
            const items = current.items.filter((item) => item.id !== itemID);
            if (items.length === current.items.length) return current;
            return put(paneID, {
                ...current,
                items,
                focusedID: current.focusedID === itemID ? null : current.focusedID
            });
        },

        setComment(paneID, itemID, comment) {
            const current = sessions.get(paneID);
            if (current === undefined) return null;
            let changed = false;
            const clamped = clampField(comment, INSPECT_LIMITS.comment);
            const items = current.items.map((item) => {
                if (item.id !== itemID || item.comment === clamped) return item;
                changed = true;
                return { ...item, comment: clamped };
            });
            return changed ? put(paneID, { ...current, items }) : current;
        },

        focus(paneID, itemID) {
            const current = sessions.get(paneID);
            if (current === undefined) return null;
            // Focusing an item that is not in the set is a no-op rather than a stuck ring.
            if (itemID !== null && !current.items.some((item) => item.id === itemID)) return current;
            return put(paneID, { ...current, focusedID: itemID });
        },

        setSubmit(paneID, submit) {
            return patch(paneID, { submit });
        },

        take(paneID, options = {}) {
            const current = sessions.get(paneID) ?? null;
            sessions.delete(paneID);
            // WEB-132: only a real destination is remembered, and only when something was sent.
            const remembered = options.rememberTarget;
            if (remembered !== undefined && remembered !== '' && current !== null && current.items.length > 0) {
                lastTargets.set(paneID, remembered);
            }
            return current;
        },

        disposePane(paneID) {
            sessions.delete(paneID);
            lastTargets.delete(paneID);
        },

        panes() {
            return [...sessions.keys()];
        }
    };
}

// ---------------------------------------------------------------------------
// The paste payload (WEB-134)
// ---------------------------------------------------------------------------

/** One entry of the batch array: `formatForPaste`'s body plus the annotation. */
function batchEntry(item: BatchItem): Record<string, unknown> {
    const result = item.result;
    return {
        attributes: result.attributes,
        captured_at: new Date(result.capturedAt).toISOString(),
        comment: clampField(item.comment, INSPECT_LIMITS.comment),
        ...(result.contextHTML === '' ? {} : { context_html: result.contextHTML }),
        id: result.elementID,
        ...(result.outerHTML === '' ? {} : { outer_html: result.outerHTML }),
        rect: { h: result.rect.h, w: result.rect.w, x: result.rect.x, y: result.rect.y },
        selector: result.selector,
        tag: result.tag,
        text: result.text,
        url: result.url,
        xpath: result.xpath
    };
}

/**
 * `InspectPayloadSanitiser.formatBatchForPaste`: the header names the moment the batch was sent
 * and how many items it carries, then one fenced JSON array — one block an agent can lift whole,
 * rather than N separate `# nex inspect` directives it would have to stitch back together.
 */
export function formatBatchForPaste(items: readonly BatchItem[], now: number): string {
    const timestamp = new Date(now).toISOString();
    const plural = items.length === 1 ? 'item' : 'items';
    const body = JSON.stringify(items.map(batchEntry), null, 2);
    return `# nex inspect batch ${timestamp} (${String(items.length)} ${plural})\n\`\`\`json\n${body}\n\`\`\`\n`;
}

/** The wire/UI shape of one item (the client's panel row, WEB-129). */
export function serializeBatchItem(item: BatchItem): JsonObject {
    return {
        id: item.id,
        selector: item.result.selector,
        tag: item.result.tag,
        text: item.result.text,
        url: item.result.url,
        comment: item.comment
    };
}

/** The whole session, as a client reads it. */
export function serializeBatchSession(session: BatchSession | null): JsonObject | null {
    if (session === null) return null;
    return {
        visible: session.visible,
        focused_id: session.focusedID,
        last_target: session.lastTarget,
        submit: session.submit,
        items: session.items.map(serializeBatchItem)
    };
}

/** The page-side marker inputs: a live re-query target, a badge number and its comment. */
export function batchMarkerInputs(session: BatchSession): JsonObject[] {
    if (!session.visible) return [];
    return session.items.map((item, index) => ({
        id: item.id,
        selector: item.result.selector,
        label: String(index + 1),
        comment: item.comment
    }));
}
