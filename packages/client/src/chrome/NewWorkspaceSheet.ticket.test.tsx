/**
 * shell-ui.md §10.1's From ticket (docs/integrations.md): the New Workspace sheet starting a
 * workspace from a GitHub issue or pull request, over a synthetic `TicketSource`.
 *
 * What is pinned: the button exists only where the host offers tickets; the picker is a sub-sheet
 * closed innermost first; a resolved ticket prefills each checkout mode the way the daemon's
 * defaults say (a new branch for an issue, a pull request's head with no Update main, an existing
 * checkout with no worktree), the prompt included even while the Agent is None; the chip's ✕ drops
 * the link and nothing else; the "already open" banner and the resolve's warnings; the Tab loop's
 * new stops; what the draft carries; the progress checklist a ticket create starts with; and a
 * create refused because of its ticket showing that failure's way out.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewEntrySheet, type NewEntryDraft, type NewEntrySheetProps } from './NewWorkspaceSheet';
import { fakeTicketSource, resolveReply, ticket, type FakeTicketSource } from './ticket-fixtures';
import type { ChromeRepo, CreateFailure } from './types';

afterEach(cleanup);

const REPOS: ChromeRepo[] = [
    { id: 'r1', name: 'api', path: '/src/api', worktreeBase: '/wt/api' },
    { id: 'r2', name: 'web', path: '/src/web', worktreeBase: '/wt/web' }
];

async function flush(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

interface Mounted {
    readonly drafts: NewEntryDraft[];
    readonly onCancel: ReturnType<typeof vi.fn>;
    readonly source: FakeTicketSource;
}

function mount(
    options: {
        readonly source?: FakeTicketSource | null;
        readonly props?: Partial<NewEntrySheetProps>;
        readonly submit?: (draft: NewEntryDraft) => Promise<CreateFailure | null>;
    } = {}
): Mounted {
    const drafts: NewEntryDraft[] = [];
    const onCancel = vi.fn();
    const source = options.source === undefined ? fakeTicketSource() : options.source;
    render(
        <NewEntrySheet
            kind="workspace"
            repos={REPOS}
            onCancel={onCancel}
            onSubmit={async (draft) => {
                drafts.push(draft);
                return options.submit === undefined ? null : options.submit(draft);
            }}
            {...(source === null ? {} : { tickets: source })}
            {...options.props}
        />
    );
    return { drafts, onCancel, source: source ?? fakeTicketSource() };
}

/** From ticket… → the picker's default lists → click a row → the resolve lands. */
async function pick(rowTestID: string): Promise<void> {
    fireEvent.click(screen.getByTestId('new-workspace-from-ticket'));
    await flush();
    fireEvent.click(screen.getByTestId(rowTestID));
    await flush();
}

const value = (testID: string): string => (screen.getByTestId(testID) as HTMLInputElement).value;
const checked = (testID: string): boolean => (screen.getByTestId(testID) as HTMLInputElement).checked;

describe('From ticket… (shell-ui.md §10.1)', () => {
    it('is offered only where the host offers tickets, and never on the New Group sheet', () => {
        mount({ source: null });
        expect(screen.queryByTestId('new-workspace-from-ticket')).toBeNull();
        cleanup();
        render(<NewEntrySheet kind="group" tickets={fakeTicketSource()} onCancel={vi.fn()} onSubmit={async () => null} />);
        expect(screen.queryByTestId('new-workspace-from-ticket')).toBeNull();
        cleanup();
        mount();
        expect(screen.getByTestId('new-workspace-from-ticket').textContent).toBe('From ticket…');
    });

    it('opens the picker as a sub-sheet that Escape closes first, giving the caret back to the button', async () => {
        const { onCancel } = mount();
        fireEvent.click(screen.getByTestId('new-workspace-from-ticket'));
        await flush();
        expect(screen.getByTestId('new-workspace-ticket-picker-layer')).toBeTruthy();
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByTestId('new-workspace-ticket-picker-layer')).toBeNull();
        expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy();
        expect(onCancel).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-from-ticket'));
        // A second Escape is the sheet's.
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('closes only the picker on a click on its own dimming layer', async () => {
        const { onCancel } = mount();
        fireEvent.click(screen.getByTestId('new-workspace-from-ticket'));
        await flush();
        fireEvent.mouseDown(screen.getByTestId('new-workspace-ticket-picker-layer'));
        expect(screen.queryByTestId('new-workspace-ticket-picker-layer')).toBeNull();
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('opens with the picker already up for ⌥⌘N, its field holding the caret', async () => {
        mount({ props: { openTicketPicker: true } });
        await flush();
        expect(screen.getByTestId('new-workspace-ticket-picker-layer')).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByTestId('ticket-picker-search'));
    });
});

describe('the prefill, per checkout mode', () => {
    it('an issue: name, its repository, a worktree on a new branch off latest main', async () => {
        mount();
        await pick('ticket-picker-row-acme/api#12');
        expect(screen.queryByTestId('new-workspace-ticket-picker-layer')).toBeNull();
        expect((screen.getByLabelText('New workspace name') as HTMLInputElement).value).toBe('#12 Crash on start');
        expect(screen.getByTestId('new-workspace-repo-remove-r1')).toBeTruthy();
        expect(checked('new-workspace-worktree-toggle')).toBe(true);
        expect(value('new-workspace-worktree-name')).toBe('12-ticket');
        expect(value('new-workspace-worktree-branch')).toBe('12-ticket');
        expect(checked('new-workspace-worktree-update-main')).toBe(true);
        expect(screen.getByTestId('new-workspace-ticket').textContent).toContain('#12');
        // Every field the prefill set is the user's now: renaming does not re-follow.
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'Something else' } });
        expect(value('new-workspace-worktree-name')).toBe('12-ticket');
    });

    it('a pull request: its head branch, editable, and no Update main', async () => {
        const pr = ticket(418, { kind: 'pr', title: 'Retry login on 401' });
        const { drafts } = mount({ source: fakeTicketSource({ resolved: resolveReply(pr) }) });
        await pick('ticket-picker-row-acme/api#418');
        expect(value('new-workspace-worktree-branch')).toBe('fix/login');
        expect(screen.queryByTestId('new-workspace-worktree-update-main')).toBeNull();
        expect(screen.getByTestId('new-workspace-worktree-preview').textContent).toContain('branch: fix/login (tracks the pull request)');
        // Editable (Q7 in the plan's owner questions: yes).
        fireEvent.change(screen.getByTestId('new-workspace-worktree-branch'), { target: { value: 'fix/login-2' } });
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        expect(drafts[0]?.worktree).toMatchObject({ repoID: 'r1', name: 'fix-login', branch: 'fix/login-2', updateMain: false });
        expect(drafts[0]?.ticket).toEqual({ ref: 'https://github.com/acme/api/pull/418' });
    });

    it('keeps a pull request head\'s own spelling, which the worktree-name sanitizer would rewrite', async () => {
        const pr = ticket(418, { kind: 'pr' });
        const { drafts } = mount({ source: fakeTicketSource({ resolved: resolveReply(pr, { branch: 'feat/c++#2' }) }) });
        await pick('ticket-picker-row-acme/api#418');
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        expect(drafts[0]?.worktree?.branch).toBe('feat/c++#2');
    });

    it('an existing checkout: no worktree, and a line saying where it opens and why', async () => {
        const issue = ticket(12, { title: 'Crash on start' });
        const resolved = resolveReply(issue, { checkout: 'existing-checkout', worktree: null, branch: '12-ticket', update_main: false }, { checked_out_at: '/wt/api/12-ticket' });
        const { drafts } = mount({ source: fakeTicketSource({ resolved }) });
        await pick('ticket-picker-row-acme/api#12');
        expect(checked('new-workspace-worktree-toggle')).toBe(false);
        expect(screen.getByTestId('new-workspace-ticket-open-at').textContent).toBe(
            'Opens a workspace at /wt/api/12-ticket, where its branch is already checked out.'
        );
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        expect(drafts[0]?.worktree).toBeUndefined();
        expect(drafts[0]?.ticket).toMatchObject({ ref: issue.url, repoPath: '/wt/api/12-ticket' });
        expect(typeof drafts[0]?.ticket?.requestID).toBe('string');
        // The checkout rides as `repo`, so the repository is not associated a second time.
        expect(drafts[0]?.repoPaths).toEqual([]);
    });

    it('an issue with the worktree turned off opens in the repository, sent as the ticket\'s checkout', async () => {
        const { drafts } = mount();
        await pick('ticket-picker-row-acme/api#12');
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        expect(screen.getByTestId('new-workspace-ticket-open-at').textContent).toBe('Opens a workspace at /src/api.');
        fireEvent.click(screen.getByTestId('new-workspace-add-repo'));
        fireEvent.click(screen.getByTestId('repo-choice-r2'));
        fireEvent.click(screen.getByTestId('repo-picker-choose'));
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        expect(drafts[0]?.ticket?.repoPath).toBe('/src/api');
        // Only the OTHER repository is associated afterwards.
        expect(drafts[0]?.repoPaths).toEqual(['/src/web']);
    });

    it('waits for a repository when the ticket\'s was removed and no worktree is made', async () => {
        mount();
        await pick('ticket-picker-row-acme/api#12');
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        fireEvent.click(screen.getByTestId('new-workspace-repo-remove-r1'));
        expect(screen.getByTestId('new-workspace-ticket-needs-repo')).toBeTruthy();
        expect((screen.getByTestId('new-workspace-submit') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('the prompt', () => {
    it('is filled from the ticket even while the Agent is None, so choosing one later has it', async () => {
        const { drafts } = mount({ props: { defaultAgent: 'none' } });
        await pick('ticket-picker-row-acme/api#12');
        fireEvent.change(screen.getByTestId('new-workspace-agent'), { target: { value: 'claude' } });
        expect((screen.getByTestId('new-workspace-agent-prompt') as HTMLTextAreaElement).value).toBe(
            'Work on #12: Crash on start (https://github.com/acme/api/issues/12).'
        );
        fireEvent.change(screen.getByTestId('new-workspace-agent'), { target: { value: 'none' } });
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        // None sends no agent at all; the prompt only waited in the box.
        expect(drafts[0]?.agent).toBeNull();
    });

    it('never replaces a prompt the user wrote', async () => {
        mount({ props: { defaultAgent: 'claude' } });
        fireEvent.change(screen.getByTestId('new-workspace-agent-prompt'), { target: { value: 'my words' } });
        await pick('ticket-picker-row-acme/api#12');
        expect((screen.getByTestId('new-workspace-agent-prompt') as HTMLTextAreaElement).value).toBe('my words');
    });

    it('replaces the previous ticket\'s prompt when another ticket is picked', async () => {
        const { source } = mount({ props: { defaultAgent: 'claude' } });
        await pick('ticket-picker-row-acme/api#12');
        source.resolve.mockResolvedValueOnce({ ok: true, reply: resolveReply(ticket(418, { kind: 'pr', title: 'Retry login on 401' })) });
        await pick('ticket-picker-row-acme/api#418');
        expect((screen.getByTestId('new-workspace-agent-prompt') as HTMLTextAreaElement).value).toBe(
            'Work on #418: Retry login on 401 (https://github.com/acme/api/pull/418).'
        );
        expect(screen.getByTestId('new-workspace-ticket').textContent).toContain('#418');
    });
});

describe('the ticket chip, banner and warnings', () => {
    it('✕ drops the link and keeps every field', async () => {
        const { drafts } = mount();
        await pick('ticket-picker-row-acme/api#12');
        fireEvent.click(screen.getByTestId('new-workspace-ticket-clear'));
        expect(screen.queryByTestId('new-workspace-ticket')).toBeNull();
        expect((screen.getByLabelText('New workspace name') as HTMLInputElement).value).toBe('#12 Crash on start');
        expect(value('new-workspace-worktree-name')).toBe('12-ticket');
        expect(document.activeElement).toBe(screen.getByLabelText('New workspace name'));
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        expect(drafts[0]?.ticket).toBeNull();
    });

    it('says where the ticket is already open and offers to switch, leaving Create enabled', async () => {
        const resolved = resolveReply(ticket(12, { title: 'Crash on start' }), {}, { existing: [{ workspace_id: 'w9', reason: 'ticket' }, { workspace_id: 'w8', reason: 'branch' }] });
        const source = fakeTicketSource({ resolved, names: { w9: 'Crash fix', w8: 'Other' } });
        const { onCancel } = mount({ source });
        await pick('ticket-picker-row-acme/api#12');
        expect(screen.getByTestId('new-workspace-ticket-existing').textContent).toContain('#12 is already open in Crash fix (and 1 more).');
        expect((screen.getByTestId('new-workspace-submit') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(screen.getByTestId('new-workspace-ticket-switch'));
        expect(source.switchToWorkspace).toHaveBeenCalledWith('w9');
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('names a branch match as the branch', async () => {
        const resolved = resolveReply(ticket(12), {}, { existing: [{ workspace_id: 'w8', reason: 'branch' }] });
        mount({ source: fakeTicketSource({ resolved, names: { w8: 'Other' } }) });
        await pick('ticket-picker-row-acme/api#12');
        expect(screen.getByTestId('new-workspace-ticket-existing').textContent).toContain("#12's branch is already open in Other.");
    });

    it('shows the resolve\'s warnings', async () => {
        const resolved = resolveReply(ticket(418, { kind: 'pr' }), {}, { warnings: ['The fork this pull request came from no longer exists.'] });
        mount({ source: fakeTicketSource({ resolved }) });
        await pick('ticket-picker-row-acme/api#418');
        expect(screen.getByTestId('new-workspace-ticket-warning').textContent).toContain('no longer exists');
    });
});

describe('the Tab loop (§WS-077) with a ticket', () => {
    it('leads with From ticket…, then the chip\'s ✕ and the banner\'s Switch, before the name', async () => {
        const resolved = resolveReply(ticket(12), {}, { existing: [{ workspace_id: 'w9', reason: 'ticket' }] });
        mount({ source: fakeTicketSource({ resolved, names: { w9: 'Crash fix' } }) });
        await pick('ticket-picker-row-acme/api#12');
        const name = screen.getByLabelText('New workspace name');
        name.focus();
        fireEvent.keyDown(name, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-ticket-switch'));
        fireEvent.keyDown(document.activeElement as Element, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-ticket-clear'));
        fireEvent.keyDown(document.activeElement as Element, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-from-ticket'));
        // …and it wraps from there to the last stop, Create.
        fireEvent.keyDown(document.activeElement as Element, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-submit'));
    });

    it('has no Update main stop for a pull request', async () => {
        mount({ source: fakeTicketSource({ resolved: resolveReply(ticket(418, { kind: 'pr' })) }) });
        await pick('ticket-picker-row-acme/api#418');
        const branch = screen.getByTestId('new-workspace-worktree-branch');
        branch.focus();
        fireEvent.keyDown(branch, { key: 'Tab' });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-agent'));
    });
});

describe('creating', () => {
    it('starts a pull request\'s checklist with the lookup, labelled for the pull request', async () => {
        mount({
            source: fakeTicketSource({ resolved: resolveReply(ticket(418, { kind: 'pr' })) }),
            submit: () => new Promise(() => {})
        });
        await pick('ticket-picker-row-acme/api#418');
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        const steps = screen.getAllByRole('listitem').map((row) => [row.dataset['testid'] ?? row.getAttribute('data-testid'), row.dataset['status']]);
        expect(steps).toEqual([
            ['new-workspace-step-ticket', 'running'],
            ['new-workspace-step-fetch', 'pending'],
            ['new-workspace-step-worktree-add', 'pending'],
            ['new-workspace-step-create-workspace', 'pending']
        ]);
        expect(screen.getByTestId('new-workspace-step-ticket').textContent).toContain('Look up the ticket');
        expect(screen.getByTestId('new-workspace-step-fetch').textContent).toContain('Fetch the pull request');
        expect(screen.getByTestId('new-workspace-step-worktree-add').textContent).toContain('Check out the pull request');
    });

    it('gives a ticket create with no worktree the lookup and the open steps, and Cancel cancels it', async () => {
        const onCancelCreate = vi.fn();
        const { drafts } = mount({ submit: () => new Promise(() => {}), props: { onCancelCreate } });
        await pick('ticket-picker-row-acme/api#12');
        fireEvent.click(screen.getByTestId('new-workspace-worktree-toggle'));
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        expect(screen.getAllByRole('listitem').map((row) => row.getAttribute('data-testid'))).toEqual([
            'new-workspace-step-ticket',
            'new-workspace-step-create-workspace'
        ]);
        fireEvent.click(screen.getByTestId('new-workspace-cancel'));
        expect(onCancelCreate).toHaveBeenCalledWith(drafts[0]?.ticket?.requestID);
    });

    it('shows a create refused because of its ticket with that failure\'s way out, reachable by Tab', async () => {
        const { source, onCancel } = mount({
            submit: async () => ({
                error: 'Resource protected by organization SAML enforcement',
                ticket: { error: 'Resource protected by organization SAML enforcement', code: 'sso-required', sso_url: 'https://github.com/orgs/acme/sso' }
            })
        });
        await pick('ticket-picker-row-acme/api#12');
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        expect(screen.queryByTestId('new-workspace-error')).toBeNull();
        expect(screen.getByTestId('new-workspace-ticket-problem').dataset['code']).toBe('sso-required');
        const authorize = screen.getByTestId('new-workspace-ticket-problem-authorize');
        fireEvent.click(authorize);
        expect(source.openURL).toHaveBeenCalledWith('https://github.com/orgs/acme/sso');
        // Its button is a stop, just before Cancel.
        authorize.focus();
        fireEvent.keyDown(authorize, { key: 'Tab' });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-cancel'));
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('leaves for Settings ▸ Integrations from a "not connected" refusal, closing the sheet first', async () => {
        const { source, onCancel } = mount({
            submit: async () => ({ error: 'GitHub is not connected', ticket: { error: 'GitHub is not connected', code: 'not-connected' } })
        });
        await pick('ticket-picker-row-acme/api#12');
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await flush();
        fireEvent.click(screen.getByTestId('new-workspace-ticket-problem-settings'));
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(source.openIntegrationSettings).toHaveBeenCalledTimes(1);
    });
});
