/**
 * Updates: ask first, then install (#272).
 *
 * Releases are published to GitHub (`.github/workflows/release.yml`) signed and notarized, and
 * `update.electronjs.org` serves them to Squirrel.Mac straight from GitHub Releases. Its feed
 * answers `GET /<owner>/<repo>/<platform>-<arch>/<current version>` with 204 when this version is
 * the latest, 200 and Squirrel's JSON (`name`, `notes`, `url`) when a newer release exists, and
 * 404 when it has no release to offer at all (it skips drafts and prereleases).
 *
 * Electron's own `autoUpdater` downloads the moment it finds an update, so the check here reads
 * the feed itself: nothing is downloaded until the user says **Update Now**. Only then is the
 * feed handed to `autoUpdater`, which downloads, and the app quits and relaunches into the new
 * version. **Later** does nothing; the next launch asks again.
 *
 * When it runs:
 * - at launch, only with Settings ▸ General ▸ Updates "Check for updates automatically"
 *   (`auto-update`, default off). Off, the app makes no update request at all;
 * - on demand from Kelpi ▸ Check for Updates…, whatever the setting.
 *
 * Only the packaged macOS app can install an update (a development run has no bundle for Squirrel
 * to replace). `KELPI_UPDATE_FEED` points the check at another feed (a test server).
 *
 * The daemon is not this module's concern: the relaunched app finds a daemon from the old version
 * and hands it off to a new one, keeping every terminal (`./daemon.ts`, docs/terminal-host.md).
 */

import { log, logError } from './log.js';

export const UPDATE_FEED_HOST = 'https://update.electronjs.org';
/** Overrides the feed's base URL (tests, a self-hosted feed). */
export const UPDATE_FEED_ENV = 'KELPI_UPDATE_FEED';
/** The launch check waits this long, so it never competes with the window coming up. */
export const LAUNCH_CHECK_DELAY_MS = 5000;
/** How long a feed request may take. */
export const FEED_TIMEOUT_MS = 10_000;
/** Release notes longer than this are cut in the prompt (the rest is on the release page). */
export const PROMPT_NOTES_LIMIT = 1200;

export interface UpdateHost {
    readonly isPackaged: boolean;
    readonly platform: string;
    readonly arch: string;
    /** `app.getVersion()`. */
    readonly version: string;
    /** `owner/name`, from the app's `package.json` `repository`. */
    readonly repo: string | undefined;
}

export type UpdateSupport = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Whether this build can install an update at all. */
export function updateSupport(host: UpdateHost): UpdateSupport {
    if (!host.isPackaged) return { ok: false, reason: 'This is a development build. Updates install into the packaged app only.' };
    if (host.platform !== 'darwin') return { ok: false, reason: `Updates are not supported on ${host.platform} yet.` };
    if (host.repo === undefined) return { ok: false, reason: 'This build does not name the repository its releases come from.' };
    return { ok: true };
}

/** The launch check runs only with the setting on, in a build that can update. */
export function shouldCheckAtLaunch(autoUpdate: boolean | null, host: UpdateHost): boolean {
    return autoUpdate === true && updateSupport(host).ok;
}

/** `owner/name` from a package.json `repository` (a string or `{ url }`), or undefined. */
export function repoFromPackage(repository: unknown): string | undefined {
    const raw =
        typeof repository === 'string'
            ? repository
            : typeof repository === 'object' && repository !== null && typeof (repository as { url?: unknown }).url === 'string'
              ? (repository as { url: string }).url
              : undefined;
    if (raw === undefined) return undefined;
    const match = /(?:github:|github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(raw.trim());
    return match === null ? undefined : `${match[1]}/${match[2]}`;
}

export function feedURL(host: UpdateHost, env: NodeJS.ProcessEnv = process.env): string {
    const base = (env[UPDATE_FEED_ENV]?.trim() || UPDATE_FEED_HOST).replace(/\/+$/, '');
    return `${base}/${host.repo ?? ''}/${host.platform}-${host.arch}/${host.version}`;
}

/** -1, 0 or 1. `major.minor.patch`, with a prerelease below its release (`0.2.0-rc.1` < `0.2.0`). */
export function compareVersions(a: string, b: string): number {
    const parse = (value: string): { core: number[]; pre: string } => {
        const [core = '', ...pre] = value.replace(/^v/, '').split('-');
        return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre.join('-') };
    };
    const left = parse(a);
    const right = parse(b);
    for (let index = 0; index < 3; index += 1) {
        const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
        if (difference !== 0) return difference > 0 ? 1 : -1;
    }
    if (left.pre === right.pre) return 0;
    if (left.pre === '') return 1;
    if (right.pre === '') return -1;
    return left.pre > right.pre ? 1 : -1;
}

export interface AvailableUpdate {
    readonly version: string;
    readonly notes: string;
    /** The feed URL Squirrel is given to download it. */
    readonly feed: string;
}

export type FeedReply =
    | { readonly kind: 'none' }
    | { readonly kind: 'available'; readonly update: AvailableUpdate }
    | { readonly kind: 'error'; readonly message: string };

/** What the feed said, as a decision. Only a strictly newer version is an update. */
export function parseFeedReply(status: number, body: string, currentVersion: string, feed: string): FeedReply {
    // 404 is the feed's "No updates found": nothing it serves, e.g. while every release is a
    // prerelease. Nothing to install, so not a failure.
    if (status === 204 || status === 404) return { kind: 'none' };
    if (status !== 200) return { kind: 'error', message: `the update feed answered HTTP ${String(status)}` };
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { kind: 'error', message: 'the update feed sent something that is not JSON' };
    }
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    const version = name.replace(/^v/, '').trim();
    if (version === '' || typeof record['url'] !== 'string') {
        return { kind: 'error', message: 'the update feed named no version or download' };
    }
    if (compareVersions(version, currentVersion) <= 0) return { kind: 'none' };
    const notes = typeof record['notes'] === 'string' ? record['notes'].trim() : '';
    return { kind: 'available', update: { version, notes, feed } };
}

export async function fetchUpdate(
    feed: string,
    currentVersion: string,
    fetchImpl: typeof fetch = fetch,
    timeoutMs = FEED_TIMEOUT_MS
): Promise<FeedReply> {
    try {
        const response = await fetchImpl(feed, { signal: AbortSignal.timeout(timeoutMs) });
        return parseFeedReply(response.status, response.status === 200 ? await response.text() : '', currentVersion, feed);
    } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
}

export const UPDATE_NOW = 0;
export const UPDATE_LATER = 1;

export interface PromptSpec {
    readonly type: 'info';
    readonly message: string;
    readonly detail: string;
    readonly buttons: string[];
    readonly defaultId: number;
    readonly cancelId: number;
}

/** The "Update Now / Later" prompt. */
export function updatePrompt(update: AvailableUpdate, currentVersion: string): PromptSpec {
    const notes =
        update.notes.length > PROMPT_NOTES_LIMIT ? `${update.notes.slice(0, PROMPT_NOTES_LIMIT).trimEnd()}…` : update.notes;
    const lines = [
        `You have ${currentVersion}. Updating downloads the new version, then restarts Kelpi.`,
        'Your terminals and agents keep running through the restart.'
    ];
    if (notes !== '') lines.push('', notes);
    return {
        type: 'info',
        message: `Kelpi ${update.version} is available`,
        detail: lines.join('\n'),
        buttons: ['Update Now', 'Later'],
        defaultId: UPDATE_NOW,
        cancelId: UPDATE_LATER
    };
}

/** Electron's `autoUpdater`, as much of it as the install needs. */
export interface Installer {
    setFeedURL(options: { url: string }): void;
    checkForUpdates(): void;
    quitAndInstall(): void;
    on(event: 'update-downloaded' | 'update-not-available' | 'error', listener: (...args: unknown[]) => void): unknown;
    removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Download the update through Squirrel and, once it is ready, quit into it. `beforeInstall` runs
 * just before the quit (it lets the quit through the agents-active confirmation, which would
 * otherwise stop an install the user already asked for). Rejects if the download fails.
 */
export function downloadAndInstall(installer: Installer, update: AvailableUpdate, beforeInstall: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
            installer.removeListener('update-downloaded', onDownloaded);
            installer.removeListener('update-not-available', onNotAvailable);
            installer.removeListener('error', onError);
        };
        const onDownloaded = (): void => {
            cleanup();
            log(`auto-update: ${update.version} downloaded; restarting into it`);
            beforeInstall();
            installer.quitAndInstall();
            resolve();
        };
        const onNotAvailable = (): void => {
            cleanup();
            reject(new Error(`Kelpi ${update.version} is no longer offered for this version`));
        };
        const onError = (error: unknown): void => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        installer.on('update-downloaded', onDownloaded);
        installer.on('update-not-available', onNotAvailable);
        installer.on('error', onError);
        try {
            installer.setFeedURL({ url: update.feed });
            installer.checkForUpdates();
            log(`auto-update: downloading ${update.version}`);
        } catch (error) {
            onError(error);
        }
    });
}

/** Logged once at launch, so a run's log says what the updater will do. */
export function launchLogLine(autoUpdate: boolean | null, host: UpdateHost): string {
    const support = updateSupport(host);
    if (!support.ok) return `auto-update: unavailable (${support.reason})`;
    return autoUpdate === true
        ? `auto-update: on; checking in ${String(LAUNCH_CHECK_DELAY_MS / 1000)} s`
        : 'auto-update: off (Settings ▸ General ▸ Updates); no update request is made';
}

export function reportUpdateError(context: string, error: unknown): void {
    logError(`auto-update: ${context}`, error);
}
