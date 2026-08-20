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
import { FavouritesMenu } from './FavouritesMenu';
import { StoragePanel, canonicalDomain, defaultExpiryInput, groupCookies, privateModeWarning } from './StoragePanel';
import { WebFindBar, findCountLabel } from './WebFindBar';
import { WebPane, type WebPaneTab } from './WebPane';
import type { WebPaneCommands } from './commands';
import type { WebBatchSession, WebFavourite } from './state';

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
    it('reads 0/0 with no matches and n/N with them', () => {
        expect(findCountLabel(0, -1)).toBe('0/0');
        expect(findCountLabel(3, 0)).toBe('1/3');
        // Never `3/0`: a count with no selection still shows a floor of 0.
        expect(findCountLabel(3, -1)).toBe('0/3');
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
        expect(screen.getByTestId(`web-find-count-${PANE}`).textContent).toBe('0/0');
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
    it('moves the caret into the URL bar and selects it', () => {
        const fake = fakeCommands();
        const { rerender } = render(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} focusURLToken={0} />
        );
        rerender(
            <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={fake.commands} focusURLToken={1} />
        );
        const input = screen.getByTestId(`web-url-${PANE}`) as HTMLInputElement;
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(0);
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
            <FavouritesMenu
                paneID={PANE}
                url="https://other.test/"
                title=""
                favourites={SAVED}
                onToggle={() => {}}
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

    it('shows the two-line hint when there are none', () => {
        render(
            <FavouritesMenu
                paneID={PANE}
                url=""
                title=""
                favourites={[]}
                onToggle={() => {}}
                onOpen={() => {}}
                onManage={() => {}}
            />
        );
        fireEvent.click(screen.getByTestId(`web-favourites-menu-${PANE}`));
        expect(screen.getByTestId(`web-favourites-empty-${PANE}`).textContent).toContain('No favourites yet');
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
    function open(fake: Fake, isPrivate = false): void {
        fake.answer('cookiesList', { ok: true, cookies: COOKIES } as unknown as CommandReply);
        render(
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
        fireEvent.click(screen.getByText('a=1'));
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
        fireEvent.click(screen.getByText('a=1'));
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
        expect(privateModeWarning(true)).toContain('discards');
        expect(privateModeWarning(false)).toContain('reappear');

        const fake = fakeCommands();
        open(fake, false);
        await waitFor(() => expect(screen.getByTestId(`web-private-toggle-${PANE}`)).not.toBeNull());
        fireEvent.click(screen.getByTestId(`web-private-toggle-${PANE}`));
        expect(screen.getByTestId(`web-storage-confirm-${PANE}`).textContent).toContain('discards');
        expect(fake.sent.some((call) => call.verb === 'setPrivate')).toBe(false);
        fireEvent.click(screen.getByTestId(`web-storage-confirm-ok-${PANE}`));
        expect(fake.sent.at(-1)).toEqual({ verb: 'setPrivate', args: [PANE, true] });
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

    it('reads localStorage through `web exec`, not a new host verb', async () => {
        const fake = fakeCommands();
        fake.answer('exec', { ok: true, result: [['token', 'abc']] } as unknown as CommandReply);
        open(fake);
        await waitFor(() => expect(screen.getByTestId(`web-localstorage-${PANE}`)).not.toBeNull());
        fireEvent.click(screen.getByTestId(`web-localstorage-${PANE}`));
        await waitFor(() => {
            expect(screen.getByTestId(`web-localstorage-rows-${PANE}`).textContent).toContain('token = abc');
        });
        expect(fake.sent.some((call) => call.verb === 'exec')).toBe(true);
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
