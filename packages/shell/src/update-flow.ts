/**
 * #286: the update flow as one state machine, with no Electron in it.
 *
 * Jordon's report, read against the code this replaced (`main.ts` ▸ `checkForUpdates` before
 * #286), explains every step of it:
 *
 *   1. **No feedback after Update Now.** The download's only sign was a macOS notification
 *      ("Downloading Kelpi X"), which notification permissions can suppress and a busy screen can
 *      hide. Squirrel.Mac reports no progress, and the ZIP is about 165 MB, so a silent minute
 *      or more was normal.
 *   2. **A second Check for Updates "is checking".** `updateCheckBusy` stayed set for the whole
 *      download, and a second check answered "Already checking for updates", which describes a
 *      download as a check.
 *   3. **The UI closed unexpectedly.** `downloadAndInstall` called `quitAndInstall()` the moment
 *      Squirrel said "downloaded": every window closed and the app quit, with no warning.
 *   4. **Reopened by hand, the same again, then "up to date".** Squirrel relaunches the app about
 *      ten seconds after it quits (7 to 13 s in our tests). A user who has just watched it vanish
 *      reopens it first, and ShipIt, which swaps the bundle only once no copy of the app is
 *      running, waits for THAT copy to quit. So the reopened app was still the old version, the
 *      check offered the same update again, and the second quit is when the install landed.
 *      (Step 4 is the likely reading, not a reproduction: ShipIt's own log,
 *      `~/Library/Caches/<bundle id>.ShipIt/ShipIt_stderr.log`, would settle it.)
 *
 * So the flow now:
 *
 *   - shows every state it is in (`present`), and the manual check reveals the current state
 *     rather than starting another check while one is running, downloading or ready (2);
 *   - shows "Downloading Kelpi X" with the promise that Kelpi asks before restarting (1);
 *   - NEVER quits when a download finishes: it stops at `ready` ("Kelpi X is ready. Restart Now /
 *     Later"), and only Restart Now calls `allowQuit` then `quitAndInstall` (3). Later leaves the
 *     update with Squirrel, which installs it when Kelpi next quits;
 *   - tells the user, in the ready sheet, that Kelpi closes and reopens by itself (4);
 *   - refuses Update Now up front when this copy of Kelpi runs from somewhere Squirrel cannot
 *     replace (`installLocation`), instead of downloading and failing;
 *   - logs every transition as an `auto-update:` line, so the next report can be read off the log.
 *
 * And, from the review of the first cut:
 *
 *   - a restart that fails is not pretended away. `allowQuit` only opens the quit gate (the
 *     teardown waits for `will-quit`), a failure re-arms it (`rearmQuit`), and the state says
 *     "Kelpi could not finish installing the update. Quit Kelpi and open it again" with a Quit
 *     button, since an app whose windows Squirrel has closed cannot retry in place. A restart
 *     still pending after `RESTART_TIMEOUT_MS` is that failure too;
 *   - a slow download is "still downloading", never a failure, and Squirrel's `update-downloaded`
 *     reaches the flow through a standing listener whenever it comes, so a late finish is never
 *     lost. Retry never starts a second Squirrel download while one may be running;
 *   - a manual check that joins a running launch check is answered (`manualWaiting`);
 *   - a state nobody asked for right now (a launch-check offer, a finished or failed download) is
 *     `prompted: false`, so the shell notifies instead of pulling a hidden window forward.
 *
 * How a state is SHOWN (the in-app sheet, or a native dialog parented to the window when no page
 * answers) is `./update-surface.ts` and `main.ts`; this module only says what to show and whether
 * to bring it to the front (`reveal`).
 */

import type { UpdateLocationNote, UpdatePhase, UpdateUserAction, UpdateView } from '@kelpi/protocol';

import {
    downloadUpdate,
    installLocationLogLine,
    type AvailableUpdate,
    type FeedReply,
    type InstallLocation,
    type Installer,
    type UpdateSupport
} from './updater.js';

export type UpdateTrigger = 'launch' | 'manual';

/**
 * How long Restart Now may leave the flow in `restarting` before it calls the restart failed.
 * Squirrel quits within a second or two when it works; a minute is only ever a restart that is
 * not going to happen.
 */
export const RESTART_TIMEOUT_MS = 60_000;

export interface UpdateFlowDeps {
    /** The version running now. */
    readonly currentVersion: () => string;
    /** Whether this build can update at all (`updater.ts` ▸ `updateSupport`). */
    readonly support: () => UpdateSupport;
    /** Read the feed (`updater.ts` ▸ `fetchUpdate` against `feedURL`). */
    readonly fetchUpdate: () => Promise<FeedReply>;
    /** Electron's `autoUpdater`, or the harness's stand-in (`./update-audit.ts`). */
    readonly installer: () => Installer;
    /** Where this copy of Kelpi runs from (`updater.ts` ▸ `installLocation`). */
    readonly location: () => InstallLocation;
    /**
     * Show `view`. `reveal` brings it to the front, otherwise an open surface just follows it.
     * `prompted` says whether the user is waiting on it right now (a check they asked for, a
     * button they pressed); an unprompted reveal (a launch-check offer, a finished download) must
     * not pull a hidden window forward.
     */
    readonly present: (view: UpdateView, reveal: boolean, prompted: boolean) => void;
    /** Open the agents-active quit gate for the restart (`quit.ts` ▸ `allowQuit`); tears nothing down. */
    readonly allowQuit: () => void;
    /** Close the gate again: the restart did not happen (`quit.ts` ▸ `rearm`). */
    readonly rearmQuit: () => void;
    /** Quit Kelpi the ordinary way (the failed-install state's Quit button). */
    readonly quit: () => void;
    /** The phase changed (the menu's row follows it). */
    readonly changed?: ((view: UpdateView) => void) | undefined;
    readonly log: (line: string) => void;
    /** When a download counts as slow (`updater.ts` ▸ `DOWNLOAD_SLOW_MS`); read per download. */
    readonly downloadSlowMs?: (() => number | undefined) | undefined;
    readonly restartTimeoutMs?: number | undefined;
    readonly setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
    readonly clearTimer?: ((timer: unknown) => void) | undefined;
}

export interface UpdateFlow {
    /** Kelpi ▸ Check for Updates… (`manual`), or the launch check with the setting on. */
    check(trigger: UpdateTrigger): Promise<void>;
    /** A button in the sheet or a native dialog. `shown` is the surface's business, not ours. */
    act(action: UpdateUserAction): void;
    /** Show the current state again, as something the user asked for (a clicked notification). */
    show(): void;
    /**
     * Squirrel reported an error (a standing listener, so it arrives whatever the flow is
     * waiting on). During a restart it means the install failed; otherwise it ends any download
     * Squirrel was running, and a download this flow is waiting on fails through its own listener.
     */
    installerError(error: unknown): void;
    /**
     * Squirrel finished a download (a standing listener). A download the flow is waiting on, or one
     * it had given up on, becomes `ready`; a late finish is never lost.
     */
    installerDownloaded(): void;
    readonly view: UpdateView;
    readonly phase: UpdatePhase;
}

/** What a failure is about, which decides what the failed state offers. */
type FailedStage = 'check' | 'download' | 'install';

interface State {
    readonly phase: UpdatePhase;
    readonly update: AvailableUpdate | null;
    readonly message: string | null;
    readonly stage: FailedStage | null;
    readonly location: InstallLocation | null;
    /** `downloading` past its expected time. */
    readonly slow: boolean;
}

const IDLE: State = { phase: 'idle', update: null, message: null, stage: null, location: null, slow: false };

/** The phases in which a manual check shows what is happening instead of checking again. */
const BUSY_PHASES: readonly UpdatePhase[] = ['checking', 'downloading', 'ready', 'restarting'];

function errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.trim() === '' ? 'Something went wrong, and Squirrel did not say what.' : text.trim();
}

function locationNote(location: InstallLocation | null): UpdateLocationNote | undefined {
    if (location === null || location.kind === 'ok') return undefined;
    return { blocked: location.kind === 'blocked', message: location.message };
}

export function createUpdateFlow(deps: UpdateFlowDeps): UpdateFlow {
    const setTimer =
        deps.setTimer ??
        ((run: () => void, ms: number): unknown => {
            const timer = setTimeout(run, ms);
            timer.unref?.();
            return timer;
        });
    const clearTimer = deps.clearTimer ?? ((timer: unknown): void => clearTimeout(timer as ReturnType<typeof setTimeout>));
    let state: State = IDLE;
    /**
     * Bumped whenever a new download starts, so a late answer from an earlier one (a retry started
     * a second one) cannot move the state through ITS listener. Squirrel's own finish still
     * arrives through the standing listener (`installerDownloaded`).
     */
    let downloadEpoch = 0;
    /** A manual check joined the running check: its answer is revealed whatever started it. */
    let manualWaiting = false;
    /**
     * Squirrel may still be fetching: set when a download starts, cleared only by Squirrel's own
     * answer (downloaded, error, not available). While set, Retry and Update Now wait for the
     * running download instead of calling `checkForUpdates` again, which would start a second.
     */
    let squirrelBusy = false;
    let restartTimer: unknown = null;
    const watched = new WeakSet<object>();

    const view = (): UpdateView => {
        const update = state.update;
        const note = locationNote(state.location);
        return {
            phase: state.phase,
            currentVersion: deps.currentVersion(),
            ...(update === null ? {} : { version: update.version }),
            ...(update === null || update.notes === '' ? {} : { notes: update.notes }),
            ...(state.message === null ? {} : { message: state.message }),
            ...(state.phase === 'failed' && state.stage !== null ? { retry: state.stage } : {}),
            ...(note === undefined ? {} : { location: note }),
            ...(state.phase === 'downloading' && state.slow ? { slow: true } : {})
        };
    };

    /** Move to `next`, log it, tell the menu, and show it. */
    const enter = (next: State, reveal: boolean, why: string, prompted = true): void => {
        const before = state.phase;
        state = next;
        const version = next.update === null ? '' : ` ${next.update.version}`;
        deps.log(`auto-update: ${before} -> ${next.phase}${version} (${why})`);
        const current = view();
        if (before !== next.phase) deps.changed?.(current);
        deps.present(current, reveal, prompted);
    };

    /** Squirrel's answers reach the flow whatever it is waiting on (see `installerDownloaded`). */
    const watch = (installer: Installer): void => {
        if (watched.has(installer)) return;
        watched.add(installer);
        installer.on('error', (error: unknown) => flow.installerError(error));
        installer.on('update-downloaded', () => flow.installerDownloaded());
        installer.on('update-not-available', () => {
            squirrelBusy = false;
        });
    };

    const stopRestartTimer = (): void => {
        if (restartTimer !== null) clearTimer(restartTimer);
        restartTimer = null;
    };

    /**
     * The restart did not happen. Squirrel may have closed every window already, so this is not a
     * state to Retry from: the gate is re-armed (the next ⌘Q asks as usual) and the user is told to
     * quit and reopen, with a Quit button. Revealed as prompted, since they just pressed Restart.
     */
    const installFailed = (reason: string): void => {
        stopRestartTimer();
        deps.rearmQuit();
        deps.log(`auto-update: the install did not happen: ${reason}`);
        enter({ ...IDLE, phase: 'failed', update: state.update, stage: 'install', message: reason }, true, `install failed: ${reason}`);
    };

    const startDownload = (update: AvailableUpdate): void => {
        const location = deps.location();
        deps.log(installLocationLogLine(location));
        if (location.kind === 'blocked') {
            // Offered again with the reason, rather than downloading something that cannot land.
            enter({ ...IDLE, phase: 'available', update, location }, true, 'Update Now refused: Kelpi cannot be replaced where it runs');
            return;
        }
        if (squirrelBusy) {
            // Squirrel is still on the earlier download; a second `checkForUpdates` would start a
            // second one. Its finish arrives through the standing listener.
            enter({ ...IDLE, phase: 'downloading', update, location, slow: true }, true, 'a download is still running; waiting for it');
            return;
        }
        downloadEpoch += 1;
        const epoch = downloadEpoch;
        enter({ ...IDLE, phase: 'downloading', update, location }, true, 'Update Now');
        let installer: Installer;
        try {
            installer = deps.installer();
        } catch (error) {
            enter({ ...IDLE, phase: 'failed', update, stage: 'download', message: errorText(error) }, true, 'the updater could not start');
            return;
        }
        watch(installer);
        squirrelBusy = true;
        const onSlow = (): void => {
            if (epoch !== downloadEpoch || state.phase !== 'downloading' || state.slow) return;
            // Still waiting, not failed: Squirrel is still fetching, and its finish will count.
            enter({ ...state, slow: true }, false, 'taking longer than expected; still waiting');
        };
        void downloadUpdate(installer, update, { slowMs: deps.downloadSlowMs?.(), onSlow }).then(
            () => {
                // Normally the standing listener has already moved the flow to `ready`.
                if (epoch === downloadEpoch && state.phase === 'downloading') flow.installerDownloaded();
            },
            (error: unknown) => {
                squirrelBusy = false;
                if (epoch !== downloadEpoch || state.phase !== 'downloading') {
                    deps.log(`auto-update: a download of ${update.version} failed after the flow moved on: ${errorText(error)}`);
                    return;
                }
                enter(
                    { ...IDLE, phase: 'failed', update, stage: 'download', message: errorText(error) },
                    true,
                    `download failed: ${errorText(error)}`,
                    false
                );
            }
        );
    };

    const restart = (): void => {
        const update = state.update;
        if (update === null) return;
        enter({ ...state, phase: 'restarting' }, false, 'Restart Now');
        try {
            // In this order: the gate first, or the agents-active confirmation would stop a quit
            // the user has just asked for. Opening it tears nothing down (`quit.ts`), and the
            // daemon is never touched.
            deps.allowQuit();
            deps.log(`auto-update: restarting into ${update.version} (quitAndInstall); the daemon keeps running`);
            restartTimer = setTimer(() => {
                restartTimer = null;
                if (state.phase !== 'restarting') return;
                const seconds = String(Math.round((deps.restartTimeoutMs ?? RESTART_TIMEOUT_MS) / 1000));
                installFailed(`Kelpi did not quit to install the update within ${seconds} seconds.`);
            }, deps.restartTimeoutMs ?? RESTART_TIMEOUT_MS);
            const installer = deps.installer();
            watch(installer);
            installer.quitAndInstall();
        } catch (error) {
            installFailed(errorText(error));
        }
    };

    const flow: UpdateFlow = {
        async check(trigger: UpdateTrigger): Promise<void> {
            const manual = trigger === 'manual';
            if (state.phase === 'checking' && manual) {
                // A manual check joining a running (launch) check: the answer is now for someone
                // who is waiting, so it is revealed whatever it turns out to be.
                manualWaiting = true;
                deps.log('auto-update: manual check while checking; its answer will be shown');
                deps.present(view(), true, true);
                return;
            }
            if (BUSY_PHASES.includes(state.phase)) {
                // #286 step 2: a second check during a download (or with one ready) shows where
                // things are. It never says "checking" about a download, and never starts a
                // second Squirrel download (`autoUpdater.checkForUpdates()` twice downloads twice).
                deps.log(`auto-update: ${trigger} check while ${state.phase}; showing the current state`);
                if (manual) deps.present(view(), true, true);
                return;
            }
            const support = deps.support();
            if (!support.ok) {
                deps.log(`auto-update: ${trigger} check skipped (${support.reason})`);
                if (manual) enter({ ...IDLE, phase: 'unsupported', message: support.reason }, true, 'this build cannot update');
                return;
            }
            // A launch check stays silent until it has something to offer, as it always has.
            manualWaiting = manual;
            enter({ ...IDLE, phase: 'checking' }, manual, `${trigger} check`);
            let reply: FeedReply;
            try {
                reply = await deps.fetchUpdate();
            } catch (error) {
                reply = { kind: 'error', message: errorText(error) };
            }
            if (state.phase !== 'checking') return; // a newer transition won (it cannot today; cheap to guard)
            const answer = manualWaiting;
            manualWaiting = false;
            const asked = answer ? 'manual' : 'launch';
            if (reply.kind === 'error') {
                if (answer) {
                    enter({ ...IDLE, phase: 'failed', stage: 'check', message: reply.message }, true, `check failed: ${reply.message}`);
                } else {
                    enter(IDLE, false, `launch check failed: ${reply.message}`);
                }
                return;
            }
            if (reply.kind === 'none') {
                enter(answer ? { ...IDLE, phase: 'up-to-date' } : IDLE, answer, `${deps.currentVersion()} is the latest (${asked} check)`);
                return;
            }
            const location = deps.location();
            deps.log(installLocationLogLine(location));
            // A launch-check offer is revealed but unprompted: nobody is waiting on it.
            enter({ ...IDLE, phase: 'available', update: reply.update, location }, true, `${asked} check`, answer);
        },

        act(action: UpdateUserAction): void {
            const phase = state.phase;
            deps.log(`auto-update: "${action}" while ${phase}`);
            switch (action) {
                case 'shown':
                    return;
                case 'update-now':
                    if (phase === 'available' && state.update !== null) startDownload(state.update);
                    return;
                case 'restart':
                    if (phase === 'ready') restart();
                    return;
                case 'retry':
                    if (phase !== 'failed') return;
                    if (state.stage === 'download' && state.update !== null) {
                        startDownload(state.update);
                        return;
                    }
                    // A failed install is not retried in place: its state offers Quit instead.
                    if (state.stage === 'install') return;
                    enter(IDLE, false, 'retrying the check');
                    void flow.check('manual');
                    return;
                case 'quit':
                    if (phase === 'failed' && state.stage === 'install') {
                        deps.log('auto-update: quitting so the update can finish (or be offered again) on the next launch');
                        deps.quit();
                    }
                    return;
                case 'later':
                case 'dismiss':
                    if (phase === 'available') {
                        enter(IDLE, false, `${state.update?.version ?? 'the update'} deferred ("Later"); the next check offers it again`);
                    } else if (phase === 'ready') {
                        // Stays ready: the menu keeps offering Restart to Update, and Squirrel
                        // installs the download when Kelpi next quits.
                        deps.log(
                            `auto-update: restart deferred ("Later"); ${state.update?.version ?? 'the update'} installs when Kelpi next quits`
                        );
                    } else if (phase === 'up-to-date' || phase === 'failed' || phase === 'unsupported') {
                        enter(IDLE, false, 'dismissed');
                    }
                    // `downloading` keeps downloading and `checking` keeps checking: the sheet
                    // closes, and the result opens it again when it arrives.
                    return;
            }
        },

        show(): void {
            if (state.phase === 'idle') return;
            deps.present(view(), true, true);
        },

        installerError(error: unknown): void {
            deps.log(`auto-update: Squirrel reported an error while ${state.phase}: ${errorText(error)}`);
            squirrelBusy = false;
            if (state.phase === 'restarting') installFailed(errorText(error));
        },

        installerDownloaded(): void {
            squirrelBusy = false;
            const update = state.update;
            const waiting = state.phase === 'downloading' || (state.phase === 'failed' && state.stage === 'download');
            if (!waiting || update === null) {
                deps.log(`auto-update: Squirrel finished a download while ${state.phase}; nothing was waiting on it`);
                return;
            }
            // #286's fix in one line: the download ENDS here, in a question. Nothing quits.
            enter({ ...IDLE, phase: 'ready', update, location: state.location }, true, 'downloaded; asking before restarting', false);
        },

        get view(): UpdateView {
            return view();
        },
        get phase(): UpdatePhase {
            return state.phase;
        }
    };
    return flow;
}
