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
import { resetIO, setIO } from '../io.js';
import { ageLabel, cpuLabel, memoryLabel, printServicesTable } from '../table.js';
import { handlePs } from './ps.js';

const PANE = '9C2B9A2E-1111-2222-3333-444455556666';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';

const TURBO = {
    id: 'process:54596:1793000000',
    kind: 'process',
    name: 'pnpm run dev:prebuilt',
    category: 'workspace',
    workspace_id: W1,
    workspace_name: 'checkout',
    started_by: 'agent',
    agent: 'claude',
    foreground: false,
    directory: '/Users/x/kelpi/worktrees/shop/feature-flags',
    directory_workspace_id: null,
    directory_missing: false,
    started_at: '2026-11-04T05:42:29Z',
    rss_bytes: 1_476_395_008,
    cpu_percent: 23.4,
    ports: [3200, 3201, 3202, 3204, 54536].map((port) => ({ port, address: '*', exposed: port === 3200 }))
};

const LEFTOVER = {
    id: 'compose:shop-400',
    kind: 'compose',
    name: 'shop-400',
    category: 'unattached',
    workspace_id: null,
    workspace_name: null,
    started_by: 'compose',
    agent: null,
    directory: '/Users/x/kelpi/worktrees/shop/old-branch/packages',
    directory_missing: true,
    started_at: '2026-11-06T00:00:00Z',
    rss_bytes: null,
    ports: [{ port: 54721, address: '127.0.0.1', exposed: false }]
};

const NOTES = {
    id: 'process:51513:1',
    kind: 'process',
    name: 'pnpm start',
    category: 'workspace',
    workspace_id: 'W2',
    workspace_name: 'notes',
    started_by: 'pane',
    agent: null,
    foreground: true,
    directory: '/Users/x/repos/notes',
    directory_workspace_id: 'W2',
    started_at: '2026-11-15T07:00:00Z',
    rss_bytes: 222_298_112,
    cpu_percent: 0.3,
    ports: [{ port: 4400, address: '127.0.0.1', exposed: false }]
};

const OLLAMA = { name: 'ollama serve', category: 'outside', started_by: 'unknown', directory: '/', ports: [] };
const NOW = Date.parse('2026-11-15T09:40:00Z');

let out = '';
let err = '';

beforeEach(() => {
    out = '';
    err = '';
    setIO({ out: (text) => (out += text), err: (text) => (err += text) });
    setEnv({ HOME: '/Users/x', KELPI_PANE_ID: PANE });
    replies.next = JSON.stringify({ ok: true, services: [TURBO, LEFTOVER], scanned_at: '2026-11-15T09:40:00Z', warnings: [] });
});
afterEach(() => {
    sent.length = 0;
    resetIO();
    setEnv(process.env);
});

describe('kelpi ps', () => {
    it('asks for running-list with no filter, and waits long enough for a scan', async () => {
        await handlePs(['--json']);
        expect(sent.map((entry) => entry.payload)).toEqual([{ command: 'running-list' }]);
        expect(sent[0]?.timeoutSeconds).toBeGreaterThanOrEqual(15);
        expect(JSON.parse(out)).toEqual([TURBO, LEFTOVER]);
    });

    it('passes --workspace, --current and --all through', async () => {
        await handlePs(['--workspace', 'checkout', '--all', '--json']);
        await handlePs(['--current', '--json']);
        expect(sent.map((entry) => entry.payload)).toEqual([
            { command: 'running-list', workspace: 'checkout', all: true },
            { command: 'running-list', pane_id: PANE, scope: 'current' }
        ]);
    });

    it('refuses --workspace with --current, and stray arguments, without asking the daemon', async () => {
        await expect(handlePs(['--workspace', 'x', '--current'])).rejects.toMatchObject({ code: 1 });
        expect(err).toContain('--workspace and --current are mutually exclusive');
        await expect(handlePs(['3000'])).rejects.toMatchObject({ code: 1 });
        expect(sent).toEqual([]);
    });

    it('prints help and sends nothing', async () => {
        await expect(handlePs(['--help'])).rejects.toMatchObject({ code: 0 });
        expect(out).toContain('kelpi ps [--workspace <name-or-uuid> | --current] [--all] [--json] [--no-header]');
        expect(sent).toEqual([]);
    });

    it('prints an empty JSON list for --current outside a pane, without asking the daemon', async () => {
        setEnv({ HOME: '/Users/x' });
        await expect(handlePs(['--current', '--json'])).rejects.toMatchObject({ code: 0 });
        expect(out).toBe('[]\n');
        out = '';
        await expect(handlePs(['--current'])).rejects.toMatchObject({ code: 0 });
        expect(out).toBe('');
        expect(sent).toEqual([]);
    });

    it("measures UP against the daemon's scan time, not this machine's clock", async () => {
        replies.next = JSON.stringify({ ok: true, services: [NOTES], scanned_at: '2026-11-15T07:30:00Z', warnings: [] });
        await handlePs(['--no-header']);
        expect(out).toContain(' 30m ');
    });

    it('puts warnings on stderr and still prints the list', async () => {
        replies.next = JSON.stringify({ ok: true, services: [NOTES], warnings: ['docker: timed out'] });
        await handlePs(['--json']);
        expect(err).toBe('kelpi ps: warning: docker: timed out\n');
        expect(JSON.parse(out)).toEqual([NOTES]);
    });

    it("exits 1 with the daemon's refusal", async () => {
        replies.next = JSON.stringify({ ok: false, error: 'workspace not found: ghost' });
        await expect(handlePs(['--workspace', 'ghost'])).rejects.toMatchObject({ code: 1 });
        expect(err).toContain('workspace not found: ghost');
    });
});

describe('printServicesTable', () => {
    it('shows workspace, service, ports, age, memory, who started it and where it runs', () => {
        setIO({ out: (text) => (out += text), err: () => undefined });
        printServicesTable([TURBO, NOTES, LEFTOVER, OLLAMA], false, '/Users/x', NOW);
        expect(out.split('\n')).toEqual([
            'WORKSPACE        SERVICE                PORTS                   UP   MEM   CPU   STARTED BY         NOTE',
            'checkout         pnpm run dev:prebuilt  3200 3201 3202 3204 +1  11d  1.4G  23%   claude             runs in ~/kelpi/worktrees/shop/feature-flags; reachable on network',
            'notes            pnpm start             4400                    2h   212M  0.3%  pane (foreground)',
            '(no workspace)   shop-400               54721                   9d   -     -     compose            in ~/kelpi/worktrees/shop/old-branch/packages (deleted)',
            '(outside Kelpi)  ollama serve           -                       -    -     -     -                  in /',
            ''
        ]);
    });

    it('never passes a control character from a name to the terminal', () => {
        setIO({ out: (text) => (out += text), err: () => undefined });
        printServicesTable([{ name: 'evil\u001b]0;pwned\u0007', category: 'outside', started_by: 'unknown', ports: [] }], true, '/Users/x', NOW);
        expect(out).toBe('(outside Kelpi)  evil?]0;pwned?  -  -  -  -  -\n');
    });

    it('formats ages and memory', () => {
        expect(ageLabel(undefined, NOW)).toBe('-');
        expect(ageLabel('2026-11-15T09:39:30Z', NOW)).toBe('30s');
        expect(ageLabel('2026-11-15T09:28:00Z', NOW)).toBe('12m');
        expect(memoryLabel(undefined)).toBe('-');
        expect(memoryLabel(0)).toBe('0M');
        expect(memoryLabel(1024)).toBe('1M');
        expect(memoryLabel(512 * 1_048_576)).toBe('512M');
        expect(memoryLabel(1536 * 1_048_576)).toBe('1.5G');
        expect(cpuLabel(undefined)).toBe('-');
        expect(cpuLabel(0)).toBe('0%');
        expect(cpuLabel(0.34)).toBe('0.3%');
        expect(cpuLabel(123.6)).toBe('124%');
    });
});
