/**
 * The URL bar's prefill and suggestion list (#375), driven the way a person drives it.
 *
 * jsdom does no text editing of its own, so each keystroke is spelled out as the `input` event a
 * browser would send: the field's new value plus its `inputType`, which is what decides whether a
 * keystroke earns a prefill (a typed character) or must not get one (a delete, a paste).
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { overlayPresenceCount } from '../chrome/modal-presence';
import type { CommandReply } from '../connection';
import { createWebPaneCommands, type WebPaneCommands } from './commands';
import type { WebHistoryEntry } from './history';
import type { WebFavourite } from './state';
import { WebPane, type WebPaneTab } from './WebPane';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000375';
const TAB = 'EEEEEEEE-0000-4000-8000-000000000375';
const TABS: readonly WebPaneTab[] = [{ id: TAB, url: 'https://example.com/', title: 'Example' }];

const GITHUB: WebHistoryEntry = { url: 'https://github.com/', title: 'GitHub', kind: 'origin' };

interface Recorded {
    readonly verb: string;
    readonly args: readonly unknown[];
}

function fakeCommands(history: (text: string) => CommandReply = (text) => ({ ok: true, text, entries: [] })): {
    commands: WebPaneCommands;
    sent: Recorded[];
    queries: string[];
} {
    const sent: Recorded[] = [];
    const queries: string[] = [];
    const record =
        (verb: string) =>
        (...args: unknown[]): Promise<CommandReply> => {
            sent.push({ verb, args });
            return Promise.resolve({ ok: true });
        };
    return {
        sent,
        queries,
        commands: {
            navigate: record('navigate'),
            focusView: record('focusView'),
            blurView: record('blurView'),
            poster: () => Promise.resolve({ ok: false }),
            historyRemove: record('historyRemove'),
            historyQuery: (text: string) => {
                queries.push(text);
                return Promise.resolve(history(text));
            }
        } as unknown as WebPaneCommands
    };
}

function favourite(id: string, url: string, title: string): WebFavourite {
    return { id, url, title, created_at: '2026-10-11T00:00:00Z', label: title };
}

function mount(
    options: {
        readonly history?: (text: string) => CommandReply;
        readonly typed?: readonly WebHistoryEntry[];
        readonly favourites?: readonly WebFavourite[];
    } = {}
): { input: HTMLInputElement; sent: Recorded[]; queries: string[] } {
    const { commands, sent, queries } = fakeCommands(options.history);
    render(
        <WebPane
            paneID={PANE}
            tabs={TABS}
            activeTabID={TAB}
            commands={commands}
            historyTyped={options.typed ?? [GITHUB]}
            favourites={options.favourites ?? []}
        />
    );
    const input = screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement;
    // A real focus, so `document.activeElement` is the field (the prefill's selection needs it).
    act(() => input.focus());
    return { input, sent, queries };
}

/** One keystroke's worth of `input` event: what the field now holds, and how it got there. */
function type(input: HTMLInputElement, value: string, inputType = 'insertText'): void {
    fireEvent.input(input, { target: { value }, inputType });
}

/** Let the suggestion query's reply land. */
async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

afterEach(() => {
    cleanup();
});

describe('prefill (#375)', () => {
    it('a typed character prefills the site, selected after what was typed', () => {
        const { input } = mount();
        type(input, 'gi');
        expect(input.value).toBe('github.com/');
        expect([input.selectionStart, input.selectionEnd]).toEqual([2, 11]);
    });

    it('Backspace over the prefill removes it, and only it', () => {
        const { input } = mount();
        type(input, 'gi');
        type(input, 'gi', 'deleteContentBackward');
        expect(input.value).toBe('gi');
    });

    it('a paste and an IME composition are never prefilled', () => {
        const { input } = mount();
        type(input, 'gi', 'insertFromPaste');
        expect(input.value).toBe('gi');
        fireEvent.compositionStart(input);
        type(input, 'git', 'insertCompositionText');
        expect(input.value).toBe('git');
    });

    it('a favourite site completes too', () => {
        const { input } = mount({ typed: [], favourites: [favourite('f1', 'https://docs.example.org/guide', 'Guide')] });
        type(input, 'docs');
        expect(input.value).toBe('docs.example.org/');
    });

    it('Return opens the prefilled address, as typed', () => {
        const { input, sent } = mount();
        type(input, 'gi');
        fireEvent.submit(input);
        expect(sent.filter((entry) => entry.verb === 'navigate')).toEqual([
            { verb: 'navigate', args: [PANE, 'github.com/', { typed: true }] }
        ]);
    });

    it('Escape drops the prefill; → makes it the user’s first, so Escape then keeps it', () => {
        let view = mount();
        type(view.input, 'gi');
        fireEvent.keyDown(view.input, { key: 'Escape' });
        expect(view.input.value).toBe('gi');
        cleanup();

        view = mount();
        type(view.input, 'gi');
        fireEvent.keyDown(view.input, { key: 'ArrowRight' });
        fireEvent.keyDown(view.input, { key: 'Escape' });
        expect(view.input.value).toBe('github.com/');
    });

    it('typing through the prefill keeps it, a character at a time', () => {
        const { input } = mount();
        type(input, 'gi');
        type(input, 'git');
        expect(input.value).toBe('github.com/');
        expect([input.selectionStart, input.selectionEnd]).toEqual([3, 11]);
    });

    it('no prefill when the caret is not at the end', () => {
        const { input } = mount();
        // `g` then `i` typed in FRONT of it would read `ig`; here `i` lands after `g` in `g…` with
        // more text behind the caret, which is what a click into the middle then a keystroke does.
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        act(() => {
            setValue?.call(input, 'gi');
            input.setSelectionRange(1, 1);
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        });
        expect(input.value).toBe('gi');
    });

    it('a URL landing mid-type leaves the draft and its prefill alone, then lands on blur', () => {
        const { commands } = fakeCommands();
        const props = { paneID: PANE, activeTabID: TAB, commands, historyTyped: [GITHUB], favourites: [] };
        const { rerender } = render(<WebPane {...props} tabs={TABS} />);
        const input = screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement;
        act(() => input.focus());
        type(input, 'gi');
        rerender(<WebPane {...props} tabs={[{ id: TAB, url: 'https://landed.test/', title: 'Landed' }]} />);
        expect(input.value).toBe('github.com/');
        expect([input.selectionStart, input.selectionEnd]).toEqual([2, 11]);
        act(() => input.blur());
        expect(input.value).toBe('https://landed.test/');
    });

    it('Shift+Delete on the prefill forgets that site, and a favourite\'s site is only dropped', () => {
        let view = mount();
        type(view.input, 'gi');
        fireEvent.keyDown(view.input, { key: 'Delete', shiftKey: true });
        expect(view.input.value).toBe('gi');
        expect(view.sent.filter((entry) => entry.verb === 'historyRemove')).toEqual([
            { verb: 'historyRemove', args: ['https://github.com/', { site: true }] }
        ]);
        cleanup();

        view = mount({ typed: [], favourites: [favourite('f1', 'https://kept.test/page', 'Kept')] });
        type(view.input, 'ke');
        expect(view.input.value).toBe('kept.test/');
        fireEvent.keyDown(view.input, { key: 'Backspace', shiftKey: true });
        expect(view.input.value).toBe('ke');
        expect(view.sent.filter((entry) => entry.verb === 'historyRemove')).toEqual([]);
    });

    it('leaving the field drops the prefill with the edit', () => {
        const { input } = mount();
        type(input, 'gi');
        act(() => input.blur());
        expect(input.value).toBe('https://example.com/');
    });
});

describe('suggestion list (#375)', () => {
    const rows = (text: string): CommandReply => ({
        ok: true,
        text,
        entries: [
            { url: 'https://news.test/a', title: 'Alpha' },
            { url: 'https://news.test/b', title: 'Beta' }
        ]
    });

    it('asks the daemon per keystroke and lists what it answers', async () => {
        const { input, queries } = mount({ history: rows });
        type(input, 'news');
        await settle();
        expect(queries).toEqual(['news']);
        expect(screen.getByTestId(`web-history-row-${PANE}-0`).textContent).toContain('Alpha');
        expect(screen.getByTestId(`web-history-row-${PANE}-1`).textContent).toContain('Beta');
    });

    it('drops an answer for text the field has moved past', async () => {
        const { input } = mount({ history: () => ({ ok: true, text: 'stale', entries: [{ url: 'https://x.test/' }] }) });
        type(input, 'news');
        await settle();
        expect(screen.queryByTestId(`web-history-row-${PANE}-0`)).toBeNull();
    });

    it('↓ highlights a row and Return opens it, as typed', async () => {
        const { input, sent } = mount({ history: rows });
        type(input, 'news');
        await settle();
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(screen.getByTestId(`web-history-row-${PANE}-1`).getAttribute('aria-selected')).toBe('true');
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        fireEvent.submit(input);
        expect(sent.filter((entry) => entry.verb === 'navigate')).toEqual([
            { verb: 'navigate', args: [PANE, 'https://news.test/a', { typed: true }] }
        ]);
    });

    it('a click on a row opens it without taking the caret first', async () => {
        const { input, sent } = mount({ history: rows });
        type(input, 'news');
        await settle();
        const row = screen.getByTestId(`web-history-row-${PANE}-1`);
        // The mousedown's default (focus moving to the row) is prevented, so the field keeps it.
        expect(fireEvent.mouseDown(row, { button: 0 })).toBe(false);
        expect(sent.filter((entry) => entry.verb === 'navigate')).toEqual([
            { verb: 'navigate', args: [PANE, 'https://news.test/b', { typed: true }] }
        ]);
    });

    it('Shift+Backspace removes the highlighted page from history', async () => {
        const { input, sent } = mount({ history: rows });
        type(input, 'news');
        await settle();
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Backspace', shiftKey: true });
        expect(sent.filter((entry) => entry.verb === 'historyRemove')).toEqual([
            { verb: 'historyRemove', args: ['https://news.test/a'] }
        ]);
        expect(screen.getByTestId(`web-history-row-${PANE}-0`).textContent).toContain('Beta');
    });

    it('lists matching favourites first, and Shift+Delete leaves a favourite alone', async () => {
        const { input, sent } = mount({
            history: rows,
            // A page, not the site: the site is what the bar prefills, and that row is dropped.
            favourites: [favourite('f1', 'https://news.example/today', 'Morning news')]
        });
        type(input, 'news');
        await settle();
        const first = screen.getByTestId(`web-history-row-${PANE}-0`);
        expect(first.getAttribute('data-favourite')).toBe('true');
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Delete', shiftKey: true });
        expect(sent.filter((entry) => entry.verb === 'historyRemove')).toEqual([]);
    });

    it('stays registered over the page for the whole typed edit, rows or not', async () => {
        const { input } = mount();
        expect(overlayPresenceCount()).toBe(0);
        type(input, 'zz');
        await settle();
        expect(screen.getByTestId(`web-history-list-${PANE}`).getAttribute('data-empty')).toBe('true');
        expect(overlayPresenceCount()).toBe(1);
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(overlayPresenceCount()).toBe(0);
    });
});

describe('what the chrome tells the daemon (#375)', () => {
    function sender(): { payloads: Record<string, unknown>[]; commands: WebPaneCommands } {
        const payloads: Record<string, unknown>[] = [];
        return {
            payloads,
            commands: createWebPaneCommands({
                raw: (payload) => {
                    payloads.push(payload);
                    return Promise.resolve({ ok: true });
                }
            })
        };
    }

    it('every navigation is a gesture, and the URL bar’s are typed', () => {
        const { payloads, commands } = sender();
        void commands.navigate(PANE, 'example.org', { typed: true });
        void commands.navigate(PANE, 'https://favourite.test/');
        void commands.back(PANE);
        void commands.forward(PANE);
        void commands.reload(PANE, true);
        void commands.newTab(PANE);
        expect(payloads).toEqual([
            { command: 'web-navigate', pane_id: PANE, url: 'example.org', gesture: true, typed: true },
            { command: 'web-navigate', pane_id: PANE, url: 'https://favourite.test/', gesture: true },
            { command: 'web-back', pane_id: PANE, gesture: true },
            { command: 'web-forward', pane_id: PANE, gesture: true },
            { command: 'web-reload', pane_id: PANE, gesture: true, hard: true },
            { command: 'web-tab-new', pane_id: PANE, url: '', make_active: true, gesture: true }
        ]);
    });

    it('speaks the history verbs', () => {
        const { payloads, commands } = sender();
        void commands.historyQuery('git');
        void commands.historyRemove('https://github.com/');
        void commands.historyClear();
        void commands.historyTypedList();
        expect(payloads).toEqual([
            { command: 'web-history-query', text: 'git', limit: 8 },
            { command: 'web-history-remove', url: 'https://github.com/' },
            { command: 'web-history-clear' },
            { command: 'web-history-typed-list' }
        ]);
    });
});
