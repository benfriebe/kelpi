/**
 * #286: the TEST-ONLY seam that lets the UI harness drive the update flow in a development run.
 *
 * A development shell cannot update (`updater.ts` ▸ `updateSupport` refuses an unpackaged app,
 * rightly: there is no bundle for Squirrel to replace), and a real Squirrel download would replace
 * a real app. The scenario lane still has to step the flow through every state and photograph
 * each one, so under this seam:
 *
 *   - the build counts as able to update, with the repository the packaged app would name;
 *   - the feed base comes from the control file's `feed` (the scenario's local stand-in for
 *     update.electronjs.org), so the real check code reads a real HTTP reply;
 *   - `autoUpdater` is replaced by `createAuditInstaller`, which "downloads" until the control
 *     file says `download: "done"` (or `"fail:<message>"`), and whose `quitAndInstall` quits the
 *     shell WITHOUT installing anything, so the restart path (quit gate included) runs for real;
 *   - the control file's `bundlePath` stands in for where the app runs from, so the location
 *     guard's refusal can be shown.
 *
 * The gate is `KELPI_AUDIT_UPDATER` naming the control file AND an unpackaged app. A packaged app
 * ignores the variable entirely (`auditUpdaterControlPath` returns null), so no shipped launch can
 * reach this code, whatever its environment says. With the variable set but no control file, the
 * seam is dormant and the shell behaves as any development run does, which is what keeps every
 * other harness scenario unchanged.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import type { Installer } from './updater.js';

export const AUDIT_UPDATER_ENV = 'KELPI_AUDIT_UPDATER';
/** How often the stand-in installer re-reads the control file while "downloading". */
export const AUDIT_POLL_MS = 150;
/** How long `quitAndInstall` waits before quitting, so the harness can photograph "Restarting". */
export const AUDIT_QUIT_DELAY_MS = 1500;
/** The repository the seam's builds claim, the packaged app's own. */
export const AUDIT_REPO = 'benfriebe/kelpi';

export interface AuditUpdaterControl {
    /** The feed base URL (the scenario's HTTP server), used in place of update.electronjs.org. */
    readonly feed?: string;
    /** `pending` (the default) keeps "downloading"; `done` finishes; `fail:<message>` fails. */
    readonly download?: string;
    /** Where the app should appear to run from (`updater.ts` ▸ `installLocation`). */
    readonly bundlePath?: string;
}

/** The control file's path, or null when the seam is off: unset, empty, or a packaged app. */
export function auditUpdaterControlPath(env: NodeJS.ProcessEnv, isPackaged: boolean): string | null {
    if (isPackaged) return null;
    const value = env[AUDIT_UPDATER_ENV]?.trim() ?? '';
    return value === '' ? null : value;
}

/** Read the control file; null when it is missing or not a JSON object (the seam is dormant). */
export function readAuditUpdaterControl(file: string): AuditUpdaterControl | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const text = (key: string): string | undefined => {
        const value = record[key];
        return typeof value === 'string' && value !== '' ? value : undefined;
    };
    const feed = text('feed');
    const download = text('download');
    const bundlePath = text('bundlePath');
    return {
        ...(feed === undefined ? {} : { feed }),
        ...(download === undefined ? {} : { download }),
        ...(bundlePath === undefined ? {} : { bundlePath })
    };
}

export interface AuditInstallerOptions {
    readonly read: () => AuditUpdaterControl | null;
    readonly log: (line: string) => void;
    /** Quit the app (the gate is already open when this runs: `allowQuit` came first). */
    readonly quit: () => void;
    readonly pollMs?: number | undefined;
    readonly quitDelayMs?: number | undefined;
}

/** A stand-in for Electron's `autoUpdater` that downloads nothing and installs nothing. */
export function createAuditInstaller(options: AuditInstallerOptions): Installer & EventEmitter {
    const emitter = new EventEmitter();
    let poll: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
        if (poll !== null) clearInterval(poll);
        poll = null;
    };
    const installer = Object.assign(emitter, {
        setFeedURL(feed: { url: string }): void {
            options.log(`auto-update: audit installer: feed ${feed.url}`);
        },
        checkForUpdates(): void {
            stop();
            options.log('auto-update: audit installer: "downloading" until the control file says done or fail');
            setImmediate(() => {
                emitter.emit('checking-for-update');
                emitter.emit('update-available');
            });
            poll = setInterval(() => {
                const download = options.read()?.download ?? 'pending';
                if (download === 'done') {
                    stop();
                    emitter.emit('update-downloaded');
                } else if (download.startsWith('fail:')) {
                    stop();
                    emitter.emit('error', new Error(download.slice('fail:'.length).trim() || 'the audit download failed'));
                }
            }, options.pollMs ?? AUDIT_POLL_MS);
            poll.unref?.();
        },
        quitAndInstall(): void {
            const delay = options.quitDelayMs ?? AUDIT_QUIT_DELAY_MS;
            options.log(`auto-update: audit installer: quitAndInstall called; quitting in ${String(delay)} ms without installing`);
            const timer = setTimeout(() => options.quit(), delay);
            timer.unref?.();
        }
    });
    return installer;
}
