import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@kelpi/protocol';
import { harness, id, seeded } from '../handlers/app/testing.js';
import { BUNDLED_PERMISSIONS_PROVIDER } from './permissions-service.js';
import { PluginService } from './service.js';

const P1 = id('dddddddd', 1);
const W1 = id('aaaaaaaa', 1);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('agent.event reaches plugin backends (#387)', () => {
    it('through api.events.on and api.agents.onEvent, one per hook line, as a plugin-event and never a daemon broadcast', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-agent-events-'));
        const broadcast = vi.fn();
        let service: PluginService | undefined;
        const app = harness({ initial: seeded(1), emitAgentEvent: event => { service?.emitDaemonEvent('agent.event', event as unknown as JsonValue); } });
        service = new PluginService({ directory: path.join(root, 'installed'), store: app.store, command: async () => ({ ok: true }), broadcast });
        cleanups.push(async () => { await service?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
        const source = path.join(root, 'sample.agents'); fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({
            id: 'sample.agents', name: 'Agents', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'startup', backend: 'backend.mjs',
            contributes: { commands: [{ id: 'sample.agents.seen', title: 'Seen' }] }
        }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), `export function activate(api) {
            const seen = [];
            api.events.on('agent.event', event => { seen.push(['events.on', event.data.type, event.data.status]); });
            api.agents.onEvent((event, raw) => { seen.push(['agents.onEvent', event.type, event.notificationType ?? null, raw.name]); });
            api.commands.register('sample.agents.seen', () => seen);
        }`);
        await service.install(source, true);
        const seen = () => service!.request('run', { command: 'sample.agents.seen' });
        await vi.waitFor(async () => expect(await seen()).toEqual([]));

        // A stop with a session id dual-fires a session-start: still one event.
        app.send({ command: 'stop', pane_id: P1, session_id: 'sess-1' });
        app.send({ command: 'notification', pane_id: P1, title: 'Claude Code', body: 'Approve?', notification_type: 'permission_prompt' });
        await vi.waitFor(async () => expect(await seen()).toHaveLength(4));
        expect(await seen()).toEqual([
            ['events.on', 'stop', 'waitingForInput'],
            ['agents.onEvent', 'stop', null, 'agent.event'],
            ['events.on', 'notification', 'waitingForInput'],
            ['agents.onEvent', 'notification', 'permission_prompt', 'agent.event']
        ]);
        // Views hear it as a plugin-event; no daemon broadcast relays it as `daemon.agent-event`.
        expect(broadcast.mock.calls.map(([message]) => message.type === 'plugin-event' ? message.event.name : message.type).filter(name => String(name).includes('agent'))).toEqual(['agent.event', 'agent.event']);
    });

    it('includes one permission-request event for a request the bundled provider answers (#388)', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-agent-events-'));
        let service: PluginService | undefined;
        const app = harness({
            initial: seeded(1),
            emitAgentEvent: event => { service?.emitDaemonEvent('agent.event', event as unknown as JsonValue); },
            decidePermission: (args, signal) => ({
                provider: BUNDLED_PERMISSIONS_PROVIDER,
                result: service!.callService({ service: 'kelpi.agent.permissions', version: 1, method: 'decide', args, provider: BUNDLED_PERMISSIONS_PROVIDER }, { daemonID: service!.daemonID }, signal)
            })
        });
        service = new PluginService({ directory: path.join(root, 'installed'), store: app.store, command: async () => ({ ok: true }), broadcast: vi.fn() });
        cleanups.push(async () => { await service?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
        const source = path.join(root, 'sample.agents'); fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'kelpi.plugin.json'), JSON.stringify({
            id: 'sample.agents', name: 'Agents', version: '1.0.0', apiVersion: 1, trust: 'full', activation: 'startup', backend: 'backend.mjs',
            contributes: { commands: [{ id: 'sample.agents.seen', title: 'Seen' }] }
        }));
        fs.writeFileSync(path.join(source, 'backend.mjs'), `export function activate(api) {
            const seen = [];
            api.agents.onEvent(event => { seen.push(event); });
            api.commands.register('sample.agents.seen', () => seen);
        }`);
        await service.install(source, true);
        const seen = () => service!.request('run', { command: 'sample.agents.seen' });
        await vi.waitFor(async () => expect(await seen()).toEqual([]));

        app.send({ command: 'permission-request', pane_id: P1, tool_name: 'Bash', tool_input: { command: 'mv a b' } });
        await vi.waitFor(() => expect(app.replies.at(-1)?.payloads).toEqual([{ ok: true, behavior: 'abstain', provider: BUNDLED_PERMISSIONS_PROVIDER }]));
        await vi.waitFor(async () => expect(await seen()).toHaveLength(1));
        expect(await seen()).toEqual([{
            type: 'permission-request', paneID: P1, workspaceID: W1, agent: 'claude', status: 'idle',
            toolName: 'Bash', behavior: 'abstain', provider: BUNDLED_PERMISSIONS_PROVIDER
        }]);
    });
});
