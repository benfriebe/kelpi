import { describe, expect, it } from 'vitest';
import { attachFakeHost, id, NOW, WEB_PANE, WEB_TAB, webHarness, WORKSPACE } from './testing.js';

describe('native browser workspace lifetime', () => {
    for (const type of ['delete-workspace', 'delete-workspaces'] as const) {
        it(`${type} closes the native page and its console stream`, () => {
            const h = webHarness();
            const host = attachFakeHost(h.service);
            host.emit('console', WEB_PANE, { level: 'log', message: 'owned page' }, WEB_TAB);
            const stream = h.open({ command: 'web-console', pane_id: WEB_PANE, follow: true });
            h.store.dispatch(type === 'delete-workspace'
                ? { type, id: WORKSPACE } : { type, ids: [WORKSPACE] });
            expect(host.notifies.filter(item => item.verb === 'pane-close')).toEqual([
                { verb: 'pane-close', args: { paneID: WEB_PANE } }
            ]);
            expect(stream.closed).toBe(true);
            expect(h.service.console.subscribers(WEB_PANE)).toBe(0);
            h.service.close();
        });
    }

    it('moving a page and deleting its old workspace preserves the live native page', () => {
        const h = webHarness();
        const host = attachFakeHost(h.service);
        const destination = id('aaaaaaaa', 2);
        h.store.dispatch({ type: 'create-workspace', id: destination, paneID: id('dddddddd', 2), name: 'destination', now: NOW });
        const stream = h.open({ command: 'web-console', pane_id: WEB_PANE, follow: true });
        h.store.dispatch({ type: 'move-pane-to-workspace', paneID: WEB_PANE, toWorkspaceID: destination });
        h.store.dispatch({ type: 'delete-workspace', id: WORKSPACE });
        expect(host.notifies.filter(item => item.verb === 'pane-close')).toEqual([]);
        expect(stream.closed).toBe(false);
        h.store.dispatch({ type: 'delete-workspace', id: destination });
        expect(host.notifies.filter(item => item.verb === 'pane-close')).toEqual([
            { verb: 'pane-close', args: { paneID: WEB_PANE } }
        ]);
        expect(stream.closed).toBe(true);
        h.service.close();
    });
});
