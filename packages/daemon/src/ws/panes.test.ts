import { describe, expect, it } from 'vitest';

import { harness, seedWorkspace, testID, W1, type Harness } from '../handlers/pane/testing.js';
import { visiblePane, workspaceByID } from '../store/derived.js';
import { createPaneLifecycleChannel, isPaneLifecycleCommand } from './panes.js';

const P0 = testID('D', 100);
const NEW = testID('E', 900);

interface Fixture {
    readonly h: Harness;
    readonly channel: ReturnType<typeof createPaneLifecycleChannel>;
    readonly sleeps: number[];
    settle(): Promise<void>;
}

function fixture(minted: readonly string[] = [NEW]): Fixture {
    const h = harness({ minted });
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P0, path: '/tmp/work' });
    const sleeps: number[] = [];
    let resolveSettle: (() => void) | null = null;
    const channel = createPaneLifecycleChannel({
        ctx: h.ctx,
        sleep: (ms) => {
            sleeps.push(ms);
            return new Promise<void>((resolve) => {
                resolveSettle = resolve;
            });
        }
    });
    return {
        h,
        channel,
        sleeps,
        async settle() {
            resolveSettle?.();
            // Let the `.then` on the settle promise run.
            await Promise.resolve();
            await Promise.resolve();
        }
    };
}

describe('isPaneLifecycleCommand', () => {
    it('names exactly the three verbs', () => {
        expect(isPaneLifecycleCommand('reopen-closed-pane')).toBe(true);
        expect(isPaneLifecycleCommand('create-scratchpad')).toBe(true);
        expect(isPaneLifecycleCommand('reveal-path')).toBe(true);
        expect(isPaneLifecycleCommand('pane-close')).toBe(false);
    });
});

describe('reopen-closed-pane', () => {
    it('needs a known workspace', () => {
        const f = fixture();
        expect(f.channel.run('reopen-closed-pane', {})).toMatchObject({ ok: false });
        expect(f.channel.run('reopen-closed-pane', { workspace_id: 'nope' })).toMatchObject({ ok: false });
    });

    it('refuses when the undo stack is empty', () => {
        const f = fixture();
        const reply = f.channel.run('reopen-closed-pane', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply['error'])).toContain('no recently closed pane');
    });

    /**
     * LAY-017 — the reopen splits the FOCUSED pane, and Swift's guard order means a workspace
     * with nothing focused eats the snapshot rather than restoring it
     * (WorkspaceFeature.swift:1906-1908: `popLast()` runs before the focus guard). The channel
     * reports that honestly instead of acking a pane id that was never created.
     */
    it('LAY-017: with nothing focused it fails, and the snapshot is consumed', () => {
        const f = fixture();
        const SECOND = testID('E', 3);
        f.h.store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: SECOND,
            direction: 'horizontal',
            sourcePaneID: P0,
            label: 'gone',
            now: 1
        });
        f.h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: SECOND });
        f.h.store.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: null });
        const before = f.h.pty.spawns.length;

        const reply = f.channel.run('reopen-closed-pane', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply['error'])).toContain('nothing is focused');
        const workspace = workspaceByID(f.h.state(), W1);
        expect(visiblePane(workspace!, NEW)).toBeNull();
        expect(workspace?.recentlyClosedPanes).toHaveLength(0);
        expect(f.h.pty.spawns).toHaveLength(before);
    });

    it('restores the pane, spawns its PTY and refreshes the sync group', () => {
        const f = fixture();
        const SECOND = testID('E', 1);
        f.h.store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: SECOND,
            direction: 'horizontal',
            sourcePaneID: P0,
            label: 'worker',
            now: 1
        });
        f.h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: SECOND });

        const reply = f.channel.run('reopen-closed-pane', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, pane_id: NEW, workspace_id: W1, type: 'shell', label: 'worker' });
        const workspace = workspaceByID(f.h.state(), W1);
        expect(visiblePane(workspace!, NEW)?.label).toBe('worker');
        expect(f.h.pty.spawns.some((spawn) => spawn.paneID === NEW)).toBe(true);
        expect(f.h.pty.syncGroupCalls.at(-1)?.workspaceID).toBe(W1);
    });

    it('types the snapshot agent resume command after the settle delay', async () => {
        const f = fixture();
        const SECOND = testID('E', 1);
        f.h.store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: SECOND,
            direction: 'horizontal',
            sourcePaneID: P0,
            label: null,
            now: 1
        });
        f.h.store.dispatch({
            type: 'pane-agent-event',
            paneID: SECOND,
            workspaceID: W1,
            now: 1,
            event: { type: 'sessionStarted', sessionID: 'abc-123', agent: 'codex' }
        });
        f.h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: SECOND });

        const reply = f.channel.run('reopen-closed-pane', { workspace_id: W1 });
        expect(reply['resume_command']).toBe('codex resume abc-123');
        expect(f.h.input.texts).toHaveLength(0);
        expect(f.sleeps).toEqual([2000]);
        await f.settle();
        expect(f.h.input.texts).toEqual([{ paneID: NEW, text: 'codex resume abc-123', bare: false }]);
    });

    it('skips a session id that fails the shell-safety allowlist', async () => {
        const f = fixture();
        const SECOND = testID('E', 1);
        f.h.store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: SECOND,
            direction: 'horizontal',
            sourcePaneID: P0,
            label: null,
            now: 1
        });
        f.h.store.dispatch({
            type: 'pane-agent-event',
            paneID: SECOND,
            workspaceID: W1,
            now: 1,
            event: { type: 'sessionStarted', sessionID: 'a; rm -rf /', agent: 'claude' }
        });
        f.h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: SECOND });

        const reply = f.channel.run('reopen-closed-pane', { workspace_id: W1 });
        expect(reply['resume_command']).toBeUndefined();
        expect(f.sleeps).toEqual([]);
        await f.settle();
        expect(f.h.input.texts).toHaveLength(0);
    });

    it('does not type a resume into a pane that was closed again while settling', async () => {
        const f = fixture();
        const SECOND = testID('E', 1);
        f.h.store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: SECOND,
            direction: 'horizontal',
            sourcePaneID: P0,
            label: null,
            now: 1
        });
        f.h.store.dispatch({
            type: 'pane-agent-event',
            paneID: SECOND,
            workspaceID: W1,
            now: 1,
            event: { type: 'sessionStarted', sessionID: 'abc-123', agent: 'claude' }
        });
        f.h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: SECOND });
        f.channel.run('reopen-closed-pane', { workspace_id: W1 });
        f.h.pty.kill(NEW);
        await f.settle();
        expect(f.h.input.texts).toHaveLength(0);
    });

    it('restores a non-shell pane without spawning anything', () => {
        const f = fixture();
        const MD = testID('E', 2);
        f.h.store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: MD,
            filePath: '/tmp/doc.md',
            now: 1
        });
        f.h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: MD });
        const before = f.h.pty.spawns.length;
        const reply = f.channel.run('reopen-closed-pane', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, type: 'markdown' });
        expect(f.h.pty.spawns).toHaveLength(before);
    });
});

describe('create-scratchpad', () => {
    it('needs a known workspace', () => {
        const f = fixture();
        expect(f.channel.run('create-scratchpad', {})).toMatchObject({ ok: false });
    });

    it('creates a focused scratchpad already in edit mode, with no PTY', () => {
        const f = fixture();
        const before = f.h.pty.spawns.length;
        const reply = f.channel.run('create-scratchpad', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, pane_id: NEW, workspace_id: W1 });
        const workspace = workspaceByID(f.h.state(), W1);
        const pane = visiblePane(workspace!, NEW);
        expect(pane?.type).toBe('scratchpad');
        expect(pane?.isEditing).toBe(true);
        expect(pane?.title).toBe('Scratchpad');
        expect(workspace?.focusedPaneID).toBe(NEW);
        expect(f.h.pty.spawns).toHaveLength(before);
    });
});

describe('reveal-path', () => {
    it('needs a path', () => {
        const f = fixture();
        expect(f.channel.run('reveal-path', {})).toMatchObject({ ok: false });
    });

    it('broadcasts the reveal for whichever shell is attached', () => {
        const f = fixture();
        expect(f.channel.run('reveal-path', { path: '/tmp/work', select: true })).toMatchObject({
            ok: true,
            path: '/tmp/work',
            select: true
        });
        expect(f.h.broadcasts.at(-1)).toEqual({ type: 'reveal-path', path: '/tmp/work', select: true });
    });

    it('defaults `select` to false (open the directory, do not reveal a file)', () => {
        const f = fixture();
        f.channel.run('reveal-path', { path: '/tmp/work' });
        expect(f.h.broadcasts.at(-1)).toMatchObject({ select: false });
    });
});
