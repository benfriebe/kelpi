/**
 * §TERM-046 — the OSC 52 sink: the gate, the refusal, and what each of them logs.
 *
 * The grammar is covered in `term/osc52.test.ts`. This is the half that decides whether a parsed
 * sequence becomes a broadcast, and the half that has to keep being true after every later
 * change: **default off**, **reads never answered**, **every drop says why**.
 *
 * The gate is read through a callback rather than captured, so "live apply" is testable here
 * rather than only in the audit: the same sink is driven either side of a flip with no
 * re-creation, which is exactly what a Settings toggle does to a running daemon.
 */

import { describe, expect, it } from 'vitest';

import { createStore } from '../../store/index.js';
import { NOW, W1, W2, id, seededState } from '../../store/testing.js';
import { parseOsc52 } from '../../term/index.js';
import { CLIPBOARD_WRITE_SETTING, createClipboardWriteSink } from './clipboard.js';

const PANE_A = id('cccccccc', 100);
const PANE_B = id('cccccccc', 200);

function b64(text: string): string {
    return Buffer.from(text, 'utf8').toString('base64');
}

/** Two workspaces, `W1` active — `PANE_B` lives in the background one. */
function twoWorkspaces(): ReturnType<typeof createStore> {
    const store = createStore(seededState(W1, PANE_A));
    store.dispatch({
        type: 'create-workspace',
        id: W2,
        paneID: PANE_B,
        name: 'background',
        color: 'green',
        now: NOW
    });
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store;
}

interface Harness {
    readonly sink: ReturnType<typeof createClipboardWriteSink>;
    readonly messages: Record<string, unknown>[];
    readonly logs: string[];
    /** The live gate, flipped by assignment — no sink re-creation, like a Settings write. */
    setEnabled(value: boolean): void;
    readonly store: ReturnType<typeof createStore>;
}

function harness(options: { enabled?: boolean } = {}): Harness {
    const store = twoWorkspaces();
    const messages: Record<string, unknown>[] = [];
    const logs: string[] = [];
    let enabled = options.enabled ?? false;
    const sink = createClipboardWriteSink({
        getState: () => store.getState(),
        enabled: () => enabled,
        broadcast: (message) => messages.push(message),
        log: (message) => logs.push(message)
    });
    return {
        sink,
        messages,
        logs,
        setEnabled: (value) => {
            enabled = value;
        },
        store
    };
}

describe('the OSC 52 write gate', () => {
    it('is OFF by default: the text is dropped and the log names the setting', () => {
        const h = harness();
        h.sink(PANE_A, parseOsc52(`c;${b64('secret token')}`));
        expect(h.messages).toEqual([]);
        expect(h.logs).toHaveLength(1);
        expect(h.logs[0]).toContain(CLIPBOARD_WRITE_SETTING);
        expect(h.logs[0]).toContain(PANE_A);
        expect(h.logs[0]).toContain('12 bytes');
        // The whole point of the byte count: the content is never in the log.
        expect(h.logs.join('\n')).not.toContain('secret token');
    });

    it('broadcasts the text once the setting is on, attributed to the pane', () => {
        const h = harness({ enabled: true });
        h.sink(PANE_A, parseOsc52(`c;${b64('copied from the pane')}`));
        expect(h.messages).toEqual([
            {
                type: 'clipboard-write',
                paneID: PANE_A,
                workspaceID: W1,
                text: 'copied from the pane',
                bytes: 20
            }
        ]);
        expect(h.logs[0]).toContain('20 bytes');
        expect(h.logs.join('\n')).not.toContain('copied from the pane');
    });

    /**
     * Live apply, which is the whole reason `enabled` is a callback: the SAME sink, driven
     * either side of a flip. A captured boolean would pass every other test in this file and
     * fail this one, which is the defect worth catching.
     */
    it('applies a flip to the very next sequence, with no re-creation', () => {
        const h = harness();
        h.sink(PANE_A, parseOsc52(`c;${b64('before')}`));
        expect(h.messages).toHaveLength(0);

        h.setEnabled(true);
        h.sink(PANE_A, parseOsc52(`c;${b64('after')}`));
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0]).toMatchObject({ text: 'after' });

        h.setEnabled(false);
        h.sink(PANE_A, parseOsc52(`c;${b64('after off again')}`));
        expect(h.messages).toHaveLength(1);
    });

    it('carries a background workspace’s pane, and names that workspace', () => {
        const h = harness({ enabled: true });
        h.sink(PANE_B, parseOsc52(`c;${b64('from the background')}`));
        expect(h.messages[0]).toMatchObject({ paneID: PANE_B, workspaceID: W2 });
    });

    it('drops a write from a pane no workspace owns', () => {
        const h = harness({ enabled: true });
        h.sink(id('cccccccc', 999), parseOsc52(`c;${b64('nowhere')}`));
        expect(h.messages).toEqual([]);
        expect(h.logs[0]).toContain('unknown pane');
    });

    it('does not touch the store — a clipboard write is not activity in the pane', () => {
        const h = harness({ enabled: true });
        const before = h.store.getState();
        h.sink(PANE_A, parseOsc52(`c;${b64('x')}`));
        expect(h.store.getState()).toBe(before);
    });
});

describe('the OSC 52 read refusal', () => {
    /**
     * The item's security clause. `broadcast` is the ONLY output this sink has — there is no PTY
     * reference, no reply handle, nothing that could carry bytes back to the program that asked —
     * so "nothing was answered" is asserted as "nothing was emitted at all, and the log says
     * refused".
     */
    it('answers nothing, with the setting ON', () => {
        const h = harness({ enabled: true });
        h.sink(PANE_A, parseOsc52('c;?'));
        expect(h.messages).toEqual([]);
        expect(h.logs[0]).toContain('READ refused');
        expect(h.logs[0]).toContain(PANE_A);
    });

    it('answers nothing with the setting off either, and the setting is not what it blames', () => {
        const h = harness({ enabled: false });
        h.sink(PANE_A, parseOsc52(';?'));
        expect(h.messages).toEqual([]);
        expect(h.logs[0]).toContain('READ refused');
        // A read is refused on its own terms; suggesting `clipboard-write = true` would be a lie.
        expect(h.logs[0]).not.toContain(CLIPBOARD_WRITE_SETTING);
    });

    it('reports a read on an unusual selection as a READ, not as an odd selection', () => {
        const h = harness({ enabled: true });
        h.sink(PANE_A, parseOsc52('p;?'));
        expect(h.logs[0]).toContain('READ refused');
        expect(h.logs[0]).toContain("'p'");
    });
});

describe('the sequences that are neither', () => {
    it('logs a reason for each one, and broadcasts none of them', () => {
        const h = harness({ enabled: true });
        h.sink(PANE_A, parseOsc52(`s;${b64('primary selection')}`));
        h.sink(PANE_A, parseOsc52('c;!!!!'));
        h.sink(PANE_A, parseOsc52('c;'));
        h.sink(PANE_A, parseOsc52('nonsense'));
        expect(h.messages).toEqual([]);
        expect(h.logs).toHaveLength(4);
        expect(h.logs[0]).toContain('unsupported selection');
        expect(h.logs[1]).toContain('not base64');
        expect(h.logs[2]).toContain('CLEAR');
        expect(h.logs[3]).toContain('malformed');
    });
});
