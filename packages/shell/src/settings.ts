/**
 * The shell's own tiny settings file, and the quit policy derived from it.
 *
 * Split out of `./quit.ts` so the policy is testable: `quit.ts` imports `electron`, which
 * cannot resolve outside an Electron process, and this is the half that has no business
 * needing one anyway.
 *
 * `confirmQuitWhenActive` is the same setting name the Swift app used (agent-lifecycle.md
 * §10 step 2, absent = true). It lives here rather than in the daemon's settings store only
 * because that store does not exist yet — PLAN M8 moves it, at which point Settings UI and
 * this dialog can share one value across every client.
 */

import fs from 'node:fs';
import path from 'node:path';

import { activitySummary, quitConfirmDetail, type AgentCounts } from './agents.js';

export const SETTINGS_FILE = 'shell-settings.json';

export interface ShellSettings {
    readonly confirmQuitWhenActive: boolean;
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
 */
export function shouldConfirmQuit(
    // Only the one field: the file also carries CLI-install state that has nothing to do with
    // quitting, and a policy that cannot see it cannot accidentally depend on it.
    settings: Pick<ShellSettings, 'confirmQuitWhenActive'>,
    counts: AgentCounts
): boolean {
    return settings.confirmQuitWhenActive && activitySummary(counts).agents > 0;
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
