import { describe, expect, it } from 'vitest';

import { flush, harness, id, seeded } from '../handlers/app/testing.js';
import type { RunningScanner } from './scanner.js';
import type { RunningScan, RunningService, RunningServiceCategory } from './types.js';

const W1 = id('aaaaaaaa', 1);
const W2 = id('aaaaaaaa', 2);
const P1 = id('dddddddd', 1);
const SCANNED_AT = Date.UTC(2026, 10, 15, 1, 2, 3);

function service(name: string, category: RunningServiceCategory, workspaceID: string | null): RunningService {
    return {
        id: `process:${name}`,
        kind: 'process',
        name,
        command: `node ${name}.js`,
        category,
        workspaceID,
        workspaceName: workspaceID === W1 ? 'w1' : workspaceID === W2 ? 'w2' : null,
        paneID: workspaceID === W1 ? P1.toLowerCase() : null,
        attribution: workspaceID === null ? 'none' : 'process-tree',
        startedBy: 'agent',
        agent: 'claude',
        foreground: false,
        directory: '/w/one',
        directoryWorkspaceID: null,
        directoryWorkspaceName: null,
        directoryMissing: false,
        worktree: null,
        startedAt: Date.UTC(2026, 10, 4, 5, 42, 29) / 1000,
        pid: 4242,
        processCount: 3,
        rssBytes: 1_048_576,
        ports: [{ port: 3200, address: '*', exposed: true, pid: 4243, containerPort: null }],
        members: [
            {
                name: 'web',
                pid: 4243,
                containerID: null,
                image: null,
                ports: [{ port: 3200, address: '*', exposed: true, pid: 4243, containerPort: null }],
                rssBytes: 524_288
            }
        ]
    };
}

const SERVICES: RunningService[] = [
    service('one', 'workspace', W1),
    service('two', 'workspace', W2),
    service('leftover', 'unattached', null),
    service('ollama', 'outside', null),
    service('claude', 'agent', W1)
];

function scanner(result: RunningScan | Error = { services: SERVICES, scannedAt: SCANNED_AT, warnings: ['docker: timed out'] }): RunningScanner & { calls: number } {
    const fake = {
        calls: 0,
        scan() {
            fake.calls += 1;
            return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        }
    };
    return fake;
}

async function ask(h: ReturnType<typeof harness>, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payloads = h.send({ command: 'running-list', ...payload });
    await flush();
    expect(payloads).toHaveLength(1);
    return payloads[0] as Record<string, unknown>;
}

const names = (reply: Record<string, unknown>): string[] => (reply['services'] as { name: string }[]).map((entry) => entry.name);

describe('running-list', () => {
    it("lists workspaces' services and unattached ones, in the wire shape", async () => {
        const h = harness({ initial: seeded(2), running: scanner() });
        const reply = await ask(h, {});
        expect(reply['ok']).toBe(true);
        expect(names(reply)).toEqual(['one', 'two', 'leftover']);
        expect(reply['scanned_at']).toBe('2026-11-15T01:02:03Z');
        expect(reply['warnings']).toEqual(['docker: timed out']);
        expect((reply['services'] as unknown[])[0]).toEqual({
            id: 'process:one',
            kind: 'process',
            name: 'one',
            command: 'node one.js',
            category: 'workspace',
            workspace_id: W1,
            workspace_name: 'w1',
            pane_id: P1,
            attribution: 'process-tree',
            started_by: 'agent',
            agent: 'claude',
            foreground: false,
            directory: '/w/one',
            directory_workspace_id: null,
            directory_workspace_name: null,
            directory_missing: false,
            worktree: null,
            started_at: '2026-11-04T05:42:29Z',
            pid: 4242,
            process_count: 3,
            rss_bytes: 1_048_576,
            ports: [{ port: 3200, address: '*', exposed: true, pid: 4243, container_port: null }],
            members: [
                {
                    name: 'web',
                    pid: 4243,
                    container_id: null,
                    image: null,
                    ports: [{ port: 3200, address: '*', exposed: true, pid: 4243, container_port: null }],
                    rss_bytes: 524_288
                }
            ]
        });
        expect(h.replies[0]?.closed).toBe(true);
    });

    it('adds what was started outside Kelpi and agents’ own ports with all', async () => {
        const h = harness({ initial: seeded(2), running: scanner() });
        expect(names(await ask(h, { all: true }))).toEqual(['one', 'two', 'leftover', 'ollama', 'claude']);
    });

    it("narrows to one workspace by name or id, the agent's own port included", async () => {
        const h = harness({ initial: seeded(2), running: scanner() });
        expect(names(await ask(h, { workspace: 'w1' }))).toEqual(['one', 'claude']);
        expect(names(await ask(h, { workspace: W2.toLowerCase() }))).toEqual(['two']);
    });

    it("narrows to the requesting pane's workspace with scope current", async () => {
        const h = harness({ initial: seeded(2), running: scanner() });
        expect(names(await ask(h, { scope: 'current', pane_id: P1 }))).toEqual(['one', 'claude']);
    });

    it('answers --current from a parked pane too', async () => {
        const state = seeded(2);
        const [first, second] = state.workspaces;
        if (first === undefined || second === undefined) throw new Error('seeded');
        const parked = { ...state, workspaces: [{ ...first, panes: [], parkedPanes: first.panes }, second] };
        const h = harness({ initial: parked, running: scanner() });
        expect(names(await ask(h, { scope: 'current', pane_id: P1 }))).toEqual(['one', 'claude']);
    });

    it('refuses a bad request before scanning', async () => {
        const running = scanner();
        const h = harness({ initial: seeded(2), running });
        expect(await ask(h, { workspace: 'ghost' })).toEqual({ ok: false, error: 'workspace not found: ghost' });
        expect(await ask(h, { scope: 'current' })).toEqual({ ok: false, error: 'no workspace contains the requesting pane' });
        expect(await ask(h, { scope: 'everything' })).toEqual({ ok: false, error: 'unknown scope: everything' });
        expect(await ask(h, { scope: 'current', pane_id: P1, workspace: 'w1' })).toEqual({
            ok: false,
            error: 'workspace and --current are mutually exclusive'
        });
        expect(running.calls).toBe(0);
    });

    it('says when the scan itself failed', async () => {
        const h = harness({ initial: seeded(1), running: scanner(new Error('boom')) });
        expect(await ask(h, {})).toEqual({ ok: false, error: 'running-list failed: boom' });
    });

    it('finds nothing without a host scanner', async () => {
        const h = harness({ initial: seeded(1) });
        const reply = await ask(h, { all: true });
        expect(reply).toMatchObject({ ok: true, services: [], warnings: [] });
    });
});
