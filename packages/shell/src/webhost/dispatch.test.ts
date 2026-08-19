/**
 * Verb dispatch: the envelopes the CLI ends up seeing (web-pane.md §8.2, §8.4, §13.2).
 *
 * The daemon merges `pane_id`/`workspace_id`/`tab_id` into whatever comes back and writes it to
 * the control socket verbatim, so these objects ARE the wire contract — including the failure
 * strings, which agents branch on.
 */

import { describe, expect, it, vi } from 'vitest';

import { TEXT_TRUNCATION_MARKER } from './caps.js';
import {
    clampZoom,
    createVerbDispatcher,
    paneSpecOf,
    type CookieRecord,
    type EvalOutcome,
    type PaneStorage,
    type TabController
} from './dispatch.js';
import { createTabRegistry, type TabRegistry } from './registry.js';

class FakeTab implements TabController {
    url_ = 'https://example.com/';
    title_ = 'Example';
    navigated: string[] = [];
    reloads: boolean[] = [];
    history: string[] = [];
    zoomFactor = 1;
    evaluated: string[] = [];
    /** Queue of outcomes; the last one repeats so a test only needs to name what it cares about. */
    outcomes: EvalOutcome[] = [{ ok: true, value: JSON.stringify({ ok: true }) }];
    png: Uint8Array | Error = new Uint8Array([1, 2, 3]);

    constructor(
        readonly paneID: string,
        readonly tabID: string
    ) {}

    url(): string {
        return this.url_;
    }
    title(): string {
        return this.title_;
    }
    navigate(url: string): void {
        this.navigated.push(url);
    }
    back(): void {
        this.history.push('back');
    }
    forward(): void {
        this.history.push('forward');
    }
    reload(hard: boolean): void {
        this.reloads.push(hard);
    }
    evaluate(expression: string): Promise<EvalOutcome> {
        this.evaluated.push(expression);
        const next = this.outcomes.length > 1 ? this.outcomes.shift() : this.outcomes[0];
        return Promise.resolve(next ?? { ok: true, value: undefined });
    }
    screenshot(): Promise<Uint8Array> {
        if (this.png instanceof Error) return Promise.reject(this.png);
        return Promise.resolve(this.png);
    }
    setZoom(factor: number): number {
        this.zoomFactor = clampZoom(factor);
        return this.zoomFactor;
    }
    zoom(): number {
        return this.zoomFactor;
    }
    devToolsOpen = false;
    setDevTools(open?: boolean): boolean {
        this.devToolsOpen = open ?? !this.devToolsOpen;
        return this.devToolsOpen;
    }
}

function harness(
    options: {
        cookies?: readonly CookieRecord[];
        writeScreenshot?: (paneID: string, png: Uint8Array) => Promise<string>;
    } = {}
) {
    const tabs: FakeTab[] = [];
    const registry: TabRegistry<FakeTab> = createTabRegistry<FakeTab>({
        create(input) {
            const tab = new FakeTab(input.paneID, input.tabID);
            tab.url_ = input.url;
            tabs.push(tab);
            return tab;
        },
        destroy() {},
        show() {}
    });
    const removals: { paneID: string; filter: { name?: string | undefined; domain?: string | undefined } }[] = [];
    const cleared: string[] = [];
    const storage: PaneStorage = {
        list: () => Promise.resolve(options.cookies ?? []),
        clearAllSiteData: (paneID) => {
            cleared.push(paneID);
            return Promise.resolve();
        },
        remove: (paneID, filter) => {
            removals.push({ paneID, filter });
            return Promise.resolve(2);
        }
    };
    const writeScreenshot = vi.fn(
        options.writeScreenshot ?? ((): Promise<string> => Promise.resolve('/tmp/nex-web-capture-P1-1.png'))
    );
    const dispatcher = createVerbDispatcher<FakeTab>({ registry, storage, writeScreenshot });
    dispatcher.notify('pane-open', {
        paneID: 'P1',
        isPrivate: false,
        activeTabID: 'T1',
        tabs: [{ id: 'T1', url: 'https://example.com/', title: 'Example' }]
    });
    const tab = tabs[0] as FakeTab;
    return { dispatcher, registry, tabs, tab, removals, cleared, writeScreenshot };
}

const scope = { paneID: 'P1', tabID: 'T1' };

describe('paneSpecOf', () => {
    it('reads the lifecycle payload and drops malformed tab entries', () => {
        expect(
            paneSpecOf({
                paneID: 'P1',
                isPrivate: true,
                activeTabID: 'T2',
                tabs: [{ id: 'T1', url: 'u', title: 't' }, { url: 'no id' }, 'nope']
            })
        ).toEqual({
            paneID: 'P1',
            isPrivate: true,
            activeTabID: 'T2',
            tabs: [{ id: 'T1', url: 'u', title: 't' }]
        });
    });

    it('treats an empty activeTabID as none', () => {
        expect(paneSpecOf({ paneID: 'P1', activeTabID: '', tabs: [] }).activeTabID).toBeNull();
    });
});

describe('lifecycle notifies', () => {
    it('drives the registry', () => {
        const { dispatcher, registry } = harness();
        dispatcher.notify('tab-open', { paneID: 'P1', tabID: 'T2', url: 'https://b/', makeActive: true });
        expect(registry.activeTabID('P1')).toBe('T2');
        dispatcher.notify('tab-select', { paneID: 'P1', tabID: 'T1' });
        expect(registry.activeTabID('P1')).toBe('T1');
        dispatcher.notify('tab-close', { paneID: 'P1', tabID: 'T2' });
        expect(registry.pane('P1')?.tabs).toHaveLength(1);
        dispatcher.notify('pane-close', { paneID: 'P1' });
        expect(registry.paneIDs()).toEqual([]);
    });

    it('acks a lifecycle verb that arrives as an RPC instead of failing it', async () => {
        const { dispatcher, registry } = harness();
        await expect(dispatcher.call('tab-open', { paneID: 'P1', tabID: 'T9', url: '', makeActive: false })).resolves.toEqual({ ok: true });
        expect(registry.pane('P1')?.tabs).toHaveLength(2);
    });

    it('disarms the picker on every tab of the pane', () => {
        const { dispatcher, tabs } = harness();
        dispatcher.notify('tab-open', { paneID: 'P1', tabID: 'T2', url: '', makeActive: false });
        dispatcher.notify('inspect-disarm', { paneID: 'P1' });
        expect(tabs).toHaveLength(2);
        for (const tab of tabs) expect(tab.evaluated[0]).toContain('__nexInspectorDisable');
    });
});

describe('navigation', () => {
    it('acks optimistically without waiting for the load', async () => {
        const { dispatcher, tab } = harness();
        await expect(dispatcher.call('navigate', { ...scope, url: 'https://b/' })).resolves.toEqual({ ok: true });
        expect(tab.navigated).toEqual(['https://b/']);
    });

    it('acks back/forward/reload and passes the hard flag through', async () => {
        const { dispatcher, tab } = harness();
        await dispatcher.call('back', scope);
        await dispatcher.call('forward', scope);
        await dispatcher.call('reload', { ...scope, hard: true });
        expect(tab.history).toEqual(['back', 'forward']);
        expect(tab.reloads).toEqual([true]);
    });

    it('returns the live url and title', async () => {
        const { dispatcher, tab } = harness();
        tab.url_ = 'https://live/';
        tab.title_ = 'Live';
        await expect(dispatcher.call('url', scope)).resolves.toEqual({
            ok: true,
            url: 'https://live/',
            title: 'Live'
        });
    });

    it('fails a verb aimed at a tab the host no longer has', async () => {
        const { dispatcher } = harness();
        await expect(dispatcher.call('url', { paneID: 'P1', tabID: 'GONE' })).resolves.toEqual({
            ok: false,
            error: 'web pane has no live tab GONE'
        });
    });
});

describe('capture (§8.4)', () => {
    it('meta carries only url + title', async () => {
        const { dispatcher } = harness();
        await expect(dispatcher.call('capture', { ...scope, mode: 'meta' })).resolves.toEqual({
            ok: true,
            url: 'https://example.com/',
            title: 'Example'
        });
    });

    it('text reports the byte count of what it returns', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: 'héllo' }];
        const reply = await dispatcher.call('capture', { ...scope, mode: 'text' });
        expect(reply['text']).toBe('héllo');
        expect(reply['byte_count']).toBe(6);
        expect(tab.evaluated[0]).toContain('innerText');
    });

    it('clamps oversized text with the trailing marker', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: 'x'.repeat(1_000_050) }];
        const reply = await dispatcher.call('capture', { ...scope, mode: 'text' });
        expect(String(reply['text']).endsWith(TEXT_TRUNCATION_MARKER)).toBe(true);
    });

    it('dom returns html', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: '<html></html>' }];
        const reply = await dispatcher.call('capture', { ...scope, mode: 'dom' });
        expect(reply['html']).toBe('<html></html>');
        expect(reply['byte_count']).toBe(13);
    });

    it('inlines a small screenshot as base64', async () => {
        const { dispatcher, writeScreenshot } = harness();
        const reply = await dispatcher.call('capture', { ...scope, mode: 'screenshot' });
        expect(reply['png_base64']).toBe(Buffer.from([1, 2, 3]).toString('base64'));
        expect(reply['byte_count']).toBe(3);
        expect(writeScreenshot).not.toHaveBeenCalled();
    });

    it('spills a large screenshot to a path instead', async () => {
        const { dispatcher, tab, writeScreenshot } = harness();
        tab.png = new Uint8Array(1_000_001);
        const reply = await dispatcher.call('capture', { ...scope, mode: 'screenshot' });
        expect(reply['path']).toBe('/tmp/nex-web-capture-P1-1.png');
        expect(reply['byte_count']).toBe(1_000_001);
        expect(writeScreenshot).toHaveBeenCalledOnce();
    });

    it('reports a spill failure with the path the writer tried', async () => {
        const { dispatcher, tab } = harness({
            writeScreenshot: () => Promise.reject(new Error('failed to write screenshot to /tmp/x.png'))
        });
        tab.png = new Uint8Array(1_000_001);
        await expect(dispatcher.call('capture', { ...scope, mode: 'screenshot' })).resolves.toEqual({
            ok: false,
            error: 'failed to write screenshot to /tmp/x.png'
        });
    });

    it('falls back to the bare write-failure string for an unrelated error', async () => {
        const { dispatcher, tab } = harness({ writeScreenshot: () => Promise.reject(new Error('EACCES')) });
        tab.png = new Uint8Array(1_000_001);
        await expect(dispatcher.call('capture', { ...scope, mode: 'screenshot' })).resolves.toEqual({
            ok: false,
            error: 'failed to write screenshot'
        });
    });

    it('fails the whole reply when a screenshot-only capture cannot be taken', async () => {
        const { dispatcher, tab } = harness();
        tab.png = new Error('no surface');
        await expect(dispatcher.call('capture', { ...scope, mode: 'screenshot' })).resolves.toEqual({
            ok: false,
            error: 'screenshot capture failed'
        });
    });

    it('degrades to screenshot_error inside `all`, keeping ok:true', async () => {
        const { dispatcher, tab } = harness();
        tab.png = new Error('no surface');
        tab.outcomes = [
            { ok: true, value: 'visible text' },
            { ok: true, value: '<html>x</html>' }
        ];
        const reply = await dispatcher.call('capture', { ...scope, mode: 'all' });
        expect(reply['ok']).toBe(true);
        expect(reply['text']).toBe('visible text');
        expect(reply['text_byte_count']).toBe(12);
        expect(reply['html']).toBe('<html>x</html>');
        expect(reply['html_byte_count']).toBe(14);
        expect(reply['screenshot_error']).toBe('screenshot capture failed');
        expect('png_base64' in reply).toBe(false);
    });

    it('names the screenshot byte count separately in `all`', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [
            { ok: true, value: 'text' },
            { ok: true, value: '<html/>' }
        ];
        const reply = await dispatcher.call('capture', { ...scope, mode: 'all' });
        expect(reply['screenshot_byte_count']).toBe(3);
        expect('byte_count' in reply).toBe(false);
    });
});

describe('actuator + exec (§8.2, §8.5)', () => {
    it('passes the page envelope through verbatim, ok:false included', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: JSON.stringify({ ok: false, error: 'no match for selector: #x' }) }];
        await expect(dispatcher.call('actuate', { ...scope, method: 'click', args: ['#x', {}] })).resolves.toEqual({
            ok: false,
            error: 'no match for selector: #x'
        });
        expect(tab.evaluated[0]).toContain('window.__nexAct["click"]');
    });

    it('labels a thrown evaluation as an actuator failure', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: false, error: 'Cannot access frame' }];
        await expect(dispatcher.call('actuate', { ...scope, method: 'click', args: [] })).resolves.toEqual({
            ok: false,
            error: 'actuator evaluation failed: Cannot access frame'
        });
    });

    it('rejects a non-string and a non-object reply with the spec details', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: 42 }];
        await expect(dispatcher.call('actuate', { ...scope, method: 'click', args: [] })).resolves.toEqual({
            ok: false,
            error: 'actuator evaluation failed: actuator returned non-string reply'
        });

        tab.outcomes = [{ ok: true, value: '"a string, not an object"' }];
        await expect(dispatcher.call('actuate', { ...scope, method: 'click', args: [] })).resolves.toEqual({
            ok: false,
            error: 'actuator evaluation failed: reply not JSON object'
        });
    });

    it('uses the exec label for exec failures and wraps the script', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: 'not json' }];
        await expect(dispatcher.call('exec', { ...scope, script: 'document.title' })).resolves.toEqual({
            ok: false,
            error: 'exec evaluation failed: reply not JSON object'
        });
        expect(tab.evaluated[0]).toContain('return (document.title);');
    });

    it('returns the exec result envelope unchanged', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: JSON.stringify({ ok: true, result: 'Example' }) }];
        await expect(dispatcher.call('exec', { ...scope, script: 'document.title' })).resolves.toEqual({
            ok: true,
            result: 'Example'
        });
    });
});

describe('inspect-arm', () => {
    it('arms with the daemon-minted nonce', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: true }];
        await expect(dispatcher.call('inspect-arm', { ...scope, nonce: 'abc', sticky: false })).resolves.toEqual({ ok: true });
        expect(tab.evaluated[0]).toContain('"abc"');
        expect(tab.evaluated[0]).toContain('false');
    });

    it('reports an arm the page refused', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: false }];
        await expect(dispatcher.call('inspect-arm', { ...scope, nonce: 'abc' })).resolves.toEqual({
            ok: false,
            error: 'failed to arm inspector for active tab'
        });
    });

    it('refuses to arm without a nonce (the nonce is the only trust anchor)', async () => {
        const { dispatcher } = harness();
        await expect(dispatcher.call('inspect-arm', scope)).resolves.toEqual({
            ok: false,
            error: 'inspect nonce is required'
        });
    });
});

describe('find + zoom', () => {
    it('returns the page counts', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: { total: 3, current: 0 } }];
        await expect(dispatcher.call('find', { ...scope, action: 'search', needle: 'x' })).resolves.toEqual({
            ok: true,
            total: 3,
            current: 0
        });
    });

    it('reports no matches as current -1', async () => {
        const { dispatcher, tab } = harness();
        tab.outcomes = [{ ok: true, value: { total: 0, current: -1 } }];
        const reply = await dispatcher.call('find', { ...scope, action: 'next' });
        expect(reply).toEqual({ ok: true, total: 0, current: -1 });
    });

    it('rejects an unknown find action', async () => {
        const { dispatcher } = harness();
        await expect(dispatcher.call('find', { ...scope, action: 'sideways' })).resolves.toEqual({
            ok: false,
            error: "unknown find action 'sideways' (allowed: search, next, prev, clear)"
        });
    });

    it('clamps zoom to [0.5, 3.0] and resets to 1', async () => {
        const { dispatcher, tab } = harness();
        await expect(dispatcher.call('zoom', { ...scope, factor: 9 })).resolves.toEqual({ ok: true, zoom: 3 });
        await expect(dispatcher.call('zoom', { ...scope, factor: 0.1 })).resolves.toEqual({ ok: true, zoom: 0.5 });
        await expect(dispatcher.call('zoom', { ...scope, delta: 0.4 })).resolves.toEqual({ ok: true, zoom: 0.9 });
        await expect(dispatcher.call('zoom', { ...scope, reset: true })).resolves.toEqual({ ok: true, zoom: 1 });
        expect(tab.zoomFactor).toBe(1);
    });

    it('toggles dev tools, and honours an explicit state', async () => {
        const { dispatcher, tab } = harness();
        await expect(dispatcher.call('devtools', scope)).resolves.toEqual({ ok: true, open: true });
        expect(tab.devToolsOpen).toBe(true);
        await expect(dispatcher.call('devtools', scope)).resolves.toEqual({ ok: true, open: false });
        await expect(dispatcher.call('devtools', { ...scope, open: true })).resolves.toEqual({
            ok: true,
            open: true
        });
        await expect(dispatcher.call('devtools', { ...scope, open: true })).resolves.toEqual({
            ok: true,
            open: true
        });
    });

    it('answers honestly for a tab that cannot open dev tools', async () => {
        const { dispatcher, tab } = harness();
        // The verb is optional on `TabController`: a tab without it must not become a throw.
        (tab as { setDevTools?: unknown }).setDevTools = undefined;
        await expect(dispatcher.call('devtools', scope)).resolves.toEqual({
            ok: false,
            error: 'dev tools are not available for this tab'
        });
    });
});

describe('cookies (§13.2)', () => {
    it('serialises the wire shape, omitting expires for session cookies', async () => {
        const { dispatcher } = harness({
            cookies: [
                {
                    name: 'sid',
                    value: 'abc',
                    domain: '.example.com',
                    path: '/',
                    isSecure: true,
                    isHttpOnly: true,
                    expires: 1_766_000_000
                },
                {
                    name: 'tmp',
                    value: '1',
                    domain: 'example.com',
                    path: '/',
                    isSecure: false,
                    isHttpOnly: false,
                    sessionOnly: true
                }
            ]
        });
        await expect(dispatcher.call('cookies-list', { paneID: 'P1' })).resolves.toEqual({
            ok: true,
            cookies: [
                {
                    name: 'sid',
                    value: 'abc',
                    domain: '.example.com',
                    path: '/',
                    is_secure: true,
                    is_http_only: true,
                    expires: 1_766_000_000
                },
                {
                    name: 'tmp',
                    value: '1',
                    domain: 'example.com',
                    path: '/',
                    is_secure: false,
                    is_http_only: false,
                    session_only: true
                }
            ]
        });
    });

    it('clear --all wipes site data and says the count is unknowable', async () => {
        const { dispatcher, cleared, removals } = harness();
        await expect(dispatcher.call('cookies-clear', { paneID: 'P1', all: true })).resolves.toEqual({
            ok: true,
            cleared_site_data: true
        });
        expect(cleared).toEqual(['P1']);
        expect(removals).toHaveLength(0);
    });

    it('clear with a domain deletes and counts', async () => {
        const { dispatcher, removals } = harness();
        await expect(dispatcher.call('cookies-clear', { paneID: 'P1', all: false, domain: '.example.com' })).resolves.toEqual({
            ok: true,
            deleted: 2
        });
        expect(removals[0]?.filter).toEqual({ domain: '.example.com' });
    });

    it('delete needs a name', async () => {
        const { dispatcher } = harness();
        await expect(dispatcher.call('cookies-delete', { paneID: 'P1' })).resolves.toEqual({
            ok: false,
            error: 'cookie name is required'
        });
    });

    it('delete scopes by name and optional domain', async () => {
        const { dispatcher, removals } = harness();
        await expect(dispatcher.call('cookies-delete', { paneID: 'P1', name: 'sid' })).resolves.toEqual({
            ok: true,
            deleted: 2
        });
        expect(removals[0]?.filter).toEqual({ name: 'sid', domain: undefined });
    });
});

describe('unknown verbs', () => {
    it('answers rather than hanging (a silent host becomes a daemon timeout)', async () => {
        const { dispatcher } = harness();
        await expect(dispatcher.call('teleport', scope)).resolves.toEqual({
            ok: false,
            error: "unsupported host verb 'teleport'"
        });
    });
});
