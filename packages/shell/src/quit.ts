/**
 * The quit gate (docs/current/agent-lifecycle.md §10, re-derived for the daemon architecture).
 *
 * The Swift gate existed because quitting the app KILLED every agent: it flushed pending
 * autosaves, stopped graft sessions, and then warned that "Quitting will terminate all
 * sessions". None of that is true any more, and the difference is the whole point of the port:
 *
 *   - **The shell never stops the daemon.** Closing the window, ⌘Q, `app.quit()`, a SIGTERM —
 *     none of them signal `nexd`. PTYs, agents and terminal state keep running, and the next
 *     launch (or a browser on the tailnet) attaches to exactly the sessions that were there.
 *   - **No flush.** The daemon owns persistence, including the debounced editor autosaves the
 *     old step 1 had to force out, so there is nothing for the shell to drain before exiting.
 *
 * What survives is the accident guard: ⌘Q is one keystroke from ⌘W, so quitting while agents
 * are active asks first — with **Cancel as the default button** (§10 step 4: the safe option
 * wins the Return key) and a "Don't ask again" checkbox honoured whichever button was clicked.
 * With nothing active there is nothing to warn about, so the dialog is skipped entirely.
 *
 * The policy and the settings file are `./settings.ts`; this module is only the Electron wiring.
 */

import { app, dialog, type BrowserWindow } from 'electron';

import { activitySummary, type AgentCounts } from './agents.js';
import { log } from './log.js';
import {
    promptForQuit,
    quitGateDismissScript,
    quitGateOpenScript,
    quitGateProbeScript,
    type QuitPromptRenderer,
    type QuitVerdict
} from './quit-prompt.js';
import {
    quitDialogSpec,
    readShellSettings,
    shouldConfirmQuit,
    writeShellSettings,
    type QuitDialogSpec
} from './settings.js';

export {
    QUIT_GATE_GLOBAL,
    QUIT_GATE_PROBE_TIMEOUT_MS,
    QUIT_GATE_VERDICT_TIMEOUT_MS,
    QUIT_GATE_VERSION,
    normalizeQuitVerdict,
    promptForQuit,
    quitGateDismissScript,
    quitGateOpenScript,
    quitGateProbeScript,
    type QuitPromptDeps,
    type QuitPromptOutcome,
    type QuitPromptRenderer,
    type QuitVerdict
} from './quit-prompt.js';

export {
    DEFAULT_SHELL_SETTINGS,
    SETTINGS_FILE,
    markQuitConfirmationMigrated,
    pendingQuitConfirmationMigration,
    quitDialogSpec,
    readShellSettings,
    settingsFile,
    shouldConfirmQuit,
    writeShellSettings,
    type QuitDialogSpec,
    type ShellSettings
} from './settings.js';

export interface QuitGateOptions {
    /** Live agent counts — the status connection's model (`./status.ts`). */
    readonly counts: () => AgentCounts;
    readonly settingsPath: string;
    /** Parent for the modal sheet; null shows an app-modal dialog. */
    readonly window?: (() => BrowserWindow | null) | undefined;
    /** Runs after the user confirms, before the app exits — tray teardown, socket close. */
    readonly onQuit?: (() => void) | undefined;
    /**
     * §AGNT-117: the DAEMON's `confirm-quit-when-active`, or null when the daemon has not said
     * (no connection yet, or an older daemon). Null falls back to the local legacy value, so a
     * quit taken before the status socket is up still honours a user's suppression.
     */
    readonly confirmWhenActive?: (() => boolean | null) | undefined;
    /**
     * Write the suppression back through the daemon, so Settings ▸ Workspaces and this dialog
     * are one switch. Absent (or a failed send) falls back to the local file, which keeps ⌘Q
     * working against a daemon that is already gone.
     */
    readonly suppress?: ((value: boolean) => boolean) | undefined;
    /**
     * §AGNT-114 step 1: force out pending markdown/scratchpad autosaves before the dialog.
     *
     * The daemon holds the buffers and outlives the shell, so this is not the Swift
     * "or the edits die" flush — it is the "the file on disk matches what you typed *before*
     * you are asked a question about quitting" flush. Bounded by `flushTimeoutMs`: a quit that
     * hangs waiting on a flush would be worse than one that loses the last 500 ms of typing.
     */
    readonly flushPendingSaves?: (() => Promise<void>) | undefined;
    readonly flushTimeoutMs?: number | undefined;
    /**
     * §AGNT-116: overrides for the renderer route's two budgets (`./quit-prompt.ts` explains why
     * there are two). Production leaves them alone; the smoke shortens the verdict one so a
     * dialog nobody is there to click still ends in a native fallback rather than a hang.
     */
    readonly quitPromptTimeouts?: { readonly probeMs?: number; readonly verdictMs?: number } | undefined;
}

/** Long enough for a synchronous daemon-side write and its round trip; short enough to feel instant. */
export const QUIT_FLUSH_TIMEOUT_MS = 750;

export interface QuitGate {
    /** Menu/tray "Quit Nex". */
    requestQuit(): void;
    /** True while the confirmation is on screen (a second ⌘Q must not stack a dialog). */
    readonly confirming: boolean;
    dispose(): void;
}

/**
 * Intercepts every termination path (⌘Q, the app menu, the tray, a signal) via `before-quit`.
 * Window closes are NOT a termination path: `./main.ts` keeps the app alive in the dock on
 * macOS, and the daemon is untouched either way.
 */
export function installQuitGate(options: QuitGateOptions): QuitGate {
    let settings = readShellSettings(options.settingsPath);
    let confirming = false;
    let confirmed = false;
    const flushTimeoutMs = options.flushTimeoutMs ?? QUIT_FLUSH_TIMEOUT_MS;

    /**
     * The live policy: the daemon's value when it has one, the legacy local file otherwise.
     *
     * The fallback is not decoration — a ⌘Q while the daemon is unreachable must still honour a
     * suppression the user set, and an unreachable daemon is exactly when the shell has no
     * snapshot to read.
     */
    const policy = (): { confirmQuitWhenActive: boolean } => {
        const daemonValue = options.confirmWhenActive?.() ?? null;
        return { confirmQuitWhenActive: daemonValue ?? settings.confirmQuitWhenActive };
    };

    /** Persist the suppression: through the daemon when possible, locally when not. */
    const suppress = (): void => {
        // Local first and always: it is the fallback the policy above reads when the daemon is
        // unreachable, and writing it costs one small file.
        if (settings.confirmQuitWhenActive || !settings.quitConfirmationMigrated) {
            // Spread, not replace: the same file carries the CLI-install state
            // (`./cli-install.ts`), and suppressing the quit dialog must not reset it.
            settings = { ...settings, confirmQuitWhenActive: false, quitConfirmationMigrated: true };
            writeShellSettings(options.settingsPath, settings);
        }
        const sent = options.suppress?.(false) ?? false;
        log(sent ? 'quit: suppression written to the daemon settings' : 'quit: suppression saved locally (daemon unreachable)');
    };

    /** §AGNT-114 step 1, bounded: never let a flush hold the app hostage. */
    const flush = async (): Promise<void> => {
        const run = options.flushPendingSaves;
        if (run === undefined) return;
        await Promise.race([
            run().catch(() => undefined),
            new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, flushTimeoutMs);
                timer.unref?.();
            })
        ]);
    };

    const proceed = (): void => {
        confirmed = true;
        options.onQuit?.();
        // Deliberately absent, here and everywhere else: anything that stops the daemon.
        log('quit: leaving the daemon running');
        app.quit();
    };

    const onBeforeQuit = (event: Electron.Event): void => {
        if (confirmed) return;
        if (confirming) {
            event.preventDefault();
            return;
        }

        // §AGNT-114: every termination path is intercepted, and the pre-flight runs on ALL of
        // them — including the one that will not show a dialog. The Swift order is flush, then
        // ask; doing it only on the asking path would mean a quit with nothing running silently
        // skipped the flush, which is the case where the user is least likely to notice a lost
        // half-second of typing.
        event.preventDefault();
        confirming = true;
        void flush()
            .then(() => {
                confirming = false;
                const counts = options.counts();
                if (!shouldConfirmQuit(policy(), counts)) {
                    proceed();
                    return;
                }
                ask(counts);
            })
            .catch(() => {
                confirming = false;
                proceed();
            });
    };

    /**
     * §AGNT-116: the native dialog — the fallback, and the only dialog before the hybrid.
     *
     * Unchanged: `defaultId`/`cancelId` both point at Cancel, and a null (or destroyed) parent
     * gives an app-modal box, which is what makes a tray/signal quit with no window still ask.
     */
    const askNatively = async (spec: QuitDialogSpec): Promise<QuitVerdict> => {
        const parent = options.window?.() ?? null;
        const request = { ...spec, buttons: [...spec.buttons] };
        const result =
            parent === null || parent.isDestroyed()
                ? await dialog.showMessageBox(request)
                : await dialog.showMessageBox(parent, request);
        return { response: result.response, checkboxChecked: result.checkboxChecked };
    };

    /**
     * §AGNT-116: the renderer route, or null when there is nothing on screen to route to.
     *
     * "Live renderer" is deliberately strict — a window the user cannot SEE is not somewhere to
     * put a modal question. Hidden, minimised, destroyed, crashed or still loading all mean the
     * native dialog, which appears regardless.
     */
    const rendererTarget = (): QuitPromptRenderer | null => {
        const window = options.window?.() ?? null;
        if (window === null || window.isDestroyed()) return null;
        if (!window.isVisible() || window.isMinimized()) return null;
        const contents = window.webContents;
        if (contents.isDestroyed() || contents.isCrashed() || contents.isLoading()) return null;
        return {
            probe: async () => (await contents.executeJavaScript(quitGateProbeScript(), false)) === true,
            ask: async (spec) => await contents.executeJavaScript(quitGateOpenScript(spec), false),
            dismiss: () => {
                void contents.executeJavaScript(quitGateDismissScript(), false).catch(() => undefined);
            }
        };
    };

    const ask = (counts: AgentCounts): void => {
        confirming = true;
        const summary = activitySummary(counts);
        log(
            `quit held: ${String(summary.agents)} active agent(s) across ${String(summary.workspaces)} workspace(s); asking first`
        );
        const spec = quitDialogSpec(counts);

        void promptForQuit(spec, {
            renderer: rendererTarget(),
            native: askNatively,
            log: (message) => log(message),
            ...(options.quitPromptTimeouts?.probeMs === undefined
                ? {}
                : { probeTimeoutMs: options.quitPromptTimeouts.probeMs }),
            ...(options.quitPromptTimeouts?.verdictMs === undefined
                ? {}
                : { verdictTimeoutMs: options.quitPromptTimeouts.verdictMs })
        })
            .then((result) => {
                confirming = false;
                // §10 step 4: honour the suppression checkbox even on Cancel.
                if (result.checkboxChecked && policy().confirmQuitWhenActive) suppress();
                if (result.response === 0) proceed();
                else log(`quit cancelled (${result.route} dialog)`);
            })
            .catch(() => {
                // A dialog that could not be shown must not wedge the app in "confirming".
                confirming = false;
            });
    };

    app.on('before-quit', onBeforeQuit);

    return {
        requestQuit(): void {
            app.quit();
        },
        get confirming(): boolean {
            return confirming;
        },
        dispose(): void {
            app.removeListener('before-quit', onBeforeQuit);
        }
    };
}
