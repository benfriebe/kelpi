import { describe, expect, it } from 'vitest';

import type { ScreenClearOutcome } from '../../term/clear-screen.js';
import { W1, harness, seedSplit, seedWorkspace, testID, type HarnessOptions } from './testing.js';

const P1 = testID('1', 1);
const P2 = testID('2', 2);
const P3 = testID('3', 3);

function seeded(options: HarnessOptions = {}) {
    const h = harness(options);
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
    seedSplit(h, { workspaceID: W1, sourcePaneID: P1, paneID: P2, label: 'worker-1' });
    return h;
}

/** A clear that records the panes it was asked for and answers `outcome`. */
function recordingClear(outcome: ScreenClearOutcome = { cleared: true }) {
    const asked: string[] = [];
    return {
        asked,
        clearScreen: async (paneID: string): Promise<ScreenClearOutcome> => {
            asked.push(paneID);
            return outcome;
        }
    };
}

/** Let the handler's async clear settle and write its reply. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('pane-clear', () => {
    it('clears the resolved pane and answers once the clear is done', async () => {
        const clear = recordingClear();
        const h = seeded({ clearScreen: clear.clearScreen });
        const reply = h.run({ command: 'pane-clear', pane_id: P1, target: 'worker-1' });
        await settle();

        expect(clear.asked).toEqual([P2]);
        expect(reply.only()).toEqual({
            ok: true,
            pane_id: P2,
            workspace_id: W1,
            workspace_name: 'dev',
            label: 'worker-1',
            cleared: true
        });
        expect(reply.closeCount).toBe(1);
    });

    it('says why nothing was cleared on the alternate screen', async () => {
        const clear = recordingClear({ cleared: false, reason: 'alternate-screen' });
        const h = seeded({ clearScreen: clear.clearScreen });
        const reply = h.run({ command: 'pane-clear', target: P1 });
        await settle();

        expect(reply.only()).toMatchObject({ ok: true, pane_id: P1, cleared: false, reason: 'alternate-screen' });
    });

    it('still clears for a client that reads no reply', async () => {
        const clear = recordingClear();
        const h = seeded({ clearScreen: clear.clearScreen });
        h.runSilent({ command: 'pane-clear', target: P1 });
        await settle();

        expect(clear.asked).toEqual([P1]);
    });

    it('refuses a pane that does not render a terminal, and never asks the clear', async () => {
        const clear = recordingClear();
        const h = seeded({ clearScreen: clear.clearScreen });
        h.store.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: P3, now: Date.now() });

        expect(h.run({ command: 'pane-clear', target: P3 }).only()).toEqual({
            ok: false,
            error: `pane ${P3} is not a terminal pane`
        });
        expect(clear.asked).toEqual([]);
    });

    it('reports an unknown target verbatim', () => {
        const h = seeded({ clearScreen: recordingClear().clearScreen });
        expect(h.run({ command: 'pane-clear', target: P3 }).only()).toEqual({
            ok: false,
            error: `no pane with UUID '${P3}'`
        });
    });

    it('answers a failed clear with an error line rather than leaving the client waiting', async () => {
        const h = seeded({
            clearScreen: async () => {
                throw new Error('emulator gone');
            }
        });
        const reply = h.run({ command: 'pane-clear', target: P1 });
        await settle();

        expect(reply.only()).toEqual({ ok: false, error: 'pane clear failed: Error: emulator gone' });
    });

    it('says so when the daemon has no clear to offer', () => {
        const h = seeded();
        expect(h.run({ command: 'pane-clear', target: P1 }).only()).toEqual({
            ok: false,
            error: 'clearing a pane is not available on this daemon'
        });
    });
});
