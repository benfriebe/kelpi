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
    stops = 0;
    stop(): void {
        this.stops += 1;
    }
    focuses = 0;
    focusView(): void {
        this.focuses += 1;
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
    /** Issue #12: base64 JPEG, `null` for "no on-screen view", or an Error for a failed call. */
    jpeg: string | null | Error = 'AAAA';
    posters = 0;
    poster(): Promise<string | null> {
        this.posters += 1;
        if (this.jpeg instanceof Error) return Promise.reject(this.jpeg);
        return Promise.resolve(this.jpeg);
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
        /** False models a host with no cookie-write surface, which must refuse honestly. */
        canWriteCookies?: boolean;
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
    const writes: { paneID: string; cookie: unknown; original: unknown }[] = [];
    const storage: PaneStorage = {
        list: () => Promise.resolve(options.cookies ?? []),
        ...(options.canWriteCookies === false
            ? {}
            : {
                  set: (paneID, cookie, original) => {
                      writes.push({ paneID, cookie, original });
                      return Promise.resolve();
                  }
              }),
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
        options.writeScreenshot ?? ((): Promise<string> => Promise.resolve('/tmp/kelpi-web-capture-P1-1.png'))
    );
    const dispatcher = createVerbDispatcher<FakeTab>({ registry, storage, writeScreenshot });
    dispatcher.notify('pane-open', {
        paneID: 'P1',
        isPrivate: false,
        activeTabID: 'T1',
        tabs: [{ id: 'T1', url: 'https://example.com/', title: 'Example' }]
    });
    const tab = tabs[0] as FakeTab;
    return { dispatcher, registry, tabs, tab, removals, cleared, writes, writeScreenshot };
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
        for (const tab of tabs) expect(tab.evaluated[0]).toContain('__kelpiInspectorDisable');
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

    it('stops a load in flight and hands the page keyboard focus (WEB-032/WEB-043)', async () => {
        const { dispatcher, tab } = harness();
        await expect(dispatcher.call('stop', scope)).resolves.toEqual({ ok: true });
        await expect(dispatcher.call('focus-view', scope)).resolves.toEqual({ ok: true });
        expect(tab.stops).toBe(1);
        expect(tab.focuses).toBe(1);
        // Both resolve the ACTIVE tab when the caller names none — the chrome usually does not.
        await dispatcher.call('focus-view', { paneID: scope.paneID });
        expect(tab.focuses).toBe(2);
    });

    it('answers honestly for a host that cannot stop or focus', async () => {
        const { dispatcher, tab } = harness();
        // Both are optional on `TabController`: a test double, or a future non-Electron host,
        // simply does not have them. (Own properties shadowing the prototype's, since `delete`
        // on an instance would not reach a class method.)
        const reduced = tab as unknown as { stop?: unknown; focusView?: unknown };
        reduced.stop = undefined;
        reduced.focusView = undefined;
        await expect(dispatcher.call('stop', scope)).resolves.toEqual({
            ok: false,
            error: 'this host cannot stop a load'
        });
        await expect(dispatcher.call('focus-view', scope)).resolves.toEqual({
            ok: false,
            error: 'this host cannot focus a view'
        });
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
        expect(reply['path']).toBe('/tmp/kelpi-web-capture-P1-1.png');
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

/**
 * Issue #12's poster — the still frame a covered pane wears while its view is parked.
 *
 * The envelope is a contract like every other one here: the client branches on `ok` to decide
 * whether to keep holding its view on screen, so each refusal has to be an honest `ok:false`
 * with its own reason rather than an empty success.
 */
describe('the poster (issue #12)', () => {
    it('answers with the base64 frame, its mime and its size', async () => {
        const { dispatcher, tab } = harness();
        await expect(dispatcher.call('poster', scope)).resolves.toEqual({
            ok: true,
            image_base64: 'AAAA',
            mime: 'image/jpeg',
            bytes: 4
        });
        expect(tab.posters).toBe(1);
    });

    it('refuses when there is no on-screen view to photograph', async () => {
        const { dispatcher, tab } = harness();
        // The tab is in the off-screen holder: its frame would be the pinned 1280×800 automation
        // viewport, which is not the pane's page and must never be painted as if it were.
        tab.jpeg = null;
        await expect(dispatcher.call('poster', scope)).resolves.toEqual({
            ok: false,
            error: 'no on-screen view to poster'
        });
    });

    it('reports a failed capture rather than an empty frame', async () => {
        const { dispatcher, tab } = harness();
        tab.jpeg = new Error('no surface');
        await expect(dispatcher.call('poster', scope)).resolves.toEqual({
            ok: false,
            error: 'poster capture failed'
        });
        tab.jpeg = '';
        await expect(dispatcher.call('poster', scope)).resolves.toEqual({
            ok: false,
            error: 'poster capture failed'
        });
    });

    it('refuses a frame too large to ride the reply', async () => {
        const { dispatcher, tab } = harness();
        // A poster has no temp-file fallback the way §8.4's screenshot does: the client paints
        // it or does without, so the budget is the refusal.
        tab.jpeg = 'A'.repeat(4_000_001);
        await expect(dispatcher.call('poster', scope)).resolves.toEqual({
            ok: false,
            error: 'poster too large to send inline'
        });
    });

    it('refuses honestly on a host with no poster surface at all', async () => {
        const { dispatcher, tab } = harness();
        // A future non-Electron host (or a test double) simply omits the method.
        (tab as unknown as { poster: (() => Promise<string | null>) | undefined }).poster = undefined;
        await expect(dispatcher.call('poster', scope)).resolves.toEqual({
            ok: false,
            error: 'no on-screen view to poster'
        });
    });

    it('refuses when the pane has no live tab', async () => {
        const { dispatcher } = harness();
        await expect(dispatcher.call('poster', { paneID: 'P1', tabID: 'T9' })).resolves.toEqual({
            ok: false,
            error: 'web pane has no live tab T9'
        });
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
        expect(tab.evaluated[0]).toContain('window.__kelpiAct["click"]');
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

describe('cookies-set — §13.2\'s write half', () => {
    it('names the original so the host can delete-then-set (WEB-052)', async () => {
        const { dispatcher, writes } = harness();
        const reply = await dispatcher.call('cookies-set', {
            ...scope,
            cookie: { name: 'renamed', value: '1', domain: 'example.com', path: '/', is_secure: true },
            original: { name: 'session', domain: 'example.com', path: '/' }
        });
        expect(reply).toEqual({ ok: true, name: 'renamed', domain: 'example.com' });
        expect(writes).toHaveLength(1);
        expect(writes[0]?.cookie).toMatchObject({
            name: 'renamed',
            domain: 'example.com',
            isSecure: true,
            isHttpOnly: false
        });
        expect(writes[0]?.original).toMatchObject({ name: 'session', domain: 'example.com' });
    });

    it('defaults the path and drops an empty original', async () => {
        const { dispatcher, writes } = harness();
        await dispatcher.call('cookies-set', {
            ...scope,
            cookie: { name: 'a', value: '', domain: 'example.com' },
            original: { name: '', domain: '' }
        });
        expect(writes[0]?.cookie).toMatchObject({ path: '/' });
        expect(writes[0]?.original).toBeUndefined();
    });

    it('refuses a nameless or domainless cookie before touching the store', async () => {
        const { dispatcher, writes } = harness();
        expect(await dispatcher.call('cookies-set', { ...scope, cookie: { domain: 'example.com' } })).toEqual({
            ok: false,
            error: 'cookie name is required'
        });
        expect(await dispatcher.call('cookies-set', { ...scope, cookie: { name: 'a' } })).toEqual({
            ok: false,
            error: 'cookie domain is required'
        });
        expect(await dispatcher.call('cookies-set', { ...scope })).toEqual({
            ok: false,
            error: 'cookie is required'
        });
        expect(writes).toHaveLength(0);
    });

    it('answers honestly when the host has no write surface', async () => {
        const { dispatcher } = harness({ canWriteCookies: false });
        expect(
            await dispatcher.call('cookies-set', { ...scope, cookie: { name: 'a', domain: 'b' } })
        ).toEqual({ ok: false, error: 'this host cannot write cookies' });
    });
});

describe('the batch marker verbs (§7.3)', () => {
    it('drive the page through notifies, dropping selector-less items', async () => {
        const { dispatcher, tab } = harness();
        dispatcher.notify('batch-markers', {
            ...scope,
            items: [
                { id: 'i1', selector: '#a', label: '1', comment: 'note' },
                { id: 'i2', label: '2' },
                'nope'
            ]
        });
        await Promise.resolve();
        const call = tab.evaluated.at(-1) ?? '';
        expect(call).toContain('__kelpiBatchSetMarkers');
        expect(call).toContain('"selector":"#a"');
        // A marker with no selector cannot be re-queried, so it never reaches the page.
        expect(call).not.toContain('"id":"i2"');
    });

    it('highlight defaults to scrolling, and unfocus/clear/comment reach their globals', async () => {
        const { dispatcher, tab } = harness();
        dispatcher.notify('batch-highlight', { ...scope, itemID: 'i1' });
        await Promise.resolve();
        expect(tab.evaluated.at(-1)).toContain('__kelpiBatchHighlight("i1", true)');

        dispatcher.notify('batch-highlight', { ...scope, itemID: 'i1', scrollIntoView: false });
        await Promise.resolve();
        expect(tab.evaluated.at(-1)).toContain('__kelpiBatchHighlight("i1", false)');

        dispatcher.notify('batch-unfocus', scope);
        await Promise.resolve();
        expect(tab.evaluated.at(-1)).toContain('__kelpiBatchUnfocus');

        dispatcher.notify('batch-clear', scope);
        await Promise.resolve();
        expect(tab.evaluated.at(-1)).toContain('__kelpiBatchClearMarkers');

        dispatcher.notify('batch-comment', { ...scope, itemID: 'i1', comment: 'typed' });
        await Promise.resolve();
        expect(tab.evaluated.at(-1)).toContain('__kelpiBatchUpdateComment("i1", "typed")');
    });

    it('is a silent no-op for a pane the host has no view for', () => {
        const { dispatcher } = harness();
        expect(() => dispatcher.notify('batch-clear', { paneID: 'gone', tabID: 'gone' })).not.toThrow();
    });
});
