/**
 * The shell's own tiny settings file, and the quit policy derived from it.
 *
 * Split out of `./quit.ts` so the policy is testable: `quit.ts` imports `electron`, which
 * cannot resolve outside an Electron process, and this is the half that has no business
 * needing one anyway.
 *
 * **`confirmQuitWhenActive` is no longer owned here** (§AGNT-117). It used to live in this file
 * because the daemon settings store did not exist; it does now, so the flag is a config-file key
 * (`confirm-quit-when-active`) that the daemon serves to every client — including this process,
 * which reads it off its own status socket's `welcome.settings`. That is what lets the ⌘Q
 * dialog's "Don't ask again" checkbox and Settings ▸ Workspaces' toggle be the same switch
 * instead of two that silently disagree.
 *
 * The local field survives for exactly one purpose: **migrating an existing install once**. A
 * user who ticked "Don't ask again" before the move has `confirmQuitWhenActive: false` in this
 * file, and losing that would be a regression they experience as the dialog coming back from
 * the dead. `pendingQuitConfirmationMigration` answers "is there something to push into the
 * daemon?", and `markQuitConfirmationMigrated` makes it a one-shot.
 */

import fs from 'node:fs';
import path from 'node:path';

import { activitySummary, quitConfirmDetail, type AgentCounts } from './agents.js';

export const SETTINGS_FILE = 'shell-settings.json';

export interface ShellSettings {
    /**
     * LEGACY (§AGNT-117): the pre-move value of what is now the daemon's
     * `confirm-quit-when-active`. Read only by the one-shot migration below; the live policy
     * comes from the daemon settings snapshot.
     */
    readonly confirmQuitWhenActive: boolean;
    /** True once the value above has been pushed into the daemon settings (or found default). */
    readonly quitConfirmationMigrated: boolean;
    /**
     * Has the user been offered the `/usr/local/bin/nex` install once? (`./cli-install.ts`)
     * Asking twice about the same thing is nagging; asking never means a fresh install has no
     * CLI and therefore no hooks.
     */
    readonly cliInstallPrompted: boolean;
    /**
     * App version whose "CLI is out of date" notification has already been shown — the port of
     * the Swift `cliInstallHealNotifiedVersion` default (APP-005). Empty = never shown.
     */
    readonly cliInstallNotifiedVersion: string;
}

export const DEFAULT_SHELL_SETTINGS: ShellSettings = {
    confirmQuitWhenActive: true,
    quitConfirmationMigrated: false,
    cliInstallPrompted: false,
    cliInstallNotifiedVersion: ''
};

export function settingsFile(userDataDir: string): string {
    return path.join(userDataDir, SETTINGS_FILE);
}

/** A missing / corrupt file means "defaults", never an error. */
export function readShellSettings(file: string): ShellSettings {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SHELL_SETTINGS;
        const source = parsed as Record<string, unknown>;
        const notified = source['cliInstallNotifiedVersion'];
        return {
            // Absent (or any non-`false` value) = true, matching the UserDefaults semantics.
            confirmQuitWhenActive: source['confirmQuitWhenActive'] !== false,
            // Opt-IN like the CLI keys: a file written before the move has no such key, which is
            // exactly the "not migrated yet" state.
            quitConfirmationMigrated: source['quitConfirmationMigrated'] === true,
            // The CLI keys are opt-IN, so absent = false / never shown.
            cliInstallPrompted: source['cliInstallPrompted'] === true,
            cliInstallNotifiedVersion: typeof notified === 'string' ? notified : ''
        };
    } catch {
        return DEFAULT_SHELL_SETTINGS;
    }
}

export function writeShellSettings(file: string, settings: ShellSettings): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    } catch {
        // A settings file we cannot write costs the suppression, not the quit.
    }
}

/**
 * Does this quit need a dialog?
 *
 * The Swift app asked unconditionally because quitting killed sessions. Here it only asks
 * when something is actually running, and the dialog says the opposite thing — see
 * `quitConfirmDetail`.
 *
 * The flag now arrives from the DAEMON settings snapshot (§AGNT-117); the shape is still a
 * one-field object so the policy cannot accidentally depend on anything else.
 */
export function shouldConfirmQuit(
    settings: Pick<ShellSettings, 'confirmQuitWhenActive'>,
    counts: AgentCounts
): boolean {
    return settings.confirmQuitWhenActive && activitySummary(counts).agents > 0;
}

/**
 * §AGNT-117's one-shot migration: is there a locally suppressed quit dialog that the daemon has
 * not been told about?
 *
 * Only a `false` is worth migrating — `true` is the default on both sides, so pushing it would
 * write a redundant config line into every existing user's file. The caller marks the migration
 * done either way (see below), so a default install pays one file write and never looks again.
 */
export function pendingQuitConfirmationMigration(settings: ShellSettings): boolean {
    return !settings.quitConfirmationMigrated && settings.confirmQuitWhenActive === false;
}

/** Record that the migration ran, so a later daemon-side re-enable is not undone next launch. */
export function markQuitConfirmationMigrated(file: string, settings: ShellSettings): ShellSettings {
    const next: ShellSettings = { ...settings, quitConfirmationMigrated: true };
    writeShellSettings(file, next);
    return next;
}

export interface QuitDialogSpec {
    readonly type: 'question';
    readonly message: string;
    readonly detail: string;
    readonly buttons: readonly string[];
    /** Cancel — ⌘Q is the accidental keystroke being guarded (§10 step 4). */
    readonly defaultId: number;
    readonly cancelId: number;
    readonly checkboxLabel: string;
    readonly checkboxChecked: boolean;
}

export function quitDialogSpec(counts: AgentCounts): QuitDialogSpec {
    return {
        type: 'question',
        message: 'Quit Nex?',
        detail: quitConfirmDetail(counts),
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        checkboxLabel: "Don't ask again",
        checkboxChecked: false
    };
}
