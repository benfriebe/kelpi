import { describe, expect, it } from 'vitest';

import { NAMED_KEYS } from '@kelpi/protocol';

import { handlePaneCapture, handlePaneSend, handlePaneSendKey } from './index.js';
import { StubTerminalState, W1, W2, harness, seedSplit, seedWorkspace, stubReply, testID } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const P3 = testID('3', 3);
const MD = testID('D', 4);

function seeded() {
    const h = harness();
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    return h;
}

/** Let the capture handler's async read settle. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('pane-send', () => {
    it('acks the resolved pane before the text is delivered', () => {
        const h = seeded();
        const reply = stubReply();
        const deliveredAtReplyTime: number[] = [];
        const originalSend = reply.send.bind(reply);
        reply.send = (payload) => {
            deliveredAtReplyTime.push(h.input.texts.length);
            originalSend(payload);
        };

        handlePaneSend(
            { command: 'pane-send', pane_id: P1, target: 'worker-1', text: 'ls -al', bare: false },
            h.ctx,
            reply
        );

        expect(deliveredAtReplyTime).toEqual([0]); // reply written before the PTY write
        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            bare: false,
            label: 'worker-1'
        });
        expect(h.input.texts).toEqual([{ paneID: P2, text: 'ls -al', bare: false, mirror: false }]);
    });

    it('carries --bare through to the reply and the write', () => {
        const h = seeded();
        const reply = h.run({
            command: 'pane-send',
            target: P2,
            text: 'ls /tm',
            bare: true
        });

        expect(reply.only()).toMatchObject({ bare: true, pane_id: P2 });
        // Never mirrored: a programmatic send targets one pane (terminal-surface.md §8.2, #51).
        expect(h.input.texts).toEqual([{ paneID: P2, text: 'ls /tm', bare: true, mirror: false }]);
    });

    it('never writes when resolution fails', () => {
        const h = seeded();
        const reply = h.run({
            command: 'pane-send',
            pane_id: P1,
            target: 'ghost',
            text: 'x',
            bare: false
        });

        expect(reply.only()).toEqual({
            ok: false,
            error: "no pane with label 'ghost' in workspace 'dev' (use --workspace <name-or-id> to address another workspace)"
        });
        expect(h.input.texts).toEqual([]);
    });

    it('still delivers for a legacy client with no reply handle', () => {
        const h = seeded();
        h.runSilent({ command: 'pane-send', target: P2, text: 'hi', bare: false });
        expect(h.input.texts).toHaveLength(1);
    });

    it('types when if_revision matches and acks the revision it matched', () => {
        const h = seeded();
        h.term.revisions.set(P2, 7);
        const reply = h.run({ command: 'pane-send', target: P2, text: 'y', bare: false, if_revision: 7 });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            bare: false,
            revision: 7,
            label: 'worker-1'
        });
        expect(h.input.texts).toEqual([{ paneID: P2, text: 'y', bare: false, mirror: false }]);
    });

    it('guards revision 0 too: an untouched pane matches it', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-send', target: P2, text: 'y', bare: true, if_revision: 0 });

        expect(reply.only()).toMatchObject({ ok: true, revision: 0 });
        expect(h.input.texts).toHaveLength(1);
    });

    it('refuses a stale if_revision with SCREEN_CHANGED and writes nothing', () => {
        const h = seeded();
        h.term.revisions.set(P2, 8);
        const reply = h.run({ command: 'pane-send', target: P2, text: 'y', bare: false, if_revision: 7 });

        expect(reply.only()).toEqual({ ok: false, error: 'screen changed', code: 'SCREEN_CHANGED', revision: 8 });
        expect(reply.closeCount).toBe(1);
        expect(h.input.texts).toEqual([]);
    });

    it('resolves before the guard: an unknown target fails on resolution, not the revision', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-send', pane_id: P1, target: 'ghost', text: 'y', bare: false, if_revision: 99 });

        expect(reply.only()).toMatchObject({ ok: false, error: expect.stringContaining("no pane with label 'ghost'") });
        expect(reply.only()).not.toHaveProperty('code');
    });

    it('refuses silently for a legacy client with no reply handle', () => {
        const h = seeded();
        h.term.revisions.set(P2, 2);
        h.runSilent({ command: 'pane-send', target: P2, text: 'hi', bare: false, if_revision: 1 });
        expect(h.input.texts).toEqual([]);
    });
});

describe('pane-send-key', () => {
    it('replies with the normalized key and delivers it', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-send-key', target: P2, key: 'ENTER' });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            key: 'enter',
            label: 'worker-1'
        });
        expect(h.input.keys).toEqual([{ paneID: P2, key: 'enter' }]);
    });

    it('validates the key BEFORE resolving, so an unknown key never touches a pane', () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-send-key', target: 'no-such-pane', key: 'F13' });

        expect(reply.only()).toEqual({
            ok: false,
            error: `unknown key 'f13' (valid: ${NAMED_KEYS.join(', ')})`
        });
        expect(h.input.keys).toEqual([]);
    });

    it('delivers a key whose if_revision matches, with the revision in the ack', () => {
        const h = seeded();
        h.term.revisions.set(P2, 3);
        const reply = h.run({ command: 'pane-send-key', target: P2, key: 'enter', if_revision: 3 });

        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            key: 'enter',
            revision: 3,
            label: 'worker-1'
        });
        expect(h.input.keys).toEqual([{ paneID: P2, key: 'enter' }]);
    });

    it('refuses a key whose if_revision is stale and sends nothing', () => {
        const h = seeded();
        h.term.revisions.set(P2, 4);
        const reply = stubReply();
        handlePaneSendKey({ command: 'pane-send-key', target: P2, key: 'enter', if_revision: 3 }, h.ctx, reply);

        expect(reply.only()).toEqual({ ok: false, error: 'screen changed', code: 'SCREEN_CHANGED', revision: 4 });
        expect(h.input.keys).toEqual([]);
    });

    it('still validates the key first: an unknown key with a stale if_revision fails on the key', () => {
        const h = seeded();
        h.term.revisions.set(P2, 4);
        const reply = h.run({ command: 'pane-send-key', target: P2, key: 'F13', if_revision: 3 });

        expect(reply.only()).toEqual({
            ok: false,
            error: `unknown key 'f13' (valid: ${NAMED_KEYS.join(', ')})`
        });
        expect(h.input.keys).toEqual([]);
    });

    it('accepts every key in the §5.6 vocabulary', () => {
        const h = seeded();
        for (const key of NAMED_KEYS) {
            const reply = h.run({ command: 'pane-send-key', target: P2, key });
            expect(reply.only()).toMatchObject({ ok: true, key });
        }
        expect(h.input.keys).toHaveLength(NAMED_KEYS.length);
    });
});

describe('pane-capture', () => {
    it('returns the viewport by default and the whole buffer with --scrollback', async () => {
        const h = seeded();
        h.term.viewport.set(P2, 'visible\n');
        h.term.scrollback.set(P2, 'history\nvisible\n');

        const viewport = h.run({ command: 'pane-capture', target: P2, scrollback: false });
        const full = h.run({ command: 'pane-capture', target: P2, scrollback: true });
        await settle();

        expect(viewport.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            text: 'visible\n',
            revision: 0,
            cursor: { row: 0, col: 0 },
            alt_screen: false,
            label: 'worker-1'
        });
        expect(full.only()).toMatchObject({ text: 'history\nvisible\n' });
    });

    it('tails to --lines keeping empty segments and the trailing newline', async () => {
        const h = seeded();
        h.term.viewport.set(P2, 'a\n\nb\nc\n');

        const reply = h.run({ command: 'pane-capture', target: P2, lines: 3, scrollback: false });
        await settle();

        expect(reply.only()).toMatchObject({ text: '\nb\nc\n' });
    });

    it('rejects a non-positive --lines before resolving anything', async () => {
        const h = seeded();
        const reply = h.run({ command: 'pane-capture', target: 'ghost', lines: 0, scrollback: false });
        await settle();

        expect(reply.only()).toEqual({
            ok: false,
            error: 'lines must be a positive integer (got 0)'
        });
    });

    it('reports the revision, cursor and alternate screen it read', async () => {
        const h = seeded();
        h.term.viewport.set(P2, 'vim\n');
        h.term.revisions.set(P2, 12);
        h.term.cursors.set(P2, { alternate: true, row: 4, col: 9 });

        const reply = h.run({ command: 'pane-capture', target: P2, scrollback: false });
        await settle();

        expect(reply.only()).toMatchObject({ text: 'vim\n', revision: 12, cursor: { row: 4, col: 9 }, alt_screen: true });
        expect(reply.only()).not.toHaveProperty('settled');
        expect(h.term.settles).toEqual([]);
    });

    it('waits for the pane to settle when settle_ms is given and says whether it did', async () => {
        const h = seeded();
        h.term.viewport.set(P2, 'done\n');

        const quiet = h.run({ command: 'pane-capture', target: P2, scrollback: false, settle_ms: 250 });
        await settle();
        h.term.settleResult = false;
        const busy = h.run({ command: 'pane-capture', target: P2, scrollback: false, settle_ms: 60_000 });
        await settle();

        expect(quiet.only()).toMatchObject({ ok: true, text: 'done\n', settled: true });
        expect(busy.only()).toMatchObject({ ok: true, text: 'done\n', settled: false });
        // The cap is the service's to apply: the handler passes the request through.
        expect(h.term.settles).toEqual([
            { paneID: P2, quietMs: 250 },
            { paneID: P2, quietMs: 60_000 }
        ]);
    });

    it('rejects a non-positive settle_ms after --lines and before resolving anything', async () => {
        const h = seeded();
        const zero = h.run({ command: 'pane-capture', target: 'ghost', settle_ms: 0, scrollback: false });
        const negative = h.run({ command: 'pane-capture', target: 'ghost', settle_ms: -5, scrollback: false });
        const both = h.run({ command: 'pane-capture', target: 'ghost', lines: 0, settle_ms: 0, scrollback: false });
        await settle();

        expect(zero.only()).toEqual({ ok: false, error: 'settle_ms must be a positive integer (got 0)' });
        expect(negative.only()).toEqual({ ok: false, error: 'settle_ms must be a positive integer (got -5)' });
        expect(both.only()).toEqual({ ok: false, error: 'lines must be a positive integer (got 0)' });
        expect(h.term.settles).toEqual([]);
    });

    it('reads a seam without the #390 reads as revision 0 on the main screen at 0,0', async () => {
        const h = seeded();
        const term = new StubTerminalState();
        term.viewport.set(P2, 'old\n');
        // An older seam: own `undefined`s shadow the stub's methods.
        Object.assign(term, { revision: undefined, screenCursor: undefined, settle: undefined });
        const reply = stubReply();
        handlePaneCapture({ command: 'pane-capture', target: P2, scrollback: false, settle_ms: 10 }, { ...h.ctx, term }, reply);
        await settle();

        expect(reply.only()).toMatchObject({ text: 'old\n', revision: 0, cursor: { row: 0, col: 0 }, alt_screen: false, settled: true });
    });

    it('rejects a non-terminal pane with its raw type', async () => {
        const h = seeded();
        h.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: MD,
            filePath: '/notes/todo.md',
            now: Date.now()
        });

        const reply = h.run({ command: 'pane-capture', target: MD, scrollback: false });
        await settle();

        expect(reply.only()).toEqual({
            ok: false,
            error: 'pane is not a terminal (type: markdown)'
        });
    });

    it('reports a pane that closed mid-read', async () => {
        const h = seeded();
        h.term.viewport.set(P2, 'stale\n');
        h.term.captureAsync = async (paneID, opts) => {
            h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P2 });
            return h.term.capture(paneID, opts);
        };

        const reply = h.run({ command: 'pane-capture', target: P2, scrollback: false });
        await settle();

        expect(reply.only()).toEqual({ ok: false, error: 'pane closed during capture' });
    });

    it('answers rather than hanging when the emulator read faults', async () => {
        const h = seeded();
        h.term.failCapture = new Error('boom');

        const reply = h.run({ command: 'pane-capture', target: P2, scrollback: false });
        await settle();

        expect(reply.only()).toEqual({ ok: false, error: 'pane capture failed: Error: boom' });
        expect(reply.closeCount).toBe(1);
    });

    it('captures the caller pane when no --target is given', async () => {
        const h = seeded();
        h.term.viewport.set(P1, 'own pane\n');

        const reply = h.run({ command: 'pane-capture', pane_id: P1, scrollback: false });
        await settle();

        expect(reply.only()).toMatchObject({ pane_id: P1, text: 'own pane\n' });
    });

    it('scopes a label to --workspace and reports a cross-workspace miss', async () => {
        const h = seeded();
        seedWorkspace(h, { id: W2, name: 'beta', paneID: P3 });

        const reply = h.run({
            command: 'pane-capture',
            target: 'worker-1',
            workspace: 'beta',
            scrollback: false
        });
        await settle();

        expect(reply.only()).toEqual({
            ok: false,
            error: "no pane with label 'worker-1' in workspace 'beta'"
        });
    });

    it('is a no-op for a legacy client with no reply handle', async () => {
        const h = seeded();
        expect(() =>
            handlePaneCapture({ command: 'pane-capture', target: P2, scrollback: false }, h.ctx, null)
        ).not.toThrow();
        await settle();
    });
});
