/**
 * The presenter model: what leaves the window, and what a presenter is allowed to send back.
 *
 * Driven through a REAL surface with a fake palette feed, because every rule worth pinning is a
 * rule about the two together: the split projection, the withheld password input, the session
 * checks that only mean something against a live session, and the budget that has to be able to
 * take the surface back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { INTERACTION_LIMITS, type InteractionPaletteItem, type InteractionPaletteSource } from './contract';
import { createInteractionPresenterHost, type InteractionPresenterHost, type InteractionPresenterSnapshot } from './presenter';
import { createInteractionSurface, type InteractionSurface, type InteractionSurfaceConfig } from './surface';

const surfaces: InteractionSurface[] = [];
const hosts: InteractionPresenterHost[] = [];

const owner = (id: string) => ({ id, pluginID: 'example.test', pluginName: 'Test Plugin' });
const nativeOwner = (id = 'native:shortcut') => ({ id, kind: 'native' as const, displayName: 'Command Palette' });

const row = (id: string, extra: Partial<InteractionPaletteItem> = {}): InteractionPaletteItem => ({
    id, kind: 'command', icon: 'terminal', title: id, subtitle: '',
    workspaceID: null, workspaceName: '', paneID: null, workspaceColor: null, ...extra
});

function feed(items: readonly InteractionPaletteItem[]) {
    const state = { items };
    const execute = vi.fn().mockResolvedValue(undefined);
    const source: InteractionPaletteSource = { subscribe: () => () => {}, snapshot: () => ({ items: state.items }), execute };
    return { source, execute, state };
}

function make(config: InteractionSurfaceConfig = {}): InteractionSurface {
    const value = createInteractionSurface(config);
    surfaces.push(value);
    return value;
}

interface Harness {
    readonly host: InteractionPresenterHost;
    readonly frames: InteractionPresenterSnapshot[];
    readonly errors: Error[];
    readonly awaited: boolean[];
    readonly failures: string[];
    readonly acknowledged: () => number;
    readonly ready: () => number;
    readonly stop: () => void;
    visible: boolean;
}

function mount(surface: InteractionSurface, placement: 'interaction.palette' | 'interaction.prompts', options: { visible?: boolean; subscribe?: boolean } = {}): Harness {
    const frames: InteractionPresenterSnapshot[] = [];
    const errors: Error[] = [];
    const awaited: boolean[] = [];
    const failures: string[] = [];
    let acknowledged = 0;
    let ready = 0;
    const state = { visible: options.visible ?? true };
    const host = createInteractionPresenterHost({
        surface, placement,
        formFactor: () => 'desktop',
        visible: () => state.visible,
        fail: (detail) => failures.push(detail),
        onFrame: (awaits) => awaited.push(awaits),
        onAcknowledged: () => { acknowledged += 1; },
        onReady: () => { ready += 1; }
    });
    hosts.push(host);
    const stop = options.subscribe === false
        ? () => {}
        : host.subscribe((value) => frames.push(value), (error) => errors.push(error));
    return {
        host, frames, errors, awaited, failures, stop,
        acknowledged: () => acknowledged,
        ready: () => ready,
        get visible() { return state.visible; },
        set visible(value: boolean) { state.visible = value; }
    };
}

/** The model coalesces on a microtask, exactly as `plugins/chrome.ts` does. */
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const surface of surfaces.splice(0)) surface.dispose();
    vi.useRealTimers();
});

describe('the per-placement projection', () => {
    it('gives each placement its own half of the window and nothing of the other', async () => {
        const { source } = feed([row('cmd:a'), row('cmd:b')]);
        const surface = make({ palette: source });
        const scope = surface.createScope(owner('view'));
        const palette = mount(surface, 'interaction.palette');
        const prompts = mount(surface, 'interaction.prompts');

        surface.palette.open(nativeOwner());
        void scope.request('ui.showQuickPick', { title: 'Pick', items: [{ id: 'one', label: 'One' }] });
        void scope.request('ui.showInput', { title: 'Queued' });
        void scope.request('ui.showNotification', { message: 'Saved' });
        await flush();

        const forPalette = palette.frames.at(-1)!;
        expect(forPalette.palette).toMatchObject({ query: '', scope: 'all', selectedID: null, remoteWorkspaceSelected: false });
        expect(forPalette.palette!.items.map((item) => item.id)).toEqual(['cmd:a', 'cmd:b']);
        // The command universe is not a prompt, and a palette presenter is told nothing about one.
        expect(forPalette.prompt).toBeNull();
        expect(forPalette.notifications).toEqual([]);
        expect(forPalette.queued).toBe(0);
        expect(forPalette.paletteOpen).toBe(true);

        const forPrompts = prompts.frames.at(-1)!;
        expect(forPrompts.palette).toBeNull();
        // Both halves need the one boolean: the palette outranks a queued prompt.
        expect(forPrompts.paletteOpen).toBe(true);
        expect(forPrompts.prompt).toMatchObject({ kind: 'quickPick', options: { title: 'Pick' } });
        expect(forPrompts.queued).toBe(1);
        // The notification stack stays bundled in this release, so the field is always empty - and
        // the toast that is on screen right now is not in it.
        expect(forPrompts.notifications).toEqual([]);
        expect(JSON.stringify(forPrompts)).not.toContain('Saved');

        // Owners are a ref and a name. Nothing else, and specifically no plugin ID.
        expect(Object.keys(forPrompts.prompt!.owner).sort()).toEqual(['displayName', 'ref']);
        expect(forPrompts.prompt!.owner.displayName).toBe('Test Plugin');
        expect(JSON.stringify(forPrompts)).not.toContain('example.test');
        expect(JSON.stringify(forPrompts)).not.toContain('view');
    });

    it('freezes every frame deeply, and publishes nothing when the snapshot has not moved', async () => {
        const { source } = feed([row('cmd:a')]);
        const surface = make({ palette: source });
        const h = mount(surface, 'interaction.palette');
        expect(h.frames).toHaveLength(1);
        surface.palette.open(nativeOwner());
        await flush();
        expect(h.frames).toHaveLength(2);
        const frame = h.frames.at(-1)!;
        expect(Object.isFrozen(frame)).toBe(true);
        expect(Object.isFrozen(frame.palette)).toBe(true);
        expect(Object.isFrozen(frame.palette!.items)).toBe(true);
        expect(Object.isFrozen(frame.palette!.items[0])).toBe(true);

        // A republish that changes nothing (the same selection set again) sends no frame.
        surface.palette.setSelection(surface.palette.getSnapshot().sessionID!, 'cmd:a');
        await flush();
        expect(h.frames).toHaveLength(3);
        surface.palette.setSelection(surface.palette.getSnapshot().sessionID!, 'cmd:a');
        h.host.refresh();
        await flush();
        expect(h.frames).toHaveLength(3);
    });

    it('fails the placement outright when a live frame cannot be delivered at all', async () => {
        const big = 'x'.repeat(2048);
        const { source } = feed(Array.from({ length: 200 }, (_, index) => row(`cmd:${String(index)}`, { title: big, subtitle: big })));
        const surface = make({ palette: source });
        const scope = surface.createScope(owner('view'));
        const h = mount(surface, 'interaction.palette');
        // The palette first, then the prompt: a palette is refused over a VISIBLE prompt, and what
        // this is about is a frame that cannot be delivered while both are live.
        surface.palette.open(nativeOwner());
        const queued = scope.request('ui.showInput', { title: 'Queued behind the palette' });
        const before = surface.getSnapshot().activeModal!.id;
        await flush();

        expect(h.errors.map((error) => error.message)).toEqual(['Window interaction snapshot is invalid or exceeds 256 KiB.']);
        expect(() => h.host.getInteraction()).toThrow('exceeds 256 KiB');
        /*
         * NOT the acknowledgement watchdog: the SDK acks an `interaction-error` exactly as it acks a
         * frame, so a timer armed here would be cleared by the presenter's own ack and the live work
         * would be stranded with nobody drawing it. The placement fails immediately instead.
         */
        expect(h.failures).toEqual(['Window interaction snapshot is invalid or exceeds 256 KiB.']);
        expect(h.awaited).toEqual([false]);
        // And nothing was settled on the way: the request keeps its id for the bundled presenter.
        expect(surface.getSnapshot().activeModal!.id).toBe(before);
        let settled = false;
        void queued.then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);
    });

    it('withholds a password input from the presenter, counts it, and refuses to let it be answered', async () => {
        const surface = make();
        const scope = surface.createScope(owner('view'));
        const h = mount(surface, 'interaction.prompts');
        const secret = scope.request('ui.showInput', { title: 'Secret', password: true });
        await flush();

        const frame = h.frames.at(-1)!;
        expect(frame.prompt).toBeNull();
        // Told that something is pending, never what it is.
        expect(frame.queued).toBe(1);
        expect(JSON.stringify(frame)).not.toContain('Secret');
        const id = surface.getSnapshot().activeModal!.id;
        expect(() => h.host.call('ui.respondInteraction', { requestID: id, value: 'guessed' })).toThrow('This UI request is not visible.');

        // The bundled presenter still owns it, and the request is untouched.
        surface.answer(id, 'typed by the user');
        await expect(secret).resolves.toBe('typed by the user');
    });

    it('tells the watchdog which frames are waiting for an acknowledgement', async () => {
        const { source } = feed([row('cmd:a')]);
        const surface = make({ palette: source });
        const scope = surface.createScope(owner('view'));
        const h = mount(surface, 'interaction.prompts');
        expect(h.awaited).toEqual([false]);
        void scope.request('ui.showInput', { title: 'New prompt' });
        await flush();
        expect(h.awaited.at(-1)).toBe(true);
        const frames = h.frames.length;

        // A notification is not this presenter's business at all, so it is not even a frame.
        void scope.request('ui.showNotification', { message: 'Beside it' });
        await flush();
        expect(h.frames).toHaveLength(frames);

        // A frame that REMOVES the prompt is still a frame, and has nothing to acknowledge.
        surface.answer(surface.getSnapshot().activeModal!.id, null);
        await flush();
        expect(h.frames).toHaveLength(frames + 1);
        expect(h.frames.at(-1)!.prompt).toBeNull();
        expect(h.awaited.at(-1)).toBe(false);
        h.host.noteAcknowledged();
        expect(h.acknowledged()).toBe(1);
    });

    it('republishes when the host’s own paint decision moves', async () => {
        const surface = make();
        const h = mount(surface, 'interaction.prompts');
        expect(h.frames.at(-1)!.visible).toBe(true);
        h.visible = false;
        h.host.refresh();
        await flush();
        expect(h.frames.at(-1)!.visible).toBe(false);
    });
});

describe('presenter calls', () => {
    const open = (surface: InteractionSurface): string => {
        surface.palette.open(nativeOwner());
        return surface.palette.getSnapshot().sessionID!;
    };

    it('refuses a method that belongs to the other placement, in both directions', () => {
        const { source } = feed([row('cmd:a')]);
        const surface = make({ palette: source });
        const session = open(surface);
        const palette = mount(surface, 'interaction.palette');
        const prompts = mount(surface, 'interaction.prompts');
        expect(() => palette.host.call('ui.respondInteraction', { requestID: 'ui-1', value: null })).toThrow('another interaction placement');
        expect(() => prompts.host.call('ui.dismissPalette', { sessionID: session })).toThrow('another interaction placement');
        expect(() => prompts.host.call('ui.setPaletteQuery', { sessionID: session, text: 'x' })).toThrow('another interaction placement');
        expect(surface.getSnapshot().palette.open).toBe(true);
    });

    it('refuses malformed arguments and an unknown method before anything runs', () => {
        const { source } = feed([row('cmd:a')]);
        const surface = make({ palette: source });
        const session = open(surface);
        const h = mount(surface, 'interaction.palette');
        expect(() => h.host.call('ui.openPalette', { sessionID: session })).toThrow('Unknown window interaction method.');
        expect(() => h.host.call('ui.dismissPalette', {})).toThrow('Invalid interaction arguments.');
        expect(() => h.host.call('ui.dismissPalette', { sessionID: session, extra: 'no' })).toThrow('Invalid interaction arguments.');
        expect(() => h.host.call('ui.setPaletteQuery', { sessionID: session })).toThrow('Invalid interaction arguments.');
        expect(() => h.host.call('ui.setPaletteQuery', { sessionID: session, text: 'x'.repeat(INTERACTION_LIMITS.presenterQueryChars + 1) }))
            .toThrow(`A palette query must be a string of at most ${String(INTERACTION_LIMITS.presenterQueryChars)} characters.`);
        expect(() => h.host.call('ui.setPaletteQuery', { sessionID: session, text: { not: 'text' } })).toThrow('A palette query must be');
        expect(surface.getSnapshot().palette.query).toBe('');
    });

    it('checks the session id on every session-scoped call', () => {
        const { source, execute } = feed([row('cmd:a')]);
        const surface = make({ palette: source });
        const session = open(surface);
        const h = mount(surface, 'interaction.palette');
        surface.palette.dismiss(session, 'user');
        for (const call of [
            () => h.host.call('ui.setPaletteQuery', { sessionID: session, text: 'x' }),
            () => h.host.call('ui.setPaletteSelection', { sessionID: session, itemID: 'cmd:a' }),
            () => h.host.call('ui.dismissPalette', { sessionID: session })
        ]) expect(call).toThrow('This palette session is no longer open.');
        expect(() => h.host.call('ui.activatePaletteItem', { sessionID: session, itemID: 'cmd:a' })).toThrow('This palette session is no longer open.');
        expect(execute).not.toHaveBeenCalled();
    });

    it('drives the query, the selection, activation and dismissal through the surface', async () => {
        const { source, execute } = feed([row('cmd:a'), row('cmd:b')]);
        const surface = make({ palette: source });
        const session = open(surface);
        const h = mount(surface, 'interaction.palette');

        h.host.call('ui.setPaletteQuery', { sessionID: session, text: 'w: notes' });
        expect(surface.getSnapshot().palette).toMatchObject({ query: 'w: notes', scope: 'workspace' });
        h.host.call('ui.setPaletteSelection', { sessionID: session, itemID: 'cmd:b' });
        expect(surface.getSnapshot().palette.selectedID).toBe('cmd:b');
        h.host.call('ui.setPaletteSelection', { sessionID: session, itemID: null });
        expect(surface.getSnapshot().palette.selectedID).toBeNull();
        // The surface ignores an unknown id in silence; the bridge tells the presenter.
        expect(() => h.host.call('ui.setPaletteSelection', { sessionID: session, itemID: 'cmd:missing' })).toThrow('That palette item is not in the current list.');

        await h.host.call('ui.activatePaletteItem', { sessionID: session, itemID: 'cmd:a' });
        expect(execute).toHaveBeenCalledExactlyOnceWith('cmd:a', { workspaceID: null, paneID: null });
        expect(surface.getSnapshot().palette.open).toBe(false);

        const second = open(surface);
        h.host.call('ui.dismissPalette', { sessionID: second });
        expect(surface.getSnapshot().palette).toMatchObject({ open: false, sessionID: null });
    });

    it('refuses to activate a disabled row, or any row once the session has closed', async () => {
        const { source, execute } = feed([row('cmd:a'), row('cmd:off', { disabled: true })]);
        const reportFailure = vi.fn();
        const surface = make({ palette: source, reportFailure });
        const session = open(surface);
        const h = mount(surface, 'interaction.palette');
        // `surface.palette.activate` is the authority and re-resolves against a FRESH read; the
        // bridge's job is only to get there with a checked session id.
        await expect(h.host.call('ui.activatePaletteItem', { sessionID: session, itemID: 'cmd:off' })).rejects.toThrow('That palette item is disabled.');
        expect(execute).not.toHaveBeenCalled();
        // The session survives a refusal - the user is still looking at the list.
        expect(surface.getSnapshot().palette.open).toBe(true);

        await h.host.call('ui.activatePaletteItem', { sessionID: session, itemID: 'cmd:a' });
        expect(execute).toHaveBeenCalledExactlyOnceWith('cmd:a', { workspaceID: null, paneID: null });
        /*
         * Activation closed the session before dispatch, so a replay cannot run the row twice. The
         * session check is the BRIDGE's and refuses synchronously; the surface's own re-resolution
         * (the disabled row above) refuses through the returned promise.
         */
        expect(() => h.host.call('ui.activatePaletteItem', { sessionID: session, itemID: 'cmd:a' })).toThrow('This palette session is no longer open.');
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('answers a visible request and refuses a value the request never declared', async () => {
        const surface = make();
        const scope = surface.createScope(owner('view'));
        const h = mount(surface, 'interaction.prompts');
        const answer = scope.request('ui.showQuickPick', { title: 'Pick', items: [{ id: 'one', label: 'One' }, { id: 'off', label: 'Off', disabled: true }] });
        await flush();
        const id = h.frames.at(-1)!.prompt!.requestID;
        expect(() => h.host.call('ui.respondInteraction', { requestID: id, value: 'off' })).toThrow('Choose an enabled item.');
        expect(() => h.host.call('ui.respondInteraction', { requestID: id, value: 17 })).toThrow('A UI answer must be a string or null.');
        expect(() => h.host.call('ui.respondInteraction', { requestID: 'ui-404', value: null })).toThrow('This UI request is not visible.');
        h.host.call('ui.respondInteraction', { requestID: id, value: 'one' });
        await expect(answer).resolves.toBe('one');
    });

    it('reports readiness to the surface, idempotently', () => {
        const surface = make();
        const h = mount(surface, 'interaction.prompts');
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(true);
        h.host.call('ui.reportPresenterReady', {});
        h.host.call('ui.reportPresenterReady', {});
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(false);
        expect(surface.usesBundledPresenter('interaction.palette')).toBe(true);
        expect(h.ready()).toBe(2);
    });

    it('fails the presenter when it burns its call budget, and rejects everything after disposal', () => {
        const { source } = feed([row('cmd:a')]);
        const surface = make({ palette: source });
        const session = open(surface);
        const h = mount(surface, 'interaction.palette');
        for (let index = 0; index < INTERACTION_LIMITS.presenterCalls; index += 1)
            h.host.call('ui.setPaletteQuery', { sessionID: session, text: `q${String(index)}` });
        expect(h.failures).toEqual([]);
        expect(() => h.host.call('ui.setPaletteQuery', { sessionID: session, text: 'over' })).toThrow('call budget');
        // A runaway loop is a broken presenter, not a recoverable error.
        expect(h.failures).toEqual(['This presenter exceeded its window interaction call budget.']);

        h.host.dispose();
        expect(() => h.host.call('ui.dismissPalette', { sessionID: session })).toThrow('unavailable after disposal');
        expect(() => h.host.getInteraction()).toThrow('unavailable after disposal');
        expect(() => h.host.subscribe(() => {})).toThrow('unavailable after disposal');
        expect(surface.getSnapshot().palette.open).toBe(true);
    });
});
