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
    /** Show `view`; `reveal` brings it to the front, otherwise an open surface just follows it. */
    readonly present: (view: UpdateView, reveal: boolean) => void;
    /** Let the next quit through the agents-active quit gate (`quit.ts` ▸ `allowQuit`). */
    readonly allowQuit: () => void;
    /** The phase changed (the menu's row follows it). */
    readonly changed?: ((view: UpdateView) => void) | undefined;
    readonly log: (line: string) => void;
    /** Test seam for the download's own time limit. */
    readonly downloadTimeoutMs?: number | undefined;
}

export interface UpdateFlow {
    /** Kelpi ▸ Check for Updates… (`manual`), or the launch check with the setting on. */
    check(trigger: UpdateTrigger): Promise<void>;
    /** A button in the sheet or a native dialog. `shown` is the surface's business, not ours. */
    act(action: UpdateUserAction): void;
    /**
     * Squirrel reported an error outside a download this flow is waiting on (the listener
     * `downloadUpdate` holds covers a download). During a restart it means `quitAndInstall`
     * failed after it returned, so the restart becomes a failure with Retry; otherwise it is
     * logged, since nothing is waiting on it.
     */
    installerError(error: unknown): void;
    readonly view: UpdateView;
    readonly phase: UpdatePhase;
}

/** What a failure is about, which decides what Retry does. */
type FailedStage = 'check' | 'download' | 'install';

interface State {
    readonly phase: UpdatePhase;
    readonly update: AvailableUpdate | null;
    readonly message: string | null;
    readonly stage: FailedStage | null;
    readonly location: InstallLocation | null;
}

const IDLE: State = { phase: 'idle', update: null, message: null, stage: null, location: null };

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
    let state: State = IDLE;
    /**
     * Bumped whenever a new download starts or the flow leaves one, so a late answer from an
     * abandoned download (a retry started a second one) cannot move the state.
     */
    let downloadEpoch = 0;

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
            ...(note === undefined ? {} : { location: note })
        };
    };

    /** Move to `next`, log it, tell the menu, and show it. */
    const enter = (next: State, reveal: boolean, why: string): void => {
        const before = state.phase;
        state = next;
        const version = next.update === null ? '' : ` ${next.update.version}`;
        deps.log(`auto-update: ${before} -> ${next.phase}${version} (${why})`);
        const current = view();
        if (before !== next.phase) deps.changed?.(current);
        deps.present(current, reveal);
    };

    const startDownload = (update: AvailableUpdate): void => {
        const location = deps.location();
        deps.log(installLocationLogLine(location));
        if (location.kind === 'blocked') {
            // Offered again with the reason, rather than downloading something that cannot land.
            enter({ ...IDLE, phase: 'available', update, location }, true, 'Update Now refused: Kelpi cannot be replaced where it runs');
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
        void downloadUpdate(installer, update, deps.downloadTimeoutMs).then(
            () => {
                if (epoch !== downloadEpoch || state.phase !== 'downloading') {
                    deps.log(`auto-update: a download of ${update.version} finished after the flow moved on; ignored`);
                    return;
                }
                // #286's fix in one line: the download ENDS here, in a question. Nothing quits.
                enter({ ...IDLE, phase: 'ready', update, location }, true, 'downloaded; asking before restarting');
            },
            (error: unknown) => {
                if (epoch !== downloadEpoch || state.phase !== 'downloading') {
                    deps.log(`auto-update: a download of ${update.version} failed after the flow moved on: ${errorText(error)}`);
                    return;
                }
                enter(
                    { ...IDLE, phase: 'failed', update, stage: 'download', message: errorText(error) },
                    true,
                    `download failed: ${errorText(error)}`
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
            // the user has just asked for. The daemon is never touched (`quit.ts`).
            deps.allowQuit();
            deps.log(`auto-update: restarting into ${update.version} (quitAndInstall); the daemon keeps running`);
            deps.installer().quitAndInstall();
        } catch (error) {
            enter({ ...IDLE, phase: 'failed', update, stage: 'install', message: errorText(error) }, true, `restart failed: ${errorText(error)}`);
        }
    };

    const flow: UpdateFlow = {
        async check(trigger: UpdateTrigger): Promise<void> {
            const manual = trigger === 'manual';
            if (BUSY_PHASES.includes(state.phase)) {
                // #286 step 2: a second check during a download (or with one ready) shows where
                // things are. It never says "checking" about a download, and never starts a
                // second Squirrel download (`autoUpdater.checkForUpdates()` twice downloads twice).
                deps.log(`auto-update: ${trigger} check while ${state.phase}; showing the current state`);
                if (manual) deps.present(view(), true);
                return;
            }
            const support = deps.support();
            if (!support.ok) {
                deps.log(`auto-update: ${trigger} check skipped (${support.reason})`);
                if (manual) enter({ ...IDLE, phase: 'unsupported', message: support.reason }, true, 'this build cannot update');
                return;
            }
            // A launch check stays silent until it has something to offer, as it always has.
            enter({ ...IDLE, phase: 'checking' }, manual, `${trigger} check`);
            let reply: FeedReply;
            try {
                reply = await deps.fetchUpdate();
            } catch (error) {
                reply = { kind: 'error', message: errorText(error) };
            }
            if (state.phase !== 'checking') return; // a newer transition won (it cannot today; cheap to guard)
            if (reply.kind === 'error') {
                if (manual) {
                    enter({ ...IDLE, phase: 'failed', stage: 'check', message: reply.message }, true, `check failed: ${reply.message}`);
                } else {
                    enter(IDLE, false, `launch check failed: ${reply.message}`);
                }
                return;
            }
            if (reply.kind === 'none') {
                enter(manual ? { ...IDLE, phase: 'up-to-date' } : IDLE, manual, `${deps.currentVersion()} is the latest (${trigger} check)`);
                return;
            }
            const location = deps.location();
            deps.log(installLocationLogLine(location));
            enter({ ...IDLE, phase: 'available', update: reply.update, location }, true, `${trigger} check`);
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
                    if (state.stage === 'install' && state.update !== null) {
                        // The download is still with Squirrel; only the restart is tried again.
                        restart();
                        return;
                    }
                    if (state.stage === 'download' && state.update !== null) {
                        startDownload(state.update);
                        return;
                    }
                    enter(IDLE, false, 'retrying the check');
                    void flow.check('manual');
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

        installerError(error: unknown): void {
            deps.log(`auto-update: Squirrel reported an error while ${state.phase}: ${errorText(error)}`);
            if (state.phase !== 'restarting' || state.update === null) return;
            enter(
                { ...IDLE, phase: 'failed', update: state.update, stage: 'install', message: errorText(error) },
                true,
                `restart failed: ${errorText(error)}`
            );
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
