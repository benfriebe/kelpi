/**
 * The shell's half of the daemon's authentication contract.
 *
 * The daemon stopped refusing unauthenticated `/ws` upgrades (a browser cannot see why an
 * upgrade failed, so a 401 became an endless silent reconnect), which moved the token check
 * into the handshake for everyone. The shell authenticates with a bearer header, so it would
 * be exempt — but only if it either sends the token in the hello too, or relies on the
 * exemption. It sends it. These tests pin that, because dropping the field would leave the
 * shell working purely by grace of the exemption and break it the day the exemption narrows.
 */

import { WS_PROTOCOL_VERSION } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import { shellHello } from './hello.js';

describe('shellHello', () => {
    it('carries the token, so the handshake authenticates on its own', () => {
        const hello = shellHello({ token: 'tok', name: 'nex-shell', version: '0.1.0' });
        expect(hello).toEqual({
            type: 'hello',
            protocolVersion: WS_PROTOCOL_VERSION,
            token: 'tok',
            client: { kind: 'electron', name: 'nex-shell', version: '0.1.0' }
        });
    });

    it('claims the web-pane host role when asked, without disturbing the rest', () => {
        const hello = shellHello({
            token: 'tok',
            name: 'nex-webhost',
            version: '0.1.0',
            capabilities: ['web-pane-host']
        });
        expect(hello['token']).toBe('tok');
        expect((hello['client'] as Record<string, unknown>)['capabilities']).toEqual(['web-pane-host']);
    });

    it('omits capabilities entirely when there are none (the status socket)', () => {
        const client = shellHello({ token: 't', name: 'nex-shell', version: '1' })['client'] as Record<string, unknown>;
        expect('capabilities' in client).toBe(false);
    });

    it('round-trips as JSON — it is written straight onto the wire', () => {
        const hello = shellHello({ token: 'tok', name: 'n', version: 'v', capabilities: ['web-pane-host'] });
        expect(JSON.parse(JSON.stringify(hello))).toEqual(hello);
    });
});
