/**
 * The window's interaction state, as the SELECTED presenter for one placement sees it.
 *
 * A view that declares `interaction.palette` or `interaction.prompts` can be chosen as that
 * placement's presenter in Settings, Plugins, Workbench views. Both placements appear in
 * `ui.getWorkbench().slots` for discovery, but `ui.selectView` REFUSES them: a prompts presenter
 * renders other plugins' requests, so the choice stays the user's and cannot be taken
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
 * Notification carve-out: notifications are also bundled in this release. A prompts presenter
 * presents modal requests only (quick pick, input, dialog); the notification stack is drawn
 * natively and `notifications` is always empty. Selectable notification presentation is a later
 * step, and the field is reserved for it.
 *
 * Plugin presenters are desktop-only in this release. A phone window keeps the bundled presenters
 * because the phone palette owns the software-keyboard inset, which a presenter cannot read.
 */
import type { UIDialogOptions, UIInputOptions, UINotificationOptions, UIQuickPickOptions } from './ui.js';

export type InteractionPlacement = 'interaction.palette' | 'interaction.prompts';

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

/** Reserved for selectable notification presentation. No frame carries one in this release. */
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
     * interaction.palette, and null for a password input, which stays bundled. */
    readonly prompt: InteractionPrompt | null;
    /** Modal requests waiting behind `prompt`, carve-outs included. Zero on interaction.palette. */
    readonly queued: number;
    /** Reserved, and ALWAYS empty in this release: the bundled stack draws notifications, as it
     * draws password inputs. A prompts presenter presents modal requests only. */
    readonly notifications: readonly InteractionNotice[];
}

/**
 * Every presenter method, on `kelpi.ui`. Each call is checked against the placement this view was
 * selected into: the palette methods belong to `interaction.palette` and `respondInteraction` to
 * `interaction.prompts`, and a call from the other placement is refused. `getInteraction`,
 * `onInteraction` and `reportPresenterReady` belong to both.
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
     * every frame carrying a new prompt or palette session must be acknowledged within 5 seconds,
     * or the placement falls back to the bundled presenter. */
    reportPresenterReady(): Promise<void>;
    setPaletteQuery(sessionID: string, text: string): Promise<void>;
    setPaletteSelection(sessionID: string, itemID: string | null): Promise<void>;
    /** Re-resolved host-side against a fresh source read; runs at most once. */
    activatePaletteItem(sessionID: string, itemID: string): Promise<void>;
    /** Dismissal only. Opening the palette stays a window gesture. */
    dismissPalette(sessionID: string): Promise<void>;
    /** Settles a currently visible request. Null cancels it. */
    respondInteraction(requestID: string, value: string | null): Promise<void>;
}
