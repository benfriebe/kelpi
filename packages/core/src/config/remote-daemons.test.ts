import { describe, expect, it } from 'vitest';

import { parseRemoteDaemons, serializeRemoteDaemonLines } from './remote-daemons.js';
import { writeRemoteDaemons } from './write.js';

describe('remote-daemon lines (§1.7)', () => {
    it('splits at the FIRST colon so URLs keep theirs, later same-name line wins, order is first appearance', () => {
        const parsed = parseRemoteDaemons(
            [
                'remote-daemon = werk:https://werk.taila.ts.net/?token=kd_a',
                'keybind = super+d=split_right',
                'remote-daemon = studio:https://studio.taila.ts.net:8443/?token=kd_b',
                'remote-daemon = werk:https://werk2.taila.ts.net/?token=kd_c',
                'remote-daemon = broken-no-url',
                'remote-daemon = :https://nameless/'
            ].join('\n')
        );
        expect(parsed).toEqual([
            { name: 'werk', url: 'https://werk2.taila.ts.net/?token=kd_c' },
            { name: 'studio', url: 'https://studio.taila.ts.net:8443/?token=kd_b' }
        ]);
    });

    it('round-trips through the writer with unrelated lines preserved byte-for-byte', () => {
        const before = '# mine\nkeybind = super+d=split_right\nremote-daemon = old:https://old/\n';
        const written = writeRemoteDaemons(before, [{ name: 'werk', url: 'https://werk/?token=kd_a' }]);
        expect(written).toContain('# mine');
        expect(written).toContain('keybind = super+d=split_right');
        expect(written).not.toContain('old:');
        expect(parseRemoteDaemons(written)).toEqual([{ name: 'werk', url: 'https://werk/?token=kd_a' }]);
        // Zero daemons into a file holding nothing else = empty file (writeProfiles' rule).
        expect(writeRemoteDaemons('remote-daemon = a:b\n', [])).toBe('');
        expect(serializeRemoteDaemonLines([{ name: 'a', url: 'b' }])).toEqual(['remote-daemon = a:b']);
    });
});
