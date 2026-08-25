/**
 * N15 — a window reopened from the Dock must be typable.
 *
 * The observed defect: after the window was closed, reopening it from the Dock produced a window
 * that rendered but took no keyboard input at all — keystrokes kept going to the previously
 * focused pane, and no click inside the new window got them back. The recreate paths
 * (`app.on('activate')` with no windows, and `showWindow()` on a destroyed window) each built a
 * window and called a bare `show()`; only the "the window already exists" branch went on to
 * `focus()` and the app-level activation, and NOTHING called `webContents.focus()`.
 *
 * These tests pin the handoff itself — every step, in order, for a window that is built as much
 * as for one that is raised — because the end of the chain (a keystroke landing in the reopened
 * window) is not reachable from a harness: synthesised keys bypass the native focus the defect
 * is about.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    focusWindowContents,
    presentWindow,
    presentWindowLogLine,
    type PresentableWindow
} from './window-present.js';

interface FakeWindow extends PresentableWindow {
    readonly calls: string[];
    destroyed: boolean;
    minimized: boolean;
}

function fakeWindow(options: { destroyed?: boolean; minimized?: boolean; contents?: boolean } = {}): FakeWindow {
    const calls: string[] = [];
    const window: FakeWindow = {
        calls,
        destroyed: options.destroyed === true,
        minimized: options.minimized === true,
        isDestroyed: () => window.destroyed,
        isMinimized: () => window.minimized,
        restore: () => {
            window.minimized = false;
            calls.push('restore');
        },
        show: () => calls.push('show'),
        focus: () => calls.push('focus'),
        ...(options.contents === false
            ? {}
            : {
                  webContents: {
                      isDestroyed: () => false,
                      focus: () => calls.push('contents.focus')
                  }
              })
    };
    return window;
}

describe('presentWindow', () => {
    it('gives a REBUILT window the same focus handoff a raised one gets (the N15 defect)', () => {
        const built = fakeWindow();
        const appFocus = vi.fn();

        const result = presentWindow({
            current: null,
            create: () => built,
            platform: 'darwin',
            appFocus
        });

        expect(result.created).toBe(true);
        // The whole defect in one assertion: the old recreate path stopped after `show`.
        expect(built.calls).toEqual(['show', 'focus', 'contents.focus']);
        expect(appFocus).toHaveBeenCalledTimes(1);
    });

    it('treats a DESTROYED window as no window — the ⌘W-then-Dock path', () => {
        const closed = fakeWindow({ destroyed: true });
        const rebuilt = fakeWindow();

        const result = presentWindow({
            current: closed,
            create: () => rebuilt,
            platform: 'darwin',
            appFocus: () => undefined
        });

        expect(result.window).toBe(rebuilt);
        expect(result.created).toBe(true);
        // Nothing is asked of the corpse.
        expect(closed.calls).toEqual([]);
        expect(rebuilt.calls).toEqual(['show', 'focus', 'contents.focus']);
    });

    it('restores a minimized window before showing it, and focuses it after', () => {
        const window = fakeWindow({ minimized: true });

        const result = presentWindow({
            current: window,
            create: () => {
                throw new Error('must not build a window that already exists');
            },
            platform: 'darwin',
            appFocus: () => undefined
        });

        expect(result.created).toBe(false);
        expect(result.restored).toBe(true);
        expect(window.calls).toEqual(['restore', 'show', 'focus', 'contents.focus']);
    });

    it('reuses a live window rather than building a second one', () => {
        const window = fakeWindow();
        const create = vi.fn(() => fakeWindow());

        const result = presentWindow({ current: window, create, platform: 'darwin' });

        expect(create).not.toHaveBeenCalled();
        expect(result.window).toBe(window);
        expect(result.created).toBe(false);
    });

    it('activates the app only on darwin', () => {
        const appFocus = vi.fn();
        presentWindow({ current: fakeWindow(), create: () => fakeWindow(), platform: 'linux', appFocus });
        expect(appFocus).not.toHaveBeenCalled();

        presentWindow({ current: fakeWindow(), create: () => fakeWindow(), platform: 'darwin', appFocus });
        expect(appFocus).toHaveBeenCalledTimes(1);
    });

    it('survives a window whose contents are already gone', () => {
        const window = fakeWindow({ contents: false });

        const result = presentWindow({ current: window, create: () => window, platform: 'darwin' });

        expect(result.focusedContents).toBe(false);
        expect(window.calls).toEqual(['show', 'focus']);
    });

    it('reports what it did, because nothing else can see it from outside the process', () => {
        const created = presentWindow({ current: null, create: () => fakeWindow(), platform: 'darwin' });
        expect(presentWindowLogLine(created)).toBe('window: presented (created, focused, contents-focused)');

        const raised = presentWindow({
            current: fakeWindow({ minimized: true }),
            create: () => fakeWindow(),
            platform: 'darwin'
        });
        expect(presentWindowLogLine(raised)).toBe(
            'window: presented (raised, restored, focused, contents-focused)'
        );
    });
});

describe('focusWindowContents', () => {
    it('is what `ready-to-show` re-asserts once the widget exists', () => {
        const window = fakeWindow();
        expect(focusWindowContents(window)).toBe(true);
        expect(window.calls).toEqual(['contents.focus']);
    });

    it('declines destroyed contents instead of throwing into Electron', () => {
        const window: PresentableWindow = {
            isDestroyed: () => false,
            isMinimized: () => false,
            restore: () => undefined,
            show: () => undefined,
            focus: () => undefined,
            webContents: {
                isDestroyed: () => true,
                focus: () => {
                    throw new Error('focus on destroyed contents');
                }
            }
        };

        expect(focusWindowContents(window)).toBe(false);
    });
});
