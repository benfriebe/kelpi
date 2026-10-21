import { describe, expect, it, vi } from 'vitest';

import type { KelpiRuntime } from '../state';
import { openPhonePane } from './new-pane';

function fakeRuntime(replies: Record<string, unknown> = {}): { runtime: KelpiRuntime; calls: { command: string; input: unknown }[] } {
    const calls: { command: string; input: unknown }[] = [];
    const answer = (command: string) => (input: unknown): Promise<unknown> => {
        calls.push({ command, input });
        return Promise.resolve(replies[command] ?? { ok: true });
    };
    const runtime = {
        commands: {
            createPane: vi.fn(answer('createPane')),
            createScratchpad: vi.fn(answer('createScratchpad')),
            openDiff: vi.fn(answer('openDiff')),
            capturePane: vi.fn(answer('capturePane')),
            sendText: vi.fn(answer('sendText')),
            raw: vi.fn(answer('raw'))
        }
    };
    return { runtime: runtime as unknown as KelpiRuntime, calls };
}

const target = (runtime: KelpiRuntime) => ({ runtime, workspaceID: 'w1', anchorPaneID: 'p1', repoPath: '/home/me/code/kelpi' });
const noSleep = (): Promise<void> => Promise.resolve();

describe('openPhonePane', () => {
    it('opens a terminal in the workspace, focused', async () => {
        const { runtime, calls } = fakeRuntime();
        expect(await openPhonePane(target(runtime), 'terminal', noSleep)).toBeNull();
        expect(calls).toEqual([{ command: 'createPane', input: { workspace: 'w1' } }]);
    });

    it('starts an agent by typing its command, only once the new shell has drawn something', async () => {
        let screen = '';
        const { runtime, calls } = fakeRuntime({ createPane: { ok: true, pane_id: 'p9' } });
        (runtime.commands.capturePane as ReturnType<typeof vi.fn>).mockImplementation((input: unknown) => {
            calls.push({ command: 'capturePane', input });
            const reply = { ok: true, text: screen };
            screen = 'me@studio ~ % ';
            return Promise.resolve(reply);
        });
        expect(await openPhonePane(target(runtime), 'codex', noSleep)).toBeNull();
        expect(calls.map((call) => call.command)).toEqual(['createPane', 'capturePane', 'capturePane', 'sendText']);
        expect(calls.at(-1)?.input).toEqual({ target: 'p9', text: 'codex' });
    });

    it('waits for the phone to attach before its first look at the screen (a capture spawns the shell)', async () => {
        const slept: number[] = [];
        const { runtime, calls } = fakeRuntime({ createPane: { ok: true, pane_id: 'p9' }, capturePane: { ok: true, text: '$ ' } });
        await openPhonePane(target(runtime), 'claude', (ms) => {
            slept.push(ms);
            return Promise.resolve();
        });
        expect(slept[0]).toBeGreaterThanOrEqual(1000);
        expect(calls.map((call) => call.command)).toEqual(['createPane', 'capturePane', 'sendText']);
    });

    it('opens a scratchpad, a blank web page split off the pane on screen, and a diff of its folder', async () => {
        const { runtime, calls } = fakeRuntime();
        await openPhonePane(target(runtime), 'scratchpad', noSleep);
        await openPhonePane(target(runtime), 'web', noSleep);
        await openPhonePane(target(runtime), 'diff', noSleep);
        expect(calls[0]).toEqual({ command: 'createScratchpad', input: { workspaceID: 'w1' } });
        expect(calls[1]?.input).toMatchObject({ command: 'web-open', url: 'about:blank', pane_id: 'p1', target: 'p1', focus: true });
        expect(calls[2]).toEqual({ command: 'openDiff', input: { repoPath: '/home/me/code/kelpi', focus: true } });
    });

    it('opens a web page in an empty workspace with no pane to split off', async () => {
        const { runtime, calls } = fakeRuntime();
        await openPhonePane({ runtime, workspaceID: 'w1', anchorPaneID: null, repoPath: null }, 'web', noSleep);
        expect(calls[0]?.input).not.toHaveProperty('pane_id');
    });

    it('says what went wrong instead of failing silently', async () => {
        const { runtime } = fakeRuntime({ createPane: { ok: false, error: 'workspace not found' } });
        expect(await openPhonePane(target(runtime), 'terminal', noSleep)).toBe('workspace not found');
        const empty = fakeRuntime().runtime;
        expect(await openPhonePane({ runtime: empty, workspaceID: 'w1', anchorPaneID: null, repoPath: null }, 'diff', noSleep)).toBe('This pane has no folder to diff.');
    });
});
