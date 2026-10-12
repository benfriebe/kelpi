import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@kelpi/protocol';
import type { ConnectionStatus } from '../connection';
import { BACKEND_PROMPT_UNAVAILABLE, createBackendPromptBridge, type BackendPromptConnection } from './backend-prompts';
import { createInteractionSurface, type InteractionSurface } from './surface';

/** A runtime whose connection the test fires by hand. */
function fakeRuntime() {
    const messages = new Set<(message: JsonObject) => void>();
    const statuses = new Set<(status: ConnectionStatus) => void>();
    const connection = {
        on(event: 'message' | 'status', listener: (value: never) => void) {
            const set = (event === 'message' ? messages : statuses) as Set<typeof listener>;
            set.add(listener);
            return () => { set.delete(listener); };
        }
    } as BackendPromptConnection;
    return {
        connection,
        emit: (message: JsonObject) => { for (const listener of [...messages]) listener(message); },
        status: (status: ConnectionStatus) => { for (const listener of [...statuses]) listener(status); },
        listeners: () => messages.size + statuses.size
    };
}
type Runtime = ReturnType<typeof fakeRuntime>;

const WINDOW = 'window-1';
const DIALOG = { title: 'Run it?', message: 'echo hi', actions: [{ id: 'run', label: 'Run' }, { id: 'skip', label: 'Skip' }] };
const prompt = (requestID: string, extra: JsonObject = {}): JsonObject => ({
    type: 'plugin-prompt', requestID, windowID: WINDOW, pluginID: 'example.suggest', pluginName: 'Suggest',
    method: 'ui.showDialog', options: DIALOG, ...extra
});
const cancel = (requestID: string, windowID = WINDOW): JsonObject => ({ type: 'plugin-prompt-cancel', requestID, windowID });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const surfaces: InteractionSurface[] = [];
afterEach(() => {
    for (const surface of surfaces.splice(0)) surface.dispose();
    vi.restoreAllMocks();
});

function setup(options: { shellWindowID?: string | null; primary?: Runtime } = {}) {
    const surface = createInteractionSurface();
    surfaces.push(surface);
    const primary = options.primary ?? fakeRuntime();
    const send = vi.fn((_runtime: Runtime, _action: string, _input: JsonObject) => Promise.resolve(null));
    const bridge = createBackendPromptBridge<Runtime>({
        surface,
        shellWindowID: options.shellWindowID === undefined ? WINDOW : options.shellWindowID,
        isPrimary: (runtime) => runtime === primary,
        send
    });
    const detach = bridge.attach(primary);
    const sent = () => send.mock.calls.map(([, action, input]) => [action, input]);
    return { surface, primary, send, sent, bridge, detach };
}

describe('backend prompts (#389)', () => {
    it('presents a dialog as the plugin, acks it, and replies with the answer or null', async () => {
        const { surface, primary, sent } = setup();
        primary.emit(prompt('r1'));
        const modal = surface.getSnapshot().activeModal!;
        expect(modal).toMatchObject({ kind: 'dialog', owner: { id: 'backend:example.suggest', pluginID: 'example.suggest', displayName: 'Suggest' } });
        await flush();
        expect(sent()).toEqual([['prompt-ack', { requestID: 'r1' }]]);
        surface.answer(modal.id, 'run');
        await flush();
        expect(sent()).toEqual([['prompt-ack', { requestID: 'r1' }], ['prompt-reply', { requestID: 'r1', value: 'run' }]]);
        primary.emit(prompt('r2'));
        surface.answer(surface.getSnapshot().activeModal!.id, null);
        await flush();
        expect(sent().slice(2)).toEqual([['prompt-ack', { requestID: 'r2' }], ['prompt-reply', { requestID: 'r2', value: null }]]);
        expect(surface.getSnapshot().activeModal).toBeNull();
    });

    it('ignores a frame for another window, and every frame in a window with no shell window id', async () => {
        const { surface, primary, sent } = setup();
        primary.emit(prompt('r1', { windowID: 'window-2' }));
        primary.emit(prompt('r2', { windowID: undefined as never }));
        const bare = setup({ shellWindowID: null });
        bare.primary.emit(prompt('r3'));
        await flush();
        expect(surface.getSnapshot().activeModal).toBeNull();
        expect(bare.surface.getSnapshot().activeModal).toBeNull();
        expect([...sent(), ...bare.sent()]).toEqual([]);
    });

    it('refuses a prompt from a runtime that is not the primary workbench runtime', async () => {
        const { surface, bridge, sent } = setup();
        const remote = fakeRuntime();
        bridge.attach(remote);
        remote.emit(prompt('r1'));
        await flush();
        expect(surface.getSnapshot().activeModal).toBeNull();
        expect(sent()).toEqual([['prompt-reply', { requestID: 'r1', error: BACKEND_PROMPT_UNAVAILABLE }]]);
    });

    it('replies with the validation error and never acks invalid options', async () => {
        const { surface, primary, sent } = setup();
        primary.emit(prompt('r1', { options: { title: 'No actions', message: 'm', actions: [] } }));
        primary.emit(prompt('r2', { method: 'ui.showSomething' }));
        await flush();
        expect(surface.getSnapshot()).toMatchObject({ activeModal: null, queued: 0, notifications: [] });
        expect(sent().map(([action, input]) => [action, (input as JsonObject)['requestID']])).toEqual([['prompt-reply', 'r1'], ['prompt-reply', 'r2']]);
        for (const [, input] of sent()) expect((input as JsonObject)['error']).toEqual(expect.any(String));
        // The failed requests released their plugin's scope: the next prompt is presented normally.
        primary.emit(prompt('r3'));
        expect(surface.getSnapshot().activeModal).not.toBeNull();
    });

    it('removes a cancelled active or queued prompt and sends nothing for it', async () => {
        const { surface, primary, sent } = setup();
        primary.emit(prompt('r1'));
        primary.emit(prompt('r2', { options: { ...DIALOG, title: 'Second' } }));
        primary.emit(prompt('r3', { options: { ...DIALOG, title: 'Third' } }));
        await flush();
        expect(surface.getSnapshot().queued).toBe(2);
        primary.emit(cancel('r2'));
        await flush();
        expect(surface.getSnapshot()).toMatchObject({ activeModal: { options: { title: 'Run it?' } }, queued: 1 });
        // The re-raised r1 answers under its own request id.
        surface.answer(surface.getSnapshot().activeModal!.id, 'run');
        await flush();
        expect(surface.getSnapshot()).toMatchObject({ activeModal: { options: { title: 'Third' } }, queued: 0 });
        primary.emit(cancel('r3', 'window-2'));
        primary.emit(cancel('unknown'));
        expect(surface.getSnapshot().activeModal).not.toBeNull();
        primary.emit(cancel('r3'));
        await flush();
        expect(surface.getSnapshot()).toMatchObject({ activeModal: null, queued: 0 });
        // Three acks and r1's answer, and nothing else: no re-ack for a re-raised prompt, no null from
        // r1's withdrawn first request, no reply for a cancelled one.
        expect(sent()).toEqual([
            ...['r1', 'r2', 'r3'].map((requestID) => ['prompt-ack', { requestID }]),
            ['prompt-reply', { requestID: 'r1', value: 'run' }]
        ]);
    });

    it('acks a prompt re-raised before its first ack went out', async () => {
        const { surface, primary, sent } = setup();
        primary.emit(prompt('r1'));
        primary.emit(prompt('r2', { options: { ...DIALOG, title: 'Second' } }));
        primary.emit(cancel('r1'));
        await flush();
        expect(surface.getSnapshot()).toMatchObject({ activeModal: { options: { title: 'Second' } }, queued: 0 });
        expect(sent()).toEqual([['prompt-ack', { requestID: 'r2' }]]);
    });

    it('withdraws every prompt of a runtime whose connection drops, without sending', async () => {
        const { surface, primary, sent } = setup();
        primary.emit(prompt('r1'));
        primary.emit(prompt('r2', { method: 'ui.showNotification', options: { message: 'Done' } }));
        await flush();
        primary.status('reconnecting');
        await flush();
        expect(surface.getSnapshot()).toMatchObject({ activeModal: null, queued: 0, notifications: [] });
        expect(sent()).toEqual([['prompt-ack', { requestID: 'r1' }], ['prompt-ack', { requestID: 'r2' }]]);
        // The connection coming back starts clean.
        primary.status('connected');
        primary.emit(prompt('r3'));
        expect(surface.getSnapshot().activeModal).not.toBeNull();
    });

    it('reports the window’s 32-pending limit back as a reply error', async () => {
        const { surface, primary, sent } = setup();
        const native = surface.createScope({ id: 'native:test', kind: 'native', displayName: 'Kelpi' });
        for (let i = 0; i < 32; i += 1) void native.request('ui.showInput', { title: `fill ${String(i)}` });
        primary.emit(prompt('r1'));
        await flush();
        expect(sent()).toEqual([['prompt-reply', { requestID: 'r1', error: 'Too many pending window UI requests.' }]]);
    });

    it('routes all four methods, and a notification lands in the notification stack', async () => {
        const { surface, primary, sent } = setup();
        primary.emit(prompt('pick', { method: 'ui.showQuickPick', options: { title: 'Pick', items: [{ id: 'a', label: 'A' }] } }));
        primary.emit(prompt('input', { method: 'ui.showInput', options: { title: 'Name' } }));
        primary.emit(prompt('dialog'));
        primary.emit(prompt('notice', { method: 'ui.showNotification', options: { message: 'Hello', actions: [{ id: 'open', label: 'Open' }] } }));
        const notice = surface.getSnapshot().notifications[0]!;
        expect(notice).toMatchObject({ kind: 'notification', options: { message: 'Hello' }, owner: { displayName: 'Suggest' } });
        surface.answer(notice.id, 'open');
        for (const answer of ['a', 'typed', 'skip']) surface.answer(surface.getSnapshot().activeModal!.id, answer);
        await flush();
        const replies = sent().filter(([action]) => action === 'prompt-reply').map(([, input]) => input);
        expect(replies).toHaveLength(4);
        expect(replies).toEqual(expect.arrayContaining([
            { requestID: 'notice', value: 'open' },
            { requestID: 'pick', value: 'a' },
            { requestID: 'input', value: 'typed' },
            { requestID: 'dialog', value: 'skip' }
        ]));
        expect(sent().filter(([action]) => action === 'prompt-ack')).toHaveLength(4);
    });

    it('gives a plugin backend one owner ref across its prompts, and another plugin its own', async () => {
        const { surface, primary } = setup();
        primary.emit(prompt('r1'));
        primary.emit(prompt('r2'));
        const ref = surface.ownerRef(surface.getSnapshot().activeModal!.owner.id);
        surface.answer(surface.getSnapshot().activeModal!.id, null);
        expect(surface.ownerRef(surface.getSnapshot().activeModal!.owner.id)).toBe(ref);
        surface.answer(surface.getSnapshot().activeModal!.id, null);
        // r2's settle has released the scope, so r3 is raised on a re-created one.
        await flush();
        primary.emit(prompt('r3'));
        expect(surface.ownerRef(surface.getSnapshot().activeModal!.owner.id)).toBe(ref);
        surface.answer(surface.getSnapshot().activeModal!.id, null);
        primary.emit(prompt('r4', { pluginID: 'example.other', pluginName: 'Other' }));
        expect(surface.ownerRef(surface.getSnapshot().activeModal!.owner.id)).not.toBe(ref);
    });

    it('answers null for its prompts when detached, ignores frames after, and swallows a failed send', async () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        const { surface, primary, send, sent, bridge } = setup();
        send.mockImplementationOnce(() => Promise.reject(new Error('unknown prompt request')));
        primary.emit(prompt('r1'));
        await flush();
        expect(debug).toHaveBeenCalledOnce();
        bridge.dispose();
        await flush();
        expect(surface.getSnapshot().activeModal).toBeNull();
        expect(sent().at(-1)).toEqual(['prompt-reply', { requestID: 'r1', value: null }]);
        expect(primary.listeners()).toBe(0);
        primary.emit(prompt('r2'));
        expect(surface.getSnapshot().activeModal).toBeNull();
    });
});
