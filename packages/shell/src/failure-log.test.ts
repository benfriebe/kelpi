import { describe, expect, it } from 'vitest';

import { createFailureLog } from './failure-log.js';

describe('createFailureLog (#312)', () => {
    it('logs the first failure, then every twentieth, and counts them on recovery', () => {
        const lines: string[] = [];
        const failures = createFailureLog('status socket error', (line) => lines.push(line));
        for (let attempt = 0; attempt < 45; attempt += 1) failures.failed('connect ECONNREFUSED 127.0.0.1:53358');
        expect(lines).toEqual([
            'status socket error: connect ECONNREFUSED 127.0.0.1:53358',
            'status socket error: connect ECONNREFUSED 127.0.0.1:53358 (20 failed attempts so far)',
            'status socket error: connect ECONNREFUSED 127.0.0.1:53358 (40 failed attempts so far)'
        ]);
        expect(failures.recovered()).toBe(45);
        expect(failures.recovered()).toBe(0);
        failures.failed('again');
        expect(lines.at(-1)).toBe('status socket error: again');
    });
});
