import { afterEach, describe, expect, it, vi } from 'vitest';
import { modalPresenceCount, registerModal } from '../chrome/modal-presence';
import { createUIServices } from '../plugins/ui-services';
import { INTERACTION_LIMITS, type InteractionPaletteItem, type InteractionPaletteSource } from './contract';
import { createInteractionSurface, type InteractionSurface, type InteractionSurfaceConfig } from './surface';

const surfaces: InteractionSurface[] = [];
const releases: Array<() => void> = [];
const make = (config: InteractionSurfaceConfig = {}): InteractionSurface => {
    const value = createInteractionSurface(config);
    surfaces.push(value);
    return value;
};
const owner = (id: string) => ({ id, pluginID: 'example.test', pluginName: 'Test Plugin' });
const nativeOwner = (id = 'native:shortcut') => ({ id, kind: 'native' as const, displayName: 'Kelpi' });

const row = (id: string, extra: Partial<InteractionPaletteItem> = {}): InteractionPaletteItem => ({
    id, kind: 'command', icon: 'terminal', title: id, subtitle: '',
    workspaceID: null, workspaceName: '', paneID: null, workspaceColor: null, ...extra
});
/**
 * `state.items` is the test's hand on the "fresh read" `activate` re-resolves against, and `notify`
 * is the feed's own wake-up - what `features/palette-source.ts` fires when the daemon mirror moves
 * or a plugin's contributions change.
 */
function feed(items: readonly InteractionPaletteItem[]) {
    const state = { items };
    const listeners = new Set<() => void>();
    const execute = vi.fn().mockResolvedValue(undefined);
    const source: InteractionPaletteSource = {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        snapshot: () => ({ items: state.items }),
        execute
    };
    return { source, execute, state, notify: () => { for (const listener of [...listeners]) listener(); } };
}
const cellState = () => {
    const cell = { open: false, query: '' };
    return { cell, state: {
        isOpen: () => cell.open,
        getQuery: () => cell.query,
        setOpen: (open: boolean) => { cell.open = open; if (!open) cell.query = ''; },
        setQuery: (query: string) => { cell.query = query; }
    } };
};

afterEach(() => {
    for (const release of releases.splice(0)) release();
    for (const value of surfaces.splice(0)) value.dispose();
    vi.useRealTimers();
    expect(modalPresenceCount()).toBe(0);
});

describe('window prompt scopes and queues', () => {
    it('queues modal requests in order and resolves a choice exactly once', async () => {
        const surface = make(), first = surface.createScope(owner('first')), second = surface.createScope(owner('second'));
        const a = first.request('ui.showInput', { title: 'First' });
        const b = second.request('ui.showDialog', { title: 'Second', message: 'Choose', actions: [{ id: 'yes', label: 'Yes' }] });
        const initial = surface.getSnapshot().activeModal!.id;
        expect(surface.getSnapshot().queued).toBe(1);
        expect(() => surface.answer(initial, 'answer')).not.toThrow();
        // A late answer to a settled request is ignored, not a second resolution.
        surface.answer(initial, 'late duplicate');
        await expect(a).resolves.toBe('answer');
        expect(surface.getSnapshot().activeModal?.owner.id).toBe('second');
        expect(() => surface.answer(surface.getSnapshot().activeModal!.id, 'missing')).toThrow('Unknown UI action');
        surface.answer(surface.getSnapshot().activeModal!.id, 'yes');
        await expect(b).resolves.toBe('yes');
        expect(surface.getSnapshot().activeModal).toBeNull();
    });

    it('cancels only the disposed view’s active, queued, and notification requests', async () => {
        const surface = make(), first = surface.createScope(owner('first')), second = surface.createScope(owner('second'));
        const active = first.request('ui.showInput', { title: 'Active' });
        const other = second.request('ui.showInput', { title: 'Other' });
        const queued = first.request('ui.showInput', { title: 'Queued' });
        const notification = first.request('ui.showNotification', { message: 'Notice' });
        first.dispose(); first.dispose();
        await expect(Promise.all([active, queued, notification])).resolves.toEqual([null, null, null]);
        expect(surface.getSnapshot().activeModal?.owner.id).toBe('second');
        expect(surface.getSnapshot().queued).toBe(0);
        expect(surface.getSnapshot().notifications).toEqual([]);
        await expect(first.request('ui.showInput', { title: 'Stale' })).rejects.toThrow('no longer owns');
        surface.dispose(); surface.dispose();
        await expect(other).resolves.toBeNull();
        expect(() => surface.createScope(owner('new'))).toThrow('disposed');
    });

    it('bounds each plugin scope and the entire window, then releases capacity on disposal', async () => {
        const surface = make();
        const scopes = Array.from({ length: 4 }, (_, i) => surface.createScope(owner(String(i))));
        const requests = scopes.flatMap(scope => Array.from({ length: INTERACTION_LIMITS.scopePending }, () => scope.request('ui.showInput', { title: 'Queued' })));
        await expect(scopes[0]!.request('ui.showInput', { title: 'Excess' })).rejects.toThrow('Too many pending');
        const extra = surface.createScope(owner('extra'));
        await expect(extra.request('ui.showInput', { title: 'Window excess' })).rejects.toThrow('Too many pending');
        scopes[0]!.dispose();
        const admitted = extra.request('ui.showInput', { title: 'Room now' });
        surface.dispose();
        await expect(Promise.all([...requests, admitted])).resolves.toHaveLength(33);
    });

    it('exempts a native owner from the per-scope limit but never from the window’s', async () => {
        const surface = make();
        const verb = surface.createScope(nativeOwner('native:menu'));
        const mine = Array.from({ length: INTERACTION_LIMITS.scopePending + 4 }, (_, i) => verb.request('ui.showInput', { title: `own ${i}` }));
        expect(surface.getSnapshot().queued).toBe(INTERACTION_LIMITS.scopePending + 3);
        const rest = Array.from({ length: INTERACTION_LIMITS.windowPending - mine.length }, (_, i) => verb.request('ui.showInput', { title: `fill ${i}` }));
        await expect(verb.request('ui.showInput', { title: 'Window excess' })).rejects.toThrow('Too many pending');
        surface.dispose();
        await expect(Promise.all([...mine, ...rest])).resolves.toHaveLength(INTERACTION_LIMITS.windowPending);
    });

    it('rejects malformed options without reserving queue capacity, and re-checks the answer', async () => {
        const surface = make(), scope = surface.createScope(owner('view'));
        await expect(scope.request('ui.showNotification', { message: 'Hi', tone: 'critical' })).rejects.toThrow();
        expect(surface.getSnapshot()).toMatchObject({ activeModal: null, queued: 0, notifications: [] });
        const choice = scope.request('ui.showQuickPick', { title: 'Pick', items: [{ id: 'no', label: 'Disabled', disabled: true }] });
        expect(() => surface.answer(surface.getSnapshot().activeModal!.id, 'no')).toThrow('enabled item');
        surface.answer(surface.getSnapshot().activeModal!.id, null);
        await expect(choice).resolves.toBeNull();
    });

    it('refuses to answer a request that is not visible, and ignores one whose owner is gone', async () => {
        const surface = make(), scope = surface.createScope(owner('view'));
        const active = scope.request('ui.showInput', { title: 'Active' });
        const queued = scope.request('ui.showInput', { title: 'Queued' });
        const hidden = surface.getSnapshot();
        const queuedID = `ui-${Number(hidden.activeModal!.id.slice(3)) + 1}`;
        expect(() => surface.answer(queuedID, 'sneaky')).toThrow('This UI request is not visible.');
        scope.dispose();
        await expect(Promise.all([active, queued])).resolves.toEqual([null, null]);
        // Post-disposal answers are a no-op, not a throw: the id is simply not pending any more.
        expect(() => surface.answer(hidden.activeModal!.id, 'late')).not.toThrow();
    });

    it('shows four notifications at once and starts a queued one’s timeout only when it becomes visible', async () => {
        vi.useFakeTimers();
        const surface = make(), scope = surface.createScope(owner('view'));
        const results = Array.from({ length: 5 }, (_, i) => scope.request('ui.showNotification', { message: `Notice ${i}` }));
        expect(surface.getSnapshot().notifications).toHaveLength(4);
        expect(vi.getTimerCount()).toBe(4);
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(Promise.all(results.slice(0, 4))).resolves.toEqual([null, null, null, null]);
        expect(surface.getSnapshot().notifications).toHaveLength(1);
        expect(surface.getSnapshot().notifications[0]?.options.message).toBe('Notice 4');
        expect(vi.getTimerCount()).toBe(1);
        scope.dispose();
        await expect(results[4]).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('the palette session', () => {
    it('activates a descriptor exactly once, then refuses the stale session', async () => {
        const { source, execute } = feed([row('cmd:new-pane'), row('ws:one', { kind: 'workspace', workspaceID: 'w1' })]);
        const surface = make({ palette: source });
        const session = surface.palette.open(nativeOwner())!;
        expect(session).not.toBeNull();
        expect(surface.getSnapshot().palette.items.map(item => item.id)).toEqual(['cmd:new-pane', 'ws:one']);
        await surface.palette.activate(session, 'ws:one');
        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledWith('ws:one', { workspaceID: 'w1', paneID: null });
        expect(surface.getSnapshot().palette).toMatchObject({ open: false, sessionID: null, items: [] });
        await expect(surface.palette.activate(session, 'cmd:new-pane')).rejects.toThrow('no longer open');
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('re-resolves against a fresh read: a vanished row and a disabled row both refuse, and report', async () => {
        const reportFailure = vi.fn();
        const { source, execute, state } = feed([row('ws:one', { kind: 'workspace', workspaceID: 'w1' }), row('cmd:off', { disabled: true })]);
        const surface = make({ palette: source, reportFailure });
        const session = surface.palette.open(nativeOwner())!;
        await expect(surface.palette.activate(session, 'cmd:off')).rejects.toThrow('disabled');
        state.items = [row('cmd:off', { disabled: true })];
        await expect(surface.palette.activate(session, 'ws:one')).rejects.toThrow('no longer available');
        expect(execute).not.toHaveBeenCalled();
        expect(reportFailure.mock.calls.map(call => call[0])).toEqual(['Command palette', 'Command palette']);
        // The session survives a refusal - the user is still looking at the list.
        expect(surface.getSnapshot().palette.open).toBe(true);
    });

    it('holds a prompt behind an open palette and shows it on dismissal', async () => {
        const surface = make(), scope = surface.createScope(owner('view'));
        const session = surface.palette.open(nativeOwner())!;
        const answer = scope.request('ui.showInput', { title: 'Behind the palette' });
        expect(surface.getSnapshot().activeModal?.options.title).toBe('Behind the palette');
        expect(surface.visibleSurface()).toBe('palette');
        surface.palette.dismiss(session, 'user');
        expect(surface.visibleSurface()).toBe('prompt');
        surface.answer(surface.getSnapshot().activeModal!.id, 'typed');
        await expect(answer).resolves.toBe('typed');
    });

    it('refuses to open over a visible prompt, and opens once the prompt is answered', async () => {
        const surface = make(), scope = surface.createScope(owner('view'));
        const answer = scope.request('ui.showInput', { title: 'Owns the window' });
        expect(surface.palette.open(nativeOwner())).toBeNull();
        expect(surface.getSnapshot().palette.open).toBe(false);
        surface.answer(surface.getSnapshot().activeModal!.id, null);
        await expect(answer).resolves.toBeNull();
        expect(surface.palette.open(nativeOwner())).not.toBeNull();
    });

    it('waits behind a native modal peer without letting it block the palette’s own recovery route', () => {
        const surface = make(), scope = surface.createScope(owner('view'));
        releases.push(registerModal());
        void scope.request('ui.showInput', { title: 'Queued behind Settings' });
        // The prompt is pending but NOT painted, so nothing is refused on its account.
        expect(surface.visibleSurface()).toBeNull();
        expect(surface.palette.open(nativeOwner('native:chrome-command'))).not.toBeNull();
        expect(surface.visibleSurface()).toBe('palette');
    });

    it('republishes the universe when the feed notifies while the session is open', () => {
        const { source, state, notify } = feed([row('cmd:a'), row('cmd:b')]);
        const surface = make({ palette: source });
        const widths: number[] = [];
        surface.palette.subscribe(() => widths.push(surface.palette.getSnapshot().items.length));
        const session = surface.palette.open(nativeOwner())!;
        expect(surface.palette.getSnapshot().items.map(item => item.id)).toEqual(['cmd:a', 'cmd:b']);

        // A plugin's `enablement` turned false and a new row arrived. Neither is store state, so
        // the feed's own notification is the ONLY thing that can repaint an open list.
        state.items = [row('cmd:a', { disabled: true }), row('cmd:b'), row('cmd:c')];
        notify();
        expect(surface.palette.getSnapshot().items.map(item => [item.id, item.disabled ?? false]))
            .toEqual([['cmd:a', true], ['cmd:b', false], ['cmd:c', false]]);
        expect(widths.at(-1)).toBe(3);

        // A closed palette has nothing to repaint, so the mirror's chatter must not wake listeners.
        surface.palette.dismiss(session, 'user');
        const quiet = widths.length;
        state.items = [row('cmd:a')];
        notify();
        expect(widths.length).toBe(quiet);
    });

    it('never paints an empty universe when something opened the palette outside the session', () => {
        const { cell, state: paletteState } = cellState();
        const { source } = feed([row('cmd:a')]);
        const surface = make({ palette: source, paletteState });
        // A direct write to `ui.palette` (a path the surface is meant to be the only writer of, and
        // the shape a stray one would take): the snapshot still has to describe a real session.
        cell.open = true;
        const snapshot = surface.palette.getSnapshot();
        expect(snapshot.open).toBe(true);
        expect(snapshot.sessionID).not.toBeNull();
        expect(snapshot.items.map(item => item.id)).toEqual(['cmd:a']);
        // And the drift read must not allocate per call, or `useSyncExternalStore` spins.
        expect(surface.palette.getSnapshot()).toBe(surface.palette.getSnapshot());
    });

    it('tracks the query, resets the selection with it, and ignores a stale session id', () => {
        const { source } = feed([row('cmd:a'), row('cmd:b')]);
        const surface = make({ palette: source });
        const session = surface.palette.open(nativeOwner())!;
        surface.palette.setSelection(session, 'cmd:b');
        expect(surface.getSnapshot().palette.selectedID).toBe('cmd:b');
        surface.palette.setQuery(session, 'w: pane');
        expect(surface.getSnapshot().palette).toMatchObject({ query: 'w: pane', scope: 'workspace', selectedID: null });
        surface.palette.setSelection(session, 'cmd:missing');
        expect(surface.getSnapshot().palette.selectedID).toBeNull();
        surface.palette.dismiss(session, 'user');
        surface.palette.setQuery(session, 'ignored');
        expect(surface.getSnapshot().palette.query).toBe('');
    });
});

describe('focus authority and the window’s read models', () => {
    const focusHost = () => ({ paneHandoff: vi.fn(), handBackCaret: vi.fn(), fallbackPaneID: () => 'pane-focused' });

    it('schedules the pane handoff on dismissal and cancels it when a prompt becomes visible', () => {
        vi.useFakeTimers();
        const focus = focusHost();
        const surface = make({ focus });
        const session = surface.palette.open(nativeOwner())!;
        surface.palette.dismiss(session, 'user');
        expect(surface.hasPendingPaneHandoff()).toBe(true);
        // Defect (2): the host has just painted a prompt that was queued behind the palette.
        surface.noteHostRegistration(true);
        expect(surface.hasPendingPaneHandoff()).toBe(false);
        vi.advanceTimersByTime(1000);
        expect(focus.paneHandoff).not.toHaveBeenCalled();
    });

    it('lands the handoff on the activated row’s pane when nothing interrupts it', async () => {
        vi.useFakeTimers();
        const focus = focusHost();
        const { source } = feed([row('pane:p1', { kind: 'pane', workspaceID: 'w1', paneID: 'p1' })]);
        const surface = make({ focus, palette: source });
        const session = surface.palette.open(nativeOwner())!;
        await surface.palette.activate(session, 'pane:p1');
        vi.advanceTimersByTime(200);
        expect(focus.paneHandoff).toHaveBeenCalledWith('p1');
    });

    it('collapses the window’s modal gates onto one predicate, and dismisses the topmost surface', async () => {
        vi.useFakeTimers();
        const focus = focusHost();
        const surface = make({ focus }), scope = surface.createScope(owner('view'));
        expect(surface.blocksWindowInput()).toBe(false);
        expect(surface.dismissTopmost()).toBe(false);

        surface.palette.open(nativeOwner());
        expect(surface.blocksWindowInput()).toBe(true);
        expect(surface.hasActiveModal()).toBe(false);
        expect(surface.dismissTopmost()).toBe(true);
        // The close chord hands the caret back at once, with no 200 ms window to be stranded in.
        expect(focus.handBackCaret).toHaveBeenCalledWith('pane-focused');
        expect(surface.hasPendingPaneHandoff()).toBe(false);

        const answer = scope.request('ui.showInput', { title: 'Prompt' });
        expect(surface.blocksWindowInput()).toBe(true);
        expect(surface.hasActiveModal()).toBe(true);
        expect(surface.dismissTopmost()).toBe(true);
        await expect(answer).resolves.toBeNull();
        expect(surface.blocksWindowInput()).toBe(false);
    });

    it('reports an active prompt even while it waits behind a native modal', () => {
        const surface = make(), scope = surface.createScope(owner('view'));
        releases.push(registerModal());
        void scope.request('ui.showInput', { title: 'Queued' });
        expect(surface.visibleSurface()).toBeNull();
        // ⌘, and ⌘/ stand down for a prompt that OWNS the window, painted or not.
        expect(surface.hasActiveModal()).toBe(true);
        expect(surface.blocksWindowInput()).toBe(true);
    });
});

describe('presenter failure', () => {
    it('settles nothing, keeps the request id stable, and dismisses the palette with its own reason', async () => {
        vi.useFakeTimers();
        const focus = { paneHandoff: vi.fn(), handBackCaret: vi.fn(), fallbackPaneID: () => 'pane-focused' };
        const { source, execute } = feed([row('cmd:a')]);
        const surface = make({ focus, palette: source }), scope = surface.createScope(owner('view'));
        surface.palette.open(nativeOwner());
        // Queued behind the palette, which outranks it.
        const answer = scope.request('ui.showInput', { title: 'Still mine' });
        const before = surface.getSnapshot().activeModal!.id;

        surface.presenterFailed('interaction.palette', 'the presenter went away');
        expect(surface.getSnapshot().palette.open).toBe(false);
        expect(execute).not.toHaveBeenCalled();
        // Re-presented, not re-raised: the same id, the same unsettled promise.
        expect(surface.getSnapshot().activeModal!.id).toBe(before);
        expect(surface.usesBundledPresenter('interaction.palette')).toBe(true);
        // The fallback pane handoff still runs.
        vi.advanceTimersByTime(200);
        expect(focus.paneHandoff).toHaveBeenCalledWith('pane-focused');

        let settled = false;
        void answer.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        surface.answer(before, 'typed');
        await expect(answer).resolves.toBe('typed');
    });

    it('never dismisses the palette for the OTHER placement’s failure', async () => {
        const reportFailure = vi.fn();
        const { source, execute } = feed([row('cmd:a')]);
        const surface = make({ palette: source, reportFailure }), scope = surface.createScope(owner('view'));
        const session = surface.palette.open(nativeOwner())!;
        const answer = scope.request('ui.showInput', { title: 'Still mine' });
        const before = surface.getSnapshot().activeModal!.id;

        surface.presenterFailed('interaction.prompts', 'the prompts view crashed');
        // The user is still reading the list: a prompts presenter is not the palette's business.
        expect(surface.getSnapshot().palette).toMatchObject({ open: true, sessionID: session });
        expect(surface.getSnapshot().activeModal!.id).toBe(before);
        expect(execute).not.toHaveBeenCalled();
        expect(reportFailure).toHaveBeenCalledWith('Interaction presenter', 'the prompts view crashed');
        surface.answer(before, 'typed');
        await expect(answer).resolves.toBe('typed');
    });

    it('reports the failure per placement, and readiness clears only the one that reported it', () => {
        const surface = make();
        expect(surface.presenterState()).toEqual({
            'interaction.palette': { failed: false, detail: null },
            'interaction.prompts': { failed: false, detail: null }
        });
        // Bundled until a presenter says it has painted: nothing else is drawing yet.
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(true);
        surface.presenterReady('interaction.prompts');
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(false);
        expect(surface.usesBundledPresenter('interaction.palette')).toBe(true);

        surface.presenterFailed('interaction.prompts', 'no acknowledgement');
        expect(surface.presenterState()).toEqual({
            'interaction.palette': { failed: false, detail: null },
            'interaction.prompts': { failed: true, detail: 'no acknowledgement' }
        });
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(true);
        // Cached against the state it describes, so a subscriber cannot spin on it.
        expect(surface.presenterState()).toBe(surface.presenterState());

        // Retry: the same placement reports ready again and owns its surface once more.
        surface.presenterReady('interaction.prompts');
        expect(surface.presenterState()['interaction.prompts']).toEqual({ failed: false, detail: null });
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(false);

        // Standing down is the OTHER way back to bundled, and it is not a failure: a phone, an empty
        // selection, a disabled plugin, a dropped connection. The read model has to say so anyway.
        surface.presenterStoodDown('interaction.prompts');
        expect(surface.usesBundledPresenter('interaction.prompts')).toBe(true);
        expect(surface.presenterState()['interaction.prompts']).toEqual({ failed: false, detail: null });
    });

    it('mints one opaque owner ref per owner, stable across requests and never the owner’s identity', async () => {
        const surface = make();
        const view = surface.createScope(owner('view-nonce-1'));
        const other = surface.createScope(nativeOwner('native:menu'));
        const first = view.request('ui.showInput', { title: 'One' });
        const second = view.request('ui.showInput', { title: 'Two' });
        const third = other.request('ui.showInput', { title: 'Three' });

        const ref = surface.ownerRef('view-nonce-1');
        expect(surface.ownerRef('view-nonce-1')).toBe(ref);
        expect(surface.ownerRef('native:menu')).not.toBe(ref);
        // Nothing about the owner is recoverable from it.
        expect(ref).not.toBe('view-nonce-1');
        expect(ref).not.toBe('example.test');
        expect(ref).not.toBe('Test Plugin');
        expect(ref).toMatch(/^owner-\d+$/);

        surface.dispose();
        await expect(Promise.all([first, second, third])).resolves.toEqual([null, null, null]);
    });
});

describe('the plugin-facing compatibility shim', () => {
    it('keeps publishing the older snapshot and the older owner shape', async () => {
        const services = createUIServices();
        try {
            const scope = services.createScope({ id: 'view', pluginID: 'example.test', pluginName: 'Test Plugin' });
            expect(services.getSnapshot()).toEqual({ active: null, queued: 0, notifications: [] });
            const answer = scope.request('ui.showInput', { title: 'Prompt' });
            expect(services.getSnapshot().active).toMatchObject({ kind: 'input', owner: { id: 'view', pluginID: 'example.test', pluginName: 'Test Plugin' } });
            // Cached against the surface's own snapshot, so `useSyncExternalStore` cannot loop.
            expect(services.getSnapshot()).toBe(services.getSnapshot());
            services.answer(services.getSnapshot().active!.id, 'typed');
            await expect(answer).resolves.toBe('typed');
            expect(services.getSnapshot()).toEqual({ active: null, queued: 0, notifications: [] });
        } finally { services.dispose(); }
    });
});
