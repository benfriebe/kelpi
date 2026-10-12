import { describe, expect, it, vi } from 'vitest';
import { type JsonObject } from '@kelpi/protocol';
import { createKelpiAPI, KelpiError } from '../index.js';

// #390: the SDK half of capture revisions, against a stubbed daemon reply.
const placement = { pane_id: 'P1', workspace_id: 'W1', workspace_name: 'Main' };

function stub(reply: (payload: JsonObject) => unknown) {
    const sent: JsonObject[] = [];
    const transport = vi.fn(async (method: string, args: { payload?: JsonObject } = {}) => {
        if (method !== 'command' || !args.payload) throw new Error(`unsupported test transport method ${method}`);
        sent.push(args.payload);
        return reply(args.payload);
    });
    return { api: createKelpiAPI(transport), sent };
}

describe('terminal.read and ifRevision', () => {
    it('reads text, revision, cursor and alt screen, with settled only when the daemon sends it', async () => {
        const { api, sent } = stub(payload => ({
            ok: true, ...placement, text: 'prompt> ', revision: 4, cursor: { row: 1, col: 8 }, alt_screen: true,
            ...(payload['settle_ms'] === undefined ? {} : { settled: false }),
        }));
        expect(await api.terminal.read('P1')).toStrictEqual({ text: 'prompt> ', revision: 4, cursor: { row: 1, col: 8 }, altScreen: true });
        expect(sent.at(-1)).toStrictEqual({ command: 'pane-capture', target: 'P1', scrollback: false });
        expect(await api.terminal.read({ paneID: 'P1', workspaceID: 'W1' }, { settleMs: 300, lines: 5, scrollback: true }))
            .toStrictEqual({ text: 'prompt> ', revision: 4, cursor: { row: 1, col: 8 }, altScreen: true, settled: false });
        expect(sent.at(-1)).toStrictEqual({ command: 'pane-capture', target: 'P1', workspace: 'W1', lines: 5, scrollback: true, settle_ms: 300 });
    });
    it('keeps capture a plain string with an unchanged payload', async () => {
        const { api, sent } = stub(() => ({ ok: true, ...placement, text: 'visible', revision: 2, cursor: { row: 0, col: 7 }, alt_screen: false }));
        expect(await api.terminal.capture('P1', { lines: 1 })).toBe('visible');
        expect(sent).toStrictEqual([{ command: 'pane-capture', target: 'P1', lines: 1, scrollback: false }]);
    });
    it('refuses read against a daemon that reports no revision, cursor or alt screen, and keeps capture', async () => {
        const old = { ok: true, text: 'x' };
        const { api } = stub(() => old);
        const failure = await api.terminal.read('P1').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(KelpiError);
        expect(failure).toMatchObject({ code: 'UNSUPPORTED', message: 'terminal.read needs a Kelpi daemon that reports screen revisions (#390)', method: 'pane-capture', details: old });
        expect(await api.terminal.capture('P1')).toBe('x');
        for (const partial of [
            { revision: 1, alt_screen: false },
            { revision: 1, cursor: { row: 0 }, alt_screen: false },
            { revision: 1, cursor: { row: 0, col: 0 } },
            { revision: '1', cursor: { row: 0, col: 0 }, alt_screen: false },
        ]) {
            const { api: partialAPI } = stub(() => ({ ok: true, text: 'x', ...partial }));
            await expect(partialAPI.terminal.read('P1')).rejects.toMatchObject({ code: 'UNSUPPORTED', method: 'pane-capture' });
        }
    });
    it('sends if_revision on send and sendKey only when ifRevision is given', async () => {
        const { api, sent } = stub(payload => ({
            ok: true, ...placement, ...(payload['command'] === 'pane-send' ? { bare: payload['bare'] } : { key: payload['key'] }),
            ...(payload['if_revision'] === undefined ? {} : { revision: payload['if_revision'] }),
        }));
        expect(await api.terminal.send('P1', 'ls')).not.toHaveProperty('revision');
        await api.terminal.sendKey('P1', 'enter');
        expect(sent.splice(0)).toStrictEqual([
            { command: 'pane-send', target: 'P1', text: 'ls', bare: false },
            { command: 'pane-send-key', target: 'P1', key: 'enter' },
        ]);
        // Revision 0 is a real revision (a fresh pane), not an absent guard.
        expect(await api.terminal.send('P1', 'y', { bare: true, ifRevision: 0 })).toMatchObject({ paneID: 'P1', bare: true, revision: 0 });
        expect(await api.terminal.sendKey('P1', 'enter', { ifRevision: 7 })).toMatchObject({ key: 'enter', revision: 7 });
        expect(sent).toStrictEqual([
            { command: 'pane-send', target: 'P1', text: 'y', bare: true, if_revision: 0 },
            { command: 'pane-send-key', target: 'P1', key: 'enter', if_revision: 7 },
        ]);
    });
    it('rejects a refused guarded send with the daemon code and current revision', async () => {
        const refusal = { ok: false, error: 'screen changed', code: 'SCREEN_CHANGED', revision: 9 };
        const { api } = stub(() => refusal);
        const failure = await api.terminal.send('P1', 'y', { ifRevision: 4 }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(KelpiError);
        expect(failure).toMatchObject({ code: 'SCREEN_CHANGED', message: 'screen changed', method: 'pane-send', details: refusal });
        expect((failure as KelpiError).details).toHaveProperty('revision', 9);
        await expect(api.terminal.sendKey('P1', 'enter', { ifRevision: 4 })).rejects.toMatchObject({ code: 'SCREEN_CHANGED', method: 'pane-send-key', details: { revision: 9 } });
    });
    it('keeps COMMAND_FAILED for a refusal without a string code', async () => {
        for (const extra of [{}, { code: 12 }, { code: null }]) {
            const { api } = stub(() => ({ ok: false, error: 'pane not found', ...extra }));
            await expect(api.terminal.send('P9', 'y')).rejects.toMatchObject({ code: 'COMMAND_FAILED', message: 'pane not found', method: 'pane-send' });
        }
    });
});
