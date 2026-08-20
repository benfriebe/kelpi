/**
 * The global `nex` CLI install and its self-heal (APP-003, APP-004, APP-005).
 *
 * Port of `Nex/Services/CLIInstallService.swift`. The problem it solves is the same one issue #39
 * described: the CLI lives inside the app bundle, `/usr/local/bin/nex` is how a shell (and every
 * Claude Code hook) reaches it, and an app that updates itself leaves that entry pointing at last
 * month's build — or, if it was ever installed by *copying* the binary, at a file that never
 * changes again. A symlink into the running bundle cannot drift; the job here is to keep one
 * there, and to keep hands off everything else.
 *
 * Three rules carried over verbatim, because each one is someone's data:
 *
 *  1. **Opt-in is preserved.** `heal()` does nothing when `/usr/local/bin/nex` does not exist. A
 *     user who never installed the CLI does not get one because they launched the app.
 *  2. **Only an entry we can attribute to Nex is touched.** Anything else — a Homebrew binary
 *     called `nex`, a deliberate pin to a dev checkout — is left exactly as it is, with no
 *     notification, because we cannot prove the user wanted ours there.
 *  3. **Never sudo, never silently.** An unwritable `/usr/local/bin` produces a notification and
 *     the exact command to run by hand (APP-005), deduped once per app version.
 *
 * Deliberate divergence from the Swift original, and the reason for it: attribution there was a
 * code-signature Team ID (`4ASXCG2599`). This app is not necessarily signed at all — a local
 * `pnpm dist` produces an ad-hoc signature whose identity changes every build — so a signature
 * check would either pass on nothing or have to be skipped. Instead an entry is ours when it is a
 * symlink into a bundle's `Contents/Resources/cli/`, a dangling symlink that still names such a
 * path (or the Swift era's `.app/Contents/Helpers/nex`), or a regular file carrying the launcher's
 * own marker text. The consequence is stated plainly: a *regular* Mach-O binary at
 * `/usr/local/bin/nex` — what the pre-April 2025 `cp` installer left — is NOT attributed by this
 * port and is left alone. That is the conservative direction: the cost is a stale Swift CLI that
 * keeps working, where the alternative cost is deleting a binary that was never ours.
 *
 * Nothing here imports Electron: the dialog, the notification and the tray item live in
 * `./main.ts` and `./status.ts`, and everything below is a pure decision over a filesystem seam,
 * which is what makes it testable under plain Node.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLI_LAUNCHER_MARKER } from './packaging.js';
import { packagedCliLauncher } from './resources.js';

/** Where the CLI goes. Same default as the Swift installer and `nex install-hooks --link`. */
export const DEFAULT_CLI_LINK_PATH = '/usr/local/bin/nex';

/**
 * The link path for this run. `NEX_CLI_LINK_PATH` overrides it.
 *
 * That override is not a user feature, it is a *testing* one, and it earns its place: without it
 * the only way to exercise this module against a real packaged app is to let it write to the
 * machine's actual `/usr/local/bin/nex`, which is the developer's own CLI. `packaged-smoke.mjs`
 * points it at a path inside its sandbox and asserts the repair really happened.
 */
export function resolveCliLinkPath(env: NodeJS.ProcessEnv): string {
    const override = env['NEX_CLI_LINK_PATH']?.trim();
    return override !== undefined && override.length > 0 ? override : DEFAULT_CLI_LINK_PATH;
}

/**
 * Path tails that mean "this points into a Nex app bundle".
 *
 * `Contents/Helpers/nex` is the Swift app's layout and is accepted only for a *dangling* link —
 * a live one means a working Swift Nex is installed, and repointing it at this app would hijack
 * another application's CLI.
 */
const PORT_CLI_SUFFIXES = ['/Contents/Resources/cli/nex', '/Contents/Resources/cli/nex.js'];
const LEGACY_CLI_SUFFIX = '.app/Contents/Helpers/nex';

export interface CliFs {
    /** `lstat`-based existence: a dangling symlink counts. */
    exists(file: string): boolean;
    isSymlink(file: string): boolean;
    isFile(file: string): boolean;
    readLink(file: string): string | null;
    /** First bytes of a file, for the launcher marker check; null when unreadable. */
    readHead(file: string): string | null;
    isWritable(dir: string): boolean;
    mkdirp(dir: string): void;
    remove(file: string): void;
    symlink(target: string, linkPath: string): void;
}

export const nodeCliFs: CliFs = {
    exists(file) {
        try {
            fs.lstatSync(file);
            return true;
        } catch {
            return false;
        }
    },
    isSymlink(file) {
        try {
            return fs.lstatSync(file).isSymbolicLink();
        } catch {
            return false;
        }
    },
    isFile(file) {
        try {
            return fs.statSync(file).isFile();
        } catch {
            return false;
        }
    },
    readLink(file) {
        try {
            return fs.readlinkSync(file);
        } catch {
            return null;
        }
    },
    readHead(file) {
        try {
            const handle = fs.openSync(file, 'r');
            try {
                const buffer = Buffer.alloc(4096);
                const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
                return buffer.subarray(0, read).toString('utf8');
            } finally {
                fs.closeSync(handle);
            }
        } catch {
            return null;
        }
    },
    isWritable(dir) {
        try {
            fs.accessSync(dir, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    },
    mkdirp(dir) {
        fs.mkdirSync(dir, { recursive: true });
    },
    remove(file) {
        try {
            fs.unlinkSync(file);
        } catch {
            // Already gone.
        }
    },
    symlink(target, linkPath) {
        fs.symlinkSync(target, linkPath);
    }
};

// ── attribution ─────────────────────────────────────────────────────────────────────

function resolveStoredDestination(linkPath: string, stored: string): string {
    return path.isAbsolute(stored) ? stored : path.join(path.dirname(linkPath), stored);
}

function carriesLauncherMarker(file: string, fsys: CliFs): boolean {
    const head = fsys.readHead(file);
    return head !== null && head.includes(CLI_LAUNCHER_MARKER);
}

/**
 * Is the entry at `linkPath` something a Nex installer produced?
 *
 * See the module note for why this is not a code-signature check, and for the one case it
 * deliberately answers "no" where the Swift original answered "yes".
 */
export function isNexManagedInstall(linkPath: string, fsys: CliFs): boolean {
    if (fsys.isSymlink(linkPath)) {
        const stored = fsys.readLink(linkPath);
        if (stored === null) return false;
        const resolved = resolveStoredDestination(linkPath, stored);
        if (fsys.exists(resolved)) {
            // Live link: only a bundle of OURS, or a file carrying our marker.
            return PORT_CLI_SUFFIXES.some((suffix) => resolved.endsWith(suffix)) || carriesLauncherMarker(resolved, fsys);
        }
        // Dangling: the app it pointed at was moved or deleted. The stored path is all we have,
        // and it is a narrow enough shape that a random broken symlink is not adopted.
        return (
            PORT_CLI_SUFFIXES.some((suffix) => resolved.endsWith(suffix)) || resolved.endsWith(LEGACY_CLI_SUFFIX)
        );
    }
    if (fsys.isFile(linkPath)) return carriesLauncherMarker(linkPath, fsys);
    return false;
}

// ── the plan ────────────────────────────────────────────────────────────────────────

export type CliInstallAction =
    /** Already a symlink to this bundle's launcher. */
    | 'ok'
    /** Nothing at the link path. `heal` leaves it (opt-in); an explicit install creates it. */
    | 'absent'
    /** Ours, but pointing at the wrong place (post-update drift, or an old copy). */
    | 'drifted'
    /** Someone else's `nex`. Never touched, never reported to the user. */
    | 'foreign'
    /** No CLI payload in this app — a dev run, or a broken build. */
    | 'unavailable';

export interface CliInstallPlan {
    readonly action: CliInstallAction;
    readonly linkPath: string;
    /** The launcher we would point at (empty when `unavailable`). */
    readonly target: string;
    /** The command a user can run by hand — always safe to print, never executed. */
    readonly manualCommand: string;
}

export interface PlanOptions {
    readonly linkPath: string;
    /** The bundled launcher path (`packagedCliLauncher(process.resourcesPath)`). */
    readonly target: string;
}

export function planCliInstall(options: PlanOptions, fsys: CliFs): CliInstallPlan {
    const { linkPath, target } = options;
    const manualCommand = `sudo ln -sfn ${target} ${linkPath}`;
    const base = { linkPath, target, manualCommand };

    if (target.length === 0 || !fsys.exists(target)) {
        return { ...base, action: 'unavailable', manualCommand: '' };
    }
    if (!fsys.exists(linkPath)) return { ...base, action: 'absent' };
    if (fsys.isSymlink(linkPath) && fsys.readLink(linkPath) === target) return { ...base, action: 'ok' };
    if (!isNexManagedInstall(linkPath, fsys)) return { ...base, action: 'foreign' };
    return { ...base, action: 'drifted' };
}

export type CliInstallResult =
    /** Nothing needed doing. */
    | { readonly kind: 'ok'; readonly plan: CliInstallPlan }
    /** The link was created or repaired. */
    | { readonly kind: 'linked'; readonly plan: CliInstallPlan }
    /** Deliberately left alone (`foreign`, or `absent` during a heal). */
    | { readonly kind: 'skipped'; readonly plan: CliInstallPlan; readonly reason: string }
    /** We could not write it; `plan.manualCommand` is the repair (APP-005). */
    | { readonly kind: 'blocked'; readonly plan: CliInstallPlan; readonly reason: string };

function link(plan: CliInstallPlan, fsys: CliFs): CliInstallResult {
    const dir = path.dirname(plan.linkPath);
    try {
        fsys.mkdirp(dir);
    } catch (error) {
        return {
            kind: 'blocked',
            plan,
            reason: `could not create ${dir}: ${error instanceof Error ? error.message : String(error)}`
        };
    }
    if (!fsys.isWritable(dir)) return { kind: 'blocked', plan, reason: `${dir} is not writable` };
    try {
        fsys.remove(plan.linkPath);
        fsys.symlink(plan.target, plan.linkPath);
    } catch (error) {
        return { kind: 'blocked', plan, reason: error instanceof Error ? error.message : String(error) };
    }
    return { kind: 'linked', plan };
}

/**
 * The launch path (APP-003/004): repair drift, never create, never touch what is not ours.
 */
export function healCliSymlink(options: PlanOptions, fsys: CliFs): CliInstallResult {
    const plan = planCliInstall(options, fsys);
    switch (plan.action) {
        case 'ok':
            return { kind: 'ok', plan };
        case 'absent':
            return { kind: 'skipped', plan, reason: 'the global CLI is not installed (nothing to heal)' };
        case 'foreign':
            return { kind: 'skipped', plan, reason: `${plan.linkPath} was not installed by Nex` };
        case 'unavailable':
            return { kind: 'skipped', plan, reason: 'this build carries no CLI payload' };
        case 'drifted':
            return link(plan, fsys);
    }
}

/**
 * The explicit path: the tray's "Install CLI", and the accepted first-launch offer.
 *
 * The only difference from `healCliSymlink` is that `absent` is a *create* rather than a skip —
 * the user asked for it, so the opt-in rule has been satisfied by the asking.
 */
export function installCliSymlink(options: PlanOptions, fsys: CliFs): CliInstallResult {
    const plan = planCliInstall(options, fsys);
    switch (plan.action) {
        case 'ok':
            return { kind: 'ok', plan };
        case 'foreign':
            return {
                kind: 'skipped',
                plan,
                reason: `${plan.linkPath} already exists and was not installed by Nex — remove it first, or install elsewhere`
            };
        case 'unavailable':
            return { kind: 'skipped', plan, reason: 'this build carries no CLI payload' };
        case 'absent':
        case 'drifted':
            return link(plan, fsys);
    }
}

// ── policy ──────────────────────────────────────────────────────────────────────────

/**
 * What should happen on launch.
 *
 *   `off`    — do nothing at all (the default outside a packaged app, and what the smokes set).
 *   `heal`   — repair an existing install only; never offer (used once the user has been asked).
 *   `prompt` — heal, and offer to create one when there is none.
 *
 * `NEX_CLI_INSTALL=off|heal|prompt|auto` overrides; `auto` installs without asking, which is for
 * a managed deployment rather than a person.
 */
export type CliInstallMode = 'off' | 'heal' | 'prompt' | 'auto';

export interface ModeInputs {
    readonly env: NodeJS.ProcessEnv;
    readonly isPackaged: boolean;
    /** Has the user already been offered the install once? */
    readonly alreadyPrompted: boolean;
}

export function resolveCliInstallMode(inputs: ModeInputs): CliInstallMode {
    const override = inputs.env['NEX_CLI_INSTALL']?.trim().toLowerCase();
    if (override === 'off' || override === 'heal' || override === 'prompt' || override === 'auto') return override;
    // A dev run (`electron .`) points at a checkout, not a bundle: there is nothing to install,
    // and offering would be offering to symlink someone's working tree into /usr/local/bin.
    if (!inputs.isPackaged) return 'off';
    return inputs.alreadyPrompted ? 'heal' : 'prompt';
}

/** The bundled launcher for the running app, or '' when this build has no CLI payload. */
export function bundledCliLauncher(resourcesPath: string | undefined): string {
    if (resourcesPath === undefined || resourcesPath.length === 0) return '';
    const launcher = packagedCliLauncher(resourcesPath);
    return nodeCliFs.exists(launcher) ? launcher : '';
}

/** One-line log/summary of what happened, for the shell log and the tray dialog. */
export function describeCliInstall(result: CliInstallResult): string {
    switch (result.kind) {
        case 'ok':
            return `cli-install: ${result.plan.linkPath} already points at this build`;
        case 'linked':
            return `cli-install: ${result.plan.linkPath} -> ${result.plan.target}`;
        case 'skipped':
            return `cli-install: skipped (${result.reason})`;
        case 'blocked':
            return `cli-install: blocked (${result.reason}); run by hand: ${result.plan.manualCommand}`;
    }
}
