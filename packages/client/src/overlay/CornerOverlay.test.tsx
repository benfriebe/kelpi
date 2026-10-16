/**
 * The shell's corner layer document: it draws the page's frame where the shell says, and hands
 * each click to exactly one collector.
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CORNER_LAYER_VERSION, CORNER_OVERLAY_GLOBAL, type CornerAction, type CornerFrame } from '../chrome/corner-layer';
import { installCornerOverlay } from './CornerOverlay';

interface Overlay {
    readonly version: number;
    render(input: unknown): Promise<boolean>;
    next(): Promise<CornerAction | null>;
}

const target: Record<string, unknown> = {};
const overlay = (): Overlay => target[CORNER_OVERLAY_GLOBAL] as Overlay;
let root: Root;
let container: HTMLDivElement;

function frame(overrides: Partial<CornerFrame> = {}): CornerFrame {
    return {
        version: CORNER_LAYER_VERSION,
        rev: 3,
        attached: true,
        rect: { x: 900, y: 600, w: 300, h: 60 },
        content: { toasts: [{ id: 't1', title: 'Removed worktree', body: '/tmp/repo-wt' }], oldHosts: null },
        vars: { '--kelpi-surface': '#abcdef' },
        theme: 'light',
        devicePixelRatio: 2,
        ...overrides
    };
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    installCornerOverlay(target, root);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    cleanup();
    document.documentElement.style.removeProperty('--kelpi-surface');
    delete document.documentElement.dataset['kelpiTheme'];
});

describe('the corner overlay', () => {
    it('installs its version', () => {
        expect(overlay().version).toBe(CORNER_LAYER_VERSION);
    });

    it('draws the cards at the inset the shell placed it with, at the page measured width', async () => {
        await act(async () => {
            await overlay().render({ frame: frame(), inset: { right: 12, bottom: 12 } });
        });
        const stack = screen.getByTestId('corner-layer-stack');
        expect(stack.style.right).toBe('12px');
        expect(stack.style.bottom).toBe('12px');
        expect(stack.style.width).toBe('300px');
        expect(screen.getByTestId('toast-t1').textContent).toContain('Removed worktree');
        expect(document.documentElement.style.getPropertyValue('--kelpi-surface')).toBe('#abcdef');
        expect(document.documentElement.dataset['kelpiTheme']).toBe('light');
    });

    it('draws nothing for an empty frame or for null', async () => {
        await act(async () => {
            await overlay().render({ frame: frame(), inset: { right: 12, bottom: 12 } });
        });
        await act(async () => {
            await overlay().render({ frame: frame({ content: null, rect: null }), inset: { right: 0, bottom: 0 } });
        });
        expect(screen.queryByTestId('corner-layer-stack')).toBeNull();
        await act(async () => {
            await overlay().render({ frame: frame(), inset: { right: 12, bottom: 12 } });
        });
        await act(async () => {
            await overlay().render(null);
        });
        expect(screen.queryByTestId('corner-layer-stack')).toBeNull();
    });

    it('queues a click until it is collected, and hands it over once', async () => {
        await act(async () => {
            await overlay().render({ frame: frame(), inset: { right: 12, bottom: 12 } });
        });
        fireEvent.click(screen.getByTestId('toast-t1'));
        await expect(overlay().next()).resolves.toEqual({ kind: 'dismiss', id: 't1' });
        let pending: CornerAction | null | undefined;
        void overlay().next().then((action) => {
            pending = action;
        });
        await Promise.resolve();
        expect(pending).toBeUndefined();
        fireEvent.click(screen.getByTestId('toast-t1'));
        await Promise.resolve();
        expect(pending).toEqual({ kind: 'dismiss', id: 't1' });
    });

    it('a new collector releases the old one with null, so a click is never handed to a stale loop', async () => {
        await act(async () => {
            await overlay().render({ frame: frame(), inset: { right: 12, bottom: 12 } });
        });
        const stale = overlay().next();
        const fresh = overlay().next();
        await expect(stale).resolves.toBeNull();
        fireEvent.click(screen.getByTestId('toast-t1'));
        await expect(fresh).resolves.toEqual({ kind: 'dismiss', id: 't1' });
    });

    it('relays the old terminal host card buttons', async () => {
        const hosts = [{ pid: 7, protocol: 1, version: '0.2.0', reason: '', startedAt: null, paneIDs: ['p'], agents: 0, busyAgents: 0 }];
        await act(async () => {
            await overlay().render({
                frame: frame({ content: { toasts: [], oldHosts: { hosts, restarting: false } } }),
                inset: { right: 12, bottom: 12 }
            });
        });
        fireEvent.click(screen.getByTestId('old-terminal-host-restart'));
        fireEvent.click(screen.getByTestId('old-terminal-host-later'));
        await expect(overlay().next()).resolves.toEqual({ kind: 'restart-old-hosts' });
        await expect(overlay().next()).resolves.toEqual({ kind: 'later-old-hosts' });
    });
});
