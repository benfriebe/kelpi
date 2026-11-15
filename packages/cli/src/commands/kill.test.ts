import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every request sent to the daemon, and the reply each one gets. */
const sent = vi.hoisted(() => [] as { payload: Record<string, unknown>; timeoutSeconds: number | undefined }[]);
const replies = vi.hoisted(() => ({ next: '' }));
vi.mock('../transport.js', async (original) => ({
    ...(await original<object>()),
    sendJSONAndReadReply: (payload: Record<string, unknown>, options: { timeoutSeconds?: number } = {}) => {
        sent.push({ payload, timeoutSeconds: options.timeoutSeconds });
        return Promise.resolve(replies.next);
    }
}));

import { setEnv } from '../env.js';
import { ExitError, resetIO, setIO } from '../io.js';
import { describeStop, handleKill, parsePortTarget } from './kill.js';

const STOPPED = {
    id: 'process:400:1400',
    name: 'apps/web',
    ports: [3000, 3001],
    action: 'signal',
    signal: 'SIGTERM',
    signalled: 5,
    skipped: [],
    failed: [],
    remaining: [],
    stopped: true,
    restarted_by: null
};

let out = '';
let err = '';

async function run(args: string[]): Promise<number> {
    try {
        await handleKill(args);
        return 0;
    } catch (error) {
        if (error instanceof ExitError) return error.code;
        throw error;
    }
}

beforeEach(() => {
    out = '';
    err = '';
    setIO({ out: (text) => (out += text), err: (text) => (err += text) });
    setEnv({ HOME: '/Users/x' });
    replies.next = JSON.stringify({ ok: true, results: [STOPPED] });
});
afterEach(() => {
    sent.length = 0;
    resetIO();
    setEnv(process.env);
});

describe('kelpi kill', () => {
    it('reads :3000 and 3000 as a port, and anything else as an id', () => {
        expect(parsePortTarget(':3000')).toBe(3000);
        expect(parsePortTarget('3000')).toBe(3000);
        expect(parsePortTarget(':0')).toBeNull();
        expect(parsePortTarget('70000')).toBeNull();
        expect(parsePortTarget('process:400:1400')).toBeNull();
    });

    it('stops by port, waiting long enough for a Docker stop, and names what it stopped', async () => {
        expect(await run([':3000'])).toBe(0);
        expect(sent[0]?.payload).toEqual({ command: 'running-stop', port: 3000 });
        expect(sent[0]?.timeoutSeconds).toBeGreaterThanOrEqual(45);
        expect(out).toBe('Stopped apps/web (5 processes; ports 3000 3001).\n');
    });

    it('passes ids, --member, --force, --yes and --no-wait through', async () => {
        await run(['process:400:1400', '--member', '402', '--force', '--yes', '--no-wait']);
        expect(sent[0]?.payload).toEqual({
            command: 'running-stop',
            ids: ['process:400:1400'],
            member: '402',
            force: true,
            confirmed: true,
            wait_ms: 0
        });
    });

    it('refuses two ports, a port with ids, and no target at all, before asking the daemon', async () => {
        expect(await run([':3000', ':3001'])).toBe(1);
        expect(await run([':3000', 'process:1:2'])).toBe(1);
        expect(await run([])).toBe(1);
        expect(await run(['--bogus'])).toBe(1);
        expect(sent).toEqual([]);
    });

    it('says what is still running and how to end it, with exit 1', async () => {
        replies.next = JSON.stringify({ ok: true, results: [{ ...STOPPED, remaining: [402], stopped: false }] });
        expect(await run([':3000'])).toBe(1);
        expect(out).toBe('apps/web: 1 of 5 processes still running after the wait. `kelpi kill --force process:400:1400` ends them.\n');
    });

    it('tells an agent to ask the user before stopping something started outside Kelpi', async () => {
        replies.next = JSON.stringify({
            ok: true,
            results: [{ ...STOPPED, action: null, error: 'vite was started outside Kelpi (vite); ask the user before stopping it', code: 'NEEDS_CONFIRM' }]
        });
        expect(await run([':5173'])).toBe(1);
        expect(err).toContain('ask the user before stopping it. Once the user agrees, run it again with --yes.');
    });

    it("prints a refused request's error, such as an ambiguous port", async () => {
        replies.next = JSON.stringify({ ok: false, error: '2 services listen on port 3000: a (x), b (y); stop one by id', code: 'AMBIGUOUS_PORT' });
        expect(await run([':3000'])).toBe(1);
        expect(err).toContain('2 services listen on port 3000');
    });

    it('describes each kind of stop', () => {
        expect(describeStop({ ...STOPPED, action: 'interrupt', signal: null, remaining: null, stopped: null })).toBe(
            'Sent Ctrl-C to the pane running apps/web; ports 3000 3001.'
        );
        expect(describeStop({ ...STOPPED, action: 'stop-containers', signal: null, signalled: 3, ports: [5432] })).toBe('Stopped apps/web (3 containers; port 5432).');
        expect(describeStop({ ...STOPPED, signal: 'SIGKILL', remaining: null, stopped: null })).toBe('Sent SIGKILL to apps/web (5 processes; ports 3000 3001).');
        expect(describeStop({ ...STOPPED, restarted_by: 'apps/web' })).toContain('a supervisor restarted it');
        // Ctrl-C did not stop it: the next plain stop sends SIGTERM, not another Ctrl-C.
        expect(describeStop({ ...STOPPED, action: 'interrupt', signal: null, remaining: [402], stopped: false })).toBe(
            'Sent Ctrl-C to the pane running apps/web; 1 process still running after the wait. `kelpi kill process:400:1400` sends SIGTERM next, `--force` SIGKILL.'
        );
    });

    it('prints the results as JSON', async () => {
        await run([':3000', '--json']);
        expect(JSON.parse(out)).toEqual([STOPPED]);
    });
});
