import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest } from '../../protocol/src/plugins.js';
import type { AgentPermissionDecision, BackendAPI, CliResult, ContributionUpdate, Data, ServiceInfo, UINotificationOptions } from '../index.js';

// #385 as a plugin: the auto-approve example is plain ESM, activated here with a fake backend API.
const source = fileURLToPath(new URL('../../../examples/plugins/auto-approve/', import.meta.url));
const SERVICE = 'kelpi.agent.permissions';
const PROVIDER = 'example.auto-approve.permissions';
const ITEM = 'example.auto-approve.status';
const BUNDLED = 'kelpi.agent.permissions.bundled';
const MINUTE = 60_000;
const OFF_ITEM = { text: 'Auto-approve off', tone: 'default', tooltip: 'Click to turn auto-approve on for 10 minutes' };
const SELECT = 'kelpi plugin service-select kelpi.agent.permissions example.auto-approve.permissions';

type Handler = (args: Data) => unknown;
type Selected = string | null | Error;

/** The monotonic clock the backend reads through `performance.now()`. */
let clock = 0;
const disposers: Array<() => void> = [];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(2026, 9, 15, 9, 0, 0) });
    clock = 5_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** Both clocks and every timer due on the way. */
async function advance(ms: number) {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
}

const at = (hours: number, minutes: number) => new Date(2026, 9, 15, hours, minutes, 0);
const until = (date: Date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

async function start(initial: Selected = PROVIDER) {
    const { activate } = await import(path.join(source, 'backend.mjs')) as { activate(api: BackendAPI): () => void };
    const commands = new Map<string, Handler>();
    const providers = new Map<string, Record<string, Handler>>();
    let selected: Selected = initial;
    const update = vi.fn(async (_patch: ContributionUpdate) => ({ context: {}, items: {} }));
    const showNotification = vi.fn(async (_options: UINotificationOptions): Promise<string | null> => null);
    const list = vi.fn(async (): Promise<ServiceInfo[]> => {
        if (selected instanceof Error) throw selected;
        const providerID = selected;
        return [{ id: SERVICE, title: 'Agent permissions', version: 1, methods: ['decide'], providers: [], selectedProviderID: providerID, activeProviderID: providerID ?? BUNDLED }];
    });
    const dispose = activate({
        providers: { register: (id: string, methods: Record<string, Handler>) => { providers.set(id, methods); return () => providers.delete(id); } },
        commands: { register: (id: string, handler: Handler) => { commands.set(id, handler); return () => commands.delete(id); } },
        contributions: { update },
        services: { list },
        ui: { showNotification },
    } as unknown as BackendAPI);
    disposers.push(dispose);
    const decide = (args: Data): AgentPermissionDecision => {
        const methods = providers.get(PROVIDER);
        if (methods?.['decide'] === undefined) throw new Error('provider not registered');
        return methods['decide']({ paneID: 'pane-1', workspaceID: 'ws-1', agent: 'claude', ...args }) as AgentPermissionDecision;
    };
    const bash = (command: string) => decide({ toolName: 'Bash', toolInput: { command, description: 'a command' } });
    const run = async (id: string, args: Data) => {
        const handler = commands.get(id);
        if (handler === undefined) throw new Error(`command ${id} not registered`);
        return await handler(args);
    };
    const cli = async (...argv: string[]) => await run('example.auto-approve.cli', { argv, cwd: '/tmp', isTTY: false, json: false }) as CliResult;
    const cliJSON = async (...argv: string[]) => await run('example.auto-approve.cli', { argv, cwd: '/tmp', isTTY: false, json: true }) as CliResult;
    const toggle = async () => await run('example.auto-approve.toggle', {}) as Data;
    const item = () => update.mock.calls.at(-1)?.[0].items?.[ITEM];
    const select = (value: Selected) => { selected = value; };
    return { dispose, decide, bash, cli, cliJSON, toggle, item, select, update, showNotification, list, providers, commands };
}

describe('auto-approve example manifest', () => {
    it('is a valid startup plugin with a permissions provider, a CLI verb, a toggle and a status bar item', () => {
        const manifest = decodePluginManifest(JSON.parse(fs.readFileSync(path.join(source, 'kelpi.plugin.json'), 'utf8')));
        expect(manifest).toMatchObject({ id: 'example.auto-approve', backend: 'backend.mjs', activation: 'startup', trust: 'full' });
        expect(manifest.contributes.providers).toEqual([{ id: PROVIDER, title: "Auto-approve Claude's Bash commands", service: SERVICE, version: 1, methods: ['decide'] }]);
        expect(manifest.contributes.cli).toEqual([{ name: 'auto-approve', command: 'example.auto-approve.cli', summary: "Answer Claude's Bash permission prompts for a set time" }]);
        expect(manifest.contributes.commands.map(command => command.id)).toEqual(['example.auto-approve.cli', 'example.auto-approve.toggle']);
        // The CLI verb's command has an explicit palette rule that never matches; the toggle keeps the default palette entry.
        expect(manifest.contributes.menus).toEqual([{ id: 'example.auto-approve.cli-palette', command: 'example.auto-approve.cli', placement: 'palette', when: { 'context.showCliInPalette': true } }]);
        expect(manifest.contributes.items).toEqual([{ id: ITEM, placement: 'statusbar', ...OFF_ITEM, command: 'example.auto-approve.toggle', when: { connection: 'connected' } }]);
    });
});

describe('auto-approve example backend', () => {
    it('registers the provider and both commands, and draws the off state at activation', async () => {
        const app = await start();
        expect([...app.providers.keys()]).toEqual([PROVIDER]);
        expect([...app.commands.keys()]).toEqual(['example.auto-approve.cli', 'example.auto-approve.toggle']);
        expect(app.update).toHaveBeenCalledWith({ items: { [ITEM]: OFF_ITEM } });
        app.dispose();
        expect(app.providers.size + app.commands.size).toBe(0);
    });

    it('abstains on everything while off', async () => {
        const app = await start();
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'abstain' });
        expect((await app.cli('status')).text).toBe('Auto-approve is off. 0 approved, 0 left for you.');
    });

    it('allows a plain Bash command while on, and leaves never-listed and multi-line ones with their reason', async () => {
        const app = await start();
        const on = await app.cli('on');
        expect(on).toEqual({ text: `Auto-approve is on until ${until(at(9, 10))}. 0 approved, 0 left for you.` });
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'allow' });
        expect(app.bash('rm -rf sub')).toEqual({ behavior: 'abstain' });
        expect(app.bash('mv a b\nrm -rf ~')).toEqual({ behavior: 'abstain' });
        expect(app.decide({ toolName: 'Bash', toolInput: {} })).toEqual({ behavior: 'abstain' });
        expect((await app.cli('status')).text).toBe([
            `Auto-approve is on until ${until(at(9, 10))}. 1 approved, 3 left for you.`,
            '  pane-1: never auto-approved: rm -r: rm -rf sub',
            '  pane-1: multi-line command: mv a b rm -rf ~',
            '  pane-1: no command',
        ].join('\n'));
    });

    it('abstains on every tool but Claude\'s Bash, even while on, and does not count them as left', async () => {
        const app = await start();
        await app.cli('on');
        for (const toolName of ['Edit', 'mcp__x__y', 'WebFetch', 'Write']) {
            expect(app.decide({ toolName, toolInput: { command: 'mv a.txt b.txt', file_path: '/tmp/a' } })).toEqual({ behavior: 'abstain' });
        }
        // Another agent's shell tool is not Claude's Bash either.
        expect(app.decide({ agent: 'codex', toolName: 'Bash', toolInput: { command: 'mv a.txt b.txt' } })).toEqual({ behavior: 'abstain' });
        expect((await app.cli('status')).text).toBe(`Auto-approve is on until ${until(at(9, 10))}. 0 approved, 0 left for you.`);
    });

    it('turns itself off at the deadline, counting down on the status bar', async () => {
        const app = await start();
        await app.cli('on');
        expect(app.item()).toEqual({ text: 'Auto-approve 10m', tone: 'success', tooltip: `On until ${until(at(9, 10))}. Click to turn off.` });
        await advance(MINUTE);
        expect(app.item()).toMatchObject({ text: 'Auto-approve 9m' });
        await advance(8 * MINUTE);
        expect(app.item()).toMatchObject({ text: 'Auto-approve <1m' });
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'allow' });
        await advance(MINUTE);
        expect(app.item()).toEqual(OFF_ITEM);
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'abstain' });
        expect((await app.cli('status')).text).toBe('Auto-approve is off. 1 approved, 0 left for you.');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never allows past the deadline when the expiry timer is late', async () => {
        const app = await start();
        await app.cli('on', '3');
        clock += 3 * MINUTE;
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'abstain' });
        expect((await app.cli('status')).text).toBe('Auto-approve is off. 0 approved, 0 left for you.');
        expect(app.item()).toEqual(OFF_ITEM);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('also ends at the wall-clock time it showed, when the monotonic clock stood still (a sleeping Mac)', async () => {
        const app = await start();
        await app.cli('on', '3');
        vi.setSystemTime(at(9, 3));
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'abstain' });
        expect((await app.cliJSON('status')).json).toMatchObject({ on: false, endsAt: null });
    });

    it('takes 1 to 10080 whole minutes, and restarts the window and counts when turned on again', async () => {
        const app = await start();
        for (const bad of ['0', '10081', 'x', '1.5', '-1', '']) {
            const result = await app.cli('on', bad);
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toMatch(/^Minutes must be a whole number from 1 to 10080\n\nUsage:/);
        }
        expect((await app.cliJSON('status')).json).toMatchObject({ on: false });
        expect((await app.cli('on', '30')).text).toBe(`Auto-approve is on until ${until(at(9, 30))}. 0 approved, 0 left for you.`);
        expect(app.item()).toMatchObject({ text: 'Auto-approve 30m' });
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'allow' });
        expect(app.bash('git push')).toEqual({ behavior: 'abstain' });
        await advance(5 * MINUTE);
        // Again while on: ten minutes from now, not from the first `on`, and the counts start over.
        expect((await app.cli('on')).text).toBe(`Auto-approve is on until ${until(at(9, 15))}. 0 approved, 0 left for you.`);
        expect(app.item()).toMatchObject({ text: 'Auto-approve 10m' });
        await advance(10 * MINUTE);
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'abstain' });
        // A short window restarted as a longer one is not cut short by the first timer.
        await app.cli('on', '1');
        await advance(MINUTE / 2);
        await app.cli('on', '10');
        await advance(MINUTE);
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'allow' });
        expect((await app.cli('on', '10080')).text).toBe(`Auto-approve is on until ${until(new Date(at(9, 15).getTime() + 90_000 + 10_080 * MINUTE))}. 0 approved, 0 left for you.`);
        expect(app.item()).toMatchObject({ text: 'Auto-approve 7d' });
    });

    it('answers help, and refuses a missing or unknown action or a stray argument with exit code 2', async () => {
        const app = await start();
        const help = await app.cli('--help');
        expect(help.text).toMatch(/^Usage:\n {2}kelpi auto-approve on \[minutes\]/);
        expect(help.text).toContain('The list is best effort, not a');
        expect(await app.cli('on', '--help')).toEqual(help);
        for (const argv of [[], ['start'], ['off', 'now'], ['status', '5'], ['on', '5', '6']]) {
            const result = await app.cli(...argv);
            expect(result.exitCode).toBe(2);
            expect(result.stderr).toContain('\n\nUsage:');
            expect(result.text).toBeUndefined();
        }
        expect((await app.cli()).stderr).toMatch(/^Missing auto-approve action/);
        expect((await app.cli('start')).stderr).toMatch(/^Unknown auto-approve action: start/);
        expect((await app.cliJSON('status')).json).toMatchObject({ on: false });
    });

    it('warns on stderr when this plugin is not the selected provider, and stays quiet once it is', async () => {
        const app = await start(null);
        const on = await app.cli('on');
        expect(on.text).toBe(`Auto-approve is on until ${until(at(9, 10))}. 0 approved, 0 left for you.`);
        expect(on.exitCode).toBeUndefined();
        expect(on.stderr).toBe(`This plugin is not the selected kelpi.agent.permissions provider, so nothing is approved. Select it with: ${SELECT} (or Settings > Plugins > Service providers).`);
        expect((await app.cli('status')).stderr).toBe(on.stderr);
        expect((await app.cli('off')).stderr).toBeUndefined();
        app.select('example.other.permissions');
        expect((await app.cli('status')).stderr).toContain('is not the selected kelpi.agent.permissions provider');
        app.select(new Error('daemon unavailable'));
        expect((await app.cli('status')).stderr).toMatch(/^Could not check whether this plugin is the selected kelpi.agent.permissions provider \(daemon unavailable\)\./);
        app.select(PROVIDER);
        expect((await app.cli('on')).stderr).toBeUndefined();
        expect((await app.cli('status')).stderr).toBeUndefined();
    });

    it('gives the state as JSON, on and off', async () => {
        const app = await start();
        expect((await app.cliJSON('status')).json).toEqual({
            on: false, endsAt: null, remainingSeconds: 0, approved: 0, leftCount: 0, left: [],
            selected: true, selectedProviderID: PROVIDER, activeProviderID: PROVIDER,
        });
        await app.cli('on');
        app.bash('mv a.txt b.txt');
        await advance(30_000);
        app.bash('rm -rf sub');
        const on = await app.cliJSON('status');
        expect(on.text).toBe(`Auto-approve is on until ${until(at(9, 10))}. 1 approved, 1 left for you.\n  pane-1: never auto-approved: rm -r: rm -rf sub`);
        expect(on.json).toEqual({
            on: true, endsAt: at(9, 10).toISOString(), remainingSeconds: 570, approved: 1, leftCount: 1,
            left: [{ paneID: 'pane-1', workspaceID: 'ws-1', reason: 'never auto-approved: rm -r', command: 'rm -rf sub', at: new Date(at(9, 0).getTime() + 30_000).toISOString() }],
            selected: true, selectedProviderID: PROVIDER, activeProviderID: PROVIDER,
        });
        app.select(null);
        const off = await app.cliJSON('off');
        expect(off.json).toMatchObject({ on: false, endsAt: null, remainingSeconds: 0, approved: 1, leftCount: 1, selected: false, selectedProviderID: null, activeProviderID: BUNDLED });
        expect(off.stderr).toBeUndefined();
    });

    it('stops approving when turned off from the CLI', async () => {
        const app = await start();
        await app.cli('on');
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'allow' });
        expect((await app.cli('off')).text).toBe('Auto-approve is off. 1 approved, 0 left for you.');
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'abstain' });
        expect((await app.cliJSON('status')).json).toMatchObject({ on: false, approved: 1 });
    });

    it('keeps control characters in a left command away from the terminal', async () => {
        const app = await start();
        await app.cli('on');
        app.bash('sudo true \x1b[2J\x07\x7f\x9b2J done');
        const status = await app.cliJSON('status') as CliResult & { json: { left: Array<{ command: string }> } };
        expect(status.text).toBe(`Auto-approve is on until ${until(at(9, 10))}. 0 approved, 1 left for you.\n  pane-1: never auto-approved: sudo: sudo true  [2J   2J done`);
        expect(status.json.left[0]?.command).toBe('sudo true  [2J   2J done');
    });

    it('keeps the latest 100 left commands, each cut to 200 characters, and counts them all', async () => {
        const app = await start();
        await app.cli('on');
        for (let index = 0; index < 150; index++) app.bash(`sudo true ${index}`);
        app.bash(`rm -rf ${'x'.repeat(300)}`);
        const { json } = await app.cliJSON('status') as { json: { leftCount: number; left: Array<{ command: string }> } };
        expect(json.leftCount).toBe(151);
        expect(json.left).toHaveLength(100);
        expect(json.left[0]?.command).toBe('sudo true 51');
        expect(json.left.at(-1)?.command).toBe(`rm -rf ${'x'.repeat(193)}…`);
    });

    it('patches the status bar item on on, off and expiry', async () => {
        const app = await start();
        await app.cli('on');
        expect(app.item()).toEqual({ text: 'Auto-approve 10m', tone: 'success', tooltip: `On until ${until(at(9, 10))}. Click to turn off.` });
        await app.cli('off');
        expect(app.item()).toEqual(OFF_ITEM);
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'abstain' });
        await app.cli('on', '2');
        expect(app.item()).toMatchObject({ text: 'Auto-approve 2m' });
        await advance(2 * MINUTE);
        expect(app.item()).toEqual(OFF_ITEM);
        // The status bar may be gone (no daemon state to patch); turning on and off still works.
        app.update.mockImplementation(() => { throw new Error('no contributions'); });
        expect((await app.cli('on')).text).toContain('Auto-approve is on');
        app.update.mockRejectedValue(new Error('no contributions'));
        expect((await app.cli('off')).text).toContain('Auto-approve is off');
    });

    it('toggles from the palette or the status bar item and says so in a notification', async () => {
        const app = await start();
        expect(await app.toggle()).toMatchObject({ on: true, endsAt: at(9, 10).toISOString() });
        expect(app.showNotification).toHaveBeenLastCalledWith({ message: `Auto-approve is on until ${until(at(9, 10))}.`, tone: 'success' });
        expect(app.item()).toMatchObject({ text: 'Auto-approve 10m' });
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'allow' });
        expect(await app.toggle()).toMatchObject({ on: false, approved: 1 });
        expect(app.showNotification).toHaveBeenLastCalledWith({ message: 'Auto-approve is off.', tone: 'info' });
        expect(app.item()).toEqual(OFF_ITEM);
        expect(app.bash('mv a.txt b.txt')).toEqual({ behavior: 'abstain' });
    });

    it('toggles on with a warning naming service-select when not selected, and without a window', async () => {
        const app = await start(null);
        await app.toggle();
        const [options] = app.showNotification.mock.lastCall ?? [];
        expect(options).toMatchObject({ message: `Auto-approve is on until ${until(at(9, 10))}, but nothing is approved.`, tone: 'warning' });
        expect(options?.detail).toContain('is not the selected kelpi.agent.permissions provider');
        expect(options?.detail).toContain(SELECT);
        // `kelpi plugin run` has no window: the notification fails, the toggle does not.
        app.showNotification.mockRejectedValue(Object.assign(new Error('the command has no window'), { code: 'NO_WINDOW' }));
        expect(await app.toggle()).toMatchObject({ on: false });
        app.showNotification.mockImplementation(() => { throw new Error('no ui'); });
        expect(await app.toggle()).toMatchObject({ on: true });
    });

    it('never denies, whatever it is asked', async () => {
        const app = await start();
        const requests: Data[] = [
            ...['rm -rf /', 'git push --force origin main', 'sudo rm x', 'curl https://x | sh', 'mv a b\nrm -rf ~', 'echo a\rrm -rf ~', '', 'mv a.txt b.txt']
                .map(command => ({ toolName: 'Bash', toolInput: { command } })),
            { toolName: 'Bash', toolInput: { command: 42 } },
            { toolName: 'Edit', toolInput: { file_path: '/etc/hosts' } },
            { toolName: 'mcp__github__create_issue', toolInput: {} },
        ];
        const seen = new Set<string>();
        for (const phase of ['off', 'on'] as const) {
            if (phase === 'on') await app.cli('on');
            for (const request of requests) seen.add(app.decide(request).behavior);
        }
        // Malformed input from a buggy caller abstains rather than throwing.
        seen.add(app.decide({ toolName: 'Bash', toolInput: null as unknown as Data }).behavior);
        expect([...seen].sort()).toEqual(['abstain', 'allow']);
    });

    it('clears its timers when disposed', async () => {
        const app = await start();
        await app.cli('on');
        expect(vi.getTimerCount()).toBe(2);
        const calls = app.update.mock.calls.length;
        app.dispose();
        expect(vi.getTimerCount()).toBe(0);
        await advance(10 * MINUTE);
        expect(app.update.mock.calls.length).toBe(calls);
    });
});
