import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKelpiAPI, type BrowserAction, type BrowserAttachOptions, type BrowserSnapshot, type Data } from '../../../plugin-sdk/index.js';
import { buildFindCall, findScript, type FindAction } from '../../../shell/src/webhost/scripts';

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples/plugins/browser-lab/ui');
const html = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(assets, 'browser.js'), 'utf8');
const cleanups: Array<() => void> = [];
async function settle(): Promise<void> { for (let index = 0; index < 20; index++) await Promise.resolve(); }
function deferred() {
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
function snapshot(isPrivate = false): BrowserSnapshot {
    return {
        paneID: 'pane', workspaceID: 'workspace', isPrivate, activeTabID: 'tab-one',
        tabs: ['one', 'two'].map(name => ({ id: `tab-${name}`, url: `https://${name}.example`, title: name,
            live: true, loading: false, canGoBack: false, canGoForward: false })),
        host: { available: true, id: 'host', name: 'Kelpi', windowID: 'window' }, favourites: [],
        inspection: { revision: 0, armed: false, tabID: null, pendingResults: 0, batchVisible: false, batchItems: 0, batchFocusedID: null }
    };
}
async function mount(initial = snapshot(), holdFindClear = false) {
    document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
    const native = document.implementation.createHTMLDocument('Native page');
    native.body.innerHTML = '<p>alpha needle</p><p>beta needle</p>';
    const nativeWindow: { top?: unknown } = {}; nativeWindow.top = nativeWindow;
    const nativeContext = vm.createContext({ window: nativeWindow, document: native, NodeFilter });
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    cleanups.push(() => { Element.prototype.scrollIntoView = scrollIntoView; });
    // This is the same marking/search implementation the shell injects into native pages.
    vm.runInContext(findScript(), nativeContext);

    let state = initial, onAction: BrowserAttachOptions['onAction'];
    const captures: Array<ReturnType<typeof deferred> & { args: Data }> = [], clears: ReturnType<typeof deferred>[] = [];
    const listeners = new Map<string, (event: { data: { subscription: string } }) => unknown>();
    const transport = vi.fn(async (method: string, args: Data): Promise<unknown> => {
        if (method === 'browser.watch') return { subscription: 'watch', state: structuredClone(state) };
        if (method === 'browser.get') return structuredClone(state);
        if (method === 'browser.unwatch') return {};
        if (method === 'browser.find') {
            const result = vm.runInContext(buildFindCall(args['action'] as FindAction, String(args['needle'] ?? '')), nativeContext);
            if (holdFindClear && args['action'] === 'clear') { const pending = deferred(); clears.push(pending); return pending.promise; }
            return { ok: true, pane_id: 'pane', tab_id: args['tabID'], ...result };
        }
        if (method === 'browser.setPrivate') {
            const isPrivate = args['isPrivate'] as boolean, changed = state.isPrivate !== isPrivate;
            state = { ...state, isPrivate }; return { ok: true, pane_id: 'pane', private: isPrivate, changed };
        }
        if (method === 'browser.tabs.select') {
            state = { ...state, activeTabID: String(args['tabID']) }; return { ok: true, pane_id: 'pane', tab_id: args['tabID'] };
        }
        if (method === 'browser.capture') { const pending = { ...deferred(), args }; captures.push(pending); return pending.promise; }
        throw new Error(`Unexpected Browser Lab request: ${method}`);
    });
    const api = createKelpiAPI(transport, () => ({ paneID: 'pane' }));
    // Fixture tab IDs contain only CSS-safe letters and hyphens; jsdom omits CSS.escape.
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    vi.stubGlobal('browserLab', undefined);
    vi.stubGlobal('kelpi', { ...api, ready: Promise.resolve(),
        events: { on(name: string, listener: (event: { data: { subscription: string } }) => unknown) { listeners.set(name, listener); return () => listeners.delete(name); } },
        browser: { ...api.browser, async attach(options: BrowserAttachOptions) {
            onAction = options.onAction;
            await options.onPresentation({ available: true, visible: true, focused: true });
            return { focus() { (document.activeElement as HTMLElement | null)?.blur(); }, setCovered() {}, dispose() {} };
        } }
    });
    const windowEvents = vi.spyOn(globalThis, 'addEventListener'), documentEvents = vi.spyOn(document, 'addEventListener');
    const registeredWindow: typeof windowEvents.mock.calls = [], registeredDocument: typeof documentEvents.mock.calls = [];
    try { await new Function(`return (async () => { ${app}\n})();`)(); }
    finally {
        registeredWindow.push(...windowEvents.mock.calls); registeredDocument.push(...documentEvents.mock.calls);
        windowEvents.mockRestore(); documentEvents.mockRestore();
    }
    cleanups.push(() => {
        window.dispatchEvent(new Event('pagehide'));
        for (const [name, listener, options] of registeredWindow) globalThis.removeEventListener(name, listener, options);
        for (const [name, listener, options] of registeredDocument) document.removeEventListener(name, listener, options);
    });
    const element = (id: string): HTMLElement => document.getElementById(id)!;
    const click = async (id: string): Promise<void> => {
        const button = element(id) as HTMLButtonElement;
        expect(button.disabled).toBe(false); button.click(); await settle();
    };
    const select = async (tabID: string): Promise<void> => {
        (document.querySelector(`[data-tab="${tabID}"]`) as HTMLButtonElement).click(); await settle();
    };
    const change = async (update: Partial<BrowserSnapshot>): Promise<void> => {
        state = { ...state, ...update }; await listeners.get('browser.changed')?.({ data: { subscription: 'watch' } }); await settle();
    };
    const search = async (needle: string): Promise<void> => {
        const input = element('find-input') as HTMLInputElement;
        input.value = needle; input.dispatchEvent(new Event('input')); await settle();
    };
    const completeCapture = async (index: number, text: string): Promise<void> => {
        const pending = captures[index]!;
        pending.resolve({ ok: true, pane_id: 'pane', tab_id: pending.args['tabID'] ?? 'tab-one', mode: 'text', text }); await settle();
    };
    return { element, click, select, change, search, completeCapture, captures, clears, transport,
        hostAction: async (action: BrowserAction) => { await onAction?.(action); await settle(); },
        marks: () => native.querySelectorAll('.kelpi-webfind-match').length };
}
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    await settle(); vi.unstubAllGlobals(); document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('Browser Lab controls through the public SDK', () => {
    it.each([false, true])('confirms the displayed private-mode intent when the initial mode is %s', async initial => {
        const h = await mount(snapshot(initial));
        await h.click('tools'); await h.click('private');
        const label = `${initial ? 'Disable' : 'Enable'} private mode`;
        expect(h.element('confirm-private').textContent).toBe(label);
        await h.change({ isPrivate: !initial });
        expect(h.element('confirm-private').textContent).toBe(label);
        await h.click('confirm-private');
        expect(h.transport).toHaveBeenCalledWith('browser.setPrivate', { paneID: 'pane', isPrivate: !initial });
        expect(document.body.dataset['private']).toBe(String(!initial));
    });

    it('restarts a retained Find query after closing and reopening from a host shortcut', async () => {
        const h = await mount(); await h.click('find'); await h.search('needle');
        expect(h.element('matches').textContent).toBe('1 / 2'); expect(h.marks()).toBe(2);
        await h.click('find-close'); expect(h.marks()).toBe(0);
        await h.hostAction({ type: 'showFind' });
        expect((h.element('find-input') as HTMLInputElement).value).toBe('needle');
        expect(h.element('matches').textContent).toBe('1 / 2'); expect(h.marks()).toBe(2);
        await h.click('find-next'); expect(h.element('matches').textContent).toBe('2 / 2');
        await h.hostAction({ type: 'showFind' });
        expect(h.element('matches').textContent).toBe('2 / 2');
    });

    it('ignores an obsolete clear failure after Find has already reopened', async () => {
        const h = await mount(snapshot(), true); await h.click('find'); await h.search('needle');
        await h.click('find-close'); await h.click('find');
        h.clears[0]!.resolve({ ok: false, error: 'browser find target changed' }); await settle();
        expect(h.element('problem').hidden).toBe(true);
        expect(h.element('matches').textContent).toBe('1 / 2'); expect(h.marks()).toBe(2);
    });

    it.each([false, true])('discards a capture after leaving its tab, including a return to that tab: %s', async returnToOriginal => {
        const h = await mount(); await h.click('tools'); await h.click('capture');
        await h.select('tab-two');
        if (returnToOriginal) await h.select('tab-one');
        await h.completeCapture(0, 'Old tab contents');
        expect(h.element('capture-result').hidden).toBe(true);
        expect(h.captures[0]!.args).toEqual({ paneID: 'pane', tabID: 'tab-one', mode: 'text' });
    });

    it.each(['reply', 'error'])('keeps the newest capture when a superseded request finishes with a late %s', async outcome => {
        const h = await mount(); await h.click('tools'); await h.click('capture'); await h.click('capture');
        await h.completeCapture(1, 'Latest page text');
        if (outcome === 'reply') await h.completeCapture(0, 'Old page text');
        else { h.captures[0]!.reject(new Error('Old capture failed')); await settle(); }
        expect(h.element('capture-result').textContent).toBe('Latest page text');
        expect(h.element('capture-result').hidden).toBe(false); expect(h.element('problem').hidden).toBe(true);
    });
});
