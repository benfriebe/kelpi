/**
 * `kelpi ps` (docs/running-services.md) against a real daemon, driven through THIS repo's CLI: a
 * server started in a pane is found by the real probes (`ps`, `lsof`) and listed under that
 * pane's workspace. The daemon runs in this test process, so the test also proves the daemon's
 * own listening ports are never listed.
 *
 * Skipped where `lsof` is missing: the scan then has no listening ports to find (it says so in
 * its warnings, which the unit tests cover).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { bundleKelpiCLI, eventually, startCompatDaemon, type CompatDaemon } from './harness.js';

interface ServiceJSON {
    readonly name: string;
    readonly category: string;
    readonly workspace_name: string | null;
    readonly pane_id: string | null;
    readonly attribution: string;
    readonly started_by: string;
    readonly foreground: boolean;
    readonly pid: number | null;
    readonly ports: readonly { readonly port: number; readonly address: string; readonly exposed: boolean }[];
}

interface PaneJSON {
    readonly id: string;
}

const HAS_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].some((file) => fs.existsSync(file));

let bundleDir: string;
let cli: string;

beforeAll(async () => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-cli-'));
    cli = await bundleKelpiCLI(bundleDir);
}, 60_000);

afterAll(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_LSOF)('compat: kelpi ps (this CLI)', () => {
    let kelpi: CompatDaemon;

    beforeEach(async () => {
        kelpi = await startCompatDaemon({ cli });
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    });

    it("lists a server started in a pane under that pane's workspace, and never the daemon itself", async () => {
        const folder = fs.mkdtempSync(path.join(kelpi.root, 'svc-'));
        await kelpi.json(['workspace', 'create', '--name', 'svc', '--path', folder, '--json']);
        const [pane] = await kelpi.json<PaneJSON[]>(['pane', 'list', '--workspace', 'svc', '--json']);
        const paneID = pane?.id ?? '';
        // The pane's shell runs it in the foreground, the way `pnpm dev` would.
        const server = `${process.execPath} -e "require('net').createServer().listen(0, '127.0.0.1')"`;
        await kelpi.json(['pane', 'send', '--target', paneID, '--json', server]);

        const services = await eventually(
            () => kelpi.json<ServiceJSON[]>(['ps', '--workspace', 'svc', '--json']),
            (list) => list.length > 0,
            15_000
        );
        expect(services).toHaveLength(1);
        const [found] = services;
        expect(found).toMatchObject({
            category: 'workspace',
            workspace_name: 'svc',
            pane_id: paneID,
            attribution: 'process-tree',
            started_by: 'pane',
            foreground: true
        });
        expect(found?.ports).toHaveLength(1);
        expect(found?.ports[0]).toMatchObject({ address: '127.0.0.1', exposed: false });

        // `--current` from that pane finds it the same way.
        const current = await kelpi.json<ServiceJSON[]>(['ps', '--current', '--json'], { paneID });
        expect(current.map((service) => service.pid)).toEqual([found?.pid]);

        // The default list has it too; `--all` adds other things on this machine, never the daemon.
        const listed = await kelpi.json<ServiceJSON[]>(['ps', '--json']);
        expect(listed.map((service) => service.pid)).toContain(found?.pid);
        const everything = await kelpi.json<ServiceJSON[]>(['ps', '--all', '--json']);
        expect(everything.map((service) => service.pid)).not.toContain(process.pid);

        const table = await kelpi.run(['ps', '--workspace', 'svc']);
        expect(table.code).toBe(0);
        expect(table.stdout.split('\n')[0]).toMatch(/^WORKSPACE\s+SERVICE\s+PORTS\s+UP\s+MEM\s+STARTED BY\s+NOTE$/);
        expect(table.stdout).toContain('pane (foreground)');
    }, 60_000);

    // docs/running-services.md §6: `kelpi kill` against the real probes and real signals.
    it('stops a foreground server with Ctrl-C in its pane, and a background one by port with SIGTERM', async () => {
        const folder = fs.mkdtempSync(path.join(kelpi.root, 'kill-'));
        await kelpi.json(['workspace', 'create', '--name', 'kill', '--path', folder, '--json']);
        const [pane] = await kelpi.json<PaneJSON[]>(['pane', 'list', '--workspace', 'kill', '--json']);
        const paneID = pane?.id ?? '';
        const listen = `${process.execPath} -e "require('net').createServer().listen(0, '127.0.0.1')"`;

        // In the background first (a job of the pane's shell that does not own the terminal),
        // then one in the foreground.
        await kelpi.json(['pane', 'send', '--target', paneID, '--json', `${listen} > /dev/null 2>&1 &`]);
        await kelpi.json(['pane', 'send', '--target', paneID, '--json', listen]);
        const both = await eventually(
            () => kelpi.json<(ServiceJSON & { id: string })[]>(['ps', '--workspace', 'kill', '--json']),
            (list) => list.length === 2,
            15_000
        );
        const background = both.find((service) => !service.foreground);
        const foreground = both.find((service) => service.foreground);
        expect(background).toBeDefined();
        expect(foreground).toBeDefined();

        const byPort = await kelpi.json<{ action: string; stopped: boolean; ports: number[] }[]>([
            'kill',
            `:${String(background?.ports[0]?.port ?? 0)}`,
            '--json'
        ]);
        expect(byPort).toMatchObject([{ action: 'signal', stopped: true }]);

        const interrupted = await kelpi.json<{ action: string; stopped: boolean }[]>(['kill', foreground?.id ?? '', '--json']);
        expect(interrupted).toMatchObject([{ action: 'interrupt', stopped: true }]);

        const after = await eventually(
            () => kelpi.json<ServiceJSON[]>(['ps', '--workspace', 'kill', '--json']),
            (list) => list.length === 0,
            15_000
        );
        expect(after).toEqual([]);
        // The pane's shell is still there to type into.
        const panes = await kelpi.json<PaneJSON[]>(['pane', 'list', '--workspace', 'kill', '--json']);
        expect(panes.map((entry) => entry.id)).toEqual([paneID]);
    }, 60_000);

    it('refuses to stop the daemon itself, by refusing what it cannot find', async () => {
        const refused = await kelpi.run(['kill', `process:${String(process.pid)}:1`]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain('is not running');
    }, 60_000);

    it('refuses an unknown workspace', async () => {
        const ghost = await kelpi.run(['ps', '--workspace', 'ghost']);
        expect(ghost.code).toBe(1);
        expect(ghost.stderr).toContain('workspace not found: ghost');
    }, 60_000);
});
