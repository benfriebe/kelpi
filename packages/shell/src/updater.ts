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
 * feed handed to `autoUpdater`, which downloads. **Later** does nothing; the next launch asks
 * again.
 *
 * #286: a finished download no longer quits the app on its own. It used to call
 * `quitAndInstall()` the moment Squirrel said "downloaded", with no warning, a minute or more
 * after the only sign of progress (a notification the user may never have seen): the window
 * vanished, which reads as a crash, and a user who reopened Kelpi before Squirrel relaunched it
 * raced the install. Now the download ends in "Kelpi X is ready. Restart Now / Later", and the
 * user decides (`./update-flow.ts` owns the states, `./update-surface.ts` how they are shown).
 * **Later** leaves the downloaded update with Squirrel, which installs it when Kelpi next quits
 * (Electron: "a successfully downloaded update will always be applied the next time the
 * application starts"; on macOS, Squirrel.Mac's ShipIt waits for the app to exit and swaps the
 * bundle then, without relaunching it).
 *
 * Squirrel can only replace a bundle it can write, so before offering Update Now the flow asks
 * `installLocation` whether this copy of Kelpi is somewhere an install can work: not
 * App-Translocated (a quarantined app opened from Downloads runs from a randomised read-only
 * mount), not on a read-only volume (the mounted DMG). Those are refused up front with the fix
 * ("move Kelpi to Applications"), rather than after a 165 MB download.
 *
 * When it runs:
 * - at launch, only with Settings ▸ General ▸ Updates "Check for updates automatically"
 *   (`auto-update`, default off). Off, the app makes no update request at all;
 * - on demand from Kelpi ▸ Check for Updates…, whatever the setting.
 *
 * Only the packaged macOS app can install an update (a development run has no bundle for Squirrel
 * to replace). `KELPI_UPDATE_FEED` points the check at another feed (a test server). The UI
 * harness drives the whole flow in a development run through a test-only seam that a packaged
 * app ignores (`./update-audit.ts`).
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
/** Release notes longer than this are cut in the NATIVE prompt (the in-app sheet scrolls). */
export const PROMPT_NOTES_LIMIT = 1200;
/**
 * How long a download may run before the flow says it is taking longer than expected. Squirrel.Mac
 * reports no progress at all, so this is the only signal a slow download gives. It is NOT a
 * failure: Squirrel keeps going, and the flow keeps waiting for it (a download that finished after
 * a timeout used to be lost, #286 review). Generous, because the ZIP is about 165 MB.
 */
export const DOWNLOAD_SLOW_MS = 10 * 60_000;

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

/** The first `major.minor.patch[-prerelease]` in some text (`v0.2.0`, `Kelpi 0.2.0-rc.2`), or undefined. */
export function versionIn(text: string): string | undefined {
    return /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?)/.exec(text)?.[1];
}

/**
 * The version a feed reply offers. The feed's `name` is the release's TITLE ("Kelpi 0.2.0"), which
 * anyone can edit, so the release's tag, the `/download/<tag>/` segment of `url`, comes first.
 */
export function offeredVersion(name: string, url: string): string | undefined {
    const tag = /\/download\/([^/]+)\//.exec(url)?.[1];
    return (tag === undefined ? undefined : versionIn(decodeURIComponent(tag))) ?? versionIn(name);
}

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
    const url = typeof record['url'] === 'string' ? record['url'] : undefined;
    const version = url === undefined ? undefined : offeredVersion(name, url);
    if (version === undefined) {
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

/** The native "Update Now / Later" prompt (the fallback when no page can show the sheet). */
export function updatePrompt(update: AvailableUpdate, currentVersion: string): PromptSpec {
    const notes =
        update.notes.length > PROMPT_NOTES_LIMIT ? `${update.notes.slice(0, PROMPT_NOTES_LIMIT).trimEnd()}…` : update.notes;
    const lines = [
        `You have ${currentVersion}. Updating downloads the new version in the background; Kelpi asks before it restarts.`,
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
    on(
        event: 'update-downloaded' | 'update-not-available' | 'update-available' | 'checking-for-update' | 'error',
        listener: (...args: unknown[]) => void
    ): unknown;
    removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface DownloadOptions {
    /** When the download counts as slow (`DOWNLOAD_SLOW_MS`). */
    readonly slowMs?: number | undefined;
    /** Called once when it does; the download goes on. */
    readonly onSlow?: (() => void) | undefined;
}

/**
 * Download the update through Squirrel, and resolve once it is downloaded. Nothing quits here:
 * #286 moved the restart behind the user's "Restart Now" (`./update-flow.ts`). Rejects if the
 * download fails or the feed no longer offers the version. A download past `slowMs` is reported
 * through `onSlow` and waited for, never abandoned: Squirrel is still fetching it.
 *
 * Squirrel's own milestones are logged as they happen (it found the update, it finished), so a
 * report like #286's can be read off the log.
 */
export function downloadUpdate(installer: Installer, update: AvailableUpdate, options: DownloadOptions = {}): Promise<void> {
    const slowMs = options.slowMs ?? DOWNLOAD_SLOW_MS;
    return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            installer.removeListener('update-downloaded', onDownloaded);
            installer.removeListener('update-not-available', onNotAvailable);
            installer.removeListener('update-available', onAvailable);
            installer.removeListener('error', onError);
        };
        const onDownloaded = (): void => {
            cleanup();
            log(`auto-update: ${update.version} downloaded; waiting for the user to restart`);
            resolve();
        };
        const onAvailable = (): void => {
            log(`auto-update: Squirrel found ${update.version} and is downloading it`);
        };
        const onNotAvailable = (): void => {
            cleanup();
            reject(new Error(`Kelpi ${update.version} is no longer offered for this version.`));
        };
        const onError = (error: unknown): void => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        installer.on('update-downloaded', onDownloaded);
        installer.on('update-not-available', onNotAvailable);
        installer.on('update-available', onAvailable);
        installer.on('error', onError);
        timer = setTimeout(() => {
            timer = undefined;
            log(`auto-update: ${update.version} is still downloading after ${String(Math.round(slowMs / 1000))} s; still waiting`);
            options.onSlow?.();
        }, slowMs);
        timer.unref?.();
        try {
            installer.setFeedURL({ url: update.feed });
            installer.checkForUpdates();
            log(`auto-update: downloading ${update.version} from ${update.feed}`);
        } catch (error) {
            onError(error);
        }
    });
}

// ── where Kelpi is running from (#286) ──────────────────────────────────────────────

/** What an install can do from where this copy of Kelpi is running. */
export type InstallLocation =
    | { readonly kind: 'ok'; readonly bundlePath: string }
    | { readonly kind: 'warn'; readonly bundlePath: string; readonly message: string }
    | {
          readonly kind: 'blocked';
          readonly bundlePath: string;
          readonly reason: 'translocated' | 'read-only';
          readonly message: string;
      };

/** Whether a directory can be written, as `fs.accessSync(dir, W_OK)` says it. */
export type DirectoryAccess = 'writable' | 'read-only' | 'denied' | 'missing';

/** The `.app` bundle an executable belongs to (`/Applications/Kelpi.app/Contents/MacOS/Kelpi`). */
export function bundlePathFromExe(exePath: string): string | null {
    const marker = /\.app\/Contents\/MacOS\//.exec(exePath);
    return marker === null ? null : exePath.slice(0, marker.index + '.app'.length);
}

function parentDirectory(target: string): string {
    const trimmed = target.replace(/\/+$/, '');
    const cut = trimmed.lastIndexOf('/');
    return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

/**
 * Whether Squirrel can replace the bundle at `bundlePath`, and what to tell the user when not.
 *
 * Squirrel.Mac installs by swapping the bundle on disk, so it needs a bundle it can replace:
 *
 *   - **App Translocation** (`/AppTranslocation/` in the path): macOS runs a quarantined app that
 *     was opened where it was downloaded from a randomised, read-only mount. The install cannot
 *     land, and the fix is to move the app with Finder. Blocked.
 *   - **A read-only volume**, which is what a mounted DMG is: nothing can be swapped. Blocked.
 *   - **Anywhere else outside `/Applications` or `~/Applications`**: Squirrel updates a bundle
 *     wherever it can write, so this is allowed, with a note, because it is the case to suspect
 *     if an install then does not take.
 *   - A folder this account cannot write (a managed Mac's `/Applications`): allowed with a note,
 *     since the install may need an administrator.
 *
 * `access` is `fs.accessSync(parent, W_OK)`'s answer, injected so the rules are testable.
 */
export function installLocation(bundlePath: string, access: (directory: string) => DirectoryAccess, home: string): InstallLocation {
    const parent = parentDirectory(bundlePath);
    const move = 'Quit Kelpi, move Kelpi.app into your Applications folder with Finder, and open it from there.';
    if (bundlePath.includes('/AppTranslocation/')) {
        return {
            kind: 'blocked',
            bundlePath,
            reason: 'translocated',
            message: `macOS is running this copy of Kelpi from a temporary read-only location (App Translocation), so an update cannot replace it. ${move}`
        };
    }
    const writable = access(parent);
    if (writable === 'read-only') {
        const volume = /^\/Volumes\/[^/]+/.exec(bundlePath)?.[0];
        return {
            kind: 'blocked',
            bundlePath,
            reason: 'read-only',
            message:
                volume === undefined
                    ? `Kelpi is running from a read-only location (${parent}), so an update cannot replace it. ${move}`
                    : `Kelpi is running from a disk image or read-only volume (${volume}), so an update cannot replace it. Drag Kelpi into your Applications folder, eject ${volume}, and open Kelpi from Applications.`
        };
    }
    const inApplications =
        parent === '/Applications' ||
        parent.startsWith('/Applications/') ||
        parent === `${home}/Applications` ||
        parent.startsWith(`${home}/Applications/`);
    if (writable === 'denied') {
        return {
            kind: 'warn',
            bundlePath,
            message: `This account cannot write to ${parent}, so installing the update may need an administrator.`
        };
    }
    if (!inApplications) {
        return {
            kind: 'warn',
            bundlePath,
            message: `Kelpi is running from ${parent} rather than Applications. The update replaces it there; if it does not take, move Kelpi to Applications and update again.`
        };
    }
    return { kind: 'ok', bundlePath };
}

/** One log line per location check, so a failed install can be matched to where Kelpi ran. */
export function installLocationLogLine(location: InstallLocation): string {
    if (location.kind === 'ok') return `auto-update: install location ${location.bundlePath} (ok)`;
    if (location.kind === 'warn') return `auto-update: install location ${location.bundlePath} (warning: ${location.message})`;
    return `auto-update: install location ${location.bundlePath} (blocked: ${location.reason})`;
}

/** Logged once at launch, so a run's log says what the updater will do. */
export function launchLogLine(autoUpdate: boolean | null, host: UpdateHost): string {
    const support = updateSupport(host);
    if (!support.ok) return `auto-update: unavailable (${support.reason})`;
    return autoUpdate === true
        ? `auto-update: on; checking in ${String(LAUNCH_CHECK_DELAY_MS / 1000)} s`
        : 'auto-update: off (Settings ▸ General ▸ Updates); no update request is made';
}

/**
 * #286: what this launch runs, against what the previous one ran. The first launch after an
 * install says so, which is how a log tells "the update took" from "the same old version came
 * back" (the second half of Jordon's report).
 */
export function launchVersionLogLine(previous: string, current: string): string {
    if (previous === '') return `auto-update: running ${current} (no earlier launch recorded)`;
    if (previous === current) return `auto-update: running ${current} (as last launch)`;
    return compareVersions(current, previous) > 0
        ? `auto-update: running ${current}, updated from ${previous}`
        : `auto-update: running ${current}, previously ${previous}`;
}

export function reportUpdateError(context: string, error: unknown): void {
    logError(`auto-update: ${context}`, error);
}
