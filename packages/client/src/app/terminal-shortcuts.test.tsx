import { Blob as NodeBlob } from 'node:buffer';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { parseKeyTrigger } from '@kelpi/core/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientKeyBindings } from '../chrome/keys';
import { registerModal } from '../chrome/modal-presence';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { registerTerminalPane, type TerminalPaneHandle } from '../terminal/pane-registry';
import { dispatchTerminalEditingShortcut, terminalShortcutChords, terminalWindowChords, type TerminalShortcutHost } from './terminal-shortcuts';

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
