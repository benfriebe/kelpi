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
    /** The first-launch "Install the kelpi command line tool?" dialog. */
    readonly offer: () => void;
    readonly log: (message: string) => void;
}

export type CliInstallPolicyOutcome =
    /** Not a packaged app, or `KELPI_CLI_INSTALL=off`: nothing was looked at. */
    | { readonly kind: 'off'; readonly mode: CliInstallMode }
    /** No launcher to point at — a dev bundle, or a broken build. */
    | { readonly kind: 'no-payload'; readonly mode: CliInstallMode }
    /** `KELPI_CLI_INSTALL=auto`: installed without asking. */
    | { readonly kind: 'installed'; readonly mode: CliInstallMode }
    /** The normal path: healed, and offered only when there was nothing there. */
    | {
          readonly kind: 'healed';
          readonly mode: CliInstallMode;
          readonly result: CliInstallResult;
          readonly offered: boolean;
      };

/**
 * What launch does about `/usr/local/bin/kelpi`, in the order it does it.
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

/** A launch step. Sync in `main.ts`; a test may hand back a promise to prove concurrency. */
export type LaunchStep = () => void | Promise<void>;

export interface DaemonConnectSteps {
    /** Discover or spawn the daemon and remember where it is. Never stops one. */
    readonly connect: () => Promise<void>;
    /** Create the status socket, or re-point the existing one (never a second controller). */
    readonly startStatus: LaunchStep;
    /** Same for the web-pane host. */
    readonly startWebHost: LaunchStep;
    /** Stage-one replay (CONT-127): only meaningful once there is somewhere to send. */
    readonly drainPendingOpens: LaunchStep;
}

/**
 * Run every step, let each one's failure cost only itself, and report the ones that threw.
 *
 * This is the shape §APP-013's fan-out needs: the shipped app's `.appLaunched` is a `.merge` of
 * six effects, and `.merge` does not serialise them and does not let one cancel the others. A
 * bare `Promise.all` would do the first half and not the second — one rejection would abandon the
 * remaining settlements — so this awaits `allSettled` and hands the rejections back.
 */
async function fanOut(steps: readonly (readonly [string, LaunchStep])[]): Promise<readonly (readonly [string, unknown])[]> {
    const results = await Promise.allSettled(
        steps.map(async ([, step]) => {
            await step();
        })
    );
    const failures: (readonly [string, unknown])[] = [];
    results.forEach((result, index) => {
        if (result.status !== 'rejected') return;
        const name = steps[index]?.[0] ?? 'step';
        failures.push([name, result.reason]);
    });
    return failures;
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
    // The two sockets are independent of each other — a status controller does not need a web
    // host and vice versa; both need only the connection above — so they go out together
    // (§APP-013). The DRAIN still waits for both: it is the one step with a real dependency.
    const failures = await fanOut([
        ['status', steps.startStatus],
        ['web-host', steps.startWebHost]
    ]);
    // No `logError` on this seam, so a socket that threw must not be swallowed here: it goes up
    // to `startDaemonAndConnect`'s caller, exactly as it did when these two calls were bare.
    const first = failures[0];
    if (first !== undefined) throw first[1];
    await steps.drainPendingOpens();
}

export interface LaunchSteps {
    /** stack.md §1's permission handlers, installed before any content loads. */
    readonly applyPermissionPolicy: LaunchStep;
    readonly buildMenu: LaunchStep;
    /** `runDaemonConnectSequence` in production; rejects when no daemon can be reached. */
    readonly connectDaemon: () => Promise<void>;
    /** The fatal path: report and exit. Launch stops here — no window is created. */
    readonly reportDaemonUnavailable: (error: unknown) => void;
    /** SET-219: the web find palette is read before the first tab can exist. */
    readonly applyFindPalette: LaunchStep;
    readonly createWindow: LaunchStep;
    readonly registerGlobalHotkey: LaunchStep;
    /** APP-003/004. Best-effort: a throw here must not cost the user their window. */
    readonly runCliInstallPolicy: LaunchStep;
    /**
     * §APP-006: refresh the bundled agent documentation into `$HOME/.claude/skills/…`
     * (`./skill.ts` owns every rule about when that is allowed). Best-effort for the same
     * reason the CLI policy is — it writes outside the app, and a home that cannot be written
     * to must cost a log line rather than the launch.
     */
    readonly refreshBundledSkill: LaunchStep;
    readonly startUpdater: LaunchStep;
    readonly installQuitGate: LaunchStep;
    readonly logError: (message: string, error: unknown) => void;
}

export type LaunchOutcome = 'ready' | 'daemon-unavailable';

/**
 * `boot()`, as an order — and, where the order is not real, as a FAN-OUT (§APP-013/§APP-014).
 *
 * The shipped app's `.appLaunched` is a `.merge` of six effects: persisted state, settings,
 * keybindings, the general config, favourites and label presets all go out at once, and the
 * reducer takes each answer as it lands (`AppReducer.swift:1079-1117`). This shell's own six
 * launch-time loads — the daemon handshake, the find palette, the global-hotkey config, the CLI
 * symlink probe, the bundled-skill refresh and the updater — ran strictly one after another, so
 * every one of them paid for the one in front of it. They do not any more.
 *
 * What is still an ORDER, and why each one is real:
 *
 *  - **Permissions and the menu come first.** The permission handlers must exist before any
 *    content can load (stack.md §1), and both are pure main-process setup with nothing to wait on.
 *  - **The daemon comes before the window.** A window pointed at a daemon that is not there shows
 *    an error page and retries in a loop; the app reports and exits instead, and it must not
 *    create the window first (APP-001's step 2 before step 3). The find palette joins it in the
 *    same wave — it is independent of the daemon, but SET-219 requires it before the first web
 *    tab can exist, so it must land before the window too.
 *  - **The window comes before the four best-effort steps.** APP-003's "off the boot path's
 *    critical line": the CLI policy writes into `/usr/local/bin` and the skill refresh into
 *    `~/.claude`, exactly the kind of places that throw, and a throw must cost a log line rather
 *    than the user's window. They run TOGETHER now, each with its own failure, because none of
 *    the four is an input to any other.
 *  - **The quit gate does not wait for them.** It is installed the moment the window exists,
 *    ahead of the join, so a slow symlink probe on a busy machine cannot leave the app briefly
 *    unable to guard ⌘Q. The sequence still returns only once everything has settled.
 */
export async function runLaunchSequence(steps: LaunchSteps): Promise<LaunchOutcome> {
    await steps.applyPermissionPolicy();
    await steps.buildMenu();

    // Wave one: the daemon handshake and the find-palette read, together. The palette read is
    // local and quick; the handshake can spawn a process. Serialising them bought nothing.
    let daemonError: { readonly error: unknown } | null = null;
    const paletteFailures = await fanOut([
        [
            'daemon',
            async () => {
                try {
                    await steps.connectDaemon();
                } catch (error) {
                    daemonError = { error };
                }
            }
        ],
        ['find-palette', steps.applyFindPalette]
    ]);
    for (const [name, error] of paletteFailures) steps.logError(`${name} failed`, error);
    if (daemonError !== null) {
        steps.reportDaemonUnavailable((daemonError as { readonly error: unknown }).error);
        return 'daemon-unavailable';
    }

    await steps.createWindow();

    // Wave two: four independent best-effort steps. `fanOut` gives each its own failure, so one
    // of them throwing costs the other three nothing — the property the two separate `try`s used
    // to provide, kept while they stopped waiting on each other.
    const tail = fanOut([
        ['hotkey', steps.registerGlobalHotkey],
        ['cli-install', steps.runCliInstallPolicy],
        ['skill-refresh', steps.refreshBundledSkill],
        ['updater', steps.startUpdater]
    ]);
    await steps.installQuitGate();
    for (const [name, error] of await tail) steps.logError(`${name} failed`, error);
    return 'ready';
}
