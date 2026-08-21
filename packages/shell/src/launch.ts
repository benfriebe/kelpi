/**
 * The launch sequence, with the Electron taken out of it (APP-001/003/004/101, CONT-125/127).
 *
 * `main.ts` cannot be imported under vitest — an `import { app } from 'electron'` does not
 * resolve under plain Node — so for as long as the launch path lived *inside* it, the parts of
 * it that have rules in them had no test at all: the file-open buffer and its drain, the
 * activate-on-open step, the CLI heal/offer ordering, and the order the boot phases run in.
 * That was gap #6 in the capability index, and the reason it was a gap rather than an opinion is
 * that all four are *sequencing* claims — the kind that keep working right up until someone
 * moves a line.
 *
 * So the sequencing lives here, as ordinary functions over injected effects, and `main.ts` is
 * left holding the effects themselves (the dialog, the notification, the BrowserWindow, the
 * control socket). Nothing in this module imports Electron, and nothing in it performs IO.
 *
 * This is an extraction, not a redesign: every branch below is the one `main.ts` already took,
 * in the order it already took it. `./shell-actions.ts` is the same idea for the daemon's
 * `shell-action` broadcast, and `vitest.config.mts` explains the rule both follow.
 */

import {
    resolveCliInstallMode,
    type CliInstallMode,
    type CliInstallResult,
    type PlanOptions
} from './cli-install.js';

// ---------------------------------------------------------------------------
// Finder "Open With", cold launch (CONT-125, CONT-127, APP-101)
// ---------------------------------------------------------------------------

/** One file the OS handed us, plus the pane that asked for it (⌘O only; Finder names none). */
export interface OpenFileRequest {
    readonly path: string;
    readonly paneID: string | null;
}

export interface OpenFileQueueDeps {
    /**
     * Is the daemon connection up? Called on **every** forward, never cached: a file can arrive
     * before the connection exists (Finder cold launch) and after it is re-established.
     */
    readonly ready: () => boolean;
    /** Send the `open` control command. Only ever called when `ready()` said yes. */
    readonly send: (request: OpenFileRequest) => void;
    /** Raise/focus the window (CONT-125): an open while hidden must become visible. */
    readonly activate: () => void;
}

export interface OpenFileQueue {
    /**
     * Route one file. Ready ⇒ send it and raise the window; not ready ⇒ park it, silently,
     * and raise nothing — there is no window to raise yet, and a queued file must not steal
     * focus twice when it finally goes out.
     */
    forward(filePath: string, paneID?: string | null): void;
    /** Replay everything parked, in arrival order. A no-op when nothing is parked. */
    drain(): void;
    /** What is parked right now (diagnostics and tests; never mutated by the caller). */
    pending(): readonly string[];
}

/**
 * Stage one of the Swift `FileOpenGate` (`CONT-127` / `APP-101`): buffer what arrives before
 * the store — here, the daemon connection — is wired, then replay it in arrival order.
 *
 * Two rules the Swift gate has and a naive queue does not:
 *
 *  - **Snapshot-and-clear.** `drain()` takes the whole queue *before* replaying any of it, so a
 *    forward that happens during the replay (a second Finder event, or a re-park because the
 *    connection dropped again) joins the next drain rather than being replayed twice by this
 *    one. `AppReducer+SearchNotify.swift:132-139` is the same snapshot-then-clear for the same
 *    reason: "a later workspace creation can't replay stale paths as phantom panes".
 *  - **A parked file is not an activated window.** `activate()` runs only where `send()` does.
 *
 * The pane id is deliberately *not* parked: the only route that carries one (⌘O, from a pane in
 * a window that is already up) can never be parked, because a window implies a connection.
 * `main.ts` had the same asymmetry — `pendingOpens` was a `string[]` — and it is preserved here
 * rather than quietly widened.
 */
export function createOpenFileQueue(deps: OpenFileQueueDeps): OpenFileQueue {
    const parked: string[] = [];

    const forward = (filePath: string, paneID: string | null = null): void => {
        if (!deps.ready()) {
            parked.push(filePath);
            return;
        }
        deps.send({ path: filePath, paneID });
        deps.activate();
    };

    return {
        forward,
        drain() {
            // Snapshot-and-clear before replaying: see the note above.
            const queued = parked.splice(0, parked.length);
            for (const filePath of queued) forward(filePath, null);
        },
        pending() {
            return [...parked];
        }
    };
}

// ---------------------------------------------------------------------------
// The global CLI: heal, then (only then) offer (APP-003, APP-004, APP-005)
// ---------------------------------------------------------------------------

export interface CliInstallPolicyDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly isPackaged: boolean;
    /** Has this install already offered once? (`shell-settings.json`) */
    readonly alreadyPrompted: boolean;
    /** The bundled launcher; `''` when this build carries no CLI payload. */
    readonly target: string;
    readonly linkPath: string;
    /** `healCliSymlink` — repair drift, never create (the opt-in rule). */
    readonly heal: (options: PlanOptions) => CliInstallResult;
    /** `installCliNow(false)` — the managed-deployment path, which does not ask. */
    readonly installNow: () => void;
    /** Log + the once-per-version "CLI is out of date" notification (APP-005). */
    readonly report: (result: CliInstallResult) => void;
    /** The first-launch "Install the nex command line tool?" dialog. */
    readonly offer: () => void;
    readonly log: (message: string) => void;
}

export type CliInstallPolicyOutcome =
    /** Not a packaged app, or `NEX_CLI_INSTALL=off`: nothing was looked at. */
    | { readonly kind: 'off'; readonly mode: CliInstallMode }
    /** No launcher to point at — a dev bundle, or a broken build. */
    | { readonly kind: 'no-payload'; readonly mode: CliInstallMode }
    /** `NEX_CLI_INSTALL=auto`: installed without asking. */
    | { readonly kind: 'installed'; readonly mode: CliInstallMode }
    /** The normal path: healed, and offered only when there was nothing there. */
    | {
          readonly kind: 'healed';
          readonly mode: CliInstallMode;
          readonly result: CliInstallResult;
          readonly offered: boolean;
      };

/**
 * What launch does about `/usr/local/bin/nex`, in the order it does it.
 *
 * **Heal first, in every case.** The offer is gated on the heal's own `absent` answer, so a
 * user who already has the CLI installed is never asked about it — and the question "is one
 * installed?" is never answered by a second, differently-written probe. The three refusals
 * (`off`, no payload, a `foreign` entry the heal declines to touch) all end here silently,
 * because none of them is the user's problem to be told about at launch.
 */
export function runCliInstallPolicy(deps: CliInstallPolicyDeps): CliInstallPolicyOutcome {
    const mode = resolveCliInstallMode({
        env: deps.env,
        isPackaged: deps.isPackaged,
        alreadyPrompted: deps.alreadyPrompted
    });
    if (mode === 'off') {
        deps.log('cli-install: disabled for this run');
        return { kind: 'off', mode };
    }
    if (deps.target === '') {
        deps.log('cli-install: no CLI payload in this build');
        return { kind: 'no-payload', mode };
    }
    if (mode === 'auto') {
        deps.installNow();
        return { kind: 'installed', mode };
    }
    const healed = deps.heal({ linkPath: deps.linkPath, target: deps.target });
    deps.report(healed);
    const offered = mode === 'prompt' && healed.plan.action === 'absent';
    if (offered) deps.offer();
    return { kind: 'healed', mode, result: healed, offered };
}

// ---------------------------------------------------------------------------
// Boot ordering (APP-001, APP-101)
// ---------------------------------------------------------------------------

export interface DaemonConnectSteps {
    /** Discover or spawn the daemon and remember where it is. Never stops one. */
    readonly connect: () => Promise<void>;
    /** Create the status socket, or re-point the existing one (never a second controller). */
    readonly startStatus: () => void;
    /** Same for the web-pane host. */
    readonly startWebHost: () => void;
    /** Stage-one replay (CONT-127): only meaningful once there is somewhere to send. */
    readonly drainPendingOpens: () => void;
}

/**
 * `startDaemonAndConnect`, as an order.
 *
 * The drain is last and it is unconditional. Last, because a file replayed before the status
 * socket exists would be sent into a connection whose reply nobody is listening for;
 * unconditional, because this function runs again on a reconnect (the tray's "start daemon"),
 * and a file parked while the daemon was down has to go out on the connection that replaces it.
 * An empty queue makes the call free.
 */
export async function runDaemonConnectSequence(steps: DaemonConnectSteps): Promise<void> {
    await steps.connect();
    steps.startStatus();
    steps.startWebHost();
    steps.drainPendingOpens();
}

export interface LaunchSteps {
    /** stack.md §1's permission handlers, installed before any content loads. */
    readonly applyPermissionPolicy: () => void;
    readonly buildMenu: () => void;
    /** `runDaemonConnectSequence` in production; rejects when no daemon can be reached. */
    readonly connectDaemon: () => Promise<void>;
    /** The fatal path: report and exit. Launch stops here — no window is created. */
    readonly reportDaemonUnavailable: (error: unknown) => void;
    /** SET-219: the web find palette is read before the first tab can exist. */
    readonly applyFindPalette: () => void;
    readonly createWindow: () => void;
    readonly registerGlobalHotkey: () => void;
    /** APP-003/004. Best-effort: a throw here must not cost the user their window. */
    readonly runCliInstallPolicy: () => void;
    /**
     * §APP-006's slot: refreshing the bundled agent documentation. Inert in this build (see
     * `main.ts`), and best-effort for the same reason the CLI policy is — whatever fills it
     * touches a directory outside the app.
     */
    readonly refreshBundledSkill: () => void;
    readonly startUpdater: () => void;
    readonly installQuitGate: () => void;
    readonly logError: (message: string, error: unknown) => void;
}

export type LaunchOutcome = 'ready' | 'daemon-unavailable';

/**
 * `boot()`, as an order — the sequence the file's own header comment describes, made executable.
 *
 * Two things in here are load-bearing and were previously only comments:
 *
 *  - **The daemon comes before the window.** A window pointed at a daemon that is not there
 *    shows an error page and retries in a loop; the app reports and exits instead, and it must
 *    not create the window first (APP-001's "discover or spawn the daemon" step 2 before step 3).
 *  - **The CLI policy and the skill refresh cannot fail the launch.** They write to
 *    `/usr/local/bin` and `~/.claude`, exactly the kind of places that throw, and they run
 *    *after* the window exists so that a throw costs a log line and nothing else (APP-003: "off
 *    the boot path's critical line").
 */
export async function runLaunchSequence(steps: LaunchSteps): Promise<LaunchOutcome> {
    steps.applyPermissionPolicy();
    steps.buildMenu();

    try {
        await steps.connectDaemon();
    } catch (error) {
        steps.reportDaemonUnavailable(error);
        return 'daemon-unavailable';
    }

    steps.applyFindPalette();
    steps.createWindow();
    steps.registerGlobalHotkey();
    // Two independent best-effort steps, in two independent `try`s: both write outside the app
    // (one into `/usr/local/bin`, one into `~/.claude`), and one of them failing must cost the
    // other nothing — least of all the launch.
    try {
        steps.runCliInstallPolicy();
    } catch (error) {
        steps.logError('cli-install failed', error);
    }
    try {
        steps.refreshBundledSkill();
    } catch (error) {
        steps.logError('skill-refresh failed', error);
    }
    steps.startUpdater();
    steps.installQuitGate();
    return 'ready';
}
