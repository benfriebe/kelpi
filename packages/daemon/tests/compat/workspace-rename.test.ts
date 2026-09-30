/**
 * `kelpi workspace rename` (#266) against a real daemon, driven through THIS repo's CLI.
 *
 * The shipped Swift binary has no such verb, so unlike the rest of this directory these cases do
 * not follow `KELPI_COMPAT_CLI`: they bundle our own CLI (`bundleKelpiCLI`) and ask whether it
 * and the daemon agree. Assertions are on exit codes, parsed JSON and stderr, plus one real
 * WebSocket session, which is how a window would see the rename arrive.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { WS_PROTOCOL_VERSION } from '@kelpi/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { readToken } from '../../src/lifecycle/index.js';
import { bundleKelpiCLI, startCompatDaemon, type CompatDaemon, type WorkspaceListEntryJSON } from './harness.js';

interface RenameReply {
    readonly ok: boolean;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly old_name: string;
}

interface CreateReply {
    readonly workspace_id: string;
}

type Message = Record<string, unknown>;

let bundleDir: string;
let cli: string;

beforeAll(async () => {
    bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-cli-'));
    cli = await bundleKelpiCLI(bundleDir);
}, 60_000);

afterAll(() => {
    fs.rmSync(bundleDir, { recursive: true, force: true });
});

describe('compat: kelpi workspace rename (this CLI)', () => {
    let kelpi: CompatDaemon;

    beforeEach(async () => {
        kelpi = await startCompatDaemon({ cli });
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    });

    const names = async (): Promise<string[]> =>
        (await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json'])).map((entry) => entry.name);

    it('renames by name and then by id, keeping the id, and workspace list shows it', async () => {
        const created = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'alpha', '--json']);
        expect(await names()).toEqual(['Default', 'alpha']);

        const byName = await kelpi.json<RenameReply>(['workspace', 'rename', 'alpha', 'auth refactor', '--json']);
        expect(byName).toEqual({
            ok: true,
            workspace_id: created.workspace_id,
            workspace_name: 'auth refactor',
            old_name: 'alpha'
        });
        expect(await names()).toEqual(['Default', 'auth refactor']);

        // By id, in the human form: one line naming the change and the id.
        const byID = await kelpi.run(['workspace', 'rename', created.workspace_id, 'billing']);
        expect(byID.code).toBe(0);
        expect(byID.stdout).toBe(`renamed workspace auth refactor to billing (${created.workspace_id})\n`);

        const list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(list.find((entry) => entry.id === created.workspace_id)?.name).toBe('billing');
        expect(list.map((entry) => entry.name)).toEqual(['Default', 'billing']);
    }, 60_000);

    it('exits 1 for a missing workspace, an ambiguous name and an empty new name, changing nothing', async () => {
        await kelpi.json(['workspace', 'create', '--name', 'dup', '--json']);
        await kelpi.json(['workspace', 'create', '--name', 'dup', '--json']);
        const before = await names();

        const missing = await kelpi.run(['workspace', 'rename', 'ghost', 'x']);
        expect(missing.code).toBe(1);
        expect(missing.stdout).toBe('');
        expect(missing.stderr).toBe('kelpi workspace rename: workspace not found: ghost\n');

        const ambiguous = await kelpi.run(['workspace', 'rename', 'dup', 'x']);
        expect(ambiguous.code).toBe(1);
        expect(ambiguous.stderr).toBe('kelpi workspace rename: workspace name is ambiguous: dup (use the id)\n');

        const empty = await kelpi.run(['workspace', 'rename', 'Default', '   ']);
        expect(empty.code).toBe(1);
        expect(empty.stderr).toBe('kelpi workspace rename: the new name cannot be empty\n');

        expect(await names()).toEqual(before);

        // The id still reaches one of the twins, which is what the ambiguity message points at.
        const list = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        const twin = list.filter((entry) => entry.name === 'dup')[1];
        expect((await kelpi.run(['workspace', 'rename', twin?.id ?? '', 'dup-2'])).code).toBe(0);
        expect(await names()).toEqual(['Default', 'dup', 'dup-2']);
    }, 60_000);

    it('refuses a whitespace-only new_name on the wire itself, for callers other than the CLI', async () => {
        const reply = await rawRequest(kelpi.port, { command: 'workspace-rename', name: 'Default', new_name: ' \t ' });
        expect(reply).toEqual({ ok: false, error: 'workspace name cannot be empty' });
        const guard = await rawRequest(kelpi.port, { command: 'workspace-rename', name: 'Default', new_name: '' });
        expect(guard).toEqual({ ok: false, error: 'workspace-rename requires new_name' });
        expect(await names()).toEqual(['Default']);
    }, 60_000);

    it('reaches a connected window live, as a workspace upsert carrying the new name', async () => {
        const created = await kelpi.json<CreateReply>(['workspace', 'create', '--name', 'alpha', '--json']);
        const session = await connectWindow(kelpi);
        try {
            const upsert = session.waitFor((message) =>
                deltaEvents(message).some(
                    (event) =>
                        event['kind'] === 'workspace-upserted' &&
                        (event['workspace'] as Message)['id'] === created.workspace_id &&
                        (event['workspace'] as Message)['name'] === 'renamed live'
                )
            );
            expect((await kelpi.run(['workspace', 'rename', 'alpha', 'renamed live'])).code).toBe(0);
            await upsert;
        } finally {
            session.close();
        }
    }, 60_000);
});

function deltaEvents(message: Message): Message[] {
    if (message['type'] !== 'delta' || !Array.isArray(message['events'])) return [];
    return message['events'] as Message[];
}

/** One control line over TCP, one reply line back: what the CLI does, minus the CLI. */
function rawRequest(port: number, message: Message): Promise<Message> {
    return new Promise<Message>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let pending = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('timed out waiting for a reply'));
        }, 10_000);
        socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            pending += chunk;
            const index = pending.indexOf('\n');
            if (index < 0) return;
            clearTimeout(timer);
            socket.destroy();
            resolve(JSON.parse(pending.slice(0, index)) as Message);
        });
        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

interface WindowSession {
    waitFor(predicate: (message: Message) => boolean): Promise<Message>;
    close(): void;
}

/** A WebSocket session with the owner's token, past `welcome`, the way a window attaches. */
async function connectWindow(kelpi: CompatDaemon): Promise<WindowSession> {
    const token = readToken(kelpi.daemon.paths) ?? '';
    const socket = new WebSocket(`ws://127.0.0.1:${String(kelpi.info.httpPort)}/ws?token=${token}`);
    const seen: Message[] = [];
    const waiters: { predicate: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
    socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as Message;
        seen.push(message);
        for (const waiter of [...waiters]) {
            if (!waiter.predicate(message)) continue;
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
        }
    });
    const waitFor = (predicate: (message: Message) => boolean): Promise<Message> =>
        new Promise<Message>((resolve, reject) => {
            const hit = seen.find(predicate);
            if (hit !== undefined) {
                resolve(hit);
                return;
            }
            const timer = setTimeout(() => reject(new Error('timed out waiting for a WebSocket message')), 10_000);
            waiters.push({
                predicate,
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message);
                }
            });
        });
    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token }));
    await waitFor((message) => message['type'] === 'snapshot');
    return { waitFor, close: () => socket.close() };
}
