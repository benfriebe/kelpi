import { describe, expect, it } from 'vitest';

import { PUSH_OPEN_MESSAGE, openTargetOf, parsePushPayload, pushOpenHash, pushOpenRecord } from './push-payload';
import { readPushOpenHash, readPushOpenMessage, readPushOpenRecord } from './push';

describe('parsePushPayload', () => {
    it('shows what the daemon sent, tagged per pane, with the routing in data', () => {
        const display = parsePushPayload(
            JSON.stringify({ v: 1, kind: 'agent-waiting', title: 'dev', body: 'Agent is waiting for input', tag: 'kelpi-p1', host: 'phone:7', workspaceID: 'w1', paneID: 'p1' })
        );
        expect(display).toEqual({
            title: 'dev',
            options: {
                body: 'Agent is waiting for input',
                tag: 'kelpi-p1',
                renotify: true,
                icon: '/icon-192.png',
                data: { kind: 'agent-waiting', host: 'phone:7', workspaceID: 'w1', paneID: 'p1' }
            }
        });
    });

    it('always becomes a notification, whatever arrives', () => {
        for (const text of [null, '', 'not json', '[]', '42', JSON.stringify({ title: 7 })]) {
            const display = parsePushPayload(text);
            expect(display.title).toBe('Kelpi');
            expect(display.options.body.length).toBeGreaterThan(0);
            expect(display.options.tag).toBe('kelpi');
        }
        // A pane id with no tag still replaces per pane.
        expect(parsePushPayload(JSON.stringify({ paneID: 'p2' })).options.tag).toBe('kelpi-p2');
    });
});

describe('a tap', () => {
    const target = { host: 'configured:mac mini', workspaceID: 'w/1', paneID: 'p#1' };

    it('needs a host, a workspace and a pane to go anywhere', () => {
        expect(openTargetOf({ kind: 'test', host: 'origin', workspaceID: null, paneID: null })).toBeNull();
        expect(openTargetOf(null)).toBeNull();
        expect(openTargetOf(target)).toEqual(target);
    });

    it('round-trips through the fragment and the message the page reads (the two ends agree)', () => {
        const hash = pushOpenHash(target);
        expect(hash.startsWith('#kelpi-open=')).toBe(true);
        expect(readPushOpenHash(hash)).toEqual(target);
        expect(readPushOpenMessage({ type: PUSH_OPEN_MESSAGE, ...target })).toEqual(target);
        expect(readPushOpenMessage({ type: 'other', ...target })).toBeNull();
        expect(readPushOpenHash('#something-else')).toBeNull();
        expect(readPushOpenHash('#kelpi-open=only/two')).toBeNull();
    });

    it('round-trips through the record the worker writes down, while it is fresh', () => {
        const record = pushOpenRecord(target, 1_000_000);
        expect(readPushOpenRecord(record, 1_000_000 + 59_000)).toEqual(target);
        expect(readPushOpenRecord(record, 1_000_000 + 61_000)).toBeNull();
        expect(readPushOpenRecord('not json', 1_000_000)).toBeNull();
        expect(readPushOpenRecord(JSON.stringify({ host: 'origin', at: 1_000_000 }), 1_000_000)).toBeNull();
    });
});
