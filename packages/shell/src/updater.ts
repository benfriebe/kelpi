/**
 * Auto-update wiring — **off by default, and off in every packaged build we currently make.**
 *
 * docs/research/stack.md §1 picks `update-electron-app` 3.3.0 over a hand-rolled feed: on macOS
 * Electron's `autoUpdater` *is* Squirrel.Mac, and the only real decision is who manages the
 * feed. `update-electron-app` points Squirrel at `update.electronjs.org`, which reads GitHub
 * Releases and serves the Squirrel-compatible JSON for free.
 *
 * Three things have to be true before it may be switched on, and none of them are true yet:
 *
 *   1. **The repository must be public.** `update.electronjs.org` only serves public GitHub
 *      repos — it has no credentials for a private one, and there is no self-hosted mode. A
 *      private repo means `electron-builder` + `electron-updater` with our own `latest-mac.yml`
 *      instead (stack.md's stated alternative), not this module with a different URL.
 *   2. **The app must be signed and notarized.** Squirrel.Mac replaces the bundle in place and
 *      Gatekeeper re-evaluates it; an unsigned or ad-hoc-signed app either fails to stage the
 *      update or installs one that will not launch. Today `pnpm dist` produces neither (see the
 *      release checklist in the repo README) — so shipping an updater now would be a way to
 *      brick an install, not a feature.
 *   3. **`repository` must name the GitHub repo** in the app's `package.json`, or the caller has
 *      to pass an explicit `repo`. `update-electron-app` derives the feed from it.
 *
 * Until then this module does exactly one thing in the default configuration: nothing. No
 * import of `update-electron-app` is evaluated, and therefore **no network request is made** —
 * the dependency is loaded lazily inside the enabled branch, so the packaged default never even
 * initialises it.
 */

import { log, logError, warn } from './log.js';

/** Opt in explicitly, per launch: `NEX_AUTO_UPDATE=1`. Anything else is off. */
export const AUTO_UPDATE_ENV = 'NEX_AUTO_UPDATE';
/** Override the `owner/name` the feed is derived from (otherwise: `package.json` repository). */
export const AUTO_UPDATE_REPO_ENV = 'NEX_AUTO_UPDATE_REPO';
/** Poll interval, in the `ms`-parseable form update-electron-app wants (min 5 minutes). */
export const AUTO_UPDATE_INTERVAL_ENV = 'NEX_AUTO_UPDATE_INTERVAL';

export const DEFAULT_UPDATE_INTERVAL = '1 hour';

export interface AutoUpdateSettings {
    readonly enabled: boolean;
    readonly repo?: string | undefined;
    readonly updateInterval: string;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Read the flag. Deliberately strict: only an explicit truthy value enables it, so a stray
 * `NEX_AUTO_UPDATE=0` (or `=false`, or an empty string inherited from a shell) cannot turn on
 * a network-touching background task.
 */
export function readAutoUpdateSettings(env: NodeJS.ProcessEnv = process.env): AutoUpdateSettings {
    const raw = env[AUTO_UPDATE_ENV]?.trim().toLowerCase() ?? '';
    const repo = env[AUTO_UPDATE_REPO_ENV]?.trim();
    const interval = env[AUTO_UPDATE_INTERVAL_ENV]?.trim();
    return {
        enabled: TRUTHY.has(raw),
        ...(repo !== undefined && repo.length > 0 ? { repo } : {}),
        updateInterval: interval !== undefined && interval.length > 0 ? interval : DEFAULT_UPDATE_INTERVAL
    };
}

export interface AutoUpdateHost {
    /** `app.isPackaged` — Squirrel cannot update a `electron .` development run. */
    readonly isPackaged: boolean;
    readonly platform: string;
}

export type AutoUpdateOutcome =
    | { readonly started: false; readonly reason: string }
    | { readonly started: true; readonly repo?: string | undefined };

/**
 * Decide whether to start the updater. Pure, so the (many) refusal paths are testable without
 * an Electron process — `maybeStartAutoUpdate` below is the thin side effect.
 */
export function autoUpdateDecision(settings: AutoUpdateSettings, host: AutoUpdateHost): AutoUpdateOutcome {
    if (!settings.enabled) return { started: false, reason: `disabled (set ${AUTO_UPDATE_ENV}=1 to opt in)` };
    if (!host.isPackaged) return { started: false, reason: 'not a packaged app' };
    if (host.platform !== 'darwin' && host.platform !== 'win32') {
        return { started: false, reason: `unsupported platform ${host.platform}` };
    }
    return { started: true, ...(settings.repo !== undefined ? { repo: settings.repo } : {}) };
}

/**
 * Start the updater when — and only when — the decision above says so.
 *
 * The `import()` sits inside the enabled branch on purpose: esbuild keeps a dynamic import of a
 * bundled module lazy, so in the default (disabled) configuration `update-electron-app` is
 * never evaluated, never reads `package.json`, and never contacts `update.electronjs.org`.
 */
export async function maybeStartAutoUpdate(
    host: AutoUpdateHost,
    env: NodeJS.ProcessEnv = process.env
): Promise<AutoUpdateOutcome> {
    const settings = readAutoUpdateSettings(env);
    const decision = autoUpdateDecision(settings, host);
    if (!decision.started) {
        log(`auto-update: ${decision.reason}`);
        return decision;
    }

    warn(
        'auto-update is ON. It requires a PUBLIC GitHub repo (update.electronjs.org serves no ' +
            'private repos) and a signed + notarized build; an unsigned app cannot install a ' +
            'Squirrel update.'
    );
    try {
        const { updateElectronApp } = await import('update-electron-app');
        updateElectronApp({
            ...(settings.repo !== undefined ? { repo: settings.repo } : {}),
            updateInterval: settings.updateInterval,
            logger: { log, info: log, error: (message: unknown) => logError(String(message)), warn }
        });
        log(`auto-update: started (${settings.repo ?? 'package.json repository'}, every ${settings.updateInterval})`);
        return decision;
    } catch (error) {
        logError('auto-update failed to start', error);
        return { started: false, reason: error instanceof Error ? error.message : String(error) };
    }
}

// ── the manual check (APP-026) ──────────────────────────────────────────────────────

/**
 * `Nex ▸ Check for Updates…`.
 *
 * The Swift app used Sparkle and disabled the item whenever `canCheckForUpdates == false`
 * (`CheckForUpdatesView.swift:4-13`). Squirrel exposes no such flag, and — more importantly —
 * the honest reason a check is unavailable here is not "one is already running" but the three
 * preconditions this module's header lists. So the item is always ENABLED and always answers:
 * when updates are off it says so, in the words of the refusal, rather than being a grey row a
 * user cannot learn anything from.
 */
export type UpdateCheckResult =
    | { readonly kind: 'unavailable'; readonly message: string }
    | { readonly kind: 'checking' }
    | { readonly kind: 'failed'; readonly message: string };

/** `electron.autoUpdater`'s two members this needs; injected so the decision stays testable. */
export interface ManualUpdateBackend {
    checkForUpdates(): void;
}

export interface ManualUpdateOptions {
    readonly host: AutoUpdateHost;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** Absent in tests and in a dev run; production passes Electron's `autoUpdater`. */
    readonly backend?: ManualUpdateBackend | undefined;
    /** True once `maybeStartAutoUpdate` has actually initialised the feed. */
    readonly started?: boolean | undefined;
}

export function checkForUpdatesNow(options: ManualUpdateOptions): UpdateCheckResult {
    const settings = readAutoUpdateSettings(options.env ?? process.env);
    const decision = autoUpdateDecision(settings, options.host);
    if (!decision.started) {
        return {
            kind: 'unavailable',
            message: `Updates are ${decision.reason}. This build checks for updates only when it is packaged, signed and ${AUTO_UPDATE_ENV}=1 is set.`
        };
    }
    if (options.started !== true || options.backend === undefined) {
        return {
            kind: 'unavailable',
            message: 'The updater has not finished starting yet — try again in a moment.'
        };
    }
    try {
        options.backend.checkForUpdates();
        log('auto-update: manual check requested');
        return { kind: 'checking' };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('auto-update: manual check failed', error);
        return { kind: 'failed', message };
    }
}
