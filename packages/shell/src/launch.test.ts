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

        expect(calls).toEqual(['permissions', 'menu', 'daemon-unavailable']);
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

        expect(calls).toEqual([
            'permissions',
            'menu',
            'daemon',
            'find-palette',
            'window',
            'hotkey',
            'error:cli-install failed',
            'skill-refresh',
            'updater',
            'quit-gate'
        ]);
    });

    it('a documentation-refresh step that throws costs a log line either (APP-006’s slot)', async () => {
        const { calls, steps } = launchHarness({
            refreshBundledSkill: () => {
                throw new Error('EROFS');
            }
        });

        await expect(runLaunchSequence(steps)).resolves.toBe('ready');

        expect(calls).toEqual([
            'permissions',
            'menu',
            'daemon',
            'find-palette',
            'window',
            'hotkey',
            'cli-install',
            'error:skill-refresh failed',
            'updater',
            'quit-gate'
        ]);
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
            startStatus: () => calls.push('status'),
            startWebHost: () => calls.push('webhost'),
            drainPendingOpens: () => calls.push('drain')
        });

        expect(calls).toEqual(['connect', 'status', 'webhost', 'drain']);
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
