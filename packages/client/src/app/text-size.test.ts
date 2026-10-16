/**
 * The rules both routes to terminal text size obey (#175), asserted where they live.
 *
 * The reason this is a module with a test rather than an expression inside `App.tsx`: the chord
 * and the View menu row reach the same behaviour by different roads, and only the chord's road
 * has the dispatcher's gates on it. A guard written into the dispatcher alone is one the menu
 * row walks past, which is precisely how the row came to be able to resize the LOCAL daemon's
 * terminals while an embedded remote workspace filled the pane area.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { describe, expect, it, vi } from 'vitest';

import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { steppedSettingsValue } from '../settings/contract';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from '../state';
import {
    createDaemonTextSizeStep,
    createRemoteMenuStep,
    createPaneTextSizeStep,
    createTextSizeStep,
    remoteFocusedPaneID,
    stepRemoteTextSize
} from './text-size';

function harness(options: { remote?: boolean; preview?: boolean; scope?: 'pane' | 'all'; terminal?: boolean; remoteTakes?: boolean } = {}) {
    const previewStep = vi.fn(() => options.preview === true);
    const paneStep = vi.fn(() => options.terminal !== false);
    const daemonStep = vi.fn(() => true);
    const remoteStep = vi.fn(() => options.remoteTakes !== false);
    const step = createTextSizeStep({
        remoteWorkspaceSelected: () => options.remote === true,
        remoteStep,
        previewStep,
        scope: () => options.scope ?? 'all',
        paneStep,
        daemonStep
    });
    return { step, previewStep, paneStep, daemonStep, remoteStep };
}

describe('the terminal text-size step', () => {
    it('steps the daemon-wide size under font-size-scope = all', () => {
        const { step, previewStep, paneStep, daemonStep } = harness();
        expect(step('increase')).toBe(true);
        expect(previewStep).toHaveBeenCalledWith('increase');
        expect(daemonStep).toHaveBeenCalledWith('increase');
        expect(paneStep).not.toHaveBeenCalled();
    });

    it("steps only the focused pane's own size under font-size-scope = pane", () => {
        const { step, paneStep, daemonStep } = harness({ scope: 'pane' });
        expect(step('decrease')).toBe(true);
        expect(paneStep).toHaveBeenCalledWith('decrease');
        expect(daemonStep).not.toHaveBeenCalled();
    });

    // Under `pane`, a focused pane that is not a terminal must not quietly resize every terminal
    // instead: the chord falls through, as any conditional binding does.
    it('falls through under font-size-scope = pane when the focused pane is not a terminal', () => {
        const { step, daemonStep } = harness({ scope: 'pane', terminal: false });
        expect(step('increase')).toBe(false);
        expect(daemonStep).not.toHaveBeenCalled();
    });

    /*
     * §3.16's own chord, kept. A markdown preview has had ⌘= / ⌘- / ⌘0 since long before #175,
     * and the three chords moving to the terminal actions must not have taken it away.
     */
    it('gives a focused markdown preview its own font size first, and stops there', () => {
        for (const scope of ['pane', 'all'] as const) {
            const { step, previewStep, paneStep, daemonStep } = harness({ preview: true, scope });
            expect(step('reset')).toBe(true);
            expect(previewStep).toHaveBeenCalledWith('reset');
            expect(paneStep).not.toHaveBeenCalled();
            expect(daemonStep).not.toHaveBeenCalled();
        }
    });

    /**
     * §1.7, the review's F4 and #267: the View menu row reaches this function WITHOUT passing the
     * window dispatcher, whose `hasActiveWorkspace` gate is what stands the local keymap down
     * while a remote workspace fills the pane area. So the routing is here, where both routes meet.
     *
     * Never a LOCAL surface: this window's settings surface holds the PRIMARY daemon's snapshot,
     * so a local step would write the wrong daemon's config while the person looks at another
     * daemon's pane. The remote workspace's own step takes it instead.
     */
    it('routes every step to the remote workspace while one fills the pane area, and nothing local', () => {
        for (const scope of ['pane', 'all'] as const) {
            const { step, previewStep, paneStep, daemonStep, remoteStep } = harness({ remote: true, scope, preview: true });
            for (const which of ['increase', 'decrease', 'reset'] as const) expect(step(which)).toBe(true);
            expect(remoteStep.mock.calls).toEqual([['increase'], ['decrease'], ['reset']]);
            expect(previewStep).not.toHaveBeenCalled();
            expect(paneStep).not.toHaveBeenCalled();
            expect(daemonStep).not.toHaveBeenCalled();
        }
    });

    it('falls through when the remote workspace declines, still touching nothing local', () => {
        const { step, daemonStep, paneStep } = harness({ remote: true, remoteTakes: false });
        expect(step('increase')).toBe(false);
        expect(daemonStep).not.toHaveBeenCalled();
        expect(paneStep).not.toHaveBeenCalled();
    });

    // A declining daemon step (the row gone, disabled, off screen) falls through rather than
    // consuming the chord, which is §7.2 step 7 and the shape every conditional binding has.
    it('falls through when neither surface takes it', () => {
        const step = createTextSizeStep({
            remoteWorkspaceSelected: () => false,
            remoteStep: () => true,
            previewStep: () => false,
            scope: () => 'all',
            paneStep: () => true,
            daemonStep: () => false
        });
        expect(step('decrease')).toBe(false);
    });
});

describe("a terminal pane's own text size", () => {
    function paneHarness(own: number | null | undefined, fallback = 13) {
        const state = { own, fallback };
        const answers: (() => void)[] = [];
        const send = vi.fn((_paneID: string, size: number | null) => new Promise<void>((resolve) => {
            answers.push(() => {
                state.own = size;
                resolve();
            });
        }));
        const step = createPaneTextSizeStep({ ownSize: () => state.own, defaultSize: () => state.fallback, send });
        const answerAll = async (): Promise<void> => {
            for (const answer of answers.splice(0)) answer();
            await Promise.resolve();
            await Promise.resolve();
        };
        return { step, send, state, answerAll };
    }

    it('starts from the default when the pane has no size of its own', () => {
        const { step, send } = paneHarness(null, 13);
        expect(step('p1', 'increase')).toBe(true);
        expect(send).toHaveBeenCalledWith('p1', 14);
    });

    it("steps from the pane's own size when it has one", () => {
        const { step, send } = paneHarness(20);
        expect(step('p1', 'decrease')).toBe(true);
        expect(send).toHaveBeenCalledWith('p1', 19);
    });

    // Zoomed in and back out, the pane follows the Font size row again rather than pinning it.
    it('stores null, not the number, when a step lands back on the default', () => {
        const { step, send } = paneHarness(14, 13);
        step('p1', 'decrease');
        expect(send).toHaveBeenCalledWith('p1', null);
    });

    it('drops the own size on reset', () => {
        const { step, send } = paneHarness(18);
        step('p1', 'reset');
        expect(send).toHaveBeenCalledWith('p1', null);
    });

    it('consumes a step that changes nothing without sending it', () => {
        for (const [own, which] of [[32, 'increase'], [8, 'decrease'], [null, 'reset']] as const) {
            const { step, send } = paneHarness(own);
            expect(step('p1', which)).toBe(true);
            expect(send).not.toHaveBeenCalled();
        }
    });

    it('declines a pane that is gone or is not a terminal', () => {
        const { step, send } = paneHarness(undefined);
        expect(step('p1', 'increase')).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    /*
     * A held-down ⌘= repeats faster than the daemon answers. Each press has to start from the
     * size last ASKED for, or every repeat re-sends the first step and the pane moves by one.
     */
    it('composes repeats that arrive before the daemon has answered', async () => {
        const { step, send, state, answerAll } = paneHarness(null, 13);
        step('p1', 'increase');
        step('p1', 'increase');
        step('p1', 'increase');
        expect(send.mock.calls.map((call) => call[1])).toEqual([14, 15, 16]);
        await answerAll();
        expect(state.own).toBe(16);
        // Once every ask has settled, the store is the word again.
        state.own = 20;
        step('p1', 'increase');
        expect(send).toHaveBeenLastCalledWith('p1', 21);
    });

    it("keeps each pane's in-flight asks to itself", () => {
        const { step, send } = paneHarness(null, 13);
        step('p1', 'increase');
        step('p2', 'increase');
        expect(send.mock.calls).toEqual([['p1', 14], ['p2', 14]]);
    });

    it('lets go of the in-flight ask when the daemon refuses it', async () => {
        const state = { own: null as number | null };
        let refuse: (error: Error) => void = () => {};
        const send = vi.fn((_paneID: string, _size: number | null) => new Promise<void>((_resolve, reject) => { refuse = reject; }));
        const step = createPaneTextSizeStep({ ownSize: () => state.own, defaultSize: () => 13, send });
        step('p1', 'increase');
        refuse(new Error('pane gone'));
        await Promise.resolve();
        await Promise.resolve();
        step('p1', 'increase');
        expect(send).toHaveBeenLastCalledWith('p1', 14);
    });
});

describe("a daemon's ghostty font-size, stepped from another window (#267)", () => {
    function daemonHarness(stored: number | null) {
        const state = { stored };
        const answers: (() => void)[] = [];
        const send = vi.fn((size: number) => new Promise<void>((resolve) => {
            answers.push(() => {
                state.stored = size;
                resolve();
            });
        }));
        // The Font size row's own stepping: 8-32 on a 1 grid.
        const field = { kind: 'slider', min: 8, max: 32, step: 1 } as Parameters<typeof steppedSettingsValue>[0];
        const step = createDaemonTextSizeStep({
            stored: () => state.stored,
            stepped: (from, steps) => steppedSettingsValue(field, from, steps),
            fallback: () => 13,
            send
        });
        const answerAll = async (): Promise<void> => {
            for (const answer of answers.splice(0)) answer();
            await Promise.resolve();
            await Promise.resolve();
        };
        return { step, send, answerAll };
    }

    it('steps one point from the stored size, or from the row default when none is stored', () => {
        const a = daemonHarness(15);
        expect(a.step('increase')).toBe(true);
        expect(a.send).toHaveBeenLastCalledWith(16);
        const b = daemonHarness(null);
        expect(b.step('decrease')).toBe(true);
        expect(b.send).toHaveBeenLastCalledWith(12);
    });

    it('composes a held chord from the size last asked for, not the stale broadcast', async () => {
        const h = daemonHarness(13);
        h.step('increase');
        h.step('increase');
        h.step('increase');
        expect(h.send.mock.calls.map(([size]) => size)).toEqual([14, 15, 16]);
        await h.answerAll();
        h.step('increase');
        expect(h.send).toHaveBeenLastCalledWith(17);
    });

    it('clamps to 8-32 and resets to 13, sending nothing for a step that changes nothing', () => {
        const top = daemonHarness(32);
        expect(top.step('increase')).toBe(true);
        expect(top.send).not.toHaveBeenCalled();
        const bottom = daemonHarness(8);
        expect(bottom.step('decrease')).toBe(true);
        expect(bottom.send).not.toHaveBeenCalled();
        const reset = daemonHarness(20);
        expect(reset.step('reset')).toBe(true);
        expect(reset.send).toHaveBeenLastCalledWith(13);
        expect(daemonHarness(null).step('reset')).toBe(true);
    });
});

describe('a remote daemon\'s terminal text size (#267)', () => {
    const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
    const SHELL = 'DDDDDDDD-0000-4000-8000-000000000001';
    const NOTE = 'DDDDDDDD-0000-4000-8000-000000000002';

    /** A paired daemon's runtime: one shell and one scratchpad, its settings as given. */
    function remote(settings: { scope?: 'pane' | 'all' | 'absent'; fontSize?: number; loaded?: boolean } = {}) {
        const daemon = createDaemonStore(emptyDaemonState('/Users/studio'));
        daemon.dispatch({ type: 'create-workspace', id: W1, paneID: SHELL, name: 'studio', color: 'blue', now: 1 });
        daemon.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: NOTE, now: 1 });
        const sockets = createFakeSocketFactory();
        const runtime: KelpiRuntime = createKelpiRuntime({
            url: 'ws://studio.test/ws', token: 'tok', socketFactory: sockets.factory, store: createKelpiStore(),
            notifications: null, tokenStorage: null, heartbeatIntervalMs: 0
        });
        runtime.connect();
        completeHandshake(sockets.last(), { state: daemon.getState() as unknown as JsonObject });
        if (settings.loaded !== false) {
            const current = runtime.store.getState().settings.value;
            const general: Record<string, unknown> = { ...current.general };
            if (settings.scope === 'absent') delete general['fontSizeScope'];
            else general['fontSizeScope'] = settings.scope ?? 'pane';
            runtime.store.getState().applySettings({
                ...current,
                general,
                appearance: { ...current.appearance, fontSize: settings.fontSize ?? null }
            });
        }
        const sent = (name: string): Record<string, unknown>[] =>
            sockets.last().messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>)
                .filter((payload) => payload['command'] === name);
        return { runtime, sent };
    }
    const report = vi.fn();

    it("steps the pane's own size on its daemon under that daemon's pane scope, from that daemon's default", () => {
        const h = remote({ scope: 'pane', fontSize: 15 });
        expect(stepRemoteTextSize(h.runtime, SHELL, 'increase', report)).toBe(true);
        expect(h.sent('pane-font-size')).toEqual([{ command: 'pane-font-size', pane_id: SHELL, size: 16 }]);
        expect(h.sent('set-ghostty-setting')).toEqual([]);
        h.runtime.dispose();
    });

    it("writes that daemon's ghostty font-size under its all scope", () => {
        const h = remote({ scope: 'all', fontSize: 15 });
        expect(stepRemoteTextSize(h.runtime, SHELL, 'decrease', report)).toBe(true);
        expect(h.sent('set-ghostty-setting')).toEqual([{ command: 'set-ghostty-setting', key: 'font-size', value: '14' }]);
        expect(h.sent('pane-font-size')).toEqual([]);
        h.runtime.dispose();
    });

    it('reads a daemon that sends no scope as all, through the same hydration', () => {
        const h = remote({ scope: 'absent' });
        expect(h.runtime.store.getState().settings.value.general.fontSizeScope).toBe('all');
        expect(stepRemoteTextSize(h.runtime, SHELL, 'increase', report)).toBe(true);
        expect(h.sent('set-ghostty-setting')).toEqual([{ command: 'set-ghostty-setting', key: 'font-size', value: '14' }]);
        h.runtime.dispose();
    });

    it("steps a hand-written off-grid size exactly as the primary daemon's Font size row does", () => {
        const h = remote({ scope: 'all', fontSize: 13.5 });
        expect(stepRemoteTextSize(h.runtime, SHELL, 'increase', report)).toBe(true);
        expect(h.sent('set-ghostty-setting')).toEqual([{ command: 'set-ghostty-setting', key: 'font-size', value: '15' }]);
        h.runtime.dispose();
    });

    it('reports a refused or a failed write through the reporter of the press that sent it', async () => {
        const h = remote({ scope: 'pane' });
        const refused = vi.spyOn(h.runtime.commands, 'setPaneFontSize').mockResolvedValueOnce({ ok: false, error: 'no such pane' });
        const first = vi.fn();
        const second = vi.fn();
        stepRemoteTextSize(h.runtime, SHELL, 'increase', first);
        // A later press through the other route must not take over where the first one reports.
        refused.mockRejectedValueOnce(new Error('connection lost'));
        stepRemoteTextSize(h.runtime, SHELL, 'increase', second);
        await vi.waitFor(() => expect(second).toHaveBeenCalled());
        expect(first).toHaveBeenCalledExactlyOnceWith('Text size', 'no such pane');
        expect(second).toHaveBeenCalledExactlyOnceWith('Text size', 'connection lost');
        h.runtime.dispose();
    });

    it('declines a pane that is not a terminal under either scope, and before settings arrive', () => {
        for (const scope of ['pane', 'all'] as const) {
            const h = remote({ scope });
            expect(stepRemoteTextSize(h.runtime, NOTE, 'increase', report)).toBe(false);
            expect([...h.sent('pane-font-size'), ...h.sent('set-ghostty-setting')]).toEqual([]);
            h.runtime.dispose();
        }
        const early = remote({ loaded: false });
        expect(stepRemoteTextSize(early.runtime, SHELL, 'increase', report)).toBe(false);
        early.runtime.dispose();
    });

    it('the View menu row steps the focused remote pane on its daemon, and names the daemon in a failure', async () => {
        const h = remote({ scope: 'pane' });
        const toast = vi.fn();
        h.runtime.focusPane(W1, SHELL);
        const step = createRemoteMenuStep({ selection: () => ({ workspaceID: W1 }), remote: () => ({ name: 'Studio', runtime: h.runtime }), report: toast });
        vi.spyOn(h.runtime.commands, 'setPaneFontSize').mockResolvedValueOnce({ ok: false, error: 'refused' });
        expect(step('increase')).toBe(true);
        await vi.waitFor(() => expect(toast).toHaveBeenCalledExactlyOnceWith('Text size', 'Studio: refused'));
        h.runtime.dispose();
    });

    it('the View menu row sends nothing anywhere for a stale selection or a gone daemon', () => {
        const h = remote({ scope: 'pane' });
        const none = createRemoteMenuStep({ selection: () => ({ workspaceID: W1 }), remote: () => null, report: vi.fn() });
        expect(none('increase')).toBe(false);
        const missing = createRemoteMenuStep({ selection: () => ({ workspaceID: 'gone' }), remote: () => ({ name: 'Studio', runtime: h.runtime }), report: vi.fn() });
        expect(missing('increase')).toBe(false);
        const unselected = createRemoteMenuStep({ selection: () => null, remote: () => ({ name: 'Studio', runtime: h.runtime }), report: vi.fn() });
        expect(unselected('increase')).toBe(false);
        expect(h.sent('pane-font-size')).toEqual([]);
        h.runtime.dispose();
    });

    it('finds the pane the focus ring is on: the echo first, else the workspace focus', () => {
        const h = remote();
        const workspaceFocus = h.runtime.store.getState().daemon.state.workspaces[0]?.focusedPaneID ?? null;
        expect(remoteFocusedPaneID(h.runtime, W1)).toBe(workspaceFocus);
        const other = workspaceFocus === SHELL ? NOTE : SHELL;
        h.runtime.focusPane(W1, other);
        expect(remoteFocusedPaneID(h.runtime, W1)).toBe(other);
        expect(remoteFocusedPaneID(h.runtime, 'missing')).toBeNull();
        h.runtime.dispose();
    });
});
