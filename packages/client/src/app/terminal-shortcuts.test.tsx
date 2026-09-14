import { Blob as NodeBlob } from 'node:buffer';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { parseKeyTrigger } from '@kelpi/core/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientKeyBindings, createKeyDispatcher, installKeyDispatcher } from '../chrome/keys';
import { registerModal } from '../chrome/modal-presence';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { TerminalFeaturePane } from '../features/TerminalFeaturePane';
import { registerTerminalPane, type TerminalPaneHandle } from '../terminal/pane-registry';
import { createFakePtyApi, createFakeRendererFactory, installFakeResizeObserver } from '../terminal/testing';
import { dispatchTerminalEditingShortcut, terminalShortcutChords, terminalWindowChords, TerminalShortcutContext, type TerminalShortcutHost } from './terminal-shortcuts';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); vi.restoreAllMocks(); });
function fixture() {
    const paneID = crypto.randomUUID(), workspaceID = crypto.randomUUID();
    const state = createDaemonStore(emptyDaemonState('/tmp'));
    state.dispatch({ type: 'create-workspace', id: workspaceID, paneID, name: 'Owner', color: 'blue', now: 1 });
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${crypto.randomUUID()}.test/ws`, socketFactory: sockets.factory, notifications: null });
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
    const readSelection = vi.fn(async () => 'live owner selection'), write = vi.fn(), dispatchKey = vi.fn(() => true);
    const focusedOnScreen = vi.fn(() => true);
    const handle: TerminalPaneHandle = { readSelection, write, selection: () => '', root: () => null,
        dispatchKey, pasteText: () => true, showKeyboard() {}, hideKeyboard() {}, cellHeight: () => 16, focusedOnScreen };
    disposals.push(() => runtime.dispose(), registerTerminalPane(paneID, handle));
    const dropText = vi.spyOn(runtime.commands, 'dropText').mockResolvedValue({ ok: true });
    const pasteImage = vi.spyOn(runtime.commands, 'pasteImage').mockResolvedValue({ ok: true });
    return { runtime, paneID, workspaceID, handle, readSelection, write, dispatchKey, focusedOnScreen, dropText, pasteImage };
}
const event = (code: string, metaKey = true) => ({ code, metaKey, ctrlKey: !metaKey, altKey: false, shiftKey: false });
const host = (): TerminalShortcutHost => ({ bindings: clientKeyBindings([], true), onError: vi.fn() });
const clipboard = () => ({ readText: vi.fn(async () => 'clipboard text'), writeText: vi.fn(async () => {}), read: vi.fn(async () => []) });

describe('terminal editing shortcuts across daemon owners', () => {
    it('returns empty-selection Ctrl+C to the original non-Mac renderer after its live reply', async () => {
        const primary = fixture(), remote = fixture(), c = clipboard();
        const h = { ...host(), bindings: clientKeyBindings([], false) };
        let finish!: (text: string) => void;
        remote.readSelection.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        expect(terminalShortcutChords(h)).toContain('1/KeyC');
        expect(dispatchTerminalEditingShortcut(event('KeyC', false), {
            runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h, clipboard: c as unknown as Clipboard
        })).toBe(true);
        expect(remote.dispatchKey).not.toHaveBeenCalled();
        finish('');
        await vi.waitFor(() => expect(remote.dispatchKey).toHaveBeenCalledExactlyOnceWith({ key: 'c', code: 'KeyC', ctrlKey: true }));
        expect(primary.dispatchKey).not.toHaveBeenCalled();
        expect(remote.write).not.toHaveBeenCalled(); // The renderer retains its own key encoding.
        expect(c.writeText).not.toHaveBeenCalled();
    });

    it.each([
        { mac: true, selection: '' },
        { mac: false, selection: 'selected output' },
    ])('keeps copy semantics for mac=$mac and selection="$selection"', async ({ mac, selection }) => {
        const remote = fixture(), c = clipboard(), h = { ...host(), bindings: clientKeyBindings([], mac) };
        remote.readSelection.mockResolvedValue(selection);
        dispatchTerminalEditingShortcut(event('KeyC', mac), {
            runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h, clipboard: c as unknown as Clipboard
        });
        for (let index = 0; index < 8; index++) await Promise.resolve();
        expect(remote.dispatchKey).not.toHaveBeenCalled();
        expect(remote.write).not.toHaveBeenCalled();
        if (selection) expect(c.writeText).toHaveBeenCalledExactlyOnceWith(selection);
        else expect(c.writeText).not.toHaveBeenCalled();
    });

    it.each(['unfocused', 'removed', 'replaced', 'modal', 'blocked'] as const)(
        'cancels the deferred Ctrl+C when its original target becomes %s', async change => {
            const remote = fixture(), c = clipboard(), blocked = vi.fn(() => false);
            const h = { ...host(), bindings: clientKeyBindings([], false), blocked };
            let finish!: (text: string) => void;
            remote.readSelection.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
            dispatchTerminalEditingShortcut(event('KeyC', false), {
                runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h, clipboard: c as unknown as Clipboard
            });
            const replacementKey = vi.fn(() => true);
            if (change === 'unfocused') remote.focusedOnScreen.mockReturnValue(false);
            else if (change === 'removed') remote.runtime.store.getState().applySnapshot(2, {
                ...remote.runtime.store.getState().daemon.state, workspaces: []
            });
            else if (change === 'replaced') disposals.push(registerTerminalPane(remote.paneID, { ...remote.handle, dispatchKey: replacementKey }));
            else if (change === 'modal') disposals.push(registerModal());
            else blocked.mockReturnValue(true);
            finish('');
            for (let index = 0; index < 8; index++) await Promise.resolve();
            expect(remote.dispatchKey).not.toHaveBeenCalled(); expect(replacementKey).not.toHaveBeenCalled();
            expect(c.writeText).not.toHaveBeenCalled();
        }
    );

    it('adds the terminal editing map without importing other pane commands into a remote relay', () => {
        const h = host();
        expect(terminalShortcutChords(h)).toEqual(['8/ArrowLeft', '8/ArrowRight', '8/Backspace', '8/KeyC', '8/KeyV']);
        expect(terminalShortcutChords(h, ['8/KeyD', '8/KeyP'])).toEqual(expect.arrayContaining(['8/KeyC', '8/KeyV', '8/KeyD', '8/KeyP']));
        expect(terminalShortcutChords({ ...h, windowChords: ['8/Comma'] })).toContain('8/Comma');
        expect(terminalShortcutChords({ bindings: clientKeyBindings([], false) })).toContain('1/KeyC');
        const rebound = { bindings: clientKeyBindings(['super+c=unbind', 'super+y=copy'], true) };
        expect(terminalShortcutChords(rebound)).not.toContain('8/KeyC'); expect(terminalShortcutChords(rebound)).toContain('8/KeyY');
        expect(terminalShortcutChords({ ...h, globalHotkey: parseKeyTrigger('super+c') })).not.toContain('8/KeyC');
        const windowChords = terminalWindowChords(h.bindings);
        expect(windowChords).toEqual(expect.arrayContaining(['8/KeyP', '8/Comma', '8/Slash']));
        expect(windowChords).not.toContain('8/KeyD');
        expect(terminalShortcutChords({ ...h, windowChords, globalHotkey: parseKeyTrigger('super+p') })).not.toContain('8/KeyP');
    });

    it('copies and pastes the exact remote pane without consulting primary focus or commands', async () => {
        const primary = fixture(), remote = fixture(), c = clipboard(), h = host();
        const target = { runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h, clipboard: c as unknown as Clipboard };
        expect(dispatchTerminalEditingShortcut(event('KeyC'), target)).toBe(true);
        await vi.waitFor(() => expect(c.writeText).toHaveBeenCalledExactlyOnceWith('live owner selection'));
        expect(remote.readSelection).toHaveBeenCalledOnce(); expect(primary.readSelection).not.toHaveBeenCalled();
        expect(dispatchTerminalEditingShortcut(event('KeyV'), target)).toBe(true);
        await vi.waitFor(() => expect(remote.dropText).toHaveBeenCalledExactlyOnceWith({ paneID: remote.paneID, text: 'clipboard text' }));
        expect(primary.dropText).not.toHaveBeenCalled(); expect(primary.write).not.toHaveBeenCalled();
    });

    it('routes all three line-edit bytes to their owning pane and leaves window/pane commands to established handlers', () => {
        const primary = fixture(), remote = fixture(), h = host();
        const target = { runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h };
        for (const code of ['Backspace', 'ArrowLeft', 'ArrowRight']) expect(dispatchTerminalEditingShortcut(event(code), target)).toBe(true);
        expect(remote.write.mock.calls).toEqual([['\x15'], ['\x01'], ['\x05']]); expect(primary.write).not.toHaveBeenCalled();
        for (const code of ['KeyD', 'KeyP', 'Comma']) expect(dispatchTerminalEditingShortcut(event(code), target)).toBe(false);
        expect(remote.dropText).not.toHaveBeenCalled();
    });

    it('supports external-editor terminals but refuses a pane from another runtime or a returned document body', () => {
        const primary = fixture(), remote = fixture(), h = host();
        const target = { runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h };
        expect(dispatchTerminalEditingShortcut(event('Backspace'), { ...target, paneID: primary.paneID })).toBe(true);
        expect(primary.write).not.toHaveBeenCalled();
        const state = remote.runtime.store.getState().daemon.state;
        const changed = (editor: string | null) => ({ ...state, workspaces: state.workspaces.map(workspace => ({ ...workspace,
            panes: workspace.panes.map(pane => ({ ...pane, type: 'markdown', externalEditorCommand: editor })) })) });
        remote.runtime.store.getState().applySnapshot(2, changed('nvim'));
        dispatchTerminalEditingShortcut(event('Backspace'), target);
        expect(remote.write).toHaveBeenCalledExactlyOnceWith('\x15');
        remote.runtime.store.getState().applySnapshot(3, changed(null));
        dispatchTerminalEditingShortcut(event('Backspace'), target);
        expect(remote.write).toHaveBeenCalledOnce();
    });

    it('does not fall back to primary editing after a remote hides, closes or a host modal opens', () => {
        const primary = fixture(), remote = fixture(), h = host(), c = clipboard();
        const target = { runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h, clipboard: c as unknown as Clipboard };
        expect(dispatchTerminalEditingShortcut(event('Backspace'), { ...target, visible: false })).toBe(true);
        const release = registerModal();
        try { expect(dispatchTerminalEditingShortcut(event('KeyC'), target)).toBe(true); } finally { release(); }
        expect(dispatchTerminalEditingShortcut(event('KeyV'), { ...target, host: { ...h, blocked: () => true } })).toBe(true);
        remote.runtime.store.getState().applySnapshot(1, { ...remote.runtime.store.getState().daemon.state, workspaces: [] });
        expect(dispatchTerminalEditingShortcut(event('Backspace'), target)).toBe(true);
        expect(remote.write).not.toHaveBeenCalled(); expect(primary.write).not.toHaveBeenCalled(); expect(c.readText).not.toHaveBeenCalled(); expect(c.writeText).not.toHaveBeenCalled();
    });

    it('preserves the original paste target across focus changes and cancels a removed target', async () => {
        const remote = fixture(), c = clipboard(), h = host();
        let finish!: (text: string) => void;
        c.readText.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const target = { runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h, clipboard: c as unknown as Clipboard };
        dispatchTerminalEditingShortcut(event('KeyV'), target);
        remote.runtime.store.getState().setFocusEcho(remote.workspaceID, null); finish('captured target');
        await vi.waitFor(() => expect(remote.dropText).toHaveBeenCalledExactlyOnceWith({ paneID: remote.paneID, text: 'captured target' }));
        dispatchTerminalEditingShortcut(event('KeyV'), target);
        remote.runtime.store.getState().applySnapshot(2, { ...remote.runtime.store.getState().daemon.state, workspaces: [] });
        finish('closed target'); await Promise.resolve(); await Promise.resolve();
        expect(remote.dropText).toHaveBeenCalledOnce();
    });

    it('uploads PNG-only clipboard data to the remote daemon and reports owning command errors', async () => {
        const primary = fixture(), remote = fixture(), c = clipboard(), h = host();
        c.readText.mockResolvedValue('');
        const png = new NodeBlob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
        c.read.mockResolvedValue([{ types: ['image/png'], getType: async () => png }] as never);
        const target = { runtime: remote.runtime, paneID: remote.paneID, visible: true, host: h, clipboard: c as unknown as Clipboard };
        dispatchTerminalEditingShortcut(event('KeyV'), target);
        await vi.waitFor(() => expect(remote.pasteImage).toHaveBeenCalledExactlyOnceWith({ paneID: remote.paneID, data: 'iVBORw==' }));
        expect(primary.pasteImage).not.toHaveBeenCalled(); expect(remote.dropText).not.toHaveBeenCalled();
        c.readText.mockResolvedValue('text'); remote.dropText.mockResolvedValue({ ok: false, error: 'remote rejected paste' });
        dispatchTerminalEditingShortcut(event('KeyV'), target);
        await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith('Paste', 'remote rejected paste'));
    });
});

/**
 * #172 / #170 - the same five actions, reached through a MOUNTED pane with the BUNDLED engine.
 *
 * The cases above call `dispatchTerminalEditingShortcut` directly, which is the plugin
 * renderer's route: `TerminalFeaturePane` hands `onTerminalKey` to `PluginView` and the frame
 * relays its claimed chords back. The bundled ghostty-web branch got nothing, and that is the
 * branch an embedded remote workspace draws with (`app/RemoteWorkspaceView.tsx`).
 *
 * What made it a total failure rather than a near miss: while a remote workspace fills the pane
 * area `App.tsx` reports `hasActiveWorkspace: false`, so `chrome/keys.ts` returns at step 3,
 * before the binding lookup, and EVERY binding is dead - copy, paste, kill_line_backward,
 * move_to_line_start, move_to_line_end. Ctrl+U survived only because nothing binds it.
 *
 * Two panes, on two daemons, rendered the two ways the window renders them: `remote` carries
 * `editingShortcuts` exactly as `RemoteWorkspaceView` sets it, `local` does not, exactly as
 * `App.tsx` renders the primary workspace. So every assertion is three at once - the right pane
 * answered, the other daemon's pane did not, and the primary window's pane has no opinion of its
 * own because its dispatcher owns the chord. The window gate itself is deliberately untouched:
 * `act.lineEdit` and `copy` resolve their pane through `focused()`, which reads the PRIMARY
 * store, so lifting the gate would send the byte into the hidden local workspace instead.
 */
describe('the bundled terminal renderer in an embedded remote workspace (#172, #170)', () => {
    let observers: ReturnType<typeof installFakeResizeObserver>;
    beforeEach(() => { observers = installFakeResizeObserver(); });
    afterEach(() => {
        cleanup(); observers.restore();
        Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'clipboard');
    });

    /** One daemon: its own runtime, its own PTY transport, its own engine, one shell pane. */
    function daemon(name: string) {
        const paneID = crypto.randomUUID(), workspaceID = crypto.randomUUID();
        const state = createDaemonStore(emptyDaemonState('/tmp'));
        state.dispatch({ type: 'create-workspace', id: workspaceID, paneID, name, color: 'blue', now: 1 });
        const sockets = createFakeSocketFactory();
        const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${crypto.randomUUID()}.test/ws`, socketFactory: sockets.factory, notifications: null });
        runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
        disposals.push(() => runtime.dispose());
        return { runtime, paneID, workspaceID, pty: createFakePtyApi(), renderers: createFakeRendererFactory({ cell: { width: 10, height: 20 } }) };
    }
    type Daemon = ReturnType<typeof daemon>;
    /** jsdom measures everything at 0x0; the pane takes its box through this seam. */
    const box = (): { width: number; height: number } => ({ width: 800, height: 480 });
    const pane = (owner: Daemon, editingShortcuts: boolean) => <TerminalFeaturePane runtime={owner.runtime}
        workspaceID={owner.workspaceID} paneID={owner.paneID} ptyApi={owner.pty} focused visible
        editingShortcuts={editingShortcuts} createRenderer={owner.renderers.factory} measure={box} />;
    const hostOf = (owner: Daemon): HTMLElement =>
        document.querySelector(`[data-terminal-pane="${owner.paneID}"] [data-terminal-host]`) as HTMLElement;
    const bytes = (owner: Daemon): string[] => owner.pty.streams.flatMap(stream => stream.input);
    /** Every keydown that got past the pane's capture handler, which is what the engine sees. */
    const engineSees = (owner: Daemon): string[] => {
        const seen: string[] = [];
        hostOf(owner).addEventListener('keydown', event => seen.push(event.code), true);
        return seen;
    };
    /** The window's own host, member for member with `App.tsx`'s provider. */
    const windowHost = (macLike: boolean): TerminalShortcutHost => {
        const bindings = clientKeyBindings([], macLike);
        return { bindings, windowChords: terminalWindowChords(bindings), blocked: () => false, globalHotkey: null, onError: vi.fn() };
    };
    /** A real window dispatcher, as `App.tsx` installs one for the PRIMARY workspace. */
    const windowDispatcher = (macLike: boolean, actions: Record<string, () => boolean>): void => {
        disposals.push(installKeyDispatcher(window, createKeyDispatcher({
            bindings: clientKeyBindings([], macLike), actions: actions as never, hasActiveWorkspace: () => true
        })));
    };

    async function mount(macLike = true): Promise<{ local: Daemon; remote: Daemon }> {
        const local = daemon('Local'), remote = daemon('Remote');
        render(<TerminalShortcutContext.Provider value={windowHost(macLike)}>
            {pane(local, false)}{pane(remote, true)}
        </TerminalShortcutContext.Provider>);
        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        return { local, remote };
    }

    it('sends the line-editing byte up the PTY of the daemon whose pane took the chord', async () => {
        const { local, remote } = await mount();
        fireEvent.keyDown(hostOf(remote), { code: 'Backspace', metaKey: true });
        expect(bytes(remote)).toEqual(['\x15']);
        expect(bytes(local)).toEqual([]);
        fireEvent.keyDown(hostOf(remote), { code: 'ArrowLeft', metaKey: true });
        fireEvent.keyDown(hostOf(remote), { code: 'ArrowRight', metaKey: true });
        expect(bytes(remote)).toEqual(['\x15', '\x01', '\x05']);
        // ...and a primary-workspace pane answers nothing itself: its dispatcher owns the chord,
        // and there is none installed here.
        fireEvent.keyDown(hostOf(local), { code: 'Backspace', metaKey: true });
        expect(bytes(local)).toEqual([]);
        expect(bytes(remote)).toEqual(['\x15', '\x01', '\x05']);
    });

    it('copies the live selection of the pane that took the chord, not the other daemon (#170)', async () => {
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
        const { local, remote } = await mount();
        act(() => {
            local.renderers.last().emitSelection('local shell selection');
            remote.renderers.last().emitSelection('codex conversation text');
        });
        fireEvent.keyDown(hostOf(remote), { code: 'KeyC', metaKey: true });
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('codex conversation text'));
        expect(bytes(remote)).toEqual([]); expect(bytes(local)).toEqual([]);
    });

    it('pastes over the owning daemon commands, never the other one', async () => {
        Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn(async () => 'pasted text') }, configurable: true, writable: true });
        const { local, remote } = await mount();
        const dropText = vi.spyOn(remote.runtime.commands, 'dropText').mockResolvedValue({ ok: true });
        const otherDropText = vi.spyOn(local.runtime.commands, 'dropText').mockResolvedValue({ ok: true });
        fireEvent.keyDown(hostOf(remote), { code: 'KeyV', metaKey: true });
        await vi.waitFor(() => expect(dropText).toHaveBeenCalledExactlyOnceWith({ paneID: remote.paneID, text: 'pasted text' }));
        expect(otherDropText).not.toHaveBeenCalled();
        fireEvent.keyDown(hostOf(local), { code: 'KeyV', metaKey: true });
        for (let index = 0; index < 8; index++) await Promise.resolve();
        expect(otherDropText).not.toHaveBeenCalled();
    });

    /**
     * The interrupt, and the recursion it would otherwise cause.
     *
     * Off macOS the shipped `super+c=copy` is rewritten to `ctrl+c`, so Ctrl+C resolves `copy`
     * here. With no selection there is nothing to copy and the physical key belongs to the
     * terminal, so `dispatchTerminalEditingShortcut` hands it back through `handle.dispatchKey`
     * - which raises a real `keydown` on the engine's key target, INSIDE this pane. Without the
     * `raisingAtEngine` guard that key re-enters the capture handler, resolves `copy` again and
     * hands it back again, forever, and the interrupt reaches the engine at no level at all.
     */
    it('hands an empty-selection Ctrl+C back to the engine exactly once, off macOS', async () => {
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
        const { remote } = await mount(false);
        const seen = engineSees(remote);
        fireEvent.keyDown(hostOf(remote), { code: 'KeyC', key: 'c', ctrlKey: true });
        expect(remote.renderers.last().keys).toEqual([{ key: 'c', code: 'KeyC', ctrlKey: true }]);
        expect(seen).toEqual(['KeyC']); // the synthesised one only: the chord itself was consumed.
        expect(writeText).not.toHaveBeenCalled();
        expect(bytes(remote)).toEqual([]);
    });

    it('copies a live selection on that same client and raises nothing at the engine', async () => {
        const writeText = vi.fn(async () => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
        const { remote } = await mount(false);
        act(() => remote.renderers.last().emitSelection('codex conversation text'));
        const seen = engineSees(remote);
        fireEvent.keyDown(hostOf(remote), { code: 'KeyC', key: 'c', ctrlKey: true });
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('codex conversation text'));
        expect(remote.renderers.last().keys).toEqual([]);
        expect(seen).toEqual([]);
    });

    /**
     * The primary window keeps its dispatcher as the single owner of every binding, consumed or
     * DECLINED. A decline is a real state there (`copy` with an empty selection is one, by
     * design - `app/clipboard.ts`), and it has to keep falling through to the engine untouched,
     * which is why the seam is opt-in rather than attached to every bundled pane.
     */
    it('leaves a primary-workspace pane to the window dispatcher, consumed or declined', async () => {
        const { local, remote } = await mount();
        const consumes = vi.fn(() => true);
        windowDispatcher(true, { kill_line_backward: consumes });
        const consumed = new KeyboardEvent('keydown', { code: 'Backspace', metaKey: true, bubbles: true, cancelable: true });
        fireEvent(hostOf(local), consumed);
        expect(consumes).toHaveBeenCalledTimes(1);
        expect(consumed.defaultPrevented).toBe(true);
        expect(bytes(local)).toEqual([]); expect(bytes(remote)).toEqual([]);

        for (const dispose of disposals.splice(-1)) dispose(); // that dispatcher, and only it
        const declines = vi.fn(() => false);
        windowDispatcher(true, { kill_line_backward: declines });
        const seen = engineSees(local);
        const fell = new KeyboardEvent('keydown', { code: 'Backspace', metaKey: true, bubbles: true, cancelable: true });
        fireEvent(hostOf(local), fell);
        expect(declines).toHaveBeenCalledTimes(1);
        expect(fell.defaultPrevented).toBe(false);
        expect(seen).toEqual(['Backspace']); // straight on to the engine, as it always did
        expect(bytes(local)).toEqual([]);
    });

    it('leaves an unbound chord to the engine, which is why Ctrl+U kept working all along', async () => {
        const { remote } = await mount();
        const event = new KeyboardEvent('keydown', { code: 'KeyU', ctrlKey: true, bubbles: true, cancelable: true });
        fireEvent(hostOf(remote), event);
        expect(event.defaultPrevented).toBe(false);
        expect(bytes(remote)).toEqual([]);
    });
});
