import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { CommandReply } from '../connection';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import type { WebBatchSession } from '../webpane/state';
import { BrowserFeaturePane, type BrowserFeaturePaneProps } from './BrowserFeaturePane';

const WORKSPACE = 'W', PANE = 'AAAAAAAA-2222-4333-8444-555555555555';
const SECOND_PANE = 'CCCCCCCC-2222-4333-8444-555555555555';
const TAB = 'BBBBBBBB-2222-4333-8444-555555555555', SHELL = 'SHELL';
const disposals: Array<() => void> = [];
afterEach(() => { cleanup(); for (const dispose of disposals.splice(0)) dispose(); vi.restoreAllMocks(); localStorage.clear(); });

const selector = (text: string) => `[data-item="${text}"]`;
function batch(text?: string): WebBatchSession {
    return { visible: true, focused_id: null, last_target: null, submit: false, items: text === undefined ? [] : [
        { id: 'item', selector: selector(text), tag: 'button', text, url: 'https://example.test', comment: '' }
    ] };
}
const batchReply = (value: WebBatchSession | null): CommandReply => ({ ok: true, batch: JSON.parse(JSON.stringify(value)) });
function pending<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}
function fixture(name = 'remote', initial: WebBatchSession | null = null) {
    const state = createDaemonStore(emptyDaemonState('/tmp'));
    state.dispatch({ type: 'create-workspace', id: WORKSPACE, paneID: SHELL, name: 'Work', color: 'blue', now: 1 });
    state.dispatch({ type: 'create-workspace', id: 'OTHER', paneID: 'OTHER-SHELL', name: 'Other', color: 'blue', now: 2 });
    state.dispatch({ type: 'open-web-pane', workspaceID: WORKSPACE, paneID: PANE, tabID: TAB, url: 'https://example.test', now: 3 });
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${name}.test/ws`, socketFactory: sockets.factory, notifications: null });
    const handshake = (): void => completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
    runtime.connect(); handshake(); disposals.push(() => runtime.dispose());
    const batches = new Map<string, WebBatchSession | null>([[PANE, initial]]);
    const readBatch = vi.fn((paneID: string): Promise<CommandReply> => Promise.resolve(batchReply(batches.get(paneID) ?? null)));
    const broadcast = (paneID: string, value: WebBatchSession | null): void => {
        batches.set(paneID, value);
        sockets.last().emit({ type: 'web-batch', paneID, batch: value });
        sockets.last().emit({ type: 'web-browser-changed', paneID });
    };
    const raw = vi.spyOn(runtime.commands, 'raw').mockImplementation(async (payload): Promise<CommandReply> => {
        if (payload['action'] === 'list') return { ok: true, result: [] };
        if (payload['action'] === 'identity') return { ok: true, result: { daemonID: name } };
        if (payload['action'] === 'browser-state') {
            const paneID = (JSON.parse(String(payload['text'])) as { paneID: string }).paneID;
            const session = batches.get(paneID);
            return { ok: true, result: {
                paneID, workspaceID: WORKSPACE, isPrivate: false, activeTabID: TAB,
                tabs: [{ id: TAB, url: 'https://example.test', live: true, loading: false, canGoBack: false, canGoForward: false }],
                host: { available: true, id: 'host', name: 'Host', windowID: 'other-window' }, favourites: [],
                inspection: { revision: 0, armed: !!session, tabID: session ? TAB : null, pendingResults: 0,
                    batchVisible: session?.visible ?? false, batchItems: session?.items.length ?? 0, batchFocusedID: null }
            } };
        }
        const paneID = String(payload['pane_id']);
        if (payload['command'] === 'web-batch-state') return readBatch(paneID);
        if (payload['command'] === 'web-batch-toggle') {
            const current = batches.get(paneID);
            const next = current ? { ...current, visible: !current.visible } : batch();
            broadcast(paneID, next); return batchReply(next);
        }
        if (payload['command'] === 'web-batch-cancel' || payload['command'] === 'web-batch-send') {
            broadcast(paneID, null); return batchReply(null);
        }
        return { ok: true };
    });
    const addPane = (): void => {
        state.dispatch({ type: 'open-web-pane', workspaceID: WORKSPACE, paneID: SECOND_PANE, tabID: 'SECOND-TAB', url: 'https://second.test', now: 4 });
        runtime.store.getState().applySnapshot(1, JSON.parse(JSON.stringify(state.getState())));
    };
    return { runtime, state, sockets, batches, readBatch, raw, broadcast, handshake, addPane };
}
const draw = (h: ReturnType<typeof fixture>, props: Partial<BrowserFeaturePaneProps> = {}) =>
    <BrowserFeaturePane runtime={h.runtime} workspaceID={WORKSPACE} paneID={PANE} focused visible embedded={false} {...props} />;
const panel = (paneID = PANE) => screen.queryByTestId(`web-batch-panel-${paneID}`);

describe('pickup in remote browser controls', () => {
    it('starts, displays, sends and cancels pickup through the owning daemon', async () => {
        const h = fixture(); render(draw(h));
        await waitFor(() => expect(h.readBatch).toHaveBeenCalledWith(PANE));
        await act(async () => fireEvent.click(screen.getByTestId(`web-batch-toggle-${PANE}`)));
        expect(h.raw).toHaveBeenCalledWith({ command: 'web-batch-toggle', pane_id: PANE });
        expect(screen.getByTestId(`web-batch-toggle-${PANE}`).getAttribute('aria-label')).toBe('Hide element pickup');
        expect(panel()).not.toBeNull();
        await act(async () => h.broadcast(PANE, batch('Picked button')));
        expect(screen.getByTitle(selector('Picked button'))).toBeDefined();
        const destinations = screen.getByRole('combobox', { name: 'Send to pane' }) as HTMLSelectElement;
        expect([...destinations.options].map(option => option.value)).toContain(SHELL);
        expect([...destinations.options].map(option => option.value)).not.toContain('OTHER-SHELL');
        fireEvent.change(destinations, { target: { value: SHELL } });
        await act(async () => fireEvent.click(screen.getByTestId(`web-batch-send-${PANE}`)));
        expect(h.raw).toHaveBeenCalledWith({ command: 'web-batch-send', pane_id: PANE, send_to: SHELL });
        expect(panel()).toBeNull();
        await act(async () => fireEvent.click(screen.getByTestId(`web-batch-toggle-${PANE}`)));
        await act(async () => fireEvent.click(screen.getByTestId(`web-batch-cancel-${PANE}`)));
        expect(h.raw).toHaveBeenCalledWith({ command: 'web-batch-cancel', pane_id: PANE });
        expect(panel()).toBeNull();
    });

    it('seeds existing sessions and refreshes after reconnect, including an ended session', async () => {
        const h = fixture('remote', batch('Before disconnect')); render(draw(h));
        await screen.findByTitle(selector('Before disconnect'));
        act(() => h.runtime.connection.resync());
        expect(panel()).toBeNull();
        h.batches.set(PANE, batch('After reconnect'));
        await act(async () => h.handshake());
        expect(screen.getByTitle(selector('After reconnect'))).toBeDefined();
        expect(h.readBatch).toHaveBeenCalledTimes(2);
        act(() => h.runtime.connection.resync());
        h.batches.set(PANE, null);
        await act(async () => h.handshake());
        expect(h.readBatch).toHaveBeenCalledTimes(3);
        expect(panel()).toBeNull();
    });

    it.each([false, true])('does not overwrite a broadcast with an older seed reply (cancelled: %s)', async cancelled => {
        const h = fixture(), delayed = pending<CommandReply>();
        h.readBatch.mockReturnValueOnce(delayed.promise); render(draw(h));
        await act(async () => h.broadcast(PANE, cancelled ? null : batch('Current pickup')));
        await act(async () => delayed.resolve(batchReply(batch('Stale pickup'))));
        expect(screen.queryByTitle(selector('Stale pickup'))).toBeNull();
        if (cancelled) expect(panel()).toBeNull();
        else expect(screen.getByTitle(selector('Current pickup'))).toBeDefined();
    });

    it('ignores a seed reply from the previous connection after reconnect', async () => {
        const h = fixture(), delayed = pending<CommandReply>();
        h.readBatch.mockReturnValueOnce(delayed.promise); render(draw(h));
        act(() => h.runtime.connection.resync());
        h.batches.set(PANE, batch('Reconnected pickup'));
        await act(async () => h.handshake());
        await act(async () => delayed.resolve(batchReply(batch('Disconnected pickup'))));
        expect(screen.queryByTitle(selector('Disconnected pickup'))).toBeNull();
        expect(screen.getByTitle(selector('Reconnected pickup'))).toBeDefined();
    });

    it.each(['runtime', 'pane'] as const)('clears the outgoing %s session and ignores its later broadcasts', async change => {
        const first = fixture('first', batch('Old owner'));
        const view = render(draw(first)); await screen.findByTitle(selector('Old owner'));
        const next = change === 'runtime' ? fixture('second') : first;
        const paneID = change === 'pane' ? SECOND_PANE : PANE;
        if (change === 'pane') act(() => first.addPane());
        const delayed = pending<CommandReply>(); next.readBatch.mockReturnValueOnce(delayed.promise);
        view.rerender(draw(next, { paneID }));
        expect(panel(paneID)).toBeNull();
        await act(async () => first.broadcast(PANE, batch('Ignored old owner')));
        expect(screen.queryByTitle(selector('Ignored old owner'))).toBeNull();
        await act(async () => delayed.resolve(batchReply(batch('New owner'))));
        expect(screen.getByTitle(selector('New owner'))).toBeDefined();
    });

    it('ignores a late read after switching runtimes', async () => {
        const first = fixture('first'), second = fixture('second', batch('Current owner'));
        const delayed = pending<CommandReply>(); first.readBatch.mockReturnValueOnce(delayed.promise);
        const view = render(draw(first));
        view.rerender(draw(second)); await screen.findByTitle(selector('Current owner'));
        await act(async () => delayed.resolve(batchReply(batch('Old reply'))));
        expect(screen.queryByTitle(selector('Old reply'))).toBeNull();
        expect(screen.getByTitle(selector('Current owner'))).toBeDefined();
    });

    it('retains App-supplied sessions and destinations without a second subscription', async () => {
        const h = fixture();
        const props = { batch: batch('From App'), batchDestinations: [{ paneID: 'custom', label: 'App destination' }] };
        const view = render(draw(h, props));
        expect(screen.getByTitle(selector('From App'))).toBeDefined();
        expect(screen.getByRole('option', { name: 'App destination' })).toBeDefined();
        expect(screen.queryByRole('option', { name: 'shell' })).toBeNull();
        await act(async () => h.broadcast(PANE, batch('From daemon')));
        expect(screen.queryByTitle(selector('From daemon'))).toBeNull();
        expect(h.readBatch).not.toHaveBeenCalled();
        view.rerender(draw(h, { ...props, batch: null }));
        expect(panel()).toBeNull(); expect(h.readBatch).not.toHaveBeenCalled();
        view.rerender(draw(h)); await screen.findByTitle(selector('From daemon'));
        expect(h.readBatch).toHaveBeenCalledExactlyOnceWith(PANE);
    });
});
