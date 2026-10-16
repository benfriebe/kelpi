import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What `decodeReply` was asked to wait for, per call (#271). */
const calls = vi.hoisted(() => [] as { command: unknown; timeoutSeconds: number | undefined }[]);
vi.mock('../reply.js', async (original) => ({
    ...(await original<object>()),
    decodeReply: (payload: Record<string, unknown>, _command: string, options: { timeoutSeconds?: number } = {}) => {
        calls.push({ command: payload['command'], timeoutSeconds: options.timeoutSeconds });
        return Promise.resolve({ ok: true, started: [], stopped: [], sessions: [] });
    }
}));

import { setEnv } from '../env.js';
import { resetIO, setIO } from '../io.js';
import { GRAFT_REPLY_TIMEOUT_SECONDS, handleGraft } from './graft.js';

describe('kelpi graft reply deadlines', () => {
    beforeEach(() => {
        setIO({ out: () => undefined, err: () => undefined });
    });
    afterEach(() => {
        calls.length = 0;
        setEnv(process.env);
        resetIO();
    });

    it('gives start and stop at least two minutes: both run git in the parent before replying', async () => {
        expect(GRAFT_REPLY_TIMEOUT_SECONDS).toBe(120);
        setEnv({});
        await handleGraft(['start', '--workspace', 'feature']);
        await handleGraft(['stop', '--workspace', 'feature']);
        await handleGraft(['status']);
        expect(calls).toEqual([
            { command: 'graft-start', timeoutSeconds: 120 },
            { command: 'graft-stop', timeoutSeconds: 120 },
            // `status` only reads the engine's map, so it keeps the default.
            { command: 'graft-status', timeoutSeconds: undefined }
        ]);
    });

    it('keeps a longer KELPI_REPLY_TIMEOUT, and never goes below the floor for a shorter one', async () => {
        setEnv({ KELPI_REPLY_TIMEOUT: '300' });
        await handleGraft(['stop', '--workspace', 'feature']);
        setEnv({ KELPI_REPLY_TIMEOUT: '1' });
        await handleGraft(['start', '--workspace', 'feature']);
        expect(calls.map((call) => call.timeoutSeconds)).toEqual([300, 120]);
    });
});
