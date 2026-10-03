import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What `decodeReply` was asked to wait for, per call (#324: sort and find wait for the whole file). */
const calls = vi.hoisted(() => [] as { payload: Record<string, unknown>; timeoutSeconds: number | undefined }[]);
vi.mock('../reply.js', async (original) => ({
    ...(await original<object>()),
    decodeReply: (payload: Record<string, unknown>, _command: string, options: { timeoutSeconds?: number } = {}) => {
        calls.push({ payload, timeoutSeconds: options.timeoutSeconds });
        return Promise.resolve({ ok: true, result: {} });
    }
}));

import { resetIO, setIO } from '../io.js';
import { DOCUMENT_SLOW_TIMEOUT_SECONDS, DOCUMENT_TIMEOUT_SECONDS, handleDocument } from './document.js';

const PANE = 'DDDDDDDD-0000-4000-8000-0000000000C5';

describe('kelpi document reply deadlines', () => {
    beforeEach(() => {
        setIO({ out: () => undefined, err: () => undefined });
    });
    afterEach(() => {
        calls.length = 0;
        resetIO();
    });

    it.each([
        [['sort', PANE, '--column', '1'], DOCUMENT_SLOW_TIMEOUT_SECONDS],
        [['find', PANE, '--query', 'needle'], DOCUMENT_SLOW_TIMEOUT_SECONDS],
        [['rows', PANE, '--start', '0', '--count', '10'], DOCUMENT_TIMEOUT_SECONDS],
        [['csv-state', PANE], DOCUMENT_TIMEOUT_SECONDS],
        [['header-row', PANE, 'on'], DOCUMENT_TIMEOUT_SECONDS]
    ])('waits for %j as long as the daemon needs to answer it', async (args, seconds) => {
        await handleDocument([...args]);
        expect(calls.map((call) => call.timeoutSeconds)).toEqual([seconds]);
    });

    it('gives sort and find ten minutes, the time a 1 GB file can take', () => {
        expect(DOCUMENT_SLOW_TIMEOUT_SECONDS).toBe(600);
        expect(DOCUMENT_TIMEOUT_SECONDS).toBe(35);
    });
});
