/**
 * #286 review: the quit gate's update path. `allowQuit` must only OPEN the gate (the teardown waits
 * for `will-quit`, where the quit is final), and `rearm` must close it again when the install did
 * not happen, so a failed restart leaves a fully working app whose next ⌘Q asks as usual.
 *
 * `quit.ts` imports Electron, which cannot load under plain Node, so `app` and `dialog` are stood in
 * for here; everything else (the policy, the prompt routing) is the real code.
 */

import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
    const listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
    return {
        listeners,
        app: {
            on(event: string, listener: (event: { preventDefault(): void }) => void): void {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            },
            removeListener(event: string, listener: (event: { preventDefault(): void }) => void): void {
                listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener));
            },
            quit: vi.fn()
        },
        dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 1, checkboxChecked: false })) }
    };
});

vi.mock('electron', () => ({ app: electron.app, dialog: electron.dialog }));

import { EMPTY_COUNTS, type AgentCounts } from './agents.js';
import { installQuitGate } from './quit.js';

/** Fire `before-quit` and say whether the gate held the quit. */
function beforeQuit(): boolean {
    let prevented = false;
    for (const listener of electron.listeners.get('before-quit') ?? []) {
        listener({
            preventDefault: () => {
                prevented = true;
            }
        });
    }
    return prevented;
}

const ACTIVE: AgentCounts = {
    ...EMPTY_COUNTS,
    running: 1,
    workspaces: [{ workspaceID: 'W1', name: 'dev', running: 1, waiting: 0, muted: false }]
};

describe('the quit gate on the update path (#286 review)', () => {
    beforeEach(() => {
        electron.listeners.clear();
        electron.app.quit.mockClear();
        electron.dialog.showMessageBox.mockClear();
    });

    it('allowQuit only opens the gate: nothing is torn down until the quit is real', () => {
        const onQuit = vi.fn();
        const gate = installQuitGate({
            counts: () => ACTIVE,
            settingsPath: path.join(os.tmpdir(), `kelpi-quit-test-${String(process.pid)}.json`),
            onQuit,
            confirmWhenActive: () => true
        });
        gate.allowQuit();
        expect(onQuit).not.toHaveBeenCalled();
        // The update's own quit goes straight through, with no agents-active question.
        expect(beforeQuit()).toBe(false);
        expect(onQuit).not.toHaveBeenCalled();
        gate.dispose();
    });

    it('rearm closes the gate again, so the next quit is held for the usual confirmation', async () => {
        const gate = installQuitGate({
            counts: () => ACTIVE,
            settingsPath: path.join(os.tmpdir(), `kelpi-quit-test-${String(process.pid)}.json`),
            confirmWhenActive: () => true
        });
        gate.allowQuit();
        gate.rearm();
        expect(beforeQuit()).toBe(true);
        // The agents-active question is asked (Cancel here), and the app does not quit.
        await vi.waitFor(() => {
            expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
        });
        expect(electron.app.quit).not.toHaveBeenCalled();
        gate.dispose();
    });
});
