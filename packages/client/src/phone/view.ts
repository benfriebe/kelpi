/**
 * The phone shell's own view state (B1/B2/B7, docs/MOBILE-PLAN.md).
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift app**
 * (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * Three things live here, all CLIENT-LOCAL (plan §3.2: "which pane is in view, which drawer is
 * open ... all client-side, never daemon state"):
 *
 *   1. **The view mode.** `pane` shows ONE pane filling the screen; `layout` shows the
 *      workspace's whole split tree, the same `PaneGrid` the desktop draws, at phone size. The
 *      owner asked for both and for a switch between them (2026-09-08). The choice is remembered
 *      per client in `localStorage`, guarded: a blocked store falls back to `pane`, which is the
 *      plan's default ("one pane at a time").
 *   2. **Which REMOTE host's workspace is showing**, if any. Mirrors `App.tsx`'s
 *      `remoteSelection`: null means the origin daemon's active workspace.
 *   3. **Whether the LANDING page is on screen** (B7, owner request 2026-09-08 after the device
 *      round: "a landing page to pick a host, with local state"). It is the shell's third
 *      top-level state, beside `pane` and `layout` and read as one value through `screen`; it is
 *      deliberately not a sheet, because it is where the phone STARTS rather than something laid
 *      over what it was showing, and it registers nothing with `chrome/modal-presence.ts` for the
 *      same reason. Nothing of the origin's is on screen while it is up, which
 *      {@link phoneVisiblePaneIDs} reports and the daemon acts on.
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { defaultStorage, type StorageLike } from '../app/config';
import { ORIGIN_HOST_KEY } from './model';
import { readStoredPlace, writeStoredPlace, type PhonePlace } from './place';

export type PhoneViewMode = 'pane' | 'layout';

/**
 * The shell's ONE top-level state: the landing page, or the view mode of the workspace on screen.
 *
 * `mode` survives a trip to the landing page (it is the person's standing choice of "one pane" or
 * "the whole layout"), so the screen is the pair read as one value rather than a fourth field.
 */
export type PhoneScreen = 'landing' | PhoneViewMode;

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
    /** The landing page is on screen, so NO workspace is: not the origin's, not a remote's. */
    readonly landing: boolean;
}

/**
 * What the ORIGIN daemon is told this client is showing (`reportVisiblePanes`), and what the
 * mount policy is allowed to mount. `pane` mode shows one pane, so one pane is visible: the
 * daemon fans PTY bytes out only for that one, which on a tailnet is the difference between one
 * stream and six. The landing page shows none, which is the cheapest screen the phone has: a
 * person picking a host is streaming nothing from anybody.
 *
 * The report is about what is ON SCREEN, not about what has a terminal: a web pane drawn as B7's
 * card and a markdown pane drawn by the desktop's own component are both visible panes, and the
 * daemon's notification suppression is right to treat them as looked at.
 */
export function phoneVisiblePaneIDs(input: PhoneVisibleInput): readonly string[] {
    if (input.landing) return EMPTY;
    if (input.remoteSelected) return EMPTY;
    if (input.mode === 'layout') return input.layoutVisible;
    return input.shownPaneID === null ? EMPTY : [input.shownPaneID];
}

const EMPTY: readonly string[] = [];

export interface PhoneView {
    readonly mode: PhoneViewMode;
    /** The shell's one top-level state: `landing`, or the view mode of the workspace on screen. */
    readonly screen: PhoneScreen;
    readonly atLanding: boolean;
    readonly shownPaneID: string | null;
    readonly remote: PhoneRemoteSelection | null;
    setMode(mode: PhoneViewMode): void;
    toggleMode(): void;
    selectRemote(selection: PhoneRemoteSelection | null): void;
    /** Back to the host list; forgets the remembered place (`phone/place.ts` says why). */
    showLanding(): void;
    /** A workspace is being opened: leave the landing page, remembering where. */
    openWorkspace(): void;
}

export interface UsePhoneViewOptions {
    /** False on a desktop: the hook then holds defaults and touches no storage. */
    readonly enabled: boolean;
    readonly focusedPaneID: string | null;
    readonly paneOrder: readonly string[];
    /**
     * The ORIGIN's active workspace, so the remembered place can name it. Advisory: a restore
     * shows whatever the daemon's active workspace is then, and never re-activates this one
     * (`phone/place.ts`, rule 2).
     */
    readonly originWorkspaceID?: string | null | undefined;
    readonly storage?: StorageLike | null | undefined;
    /**
     * Where the remembered place lives: the phone's OWN store, the one that holds the host list,
     * because a place names a host in that list (`phone/place.ts`).
     */
    readonly placeStorage?: StorageLike | null | undefined;
}

/** The view state, owned by assembly so the visible-pane report can read it. */
export function usePhoneView(options: UsePhoneViewOptions): PhoneView {
    const { enabled, focusedPaneID, paneOrder } = options;
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    const placeStorage = options.placeStorage === undefined ? defaultStorage() : options.placeStorage;
    const originWorkspaceID = options.originWorkspaceID ?? null;
    const [mode, setModeState] = useState<PhoneViewMode>(() => (enabled ? readStoredViewMode(storage) : DEFAULT_PHONE_VIEW_MODE));
    const [remote, setRemote] = useState<PhoneRemoteSelection | null>(() => remoteFromPlace(enabled ? readStoredPlace(placeStorage) : null));
    // Nothing remembered means the phone has never been anywhere, or was last put down on the
    // landing page: either way the host list is the first screen (`phone/place.ts`, rule 1).
    const [landing, setLanding] = useState<boolean>(() => (enabled ? readStoredPlace(placeStorage) === null : false));

    // A desktop that becomes a phone (the audit's emulation, a tablet losing its mouse) reads the
    // remembered mode and place on that edge; a phone that becomes a desktop drops its remote
    // selection, because the desktop tree has its own.
    const first = useRef(true);
    useEffect(() => {
        if (first.current) {
            first.current = false;
            return;
        }
        if (enabled) {
            setModeState(readStoredViewMode(storage));
            const place = readStoredPlace(placeStorage);
            setRemote(remoteFromPlace(place));
            setLanding(place === null);
        } else {
            setRemote(null);
            setLanding(false);
        }
        // `storage` and `placeStorage` are stable handles; the edge is `enabled`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);

    /*
     * The place, written whenever a workspace is on screen and cleared when the landing page is.
     *
     * Guarded on `enabled`: a DESKTOP window must not touch the phone's storage at all, which is
     * the same rule the mode has and the same rule `PhoneKeyBar` has about the content row.
     */
    useEffect(() => {
        if (!enabled) return;
        if (landing) {
            writeStoredPlace(null, placeStorage);
            return;
        }
        const workspaceID = remote?.workspaceID ?? originWorkspaceID;
        // Nothing to remember yet (the origin has no workspace, or the snapshot has not landed):
        // leave whatever is stored alone rather than forgetting a good place on a reconnect.
        if (workspaceID === null || workspaceID.length === 0) return;
        writeStoredPlace({ host: remote?.host ?? ORIGIN_HOST_KEY, workspaceID }, placeStorage);
    }, [enabled, landing, remote, originWorkspaceID, placeStorage]);

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

    const showLanding = useCallback((): void => setLanding(true), []);
    const openWorkspace = useCallback((): void => setLanding(false), []);

    const shownPaneID = useMemo(() => resolveShownPane(focusedPaneID, paneOrder), [focusedPaneID, paneOrder]);

    return useMemo(
        () => ({
            mode,
            screen: landing ? ('landing' as const) : mode,
            atLanding: landing,
            shownPaneID,
            remote,
            setMode,
            toggleMode,
            selectRemote: setRemote,
            showLanding,
            openWorkspace
        }),
        [mode, landing, shownPaneID, remote, setMode, toggleMode, showLanding, openWorkspace]
    );
}

/**
 * The remote selection a remembered place implies. The ORIGIN's place carries no selection: the
 * origin's workspace is the daemon's active one, restored by showing it rather than by asking for
 * it (`phone/place.ts`, rule 2).
 */
function remoteFromPlace(place: PhonePlace | null): PhoneRemoteSelection | null {
    if (place === null || place.host === ORIGIN_HOST_KEY || place.workspaceID.length === 0) return null;
    return { host: place.host, workspaceID: place.workspaceID };
}
