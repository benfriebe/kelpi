/**
 * `kelpi workspace color` (#393) against a real daemon, driven through THIS repo's CLI.
 *
 * The shipped Swift binary has no such verb, so like `workspace-icon.test.ts` these cases do not
 * follow `KELPI_COMPAT_CLI`: they bundle our own CLI (`bundleKelpiCLI`) and ask whether it and
 * the daemon agree. Assertions are on exit codes, parsed JSON and stderr, plus one real WebSocket
 * session, which is how a window would see the color arrive.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    bundleKelpiCLI,
    connectWindow,
    deltaEvents,
    rawRequest,
    startCompatDaemon,
    type CompatDaemon,
    type Message,
    type WorkspaceListEntryJSON
} from './harness.js';

interface ColorReply {
    readonly ok: boolean;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly color: string;
    readonly old_color: string;
}

interface CreateReply {
    readonly workspace_id: string;
}

const CHOICES = 'red, orange, yellow, green, blue, purple, pink, gray, black, white';

let bundleDir: string;
let cli: string;

beforeAll(async () => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-cli-'));
    cli = await bundleKelpiCLI(bundleDir);
}, 60_000);

afterAll(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true });
});

describe('compat: kelpi workspace color (this CLI)', () => {
    let kelpi: CompatDaemon;

    beforeEach(async () => {
        kelpi = await startCompatDaemon({ cli });
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    });

    const colors = async (): Promise<(string | undefined)[]> =>
        (await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json'])).map((entry) => entry.color);

    it('sets by name and by id, says when nothing changed, and workspace list shows it', async () => {
        const created = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'feat', '--color', 'blue', '--json']);

        const byName = await kelpi.json<ColorReply>(['workspace', 'color', 'feat', 'purple', '--json']);
        expect(byName).toEqual({
            ok: true,
            workspace_id: created.workspace_id,
            workspace_name: 'feat',
            color: 'purple',
            old_color: 'blue'
        });
        expect((await colors())[1]).toBe('purple');

        const byID = await kelpi.run(['workspace', 'color', created.workspace_id, 'Green']);
        expect(byID.code).toBe(0);
        expect(byID.stdout).toBe('feat: color set to green\n');

        const same = await kelpi.run(['workspace', 'color', 'feat', 'green']);
        expect(same.code).toBe(0);
        expect(same.stdout).toBe('feat: color is already green\n');
        expect((await colors())[1]).toBe('green');
    }, 60_000);

    it('exits 1 for a missing workspace, an ambiguous name, a bad color and --clear, changing nothing', async () => {
        await kelpi.json(['workspace', 'create', '--name', 'dup', '--color', 'red', '--json']);
        await kelpi.json(['workspace', 'create', '--name', 'dup', '--color', 'red', '--json']);
        const before = await colors();

        const missing = await kelpi.run(['workspace', 'color', 'ghost', 'red']);
        expect(missing.code).toBe(1);
        expect(missing.stdout).toBe('');
        expect(missing.stderr).toBe('kelpi workspace color: workspace not found: ghost\n');

        const ambiguous = await kelpi.run(['workspace', 'color', 'dup', 'blue']);
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stderr).toBe('kelpi workspace color: workspace name is ambiguous: dup (use the id)\n');

        const teal = await kelpi.run(['workspace', 'color', 'Default', 'teal']);
        expect(teal.code).toBe(1);
        expect(teal.stderr).toBe(`kelpi workspace color: 'teal' is not a workspace color: give one of ${CHOICES}\n`);

        const clear = await kelpi.run(['workspace', 'color', 'Default', '--clear']);
        expect(clear.code).toBe(1);
        expect(clear.stderr).toBe(`kelpi workspace color: a workspace always has a color; give one of ${CHOICES}\n`);
        expect(await colors()).toEqual(before);
    }, 60_000);

    it('refuses an unknown color on the wire itself, for callers other than the CLI', async () => {
        const before = await colors();
        const reply = await rawRequest(kelpi.port, { command: 'workspace-color', name: 'Default', color: 'teal' });
        expect(reply).toEqual({ ok: false, error: `'teal' is not a workspace color: give one of ${CHOICES}` });
        const absent = await rawRequest(kelpi.port, { command: 'workspace-color', name: 'Default' });
        expect(absent).toEqual({ ok: false, error: `workspace-color requires color: give one of ${CHOICES}` });
        expect(await colors()).toEqual(before);
    }, 60_000);

    it('reaches a connected window live, as a workspace upsert carrying the color', async () => {
        const created = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'feat', '--color', 'blue', '--json']);
        const session = await connectWindow(kelpi);
        try {
            const upsert = session.waitFor((message) =>
                deltaEvents(message).some(
                    (event) =>
                        event['kind'] === 'workspace-upserted' &&
                        (event['workspace'] as Message)['id'] === created.workspace_id &&
                        (event['workspace'] as Message)['color'] === 'purple'
                )
            );
            expect((await kelpi.run(['workspace', 'color', 'feat', 'purple'])).code).toBe(0);
            await upsert;
        } finally {
            session.close();
        }
    }, 60_000);
});
