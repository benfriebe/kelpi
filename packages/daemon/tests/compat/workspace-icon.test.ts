/**
 * `kelpi workspace icon` against a real daemon, driven through THIS repo's CLI.
 *
 * The shipped Swift binary has no such verb, so like `workspace-rename.test.ts` these cases do not
 * follow `KELPI_COMPAT_CLI`: they bundle our own CLI (`bundleKelpiCLI`) and ask whether it and
 * the daemon agree. Assertions are on exit codes, parsed JSON and stderr, plus one real WebSocket
 * session, which is how a window would see the icon arrive.
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

interface IconReply {
    readonly ok: boolean;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly icon: string | null;
    readonly old_icon: string | null;
}

interface CreateReply {
    readonly workspace_id: string;
    readonly icon?: string;
}

let bundleDir: string;
let cli: string;

beforeAll(async () => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-cli-'));
    cli = await bundleKelpiCLI(bundleDir);
}, 60_000);

afterAll(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true });
});

describe('compat: kelpi workspace icon (this CLI)', () => {
    let kelpi: CompatDaemon;

    beforeEach(async () => {
        kelpi = await startCompatDaemon({ cli });
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    });

    const icons = async (): Promise<(string | undefined)[]> =>
        (await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json'])).map((entry) => entry.icon);

    it('sets by name and by id, clears, and workspace list shows it', async () => {
        const created = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'chef', '--json']);
        expect(created.icon).toBeUndefined();

        const byName = await kelpi.json<IconReply>(['workspace', 'icon', 'chef', '👩‍🍳', '--json']);
        expect(byName).toEqual({ ok: true, workspace_id: created.workspace_id, workspace_name: 'chef', icon: 'emoji:👩‍🍳', old_icon: null });
        expect(await icons()).toEqual([undefined, 'emoji:👩‍🍳']);

        const byID = await kelpi.run(['workspace', 'icon', created.workspace_id, '🇦🇺']);
        expect(byID.code).toBe(0);
        expect(byID.stdout).toBe('chef: icon set to 🇦🇺\n');

        // The same icon again: success, nothing changes.
        const same = await kelpi.run(['workspace', 'icon', 'chef', '🇦🇺']);
        expect(same.code).toBe(0);
        expect(same.stdout).toBe('chef: icon is already 🇦🇺\n');
        expect(await icons()).toEqual([undefined, 'emoji:🇦🇺']);

        const cleared = await kelpi.run(['workspace', 'icon', 'chef', '--clear']);
        expect(cleared.code).toBe(0);
        expect(cleared.stdout).toBe('chef: icon cleared\n');
        expect(await icons()).toEqual([undefined, undefined]);
    }, 60_000);

    it('creates a workspace with its icon', async () => {
        const created = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'lab', '--icon', '🧪', '--json']);
        expect(created.icon).toBe('emoji:🧪');
        expect(await icons()).toEqual([undefined, 'emoji:🧪']);

        const refused = await kelpi.run(['workspace', 'create', '--name', 'bad', '--icon', 'abc']);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toBe("kelpi workspace create: 'abc' is not a usable icon: give one emoji or symbol\n");
        expect(await icons()).toEqual([undefined, 'emoji:🧪']);
    }, 60_000);

    it('exits 1 for a missing workspace, an ambiguous name and a bad icon, changing nothing', async () => {
        await kelpi.json(['workspace', 'create', '--name', 'dup', '--json']);
        await kelpi.json(['workspace', 'create', '--name', 'dup', '--json']);

        const missing = await kelpi.run(['workspace', 'icon', 'ghost', '🔥']);
        expect(missing.code).toBe(1);
        expect(missing.stdout).toBe('');
        expect(missing.stderr).toBe('kelpi workspace icon: workspace not found: ghost\n');

        const ambiguous = await kelpi.run(['workspace', 'icon', 'dup', '🔥']);
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stderr).toBe('kelpi workspace icon: workspace name is ambiguous: dup (use the id)\n');

        for (const bad of ['abc', '🔥🔥']) {
            const result = await kelpi.run(['workspace', 'icon', 'Default', bad]);
            expect(result.code).toBe(1);
            expect(result.stderr).toBe(`kelpi workspace icon: '${bad}' is not a usable icon: give one emoji or symbol\n`);
        }
        const prefixed = await kelpi.run(['workspace', 'icon', 'Default', 'emoji:🔥']);
        expect(prefixed.code).toBe(1);
        expect(prefixed.stderr).toBe('kelpi workspace icon: give the bare emoji, without the emoji: prefix\n');
        expect(await icons()).toEqual([undefined, undefined, undefined]);
    }, 60_000);

    it('refuses an unusable icon on the wire itself, for callers other than the CLI', async () => {
        const reply = await rawRequest(kelpi.port, { command: 'workspace-icon', name: 'Default', icon: 'emoji:a' });
        expect(reply).toEqual({ ok: false, error: "'a' is not a usable icon: give one emoji or symbol" });
        const unparsed = await rawRequest(kelpi.port, { command: 'workspace-icon', name: 'Default', icon: '' });
        expect(unparsed).toEqual({ ok: false, error: "'' is not an icon: give emoji:<emoji> or system:<symbol>" });
        // One grapheme cluster, about 6000 characters long: refused, on create as well.
        const chain = `emoji:${Array.from({ length: 2000 }, () => '🔥').join('\u200d')}`;
        const long = await rawRequest(kelpi.port, { command: 'workspace-icon', name: 'Default', icon: chain });
        expect(long).toEqual({ ok: false, error: 'the icon is too long: give one emoji or symbol' });
        const created = await rawRequest(kelpi.port, { command: 'workspace-create', name: 'long', icon: chain });
        expect(created).toEqual({ ok: false, error: 'the icon is too long: give one emoji or symbol' });
        expect(await icons()).toEqual([undefined]);
    }, 60_000);

    it('reaches a connected window live, as a workspace upsert carrying the icon', async () => {
        const created = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'chef', '--json']);
        const session = await connectWindow(kelpi);
        try {
            const upsert = session.waitFor((message) =>
                deltaEvents(message).some(
                    (event) =>
                        event['kind'] === 'workspace-upserted' &&
                        (event['workspace'] as Message)['id'] === created.workspace_id &&
                        JSON.stringify((event['workspace'] as Message)['icon']).includes('👩‍🍳')
                )
            );
            expect((await kelpi.run(['workspace', 'icon', 'chef', '👩‍🍳'])).code).toBe(0);
            await upsert;
        } finally {
            session.close();
        }
    }, 60_000);
});
