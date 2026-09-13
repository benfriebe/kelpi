/**
 * The window's interaction state, as the SELECTED presenter for one placement sees it.
 *
 * A view that declares `interaction.palette`, `interaction.prompts` or `interaction.notifications`
 * can be chosen as that placement's presenter in Settings, Plugins, Workbench views. All three
 * appear in `ui.getWorkbench().slots` for discovery, but `ui.selectView` REFUSES them: these
 * presenters render other plugins' requests, so the choice stays the user's and cannot be taken
 * programmatically.
 *
 * The bundled presenter is the recovery floor and cannot be selected away. It takes the placement
 * back for the rest of the window session when the selected presenter fails, and re-presents the
 * live request under the SAME request ID, so a failure never settles a request and never produces
 * an answer. `kelpi.window.openPalette`, `openSettings`, `openPlugins`, `openHelp` and
 * `restartUI`, the native menu and their shortcuts stay available whatever is selected.
 *
 * Password carve-out: a `ui.showInput({ password: true })` prompt is always presented by the
 * bundled presenter, whatever is selected, and never reaches a plugin presenter. The snapshot
 * reports `prompt: null` while such a request is visible, and `queued` still counts it. Native
 * destructive confirmations are carved out the same way.
 *
 * Notifications are their own placement, not a field on the prompts one: `notifications` is
 * populated on `interaction.notifications` only, and is empty on the other two. A notification is
 * not modal - it is a corner box over a window that stays usable - so the host draws that frame
 * where the bundled stack sits and the presenter declares its height with
 * `setNotificationBoxHeight`. A frame carries the notices that fit in 256 KiB and counts the rest
 * in `queued`. The expiry clock stays the host's: a notice is settled with null ten seconds after
 * it becomes visible and simply leaves the next frame, whether or not a frame carried it. Native
 * toasts (a daemon notification, a command failure) are host chrome and are never projected.
 *
 * Plugin presenters are desktop-only in this release. A phone window keeps the bundled presenters
 * because the phone palette owns the software-keyboard inset, which a presenter cannot read.
 */
import type { UIDialogOptions, UIInputOptions, UINotificationOptions, UIQuickPickOptions } from './ui.js';

export type InteractionPlacement = 'interaction.palette' | 'interaction.prompts' | 'interaction.notifications';

/** Who asked. An opaque window-local ref plus a display name; never a plugin ID. */
export interface InteractionOwnerRef {
    /** Stable for this owner for the window's life. Correlates requests, identifies nothing. */
    readonly ref: string;
    readonly displayName: string;
}

/** A palette row with every function-valued field removed; activation goes back through the host. */
export interface InteractionPaletteItem {
    readonly id: string;
    readonly kind: 'workspace' | 'pane' | 'command';
    readonly icon: string;
    readonly title: string;
    readonly subtitle: string;
    readonly workspaceID: string | null;
    readonly workspaceName: string;
    readonly paneID: string | null;
    readonly workspaceColor: string | null;
    readonly disabled?: boolean;
    readonly shortcut?: string;
}

export interface InteractionPaletteSession {
    /** Minted on open. Every session-scoped call is checked against it. */
    readonly sessionID: string;
    readonly query: string;
    readonly scope: 'all' | 'workspace' | 'pane';
    /** The whole universe; the presenter applies the matching rule itself. */
    readonly items: readonly InteractionPaletteItem[];
    readonly selectedID: string | null;
    /** The primary grid shows a secondary daemon; mirrors ChromeSnapshot.remoteWorkspaceSelected. */
    readonly remoteWorkspaceSelected: boolean;
}

export type InteractionPrompt = { readonly requestID: string; readonly owner: InteractionOwnerRef } & (
    | { readonly kind: 'quickPick'; readonly options: UIQuickPickOptions }
    | { readonly kind: 'input'; readonly options: UIInputOptions }
    | { readonly kind: 'dialog'; readonly options: UIDialogOptions }
);

/** One plugin notification, on `interaction.notifications` only. */
export interface InteractionNotice {
    readonly requestID: string;
    readonly owner: InteractionOwnerRef;
    readonly options: UINotificationOptions;
}

export interface InteractionSnapshot {
    readonly placement: InteractionPlacement;
    /** Plugin presenters are desktop-only in this release; a phone window never selects one. */
    readonly formFactor: 'desktop' | 'phone';
    /** Whether this placement is painted right now. False means present nothing. */
    readonly visible: boolean;
    /** The palette presenter only; null on interaction.prompts, and null while closed. */
    readonly palette: InteractionPaletteSession | null;
    /** Both placements: the palette outranks a queued prompt. */
    readonly paletteOpen: boolean;
    /** The prompts presenter only: a modal quick pick, input or dialog. Null on
     * interaction.palette and interaction.notifications, and null for a password input, which
     * stays bundled. */
    readonly prompt: InteractionPrompt | null;
    /** On interaction.prompts: modal requests waiting behind `prompt`, carve-outs included. On
     * interaction.notifications: visible notices this frame could not carry, because a frame is
     * bounded at 256 KiB and four maximal notices do not fit; they keep their IDs and their
     * expiry clocks and arrive in a later frame. Zero on interaction.palette. */
    readonly queued: number;
    /** The notifications presenter only: the visible notices, oldest first, at most four and as
     * many as fit in one 256 KiB frame. Empty on interaction.palette and interaction.prompts,
     * where it means "not this placement's". */
    readonly notifications: readonly InteractionNotice[];
}

/**
 * Every presenter method, on `kelpi.ui`. Each call is checked against the placement this view was
 * selected into: the palette methods belong to `interaction.palette`, `setNotificationBoxHeight` to
 * `interaction.notifications`, `respondInteraction` to whichever of `interaction.prompts` and
 * `interaction.notifications` published the request, and a call from another placement is refused.
 * `getInteraction`, `onInteraction` and `reportPresenterReady` belong to all three.
 */
export interface WindowInteractionAPI {
    getInteraction(): Promise<InteractionSnapshot>;
    /** Initial/latest snapshots with bounded acknowledged delivery, as onChrome.
     * A snapshot exceeding 256 KiB calls onError, or reports a view error if omitted. */
    onInteraction(
        listener: (value: InteractionSnapshot) => void | Promise<void>,
        onError?: (error: Error) => void | Promise<void>
    ): () => void;
    /** Confirms this presenter has painted. Required within 5 seconds of the first frame, and
     * every frame carrying a new prompt, a new palette session or a new notification must be
     * acknowledged within 5 seconds, or the placement falls back to the bundled presenter. */
    reportPresenterReady(): Promise<void>;
    setPaletteQuery(sessionID: string, text: string): Promise<void>;
    setPaletteSelection(sessionID: string, itemID: string | null): Promise<void>;
    /** Re-resolved host-side against a fresh source read; runs at most once. */
    activatePaletteItem(sessionID: string, itemID: string): Promise<void>;
    /** Dismissal only. Opening the palette stays a window gesture. */
    dismissPalette(sessionID: string): Promise<void>;
    /** Settles a currently visible request: the visible prompt, or any notice in the published
     * stack. Null cancels it - a dismissed notification answers null, as an expired one does. */
    respondInteraction(requestID: string, value: string | null): Promise<void>;
    /**
     * `interaction.notifications`: how tall this presenter's stack needs its box to be, in CSS
     * pixels. The host draws the box in the window's bottom-right corner at up to 360 px wide and
     * clamps the height to the SMALLER of 45% of the window and 200 px per visible notice; before
     * a presenter declares one it budgets 96 px per visible notice, and a stack taller than its
     * box scrolls inside it.
     *
     * The per-notice ceiling is why a declaration cannot be used to claim the corner: a presenter
     * is a plugin like any other, so it can raise its own notification every ten seconds and keep
     * the box on screen indefinitely, and a box bigger than the cards in it would be a transparent
     * rect that swallows clicks, parks the pages under it, and covers the native toast stack it
     * shares that corner with - including the toast that says a presenter has failed.
     *
     * The frame is not painted at all while `notifications` is empty, so declare nothing then: a
     * height measured in an unpainted frame is zero, and it would replace the host's default.
     * A declaration belongs to the view that made it and is dropped on a reload, a Retry or a
     * different selection.
     */
    setNotificationBoxHeight(pixels: number): Promise<void>;
}
