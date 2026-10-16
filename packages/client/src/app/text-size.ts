/**
 * What ⌘= / ⌘- / ⌘0 and the View menu's three text-size rows both do (#175).
 *
 * A module rather than three lines inside `App.tsx` for one reason: there are TWO routes to this
 * behaviour and they must be one gesture. The chord arrives through the window dispatcher, which
 * applies §7.2's gates on the way; the menu row arrives as a `menu-command` over the daemon
 * socket, which applies none of them. A guard written only into the dispatcher is therefore a
 * guard the menu row walks straight past, which is exactly the defect this file exists to hold
 * closed: with an embedded remote workspace filling the pane area, the row would have resized the
 * LOCAL daemon's terminals while the person was looking at a remote pane.
 *
 * Three rules, in order.
 *
 * 1. **A remote workspace's size is its own daemon's (#267).** §1.7: the window's local pane
 *    keymap stands down while `RemoteWorkspaceView` fills the pane area, and this window's
 *    settings surface holds the PRIMARY daemon's snapshot. So with a remote workspace selected,
 *    neither the local preview, the local pane nor the local daemon is touched: the step goes to
 *    {@link stepRemoteTextSize}, against the remote daemon's own runtime, its own focused pane and
 *    its own `font-size-scope`. The remote pane's chord reaches the same function through its own
 *    seam (`app/terminal-shortcuts.tsx`), so the chord and the menu row are still one gesture.
 *
 * 2. **The more specific surface wins.** A focused markdown PREVIEW has had its own font size on
 *    these chords since §3.16. So the preview is offered the press first and the terminal size
 *    takes what it declines - the same shape `toggle_search` uses to route ⌘F between a content
 *    pane's find bar and the terminal's scrollback search. This is also what keeps a markdown
 *    pane's behaviour byte-identical through #175's move of the three chords from the
 *    `*_markdown_font_size` actions to these.
 *
 * 3. **`font-size-scope` picks which terminal size.** `pane` (the default) steps the focused
 *    terminal pane's OWN size and leaves every other pane alone, which is how the Swift app's
 *    libghostty surfaces behaved; `all` steps the daemon-wide ghostty `font-size`, #175's
 *    original shape. Under `pane`, a focused pane that is not a terminal declines, so the chord
 *    falls through rather than resizing everything behind the person's back.
 *
 * Returning false means "my condition did not hold": the chord falls through untouched (§7.2
 * step 7) and the menu row does nothing. Nothing here raises a toast, including at the slider's
 * own minimum and maximum, where the settings surface's unchanged-commit rule writes nothing.
 */

import { isUsingExternalEditor, type Pane } from '@kelpi/core/layout';
import { PANE_FONT_SIZE_MAX, PANE_FONT_SIZE_MIN } from '@kelpi/protocol';

import { isOkReply, replyError, type CommandReply } from '../connection';
import type { FontSizeStep } from '../content';
import { steppedSettingsValue } from '../settings/contract';
import {
    SETTINGS_TERMINAL_FONT_SIZE_DEFAULT,
    SETTINGS_TERMINAL_FONT_SIZE_FIELD_ID,
    describeSettingsField,
    settingsFieldDefinition
} from '../settings/sections';
import type { KelpiRuntime, KelpiState } from '../state';

export interface TextSizeStepDeps {
    /** §1.7 - an embedded remote daemon's workspace is what fills the pane area right now. */
    readonly remoteWorkspaceSelected: () => boolean;
    /** That remote workspace's own step (#267); false when there is nothing there to step. */
    readonly remoteStep: (step: FontSizeStep) => boolean;
    /** The focused markdown preview's own font size; false when the focused pane is not one. */
    readonly previewStep: (step: FontSizeStep) => boolean;
    /** `font-size-scope`, read at press time. */
    readonly scope: () => 'pane' | 'all';
    /** The focused terminal pane's own size; false when the focused pane is not a terminal. */
    readonly paneStep: (step: FontSizeStep) => boolean;
    /** The daemon-wide terminal size, through the settings surface's one write path. */
    readonly daemonStep: (step: FontSizeStep) => boolean;
}

export function createTextSizeStep(deps: TextSizeStepDeps): (step: FontSizeStep) => boolean {
    return (step: FontSizeStep): boolean => {
        if (deps.remoteWorkspaceSelected()) return deps.remoteStep(step);
        if (deps.previewStep(step)) return true;
        return deps.scope() === 'pane' ? deps.paneStep(step) : deps.daemonStep(step);
    };
}

export interface PaneTextSizeDeps {
    /**
     * The pane's own size (null = it follows the default), or undefined when the pane is gone or
     * does not render a terminal.
     */
    readonly ownSize: (paneID: string) => number | null | undefined;
    /** The size a pane with none of its own is drawn at: the ghostty `font-size`, or 13. */
    readonly defaultSize: () => number;
    /** `pane-font-size`; null drops the pane's own size. Settles when the daemon has answered. */
    readonly send: (paneID: string, size: number | null) => Promise<unknown>;
}

/**
 * ⌘= / ⌘- / ⌘0 on ONE terminal pane: the size it is drawn at, one point up or down, clamped to
 * the Font size row's 8-32; ⌘0 drops its own size.
 *
 * A step that lands back on the default stores null rather than the number, so a pane zoomed in
 * and back out follows the Font size row again instead of pinning today's value.
 *
 * A held-down chord repeats faster than the daemon answers, so each press starts from the size
 * this window last ASKED for while any earlier ask for that pane is still in flight, not from
 * the store's newest broadcast; otherwise the repeats would each re-send the first step (the
 * same reason the daemon-wide path goes through the settings surface's `pendingValue`). A step
 * that changes nothing (already at 32, already following the default) is consumed with nothing
 * sent, as the settings surface does at the slider's ends.
 */
export function createPaneTextSizeStep(deps: PaneTextSizeDeps): (paneID: string, step: FontSizeStep) => boolean {
    const pending = new Map<string, { size: number | null; inFlight: number }>();
    return (paneID: string, step: FontSizeStep): boolean => {
        const stored = deps.ownSize(paneID);
        if (stored === undefined) return false;
        const asked = pending.get(paneID);
        const current = asked === undefined ? stored : asked.size;
        const fallback = deps.defaultSize();
        let next: number | null = null;
        if (step !== 'reset') {
            const from = current ?? fallback;
            const stepped = Math.max(PANE_FONT_SIZE_MIN, Math.min(PANE_FONT_SIZE_MAX, from + (step === 'increase' ? 1 : -1)));
            next = stepped === fallback ? null : stepped;
        }
        if (next === current) return true;
        const entry = { size: next, inFlight: (asked?.inFlight ?? 0) + 1 };
        pending.set(paneID, entry);
        const settle = (): void => {
            const now = pending.get(paneID);
            if (now === undefined) return;
            if (now.inFlight <= 1) pending.delete(paneID);
            else pending.set(paneID, { size: now.size, inFlight: now.inFlight - 1 });
        };
        void deps.send(paneID, next).then(settle, settle);
        return true;
    };
}

// ── a remote daemon's terminals (#267) ───────────────────────────────────────────────

export interface DaemonTextSizeDeps {
    /** The daemon's ghostty `font-size` as its last broadcast says, or null when it sets none. */
    readonly stored: () => number | null;
    /** The Font size row's own stepping (`steppedSettingsValue`): `from` moved by `steps`. */
    readonly stepped: (from: number, steps: number) => number;
    /** The row's default, which ⌘0 writes and an absent key reads as. */
    readonly fallback: () => number;
    /** `set-ghostty-setting font-size`. Settles when the daemon has answered. */
    readonly send: (size: number) => Promise<unknown>;
}

/**
 * ⌘= / ⌘- / ⌘0 on a daemon's ghostty `font-size`, for a daemon this window has no settings surface
 * for (a paired remote). The Appearance tab's Font size row decides the arithmetic, through the
 * same `steppedSettingsValue` the primary daemon's `stepField` uses: clamped to the row's bounds
 * and snapped to its grid, so a hand-written `font-size = 13.5` steps to 15 on either path. ⌘0
 * writes the row's default.
 *
 * A held chord repeats faster than the daemon answers, so each press starts from the size last
 * ASKED for while a write is in flight, as `createPaneTextSizeStep` does for a pane and the
 * settings surface's `stepField` does for the primary daemon. A step that changes nothing is
 * consumed with nothing sent.
 */
export function createDaemonTextSizeStep(deps: DaemonTextSizeDeps): (step: FontSizeStep) => boolean {
    let pending: { size: number; inFlight: number } | null = null;
    return (step: FontSizeStep): boolean => {
        const current = pending?.size ?? deps.stored() ?? deps.fallback();
        const next = step === 'reset' ? deps.fallback() : deps.stepped(current, step === 'increase' ? 1 : -1);
        if (next === current) return true;
        pending = { size: next, inFlight: (pending?.inFlight ?? 0) + 1 };
        const settle = (): void => {
            if (pending === null) return;
            pending = pending.inFlight <= 1 ? null : { size: pending.size, inFlight: pending.inFlight - 1 };
        };
        void deps.send(next).then(settle, settle);
        return true;
    };
}

/** Where a failed remote write is reported: the host's toast, titled for the person. */
export type TextSizeReport = (title: string, message: string) => void;

interface RemoteTextSize {
    readonly pane: (paneID: string, step: FontSizeStep) => boolean;
    readonly daemon: (step: FontSizeStep) => boolean;
    report: TextSizeReport | null;
}

const REMOTE_TEXT_SIZE = new WeakMap<KelpiRuntime, RemoteTextSize>();

function ownedPane(runtime: KelpiRuntime, paneID: string): Pane | undefined {
    return runtime.store
        .getState()
        .daemon.state.workspaces.flatMap((workspace) => workspace.panes)
        .find((pane) => pane.id === paneID);
}

function isTerminalPane(pane: Pane | undefined): pane is Pane {
    return pane !== undefined && (pane.type === 'shell' || isUsingExternalEditor(pane));
}

/**
 * The size a remote daemon's terminal pane with no size of its own is drawn at: that daemon's
 * ghostty `font-size`, which is what every other viewer of the same PTY draws (§7.6). The
 * remote render sites (`RemoteWorkspaceView`, `PhoneRemoteWorkspace`) and the stepper below read
 * the same answer, so a step starts from the size on screen.
 */
export function remoteDefaultFontSize(state: KelpiState): number {
    return state.settings.value.appearance.fontSize ?? SETTINGS_TERMINAL_FONT_SIZE_DEFAULT;
}

/** The Font size row as this daemon's settings describe it, for its bounds, grid and default. */
function fontSizeField(runtime: KelpiRuntime) {
    const definition = settingsFieldDefinition(SETTINGS_TERMINAL_FONT_SIZE_FIELD_ID);
    const descriptor = definition === undefined ? undefined : describeSettingsField(definition, runtime.store.getState().settings.value);
    return descriptor !== undefined && descriptor.kind === 'slider' ? descriptor : null;
}

/** Sends a remote write and reports a refusal or a rejection through the reporter of ITS press. */
async function sendReported(task: () => Promise<CommandReply>, report: TextSizeReport | null): Promise<void> {
    try {
        const reply = await task();
        if (!isOkReply(reply)) report?.('Text size', replyError(reply));
    } catch (error) {
        report?.('Text size', error instanceof Error ? error.message : String(error));
    }
}

function remoteTextSize(runtime: KelpiRuntime): RemoteTextSize {
    const cached = REMOTE_TEXT_SIZE.get(runtime);
    if (cached !== undefined) return cached;
    const entry: RemoteTextSize = {
        report: null,
        pane: createPaneTextSizeStep({
            ownSize: (paneID) => {
                const pane = ownedPane(runtime, paneID);
                if (!isTerminalPane(pane)) return undefined;
                return pane.terminalFontSize ?? null;
            },
            defaultSize: () => remoteDefaultFontSize(runtime.store.getState()),
            // The reporter is read when the write is SENT, so a later press by the other route
            // cannot take over where this one's failure is reported.
            send: (paneID, size) => sendReported(() => runtime.commands.setPaneFontSize({ paneID, size }), entry.report)
        }),
        daemon: createDaemonTextSizeStep({
            stored: () => runtime.store.getState().settings.value.appearance.fontSize ?? null,
            stepped: (from, steps) => {
                const field = fontSizeField(runtime);
                return field === null
                    ? Math.max(PANE_FONT_SIZE_MIN, Math.min(PANE_FONT_SIZE_MAX, Math.round(from) + steps))
                    : steppedSettingsValue(field, from, steps);
            },
            fallback: () => {
                const fallback = fontSizeField(runtime)?.default;
                return typeof fallback === 'number' ? fallback : SETTINGS_TERMINAL_FONT_SIZE_DEFAULT;
            },
            send: (size) => sendReported(() => runtime.commands.setGhosttySetting({ key: 'font-size', value: size }), entry.report)
        })
    };
    // Never disposed: one small record per paired daemon, collected with its runtime.
    REMOTE_TEXT_SIZE.set(runtime, entry);
    return entry;
}

/**
 * ⌘= / ⌘- / ⌘0 on a REMOTE daemon's terminal pane (#267), from either route: the pane's own chord
 * seam or the View menu row while that daemon's workspace is selected.
 *
 * The remote daemon's own `font-size-scope` decides, because the size being changed is that
 * daemon's: `pane` steps the pane's own size there (`pane-font-size`), `all` writes that daemon's
 * ghostty `font-size`, which is what "All panes" means and what #175 scoped a kelpi-to-kelpi
 * session to drive. An older daemon that sends no scope hydrates to `all`, as on the primary.
 *
 * Declines (returns false) while that daemon's settings have not arrived, and for a focused pane
 * that is not a terminal under either scope, so the menu row and the chord (which only a terminal
 * pane carries) can never disagree. Bookkeeping is per runtime, shared by both routes, so a held
 * chord composes however it arrives.
 */
export function stepRemoteTextSize(runtime: KelpiRuntime, paneID: string, step: FontSizeStep, report: TextSizeReport): boolean {
    const settings = runtime.store.getState().settings;
    if (!settings.loaded) return false;
    if (!isTerminalPane(ownedPane(runtime, paneID))) return false;
    const entry = remoteTextSize(runtime);
    entry.report = report;
    return settings.value.general.fontSizeScope === 'pane' ? entry.pane(paneID, step) : entry.daemon(step);
}

/**
 * The pane a remote workspace's focus ring is on, exactly as `RemoteWorkspaceView` draws it: this
 * window's focus echo for that workspace when there is one, else the workspace's focused pane.
 */
export function remoteFocusedPaneID(runtime: KelpiRuntime, workspaceID: string): string | null {
    const state = runtime.store.getState();
    const workspace = state.daemon.state.workspaces.find((entry) => entry.id === workspaceID);
    if (workspace === undefined) return null;
    const echo = state.ui.focusEcho;
    return echo !== null && echo.workspaceID === workspaceID ? echo.paneID : workspace.focusedPaneID;
}

export interface RemoteMenuStepDeps {
    /** The remote workspace the window is showing, or null. */
    readonly selection: () => { readonly workspaceID: string } | null;
    /** The paired daemon behind it, or null when it is gone (a stale selection). */
    readonly remote: () => { readonly name: string; readonly runtime: KelpiRuntime } | null;
    /** The window's failure toast. */
    readonly report: TextSizeReport;
}

/**
 * The View menu row's half of #267: while a paired daemon's workspace is selected, step the pane
 * its focus ring is on, against that daemon, exactly as that pane's own chord does. A failure is
 * reported with the daemon's name, since the row was clicked in a window showing two daemons.
 */
export function createRemoteMenuStep(deps: RemoteMenuStepDeps): (step: FontSizeStep) => boolean {
    return (step: FontSizeStep): boolean => {
        const selection = deps.selection();
        const remote = deps.remote();
        if (selection === null || remote === null) return false;
        const paneID = remoteFocusedPaneID(remote.runtime, selection.workspaceID);
        if (paneID === null) return false;
        return stepRemoteTextSize(remote.runtime, paneID, step, (title, message) => deps.report(title, `${remote.name}: ${message}`));
    };
}
