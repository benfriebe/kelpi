import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSnapshot } from '../../../plugin-sdk/browser-pane';
import { createKelpiStore, type KelpiRuntime } from '../state';
import type { WebPaneProps } from '../webpane/WebPane';
import { BrowserFeaturePane } from './BrowserFeaturePane';

let plugins: PluginInfo[] = [];
const read = vi.fn(), mounted = vi.fn(), released = vi.fn();
const nativeKey = vi.fn();
const shown = new Map<string, WebPaneProps & { available?: boolean }>();
vi.mock('../plugins/client', () => ({
    usePlugins: (runtime: KelpiRuntime) => ({ plugins, daemonID: new URL(runtime.connection.target).host }),
    getCurrentPlugins: () => plugins,
    pluginRequest: (...args: unknown[]) => read(...args)
}));
vi.mock('../webpane/WebPane', () => ({ WebPane: (props: WebPaneProps) => {
    shown.set(props.paneID, props);
    useEffect(() => { mounted(props.paneID, 'native'); return () => { released(props.paneID, 'native'); }; }, [props.paneID]);
    return <div data-testid={`native-${props.paneID}`} data-embedded={props.embedded} data-visible={props.visible}><input data-web-chrome-text="true" aria-label={`Address ${props.paneID}`} /></div>;
} }));
vi.mock('../plugins/PluginView', () => ({ PluginView: (props: { paneID: string; viewID: string; browser: WebPaneProps & { available: boolean }; onError(message: string): void }) => {
    shown.set(props.paneID, props.browser);
    useEffect(() => { mounted(props.paneID, props.viewID); return () => { released(props.paneID, props.viewID); }; }, [props.paneID, props.viewID]);
    return <button data-testid={`plugin-${props.paneID}`} data-embedded={props.browser.available} data-visible={props.browser.visible}
        onClick={() => props.onError('Renderer failed')}>{props.viewID}</button>;
} }));
vi.mock('../app/browser-shortcuts', () => ({ useBrowserShortcuts: () => ({ chords: [], onKey: () => false, onNativeKey: nativeKey }) }));
const W = 'aaaaaaaa-0000-4000-8000-000000000001';
const P = 'bbbbbbbb-0000-4000-8000-000000000001';
const P2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const T = 'cccccccc-0000-4000-8000-000000000001';
const S = 'dddddddd-0000-4000-8000-000000000001';
const fixtures = new Map<KelpiRuntime, ReturnType<typeof fixture>>();
function fixture(name = 'browser.test') {
    const daemon = createDaemonStore(emptyDaemonState('/private/fixture'));
    daemon.dispatch({ type: 'create-workspace', id: W, paneID: S, name, color: 'blue', now: 1 });
    daemon.dispatch({ type: 'open-web-pane', workspaceID: W, paneID: P, tabID: T, url: 'https://example.test/', now: 2 });
    const store = createKelpiStore();
    const sync = (): void => store.getState().applySnapshot(0, JSON.parse(JSON.stringify(daemon.getState())));
    sync();
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const connection = { target: `ws://${name}/ws`, isConnected: true,
        on(event: string, listener: (value: unknown) => void) {
            const held = listeners.get(event) ?? new Set(); held.add(listener); listeners.set(event, held);
            return () => { held.delete(listener); };
        } };
    const raw = vi.fn().mockResolvedValue({ok:true});
    const runtime = { store, connection, commands: { raw }, focusPane: vi.fn() } as unknown as KelpiRuntime;
    const snapshot: BrowserSnapshot = { paneID:P,workspaceID:W,isPrivate:false,activeTabID:T,
        tabs:[{id:T,url:'https://example.test/',title:'Fixture',live:true,loading:false,canGoBack:false,canGoForward:false}],
        host:{available:true,id:'host',name:'Kelpi',windowID:'local-window'},favourites:[],
        inspection:{revision:0,armed:false,tabID:null,pendingResults:0,batchVisible:false,batchItems:0,batchFocusedID:null} };
    const emit = (event: string, value: unknown): void => { for (const listener of listeners.get(event) ?? []) listener(value); };
    return {runtime,daemon,store,sync,raw,connection,listeners,emit,snapshot};
}
function pending<T>() { let resolve!: (value:T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return {promise,resolve}; }
const draw = (h: ReturnType<typeof fixture>, props: Partial<Parameters<typeof BrowserFeaturePane>[0]> = {}) =>
    <BrowserFeaturePane runtime={h.runtime} workspaceID={W} paneID={P} visible focused embedded {...props} />;
const choose = (choice = 'sample.browser.chrome', index = 0) => fireEvent.change(screen.getAllByLabelText('Browser renderer')[index]!,{target:{value:choice}});
beforeEach(() => {
    localStorage.clear(); history.replaceState({}, '', '/?shellWindow=local-window');
    read.mockReset(); mounted.mockClear(); released.mockClear(); nativeKey.mockReset().mockReturnValue(false); shown.clear(); fixtures.clear();
    plugins = [{ manifest: decodePluginManifest({id:'sample.browser',version:'1.0.0',apiVersion:1,trust:'full',contributes:{
        views:[{id:'sample.browser.chrome',title:'Custom browser',entry:'ui/index.html',placements:['browser']}]
    }}), enabled:true,status:'inactive',revision:'one',instanceID:'one',error:null }];
    read.mockImplementation(async (runtime: KelpiRuntime, _action: string, input: {paneID:string}) => ({...fixtures.get(runtime)!.snapshot,paneID:input.paneID}));
});
afterEach(cleanup);
const make = (name?: string) => { const h = fixture(name); fixtures.set(h.runtime,h); return h; };

describe('replaceable browser feature', () => {
    it('switches and persists browser controls without mutating native tabs or sessions', async () => {
        const h = make(); const view = render(draw(h));
        await waitFor(() => expect(screen.getByTestId(`native-${P}`).dataset.embedded).toBe('true'));
        choose(); expect(screen.getByTestId(`plugin-${P}`).dataset.embedded).toBe('true');
        expect(released).toHaveBeenCalledWith(P,'native');
        expect(shown.get(P)?.tabs[0]?.id).toBe(T); expect(h.raw).not.toHaveBeenCalled();
        view.unmount(); render(draw(h));
        await waitFor(() => expect(screen.getByTestId(`plugin-${P}`).dataset.embedded).toBe('true'));
        choose('kelpi.web'); expect(screen.getByTestId(`native-${P}`)).toBeDefined();
    });

    it('keeps current native props ahead of a late snapshot and retains native callbacks', async () => {
        const h = make(), onGeometry = vi.fn(), onHidden = vi.fn();
        const tabs = [{id:'latest-tab',url:'https://latest.test/',title:'Current native state'}];
        render(draw(h,{tabs,activeTabID:'latest-tab',isPrivate:true,loading:true,onGeometry,onHidden}));
        await waitFor(() => expect(shown.get(P)?.embedded).toBe(true)); choose();
        expect(shown.get(P)).toMatchObject({tabs,activeTabID:'latest-tab',isPrivate:true,loading:true,onGeometry,onHidden});
    });

    it('keeps native pages embedded when native browser state exceeds the plugin reply budget', async () => {
        const h = make();
        h.snapshot = {...h.snapshot,favourites:[{id:'large',url:'https://example.test/',title:'x'.repeat(300_000),label:'Large saved title',createdAt:'2026-09-10T00:00:00Z'}]};
        read.mockImplementation(async (_runtime:KelpiRuntime,action:string) => {
            if (action !== 'browser-state') throw new Error('Plugin reply exceeds its 256 KiB budget');
            return h.snapshot;
        });
        render(draw(h)); await waitFor(() => expect(shown.get(P)?.embedded).toBe(true));
        expect(shown.get(P)?.favourites?.[0]?.title).toHaveLength(300_000);
        expect(read).toHaveBeenCalledWith(h.runtime,'browser-state',{paneID:P});
    });

    it('isolates renderer preferences by daemon while sharing them across sibling panes', async () => {
        const h = make(), remote = make('remote-browser.test');
        h.daemon.dispatch({type:'open-web-pane',workspaceID:W,paneID:P2,tabID:'second-tab',url:'https://second.test/',now:3}); h.sync();
        render(<>{draw(h)}{draw(h,{paneID:P2})}{draw(remote,{paneID:'remote-pane',embedded:false})}</>);
        choose(); await waitFor(() => expect(screen.getByTestId(`plugin-${P2}`)).toBeDefined());
        expect(screen.getByTestId('native-remote-pane')).toBeDefined();
    });

    it('retains a mounted replacement while visibility changes', async () => {
        const h = make(); const view = render(draw(h)); choose();
        await waitFor(() => expect(shown.get(P)?.available).toBe(true));
        const before = mounted.mock.calls.length;
        view.rerender(draw(h,{visible:false,focused:false}));
        expect(screen.getByTestId(`plugin-${P}`).dataset.visible).toBe('false');
        view.rerender(draw(h)); expect(mounted.mock.calls).toHaveLength(before);
    });

    it('falls back on failure, supports retry and recovers after plugin reload or enable', async () => {
        const h = make(); const view = render(draw(h)); choose();
        await waitFor(() => expect(shown.get(P)?.available).toBe(true));
        fireEvent.click(screen.getByTestId(`plugin-${P}`)); expect(screen.getByTestId(`native-${P}`)).toBeDefined();
        expect(screen.getByRole('status').textContent).toContain('bundled browser');
        fireEvent.click(screen.getByText('Retry renderer')); expect(screen.getByTestId(`plugin-${P}`)).toBeDefined();
        fireEvent.click(screen.getByTestId(`plugin-${P}`));
        plugins = [{...plugins[0]!,instanceID:'two'}]; view.rerender(draw(h)); expect(screen.getByTestId(`plugin-${P}`)).toBeDefined();
        plugins = [{...plugins[0]!,enabled:false}]; view.rerender(draw(h)); expect(screen.getByTestId(`native-${P}`)).toBeDefined();
        plugins = [{...plugins[0]!,enabled:true}]; view.rerender(draw(h)); expect(screen.getByTestId(`plugin-${P}`)).toBeDefined();
    });

    it('does not embed another window’s page, or offer pixels to remote/phone clients', async () => {
        const h = make(); const view = render(draw(h,{embedded:false})); choose();
        await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        expect(shown.get(P)?.available).toBe(false);
        h.snapshot = {...h.snapshot,host:{...h.snapshot.host,windowID:'other-window'}};
        view.rerender(draw(h)); act(() => h.emit('message',{type:'web-browser-changed',paneID:P}));
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        expect(shown.get(P)?.available).toBe(false);
    });

    it('coalesces invalidations and never publishes an obsolete in-flight host result', async () => {
        const h = make(), first = pending<BrowserSnapshot>(), second = pending<BrowserSnapshot>();
        read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        render(draw(h)); choose();
        expect(h.listeners.get('message')?.size).toBe(1);
        act(() => { h.emit('message',{type:'web-browser-changed',paneID:null}); h.emit('message',{type:'web-browser-changed',paneID:P}); });
        expect(read).toHaveBeenCalledTimes(1);
        await act(async () => first.resolve(h.snapshot));
        expect(read).toHaveBeenCalledTimes(2); expect(shown.get(P)?.available).toBe(false);
        await act(async () => second.resolve({...h.snapshot,host:{...h.snapshot.host,windowID:'other-window'}}));
        expect(shown.get(P)?.available).toBe(false);
        act(() => h.emit('message',{type:'web-browser-changed',paneID:'unrelated'})); expect(read).toHaveBeenCalledTimes(2);
        act(() => h.emit('message',{type:'web-browser-changed',paneID:P}));
        await waitFor(() => expect(shown.get(P)?.available).toBe(true));
    });

    it('drops stale ownership immediately on disconnect and rereads after reconnect', async () => {
        const h = make(); render(draw(h)); choose(); await waitFor(() => expect(shown.get(P)?.available).toBe(true));
        const old = pending<BrowserSnapshot>(); read.mockReturnValueOnce(old.promise);
        act(() => h.emit('message',{type:'web-browser-changed',paneID:P}));
        act(() => { h.connection.isConnected = false; h.emit('status','disconnected'); });
        expect(shown.get(P)?.available).toBe(false);
        await act(async () => old.resolve(h.snapshot)); expect(shown.get(P)?.available).toBe(false);
        act(() => { h.connection.isConnected = true; h.emit('status','connected'); });
        await waitFor(() => expect(shown.get(P)?.available).toBe(true));
    });

    it('cannot apply an old runtime’s ownership to a replacement runtime', async () => {
        const h = make(), remote = make('replacement-browser.test'), late = pending<BrowserSnapshot>();
        read.mockReturnValueOnce(late.promise);
        const view = render(draw(h)); choose();
        remote.snapshot = {...remote.snapshot,host:{...remote.snapshot.host,windowID:'remote-window'}};
        view.rerender(draw(remote)); choose();
        await act(async () => late.resolve(h.snapshot));
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        expect(shown.get(P)?.available).toBe(false);
        expect(h.listeners.get('message')?.size).toBe(0); expect(h.listeners.get('status')?.size).toBe(0);
    });

    it('revokes embedding when the current store no longer owns a web pane', async () => {
        const h = make(); render(draw(h)); choose(); await waitFor(() => expect(shown.get(P)?.available).toBe(true));
        act(() => { h.daemon.dispatch({type:'close-pane',workspaceID:W,paneID:P}); h.sync(); });
        expect(shown.get(P)?.available).toBe(false);
    });

    it('routes remote bundled chrome keys through its owning handler without duplicate dispatch', async () => {
        const h = make('remote-native-browser.test');
        const parent = vi.fn(); render(<div onKeyDown={parent}>{draw(h,{embedded:false})}</div>);
        const input = screen.getByLabelText(`Address ${P}`);
        nativeKey.mockReturnValue(true);
        expect(fireEvent.keyDown(input,{key:'l',code:'KeyL',metaKey:true})).toBe(false);
        expect(nativeKey).toHaveBeenCalledTimes(1); expect(parent).not.toHaveBeenCalled();
        nativeKey.mockReturnValue(false);
        expect(fireEvent.keyDown(input,{key:'ArrowLeft',code:'ArrowLeft',metaKey:true})).toBe(true);
        expect(parent).toHaveBeenCalledTimes(1);
        nativeKey.mockClear();
        const handled = new KeyboardEvent('keydown',{key:'l',code:'KeyL',metaKey:true,bubbles:true,cancelable:true}); handled.preventDefault();
        fireEvent(input,handled); expect(nativeKey).not.toHaveBeenCalled();
        choose(); fireEvent.keyDown(screen.getByTestId(`plugin-${P}`),{key:'l',code:'KeyL',metaKey:true});
        expect(nativeKey).not.toHaveBeenCalled();
        await act(async () => {});
    });
});
