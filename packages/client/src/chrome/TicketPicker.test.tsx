/**
 * The New Workspace sheet's ticket picker (shell-ui.md §10.1, docs/integrations.md), mounted bare
 * over a synthetic `TicketSource`: nothing here reaches a daemon or GitHub.
 *
 * What is pinned: the three default lists on open; a 300 ms pause and two characters before a
 * typed search; a late reply never painting over a newer one; a pasted link resolving at once and
 * a typed one offered as one row; an unregistered repository's row listed, dimmed and unpickable;
 * the keyboard (↑/↓ over pickable rows only, Return picks); and each failure with its way out.
 */

import type { TicketSearchReply } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultLists, fakeTicketSource, resolveReply, searchReply, ticket, type FakeTicketSource } from './ticket-fixtures';
import {
    TICKET_SEARCH_DEBOUNCE_MS,
    TicketPicker,
    formatRetryAfter,
    readTicketResolve,
    readTicketSearch,
    statusProblem,
    ticketProblemButtons
} from './TicketPicker';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

/** Let resolved promises land (fake timers do not run microtasks for us inside React). */
async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function mount(source: FakeTicketSource) {
    const onResolved = vi.fn();
    const onCancel = vi.fn();
    const onOpenSettings = vi.fn();
    render(<TicketPicker source={source} onResolved={onResolved} onCancel={onCancel} onOpenSettings={onOpenSettings} />);
    return { onResolved, onCancel, onOpenSettings };
}

const field = (): HTMLInputElement => screen.getByTestId('ticket-picker-search') as HTMLInputElement;

describe('opening', () => {
    it('loads the three default lists at once, under their own headings', async () => {
        const source = fakeTicketSource();
        mount(source);
        expect(source.search).toHaveBeenCalledWith('');
        await flush();
        expect(screen.getByTestId('ticket-picker-section-authored').textContent).toContain('Your open pull requests');
        expect(screen.getByTestId('ticket-picker-section-review-requested').textContent).toContain('Waiting for your review');
        expect(screen.getByTestId('ticket-picker-section-assigned').textContent).toContain('Issues assigned to you');
        expect(screen.getByTestId('ticket-picker-row-acme/api#418').textContent).toContain('Retry login on 401');
        // The field keeps the caret, the way the repo picker's search does.
        expect(document.activeElement).toBe(field());
    });

    it('shows the search reply\'s warnings (SSO hiding some organizations\' results)', async () => {
        const source = fakeTicketSource();
        source.search.mockResolvedValue({ ok: true, reply: searchReply(defaultLists().sections, ['Results from acme are hidden until SSO is authorized.']) });
        mount(source);
        await flush();
        expect(screen.getByTestId('ticket-picker-warning').textContent).toContain('SSO');
    });
});

describe('typing', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('waits 300 ms after the last keystroke, and two characters, before it searches', async () => {
        const source = fakeTicketSource();
        mount(source);
        await flush();
        source.search.mockClear();

        fireEvent.change(field(), { target: { value: 'r' } });
        act(() => {
            vi.advanceTimersByTime(TICKET_SEARCH_DEBOUNCE_MS * 2);
        });
        expect(source.search).not.toHaveBeenCalled();
        expect(screen.getByTestId('ticket-picker-short')).toBeTruthy();

        fireEvent.change(field(), { target: { value: 're' } });
        act(() => {
            vi.advanceTimersByTime(TICKET_SEARCH_DEBOUNCE_MS - 1);
        });
        fireEvent.change(field(), { target: { value: 'ret' } });
        act(() => {
            vi.advanceTimersByTime(TICKET_SEARCH_DEBOUNCE_MS - 1);
        });
        expect(source.search).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(source.search).toHaveBeenCalledTimes(1);
        expect(source.search).toHaveBeenCalledWith('ret');
    });

    it('drops a reply that arrives after a newer search went out', async () => {
        const source = fakeTicketSource();
        mount(source);
        await flush();
        const pending: ((reply: TicketSearchReply) => void)[] = [];
        source.search.mockImplementation(
            () => new Promise((resolve) => pending.push((reply) => resolve({ ok: true, reply })))
        );

        fireEvent.change(field(), { target: { value: 'ret' } });
        act(() => {
            vi.advanceTimersByTime(TICKET_SEARCH_DEBOUNCE_MS);
        });
        fireEvent.change(field(), { target: { value: 'retry' } });
        act(() => {
            vi.advanceTimersByTime(TICKET_SEARCH_DEBOUNCE_MS);
        });
        expect(pending).toHaveLength(2);

        // The newer answer lands first; the older one then arrives and must not paint over it.
        pending[1]?.(searchReply([{ id: 'results', items: [ticket(5, { title: 'Retry newest' })] }]));
        await flush();
        pending[0]?.(searchReply([{ id: 'results', items: [ticket(6, { title: 'Stale ret' })] }]));
        await flush();
        expect(screen.getByTestId('ticket-picker-row-acme/api#5')).toBeTruthy();
        expect(screen.queryByTestId('ticket-picker-row-acme/api#6')).toBeNull();
    });

    it('resolves a pasted link at once, with no search', async () => {
        const source = fakeTicketSource();
        const { onResolved } = mount(source);
        await flush();
        source.search.mockClear();
        const url = 'https://github.com/acme/api/pull/418';
        fireEvent.paste(field());
        fireEvent.change(field(), { target: { value: url } });
        expect(source.resolve).toHaveBeenCalledWith(url);
        expect(screen.getByTestId('ticket-picker-resolving').textContent).toContain('acme/api#418');
        await flush();
        expect(onResolved).toHaveBeenCalledTimes(1);
        act(() => {
            vi.advanceTimersByTime(TICKET_SEARCH_DEBOUNCE_MS * 2);
        });
        expect(source.search).not.toHaveBeenCalled();
    });

    it('offers a TYPED `owner/name#n` as one row Return opens, rather than resolving mid-number', async () => {
        const source = fakeTicketSource();
        const { onResolved } = mount(source);
        await flush();
        fireEvent.change(field(), { target: { value: 'acme/api#4' } });
        expect(source.resolve).not.toHaveBeenCalled();
        fireEvent.change(field(), { target: { value: 'acme/api#41' } });
        expect(screen.getByTestId('ticket-picker-ref').textContent).toBe('Open acme/api#41');
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(source.resolve).toHaveBeenCalledWith('acme/api#41');
        await flush();
        expect(onResolved).toHaveBeenCalled();
    });
});

describe('rows', () => {
    it('lists a ticket from an unregistered repository dimmed, says how to add it, and will not pick it', async () => {
        const source = fakeTicketSource();
        mount(source);
        await flush();
        const row = screen.getByTestId('ticket-picker-row-other/lib#77');
        expect(row.dataset['pickable']).toBe('false');
        expect(row.getAttribute('aria-disabled')).toBe('true');
        expect(row.style.opacity).toBe('0.5');
        expect(row.textContent).toContain('Add other/lib in Settings ▸ Repositories');
        fireEvent.click(row);
        expect(source.resolve).not.toHaveBeenCalled();
    });

    it('moves the highlight over pickable rows only, and Return picks the highlighted one', async () => {
        const source = fakeTicketSource();
        const { onResolved } = mount(source);
        await flush();
        const lit = (): string | undefined =>
            screen
                .getAllByRole('option')
                .find((row) => row.dataset['highlighted'] === 'true')
                ?.getAttribute('data-testid') ?? undefined;
        expect(lit()).toBe('ticket-picker-row-acme/api#418');
        fireEvent.keyDown(field(), { key: 'ArrowDown' });
        // #77 is not pickable, so the highlight skips it.
        expect(lit()).toBe('ticket-picker-row-acme/api#12');
        fireEvent.keyDown(field(), { key: 'ArrowDown' });
        expect(lit()).toBe('ticket-picker-row-acme/api#418');
        fireEvent.keyDown(field(), { key: 'ArrowUp' });
        expect(lit()).toBe('ticket-picker-row-acme/api#12');
        fireEvent.keyDown(field(), { key: 'Enter' });
        expect(source.resolve).toHaveBeenCalledWith('https://github.com/acme/api/issues/12');
        await flush();
        expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ ticket: expect.objectContaining({ number: 12 }) }));
    });

    it('takes one pick at a time: a second click while a lookup is out does nothing', async () => {
        const source = fakeTicketSource();
        const { onResolved } = mount(source);
        await flush();
        const answers: ((value: unknown) => void)[] = [];
        source.resolve.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
        fireEvent.click(screen.getByTestId('ticket-picker-row-acme/api#418'));
        fireEvent.click(screen.getByTestId('ticket-picker-row-acme/api#12'));
        expect(source.resolve).toHaveBeenCalledTimes(1);
        answers[0]?.({ ok: true, reply: resolveReply(ticket(418, { kind: 'pr' })) });
        await flush();
        expect(onResolved).toHaveBeenCalledTimes(1);
    });
});

describe('failures, each with its way out', () => {
    it('says GitHub is not connected, searches nothing, and offers Settings ▸ Integrations', () => {
        const source = fakeTicketSource({ status: { provider: 'github', available: true, connected: false } });
        const { onOpenSettings } = mount(source);
        expect(source.search).not.toHaveBeenCalled();
        expect(screen.getByTestId('ticket-picker-problem').dataset['code']).toBe('not-connected');
        expect(screen.getByTestId('ticket-picker-problem-title').textContent).toBe('GitHub is not connected');
        expect(field().disabled).toBe(true);
        fireEvent.click(screen.getByTestId('ticket-picker-problem-settings'));
        expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it('treats a revoked credential the same way', () => {
        mount(fakeTicketSource({ status: { provider: 'github', available: true, connected: false, problem: 'revoked' } }));
        expect(screen.getByTestId('ticket-picker-problem').dataset['code']).toBe('unauthorized');
        expect(screen.getByTestId('ticket-picker-problem-settings')).toBeTruthy();
    });

    it('says when a rate limit lifts, and Try again repeats the search', async () => {
        const source = fakeTicketSource();
        source.search.mockResolvedValueOnce({ ok: false, failure: { error: 'API rate limit exceeded', code: 'rate-limited', retry_after_s: 42 } });
        mount(source);
        await flush();
        expect(screen.getByTestId('ticket-picker-problem').textContent).toContain('Try again in 42 s');
        fireEvent.click(screen.getByTestId('ticket-picker-problem-retry'));
        expect(source.search).toHaveBeenCalledTimes(2);
        expect(source.search).toHaveBeenLastCalledWith('');
        await flush();
        expect(screen.queryByTestId('ticket-picker-problem')).toBeNull();
    });

    it('offers Authorize for SAML SSO, opening only GitHub\'s own page', async () => {
        const source = fakeTicketSource();
        source.search.mockResolvedValueOnce({
            ok: false,
            failure: { error: 'Resource protected by organization SAML enforcement', code: 'sso-required', sso_url: 'https://github.com/orgs/acme/sso?authorization_request=1' }
        });
        mount(source);
        await flush();
        fireEvent.click(screen.getByTestId('ticket-picker-problem-authorize'));
        expect(source.openURL).toHaveBeenCalledWith('https://github.com/orgs/acme/sso?authorization_request=1');
    });

    it('draws no Authorize at all for an SSO link that is not GitHub\'s', async () => {
        const source = fakeTicketSource();
        source.search.mockResolvedValueOnce({
            ok: false,
            failure: { error: 'SSO', code: 'sso-required', sso_url: 'https://evil.example/sso' }
        });
        mount(source);
        await flush();
        expect(screen.getByTestId('ticket-picker-problem').dataset['code']).toBe('sso-required');
        expect(screen.queryByTestId('ticket-picker-problem-authorize')).toBeNull();
        expect(source.openURL).not.toHaveBeenCalled();
    });

    it('explains an organization\'s OAuth App restriction, with a request link and the token path', async () => {
        const source = fakeTicketSource();
        source.resolve.mockResolvedValueOnce({
            ok: false,
            failure: {
                error: 'acme restricts OAuth App access',
                code: 'org-restricted',
                settings_url: 'https://github.com/settings/connections/applications/abc123'
            }
        });
        const { onOpenSettings, onResolved } = mount(source);
        await flush();
        fireEvent.click(screen.getByTestId('ticket-picker-row-acme/api#418'));
        await flush();
        expect(onResolved).not.toHaveBeenCalled();
        const problem = screen.getByTestId('ticket-picker-problem');
        expect(problem.dataset['code']).toBe('org-restricted');
        expect(problem.textContent).toContain('personal access token');
        fireEvent.click(screen.getByTestId('ticket-picker-problem-request'));
        expect(source.openURL).toHaveBeenCalledWith('https://github.com/settings/connections/applications/abc123');
        fireEvent.click(screen.getByTestId('ticket-picker-problem-settings'));
        expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it('shows a thrown search (a timeout, a dropped connection) as a failure it can retry', async () => {
        const source = fakeTicketSource();
        source.search.mockRejectedValueOnce(new Error("command 'ticket-search' timed out after 30000ms"));
        mount(source);
        await flush();
        expect(screen.getByTestId('ticket-picker-problem').textContent).toContain('timed out');
        expect(screen.getByTestId('ticket-picker-problem-retry')).toBeTruthy();
    });
});

describe('a reconnect', () => {
    it('asks again for a search the dropped connection failed, and leaves GitHub\'s own answers alone', async () => {
        const source = fakeTicketSource();
        source.search.mockRejectedValueOnce(new Error("connection lost before 'ticket-search' was answered"));
        const onResolved = vi.fn();
        const props = { onResolved, onCancel: vi.fn(), onOpenSettings: vi.fn() };
        const { rerender } = render(<TicketPicker source={{ ...source, sessionKey: 'client-1' }} {...props} />);
        await flush();
        expect(screen.getByTestId('ticket-picker-problem')).toBeTruthy();
        rerender(<TicketPicker source={{ ...source, sessionKey: 'client-2' }} {...props} />);
        await flush();
        expect(source.search).toHaveBeenCalledTimes(2);
        expect(screen.queryByTestId('ticket-picker-problem')).toBeNull();

        // A lookup GitHub refused (a code) is not re-asked on the next reconnect…
        source.resolve.mockResolvedValueOnce({ ok: false, failure: { error: 'gone', code: 'not-found' } });
        fireEvent.click(screen.getByTestId('ticket-picker-row-acme/api#418'));
        await flush();
        rerender(<TicketPicker source={{ ...source, sessionKey: 'client-3' }} {...props} />);
        await flush();
        expect(source.resolve).toHaveBeenCalledTimes(1);

        // …but one the connection dropped is, and its answer lands.
        source.resolve.mockRejectedValueOnce(new Error("connection lost before 'ticket-resolve' was answered"));
        fireEvent.click(screen.getByTestId('ticket-picker-row-acme/api#418'));
        await flush();
        rerender(<TicketPicker source={{ ...source, sessionKey: 'client-4' }} {...props} />);
        await flush();
        expect(source.resolve).toHaveBeenCalledTimes(3);
        expect(source.resolve).toHaveBeenLastCalledWith('https://github.com/acme/api/pull/418');
        expect(onResolved).toHaveBeenCalledTimes(1);
    });
});

describe('the readers', () => {
    it('reads a search or resolve reply with the protocol\'s readers, and a failure as one', () => {
        expect(readTicketSearch({ ok: true, sections: [{ id: 'results', items: [ticket(3)] }] })).toMatchObject({ ok: true });
        expect(readTicketSearch({ ok: false, error: 'nope', code: 'not-connected' })).toEqual({
            ok: false,
            failure: { error: 'nope', code: 'not-connected' }
        });
        expect(readTicketSearch({ ok: true })).toMatchObject({ ok: false, failure: { code: null } });
        expect(readTicketResolve(resolveReply(ticket(3)))).toMatchObject({ ok: true, reply: { ticket: { number: 3 } } });
        expect(readTicketResolve({ ok: false, error: 'gone', code: 'not-found' })).toMatchObject({ ok: false, failure: { code: 'not-found' } });
    });

    it('formats a retry time, and reads a status that cannot search', () => {
        expect(formatRetryAfter(9.2)).toBe('10 s');
        expect(formatRetryAfter(61)).toBe('2 min');
        expect(statusProblem(null)?.code).toBe('unavailable');
        expect(statusProblem({ provider: 'github', available: true, connected: true })).toBeNull();
        expect(statusProblem({ provider: 'github', available: false, connected: false, problem: 'unreadable' })?.code).toBe('not-connected');
        expect(statusProblem({ provider: 'github', available: true, connected: false, problem: 'endpoint-mismatch' })).toEqual({
            error: 'The saved GitHub credential is for another GitHub address than this daemon uses.',
            code: 'not-connected'
        });
    });

    it('lists each failure\'s buttons in drawing order', () => {
        expect(ticketProblemButtons({ error: 'x', code: 'not-connected' }, { retry: true })).toEqual(['settings']);
        expect(ticketProblemButtons({ error: 'x', code: 'rate-limited' }, { retry: false })).toEqual([]);
        expect(
            ticketProblemButtons({ error: 'x', code: 'org-restricted', settings_url: 'https://github.com/settings/connections/applications/a' }, { retry: false })
        ).toEqual(['request', 'settings']);
        expect(ticketProblemButtons({ error: 'x', code: null }, { retry: true })).toEqual(['retry']);
    });
});
