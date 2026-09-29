import { EventEmitter } from 'node:events';

import type { UpdateView } from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { createUpdateFlow, type UpdateFlowDeps } from './update-flow.js';
import type { FeedReply, InstallLocation, Installer, UpdateSupport } from './updater.js';

const FEED = 'https://update.electronjs.org/benfriebe/kelpi/darwin-arm64/0.2.2';
const OFFER: FeedReply = {
    kind: 'available',
    update: { version: '0.2.3', notes: '## Fixes\n\n- The update restarts only when you say so.', feed: FEED }
};

class FakeInstaller extends EventEmitter implements Installer {
    feeds: string[] = [];
    checks = 0;
    installs = 0;
    setFeedURL(options: { url: string }): void {
        this.feeds.push(options.url);
    }
    checkForUpdates(): void {
        this.checks += 1;
    }
    quitAndInstall(): void {
        this.installs += 1;
        this.order?.push('quitAndInstall');
    }
    order: string[] | undefined;
}

interface Harness {
    readonly flow: ReturnType<typeof createUpdateFlow>;
    readonly installer: FakeInstaller;
    readonly presented: { view: UpdateView; reveal: boolean }[];
    readonly logs: string[];
    readonly order: string[];
    readonly changes: string[];
    reply: FeedReply;
    support: UpdateSupport;
    location: InstallLocation;
    readonly last: () => { view: UpdateView; reveal: boolean };
    /** `prompted`, per present, in step with `presented`. */
    readonly prompts: boolean[];
    /** Timers the flow set (the restart timeout), fired by hand. */
    readonly timers: { run: () => void; ms: number; cleared: boolean }[];
}

function harness(overrides: Partial<UpdateFlowDeps> = {}): Harness {
    const installer = new FakeInstaller();
    const order: string[] = [];
    installer.order = order;
    const h: Harness = {
        installer,
        presented: [],
        logs: [],
        order,
        changes: [],
        prompts: [],
        timers: [],
        reply: OFFER,
        support: { ok: true },
        location: { kind: 'ok', bundlePath: '/Applications/Kelpi.app' },
        last: () => {
            const entry = h.presented[h.presented.length - 1];
            if (entry === undefined) throw new Error('nothing presented');
            return entry;
        },
        flow: undefined as unknown as ReturnType<typeof createUpdateFlow>
    };
    (h as { flow: ReturnType<typeof createUpdateFlow> }).flow = createUpdateFlow({
        currentVersion: () => '0.2.2',
        support: () => h.support,
        fetchUpdate: () => Promise.resolve(h.reply),
        installer: () => installer,
        location: () => h.location,
        present: (view, reveal, prompted) => {
            h.presented.push({ view, reveal });
            h.prompts.push(prompted);
        },
        allowQuit: () => order.push('allowQuit'),
        rearmQuit: () => order.push('rearmQuit'),
        quit: () => order.push('quit'),
        setTimer: (run, ms) => {
            h.timers.push({ run, ms, cleared: false });
            return h.timers.length - 1;
        },
        clearTimer: (timer) => {
            const entry = h.timers[timer as number];
            if (entry !== undefined) entry.cleared = true;
        },
        changed: (view) => h.changes.push(view.phase),
        log: (line) => h.logs.push(line),
        ...overrides
    });
    return h;
}

/** Let the download promise's handlers run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function toReady(h: Harness): Promise<void> {
    await h.flow.check('manual');
    h.flow.act('update-now');
    h.installer.emit('update-downloaded');
    await settle();
}

describe('the update flow: checking', () => {
    it('a manual check shows "checking", then the offer with its notes, both revealed', async () => {
        const h = harness();
        await h.flow.check('manual');
        expect(h.presented.map((entry) => [entry.view.phase, entry.reveal])).toEqual([
            ['checking', true],
            ['available', true]
        ]);
        expect(h.last().view).toMatchObject({ phase: 'available', version: '0.2.3', currentVersion: '0.2.2' });
        expect(h.last().view.notes).toContain('## Fixes');
        expect(h.logs).toContain('auto-update: idle -> checking (manual check)');
        expect(h.logs).toContain('auto-update: checking -> available 0.2.3 (manual check)');
        expect(h.logs).toContain('auto-update: install location /Applications/Kelpi.app (ok)');
    });

    it('a manual check says "up to date" with the version', async () => {
        const h = harness();
        h.reply = { kind: 'none' };
        await h.flow.check('manual');
        expect(h.last()).toEqual({ view: { phase: 'up-to-date', currentVersion: '0.2.2' }, reveal: true });
    });

    it('a failed manual check says why, and Retry checks again', async () => {
        const h = harness();
        h.reply = { kind: 'error', message: 'the update feed answered HTTP 502' };
        await h.flow.check('manual');
        expect(h.last()).toEqual({
            view: { phase: 'failed', currentVersion: '0.2.2', message: 'the update feed answered HTTP 502', retry: 'check' },
            reveal: true
        });
        h.reply = { kind: 'none' };
        h.flow.act('retry');
        await settle();
        expect(h.flow.phase).toBe('up-to-date');
    });

    it('the launch check is silent unless there is something to offer', async () => {
        const quiet = harness();
        quiet.reply = { kind: 'none' };
        await quiet.flow.check('launch');
        expect(quiet.presented.every((entry) => !entry.reveal)).toBe(true);
        expect(quiet.flow.phase).toBe('idle');

        const failing = harness();
        failing.reply = { kind: 'error', message: 'offline' };
        await failing.flow.check('launch');
        expect(failing.presented.every((entry) => !entry.reveal)).toBe(true);
        expect(failing.flow.phase).toBe('idle');
        expect(failing.logs.some((line) => line.includes('launch check failed: offline'))).toBe(true);

        const offered = harness();
        await offered.flow.check('launch');
        expect(offered.presented.map((entry) => [entry.view.phase, entry.reveal])).toEqual([
            ['checking', false],
            ['available', true]
        ]);
    });

    it('a build that cannot update says so on a manual check and stays silent at launch', async () => {
        const h = harness();
        h.support = { ok: false, reason: 'This is a development build.' };
        await h.flow.check('launch');
        expect(h.presented).toEqual([]);
        await h.flow.check('manual');
        expect(h.last()).toEqual({
            view: { phase: 'unsupported', currentVersion: '0.2.2', message: 'This is a development build.' },
            reveal: true
        });
    });
});

describe('the update flow: downloading and restarting', () => {
    it('Update Now downloads and shows "downloading", revealed', async () => {
        const h = harness();
        await h.flow.check('manual');
        h.flow.act('update-now');
        expect(h.installer.feeds).toEqual([FEED]);
        expect(h.installer.checks).toBe(1);
        expect(h.last()).toMatchObject({ view: { phase: 'downloading', version: '0.2.3' }, reveal: true });
    });

    it('a finished download ASKS: it stops at "ready" and never quits on its own (#286)', async () => {
        const h = harness();
        await toReady(h);
        expect(h.last()).toMatchObject({ view: { phase: 'ready', version: '0.2.3' }, reveal: true });
        expect(h.installer.installs).toBe(0);
        expect(h.order).toEqual([]);
        expect(h.logs).toContain('auto-update: downloading -> ready 0.2.3 (downloaded; asking before restarting)');
    });

    it('Restart Now opens the quit gate FIRST, then quits into the update, and says the daemon keeps running', async () => {
        const h = harness();
        await toReady(h);
        h.flow.act('restart');
        expect(h.order).toEqual(['allowQuit', 'quitAndInstall']);
        expect(h.flow.phase).toBe('restarting');
        expect(h.logs.some((line) => line.includes('restarting into 0.2.3 (quitAndInstall); the daemon keeps running'))).toBe(true);
    });

    it('a restart that throws re-arms the quit gate and says to quit and reopen, with no Retry in place', async () => {
        const h = harness();
        await toReady(h);
        h.installer.quitAndInstall = () => {
            h.order.push('quitAndInstall');
            throw new Error('Squirrel is not ready');
        };
        h.flow.act('restart');
        expect(h.order).toEqual(['allowQuit', 'quitAndInstall', 'rearmQuit']);
        expect(h.last()).toMatchObject({ view: { phase: 'failed', retry: 'install', message: 'Squirrel is not ready' }, reveal: true });
        expect(h.prompts.at(-1)).toBe(true);
        h.flow.act('retry');
        expect(h.flow.phase).toBe('failed');
        expect(h.order).toEqual(['allowQuit', 'quitAndInstall', 'rearmQuit']);
        h.flow.act('quit');
        expect(h.order.at(-1)).toBe('quit');
    });

    it('a restart still pending after the timeout is a failed install, and the gate is re-armed', async () => {
        const h = harness();
        await toReady(h);
        h.flow.act('restart');
        const timer = h.timers.at(-1);
        expect(timer?.ms).toBe(60_000);
        timer?.run();
        expect(h.flow.phase).toBe('failed');
        expect(h.last().view).toMatchObject({ retry: 'install', message: 'Kelpi did not quit to install the update within 60 seconds.' });
        expect(h.order).toEqual(['allowQuit', 'quitAndInstall', 'rearmQuit']);
    });

    it('a failed install can be closed, leaving Kelpi usable, and the timeout does nothing after a real failure', async () => {
        const h = harness();
        await toReady(h);
        h.flow.act('restart');
        h.installer.emit('error', new Error('ShipIt could not be launched'));
        expect(h.timers.at(-1)?.cleared).toBe(true);
        h.flow.act('dismiss');
        expect(h.flow.phase).toBe('idle');
        expect(h.order).toEqual(['allowQuit', 'quitAndInstall', 'rearmQuit']);
    });

    it('a Squirrel error during the restart becomes a failed install; at other times it is only logged', async () => {
        const h = harness();
        await toReady(h);
        h.flow.installerError(new Error('late noise'));
        expect(h.flow.phase).toBe('ready');
        h.flow.act('restart');
        h.flow.installerError(new Error('ShipIt could not be launched'));
        expect(h.last()).toMatchObject({ view: { phase: 'failed', retry: 'install', message: 'ShipIt could not be launched' }, reveal: true });
        expect(h.order).toContain('rearmQuit');
        expect(h.logs.some((line) => line.includes('Squirrel reported an error while ready: late noise'))).toBe(true);
    });

    it('a download error is a failure with Retry, and Retry downloads again', async () => {
        const h = harness();
        await h.flow.check('manual');
        h.flow.act('update-now');
        h.installer.emit('error', new Error('Code signature at URL did not pass validation'));
        await settle();
        expect(h.last()).toEqual({
            view: {
                phase: 'failed',
                currentVersion: '0.2.2',
                version: '0.2.3',
                notes: '## Fixes\n\n- The update restarts only when you say so.',
                message: 'Code signature at URL did not pass validation',
                retry: 'download'
            },
            reveal: true
        });
        h.flow.act('retry');
        expect(h.flow.phase).toBe('downloading');
        expect(h.installer.checks).toBe(2);
        h.installer.emit('update-downloaded');
        await settle();
        expect(h.flow.phase).toBe('ready');
    });

    it('Later on "ready" keeps it ready (Squirrel installs on the next quit), and quits nothing', async () => {
        const h = harness();
        await toReady(h);
        const before = h.presented.length;
        h.flow.act('later');
        expect(h.flow.phase).toBe('ready');
        expect(h.presented.length).toBe(before);
        expect(h.installer.installs).toBe(0);
        expect(h.order).toEqual([]);
        expect(h.logs.some((line) => line.includes('0.2.3 installs when Kelpi next quits'))).toBe(true);
        // …and a restart is still one choice away.
        h.flow.act('restart');
        expect(h.order).toEqual(['allowQuit', 'quitAndInstall']);
    });

    it('Later on an offer goes back to idle; the next check offers it again', async () => {
        const h = harness();
        await h.flow.check('manual');
        h.flow.act('later');
        expect(h.flow.phase).toBe('idle');
        await h.flow.check('manual');
        expect(h.flow.phase).toBe('available');
    });

    it('buttons that do not fit the state do nothing', async () => {
        const h = harness();
        h.flow.act('restart');
        h.flow.act('update-now');
        h.flow.act('retry');
        expect(h.flow.phase).toBe('idle');
        expect(h.order).toEqual([]);
        await h.flow.check('manual');
        h.flow.act('restart');
        expect(h.order).toEqual([]);
        expect(h.flow.phase).toBe('available');
    });
});

describe('the update flow: a second check (#286 step 2)', () => {
    it('while downloading shows "downloading", never "checking", and starts no second download', async () => {
        const h = harness();
        await h.flow.check('manual');
        h.flow.act('update-now');
        h.flow.act('dismiss'); // the user hid the sheet; the download goes on
        expect(h.flow.phase).toBe('downloading');
        const before = h.presented.length;
        await h.flow.check('manual');
        expect(h.presented.length).toBe(before + 1);
        expect(h.last()).toMatchObject({ view: { phase: 'downloading', version: '0.2.3' }, reveal: true });
        expect(h.presented.slice(before).some((entry) => entry.view.phase === 'checking')).toBe(false);
        expect(h.installer.checks).toBe(1);
    });

    it('while ready shows "ready" again, so Restart Now is one click away', async () => {
        const h = harness();
        await toReady(h);
        h.flow.act('later');
        await h.flow.check('manual');
        expect(h.last()).toMatchObject({ view: { phase: 'ready', version: '0.2.3' }, reveal: true });
        expect(h.installer.checks).toBe(1);
    });

    it('the launch check while busy shows nothing', async () => {
        const h = harness();
        await toReady(h);
        const before = h.presented.length;
        await h.flow.check('launch');
        expect(h.presented.length).toBe(before);
    });
});

describe('the update flow: where Kelpi runs from', () => {
    it('an offer from a place Squirrel cannot write carries the reason, and Update Now downloads nothing', async () => {
        const h = harness();
        h.location = {
            kind: 'blocked',
            bundlePath: '/private/var/folders/x/T/AppTranslocation/1/d/Kelpi.app',
            reason: 'translocated',
            message: 'macOS is running this copy of Kelpi from a temporary read-only location.'
        };
        await h.flow.check('manual');
        expect(h.last().view.location).toEqual({ blocked: true, message: 'macOS is running this copy of Kelpi from a temporary read-only location.' });
        h.flow.act('update-now');
        expect(h.installer.checks).toBe(0);
        expect(h.flow.phase).toBe('available');
        expect(h.logs.some((line) => line.includes('Update Now refused'))).toBe(true);
    });

    it('a warning rides along but does not stop the download', async () => {
        const h = harness();
        h.location = { kind: 'warn', bundlePath: '/Users/j/Downloads/Kelpi.app', message: 'Kelpi is running from /Users/j/Downloads.' };
        await h.flow.check('manual');
        expect(h.last().view.location).toEqual({ blocked: false, message: 'Kelpi is running from /Users/j/Downloads.' });
        h.flow.act('update-now');
        expect(h.installer.checks).toBe(1);
    });
});

describe('the update flow: logging and the menu', () => {
    it('logs every transition and tells the menu only when the phase changes', async () => {
        const h = harness();
        await toReady(h);
        expect(h.changes).toEqual(['checking', 'available', 'downloading', 'ready']);
        expect(h.logs.filter((line) => line.includes(' -> '))).toEqual([
            'auto-update: idle -> checking (manual check)',
            'auto-update: checking -> available 0.2.3 (manual check)',
            'auto-update: available -> downloading 0.2.3 (Update Now)',
            'auto-update: downloading -> ready 0.2.3 (downloaded; asking before restarting)'
        ]);
    });

    it('a late answer from an abandoned download moves nothing', async () => {
        const h = harness();
        await h.flow.check('manual');
        h.flow.act('update-now');
        h.installer.emit('error', new Error('network lost'));
        await settle();
        h.flow.act('retry');
        // The first download's own listener is gone; the flow's standing one and the second
        // download's are the ones left.
        expect(h.installer.listenerCount('update-downloaded')).toBe(2);
        expect(h.flow.phase).toBe('downloading');
    });
});

describe('the update flow: review fixes (#286)', () => {
    it('a slow download is "still downloading", never a failure, and its late finish is ready', async () => {
        const h = harness({ downloadSlowMs: () => 5 });
        await h.flow.check('manual');
        h.flow.act('update-now');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(h.flow.phase).toBe('downloading');
        expect(h.last()).toMatchObject({ view: { phase: 'downloading', slow: true }, reveal: false });
        // A manual check while slow shows it, and starts nothing.
        await h.flow.check('manual');
        expect(h.last().view.slow).toBe(true);
        expect(h.installer.checks).toBe(1);
        h.installer.emit('update-downloaded');
        await settle();
        expect(h.flow.phase).toBe('ready');
        expect(h.installer.checks).toBe(1);
    });

    it('Squirrel finishing after the flow gave up on a download still ends in ready', async () => {
        const h = harness();
        await h.flow.check('manual');
        h.flow.act('update-now');
        h.installer.emit('error', new Error('network blip'));
        await settle();
        expect(h.flow.phase).toBe('failed');
        h.installer.emit('update-downloaded');
        await settle();
        expect(h.flow.phase).toBe('ready');
    });

    it('a manual check that joins a running launch check gets the answer revealed', async () => {
        let answer: (reply: FeedReply) => void = () => undefined;
        const h = harness({ fetchUpdate: () => new Promise<FeedReply>((resolve) => { answer = resolve; }) });
        const launch = h.flow.check('launch');
        expect(h.last()).toMatchObject({ view: { phase: 'checking' }, reveal: false });
        await h.flow.check('manual');
        expect(h.last()).toMatchObject({ view: { phase: 'checking' }, reveal: true });
        answer({ kind: 'none' });
        await launch;
        expect(h.last()).toEqual({ view: { phase: 'up-to-date', currentVersion: '0.2.2' }, reveal: true });
    });

    it('a launch-check offer is revealed but unprompted; a manual one is prompted', async () => {
        const launch = harness();
        await launch.flow.check('launch');
        expect(launch.last().view.phase).toBe('available');
        expect(launch.prompts.at(-1)).toBe(false);
        const manual = harness();
        await manual.flow.check('manual');
        expect(manual.prompts.at(-1)).toBe(true);
    });

    it('a finished or failed download is unprompted (it never pulls a hidden window forward)', async () => {
        const h = harness();
        await toReady(h);
        expect(h.prompts.at(-1)).toBe(false);
    });

    it('show() re-presents the current state as prompted, and does nothing while idle', async () => {
        const h = harness();
        h.flow.show();
        expect(h.presented).toEqual([]);
        await h.flow.check('launch');
        h.flow.show();
        expect(h.last().reveal).toBe(true);
        expect(h.prompts.at(-1)).toBe(true);
    });
});
