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

import type { AgentCounts } from './agents.js';
import { log } from './log.js';
import { quitDialogSpec, readShellSettings, shouldConfirmQuit, writeShellSettings } from './settings.js';

export {
    DEFAULT_SHELL_SETTINGS,
    SETTINGS_FILE,
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
}

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
        const counts = options.counts();
        if (!shouldConfirmQuit(settings, counts)) {
            confirmed = true;
            log('quit: leaving the daemon running');
            return;
        }

        event.preventDefault();
        confirming = true;
        log(`quit held: ${String(counts.running + counts.waiting)} active agent(s); asking first`);
        const spec = quitDialogSpec(counts);
        const parent = options.window?.() ?? null;
        const request = { ...spec, buttons: [...spec.buttons] };
        const promise =
            parent === null || parent.isDestroyed()
                ? dialog.showMessageBox(request)
                : dialog.showMessageBox(parent, request);

        void promise
            .then((result) => {
                confirming = false;
                // §10 step 4: honour the suppression checkbox even on Cancel.
                if (result.checkboxChecked && settings.confirmQuitWhenActive) {
                    settings = { confirmQuitWhenActive: false };
                    writeShellSettings(options.settingsPath, settings);
                }
                if (result.response === 0) proceed();
                else log('quit cancelled');
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
