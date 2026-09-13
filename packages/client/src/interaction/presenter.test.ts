/**
 * The presenter model: what leaves the window, and what a presenter is allowed to send back.
 *
 * Driven through a REAL surface with a fake palette feed, because every rule worth pinning is a
 * rule about the two together: the split projection, the withheld password input, the session
 * checks that only mean something against a live session, and the budget that has to be able to
 * take the surface back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { INTERACTION_LIMITS, type InteractionPaletteItem, type InteractionPaletteSource, type InteractionPlacement } from './contract';
import { createInteractionPresenterHost, notificationBoxHeight, type InteractionPresenterHost, type InteractionPresenterSnapshot } from './presenter';
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
    /** Every `setNotificationBoxHeight` the presenter declared, unclamped. */
    readonly declared: number[];
    readonly acknowledged: () => number;
    readonly ready: () => number;
    readonly stop: () => void;
    visible: boolean;
}

function mount(surface: InteractionSurface, placement: InteractionPlacement, options: { visible?: boolean; subscribe?: boolean } = {}): Harness {
    const frames: InteractionPresenterSnapshot[] = [];
    const errors: Error[] = [];
    const awaited: boolean[] = [];
    const failures: string[] = [];
    const declared: number[] = [];
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
        onReady: () => { ready += 1; },
        onBoxHeight: (pixels) => declared.push(pixels)
    });
    hosts.push(host);
    const stop = options.subscribe === false
        ? () => {}
        : host.subscribe((value) => frames.push(value), (error) => errors.push(error));
    return {
        host, frames, errors, awaited, failures, declared, stop,
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

/**
 * The third placement. Everything a notification presenter is told, everything it may settle, and
 * the one number it is allowed to ask the host for.
 */
describe('the notifications projection', () => {
    it('publishes the stack to its own placement and to neither of the others', async () => {
        const { source } = feed([row('cmd:a')]);
        const surface = make({ palette: source });
        const scope = surface.createScope(owner('view'));
        const notices = mount(surface, 'interaction.notifications');
        const prompts = mount(surface, 'interaction.prompts');
        const palette = mount(surface, 'interaction.palette');

        void scope.request('ui.showNotification', { message: 'Saved', tone: 'success', actions: [{ id: 'open', label: 'Open' }] });
        void scope.request('ui.showInput', { title: 'A modal beside it' });
        await flush();

        const frame = notices.frames.at(-1)!;
        expect(frame.placement).toBe('interaction.notifications');
        expect(frame.notifications).toHaveLength(1);
        expect(frame.notifications[0]).toMatchObject({ options: { message: 'Saved', tone: 'success' } });
        expect(frame.notifications[0]!.options.actions).toEqual([{ id: 'open', label: 'Open' }]);
        // A notice is not a modal request: the visible prompt and its queue belong elsewhere.
        expect(frame.prompt).toBeNull();
        expect(frame.queued).toBe(0);
        expect(frame.palette).toBeNull();
        expect(JSON.stringify(frame)).not.toContain('A modal beside it');
        // An owner is a ref and a display name here too - no plugin id reaches the corner either.
        expect(Object.keys(frame.notifications[0]!.owner).sort()).toEqual(['displayName', 'ref']);
        expect(frame.notifications[0]!.owner.displayName).toBe('Test Plugin');
        expect(JSON.stringify(frame)).not.toContain('example.test');
        expect(Object.isFrozen(frame.notifications)).toBe(true);
        expect(Object.isFrozen(frame.notifications[0])).toBe(true);

        // The other two placements are told nothing about it, as before.
        expect(prompts.frames.at(-1)!.notifications).toEqual([]);
        expect(palette.frames.at(-1)!.notifications).toEqual([]);
        expect(JSON.stringify(prompts.frames.at(-1)!)).not.toContain('Saved');
    });

    it('settles a notice it was published, and refuses every id it was not', async () => {
        const surface = make();
        const scope = surface.createScope(owner('view'));
        const notices = mount(surface, 'interaction.notifications');
        const prompts = mount(surface, 'interaction.prompts');
        const notice = scope.request('ui.showNotification', { message: 'Saved', actions: [{ id: 'open', label: 'Open' }] });
        const prompt = scope.request('ui.showInput', { title: 'Modal' });
        await flush();

        const noticeID = notices.frames.at(-1)!.notifications[0]!.requestID;
        const promptID = prompts.frames.at(-1)!.prompt!.requestID;
        // Each placement answers its own half and guesses nothing about the other's.
        expect(() => notices.host.call('ui.respondInteraction', { requestID: promptID, value: null })).toThrow('This UI request is not visible.');
        expect(() => prompts.host.call('ui.respondInteraction', { requestID: noticeID, value: 'open' })).toThrow('This UI request is not visible.');
        expect(() => notices.host.call('ui.respondInteraction', { requestID: noticeID, value: 'invented' })).toThrow('Unknown UI action.');
        expect(() => notices.host.call('ui.respondInteraction', { requestID: 'ui-404', value: null })).toThrow('This UI request is not visible.');

        notices.host.call('ui.respondInteraction', { requestID: noticeID, value: 'open' });
        await expect(notice).resolves.toBe('open');
        // A dismissal is the same settle with null, exactly as the bundled card's × does.
        const second = scope.request('ui.showNotification', { message: 'Dismissed' });
        await flush();
        notices.host.call('ui.respondInteraction', { requestID: notices.frames.at(-1)!.notifications[0]!.requestID, value: null });
        await expect(second).resolves.toBeNull();
        prompts.host.call('ui.respondInteraction', { requestID: promptID, value: 'typed' });
        await expect(prompt).resolves.toBe('typed');
    });

    it('keeps the host’s expiry clock: a notice leaves the frame when it times out', async () => {
        vi.useFakeTimers();
        const surface = make();
        const scope = surface.createScope(owner('view'));
        const h = mount(surface, 'interaction.notifications');
        const notice = scope.request('ui.showNotification', { message: 'Expires' });
        await flush();
        expect(h.frames.at(-1)!.notifications).toHaveLength(1);

        vi.advanceTimersByTime(INTERACTION_LIMITS.notificationMs);
        await flush();
        // Settled with null by the host, and simply dropped from the next frame. A presenter never
        // has to run a clock, and could not be trusted with one.
        await expect(notice).resolves.toBeNull();
        expect(h.frames.at(-1)!.notifications).toEqual([]);
        // A frame that only drops a notice waits for nothing: an idle presenter is not a failure.
        expect(h.awaited.at(-1)).toBe(false);
        expect(h.failures).toEqual([]);
    });

    it('waits for the acknowledgement of a frame that ADDS a notice', async () => {
        const surface = make();
        const scope = surface.createScope(owner('view'));
        const h = mount(surface, 'interaction.notifications');
        expect(h.awaited).toEqual([false]);
        void scope.request('ui.showNotification', { message: 'First' });
        await flush();
        expect(h.awaited.at(-1)).toBe(true);
        h.host.noteAcknowledged();
        expect(h.acknowledged()).toBe(1);

        // A second notice is a second frame to wait for; the first one is already drawn.
        void scope.request('ui.showNotification', { message: 'Second' });
        await flush();
        expect(h.awaited.at(-1)).toBe(true);
        expect(h.frames.at(-1)!.notifications.map((notice) => notice.options.message)).toEqual(['First', 'Second']);
        expect(h.failures).toEqual([]);
        /*
         * The frame is BOUNDED rather than allowed to burst (the case below), so the undeliverable
         * arm is hard to reach from this placement. The failure path it shares with the other two
         * is covered by the palette suite above, and `hasLiveWork` counts a visible notice so a
         * frame that somehow could not be delivered would hand the stack back to the bundled one
         * rather than leave it undrawn.
         */
    });

    /**
     * Four maximal notices do not fit in one 256 KiB frame, and the frame must not burst.
     *
     * The option limits are CHARACTER limits and JSON expands a control character to six bytes, so
     * one maximal notice is about 77 KiB serialized and four are about 303 KiB. Before the bound,
     * that frame was undeliverable, and an undeliverable frame with live work in it FAILS the
     * placement: the user's chosen presenter would be latched out by somebody else's notification,
     * with a toast to explain it and a Retry that re-failed until the notices expired.
     */
    it('carries the notices that fit, counts the ones it cannot, and never bursts the frame', async () => {
        const surface = make();
        const scope = surface.createScope(owner('view'));
        const h = mount(surface, 'interaction.notifications');
        const wide = (length: number): string => '\u0001'.repeat(length);
        const maximal = {
            message: wide(2048),
            detail: wide(8192),
            actions: Array.from({ length: INTERACTION_LIMITS.actions }, (_, index) => ({
                id: `${String(index)}${wide(127)}`,
                label: wide(200)
            }))
        };
        const answers = Array.from({ length: INTERACTION_LIMITS.notifications }, () =>
            scope.request('ui.showNotification', maximal)
        );
        await flush();

        // Nothing failed, nothing errored: what the presenter gets is a short frame, not a latch.
        expect(h.errors).toEqual([]);
        expect(h.failures).toEqual([]);
        const frame = h.frames.at(-1)!;
        expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThanOrEqual(INTERACTION_LIMITS.payloadBytes);
        expect(frame.notifications.length).toBeGreaterThan(0);
        expect(frame.notifications.length).toBeLessThan(INTERACTION_LIMITS.notifications);
        expect(frame.queued).toBe(INTERACTION_LIMITS.notifications - frame.notifications.length);
        // The read path agrees with the feed: `pluginJSON` would throw on an oversized frame.
        expect(() => h.host.getInteraction()).not.toThrow();

        // Visible order, so the withheld ones are the LAST of the four.
        const live = surface.getSnapshot().notifications.map((notice) => notice.id);
        expect(frame.notifications.map((notice) => notice.requestID)).toEqual(live.slice(0, frame.notifications.length));
        const withheldID = live.at(-1)!;
        // A notice this presenter was not shown cannot be answered by guessing its id.
        expect(() => h.host.call('ui.respondInteraction', { requestID: withheldID, value: null })).toThrow('This UI request is not visible.');

        // Settling a carried one makes room, and the withheld notice arrives under its own id.
        const carried = frame.notifications.length;
        surface.answer(frame.notifications[0]!.requestID, null);
        await expect(answers[0]).resolves.toBeNull();
        await flush();
        const next = h.frames.at(-1)!;
        expect(next.notifications).toHaveLength(carried);
        expect(next.notifications.some((notice) => notice.requestID === withheldID)).toBe(true);
        expect(next.queued).toBe(0);
        expect(h.failures).toEqual([]);
    });

    it('takes a declared box height, refuses a nonsense one, and clamps what is painted', () => {
        const surface = make();
        const h = mount(surface, 'interaction.notifications');
        const prompts = mount(surface, 'interaction.prompts');

        h.host.call('ui.setNotificationBoxHeight', { pixels: 240 });
        h.host.call('ui.setNotificationBoxHeight', { pixels: 0 });
        expect(h.declared).toEqual([240, 0]);
        for (const pixels of [-1, Number.NaN, Number.POSITIVE_INFINITY, '240', null])
            expect(() => h.host.call('ui.setNotificationBoxHeight', { pixels })).toThrow('A notification box height must be');
        expect(() => h.host.call('ui.setNotificationBoxHeight', {})).toThrow('Invalid interaction arguments.');
        expect(h.declared).toEqual([240, 0]);
        // The box belongs to one placement, like the palette calls do.
        expect(() => prompts.host.call('ui.setNotificationBoxHeight', { pixels: 240 })).toThrow('another interaction placement');

        // The clamp itself: the presenter's number, the host's two ceilings, and a default per
        // notice for the frames before a presenter has said anything at all.
        expect(notificationBoxHeight(null, 0, 1000)).toBe(0);
        expect(notificationBoxHeight(null, 2, 1000)).toBe(2 * INTERACTION_LIMITS.noticeBoxPx);
        expect(notificationBoxHeight(150, 1, 1000)).toBe(150);
        expect(notificationBoxHeight(150.6, 1, 1000)).toBe(151);
        expect(notificationBoxHeight(-10, 1, 1000)).toBe(0);
        /*
         * Two ceilings. One notice is worth at most `noticeBoxMaxPx` however big a number the
         * presenter sends, which is what stops a presenter holding a box bigger than what it draws
         * over the corner (its own notification every ten seconds would keep it there); and the
         * window's own fraction binds once enough notices are up to pass it.
         */
        expect(notificationBoxHeight(100_000, 1, 1000)).toBe(INTERACTION_LIMITS.noticeBoxMaxPx);
        expect(notificationBoxHeight(100_000, 2, 1000)).toBe(2 * INTERACTION_LIMITS.noticeBoxMaxPx);
        expect(notificationBoxHeight(100_000, 4, 1000)).toBe(450);
        // A window too short for even one default card clamps the default too.
        expect(notificationBoxHeight(null, 4, 200)).toBe(90);
    });
});
