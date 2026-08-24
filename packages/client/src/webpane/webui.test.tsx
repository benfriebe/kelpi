/**
 * The web pane's four new surfaces, driven the way a person drives them: the find bar, the
 * URL-bar star + bookmarks menu, the batch panel, and the cookie/storage panel.
 *
 * All four talk to a page this client cannot touch, so every assertion is about the VERB that
 * left and the state that came back — which is exactly the seam that broke silently in the
 * Swift app (a find count from the wrong tab, a comment echo that ate the caret).
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandReply } from '../connection';
import { BatchPanel, BATCH_EMPTY_HINT } from './BatchPanel';
import { BookmarksMenu } from './FavouritesMenu';
import {
    StoragePanel,
    canonicalDomain,
    defaultExpiryInput,
    groupCookies,
    privateModeAction,
    privateModeQuestion,
    privateModeWarning,
    truncateCookieValue
} from './StoragePanel';
import { WebFindBar } from './WebFindBar';
import { WebPane, type WebPaneTab } from './WebPane';
import type { WebPaneCommands } from './commands';
import { BATCH_LOCAL_DESTINATION, type WebBatchSession, type WebFavourite } from './state';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const TAB1 = 'EEEEEEEE-0000-4000-8000-000000000001';
const TAB2 = 'EEEEEEEE-0000-4000-8000-000000000002';

interface Recorded {
    readonly verb: string;
    readonly args: readonly unknown[];
}

interface Fake {
    readonly commands: WebPaneCommands;
    readonly sent: Recorded[];
    /** Queue a reply for the next call to `verb`. */
    answer(verb: string, reply: CommandReply): void;
}

function fakeCommands(): Fake {
    const sent: Recorded[] = [];
    const replies = new Map<string, CommandReply[]>();
    const record =
        (verb: string) =>
        (...args: unknown[]): Promise<CommandReply> => {
            sent.push({ verb, args });
            const queued = replies.get(verb);
            return Promise.resolve(queued?.shift() ?? ({ ok: true } as CommandReply));
        };
    const commands = new Proxy(
        {},
        {
            get: (_target, property: string) => record(property)
        }
    ) as unknown as WebPaneCommands;
    return {
        commands,
        sent,
        answer(verb, reply) {
            const queued = replies.get(verb) ?? [];
            queued.push(reply);
            replies.set(verb, queued);
        }
    };
}

const TABS: readonly WebPaneTab[] = [
    { id: TAB1, url: 'https://example.com/', title: 'Example' },
    { id: TAB2, url: 'https://second.test/', title: 'Second' }
];

afterEach(cleanup);

// ── find (WEB-059…WEB-065) ──────────────────────────────────────────────────────────

describe('the find bar', () => {
    /**
     * §M38 — the readout is the app's ONE find-bar rule (`grid/PaneSearchOverlay.tsx`'s
     * `matchCountLabel`, which is `PaneSearchOverlay.swift:99-116`): `selected+1/total` once
     * something is selected, `-/total` before that, and **nothing at all** while the field is
     * empty. The web bar used to own a second rule that read a permanent `0/0` before you typed
     * — a counter for a search nobody had started.
     */
    it('shows no counter until there is a needle, then the Swift readout', () => {
        const fake = fakeCommands();
        fake.answer('find', { ok: true, total: 3, current: 0, tab_id: TAB1 } as unknown as CommandReply);
        render(<WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => {}} />);
        expect(screen.queryByTestId(`web-find-count-${PANE}`)).toBeNull();
    });

    it('reads `-/total` before a match is selected', async () => {
        const fake = fakeCommands();
        fake.answer('find', { ok: true, total: 3, current: -1, tab_id: TAB1 } as unknown as CommandReply);
        render(<WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => {}} />);
        fireEvent.change(screen.getByTestId(`web-find-input-${PANE}`), { target: { value: 'x' } });
        await waitFor(() => {
            expect(screen.getByTestId(`web-find-count-${PANE}`).textContent).toBe('-/3');
        });
    });

    /**
     * §M38 — the field, the count's home and the chevrons' disabled rule are the terminal bar's,
     * i.e. `PaneSearchOverlay.swift:18-86`: a 160 px 12 px-monospace "Search" field with the
     * counter tucked INSIDE its trailing edge, and a chevron pair that is dimmed AND inert while
     * the needle is empty. The bar was a 192 px sans "Find in page" field with the count outside
     * it and arrows that were never disabled.
     */
    it('wears the app’s one find-bar recipe: 160 px mono "Search", inert chevrons when empty', async () => {
        const fake = fakeCommands();
        fake.answer('find', { ok: true, total: 2, current: 0, tab_id: TAB1 } as unknown as CommandReply);
        render(<WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => {}} />);

        const input = screen.getByTestId(`web-find-input-${PANE}`) as HTMLInputElement;
        expect(input.getAttribute('placeholder')).toBe('Search');
        expect(input.className).toContain('w-[160px]');
        expect(input.style.fontSize).toBe('12px');
        expect(input.style.fontFamily).toContain('mono');

        const up = screen.getByTestId(`web-find-next-${PANE}`) as HTMLButtonElement;
        const down = screen.getByTestId(`web-find-prev-${PANE}`) as HTMLButtonElement;
        expect(up.disabled).toBe(true);
        expect(down.disabled).toBe(true);
        expect(up.className).toContain('opacity-30');

        fireEvent.change(input, { target: { value: 'x' } });
        expect((screen.getByTestId(`web-find-next-${PANE}`) as HTMLButtonElement).disabled).toBe(false);
        // …and the counter lives INSIDE the field, not as a sibling of the buttons.
        await waitFor(() => {
            const count = screen.getByTestId(`web-find-count-${PANE}`);
            expect(count.parentElement?.contains(screen.getByTestId(`web-find-input-${PANE}`))).toBe(true);
        });
    });

    it('searches as you type and shows the count the page reported', async () => {
        const fake = fakeCommands();
        fake.answer('find', { ok: true, total: 4, current: 0, tab_id: TAB1 } as unknown as CommandReply);
        render(<WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => {}} />);
        fireEvent.change(screen.getByTestId(`web-find-input-${PANE}`), { target: { value: 'fixture' } });
        await waitFor(() => {
            expect(screen.getByTestId(`web-find-count-${PANE}`).textContent).toBe('1/4');
        });
        expect(fake.sent.at(-1)).toEqual({ verb: 'find', args: [PANE, TAB1, 'search', 'fixture'] });
    });

    it('drops a count measured on a tab that is no longer active (WEB-063)', async () => {
        const fake = fakeCommands();
        // The reply names TAB2 — an outgoing tab's answer racing the switch.
        fake.answer('find', { ok: true, total: 9, current: 3, tab_id: TAB2 } as unknown as CommandReply);
        render(<WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => {}} />);
        fireEvent.change(screen.getByTestId(`web-find-input-${PANE}`), { target: { value: 'x' } });
        await waitFor(() => {
            expect(fake.sent.some((call) => call.verb === 'find')).toBe(true);
        });
        // Nothing from TAB2 landed: with no count of our own there is no counter at all
        // (§M38 — the readout is absent until the ACTIVE tab has answered).
        expect(screen.queryByTestId(`web-find-count-${PANE}`)).toBeNull();
    });

    it('steps with Return / ⇧Return and the arrows', () => {
        const fake = fakeCommands();
        render(<WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => {}} />);
        const input = screen.getByTestId(`web-find-input-${PANE}`);
        fireEvent.change(input, { target: { value: 'x' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
        fireEvent.click(screen.getByTestId(`web-find-prev-${PANE}`));
        fireEvent.click(screen.getByTestId(`web-find-next-${PANE}`));
        expect(fake.sent.filter((call) => call.verb === 'find').map((call) => call.args[2])).toEqual([
            'search',
            'next',
            'prev',
            'prev',
            'next'
        ]);
        // Mounting an empty bar marks nothing, so nothing was cleared before the first search.
        expect(fake.sent[0]?.args[2]).toBe('search');
    });

    /**
     * §H7 — the shipped app draws ONE find bar for terminal, markdown and web panes, and it
     * wires `chevron.up` to next and `chevron.down` to previous (`PaneSearchOverlay.swift:48-66`).
     * The glyph is what has to agree, so the glyph is what is read.
     */
    it('puts NEXT under the up chevron and PREVIOUS under the down one, in that order', () => {
        const fake = fakeCommands();
        render(<WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => {}} />);

        const up = screen.getByTestId(`web-find-next-${PANE}`);
        const down = screen.getByTestId(`web-find-prev-${PANE}`);
        // The glyph is the terminal bar's chevron now, not a `↑` literal (§M38) — so the shape
        // is read off `data-icon`, which is what names the mark either way.
        expect(up.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('chevron-up');
        expect(down.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('chevron-down');
        expect(up.getAttribute('aria-label')).toBe('Next match');
        expect(down.getAttribute('aria-label')).toBe('Previous match');
        // …and the up chevron is the one that comes first in the row.
        const order = [...screen.getByTestId(`web-find-${PANE}`).querySelectorAll('button')].map((button) =>
            button.getAttribute('data-testid')
        );
        expect(order).toEqual([
            `web-find-next-${PANE}`,
            `web-find-prev-${PANE}`,
            `web-find-close-${PANE}`
        ]);

        // The pair is inert until there is a needle (§M38), so give it one before clicking.
        fireEvent.change(screen.getByTestId(`web-find-input-${PANE}`), { target: { value: 'x' } });
        fireEvent.click(up);
        fireEvent.click(down);
        expect(fake.sent.filter((call) => call.verb === 'find').map((call) => call.args[2])).toEqual([
            'search',
            'next',
            'prev'
        ]);
    });

    it('clears the page and closes on Escape and on the ✕ (WEB-065)', () => {
        const fake = fakeCommands();
        let closed = 0;
        const { rerender } = render(
            <WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => (closed += 1)} />
        );
        fireEvent.keyDown(screen.getByTestId(`web-find-${PANE}`), { key: 'Escape' });
        expect(closed).toBe(1);
        expect(fake.sent.at(-1)).toEqual({ verb: 'find', args: [PANE, TAB1, 'clear', ''] });

        rerender(
            <WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => (closed += 1)} />
        );
        fireEvent.click(screen.getByTestId(`web-find-close-${PANE}`));
        expect(closed).toBe(2);
    });

    it('re-runs the needle when the active tab changes (WEB-064)', async () => {
        const fake = fakeCommands();
        const { rerender } = render(
            <WebFindBar paneID={PANE} activeTabID={TAB1} commands={fake.commands} onClose={() => {}} />
        );
        fireEvent.change(screen.getByTestId(`web-find-input-${PANE}`), { target: { value: 'needle' } });
        await waitFor(() => expect(fake.sent.length).toBeGreaterThan(0));
        rerender(<WebFindBar paneID={PANE} activeTabID={TAB2} commands={fake.commands} onClose={() => {}} />);
        await waitFor(() => {
            expect(fake.sent.at(-1)).toEqual({ verb: 'find', args: [PANE, TAB2, 'search', 'needle'] });
        });
    });

    it('⌘F over a web pane opens the bar (the app bumps a token)', () => {
        const fake = fakeCommands();
        const { rerender } = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} findToken={0} />
        );
        expect(screen.queryByTestId(`web-find-${PANE}`)).toBeNull();
        rerender(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} findToken={1} />);
        expect(screen.getByTestId(`web-find-${PANE}`)).not.toBeNull();
    });
});

// ── ⌘L (SET-188) ────────────────────────────────────────────────────────────────────

describe('⌘L', () => {
    it('moves the caret into the URL bar and selects the WHOLE address', () => {
        const fake = fakeCommands();
        const { rerender } = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} focusURLToken={0} />
        );
        rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} focusURLToken={1} />
        );
        const input = screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement;
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('https://example.com/');
        // The token's whole point: the address is selected, so typing replaces it.
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(input.value.length);
    });

    /**
     * H17 — select-all belongs to the TOKEN, never to focus itself
     * (`WebPaneChrome.swift:469-503` runs `selectAll` only inside the token guard). Clicking
     * mid-URL to fix one character used to wipe the whole field.
     */
    it('leaves the caret where a plain click put it — no select-all on focus', () => {
        const fake = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} />);
        const input = screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement;
        input.focus();
        // A pointer focus lands the caret at the click offset; jsdom does not run hit testing,
        // so the caret is placed the way the browser would have, AFTER the focus handler ran.
        input.setSelectionRange(8, 8);
        fireEvent.focus(input);
        expect(input.selectionStart).toBe(8);
        expect(input.selectionEnd).toBe(8);
    });

    it('still selects on a LATER token bump, even once the field is focused', () => {
        const fake = fakeCommands();
        const { rerender } = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} focusURLToken={1} />
        );
        const input = screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement;
        input.setSelectionRange(4, 4);
        rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} focusURLToken={2} />
        );
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe(input.value.length);
    });
});

// ── favourites (WEB-037/WEB-038) ────────────────────────────────────────────────────

const SAVED: readonly WebFavourite[] = [
    { id: 'f1', url: 'https://example.com/', title: 'Example', created_at: '', label: 'Example' }
];

describe('the URL-bar star', () => {
    it('fills for a saved URL and is hollow otherwise', () => {
        const fake = fakeCommands();
        const { rerender } = render(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={fake.commands}
                favourites={SAVED}
            />
        );
        expect(screen.getByTestId(`web-favourite-star-${PANE}`).getAttribute('data-saved')).toBe('true');
        rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB2} commands={fake.commands} favourites={SAVED} />
        );
        expect(screen.getByTestId(`web-favourite-star-${PANE}`).getAttribute('data-saved')).toBe('false');
    });

    it('is disabled for an empty URL', () => {
        const fake = fakeCommands();
        render(<WebPane paneID={PANE} tabs={[]} activeTabID={null} commands={fake.commands} />);
        expect((screen.getByTestId(`web-favourite-star-${PANE}`) as HTMLButtonElement).disabled).toBe(true);
    });

    it('toggles with the page title', () => {
        const fake = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} />);
        fireEvent.click(screen.getByTestId(`web-favourite-star-${PANE}`));
        expect(fake.sent.at(-1)).toEqual({ verb: 'favouriteToggle', args: ['https://example.com/', 'Example'] });
    });

    it('lists favourites, opens one, and offers "Manage favourites…"', () => {
        let managed = 0;
        const opened: string[] = [];
        render(
            <BookmarksMenu
                paneID={PANE}
                favourites={SAVED}
                onOpen={(url) => opened.push(url)}
                onManage={() => (managed += 1)}
            />
        );
        fireEvent.click(screen.getByTestId(`web-favourites-menu-${PANE}`));
        fireEvent.click(screen.getByTestId('web-favourite-f1'));
        expect(opened).toEqual(['https://example.com/']);

        fireEvent.click(screen.getByTestId(`web-favourites-menu-${PANE}`));
        fireEvent.click(screen.getByTestId(`web-favourites-manage-${PANE}`));
        expect(managed).toBe(1);
    });

    /**
     * §L64 — the hint is `WebPaneChrome.swift:96-99`, word for word: "No favourites yet" over
     * "Click the star to save the current page". The port had reworded both.
     */
    it('shows the two-line hint when there are none', () => {
        render(<BookmarksMenu paneID={PANE} favourites={[]} onOpen={() => {}} onManage={() => {}} />);
        fireEvent.click(screen.getByTestId(`web-favourites-menu-${PANE}`));
        const hint = screen.getByTestId(`web-favourites-empty-${PANE}`);
        expect(hint.textContent).toContain('No favourites yet');
        expect(hint.textContent).toContain('Click the star to save the current page');
        expect(hint.textContent).not.toContain('URL bar');
    });

    /**
     * §L65 — the menu has no selected state. `WebPaneChrome.swift:101-106` is a plain `Button`
     * per row; the port lit the row matching the current page with an accent pill.
     */
    it('never highlights the row matching the current page', () => {
        render(<BookmarksMenu paneID={PANE} favourites={SAVED} onOpen={() => {}} onManage={() => {}} />);
        fireEvent.click(screen.getByTestId(`web-favourites-menu-${PANE}`));
        // Rendered from a pane sitting on exactly this favourite's URL — and still plain.
        expect(screen.getByTestId('web-favourite-f1').style.background).toBe('');
    });

    /**
     * §L63 — bookmarks is a 22×22 toolbar button called "Bookmarks", OUTSIDE the URL field.
     * It was a 16×20 `▾` caret inside the field beside the star, which both renamed the control
     * and ate ~36 px of the address the field exists to show.
     */
    it('draws bookmarks as a toolbar button beside the URL field, not inside it', () => {
        const fake = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} />);
        const button = screen.getByTestId(`web-favourites-menu-${PANE}`);
        expect(button.getAttribute('title')).toBe('Bookmarks');
        expect(button.getAttribute('aria-label')).toBe('Bookmarks');
        expect(button.className).toContain('h-[22px]');
        expect(button.className).toContain('w-[22px]');
        expect(button.querySelector('[data-icon="book"]')).not.toBeNull();
        // The star is still inside the field; the menu no longer is.
        const field = screen.getByTestId(`web-url-${PANE}`).parentElement;
        expect(field?.contains(screen.getByTestId(`web-favourite-star-${PANE}`))).toBe(true);
        expect(field?.contains(button)).toBe(false);
    });
});

// ── batch pickup (WEB-126…WEB-136) ──────────────────────────────────────────────────

function session(overrides: Partial<WebBatchSession> = {}): WebBatchSession {
    return {
        visible: true,
        focused_id: null,
        last_target: null,
        submit: false,
        items: [],
        ...overrides
    };
}

describe('the batch panel', () => {
    it('shows the empty-state hint before anything is picked (WEB-131)', () => {
        const fake = fakeCommands();
        render(
            <BatchPanel
                paneID={PANE}
                session={session()}
                activeTabID={TAB1}
                destinations={[]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        expect(screen.getByTestId(`web-batch-empty-${PANE}`).textContent).toBe(BATCH_EMPTY_HINT);
    });

    it('numbers each row to match its page badge, and marks the focused one (WEB-129)', () => {
        const fake = fakeCommands();
        render(
            <BatchPanel
                paneID={PANE}
                session={session({
                    focused_id: 'i2',
                    items: [
                        { id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' },
                        { id: 'i2', selector: '#b', tag: 'a', text: '', url: '', comment: '' }
                    ]
                })}
                activeTabID={TAB1}
                destinations={[]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        expect(screen.getByTestId('web-batch-chip-i1').textContent).toBe('1');
        expect(screen.getByTestId('web-batch-chip-i2').textContent).toBe('2');
        expect(screen.getByTestId('web-batch-item-i2').getAttribute('data-focused')).toBe('true');
        expect(screen.getByTestId('web-batch-item-i1').getAttribute('data-focused')).toBe('false');
    });

    it('focuses a row with PANEL origin (which scrolls the page) and streams comments', () => {
        const fake = fakeCommands();
        render(
            <BatchPanel
                paneID={PANE}
                session={session({
                    items: [{ id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' }]
                })}
                activeTabID={TAB1}
                destinations={[]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        fireEvent.click(screen.getByTestId('web-batch-item-i1'));
        expect(fake.sent.at(-1)).toEqual({ verb: 'batchFocus', args: [PANE, 'i1', 'panel'] });
        fireEvent.change(screen.getByTestId('web-batch-comment-i1'), { target: { value: 'note' } });
        expect(fake.sent.at(-1)).toEqual({ verb: 'batchComment', args: [PANE, 'i1', 'note', TAB1] });
    });

    it('removes an item and cancels the batch', () => {
        const fake = fakeCommands();
        render(
            <BatchPanel
                paneID={PANE}
                session={session({
                    items: [{ id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' }]
                })}
                activeTabID={TAB1}
                destinations={[]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        fireEvent.click(screen.getByTestId('web-batch-remove-i1'));
        expect(fake.sent.at(-1)).toEqual({ verb: 'batchRemove', args: [PANE, 'i1'] });
        fireEvent.click(screen.getByTestId(`web-batch-cancel-${PANE}`));
        expect(fake.sent.at(-1)).toEqual({ verb: 'batchCancel', args: [PANE] });
    });

    /**
     * §M37 — the panel's furniture. `WebBatchInspectPanel.swift:95-109` heads it with an accent
     * `scope` crosshair (the same mark as the toolbar button that opened it) and closes the row
     * with the item count; `:224-247` is `HStack { Cancel; Spacer(); picker; Send N }`, with
     * Send `.borderedProminent`. The port had Cancel as a chip in the header's top-right, a bare
     * "Send" with no count, no fill on it, and no crosshair anywhere.
     */
    it('heads the panel with the scope mark and foots it Cancel · picker · Send N (M37)', () => {
        const fake = fakeCommands();
        render(
            <BatchPanel
                paneID={PANE}
                session={session({
                    items: [
                        { id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' },
                        { id: 'i2', selector: '#b', tag: 'a', text: '', url: '', comment: '' }
                    ]
                })}
                activeTabID={TAB1}
                destinations={[{ paneID: 'shell-1', label: 'worker' }]}
                commands={fake.commands}
                destination="shell-1"
                onDestinationChange={() => {}}
            />
        );

        const panel = screen.getByTestId(`web-batch-panel-${PANE}`);
        // The header carries the crosshair, and Cancel is NOT in it.
        const header = panel.firstElementChild as HTMLElement;
        expect(header.querySelector('[data-icon="scope"]')).not.toBeNull();
        expect(header.textContent).toContain('Element pickup');
        expect(header.querySelector('[data-testid]')).toBeNull();

        // The footer is Cancel, then the picker, then Send — in that DOM order.
        const cancel = screen.getByTestId(`web-batch-cancel-${PANE}`);
        const picker = screen.getByTestId(`web-batch-destination-${PANE}`);
        const send = screen.getByTestId(`web-batch-send-${PANE}`);
        const footer = cancel.parentElement as HTMLElement;
        expect(footer).toBe(picker.parentElement);
        expect(footer).toBe(send.parentElement);
        expect([...footer.children].indexOf(cancel)).toBe(0);
        expect([...footer.children].indexOf(picker)).toBeLessThan([...footer.children].indexOf(send));

        // Send names the count it is about to dispatch, and is FILLED as the default action.
        expect(send.textContent?.replace(/\s+/g, ' ').trim()).toBe('Send 2');
        expect((send as HTMLButtonElement).style.background).not.toBe('');
        expect((send as HTMLButtonElement).style.color).toBe('rgb(255, 255, 255)');
    });

    /**
     * H28 — the comment field is a full-width line of its own, under the tag+selector line
     * (`WebBatchInspectPanel.swift:153-222`: `VStack { HStack { tag; selector }; TextField }`).
     */
    it('stacks each row: tag + selector on one line, the comment full-width under it (H28)', () => {
        const fake = fakeCommands();
        render(
            <BatchPanel
                paneID={PANE}
                session={session({
                    items: [{ id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' }]
                })}
                activeTabID={TAB1}
                destinations={[]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        const comment = screen.getByTestId('web-batch-comment-i1');
        const head = screen.getByTestId('web-batch-head-i1');
        // The selector line and the comment are SIBLINGS in a column, not items in one row…
        expect(head.contains(comment)).toBe(false);
        expect(comment.parentElement).toBe(head.parentElement);
        expect(head.parentElement?.className).toContain('flex-col');
        // …and the field spans that column rather than the old fixed 128 px.
        expect(comment.className).toContain('w-full');
        expect(comment.className).not.toContain('w-32');
        // The Swift placeholder, verbatim.
        expect(comment.getAttribute('placeholder')).toBe('Comment (optional)');
        // The selector's own line still truncates in the middle (WEB-129).
        expect(screen.getByTestId('web-batch-selector-i1')).not.toBeNull();
    });

    it('grows to three two-line rows before it scrolls (WEB-131 / H28)', () => {
        const fake = fakeCommands();
        render(
            <BatchPanel
                paneID={PANE}
                session={session({
                    items: [{ id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' }]
                })}
                activeTabID={TAB1}
                destinations={[]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        // 3 × 64 + 12, the Swift cap for a two-line row — not the 148 px of a one-line one.
        expect((screen.getByTestId(`web-batch-items-${PANE}`) as HTMLElement).style.maxHeight).toBe('204px');
    });

    it('disables Send on an empty batch and sends the chosen destination (WEB-132)', () => {
        const fake = fakeCommands();
        const { rerender } = render(
            <BatchPanel
                paneID={PANE}
                session={session()}
                activeTabID={TAB1}
                destinations={[{ paneID: 'shell-1', label: 'worker' }]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        expect((screen.getByTestId(`web-batch-send-${PANE}`) as HTMLButtonElement).disabled).toBe(true);

        rerender(
            <BatchPanel
                paneID={PANE}
                session={session({
                    items: [{ id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' }]
                })}
                activeTabID={TAB1}
                destinations={[{ paneID: 'shell-1', label: 'worker' }]}
                commands={fake.commands}
                destination="shell-1"
                onDestinationChange={() => {}}
            />
        );
        fireEvent.click(screen.getByTestId(`web-batch-send-${PANE}`));
        expect(fake.sent.at(-1)).toEqual({ verb: 'batchSend', args: [PANE, 'shell-1'] });
    });

    it('says so when there is nowhere to send (WEB-133)', () => {
        const fake = fakeCommands();
        render(
            <BatchPanel
                paneID={PANE}
                session={session()}
                activeTabID={TAB1}
                destinations={[]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        expect(screen.getByTestId(`web-batch-destination-${PANE}`).textContent).toContain(
            'No other panes open in this workspace'
        );
    });

    /**
     * H16 — the contradicted half of WEB-132. Send used to be enabled by a non-empty batch
     * alone, and the picker's empty value read "Queue locally", so the default click dispatched
     * the batch into a CLI-only queue. `WebBatchInspectPanel.swift:224-247` disables Send on
     * `selection == .unselected`, and its picker has no local row at all.
     */
    it('keeps Send disabled until a destination is deliberately picked (H16 / WEB-132)', () => {
        const fake = fakeCommands();
        const items = [{ id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' }];
        const { rerender } = render(
            <BatchPanel
                paneID={PANE}
                session={session({ items })}
                activeTabID={TAB1}
                destinations={[{ paneID: 'shell-1', label: 'worker' }]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        const send = (): HTMLButtonElement => screen.getByTestId(`web-batch-send-${PANE}`) as HTMLButtonElement;
        // A full batch with no destination is NOT sendable.
        expect(send().disabled).toBe(true);
        fireEvent.click(send());
        expect(fake.sent.some((call) => call.verb === 'batchSend')).toBe(false);

        // The unselected picker says what it wants, and never "Queue locally".
        const picker = screen.getByTestId(`web-batch-destination-${PANE}`) as HTMLSelectElement;
        expect(picker.value).toBe('');
        expect(picker.options[0]?.textContent).toBe('Select destination…');

        rerender(
            <BatchPanel
                paneID={PANE}
                session={session({ items })}
                activeTabID={TAB1}
                destinations={[{ paneID: 'shell-1', label: 'worker' }]}
                commands={fake.commands}
                destination="shell-1"
                onDestinationChange={() => {}}
            />
        );
        expect(send().disabled).toBe(false);
    });

    it('offers the local queue as an explicit row below the panes, and sends it as null (H16)', () => {
        const fake = fakeCommands();
        const items = [{ id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' }];
        let chosen: string | null = null;
        const { rerender } = render(
            <BatchPanel
                paneID={PANE}
                session={session({ items })}
                activeTabID={TAB1}
                destinations={[{ paneID: 'shell-1', label: 'worker' }]}
                commands={fake.commands}
                destination={null}
                onDestinationChange={(value) => {
                    chosen = value;
                }}
            />
        );
        const picker = screen.getByTestId(`web-batch-destination-${PANE}`) as HTMLSelectElement;
        // Placeholder, the pane, then the local queue — in that order.
        expect(Array.from(picker.options).map((option) => option.value)).toEqual([
            '',
            'shell-1',
            BATCH_LOCAL_DESTINATION
        ]);
        fireEvent.change(picker, { target: { value: BATCH_LOCAL_DESTINATION } });
        expect(chosen).toBe(BATCH_LOCAL_DESTINATION);

        rerender(
            <BatchPanel
                paneID={PANE}
                session={session({ items })}
                activeTabID={TAB1}
                destinations={[{ paneID: 'shell-1', label: 'worker' }]}
                commands={fake.commands}
                destination={BATCH_LOCAL_DESTINATION}
                onDestinationChange={() => {}}
            />
        );
        const send = screen.getByTestId(`web-batch-send-${PANE}`) as HTMLButtonElement;
        expect(send.disabled).toBe(false);
        fireEvent.click(send);
        // The wire is unchanged: the local queue is still `sendTo: null`.
        expect(fake.sent.at(-1)).toEqual({ verb: 'batchSend', args: [PANE, null] });
    });

    it('never resets an explicit local-queue pick, however the pane list moves (H16)', () => {
        const fake = fakeCommands();
        const resets: (string | null)[] = [];
        render(
            <BatchPanel
                paneID={PANE}
                session={session({
                    items: [{ id: 'i1', selector: '#a', tag: 'button', text: '', url: '', comment: '' }]
                })}
                activeTabID={TAB1}
                destinations={[]}
                commands={fake.commands}
                destination={BATCH_LOCAL_DESTINATION}
                onDestinationChange={(value) => resets.push(value)}
            />
        );
        // WEB-132's staleness check is about PANES; the local queue can never go stale.
        expect(resets).toEqual([]);
    });

    it('is a three-way chrome button whose label says what it will do (WEB-126)', () => {
        const fake = fakeCommands();
        const { rerender } = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} batch={null} />
        );
        const button = (): HTMLElement => screen.getByTestId(`web-batch-toggle-${PANE}`);
        expect(button().getAttribute('aria-label')).toBe('Start element pickup');
        fireEvent.click(button());
        expect(fake.sent.at(-1)).toEqual({ verb: 'batchToggle', args: [PANE] });

        rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} batch={session()} />
        );
        expect(button().getAttribute('aria-label')).toBe('Hide element pickup');
        expect(screen.getByTestId(`web-batch-panel-${PANE}`)).not.toBeNull();

        rerender(
            <WebPane
                paneID={PANE}
                tabs={TABS}
                activeTabID={TAB1}
                commands={fake.commands}
                batch={session({ visible: false })}
            />
        );
        expect(button().getAttribute('aria-label')).toBe('Show element pickup');
        // Hidden means paused: the items live on daemon-side, but no panel is drawn.
        expect(screen.queryByTestId(`web-batch-panel-${PANE}`)).toBeNull();
    });
});

// ── storage (WEB-049…WEB-054) ───────────────────────────────────────────────────────

const COOKIES = [
    { name: 'b', value: '2', domain: '.example.com', path: '/', is_secure: false, is_http_only: false },
    { name: 'a', value: '1', domain: 'example.com', path: '/', is_secure: true, is_http_only: false },
    { name: 'z', value: '9', domain: 'other.test', path: '/', is_secure: false, is_http_only: true }
];

describe('cookie grouping (WEB-050)', () => {
    it('groups by canonical domain, sorts groups and names', () => {
        expect(canonicalDomain('.example.com')).toBe('example.com');
        expect(groupCookies(COOKIES)).toEqual([
            { domain: 'example.com', cookies: [COOKIES[1], COOKIES[0]] },
            { domain: 'other.test', cookies: [COOKIES[2]] }
        ]);
    });
});

describe('the storage panel', () => {
    function open(fake: Fake, isPrivate = false): ReturnType<typeof render> {
        fake.answer('cookiesList', { ok: true, cookies: COOKIES } as unknown as CommandReply);
        return render(
            <StoragePanel
                paneID={PANE}
                isPrivate={isPrivate}
                commands={fake.commands}
                onClose={() => {}}
                now={() => 0}
            />
        );
    }

    it('lists cookies collapsed by default, with a count per domain', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull());
        const group = screen.getByTestId('web-cookie-group-example.com');
        expect(group.getAttribute('data-open')).toBe('false');
        expect(group.textContent).toContain('(2)');
        // Collapsed: the rows are not rendered until the accordion opens.
        expect(screen.queryByTestId('web-cookie-example.com-a')).toBeNull();
        fireEvent.click(group);
        expect(screen.getByTestId('web-cookie-example.com-a')).not.toBeNull();
    });

    it('deletes one cookie and a whole domain', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull());
        fireEvent.click(screen.getByTestId('web-cookie-clear-example.com'));
        expect(fake.sent.at(-1)).toEqual({ verb: 'cookiesClear', args: [PANE, { domain: 'example.com' }] });

        fireEvent.click(screen.getByTestId('web-cookie-group-example.com'));
        fireEvent.click(screen.getByTestId('web-cookie-delete-a'));
        expect(fake.sent.at(-1)).toEqual({ verb: 'cookieDelete', args: [PANE, 'a', 'example.com'] });
    });

    it('opens an edit form with a locked domain and a +30 day expiry (WEB-051)', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull());
        fireEvent.click(screen.getByTestId('web-cookie-group-example.com'));
        fireEvent.click(screen.getByTestId('web-cookie-toggle-a'));
        const domain = screen.getByTestId(`web-cookie-form-domain-${PANE}`) as HTMLInputElement;
        expect(domain.readOnly).toBe(true);
        expect(domain.value).toBe('example.com');
        // The row was not a session cookie in the fixture (no expires ⇒ session only), so the
        // picker is prefilled to the +30-day default and disabled behind the checkbox.
        expect((screen.getByTestId(`web-cookie-form-expires-${PANE}`) as HTMLInputElement).value).toBe(
            defaultExpiryInput(0)
        );
    });

    it('saves through delete-then-set by naming the original (WEB-052)', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull());
        fireEvent.click(screen.getByTestId('web-cookie-group-example.com'));
        fireEvent.click(screen.getByTestId('web-cookie-toggle-a'));
        fireEvent.change(screen.getByTestId(`web-cookie-form-name-${PANE}`), { target: { value: 'renamed' } });
        fireEvent.click(screen.getByTestId(`web-cookie-form-save-${PANE}`));
        const call = fake.sent.at(-1);
        expect(call?.verb).toBe('cookieSet');
        expect(call?.args[1]).toMatchObject({ name: 'renamed', domain: 'example.com', is_secure: true });
        expect(call?.args[2]).toMatchObject({ name: 'a', domain: 'example.com' });
    });

    it('disables Save until name and domain are both filled', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId(`web-cookie-add-${PANE}`)).not.toBeNull());
        fireEvent.click(screen.getByTestId(`web-cookie-add-${PANE}`));
        const save = (): HTMLButtonElement => screen.getByTestId(`web-cookie-form-save-${PANE}`) as HTMLButtonElement;
        expect(save().disabled).toBe(true);
        fireEvent.change(screen.getByTestId(`web-cookie-form-name-${PANE}`), { target: { value: 'n' } });
        expect(save().disabled).toBe(true);
        fireEvent.change(screen.getByTestId(`web-cookie-form-domain-${PANE}`), { target: { value: 'd.test' } });
        expect(save().disabled).toBe(false);
    });

    it('gates "clear all site data" behind a confirmation (WEB-054)', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId(`web-clear-site-data-${PANE}`)).not.toBeNull());
        fireEvent.click(screen.getByTestId(`web-clear-site-data-${PANE}`));
        // Nothing has happened yet — only the question.
        expect(fake.sent.some((call) => call.verb === 'cookiesClear')).toBe(false);
        fireEvent.click(screen.getByTestId(`web-storage-confirm-ok-${PANE}`));
        expect(fake.sent.at(-1)).toEqual({ verb: 'cookiesClear', args: [PANE, { all: true }] });
    });

    it('gates the private toggle, with a message that differs per direction (WEB-049)', async () => {
        expect(privateModeWarning(true)).toContain('discarded on quit');
        expect(privateModeWarning(false)).toContain('become visible again');

        const fake = fakeCommands();
        open(fake, false);
        await waitFor(() => expect(screen.getByTestId(`web-private-toggle-${PANE}`)).not.toBeNull());
        fireEvent.click(screen.getByTestId(`web-private-toggle-${PANE}`));
        expect(screen.getByTestId(`web-storage-confirm-${PANE}`).textContent).toContain('discarded on quit');
        expect(fake.sent.some((call) => call.verb === 'setPrivate')).toBe(false);
        fireEvent.click(screen.getByTestId(`web-storage-confirm-ok-${PANE}`));
        expect(fake.sent.at(-1)).toEqual({ verb: 'setPrivate', args: [PANE, true] });
    });

    /**
     * §L74 — a confirmation is a titled QUESTION whose destructive button NAMES the action
     * (`StoragePanel.swift:57-82`). Both of the port's read as one untitled card ending in
     * "Continue", so the two very different questions were told apart by body text alone.
     */
    it('titles each confirmation and names its destructive action (L74)', async () => {
        expect(privateModeQuestion(true)).toBe('Enable private mode for this pane?');
        expect(privateModeQuestion(false)).toBe('Disable private mode for this pane?');
        expect(privateModeAction(true)).toBe('Enable private mode');
        expect(privateModeAction(false)).toBe('Disable private mode');

        const fake = fakeCommands();
        open(fake, false);
        await waitFor(() => expect(screen.getByTestId(`web-clear-site-data-${PANE}`)).not.toBeNull());

        fireEvent.click(screen.getByTestId(`web-clear-site-data-${PANE}`));
        expect(screen.getByTestId(`web-storage-confirm-title-${PANE}`).textContent).toBe(
            'Clear all site data for this pane?'
        );
        expect(screen.getByTestId(`web-storage-confirm-ok-${PANE}`).textContent).toBe('Clear all site data');
        expect(screen.getByTestId(`web-storage-confirm-${PANE}`).textContent).toContain('IndexedDB');
        expect(screen.getByTestId(`web-storage-confirm-${PANE}`).textContent).not.toContain('Continue');
        fireEvent.click(screen.getByTestId(`web-storage-confirm-cancel-${PANE}`));

        fireEvent.click(screen.getByTestId(`web-private-toggle-${PANE}`));
        expect(screen.getByTestId(`web-storage-confirm-title-${PANE}`).textContent).toBe(
            'Enable private mode for this pane?'
        );
        expect(screen.getByTestId(`web-storage-confirm-ok-${PANE}`).textContent).toBe('Enable private mode');
    });

    /**
     * §L58 — the edit form's own Delete (`StoragePanel.swift:592-599`). Present only when there
     * is an original to delete, so the add form still shows Cancel/Save alone.
     */
    it('deletes from inside the edit form, and offers no Delete on the add form (L58)', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull());

        fireEvent.click(screen.getByTestId(`web-cookie-add-${PANE}`));
        expect(screen.queryByTestId(`web-cookie-form-delete-${PANE}`)).toBeNull();
        fireEvent.click(screen.getByTestId(`web-cookie-form-cancel-${PANE}`));

        fireEvent.click(screen.getByTestId('web-cookie-group-example.com'));
        fireEvent.click(screen.getByTestId('web-cookie-toggle-a'));
        fireEvent.click(screen.getByTestId(`web-cookie-form-delete-${PANE}`));
        expect(fake.sent.at(-1)).toEqual({ verb: 'cookieDelete', args: [PANE, 'a', 'example.com'] });
        // …and the form closes behind it, the way `onDelete` sets `editingKey = nil`.
        expect(screen.queryByTestId(`web-cookie-form-${PANE}`)).toBeNull();
    });

    /**
     * §L60 — a cookie row is a two-line disclosure: an expander glyph, the name over its
     * 60-char-clamped value. It had been one `name=value` link with no expander and no clamp.
     */
    it('draws cookie rows as two-line disclosures with a clamped value (L60)', async () => {
        expect(truncateCookieValue('short')).toBe('short');
        expect(truncateCookieValue('x'.repeat(200))).toBe(`${'x'.repeat(59)}…`);
        expect(truncateCookieValue('x'.repeat(60))).toBe('x'.repeat(60));

        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull());
        fireEvent.click(screen.getByTestId('web-cookie-group-example.com'));

        const row = screen.getByTestId('web-cookie-example.com-a');
        expect(row.getAttribute('data-open')).toBe('false');
        expect(row.textContent).not.toContain('a=1');
        expect(row.textContent).toContain('▸');
        expect(screen.getByTestId('web-cookie-value-a').textContent).toBe('1');

        fireEvent.click(screen.getByTestId('web-cookie-toggle-a'));
        expect(screen.getByTestId('web-cookie-example.com-a').getAttribute('data-open')).toBe('true');
        expect(screen.getByTestId('web-cookie-example.com-a').textContent).toContain('▾');
        // The same click again collapses it, the way `toggleEditing(key)` does.
        fireEvent.click(screen.getByTestId('web-cookie-toggle-a'));
        expect(screen.queryByTestId(`web-cookie-form-${PANE}`)).toBeNull();
    });

    /**
     * §L61 — the empty line has a private-mode variant (`StoragePanel.swift:186-192`); the port
     * said "No cookies for this pane." in both modes.
     */
    it('names private mode in the empty-cookie line (L61)', async () => {
        const fake = fakeCommands();
        fake.answer('cookiesList', { ok: true, cookies: [] } as unknown as CommandReply);
        const view = render(
            <StoragePanel paneID={PANE} isPrivate={false} commands={fake.commands} onClose={() => {}} />
        );
        await waitFor(() => expect(screen.getByTestId(`web-cookie-empty-${PANE}`)).not.toBeNull());
        expect(screen.getByTestId(`web-cookie-empty-${PANE}`).textContent).toBe(
            'No cookies for this data store yet.'
        );

        view.rerender(
            <StoragePanel paneID={PANE} isPrivate={true} commands={fake.commands} onClose={() => {}} />
        );
        expect(screen.getByTestId(`web-cookie-empty-${PANE}`).textContent).toBe(
            'No cookies (private mode — fresh on every launch).'
        );
    });

    /**
     * §L59 — the Swift shows a `ProgressView` beside the "Cookies" heading for as long as
     * `getAllCookies` is in flight; the port's `refresh()` set no pending state at all.
     */
    it('shows a progress indicator while the cookie list is in flight (L59)', async () => {
        let settle: ((reply: CommandReply) => void) | undefined;
        const commands = {
            cookiesList: () =>
                new Promise<CommandReply>((resolve) => {
                    settle = resolve;
                })
        } as unknown as WebPaneCommands;
        render(<StoragePanel paneID={PANE} isPrivate={false} commands={commands} onClose={() => {}} />);
        // The read is open: the indicator stands in for the answer that has not arrived.
        expect(screen.getByTestId(`web-storage-loading-${PANE}`)).not.toBeNull();
        settle?.({ ok: true, cookies: COOKIES } as unknown as CommandReply);
        await waitFor(() => expect(screen.queryByTestId(`web-storage-loading-${PANE}`)).toBeNull());
        expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull();
    });

    /**
     * §L73 — every control outside the toolbar carries the Swift's `.help(…)` as a `title`, not
     * an `aria-label` alone: a pointer user gets no accessible name.
     */
    it('gives each storage control its Swift tooltip (L73)', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull());
        fireEvent.click(screen.getByTestId('web-cookie-group-example.com'));
        const title = (testID: string): string | null => screen.getByTestId(testID).getAttribute('title');
        expect(title(`web-storage-refresh-${PANE}`)).toBe('Refresh cookie list');
        expect(title(`web-storage-close-${PANE}`)).toBe('Close storage panel');
        expect(title(`web-cookie-add-${PANE}`)).toBe('Add a cookie');
        expect(title(`web-clear-site-data-${PANE}`)).toBe(
            'Clear all site data (cookies, caches, local storage)'
        );
        expect(title('web-cookie-add-example.com')).toBe('Add cookie for example.com');
        expect(title('web-cookie-clear-example.com')).toBe('Delete all cookies for example.com');
        expect(title('web-cookie-delete-a')).toBe('Delete cookie a');
    });

    it('cancels a confirmation without doing anything', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId(`web-clear-site-data-${PANE}`)).not.toBeNull());
        fireEvent.click(screen.getByTestId(`web-clear-site-data-${PANE}`));
        fireEvent.click(screen.getByTestId(`web-storage-confirm-cancel-${PANE}`));
        expect(screen.queryByTestId(`web-storage-confirm-${PANE}`)).toBeNull();
        expect(fake.sent.some((call) => call.verb === 'cookiesClear')).toBe(false);
    });

    /**
     * §M39 — the panel is cookies, the private toggle and clear-all, and nothing else.
     * `StoragePanel.swift` has no localStorage read-out; the port had grown a "Local storage"
     * button that ran a `web-exec` and dumped the page's keys into the panel, which is an
     * affordance the shipped app never shows. `nex web exec` is still the way to read it.
     */
    it('offers no localStorage read-out, and runs no `exec` for one', async () => {
        const fake = fakeCommands();
        open(fake);
        await waitFor(() => expect(screen.getByTestId(`web-clear-site-data-${PANE}`)).not.toBeNull());
        expect(screen.queryByTestId(`web-localstorage-${PANE}`)).toBeNull();
        expect(screen.queryByTestId(`web-localstorage-rows-${PANE}`)).toBeNull();
        expect(screen.queryByText('Local storage')).toBeNull();
        expect(fake.sent.some((call) => call.verb === 'exec')).toBe(false);
    });

    /**
     * §M36 — the private row is `StoragePanel.swift:105-125`: "Private mode" over a caption that
     * says what the choice COSTS, with a real macOS switch on the trailing edge. It read
     * "Private session · in-memory store" beside a square user-agent tick box.
     */
    it('names the private row the way the shipped app does, on a real switch', async () => {
        const fake = fakeCommands();
        const view = open(fake, false);
        await waitFor(() => expect(screen.getByTestId(`web-private-toggle-${PANE}`)).not.toBeNull());

        const panel = screen.getByTestId(`web-storage-${PANE}`);
        expect(panel.textContent).toContain('Private mode');
        expect(panel.textContent).toContain('Cookies + caches persist across restarts.');
        expect(panel.textContent).not.toContain('in-memory store');

        const toggle = screen.getByTestId(`web-private-toggle-${PANE}`) as HTMLInputElement;
        expect(toggle.getAttribute('role')).toBe('switch');
        // The switch primitive, not the user agent's box: the input IS the track, and a thumb
        // rides over it.
        expect(toggle.style.appearance).toBe('none');
        expect(screen.getByTestId(`web-private-toggle-${PANE}-thumb`)).not.toBeNull();

        view.rerender(
            <StoragePanel paneID={PANE} isPrivate={true} commands={fake.commands} onClose={() => {}} />
        );
        expect(screen.getByTestId(`web-storage-${PANE}`).textContent).toContain(
            'Cookies + caches discarded on quit; tabs blank on restart.'
        );
    });

    it('is opened and closed from the chrome', () => {
        const fake = fakeCommands();
        render(<WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} />);
        expect(screen.queryByTestId(`web-storage-${PANE}`)).toBeNull();
        fireEvent.click(screen.getByTestId(`web-storage-toggle-${PANE}`));
        expect(screen.getByTestId(`web-storage-${PANE}`)).not.toBeNull();
        fireEvent.click(screen.getByTestId(`web-storage-close-${PANE}`));
        expect(screen.queryByTestId(`web-storage-${PANE}`)).toBeNull();
    });
});
