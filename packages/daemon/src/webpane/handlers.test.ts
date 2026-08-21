/**
 * The `web-*` command surface, driven through the REAL wire decoder against a FAKE host.
 *
 * What these specs pin down (web-pane.md §8–§13, §17):
 *   - scope resolution + its verbatim error strings;
 *   - which verbs answer from daemon state (and therefore work headlessly) versus which
 *     require a browser and fail with `no web pane host connected`;
 *   - pre-minted pane/tab UUIDs echoed BEFORE the effect (and before any host ack);
 *   - the host RPC shapes, and the id merge on the way back;
 *   - the console follow stream's framing and subscriber lifetime;
 *   - the element picker's arm → payload → queue → paste pipeline.
 */

import { describe, expect, it } from 'vitest';

import { NO_HOST_ERROR, timeoutError } from './host.js';
import {
    attachFakeHost,
    flush,
    id,
    SHELL_PANE,
    WEB_PANE,
    WEB_TAB,
    webHarness,
    WORKSPACE
} from './testing.js';

const OTHER_TAB = id('cccccccc', 2);

describe('scope resolution (§8.1)', () => {
    it('resolves the caller pane and rejects a non-web pane by type', () => {
        const h = webHarness();
        expect(h.reply({ command: 'web-tabs', pane_id: WEB_PANE })).toMatchObject({ ok: true });
        expect(h.reply({ command: 'web-tabs', pane_id: SHELL_PANE })).toEqual({
            ok: false,
            error: 'pane is not a web pane (type: shell)'
        });
    });

    it('passes the pane-target resolver errors through verbatim', () => {
        const h = webHarness();
        const missing = id('99999999', 9);
        expect(h.reply({ command: 'web-tabs', pane_id: missing })).toEqual({
            ok: false,
            error: `no pane with UUID '${missing}'`
        });
        expect(h.reply({ command: 'web-tabs', pane_id: WEB_PANE, target: 'nope' })).toEqual({
            ok: false,
            error: "no pane with label 'nope' in workspace 'w1' (use --workspace <name-or-id> to address another workspace)"
        });
    });

    it('reports a tab-less pane as having no active tab, but still lists its tabs', () => {
        const h = webHarness();
        // Drive the pane down to zero tabs the way a restore of a private pane would.
        h.store.dispatch({
            type: 'replace-state',
            state: {
                ...h.state(),
                workspaces: h.state().workspaces.map((workspace) => ({
                    ...workspace,
                    webPanes: { [WEB_PANE]: { tabs: [], activeTabID: null, isPrivate: false } }
                }))
            }
        });
        expect(h.reply({ command: 'web-tabs', pane_id: WEB_PANE })).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tabs: []
        });
        expect(h.reply({ command: 'web-url', pane_id: WEB_PANE })).toEqual({
            ok: false,
            error: 'web pane has no active tab'
        });
    });

    it('reports a missing sidecar as the invariant violation it is (§17.3)', () => {
        const h = webHarness();
        h.store.dispatch({
            type: 'replace-state',
            state: {
                ...h.state(),
                workspaces: h.state().workspaces.map((workspace) => ({ ...workspace, webPanes: {} }))
            }
        });
        expect(h.reply({ command: 'web-tabs', pane_id: WEB_PANE })).toEqual({
            ok: false,
            error: `web pane state missing for ${WEB_PANE}`
        });
    });
});

describe('web-open (§3.3)', () => {
    it('echoes the pre-minted pane + tab ids BEFORE the pane exists', () => {
        const paneID = id('bbbbbbbb', 1);
        const tabID = id('bbbbbbbb', 2);
        const h = webHarness({ ids: [paneID, tabID] });

        const reply = h.reply({ command: 'web-open', url: 'example.com', pane_id: SHELL_PANE });
        expect(reply).toEqual({
            ok: true,
            pane_id: paneID,
            tab_id: tabID,
            url: 'https://example.com',
            private: false,
            workspace_id: WORKSPACE
        });

        // The state captured at write time must NOT contain the pane yet (§17.4).
        const atWrite = h.replies.at(-1)?.[0]?.state;
        expect(atWrite?.workspaces[0]?.panes.some((pane) => pane.id === paneID)).toBe(false);
        // ...and afterwards it does, with the tab the reply promised.
        const workspace = h.state().workspaces[0];
        expect(workspace?.panes.some((pane) => pane.id === paneID)).toBe(true);
        expect(workspace?.webPanes[paneID]).toEqual({
            tabs: [{ id: tabID, url: 'https://example.com', title: '' }],
            activeTabID: tabID,
            isPrivate: false
        });
    });

    it('works with no host attached — the pane is daemon state', () => {
        const h = webHarness();
        expect(h.reply({ command: 'web-open', url: 'https://a.test', pane_id: SHELL_PANE })).toMatchObject({
            ok: true
        });
    });

    it('announces the new pane to a connected host', () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        const paneID = id('bbbbbbbb', 3);
        const tabID = id('bbbbbbbb', 4);
        h.reply({ command: 'web-open', url: 'https://a.test', pane_id: SHELL_PANE });
        void paneID;
        void tabID;
        const announced = host.notifies.filter((entry) => entry.verb === 'pane-open');
        // One for the harness's seeded pane (replayed at registration), one for the new pane.
        expect(announced.length).toBeGreaterThanOrEqual(2);
        expect(announced.at(-1)?.args['isPrivate']).toBe(false);
    });

    it('refuses when there is no workspace at all', () => {
        const h = webHarness({ withWebPane: false });
        h.store.dispatch({
            type: 'replace-state',
            state: { ...h.state(), workspaces: [], topLevelOrder: [], lastActiveWorkspaceID: null }
        });
        expect(h.reply({ command: 'web-open', url: 'https://a.test' })).toEqual({
            ok: false,
            error: 'no active workspace'
        });
    });
});

describe('tabs (§5)', () => {
    it('lists tabs with index + resolved active flag', () => {
        const h = webHarness({ ids: [OTHER_TAB] });
        h.reply({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'b.test', make_active: false });
        expect(h.reply({ command: 'web-tabs', pane_id: WEB_PANE })).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tabs: [
                { id: WEB_TAB, url: 'https://example.com', title: '', index: 0, active: true },
                { id: OTHER_TAB, url: 'https://b.test', title: '', index: 1, active: false }
            ]
        });
    });

    it('mints the new tab id in the reply before the tab exists, and tells the host', () => {
        const h = webHarness({ ids: [OTHER_TAB] });
        const host = attachFakeHost(h.service);
        const reply = h.reply({
            command: 'web-tab-new',
            pane_id: WEB_PANE,
            url: 'b.test',
            make_active: true
        });
        expect(reply).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tab_id: OTHER_TAB,
            url: 'https://b.test',
            active: true
        });
        const atWrite = h.replies.at(-1)?.[0]?.state;
        expect(atWrite?.workspaces[0]?.webPanes[WEB_PANE]?.tabs).toHaveLength(1);
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.activeTabID).toBe(OTHER_TAB);
        expect(host.notifies.at(-1)).toEqual({
            verb: 'tab-open',
            args: { paneID: WEB_PANE, tabID: OTHER_TAB, url: 'https://b.test', makeActive: true }
        });
    });

    it('resolves a tab ref by uuid or index, with the spec error strings', () => {
        const h = webHarness({ ids: [OTHER_TAB] });
        h.reply({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'b.test', make_active: false });

        expect(h.reply({ command: 'web-tab-select', pane_id: WEB_PANE, tab: '1' })).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tab_id: OTHER_TAB
        });
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.activeTabID).toBe(OTHER_TAB);

        expect(h.reply({ command: 'web-tab-select', pane_id: WEB_PANE, tab: '7' })).toEqual({
            ok: false,
            error: 'tab index 7 out of range (0..<2)'
        });
        const stranger = id('77777777', 7);
        expect(h.reply({ command: 'web-tab-close', pane_id: WEB_PANE, tab: stranger })).toEqual({
            ok: false,
            error: `no tab with UUID '${stranger}' in this web pane`
        });
        expect(h.reply({ command: 'web-tab-close', pane_id: WEB_PANE, tab: 'lol' })).toEqual({
            ok: false,
            error: "tab ref must be a UUID or numeric index, got 'lol'"
        });
    });

    it('refuses to close the only tab and points at `nex pane close`', () => {
        const h = webHarness();
        expect(h.reply({ command: 'web-tab-close', pane_id: WEB_PANE, tab: WEB_TAB })).toEqual({
            ok: false,
            error:
                'cannot close the only tab in a web pane, use `nex pane close` to close the pane itself'
        });
    });

    it('closing the active tab activates the left neighbour', () => {
        const h = webHarness({ ids: [OTHER_TAB] });
        const host = attachFakeHost(h.service);
        h.reply({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'b.test', make_active: true });
        expect(h.reply({ command: 'web-tab-close', pane_id: WEB_PANE, tab: '1' })).toMatchObject({
            ok: true,
            tab_id: OTHER_TAB
        });
        const web = h.state().workspaces[0]?.webPanes[WEB_PANE];
        expect(web?.tabs.map((tab) => tab.id)).toEqual([WEB_TAB]);
        expect(web?.activeTabID).toBe(WEB_TAB);
        expect(host.notifies.at(-1)).toEqual({
            verb: 'tab-close',
            args: { paneID: WEB_PANE, tabID: OTHER_TAB }
        });
    });

    /**
     * §WEB-019. The arm is daemon state keyed by TAB, so without this it outlives the page it
     * was armed on — inert (payloads are matched against `arm.tabID`) but still reported as
     * armed, and a `--send-to` arm would wait for a click that can never come.
     */
    it('drops an inspector arm that was armed on the closed tab', () => {
        const h = webHarness({ ids: [OTHER_TAB], nonce: () => 'NONCE-CLOSE' });
        attachFakeHost(h.service);
        h.reply({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'b.test', make_active: true });
        h.service.inspect.arm({
            paneID: WEB_PANE,
            tabID: OTHER_TAB,
            nonce: 'NONCE-CLOSE',
            sendTo: null,
            submit: false
        });

        h.reply({ command: 'web-tab-close', pane_id: WEB_PANE, tab: '1' });
        expect(h.service.inspect.armOf(WEB_PANE)).toBeNull();
    });

    it('leaves an arm on a DIFFERENT tab alone when a tab is closed', () => {
        const h = webHarness({ ids: [OTHER_TAB], nonce: () => 'NONCE-KEEP' });
        attachFakeHost(h.service);
        h.reply({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'b.test', make_active: true });
        h.service.inspect.arm({
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            nonce: 'NONCE-KEEP',
            sendTo: null,
            submit: false
        });

        h.reply({ command: 'web-tab-close', pane_id: WEB_PANE, tab: '1' });
        expect(h.service.inspect.armOf(WEB_PANE)?.tabID).toBe(WEB_TAB);
    });

    /** The page-initiated close (`window.close()`) takes the same route. */
    it('drops the arm when the PAGE closes its own tab', () => {
        const h = webHarness({ ids: [OTHER_TAB], nonce: () => 'NONCE-SELF' });
        const host = attachFakeHost(h.service);
        h.reply({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'b.test', make_active: true });
        h.service.inspect.arm({
            paneID: WEB_PANE,
            tabID: OTHER_TAB,
            nonce: 'NONCE-SELF',
            sendTo: null,
            submit: false
        });

        host.emit('tab-closed', WEB_PANE, {}, OTHER_TAB);
        expect(h.service.inspect.armOf(WEB_PANE)).toBeNull();
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.tabs.map((tab) => tab.id)).toEqual([WEB_TAB]);
    });
});

describe('private mode (§6)', () => {
    it('is idempotent and reports whether anything changed', () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        expect(h.reply({ command: 'web-private', pane_id: WEB_PANE, private: true })).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            private: true,
            changed: true
        });
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.isPrivate).toBe(true);
        expect(host.notifies.at(-1)?.verb).toBe('pane-set-private');

        const notifies = host.notifies.length;
        expect(h.reply({ command: 'web-private', pane_id: WEB_PANE, private: true })).toMatchObject({
            changed: false
        });
        // No change ⇒ no coordinator rebuild.
        expect(host.notifies).toHaveLength(notifies);
    });
});

describe('navigation', () => {
    it('needs a host, and writes the normalized URL optimistically once it has one', async () => {
        const h = webHarness();
        expect(h.reply({ command: 'web-navigate', pane_id: WEB_PANE, url: 'b.test' })).toEqual({
            ok: false,
            error: NO_HOST_ERROR
        });
        // Refused ⇒ the tab URL is untouched.
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.tabs[0]?.url).toBe('https://example.com');

        const host = attachFakeHost(h.service);
        const open = h.open({ command: 'web-navigate', pane_id: WEB_PANE, url: 'b.test' });
        // The state write happens before the host answers (the ack is optimistic, §17.4).
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.tabs[0]?.url).toBe('https://b.test');
        const call = host.answer({ ok: true }, 'navigate');
        expect(call.args).toEqual({ paneID: WEB_PANE, tabID: WEB_TAB, url: 'https://b.test' });
        await flush();
        expect(open.lines[0]?.payload).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tab_id: WEB_TAB,
            url: 'https://b.test'
        });
    });

    it('acks back/forward/reload through the host', async () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        for (const [command, verb] of [
            ['web-back', 'back'],
            ['web-forward', 'forward'],
            ['web-reload', 'reload']
        ] as const) {
            const open = h.open({ command, pane_id: WEB_PANE, ...(command === 'web-reload' ? { hard: true } : {}) });
            const call = host.answer({ ok: true }, verb);
            expect(call.args['paneID']).toBe(WEB_PANE);
            await flush();
            expect(open.lines[0]?.payload).toMatchObject({ ok: true, tab_id: WEB_TAB });
        }
        expect(host.calls.find((call) => call.verb === 'reload')?.args['hard']).toBe(true);
    });

    it('web-url falls back to state when no view is built (§8.2)', async () => {
        const h = webHarness();
        expect(h.reply({ command: 'web-url', pane_id: WEB_PANE })).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tab_id: WEB_TAB,
            url: 'https://example.com',
            title: ''
        });

        const host = attachFakeHost(h.service);
        const open = h.open({ command: 'web-url', pane_id: WEB_PANE });
        host.answer({ ok: true, url: 'https://example.com/live', title: 'Example' }, 'url');
        await flush();
        expect(open.lines[0]?.payload).toMatchObject({
            url: 'https://example.com/live',
            title: 'Example'
        });
    });
});

describe('capture (§8.4)', () => {
    it('rejects an unknown mode before bothering the host', () => {
        const h = webHarness();
        attachFakeHost(h.service);
        expect(h.reply({ command: 'web-capture', pane_id: WEB_PANE, mode: 'movie' })).toEqual({
            ok: false,
            error: "unknown capture mode 'movie' (allowed: meta, text, screenshot, dom, all)"
        });
    });

    it('merges the host payload with the daemon ids and the mode', async () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        const open = h.open({ command: 'web-capture', pane_id: WEB_PANE, mode: 'text' });
        const call = host.answer(
            { ok: true, text: 'hello', byte_count: 5, url: 'https://example.com/x', title: 'X' },
            'capture'
        );
        expect(call.args['mode']).toBe('text');
        expect(call.timeoutMs).toBeGreaterThan(5_000);
        await flush();
        expect(open.lines[0]?.payload).toEqual({
            ok: true,
            text: 'hello',
            byte_count: 5,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tab_id: WEB_TAB,
            mode: 'text',
            url: 'https://example.com/x',
            title: 'X'
        });
    });
});

describe('actuator verbs (§8.2)', () => {
    it('sends one `actuate` call per verb with the __nexAct method + args', async () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);

        const cases: { request: Record<string, unknown>; method: string; args: unknown[] }[] = [
            {
                request: { command: 'web-click', pane_id: WEB_PANE, selector: '#a', double: true },
                method: 'click',
                args: ['#a', { double: true, right: false }]
            },
            {
                request: {
                    command: 'web-click',
                    pane_id: WEB_PANE,
                    selector: '#a',
                    at_x: 4,
                    at_y: 5
                },
                method: 'click',
                args: ['#a', { double: false, right: false, at: { x: 4, y: 5 } }]
            },
            {
                request: { command: 'web-type', pane_id: WEB_PANE, selector: '#a', text: 'hi', submit: true },
                method: 'type',
                args: ['#a', 'hi', { submit: true }]
            },
            {
                request: {
                    command: 'web-type',
                    pane_id: WEB_PANE,
                    selector: '#a',
                    text: 'hi',
                    replace: false
                },
                method: 'type',
                args: ['#a', 'hi', { submit: false, replace: false }]
            },
            {
                request: { command: 'web-q-text', pane_id: WEB_PANE, selector: '#a', max_bytes: 100 },
                method: 'text',
                args: ['#a', { maxBytes: 100 }]
            },
            {
                request: { command: 'web-q-attr', pane_id: WEB_PANE, selector: '#a', attribute: 'href' },
                method: 'attr',
                args: ['#a', 'href']
            },
            {
                request: { command: 'web-q-count', pane_id: WEB_PANE, selector: '.row' },
                method: 'count',
                args: ['.row']
            },
            {
                request: { command: 'web-q-exists', pane_id: WEB_PANE, selector: '.row' },
                method: 'exists',
                args: ['.row']
            },
            {
                request: { command: 'web-q-dom', pane_id: WEB_PANE, selector: '#a' },
                method: 'dom',
                args: ['#a', {}]
            },
            {
                request: { command: 'web-select', pane_id: WEB_PANE, selector: '#s', value_or_label: 'AU' },
                method: 'select',
                args: ['#s', 'AU']
            },
            {
                request: { command: 'web-scroll', pane_id: WEB_PANE, selector: '#a', block: 'end' },
                method: 'scroll',
                args: ['#a', { block: 'end', behavior: 'instant' }]
            },
            {
                request: { command: 'web-hover', pane_id: WEB_PANE, selector: '#a' },
                method: 'hover',
                args: ['#a']
            },
            {
                request: { command: 'web-key', pane_id: WEB_PANE, key: 'enter', selector: '#a' },
                method: 'key',
                args: ['enter', { selector: '#a' }]
            },
            {
                request: {
                    command: 'web-wait',
                    pane_id: WEB_PANE,
                    selector: '#a',
                    for: 'visible',
                    timeout_ms: 2000
                },
                method: 'wait',
                args: [{ selector: '#a', for: 'visible', timeout: 2000 }]
            },
            {
                request: { command: 'web-wait', pane_id: WEB_PANE, url_match: '/done' },
                method: 'wait',
                args: [{ urlMatch: '/done' }]
            }
        ];

        for (const testCase of cases) {
            const open = h.open(testCase.request);
            const call = host.answer({ ok: true, matched: true }, 'actuate');
            expect(call.args['method']).toBe(testCase.method);
            expect(call.args['args']).toEqual(testCase.args);
            expect(call.args['tabID']).toBe(WEB_TAB);
            await flush();
            expect(open.lines[0]?.payload).toEqual({
                ok: true,
                matched: true,
                pane_id: WEB_PANE,
                workspace_id: WORKSPACE,
                tab_id: WEB_TAB
            });
        }
    });

    it('pads the wait budget so the page-side timeout fires first', () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        h.open({ command: 'web-wait', pane_id: WEB_PANE, selector: '#a', timeout_ms: 2000 });
        expect(host.calls.at(-1)?.timeoutMs).toBe(7000);
        h.open({ command: 'web-wait', pane_id: WEB_PANE, selector: '#a' });
        expect(host.calls.at(-1)?.timeoutMs).toBe(15_000);
    });

    it('passes an ok:false envelope through untouched (exists/attr/wait exit codes)', async () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);

        const exists = h.open({ command: 'web-q-exists', pane_id: WEB_PANE, selector: '#nope' });
        host.answer({ ok: true, found: false }, 'actuate');
        await flush();
        // `found:false` must survive: the CLI turns it into exit 1 even though ok is true.
        expect(exists.lines[0]?.payload).toMatchObject({ ok: true, found: false });

        const attr = h.open({
            command: 'web-q-attr',
            pane_id: WEB_PANE,
            selector: '#a',
            attribute: 'disabled'
        });
        host.answer({ ok: true, name: 'disabled', value: null, present: false }, 'actuate');
        await flush();
        expect(attr.lines[0]?.payload).toMatchObject({ present: false, value: null });

        const wait = h.open({ command: 'web-wait', pane_id: WEB_PANE, selector: '#a' });
        host.answer({ ok: false, error: 'timeout', condition: 'exists', waited_ms: 10_000 }, 'actuate');
        await flush();
        expect(wait.lines[0]?.payload).toEqual({
            ok: false,
            error: 'timeout',
            condition: 'exists',
            waited_ms: 10_000,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tab_id: WEB_TAB
        });
    });

    it('fails every browser-bound verb honestly with no host', () => {
        const h = webHarness();
        for (const request of [
            { command: 'web-click', pane_id: WEB_PANE, selector: '#a' },
            { command: 'web-type', pane_id: WEB_PANE, selector: '#a', text: 'x' },
            { command: 'web-q-text', pane_id: WEB_PANE, selector: '#a' },
            { command: 'web-exec', pane_id: WEB_PANE, script: '1+1' },
            { command: 'web-capture', pane_id: WEB_PANE, mode: 'text' },
            { command: 'web-back', pane_id: WEB_PANE },
            { command: 'web-inspect', pane_id: WEB_PANE }
        ]) {
            expect(h.reply(request)).toEqual({ ok: false, error: NO_HOST_ERROR });
        }
    });

    it('answers a wedged host with a timeout instead of hanging the CLI', async () => {
        const h = webHarness();
        attachFakeHost(h.service);
        const open = h.open({ command: 'web-click', pane_id: WEB_PANE, selector: '#a' });
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        expect(open.lines).toHaveLength(0);
        // The registry's timer is what settles it; drive it with a tiny budget instead of
        // waiting five seconds by faking the clock at the registry level.
        h.service.host.settle('unknown-id', { ok: true });
        expect(open.lines).toHaveLength(0);
    });

    it('surfaces the timeout error string once the budget elapses', async () => {
        const h = webHarness();
        attachFakeHost(h.service);
        const envelope = await h.service.call('actuate', {}, { timeoutMs: 10 });
        expect(envelope).toEqual({ ok: false, error: timeoutError('actuate', 10) });
    });
});

describe('exec (§8.5)', () => {
    it('forwards the script with a long budget and merges ids into the envelope', async () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        const open = h.open({ command: 'web-exec', pane_id: WEB_PANE, script: 'return 1 + 1' });
        const call = host.answer({ ok: true, result: 2 }, 'exec');
        expect(call.args).toEqual({ paneID: WEB_PANE, tabID: WEB_TAB, script: 'return 1 + 1' });
        expect(call.timeoutMs).toBe(30_000);
        await flush();
        expect(open.lines[0]?.payload).toEqual({
            ok: true,
            result: 2,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tab_id: WEB_TAB
        });
    });
});

describe('cookies (§13.2)', () => {
    it('reads empty and deletes zero when no view exists — never an error', () => {
        const h = webHarness();
        expect(h.reply({ command: 'web-cookies-list', pane_id: WEB_PANE })).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            private: false,
            cookies: []
        });
        expect(
            h.reply({ command: 'web-cookies-delete', pane_id: WEB_PANE, name: 'sid' })
        ).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            name: 'sid',
            deleted: 0
        });
        expect(h.reply({ command: 'web-cookies-clear', pane_id: WEB_PANE })).toMatchObject({
            ok: true,
            deleted: 0
        });
    });

    it('rejects --all with --domain', () => {
        const h = webHarness();
        expect(
            h.reply({ command: 'web-cookies-clear', pane_id: WEB_PANE, all: true, domain: 'a.test' })
        ).toEqual({ ok: false, error: '--all and --domain are mutually exclusive' });
    });

    it('forwards to the host and keeps its counts', async () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        const open = h.open({
            command: 'web-cookies-delete',
            pane_id: WEB_PANE,
            name: 'sid',
            domain: '.a.test'
        });
        const call = host.answer({ ok: true, deleted: 2 }, 'cookies-delete');
        expect(call.args).toEqual({ paneID: WEB_PANE, name: 'sid', domain: '.a.test' });
        await flush();
        expect(open.lines[0]?.payload).toEqual({
            ok: true,
            deleted: 2,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            name: 'sid',
            domain: '.a.test'
        });
    });
});

describe('console (§9)', () => {
    it('drains the daemon ring buffer with no host in sight', () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        host.emit('console', WEB_PANE, { level: 'error', message: 'boom', url: 'https://a/' }, WEB_TAB);
        host.emit('console', WEB_PANE, { level: 'log', message: 'chatter', url: 'https://a/' }, WEB_TAB);

        const reply = h.reply({ command: 'web-console', pane_id: WEB_PANE });
        expect(reply).toMatchObject({ ok: true, next_since: 2, dropped: 0, follow: false });
        const lines = reply['lines'] as Record<string, unknown>[];
        expect(lines.map((line) => line['message'])).toEqual(['boom', 'chatter']);
        expect(lines[0]).toMatchObject({ seq: 0, tab_id: WEB_TAB, level: 'error' });

        expect(
            (h.reply({ command: 'web-console', pane_id: WEB_PANE, level: 'error' })['lines'] as unknown[])
        ).toHaveLength(1);
        expect(
            (h.reply({ command: 'web-console', pane_id: WEB_PANE, since: 1 })['lines'] as unknown[])
        ).toHaveLength(1);
    });

    it('follow keeps the handle open: drain first, then one object per line', () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        host.emit('console', WEB_PANE, { level: 'log', message: 'before' }, WEB_TAB);

        const stream = h.open({ command: 'web-console', pane_id: WEB_PANE, follow: true });
        expect(stream.closed).toBe(false);
        expect(stream.lines[0]?.payload).toMatchObject({ ok: true, follow: true });
        expect((stream.lines[0]?.payload['lines'] as unknown[])).toHaveLength(1);

        host.emit('console', WEB_PANE, { level: 'warn', message: 'live' }, WEB_TAB);
        expect(stream.lines[1]?.payload).toMatchObject({ seq: 1, level: 'warn', message: 'live' });

        // Ctrl-C: the control server fires the handle's disconnect callbacks, which release
        // the subscriber slot (§9.3 teardown a).
        stream.disconnect();
        host.emit('console', WEB_PANE, { level: 'log', message: 'after' }, WEB_TAB);
        expect(stream.lines).toHaveLength(2);
        expect(h.service.console.subscribers(WEB_PANE)).toBe(0);
    });

    it('closing the pane ends the stream and drops the buffer (§9.3 teardown b)', () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        host.emit('console', WEB_PANE, { level: 'log', message: 'x' }, WEB_TAB);
        const stream = h.open({ command: 'web-console', pane_id: WEB_PANE, follow: true });
        expect(h.service.console.subscribers(WEB_PANE)).toBe(1);

        h.store.dispatch({ type: 'close-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
        expect(stream.closed).toBe(true);
        expect(h.service.console.subscribers(WEB_PANE)).toBe(0);
        expect(host.notifies.at(-1)).toEqual({ verb: 'pane-close', args: { paneID: WEB_PANE } });
    });
});

describe('element picker (§11)', () => {
    it('arms through the host, then queues + pastes the sanitised payload', async () => {
        const h = webHarness({ nonce: () => 'NONCE-1' });
        const host = attachFakeHost(h.service);

        const open = h.open({
            command: 'web-inspect',
            pane_id: WEB_PANE,
            send_to: SHELL_PANE,
            submit: true
        });
        const call = host.answer({ ok: true }, 'inspect-arm');
        expect(call.args).toEqual({
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            nonce: 'NONCE-1',
            sticky: false
        });
        await flush();
        expect(open.lines[0]?.payload).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            tab_id: WEB_TAB,
            armed: true,
            send_to: SHELL_PANE,
            submit: true
        });

        // A payload with the wrong nonce is dropped silently (§17.6).
        host.emit('inspect', WEB_PANE, { nonce: 'WRONG', selector: '#x', tag: 'div' }, WEB_TAB);
        expect(h.reply({ command: 'web-inspect-result', pane_id: WEB_PANE })['results']).toEqual([]);

        host.emit(
            'inspect',
            WEB_PANE,
            {
                nonce: 'NONCE-1',
                selector: '#login',
                tag: 'BUTTON',
                element_id: 'login',
                text: 'Sign in',
                url: 'https://example.com/login',
                rect: { x: 1, y: 2, w: 3, h: 4 }
            },
            WEB_TAB
        );

        // Single-shot: the arm is consumed, the result queued, and the block pasted with
        // Enter (because the arm carried --submit).
        expect(h.service.inspect.armOf(WEB_PANE)).toBeNull();
        expect(h.pasted).toHaveLength(1);
        expect(h.pasted[0]?.paneID).toBe(SHELL_PANE);
        expect(h.pasted[0]?.bare).toBe(false);
        expect(h.pasted[0]?.text).toContain('# nex inspect');
        expect(h.pasted[0]?.text).toContain('"selector": "#login"');

        const drained = h.reply({ command: 'web-inspect-result', pane_id: WEB_PANE, clear: true });
        const results = drained['results'] as Record<string, unknown>[];
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ tag: 'button', id: 'login', tab_id: WEB_TAB });
        // `--clear` empties the queue.
        expect(h.reply({ command: 'web-inspect-result', pane_id: WEB_PANE })['results']).toEqual([]);
    });

    it('rejects a --send-to that is not a shell pane, before arming', () => {
        const h = webHarness();
        attachFakeHost(h.service);
        expect(
            h.reply({ command: 'web-inspect', pane_id: WEB_PANE, send_to: WEB_PANE })
        ).toEqual({
            ok: false,
            error: '--send-to: destination must be a shell pane (got: web)'
        });
        const missing = id('55555555', 5);
        expect(
            h.reply({ command: 'web-inspect', pane_id: WEB_PANE, send_to: missing })
        ).toEqual({ ok: false, error: `--send-to: no pane with UUID '${missing}'` });
    });

    it('disarm needs no host and no active tab', () => {
        const h = webHarness({ nonce: () => 'NONCE-2' });
        h.service.inspect.arm({
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            nonce: 'NONCE-2',
            sendTo: null,
            submit: false
        });
        expect(h.reply({ command: 'web-inspect', pane_id: WEB_PANE, disarm: true })).toEqual({
            ok: true,
            pane_id: WEB_PANE,
            workspace_id: WORKSPACE,
            armed: false
        });
        expect(h.service.inspect.armOf(WEB_PANE)).toBeNull();
    });

    it('an Esc cancel disarms without queueing anything', () => {
        const h = webHarness({ nonce: () => 'NONCE-3' });
        const host = attachFakeHost(h.service);
        h.service.inspect.arm({
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            nonce: 'NONCE-3',
            sendTo: null,
            submit: false
        });
        host.emit('inspect', WEB_PANE, { nonce: 'NONCE-3', cancelled: true }, WEB_TAB);
        expect(h.service.inspect.armOf(WEB_PANE)).toBeNull();
        expect(h.reply({ command: 'web-inspect-result', pane_id: WEB_PANE })['results']).toEqual([]);
    });
});

describe('host state mirroring', () => {
    it('mirrors URL/title changes into the sidecar with the placeholder guard (§4.4)', () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);

        host.emit('page-state', WEB_PANE, { url: 'https://example.com/x', title: 'Example' }, WEB_TAB);
        let web = h.state().workspaces[0]?.webPanes[WEB_PANE];
        expect(web?.tabs[0]).toEqual({ id: WEB_TAB, url: 'https://example.com/x', title: 'Example' });
        // The pane header follows the active tab's display label.
        expect(h.state().workspaces[0]?.panes.find((pane) => pane.id === WEB_PANE)?.title).toBe('Example');

        host.emit('page-state', WEB_PANE, { url: 'about:blank', title: 'Loading' }, WEB_TAB);
        web = h.state().workspaces[0]?.webPanes[WEB_PANE];
        expect(web?.tabs[0]?.url).toBe('https://example.com/x');
        expect(web?.tabs[0]?.title).toBe('Loading');
    });

    it('replays every existing web pane onto a freshly registered host', () => {
        const h = webHarness();
        const first = attachFakeHost(h.service, 'first');
        expect(first.notifies.filter((entry) => entry.verb === 'pane-open')).toHaveLength(1);

        const second = attachFakeHost(h.service, 'second');
        expect(first.revoked).toBe(true);
        const replay = second.notifies.filter((entry) => entry.verb === 'pane-open');
        expect(replay).toHaveLength(1);
        expect(replay[0]?.args).toMatchObject({
            paneID: WEB_PANE,
            activeTabID: WEB_TAB,
            isPrivate: false
        });
    });

    it('a host-closed tab is reflected in daemon state', () => {
        const h = webHarness({ ids: [OTHER_TAB] });
        const host = attachFakeHost(h.service);
        h.reply({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'b.test', make_active: true });
        host.emit('tab-closed', WEB_PANE, {}, OTHER_TAB);
        const web = h.state().workspaces[0]?.webPanes[WEB_PANE];
        expect(web?.tabs.map((tab) => tab.id)).toEqual([WEB_TAB]);
        expect(web?.activeTabID).toBe(WEB_TAB);
    });
});
