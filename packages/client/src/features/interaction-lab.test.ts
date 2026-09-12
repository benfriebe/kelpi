/**
 * Interaction Lab, the SDK-only interaction presenters, driven exactly as the window drives them.
 *
 * The two shipped view modules are evaluated unchanged in jsdom against a fake `kelpi` whose `ui`
 * methods are the REAL presenter model over a REAL surface (`interaction/presenter.ts`,
 * `interaction/surface.ts`), as `plugins/chrome-lab.test.ts` runs Chrome Lab against the real UI
 * services: a session id, a request id or a disabled row that the host would refuse is refused here
 * too, so what the example proves is behaviour and not a mock's agreement.
 *
 * The subscription wrapper also copies the SDK's delivery rule - one frame at a time, acknowledged
 * only once the listener settles - because that is what makes the example's `stall()` hook a real
 * missed acknowledgement rather than a flag.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonObject } from '@kelpi/protocol';

import type { InteractionPaletteItem, InteractionPaletteSource } from '../interaction/contract';
import {
    createInteractionPresenterHost,
    type InteractionPresenterHost,
    type InteractionPresenterSnapshot
} from '../interaction/presenter';
import { createInteractionSurface, type InteractionSurface } from '../interaction/surface';

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples/plugins/interaction-lab/ui');
const views = {
    palette: fs.readFileSync(path.join(assets, 'palette.js'), 'utf8'),
    prompts: fs.readFileSync(path.join(assets, 'prompts.js'), 'utf8')
} as const;

/** What each view publishes for the scenario, and what this suite reads back. */
interface LabDiagnostics {
    readonly snapshot: InteractionPresenterSnapshot | null;
    readonly ready: boolean;
    readonly frames: number;
    readonly lastError: string | null;
    readonly matched: readonly string[];
    readonly selectedID: string | null;
    readonly requestID?: string | null;
    readonly kind?: string | null;
    readonly queued?: number;
    crash(mode?: string): void;
    stall(): void;
}

const surfaces: InteractionSurface[] = [];
const cleanups: Array<() => void> = [];

const flush = async (): Promise<void> => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
async function until(condition: () => boolean, label: string): Promise<void> {
    for (let index = 0; index < 240; index++) {
        // A condition that reads an element the view has not drawn yet is "not yet", not a failure.
        try { if (condition()) return; } catch { /* keep polling */ }
        await new Promise((resolve) => setTimeout(resolve, 4));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

const native = { id: 'native:shortcut', kind: 'native' as const, displayName: 'Command Palette' };
const owner = { id: 'ui-lab-view', pluginID: 'example.ui-lab', pluginName: 'UI Lab' };

function item(id: string, extra: Partial<InteractionPaletteItem> = {}): InteractionPaletteItem {
    return {
        id, kind: 'command', icon: 'terminal', title: id, subtitle: '',
        workspaceID: null, workspaceName: '', paneID: null, workspaceColor: null, ...extra
    };
}
/** Real host icon TOKENS (`chrome/palette.ts`), including one this lab has no glyph for. */
const universe: readonly InteractionPaletteItem[] = [
    item('workspace-alpha', { kind: 'workspace', icon: 'rectangle.stack', title: 'Alpha', subtitle: '2 panes', workspaceID: 'w1', workspaceName: 'Alpha', workspaceColor: 'blue' }),
    item('pane-notes', { kind: 'pane', icon: 'doc.text', title: 'Notes', subtitle: '~/alpha/notes', workspaceID: 'w1', workspaceName: 'Alpha', paneID: 'p1' }),
    item('command-tests', { kind: 'command', icon: 'terminal', title: 'Run tests', subtitle: 'Tasks', shortcut: 'Cmd+T' }),
    item('command-locked', { kind: 'command', icon: 'not.a.known.token', title: 'Locked task', subtitle: 'Tasks', disabled: true })
];

function make(options: { readonly items?: readonly InteractionPaletteItem[]; readonly remote?: boolean } = {}) {
    const execute = vi.fn<(itemID: string, target: JsonObject) => Promise<void>>().mockResolvedValue(undefined);
    const source: InteractionPaletteSource = {
        subscribe: () => () => {},
        snapshot: () => ({ items: options.items ?? universe }),
        execute
    };
    const surface = createInteractionSurface({ palette: source, remoteWorkspaceSelected: () => options.remote === true });
    surfaces.push(surface);
    return { surface, execute };
}

async function mount(view: 'palette' | 'prompts', surface: InteractionSurface, options: { readonly visible?: boolean } = {}) {
    const html = fs.readFileSync(path.join(assets, `${view}.html`), 'utf8');
    document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
    const state = { visible: options.visible ?? true };
    const failures: string[] = [], thrown: Error[] = [], errors: Error[] = [];
    const calls: Array<{ method: string; args: JsonObject }> = [];
    let acknowledged = 0, readied = 0;
    const host: InteractionPresenterHost = createInteractionPresenterHost({
        surface,
        placement: view === 'palette' ? 'interaction.palette' : 'interaction.prompts',
        formFactor: () => 'desktop',
        visible: () => state.visible,
        fail: (detail) => { failures.push(detail); },
        onAcknowledged: () => { acknowledged += 1; },
        onReady: () => { readied += 1; }
    });
    const call = async (method: string, args: JsonObject): Promise<void> => {
        calls.push({ method, args });
        await host.call(method, args);
    };
    // The SDK's own rule: frames drain one at a time, and each is acknowledged only after the
    // author's listener settles. A listener that never settles never acknowledges.
    let draining: Promise<void> = Promise.resolve();
    const onInteraction = (
        listener: (value: InteractionPresenterSnapshot) => void | Promise<void>,
        onError?: (error: Error) => void | Promise<void>
    ): (() => void) =>
        host.subscribe(
            (value) => {
                draining = draining.then(async () => {
                    try { await listener(value); } catch (error) { thrown.push(error as Error); }
                    host.noteAcknowledged();
                });
            },
            (error) => { errors.push(error); void onError?.(error); }
        );
    vi.stubGlobal('kelpi', {
        ready: Promise.resolve(),
        ui: {
            getInteraction: async () => host.getInteraction(),
            onInteraction,
            reportPresenterReady: () => call('ui.reportPresenterReady', {}),
            setPaletteQuery: (sessionID: string, text: string) => call('ui.setPaletteQuery', { sessionID, text }),
            setPaletteSelection: (sessionID: string, itemID: string | null) => call('ui.setPaletteSelection', { sessionID, itemID }),
            activatePaletteItem: (sessionID: string, itemID: string) => call('ui.activatePaletteItem', { sessionID, itemID }),
            dismissPalette: (sessionID: string) => call('ui.dismissPalette', { sessionID }),
            respondInteraction: (requestID: string, value: string | null) => call('ui.respondInteraction', { requestID, value })
        }
    });
    // Evaluate the shipped module unchanged, exactly as `plugins/chrome-lab.test.ts` does.
    const events = vi.spyOn(globalThis, 'addEventListener');
    const registered: typeof events.mock.calls = [];
    try { await new Function(`return (async () => { ${views[view]}\n})();`)(); }
    finally { registered.push(...events.mock.calls); events.mockRestore(); }
    cleanups.push(() => {
        window.dispatchEvent(new Event('pagehide'));
        host.dispose();
        for (const [name, listener, listenerOptions] of registered) globalThis.removeEventListener(name, listener, listenerOptions);
    });
    return {
        calls, errors, failures, thrown,
        acknowledged: () => acknowledged,
        readied: () => readied,
        lab: (): LabDiagnostics => (globalThis as unknown as { interactionLab: LabDiagnostics }).interactionLab,
        /** The host re-reads its own paint decision; the surface knows nothing about it. */
        show(visible: boolean) { state.visible = visible; host.refresh(); },
        sent: (method: string) => calls.filter((entry) => entry.method === method).map((entry) => entry.args)
    };
}
type Harness = Awaited<ReturnType<typeof mount>>;

const found = (testid: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)];
function one(testid: string): HTMLElement {
    const [first] = found(testid);
    expect(first, `Missing [data-testid="${testid}"]`).toBeDefined();
    return first!;
}
const labels = (testid: string): string[] => found(testid).map((node) => node.dataset.itemId ?? node.dataset.actionId ?? '');
const key = (name: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); };
function type(field: HTMLElement, value: string): void {
    (field as HTMLInputElement).value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
}
const ready = (h: Harness): Promise<void> => until(() => document.body.dataset.ready === 'true', 'the presenter to report readiness').then(() => {
    expect(h.lab().ready).toBe(true);
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const surface of surfaces.splice(0)) surface.dispose();
    await flush();
    vi.unstubAllGlobals();
    delete (globalThis as unknown as { interactionLab?: LabDiagnostics }).interactionLab;
    document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('Interaction Lab presents the palette session', () => {
    it('reports readiness after the first frame, mounted hidden as the host mounts it', async () => {
        const { surface } = make();
        // `visible: false` is how a palette presenter starts: the host mounts it hidden and arms
        // the 5 second readiness window on this first frame anyway.
        const h = await mount('palette', surface, { visible: false });
        expect(h.lab().frames).toBeGreaterThanOrEqual(1);
        await ready(h);
        expect(h.readied()).toBe(1);
        expect(h.sent('ui.reportPresenterReady')).toHaveLength(1);
        expect(h.failures).toEqual([]);
        expect(h.lab().lastError).toBeNull();
        // The first frame carried no session, so nothing was presented and nothing was answered.
        expect(found('lab-palette')).toHaveLength(0);
    });

    it('filters with the host rule, keeps a selection, and reports it back to the session', async () => {
        const { surface } = make();
        const h = await mount('palette', surface);
        await ready(h);
        const session = surface.palette.open(native);
        expect(session).not.toBeNull();
        await until(() => found('lab-palette-row').length === universe.length, 'the whole universe');
        expect(labels('lab-palette-row')).toEqual(['workspace-alpha', 'pane-notes', 'command-tests', 'command-locked']);
        // A fresh session selects the top row, and the host is told so.
        expect(h.lab().selectedID).toBe('workspace-alpha');
        expect(surface.palette.getSnapshot().selectedID).toBe('workspace-alpha');
        /*
         * `item.icon` is a token, never a glyph: printing it raw is what painted
         * "rectangle.stack" across a row's title. An unknown token draws nothing at all, and the
         * token itself stays on the cell for anyone reading the DOM.
         */
        const icons = found('lab-palette-row').map((row) => row.firstElementChild as HTMLElement);
        expect(icons.map((cell) => cell.textContent)).toEqual(['▥', '▤', '❯', '']);
        expect(icons.map((cell) => cell.dataset.icon)).toEqual(['rectangle.stack', 'doc.text', 'terminal', 'not.a.known.token']);
        expect(found('lab-palette-row').every((row) => !row.textContent?.includes('rectangle.stack'))).toBe(true);
        // The host owns the query: typing sends it, and the next frame is what filters.
        type(one('lab-palette-input'), 'TASK');
        await until(() => found('lab-palette-row').length === 2, 'a case-insensitive substring match');
        expect(labels('lab-palette-row')).toEqual(['command-tests', 'command-locked']);
        expect(h.sent('ui.setPaletteQuery')).toEqual([{ sessionID: session, text: 'TASK' }]);
        // `p:` is the host's scope prefix: the snapshot reports the scope, the view honours it.
        type(one('lab-palette-input'), 'p:a');
        await until(() => labels('lab-palette-row').join() === 'pane-notes', 'the pane scope');
        expect(h.lab().snapshot?.palette?.scope).toBe('pane');
        type(one('lab-palette-input'), '');
        await until(() => found('lab-palette-row').length === universe.length, 'the cleared query');
        // The selection survives the query change, because the host is holding it.
        expect(h.lab().selectedID).toBe('pane-notes');
        key('ArrowDown');
        key('ArrowDown');
        await flush();
        expect(h.lab().selectedID).toBe('command-locked');
        expect(one('lab-palette-row').getAttribute('aria-selected')).toBe('false');
        expect(surface.palette.getSnapshot().selectedID).toBe('command-locked');
        key('ArrowUp');
        await flush();
        expect(h.lab().selectedID).toBe('command-tests');
        expect(h.sent('ui.setPaletteSelection').map((args) => args['itemID'])).toEqual(['workspace-alpha', 'command-tests', 'pane-notes', 'command-tests', 'command-locked', 'command-tests']);
        expect(h.sent('ui.setPaletteSelection').every((args) => args['sessionID'] === session)).toBe(true);
        expect(h.failures).toEqual([]);
    });

    it('activates a clicked row through the session and never a disabled one', async () => {
        const { surface, execute } = make();
        const h = await mount('palette', surface);
        await ready(h);
        const session = surface.palette.open(native);
        await until(() => found('lab-palette-row').length === universe.length, 'the whole universe');
        const rows = found('lab-palette-row');
        const locked = rows.find((row) => row.dataset.itemId === 'command-locked')!;
        expect(locked.getAttribute('aria-disabled')).toBe('true');
        locked.click();
        await flush();
        expect(h.sent('ui.activatePaletteItem')).toEqual([]);
        // Confirming a selected disabled row is refused by the view for the same reason.
        key('ArrowDown'); key('ArrowDown'); key('ArrowDown');
        await flush();
        expect(h.lab().selectedID).toBe('command-locked');
        key('Enter');
        await flush();
        expect(h.sent('ui.activatePaletteItem')).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
        rows.find((row) => row.dataset.itemId === 'command-tests')!.click();
        await flush();
        expect(h.sent('ui.activatePaletteItem')).toEqual([{ sessionID: session, itemID: 'command-tests' }]);
        expect(execute).toHaveBeenCalledExactlyOnceWith('command-tests', { workspaceID: null, paneID: null });
        // Activation dismisses the session host-side, so the presenter draws nothing after it.
        await until(() => found('lab-palette').length === 0, 'the session to close');
        expect(h.failures).toEqual([]);
        expect(h.lab().lastError).toBeNull();
    });

    it('badges a selected remote workspace and dismisses on Escape', async () => {
        const { surface } = make({ remote: true });
        const h = await mount('palette', surface);
        await ready(h);
        const session = surface.palette.open(native);
        await until(() => found('lab-palette').length === 1, 'the panel');
        expect(document.getElementById('remote')!.hidden).toBe(false);
        expect(h.lab().snapshot?.palette?.remoteWorkspaceSelected).toBe(true);
        key('Escape');
        await until(() => found('lab-palette').length === 0, 'the dismissal');
        expect(h.sent('ui.dismissPalette')).toEqual([{ sessionID: session }]);
        expect(surface.palette.getSnapshot().open).toBe(false);
    });

    it('presents nothing while the placement is not visible', async () => {
        const { surface } = make();
        const h = await mount('palette', surface);
        await ready(h);
        surface.palette.open(native);
        await until(() => found('lab-palette').length === 1, 'the panel');
        h.show(false);
        await until(() => found('lab-palette').length === 0, 'the hidden placement');
        expect(document.getElementById('backdrop')!.hidden).toBe(true);
        expect(document.body.dataset.visible).toBe('false');
        expect(found('lab-palette-row')).toHaveLength(0);
        // The session is still open host-side: `visible: false` means present nothing, not dismiss.
        expect(surface.palette.getSnapshot().open).toBe(true);
    });
});

describe('Interaction Lab presents the shared prompts', () => {
    async function prompts(options: { readonly visible?: boolean } = {}) {
        const { surface } = make();
        const h = await mount('prompts', surface, options);
        await ready(h);
        const scope = surface.createScope(owner);
        cleanups.push(() => scope.dispose());
        return { h, surface, scope };
    }

    it('renders a quick pick with its filter, enabled rows, owner and queue, then answers with the id', async () => {
        const { h, scope } = await prompts();
        const answer = scope.request('ui.showQuickPick', {
            title: 'Choose a color', placeholder: 'Filter colors', selectedID: 'blue', items: [
                { id: 'blue', label: 'Blue', description: 'A calm accent' },
                { id: 'green', label: 'Green', description: 'A fresh accent' },
                { id: 'locked', label: 'Unavailable color', disabled: true }
            ]
        });
        void scope.request('ui.showInput', { title: 'Behind it' });
        await until(() => found('lab-prompt-item').length === 3, 'the quick pick rows');
        expect(one('lab-prompt').dataset.kind).toBe('quickPick');
        expect(one('lab-prompt-owner').textContent).toBe('UI Lab');
        expect(one('lab-prompt-owner').dataset.ownerRef).toBe(h.lab().snapshot?.prompt?.owner.ref);
        expect(one('lab-prompt-queued').dataset.count).toBe('1');
        expect(one('lab-prompt-input').dataset.role).toBe('filter');
        expect((one('lab-prompt-input') as HTMLInputElement).placeholder).toBe('Filter colors');
        expect(h.lab().selectedID).toBe('blue');
        // The filter is the presenter's own state; the host never sees a keystroke of it.
        type(one('lab-prompt-input'), 'fresh');
        await flush();
        expect(labels('lab-prompt-item')).toEqual(['green']);
        expect(h.sent('ui.respondInteraction')).toEqual([]);
        const requestID = h.lab().requestID;
        one('lab-prompt-item').click();
        await expect(answer).resolves.toBe('green');
        expect(h.sent('ui.respondInteraction')).toEqual([{ requestID, value: 'green' }]);
        // The queued input becomes the visible request under its own id.
        await until(() => one('lab-prompt').dataset.kind === 'input', 'the queued prompt');
        expect(one('lab-prompt-queued').dataset.count).toBe('0');
        expect(h.failures).toEqual([]);
    });

    /**
     * The bundled quick pick's navigation: arrows walk the ENABLED rows and wrap, so the selection
     * can never rest on a row that answers nothing - and a click on a disabled row neither moves it
     * nor answers with whatever was selected before.
     */
    it('steps over a disabled quick-pick row, wraps, and never answers one', async () => {
        const { h, scope } = await prompts();
        const answer = scope.request('ui.showQuickPick', { title: 'Choose', items: [
            { id: 'ok', label: 'Fine' }, { id: 'locked', label: 'Locked', disabled: true }, { id: 'last', label: 'Last' }
        ] });
        await until(() => found('lab-prompt-item').length === 3, 'the rows');
        const selected = (): string | undefined => found('lab-prompt-item').find((row) => row.getAttribute('aria-selected') === 'true')?.dataset.itemId;
        expect(h.lab().selectedID).toBe('ok');
        expect(selected()).toBe('ok');
        const locked = found('lab-prompt-item').find((row) => row.dataset.itemId === 'locked')!;
        expect(locked.getAttribute('aria-disabled')).toBe('true');
        locked.click();
        await flush();
        expect(h.sent('ui.respondInteraction')).toEqual([]);
        expect(h.lab().selectedID).toBe('ok');
        expect(selected()).toBe('ok');
        key('ArrowDown');
        await flush();
        // Straight past the disabled row, and the diagnostics move with the painted selection.
        expect(h.lab().selectedID).toBe('last');
        expect(selected()).toBe('last');
        key('ArrowDown');
        await flush();
        expect(h.lab().selectedID).toBe('ok');
        key('ArrowUp');
        await flush();
        expect(h.lab().selectedID).toBe('last');
        key('Enter');
        await expect(answer).resolves.toBe('last');
        // A second request, to prove Cancel still answers null for a quick pick.
        const next = scope.request('ui.showQuickPick', { title: 'Choose again', items: [{ id: 'only', label: 'Only' }] });
        await until(() => one('lab-prompt').dataset.kind === 'quickPick' && h.lab().matched.length === 1, 'the second quick pick');
        one('lab-prompt-cancel').click();
        await expect(next).resolves.toBeNull();
    });

    it('selects the clicked row and answers with it', async () => {
        const { h, scope } = await prompts();
        const answer = scope.request('ui.showQuickPick', { title: 'Choose', items: [
            { id: 'first', label: 'First' }, { id: 'second', label: 'Second' }
        ] });
        await until(() => found('lab-prompt-item').length === 2, 'the rows');
        found('lab-prompt-item').find((row) => row.dataset.itemId === 'second')!.click();
        expect(h.lab().selectedID).toBe('second');
        await expect(answer).resolves.toBe('second');
    });

    it('renders an input with its prompt, placeholder, value and maxLength, and answers what was typed', async () => {
        const { h, scope } = await prompts();
        const answer = scope.request('ui.showInput', {
            title: 'Enter a label', prompt: 'Choose a label for this example.', value: 'Kelpi', placeholder: 'Your label', maxLength: 80
        });
        await until(() => one('lab-prompt').dataset.kind === 'input', 'the input prompt');
        const field = one('lab-prompt-input') as HTMLInputElement;
        expect(field.dataset.role).toBe('value');
        expect(field.value).toBe('Kelpi');
        expect(field.placeholder).toBe('Your label');
        expect(field.maxLength).toBe(80);
        expect(document.getElementById('message')!.textContent).toBe('Choose a label for this example.');
        expect(found('lab-prompt-item')).toHaveLength(0);
        const requestID = h.lab().requestID;
        type(field, 'Interaction Lab');
        key('Enter');
        await expect(answer).resolves.toBe('Interaction Lab');
        expect(h.sent('ui.respondInteraction')).toEqual([{ requestID, value: 'Interaction Lab' }]);
    });

    it('renders dialog actions with the cancel action, and cancels with null', async () => {
        const { h, scope } = await prompts();
        const options = {
            title: 'Confirm action', message: 'Try a shared Kelpi dialog.', detail: 'Recorded without changing a workspace.',
            cancelID: 'cancel', actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'confirm', label: 'Confirm', kind: 'primary' }]
        };
        const first = scope.request('ui.showDialog', options);
        await until(() => found('lab-prompt-action').length === 2, 'the dialog actions');
        expect(labels('lab-prompt-action')).toEqual(['cancel', 'confirm']);
        expect(found('lab-prompt-action')[0]!.dataset.cancel).toBe('true');
        expect(found('lab-prompt-action')[1]!.dataset.kind).toBe('primary');
        expect(document.getElementById('detail')!.textContent).toBe('Recorded without changing a workspace.');
        expect((one('lab-prompt-input') as HTMLInputElement).hidden).toBe(true);
        found('lab-prompt-action')[1]!.click();
        await expect(first).resolves.toBe('confirm');
        const second = scope.request('ui.showDialog', options);
        await until(() => found('lab-prompt-action').length === 2, 'the second dialog');
        const requestID = h.lab().requestID;
        one('lab-prompt-cancel').click();
        await expect(second).resolves.toBeNull();
        expect(h.sent('ui.respondInteraction').at(-1)).toEqual({ requestID, value: null });
    });

    it('presents nothing while the placement is not visible, and never assumes a notification', async () => {
        const { h, scope } = await prompts();
        const answer = scope.request('ui.showInput', { title: 'Still pending' });
        await until(() => found('lab-prompt').length === 1, 'the prompt');
        h.show(false);
        await until(() => found('lab-prompt').length === 0, 'the hidden placement');
        expect(document.getElementById('backdrop')!.hidden).toBe(true);
        expect(document.body.dataset.visible).toBe('false');
        expect(h.lab().requestID).toBeNull();
        // Nothing was settled: the request keeps its id and comes back when the placement paints.
        h.show(true);
        await until(() => found('lab-prompt').length === 1, 'the restored prompt');
        expect(h.lab().snapshot?.notifications).toEqual([]);
        expect(h.lab().lastError).toBeNull();
        one('lab-prompt-cancel').click();
        await expect(answer).resolves.toBeNull();
    });

    it('refuses a request this placement was never shown', async () => {
        const { h, scope } = await prompts();
        void scope.request('ui.showInput', { title: 'Visible', password: true });
        await until(() => (h.lab().queued ?? 0) === 1, 'the withheld password input');
        // A password input stays bundled: no prompt is drawn, and `queued` still counts it.
        expect(found('lab-prompt')).toHaveLength(0);
        expect(h.lab().requestID).toBeNull();
    });
});

describe('Interaction Lab fails on purpose for the recovery paths', () => {
    it('throws inside the next frame when the crash hook is armed', async () => {
        const { surface } = make();
        const h = await mount('palette', surface);
        await ready(h);
        h.lab().crash();
        const frames = h.lab().frames;
        surface.palette.open(native);
        await until(() => h.thrown.length === 1, 'the armed crash');
        expect(h.thrown[0]!.message).toBe('Interaction Lab crashed on purpose.');
        expect(h.lab().frames).toBe(frames + 1);
        expect(h.lab().lastError).toBe('Interaction Lab crashed on purpose.');
        // The SDK catches a listener error, so the frame is still acknowledged - and nothing was
        // drawn for it. The next frame renders again: one armed crash is one crash.
        expect(found('lab-palette')).toHaveLength(0);
        surface.palette.setQuery(surface.palette.getSnapshot().sessionID!, 'alpha');
        await until(() => found('lab-palette').length === 1, 'the frame after the crash');
        expect(h.thrown).toHaveLength(1);
    });

    it('rethrows an armed uncaught crash where the SDK reports it as a view error', async () => {
        const { surface } = make();
        const h = await mount('prompts', surface);
        await ready(h);
        // The SDK reports an uncaught error, never a caught listener error, so the escalated hook
        // schedules the rethrow outside the callback. Delayed timers stay real: `until` uses them.
        const scheduled: Array<() => void> = [];
        const real = globalThis.setTimeout;
        const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) =>
            ms === undefined ? (scheduled.push(callback), 0) : real(callback, ms)) as unknown as typeof globalThis.setTimeout);
        try {
            h.lab().crash('uncaught');
            const scope = surface.createScope(owner);
            cleanups.push(() => scope.dispose());
            void scope.request('ui.showInput', { title: 'Crashes the presenter' });
            await until(() => h.thrown.length === 1, 'the armed crash');
        } finally { timers.mockRestore(); }
        expect(scheduled).toHaveLength(1);
        expect(() => scheduled[0]!()).toThrow('Interaction Lab crashed on purpose.');
        expect(found('lab-prompt')).toHaveLength(0);
    });

    it('stops acknowledging frames when the stall hook is armed', async () => {
        const { surface } = make();
        const h = await mount('prompts', surface);
        await ready(h);
        const acknowledged = h.acknowledged();
        h.lab().stall();
        const scope = surface.createScope(owner);
        cleanups.push(() => scope.dispose());
        void scope.request('ui.showInput', { title: 'Never acknowledged' });
        await until(() => (h.lab().frames ?? 0) > 1, 'the stalled frame');
        await flush();
        // The frame arrived and was never settled, so the host is still waiting for its
        // acknowledgement: this is the watchdog path, not a view error.
        expect(h.acknowledged()).toBe(acknowledged);
        expect(found('lab-prompt')).toHaveLength(0);
        expect(h.failures).toEqual([]);
        expect(h.thrown).toEqual([]);
    });
});
