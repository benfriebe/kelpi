/**
 * The launch sequence's rules, driven (gap #6: CONT-125, CONT-127, APP-004, APP-101).
 *
 * Everything here is about ORDER — what runs before what, what is held back until something
 * else has happened, and what a failure in one step costs the steps after it. Those are the
 * claims `main.ts` could only make in prose while the sequencing lived inside a module vitest
 * cannot import, and they are the ones that break silently when a line moves.
 */

import { describe, expect, it } from 'vitest';

import type { CliInstallPlan, CliInstallResult } from './cli-install.js';
import {
    createOpenFileQueue,
    runCliInstallPolicy,
    runDaemonConnectSequence,
    runLaunchSequence,
    type CliInstallPolicyDeps,
    type LaunchSteps,
    type OpenFileRequest
} from './launch.js';

// ---------------------------------------------------------------------------
// CONT-125 / CONT-127 / APP-101 — the cold-launch file queue
// ---------------------------------------------------------------------------

interface QueueHarness {
    readonly sent: OpenFileRequest[];
    readonly activations: number[];
    ready: boolean;
}

function queueHarness(): { harness: QueueHarness; queue: ReturnType<typeof createOpenFileQueue> } {
    const harness: QueueHarness = { sent: [], activations: [], ready: false };
    const queue = createOpenFileQueue({
        ready: () => harness.ready,
        send: (request) => {
            harness.sent.push(request);
        },
        activate: () => {
            harness.activations.push(harness.sent.length);
        }
    });
    return { harness, queue };
}

describe('the Finder open queue (CONT-127 stage one, APP-101)', () => {
    it('parks a file that arrives before the daemon connection, and raises nothing', () => {
        const { harness, queue } = queueHarness();

        queue.forward('/tmp/notes.md');

        expect(harness.sent).toEqual([]);
        // CONT-125's activation belongs to a file that actually went out. There is no window to
        // raise during a cold launch, and raising one later for a file the user opened minutes
        // ago would steal focus twice.
        expect(harness.activations).toEqual([]);
        expect(queue.pending()).toEqual(['/tmp/notes.md']);
    });

    it('replays the parked files in ARRIVAL order once the connection is up', () => {
        const { harness, queue } = queueHarness();
        queue.forward('/tmp/first.md');
        queue.forward('/tmp/second.md');
        queue.forward('/tmp/third.md');

        harness.ready = true;
        queue.drain();

        expect(harness.sent.map((request) => request.path)).toEqual([
            '/tmp/first.md',
            '/tmp/second.md',
            '/tmp/third.md'
        ]);
        expect(queue.pending()).toEqual([]);
        // One raise per file that went out, and each one after its send.
        expect(harness.activations).toEqual([1, 2, 3]);
    });

    it('drains snapshot-and-clear, so a file arriving mid-replay is not replayed twice', () => {
        const harness: QueueHarness = { sent: [], activations: [], ready: false };
        let reentrant = true;
        const queue = createOpenFileQueue({
            ready: () => harness.ready,
            send: (request) => {
                harness.sent.push(request);
                // A second Finder event lands while the first parked file is going out.
                if (reentrant && request.path === '/tmp/a.md') {
                    reentrant = false;
                    queue.forward('/tmp/mid.md');
                }
            },
            activate: () => {
                harness.activations.push(harness.sent.length);
            }
        });

        queue.forward('/tmp/a.md');
        queue.forward('/tmp/b.md');
        harness.ready = true;
        queue.drain();

        // `a` exactly once — the queue it was replayed from was taken before the replay started,
        // so the re-entrant forward could not append into the list being iterated.
        expect(harness.sent.map((request) => request.path)).toEqual(['/tmp/a.md', '/tmp/mid.md', '/tmp/b.md']);
        expect(queue.pending()).toEqual([]);
        queue.drain();
        expect(harness.sent).toHaveLength(3);
    });

    it('re-parks rather than dropping when the drain finds the connection still down', () => {
        const { harness, queue } = queueHarness();
        queue.forward('/tmp/one.md');
        queue.forward('/tmp/two.md');

        queue.drain(); // the daemon is still absent

        expect(harness.sent).toEqual([]);
        expect(queue.pending()).toEqual(['/tmp/one.md', '/tmp/two.md']);

        harness.ready = true;
        queue.drain();
        expect(harness.sent.map((request) => request.path)).toEqual(['/tmp/one.md', '/tmp/two.md']);
    });

    it('sends a file that arrives with the connection up, and raises the window for it (CONT-125)', () => {
        const { harness, queue } = queueHarness();
        harness.ready = true;

        queue.forward('/tmp/open-me.md');

        expect(harness.sent).toEqual([{ path: '/tmp/open-me.md', paneID: null }]);
        expect(harness.activations).toEqual([1]);
        expect(queue.pending()).toEqual([]);
    });

    it('carries the asking pane on the ⌘O route and none on the Finder route', () => {
        const { harness, queue } = queueHarness();
        harness.ready = true;

        queue.forward('/tmp/from-pane.md', 'pane-7');
        queue.forward('/tmp/from-finder.md');

        expect(harness.sent).toEqual([
            { path: '/tmp/from-pane.md', paneID: 'pane-7' },
            { path: '/tmp/from-finder.md', paneID: null }
        ]);
    });

    it('is a no-op on an empty queue', () => {
        const { harness, queue } = queueHarness();
        harness.ready = true;

        queue.drain();

        expect(harness.sent).toEqual([]);
        expect(harness.activations).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// APP-003 / APP-004 / APP-005 — heal first, offer only when there is nothing
// ---------------------------------------------------------------------------

function planFor(action: CliInstallPlan['action']): CliInstallPlan {
    return {
        action,
        linkPath: '/sandbox/bin/nex',
        target: '/sandbox/Nex.app/Contents/Resources/cli/nex',
        manualCommand: 'sudo ln -sfn /sandbox/Nex.app/Contents/Resources/cli/nex /sandbox/bin/nex'
    };
}

interface PolicyHarness {
    readonly calls: string[];
    readonly reported: CliInstallResult[];
    deps: CliInstallPolicyDeps;
}

function policyHarness(
    healResult: CliInstallResult,
    overrides: Partial<CliInstallPolicyDeps> = {}
): PolicyHarness {
    const calls: string[] = [];
    const reported: CliInstallResult[] = [];
    const deps: CliInstallPolicyDeps = {
        env: {},
        isPackaged: true,
        alreadyPrompted: false,
        target: '/sandbox/Nex.app/Contents/Resources/cli/nex',
        linkPath: '/sandbox/bin/nex',
        heal: () => {
            calls.push('heal');
            return healResult;
        },
        installNow: () => {
            calls.push('install');
        },
        report: (result) => {
            calls.push('report');
            reported.push(result);
        },
        offer: () => {
            calls.push('offer');
        },
        log: (message) => {
            calls.push(`log:${message}`);
        },
        ...overrides
    };
    return { calls, reported, deps };
}

describe('the launch-time CLI policy (APP-004)', () => {
    it('a dev run (unpackaged) never touches /usr/local/bin', () => {
        const { calls, deps } = policyHarness({ kind: 'ok', plan: planFor('ok') }, { isPackaged: false });

        const outcome = runCliInstallPolicy(deps);

        expect(outcome).toEqual({ kind: 'off', mode: 'off' });
        expect(calls).toEqual(['log:cli-install: disabled for this run']);
    });

    it('NEX_CLI_INSTALL=off is honoured inside a packaged app', () => {
        const { calls, deps } = policyHarness(
            { kind: 'ok', plan: planFor('ok') },
            { env: { NEX_CLI_INSTALL: 'off' } }
        );

        expect(runCliInstallPolicy(deps).kind).toBe('off');
        expect(calls.filter((call) => call === 'heal')).toEqual([]);
    });

    it('a build with no CLI payload stops before the heal, and says why', () => {
        const { calls, deps } = policyHarness({ kind: 'ok', plan: planFor('ok') }, { target: '' });

        expect(runCliInstallPolicy(deps).kind).toBe('no-payload');
        expect(calls).toEqual(['log:cli-install: no CLI payload in this build']);
    });

    it('auto installs without asking anybody', () => {
        const { calls, deps } = policyHarness(
            { kind: 'ok', plan: planFor('ok') },
            { env: { NEX_CLI_INSTALL: 'auto' } }
        );

        expect(runCliInstallPolicy(deps)).toEqual({ kind: 'installed', mode: 'auto' });
        expect(calls).toEqual(['install']);
        expect(calls).not.toContain('offer');
    });

    it('heals FIRST, and offers only because the heal said there is nothing installed', () => {
        const healed: CliInstallResult = {
            kind: 'skipped',
            plan: planFor('absent'),
            reason: 'the global CLI is not installed (nothing to heal)'
        };
        const { calls, reported, deps } = policyHarness(healed);

        const outcome = runCliInstallPolicy(deps);

        // The order is the rule: the offer is gated on the heal's own answer, never on a second
        // probe that could disagree with it.
        expect(calls).toEqual(['heal', 'report', 'offer']);
        expect(reported).toEqual([healed]);
        expect(outcome).toMatchObject({ kind: 'healed', mode: 'prompt', offered: true });
    });

    it('never asks a user who already has the CLI installed', () => {
        for (const healed of [
            { kind: 'ok', plan: planFor('ok') } as CliInstallResult,
            { kind: 'linked', plan: planFor('drifted') } as CliInstallResult,
            { kind: 'skipped', plan: planFor('foreign'), reason: 'not ours' } as CliInstallResult,
            { kind: 'blocked', plan: planFor('drifted'), reason: 'not writable' } as CliInstallResult
        ]) {
            const { calls, deps } = policyHarness(healed);

            const outcome = runCliInstallPolicy(deps);

            expect(calls).toEqual(['heal', 'report']);
            expect(outcome).toMatchObject({ offered: false });
        }
    });

    it('an install that has already been offered once heals silently forever after', () => {
        const healed: CliInstallResult = {
            kind: 'skipped',
            plan: planFor('absent'),
            reason: 'the global CLI is not installed (nothing to heal)'
        };
        const { calls, deps } = policyHarness(healed, { alreadyPrompted: true });

        const outcome = runCliInstallPolicy(deps);

        expect(outcome).toMatchObject({ mode: 'heal', offered: false });
        expect(calls).toEqual(['heal', 'report']);
    });
});

// ---------------------------------------------------------------------------
// APP-001 / APP-101 — boot ordering
// ---------------------------------------------------------------------------

function launchHarness(overrides: Partial<LaunchSteps> = {}): { calls: string[]; steps: LaunchSteps } {
    const calls: string[] = [];
    const record =
        (name: string) =>
        (): void => {
            calls.push(name);
        };
    const steps: LaunchSteps = {
        applyPermissionPolicy: record('permissions'),
        buildMenu: record('menu'),
        connectDaemon: async () => {
            calls.push('daemon');
            await Promise.resolve();
        },
        reportDaemonUnavailable: () => {
            calls.push('daemon-unavailable');
        },
        applyFindPalette: record('find-palette'),
        createWindow: record('window'),
        registerGlobalHotkey: record('hotkey'),
        runCliInstallPolicy: record('cli-install'),
        refreshBundledSkill: record('skill-refresh'),
        startUpdater: record('updater'),
        installQuitGate: record('quit-gate'),
        logError: (message) => {
            calls.push(`error:${message}`);
        },
        ...overrides
    };
    return { calls, steps };
}

describe('the launch order (APP-001, APP-101)', () => {
    it('runs the phases in the order the shell documents', async () => {
        const { calls, steps } = launchHarness();

        await expect(runLaunchSequence(steps)).resolves.toBe('ready');

        // The ORDER claims, unchanged by the fan-out below: permissions and the menu first, the
        // daemon before the window, the four best-effort steps after it. Within a wave the
        // relative order is the order they are STARTED in, which is stable.
        expect(calls).toEqual([
            'permissions',
            'menu',
            'daemon',
            'find-palette',
            'window',
            'hotkey',
            'cli-install',
            'skill-refresh',
            'updater',
            'quit-gate'
        ]);
    });

    it('a daemon it cannot reach stops the launch BEFORE a window exists', async () => {
        const { calls, steps } = launchHarness({
            connectDaemon: () => Promise.reject(new Error('no daemon'))
        });

        await expect(runLaunchSequence(steps)).resolves.toBe('daemon-unavailable');

        // The find-palette read rides in the same wave as the handshake, so it HAS run by the
        // time the refusal is reported — it is local, cheap and harmless. What must not have
        // happened is the window and the quit gate.
        // (`daemon` is absent because this harness REPLACES the recording connect step.)
        expect(calls).toEqual(['permissions', 'menu', 'find-palette', 'daemon-unavailable']);
        expect(calls).not.toContain('window');
        expect(calls).not.toContain('quit-gate');
    });

    it('a CLI policy that throws costs a log line, not the launch — and not the skill refresh', async () => {
        const { calls, steps } = launchHarness({
            runCliInstallPolicy: () => {
                throw new Error('/usr/local/bin is read-only');
            }
        });

        await expect(runLaunchSequence(steps)).resolves.toBe('ready');

        // Every other step in the wave still ran; the failure is reported after the join, so it
        // lands at the end rather than in the middle of the wave it belonged to.
        expect(calls).toContain('skill-refresh');
        expect(calls).toContain('updater');
        expect(calls).toContain('hotkey');
        expect(calls).toContain('quit-gate');
        expect(calls).toContain('error:cli-install failed');
        expect(calls).not.toContain('error:skill-refresh failed');
    });

    it('a documentation-refresh step that throws costs a log line either (APP-006’s slot)', async () => {
        const { calls, steps } = launchHarness({
            refreshBundledSkill: () => {
                throw new Error('EROFS');
            }
        });

        await expect(runLaunchSequence(steps)).resolves.toBe('ready');

        expect(calls).toContain('cli-install');
        expect(calls).toContain('updater');
        expect(calls).toContain('quit-gate');
        expect(calls).toContain('error:skill-refresh failed');
        expect(calls).not.toContain('error:cli-install failed');
    });

    it('reports EVERY failure in a wave, not just the first (APP-013’s `.merge`, not `Promise.all`)', async () => {
        const { calls, steps } = launchHarness({
            runCliInstallPolicy: () => {
                throw new Error('EACCES');
            },
            refreshBundledSkill: () => {
                throw new Error('EROFS');
            },
            registerGlobalHotkey: () => {
                throw new Error('taken');
            }
        });

        await expect(runLaunchSequence(steps)).resolves.toBe('ready');

        // A bare `Promise.all` would have abandoned the rest on the first rejection; a `.merge`
        // does not, and neither does this.
        expect(calls).toContain('error:hotkey failed');
        expect(calls).toContain('error:cli-install failed');
        expect(calls).toContain('error:skill-refresh failed');
        expect(calls).toContain('updater');
        expect(calls).toContain('quit-gate');
    });
});

// ---------------------------------------------------------------------------
// APP-013 / APP-014 / APP-116 — the launch FAN-OUT
// ---------------------------------------------------------------------------

/**
 * The shipped app's `.appLaunched` is a `.merge` of six effects (`AppReducer.swift:1079-1117`):
 * six loads go out at once and the reducer takes each answer as it lands. The port's launch ran
 * its own six one after another, so each paid for the one in front of it.
 *
 * A "did they run concurrently?" claim cannot be settled by looking at the call order — a
 * sequential run and a concurrent one START in the same order. What separates them is whether a
 * later step can BEGIN before an earlier one has FINISHED, so every test below instruments both
 * edges (`+name` on entry, `-name` on resolution) and hands back deferred promises whose
 * resolution order is deliberately the reverse of their start order. Under a sequential
 * implementation none of these can pass: the harness would deadlock or the trace would pair up.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => {};
    const promise = new Promise<void>((settle) => {
        resolve = () => {
            settle();
        };
    });
    return { promise, resolve };
}

/**
 * Let the sequence get as far as it can without settling anything.
 *
 * A macrotask boundary rather than a counted number of `await Promise.resolve()`s: the number of
 * microtask ticks between "the wave started" and "every member has been entered" is an
 * implementation detail of how many `await`s the sequence takes to get there, and a test that
 * counts them fails for the wrong reason the moment one is added.
 */
const settleTurn = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('the launch fan-out (APP-013, APP-014, APP-116)', () => {
    it('starts the daemon handshake and the find-palette read TOGETHER', async () => {
        const trace: string[] = [];
        const daemonGate = deferred();
        const paletteStarted = deferred();

        const { steps } = launchHarness({
            connectDaemon: async () => {
                trace.push('+daemon');
                // Deadlocks under a sequential implementation: nothing resolves this until the
                // palette step below has RUN, which a sequential launch would not reach.
                await paletteStarted.promise;
                await daemonGate.promise;
                trace.push('-daemon');
            },
            applyFindPalette: () => {
                trace.push('+palette');
                paletteStarted.resolve();
                trace.push('-palette');
            }
        });

        const run = runLaunchSequence(steps);
        await paletteStarted.promise;
        // The palette has been read while the handshake is still in flight.
        expect(trace).toEqual(['+daemon', '+palette', '-palette']);
        daemonGate.resolve();
        await expect(run).resolves.toBe('ready');
        expect(trace).toEqual(['+daemon', '+palette', '-palette', '-daemon']);
    });

    it('waits for BOTH before the window — SET-219’s palette and APP-001’s daemon', async () => {
        const trace: string[] = [];
        const daemonGate = deferred();
        const paletteGate = deferred();

        const { steps } = launchHarness({
            connectDaemon: async () => {
                await daemonGate.promise;
                trace.push('-daemon');
            },
            applyFindPalette: async () => {
                await paletteGate.promise;
                trace.push('-palette');
            },
            createWindow: () => {
                trace.push('window');
            }
        });

        const run = runLaunchSequence(steps);
        daemonGate.resolve();
        await settleTurn();
        expect(trace).not.toContain('window');

        paletteGate.resolve();
        await expect(run).resolves.toBe('ready');
        expect(trace).toEqual(['-daemon', '-palette', 'window']);
    });

    it('runs the four post-window steps concurrently, in ANY completion order', async () => {
        const trace: string[] = [];
        const gates = {
            hotkey: deferred(),
            cli: deferred(),
            skill: deferred(),
            updater: deferred()
        };
        const started: string[] = [];
        const stepFor = (name: string, gate: { promise: Promise<void> }) => async (): Promise<void> => {
            trace.push(`+${name}`);
            started.push(name);
            await gate.promise;
            trace.push(`-${name}`);
        };

        const { steps } = launchHarness({
            registerGlobalHotkey: stepFor('hotkey', gates.hotkey),
            runCliInstallPolicy: stepFor('cli', gates.cli),
            refreshBundledSkill: stepFor('skill', gates.skill),
            startUpdater: stepFor('updater', gates.updater)
        });

        const run = runLaunchSequence(steps);
        // Let the wave start. All four must be IN FLIGHT with none finished — a sequential
        // implementation could only ever have the first one started here.
        await settleTurn();
        expect(started).toEqual(['hotkey', 'cli', 'skill', 'updater']);
        expect(trace.filter((entry) => entry.startsWith('-'))).toEqual([]);

        // Resolve them in the REVERSE of their start order: nothing in the sequence may depend
        // on the order the four land in.
        gates.updater.resolve();
        gates.skill.resolve();
        gates.cli.resolve();
        gates.hotkey.resolve();

        await expect(run).resolves.toBe('ready');
        expect(trace.slice(0, 4)).toEqual(['+hotkey', '+cli', '+skill', '+updater']);
        expect(trace.slice(4)).toEqual(['-updater', '-skill', '-cli', '-hotkey']);
    });

    it('installs the quit gate without waiting for that wave to finish', async () => {
        // APP-003's "off the boot path's critical line", applied to ⌘Q: a slow symlink probe on
        // a busy machine must not leave the app briefly unable to guard a quit.
        const trace: string[] = [];
        const slow = deferred();

        const { steps } = launchHarness({
            runCliInstallPolicy: async () => {
                trace.push('+cli');
                await slow.promise;
                trace.push('-cli');
            },
            installQuitGate: () => {
                trace.push('quit-gate');
            }
        });

        const run = runLaunchSequence(steps);
        await settleTurn();
        expect(trace).toContain('quit-gate');
        expect(trace).not.toContain('-cli');

        slow.resolve();
        await expect(run).resolves.toBe('ready');
        // …and the sequence still does not call itself ready until everything has settled.
        expect(trace).toEqual(['+cli', 'quit-gate', '-cli']);
    });
});

describe('the daemon connect order (CONT-127, APP-101)', () => {
    it('drains the parked file opens LAST, after both sockets', async () => {
        const calls: string[] = [];
        await runDaemonConnectSequence({
            connect: async () => {
                calls.push('connect');
                await Promise.resolve();
            },
            startStatus: () => {
                calls.push('status');
            },
            startWebHost: () => {
                calls.push('webhost');
            },
            drainPendingOpens: () => {
                calls.push('drain');
            }
        });

        expect(calls).toEqual(['connect', 'status', 'webhost', 'drain']);
    });

    it('opens the two sockets TOGETHER — neither is an input to the other (APP-013)', async () => {
        const trace: string[] = [];
        const statusStarted = deferred();
        const release = deferred();

        await runDaemonConnectSequence({
            connect: () => Promise.resolve(),
            startStatus: async () => {
                trace.push('+status');
                statusStarted.resolve();
                await release.promise;
                trace.push('-status');
            },
            startWebHost: async () => {
                trace.push('+webhost');
                // Deadlocks if the two are serialised: this waits on the status socket having
                // started, which a sequential run reaches only after `-status`.
                await statusStarted.promise;
                release.resolve();
                trace.push('-webhost');
            },
            drainPendingOpens: () => {
                trace.push('drain');
            }
        });

        expect(trace.slice(0, 2)).toEqual(['+status', '+webhost']);
        // And the drain is still LAST: it is the one step with a real dependency on both.
        expect(trace.at(-1)).toBe('drain');
    });

    it('a socket that throws still reaches the caller rather than being swallowed by the wave', async () => {
        await expect(
            runDaemonConnectSequence({
                connect: () => Promise.resolve(),
                startStatus: () => {
                    throw new Error('address in use');
                },
                startWebHost: () => undefined,
                drainPendingOpens: () => {
                    throw new Error('the drain must not run after a failed socket');
                }
            })
        ).rejects.toThrow('address in use');
    });

    it('drains again on a reconnect, because a file can be parked while the daemon is down', async () => {
        let drains = 0;
        const steps = {
            connect: () => Promise.resolve(),
            startStatus: () => undefined,
            startWebHost: () => undefined,
            drainPendingOpens: () => {
                drains += 1;
            }
        };

        await runDaemonConnectSequence(steps);
        await runDaemonConnectSequence(steps);

        expect(drains).toBe(2);
    });

    it('the whole race: a file opened during a cold launch reaches the daemon exactly once, after it connects', async () => {
        const sent: string[] = [];
        let connected = false;
        const queue = createOpenFileQueue({
            ready: () => connected,
            send: (request) => sent.push(request.path),
            activate: () => undefined
        });

        // Finder hands us the file while `boot()` is still discovering the daemon.
        queue.forward('/tmp/cold-launch.md');
        expect(sent).toEqual([]);

        await runDaemonConnectSequence({
            connect: async () => {
                await Promise.resolve();
                connected = true;
                // Nothing may have gone out yet: the connection exists, the sockets do not.
                expect(sent).toEqual([]);
            },
            startStatus: () => expect(sent).toEqual([]),
            startWebHost: () => expect(sent).toEqual([]),
            drainPendingOpens: () => queue.drain()
        });

        expect(sent).toEqual(['/tmp/cold-launch.md']);
        expect(queue.pending()).toEqual([]);
    });
});
