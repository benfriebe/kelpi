import { describe, expect, it } from 'vitest';
import { readHttpEndpoint } from './probe.js';

describe('live HTTP endpoint from ping', () => {
    it.each(['127.0.0.1', '0.0.0.0', '::1', '::'])('preserves the bound address %s', host => {
        expect(readHttpEndpoint({ http: { host, port: 43210 } })).toEqual({ host, port: 43210 });
    });

    it.each([undefined, null, [], {}, { host: 'localhost', port: 43210 },
        { host: '127.0.0.1', port: 0 }, { host: '127.0.0.1', port: 65536 },
        { host: '127.0.0.1', port: '43210' }, { host: '::1', port: 1.5 }
    ])('leaves missing or malformed binding %j unknown', http => {
        expect(readHttpEndpoint({ http })).toBeUndefined();
    });
});
