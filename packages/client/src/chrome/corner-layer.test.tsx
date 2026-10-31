/**
 * The page half of the shell's corner layer, and the toast stack that publishes to it.
 *
 * What has to hold: a stack the shell is drawing parks no web pane and is not painted here, a
 * stack nobody is drawing is painted and parks exactly as before, and a click on the layer does
 * what a click on the page's own card does.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CORNER_LAYER_VERSION,
    CORNER_PAGE_GLOBAL,
    UNTAKEN_FRAME_MS,
    installCornerBridge,
    parseCornerAction,
    publishCorner,
    resetCornerBridgeForTests,
    type CornerFrame
} from './corner-layer';
import { overlayPresenceCount } from './modal-presence';
import { ToastStack } from './ToastStack';

interface Bridge {
    readonly version: number;
    next(after: unknown): Promise<CornerFrame>;
    attach(): boolean;
    detach(): boolean;
    act(action: unknown): boolean;
}

const target: Record<string, unknown> = {};
const bridge = (): Bridge => target[CORNER_PAGE_GLOBAL] as Bridge;

const TOAST = { id: 't1', kind: 'info' as const, title: 'Removed worktree', body: '/tmp/repo-wt', paneID: null, workspaceID: null, createdAt: 0 };
const BOX = { x: 900, y: 600, width: 300, height: 60, left: 900, top: 600, right: 1200, bottom: 660 };

beforeEach(() => {
    resetCornerBridgeForTests(target);
    // jsdom lays nothing out; give every element the stack's box so the publish has a rect.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...BOX, toJSON: () => BOX } as DOMRect);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetCornerBridgeForTests(target);
});

describe('parseCornerAction', () => {
    it('reads the three clicks and refuses anything else', () => {
        expect(parseCornerAction({ kind: 'dismiss', id: 'a' })).toEqual({ kind: 'dismiss', id: 'a' });
        expect(parseCornerAction({ kind: 'restart-old-hosts' })).toEqual({ kind: 'restart-old-hosts' });
        expect(parseCornerAction({ kind: 'later-old-hosts', extra: 1 })).toEqual({ kind: 'later-old-hosts' });
        expect(parseCornerAction({ kind: 'dismiss' })).toBeNull();
        expect(parseCornerAction({ kind: 'dismiss', id: '' })).toBeNull();
        expect(parseCornerAction({ kind: 'navigate', url: 'x' })).toBeNull();
        expect(parseCornerAction('dismiss')).toBeNull();
    });
});

describe('the bridge', () => {
    it('is installed with its version, and publishing before it is installed does nothing', async () => {
        publishCorner(null, { toasts: [], oldHosts: null }, null);
        expect(target[CORNER_PAGE_GLOBAL]).toBeUndefined();
        installCornerBridge(target);
        expect(bridge().version).toBe(CORNER_LAYER_VERSION);
        const frame = await bridge().next(-1);
        expect(frame).toMatchObject({ rev: 0, attached: false, rect: null, content: null });
    });

    it('answers next() at once for a newer frame, and holds it open until one is published', async () => {
        installCornerBridge(target);
        const first = await bridge().next(-1);
        let settled: CornerFrame | null = null;
        void bridge().next(first.rev).then((frame) => {
            settled = frame;
        });
        await Promise.resolve();
        expect(settled).toBeNull();
        publishCorner({ x: 1, y: 2, w: 3, h: 4 }, { toasts: [{ id: 'a', title: 'T', body: 'B' }], oldHosts: null }, null);
        await Promise.resolve();
        expect(settled).toMatchObject({ rev: first.rev + 1, rect: { x: 1, y: 2, w: 3, h: 4 } });
    });

    it('publishes nothing new for an unchanged frame', async () => {
        installCornerBridge(target);
        const content = { toasts: [{ id: 'a', title: 'T', body: 'B' }], oldHosts: null };
        publishCorner({ x: 1, y: 2, w: 3, h: 4 }, content, null);
        const before = (await bridge().next(-1)).rev;
        publishCorner({ x: 1, y: 2, w: 3, h: 4 }, { ...content }, null);
        expect((await bridge().next(-1)).rev).toBe(before);
    });

    it('drops the rect of an empty stack', async () => {
        installCornerBridge(target);
        publishCorner({ x: 1, y: 2, w: 3, h: 4 }, null, null);
        expect(await bridge().next(-1)).toMatchObject({ rect: null, content: null });
    });

    it('echoes attach and detach in the frame', async () => {
        installCornerBridge(target);
        const start = await bridge().next(-1);
        expect(bridge().attach()).toBe(true);
        const attached = await bridge().next(start.rev);
        expect(attached.attached).toBe(true);
        bridge().detach();
        expect((await bridge().next(attached.rev)).attached).toBe(false);
    });

    it('takes drawing back when an attached layer stops taking frames', async () => {
        vi.useFakeTimers();
        installCornerBridge(target);
        bridge().attach();
        // Taken: the shell's loop is alive.
        let latest = await bridge().next(-1);
        publishCorner({ x: 1, y: 2, w: 3, h: 4 }, { toasts: [{ id: 'a', title: 'T', body: 'B' }], oldHosts: null }, null);
        latest = await bridge().next(latest.rev);
        vi.advanceTimersByTime(UNTAKEN_FRAME_MS * 2);
        expect(latest.attached).toBe(true);
        expect((await bridge().next(-1)).attached).toBe(true);

        // Not taken: nobody asks for the next one.
        publishCorner({ x: 1, y: 2, w: 3, h: 5 }, { toasts: [{ id: 'a', title: 'T', body: 'B' }], oldHosts: null }, null);
        vi.advanceTimersByTime(UNTAKEN_FRAME_MS + 1);
        expect((await bridge().next(-1)).attached).toBe(false);
    });

    it('routes a click to the latest handler, and refuses one it cannot read', () => {
        installCornerBridge(target);
        const handler = vi.fn();
        publishCorner(null, { toasts: [], oldHosts: null }, handler);
        expect(bridge().act({ kind: 'dismiss', id: 'a' })).toBe(true);
        expect(bridge().act({ kind: 'bogus' })).toBe(false);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ kind: 'dismiss', id: 'a' });
    });
});

describe('ToastStack', () => {
    const noop = (): void => undefined;

    it('outside a shell window: painted, and it parks the panes it covers', () => {
        render(<ToastStack toasts={[TOAST]} oldHosts={null} onDismiss={noop} onRestartOldHosts={noop} onLaterOldHosts={noop} />);
        const stack = screen.getByTestId('toast-stack');
        expect(stack.dataset['drawnBy']).toBe('page');
        expect(stack.style.opacity).toBe('');
        expect(overlayPresenceCount()).toBe(1);
    });

    it('publishes its cards and box, and once the layer attaches it is not painted and parks nothing', async () => {
        installCornerBridge(target);
        render(<ToastStack toasts={[TOAST]} oldHosts={null} onDismiss={noop} onRestartOldHosts={noop} onLaterOldHosts={noop} />);
        const frame = await bridge().next(-1);
        expect(frame.content).toEqual({ toasts: [{ id: 't1', title: 'Removed worktree', body: '/tmp/repo-wt' }], oldHosts: null });
        expect(frame.rect).toEqual({ x: 900, y: 600, w: 300, h: 60 });
        // Not attached yet: the page still draws and parks, which is the fallback.
        expect(overlayPresenceCount()).toBe(1);

        act(() => {
            bridge().attach();
        });
        const stack = screen.getByTestId('toast-stack');
        expect(stack.dataset['drawnBy']).toBe('shell');
        expect(stack.style.opacity).toBe('0');
        expect(overlayPresenceCount()).toBe(0);

        act(() => {
            bridge().detach();
        });
        expect(screen.getByTestId('toast-stack').dataset['drawnBy']).toBe('page');
        expect(overlayPresenceCount()).toBe(1);
    });

    it('carries the theme the page stamped on :root', async () => {
        installCornerBridge(target);
        document.documentElement.style.setProperty('--kelpi-surface', '#123456');
        document.documentElement.dataset['kelpiTheme'] = 'light';
        try {
            render(<ToastStack toasts={[TOAST]} oldHosts={null} onDismiss={noop} onRestartOldHosts={noop} onLaterOldHosts={noop} />);
            const frame = await bridge().next(-1);
            expect(frame.vars['--kelpi-surface']).toBe('#123456');
            expect(frame.theme).toBe('light');
        } finally {
            document.documentElement.style.removeProperty('--kelpi-surface');
            delete document.documentElement.dataset['kelpiTheme'];
        }
    });

    it('a click on the layer does what a click on its own card does', () => {
        installCornerBridge(target);
        const onDismiss = vi.fn();
        const onRestart = vi.fn();
        const onLater = vi.fn();
        const hosts = [{ pid: 7, protocol: 1, version: '0.2.0', reason: '', startedAt: null, paneIDs: ['p'], agents: 0, busyAgents: 0 }];
        render(
            <ToastStack
                toasts={[TOAST]}
                oldHosts={{ hosts, restarting: false }}
                onDismiss={onDismiss}
                onRestartOldHosts={onRestart}
                onLaterOldHosts={onLater}
            />
        );
        bridge().act({ kind: 'dismiss', id: 't1' });
        bridge().act({ kind: 'restart-old-hosts' });
        bridge().act({ kind: 'later-old-hosts' });
        expect(onDismiss).toHaveBeenCalledWith('t1');
        expect(onRestart).toHaveBeenCalledTimes(1);
        expect(onLater).toHaveBeenCalledTimes(1);

        // And the page's own copy still answers a click (what a CDP click on it reaches).
        fireEvent.click(screen.getByTestId('toast-t1'));
        expect(onDismiss).toHaveBeenCalledTimes(2);
    });

    /*
     * An undelivered agent prompt's toast (`state/agent-launch.ts`): both documents mark the card
     * that copies, but only the mark crosses to the layer. The text stays in the page, which does
     * the copy when the click comes back as `dismiss`.
     */
    it('marks a toast that copies on both documents, without sending its text to the layer', async () => {
        installCornerBridge(target);
        const prompt = { ...TOAST, id: 'agent-launch-p1', title: 'Prompt not delivered', copyText: 'Fix the login timeout' };
        render(<ToastStack toasts={[TOAST, prompt]} oldHosts={null} onDismiss={noop} onRestartOldHosts={noop} onLaterOldHosts={noop} />);
        const frame = await bridge().next(-1);
        expect(frame.content?.toasts).toEqual([
            { id: 't1', title: 'Removed worktree', body: '/tmp/repo-wt' },
            { id: 'agent-launch-p1', title: 'Prompt not delivered', body: '/tmp/repo-wt', copy: true }
        ]);
        expect(JSON.stringify(frame)).not.toContain('Fix the login timeout');
        expect(screen.getByTestId('toast-agent-launch-p1').dataset['copy']).toBe('true');
        expect(screen.getByTestId('toast-t1').dataset['copy']).toBeUndefined();
    });

    it('publishes an empty frame once the last toast goes', async () => {
        installCornerBridge(target);
        const { rerender } = render(
            <ToastStack toasts={[TOAST]} oldHosts={null} onDismiss={noop} onRestartOldHosts={noop} onLaterOldHosts={noop} />
        );
        const shown = await bridge().next(-1);
        expect(shown.content).not.toBeNull();
        rerender(<ToastStack toasts={[]} oldHosts={null} onDismiss={noop} onRestartOldHosts={noop} onLaterOldHosts={noop} />);
        const gone = await bridge().next(shown.rev);
        expect(gone).toMatchObject({ rect: null, content: null });
        expect(screen.queryByTestId('toast-stack')).toBeNull();
    });
});
