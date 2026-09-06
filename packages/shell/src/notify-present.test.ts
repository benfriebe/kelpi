/**
 * The notification seam (#67), and the promise it makes to a user: with the harness channel
 * off, the shell posts exactly the notification it posted before the seam existed.
 *
 * `vitest.config.mts` says a module importing `electron` belongs to `scripts/smoke.mjs`, and
 * that holds for anything needing a real Notification Centre. It does not hold for what this
 * file is about: which OPTIONS object reaches the constructor and which listeners get
 * registered, both decided in the main process from values a fake class can record — the same
 * exemption `status.test.ts` takes for the tray.
 */

import { describe, expect, it, vi } from 'vitest';

/** The recorder the `electron` mock writes into; `vi.hoisted` because the factory runs first. */
const electronMock = vi.hoisted(() => {
    interface Built {
        readonly options: Record<string, unknown>;
        readonly events: string[];
        readonly handlers: Map<string, (...args: unknown[]) => void>;
        shows: number;
        closes: number;
    }
    const built: Built[] = [];
    let supported = true;
    class FakeNotification {
        readonly #entry: Built;
        constructor(options: Record<string, unknown>) {
            this.#entry = { options, events: [], handlers: new Map(), shows: 0, closes: 0 };
            built.push(this.#entry);
        }
        static isSupported(): boolean {
            return supported;
        }
        on(event: string, handler: (...args: unknown[]) => void): this {
            this.#entry.events.push(event);
            this.#entry.handlers.set(event, handler);
            return this;
        }
        show(): void {
            this.#entry.shows += 1;
        }
        close(): void {
            this.#entry.closes += 1;
        }
    }
    return {
        FakeNotification,
        built,
        setSupported: (value: boolean): void => {
            supported = value;
        }
    };
});

vi.mock('electron', () => ({ Notification: electronMock.FakeNotification }));

const { SHIPPED_NOTIFICATION_PRESENTER, notificationsSupported, presentNotification, setNotificationPresenter } =
    await import('./notify-present.js');

function lastBuilt(): (typeof electronMock.built)[number] {
    const entry = electronMock.built[electronMock.built.length - 1];
    if (entry === undefined) throw new Error('nothing was constructed');
    return entry;
}

describe('the shipped presenter builds what the call sites built before the seam', () => {
    it('passes only the keys it was given, so main.ts still constructs { title, body }', () => {
        presentNotification({ title: 'Kelpi CLI is out of date', body: 'Run this in a terminal' }).show();
        const entry = lastBuilt();
        // The whole point: no `silent`, no `actions`, nothing invented. Electron's own defaults
        // decide the rest, exactly as they did when this was a bare `new Notification({...})`.
        expect(Object.keys(entry.options).sort()).toEqual(['body', 'title']);
        // And no listener the caller did not ask for: these notices are not clickable.
        expect(entry.events).toEqual([]);
        expect(entry.shows).toBe(1);
    });

    it('passes the kelpi-agent category through as a mutable array, in order', () => {
        presentNotification({
            title: 'needs you',
            body: 'a question',
            silent: false,
            actions: [
                { type: 'button', text: 'Open' },
                { type: 'button', text: 'Dismiss' }
            ]
        });
        expect(lastBuilt().options).toEqual({
            title: 'needs you',
            body: 'a question',
            silent: false,
            // §AGNT-073: Open first, because macOS shows the first action as the button.
            actions: [
                { type: 'button', text: 'Open' },
                { type: 'button', text: 'Dismiss' }
            ]
        });
        // `paneID` and `key` are the harness's, never Electron's.
        expect(lastBuilt().options).not.toHaveProperty('paneID');
        expect(lastBuilt().options).not.toHaveProperty('key');
    });

    it('registers a listener per handler supplied, and reports the action by index', () => {
        const seen: string[] = [];
        const handle = presentNotification(
            { title: 'needs you', body: 'a question' },
            {
                onClick: () => seen.push('click'),
                onAction: (index) => seen.push(`action:${String(index)}`),
                onClose: () => seen.push('close')
            }
        );
        const entry = lastBuilt();
        expect(entry.events).toEqual(['click', 'action', 'close']);
        entry.handlers.get('click')?.();
        // Electron's `action` event is (event, index); the seam hands on the index alone.
        entry.handlers.get('action')?.(undefined, 1);
        entry.handlers.get('close')?.();
        expect(seen).toEqual(['click', 'action:1', 'close']);
        handle.show();
        handle.close();
        expect([entry.shows, entry.closes]).toEqual([1, 1]);
    });

    it('is what `presentNotification` uses until something swaps it, and puts back', () => {
        const before = electronMock.built.length;
        const recorded: string[] = [];
        // What `harness.ts` does, and the only thing that ever does it.
        const previous = setNotificationPresenter((request) => {
            recorded.push(request.title);
            return { show: () => {}, close: () => {} };
        });
        expect(previous).toBe(SHIPPED_NOTIFICATION_PRESENTER);
        presentNotification({ title: 'recorded', body: '' }).show();
        expect(recorded).toEqual(['recorded']);
        // Nothing reached Electron while the wrapper was in place.
        expect(electronMock.built.length).toBe(before);
        setNotificationPresenter(previous);
        presentNotification({ title: 'real again', body: '' }).show();
        expect(electronMock.built.length).toBe(before + 1);
        expect(lastBuilt().options).toMatchObject({ title: 'real again' });
    });

    it('reports the Electron support gate verbatim: the whole of the shell permission story', () => {
        expect(notificationsSupported()).toBe(true);
        electronMock.setSupported(false);
        expect(notificationsSupported()).toBe(false);
        electronMock.setSupported(true);
    });
});
