/**
 * Noticing that the daemon has gone, and noticing when one is back (#312).
 *
 * The shell used to find its daemon once, at launch. After that the window, the status socket and
 * the web host each retried the SAME URL forever: when the daemon was stopped on 2026-10-01 the
 * window reloaded a refused URL every 1.5 s, nothing said why, and only relaunching the app (which
 * runs discovery again) brought it back.
 *
 * This is the missing step. Any of those connections failing makes the daemon *suspect*, and
 * from then on the run dir is asked directly (`findDaemon`):
 *
 *   - **a daemon is serving**: maybe the same one, maybe a successor on a new port after
 *     `kelpid restart` or one a user started by hand. It is adopted: `adopt` re-points the
 *     connections and reloads the window when it has to.
 *   - **nothing is listening** for `stoppedAfterMs`: the daemon is stopped. `stopped` shows the
 *     window's "Kelpi's daemon has stopped" page, with a Start Daemon button. The run dir is
 *     still checked, more slowly, so a daemon started from a terminal is picked up by itself.
 *   - **something holds the socket but is not serving** (busy, or still starting): keep
 *     checking. A daemon that is restoring 40 panes is not a stopped one.
 *
 * It never starts a daemon. Someone who ran `kelpid stop` with the app open may want it to stay
 * stopped, so starting one is the button's job, never a timer's.
 *
 * Pure: the clock, the timers and the run-dir probe are injected, and `daemon-watch.test.ts`
 * drives it with fakes.
 */

import type { DaemonLocation, DaemonPresence } from './daemon.js';

export type DaemonWatchState = 'healthy' | 'checking' | 'stopped' | 'starting';

export interface DaemonWatchDeps {
    readonly find: () => Promise<DaemonPresence>;
    /** A daemon answered: point everything at it. */
    readonly adopt: (location: DaemonLocation) => void;
    /** Nothing has listened for `stoppedAfterMs`: show the stopped page. */
    readonly stopped: (runDir: string) => void;
    readonly log: (message: string) => void;
    readonly now: () => number;
    readonly setTimer: (callback: () => void, ms: number) => unknown;
    readonly clearTimer: (timer: unknown) => void;
}

export interface DaemonWatchOptions {
    /** How long nothing may listen before the daemon counts as stopped. */
    readonly stoppedAfterMs?: number;
    /** How often to look while it is only suspect. */
    readonly checkEveryMs?: number;
    /** How often to look once it is stopped (for a daemon started from a terminal). */
    readonly stoppedCheckEveryMs?: number;
}

export const DAEMON_STOPPED_AFTER_MS = 8_000;
export const DAEMON_CHECK_EVERY_MS = 2_000;
export const DAEMON_STOPPED_CHECK_EVERY_MS = 5_000;

export interface DaemonWatch {
    readonly state: DaemonWatchState;
    /** A connection to the daemon failed; start looking unless already looking. */
    suspect(reason: string): void;
    /** A connection to the daemon works again; stop looking. */
    healthy(): void;
    /** The user asked for a daemon to be started; stop looking until `healthy` or `startFailed`. */
    starting(): void;
    /** The start failed: the daemon is still stopped, keep looking slowly. */
    startFailed(): void;
    /** Stop every timer (the app is quitting). */
    dispose(): void;
}

export function createDaemonWatch(deps: DaemonWatchDeps, options: DaemonWatchOptions = {}): DaemonWatch {
    const stoppedAfterMs = options.stoppedAfterMs ?? DAEMON_STOPPED_AFTER_MS;
    const checkEveryMs = options.checkEveryMs ?? DAEMON_CHECK_EVERY_MS;
    const stoppedCheckEveryMs = options.stoppedCheckEveryMs ?? DAEMON_STOPPED_CHECK_EVERY_MS;

    let state: DaemonWatchState = 'healthy';
    let timer: unknown = null;
    /** When nothing was last seen listening for the first time; null while something was. */
    let goneSince: number | null = null;
    /** Bumped on every transition, so a probe that resolves late cannot act on an old state. */
    let generation = 0;
    let disposed = false;

    const cancel = (): void => {
        if (timer !== null) deps.clearTimer(timer);
        timer = null;
    };

    const schedule = (ms: number): void => {
        cancel();
        if (disposed) return;
        timer = deps.setTimer(() => {
            timer = null;
            void look();
        }, ms);
    };

    const look = async (): Promise<void> => {
        if (state !== 'checking' && state !== 'stopped') return;
        const asked = generation;
        let presence: DaemonPresence;
        try {
            presence = await deps.find();
        } catch (error) {
            presence = { kind: 'busy', runDir: '', reason: error instanceof Error ? error.message : String(error) };
        }
        if (asked !== generation || disposed) return;
        if (presence.kind === 'ready') {
            const was = state;
            state = 'healthy';
            generation += 1;
            goneSince = null;
            cancel();
            deps.log(
                `daemon watch: found pid=${String(presence.location.pid ?? 0)} ${presence.location.url}` +
                    (was === 'stopped' ? ' (it was stopped; reconnecting)' : '')
            );
            deps.adopt(presence.location);
            return;
        }
        if (presence.kind === 'busy') {
            goneSince = null;
            schedule(state === 'stopped' ? stoppedCheckEveryMs : checkEveryMs);
            return;
        }
        goneSince ??= deps.now();
        if (state === 'checking' && deps.now() - goneSince >= stoppedAfterMs) {
            state = 'stopped';
            generation += 1;
            deps.log(`daemon watch: nothing listening in ${presence.runDir} for ${String(stoppedAfterMs)}ms (${presence.reason}); the daemon is stopped`);
            deps.stopped(presence.runDir);
        }
        schedule(state === 'stopped' ? stoppedCheckEveryMs : checkEveryMs);
    };

    return {
        get state() {
            return state;
        },
        suspect(reason: string): void {
            if (disposed || state !== 'healthy') return;
            state = 'checking';
            generation += 1;
            goneSince = null;
            deps.log(`daemon watch: ${reason}; looking for a daemon`);
            schedule(0);
        },
        healthy(): void {
            if (state === 'healthy') return;
            state = 'healthy';
            generation += 1;
            goneSince = null;
            cancel();
        },
        starting(): void {
            state = 'starting';
            generation += 1;
            cancel();
        },
        startFailed(): void {
            if (disposed) return;
            state = 'stopped';
            generation += 1;
            schedule(stoppedCheckEveryMs);
        },
        dispose(): void {
            disposed = true;
            generation += 1;
            cancel();
        }
    };
}
