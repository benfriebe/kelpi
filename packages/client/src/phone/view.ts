/**
 * The phone shell's own view state (B1/B2, docs/MOBILE-PLAN.md).
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift app**
 * (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * Two things live here, both CLIENT-LOCAL (plan §3.2: "which pane is in view, which drawer is
 * open ... all client-side, never daemon state"):
 *
 *   1. **The view mode.** `pane` shows ONE pane filling the screen; `layout` shows the
 *      workspace's whole split tree, the same `PaneGrid` the desktop draws, at phone size. The
 *      owner asked for both and for a switch between them (2026-09-08). The choice is remembered
 *      per client in `localStorage`, guarded: a blocked store falls back to `pane`, which is the
 *      plan's default ("one pane at a time").
 *   2. **Which REMOTE host's workspace is showing**, if any. Mirrors `App.tsx`'s
 *      `remoteSelection`: null means the origin daemon's active workspace.
 *
 * Which pane `pane` mode shows is deliberately NOT state of its own: it is the daemon-focused
 * pane, echo-fast (`selectFocusedPaneID`), and the phone's pane switcher FOCUSES. The plan's B2
 * sketched a client-local "shown pane" that never wrote focus, but the focus report is already
 * how every remote client works (a tap in a pane's body calls `act.focusPane`, and the owner
 * validated exactly that on the device in rounds 4 to 8 under the desktop layout), the daemon's
 * own focus is what `kelpi pane focus`, a notification's Open and a split's new pane move, and a
 * second source of truth for "the pane you are looking at" would have had to be reconciled with
 * all of them. One rule, one owner: the daemon's focus is the shown pane. What it costs is the
 * ring on a Mac that is being used at the same time, which a pane tap on the phone already moved.
 *
 * `zoomedPaneID` is never written (plan §2: zoom is daemon state and would zoom the desktop too).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { defaultStorage, type StorageLike } from '../app/config';

export type PhoneViewMode = 'pane' | 'layout';

/** Where the per-client mode choice is remembered. */
export const PHONE_VIEW_MODE_KEY = 'kelpi.phone.view-mode';

export const DEFAULT_PHONE_VIEW_MODE: PhoneViewMode = 'pane';

export function isPhoneViewMode(value: unknown): value is PhoneViewMode {
    return value === 'pane' || value === 'layout';
}

/** The remembered mode; the default when nothing is stored or the store is blocked. */
export function readStoredViewMode(storage: StorageLike | null = defaultStorage()): PhoneViewMode {
    try {
        const value = storage?.getItem(PHONE_VIEW_MODE_KEY);
        return isPhoneViewMode(value) ? value : DEFAULT_PHONE_VIEW_MODE;
    } catch {
        return DEFAULT_PHONE_VIEW_MODE;
    }
}

export function writeStoredViewMode(mode: PhoneViewMode, storage: StorageLike | null = defaultStorage()): void {
    try {
        storage?.setItem(PHONE_VIEW_MODE_KEY, mode);
    } catch {
        // Convenience only; the mode still holds for this page's life.
    }
}

/** A remote host's workspace on screen. `host` is the host's key in the phone's host list. */
export interface PhoneRemoteSelection {
    readonly host: string;
    readonly workspaceID: string;
}

/**
 * The pane `pane` mode shows: the focused pane, or the first pane in layout order when nothing
 * holds focus (a workspace whose focused pane was just closed, between the close and the
 * daemon's next focus). Null only for an empty workspace.
 */
export function resolveShownPane(focusedPaneID: string | null, paneOrder: readonly string[]): string | null {
    if (focusedPaneID !== null && paneOrder.includes(focusedPaneID)) return focusedPaneID;
    return paneOrder[0] ?? null;
}

export interface PhoneVisibleInput {
    readonly mode: PhoneViewMode;
    readonly shownPaneID: string | null;
    /** What the desktop rule would report: the layout's own visible set (zoom-aware). */
    readonly layoutVisible: readonly string[];
    /** A remote host's workspace is on screen, so none of the origin's panes are. */
    readonly remoteSelected: boolean;
}

/**
 * What the ORIGIN daemon is told this client is showing (`reportVisiblePanes`), and what the
 * mount policy is allowed to mount. `pane` mode shows one pane, so one pane is visible: the
 * daemon fans PTY bytes out only for that one, which on a tailnet is the difference between one
 * stream and six.
 */
export function phoneVisiblePaneIDs(input: PhoneVisibleInput): readonly string[] {
    if (input.remoteSelected) return EMPTY;
    if (input.mode === 'layout') return input.layoutVisible;
    return input.shownPaneID === null ? EMPTY : [input.shownPaneID];
}

const EMPTY: readonly string[] = [];

export interface PhoneView {
    readonly mode: PhoneViewMode;
    readonly shownPaneID: string | null;
    readonly remote: PhoneRemoteSelection | null;
    setMode(mode: PhoneViewMode): void;
    toggleMode(): void;
    selectRemote(selection: PhoneRemoteSelection | null): void;
}

export interface UsePhoneViewOptions {
    /** False on a desktop: the hook then holds defaults and touches no storage. */
    readonly enabled: boolean;
    readonly focusedPaneID: string | null;
    readonly paneOrder: readonly string[];
    readonly storage?: StorageLike | null | undefined;
}

/** The view state, owned by assembly so the visible-pane report can read it. */
export function usePhoneView(options: UsePhoneViewOptions): PhoneView {
    const { enabled, focusedPaneID, paneOrder } = options;
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    const [mode, setModeState] = useState<PhoneViewMode>(() => (enabled ? readStoredViewMode(storage) : DEFAULT_PHONE_VIEW_MODE));
    const [remote, setRemote] = useState<PhoneRemoteSelection | null>(null);

    // A desktop that becomes a phone (the audit's emulation, a tablet losing its mouse) reads the
    // remembered mode on that edge; a phone that becomes a desktop drops its remote selection,
    // because the desktop tree has its own.
    useEffect(() => {
        if (enabled) setModeState(readStoredViewMode(storage));
        else setRemote(null);
        // `storage` is a stable handle; the edge is `enabled`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);

    const setMode = useCallback(
        (next: PhoneViewMode): void => {
            setModeState(next);
            writeStoredViewMode(next, storage);
        },
        [storage]
    );
    const toggleMode = useCallback((): void => {
        setModeState((current) => {
            const next: PhoneViewMode = current === 'pane' ? 'layout' : 'pane';
            writeStoredViewMode(next, storage);
            return next;
        });
    }, [storage]);

    const shownPaneID = useMemo(() => resolveShownPane(focusedPaneID, paneOrder), [focusedPaneID, paneOrder]);

    return useMemo(
        () => ({ mode, shownPaneID, remote, setMode, toggleMode, selectRemote: setRemote }),
        [mode, shownPaneID, remote, setMode, toggleMode]
    );
}
