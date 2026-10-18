/**
 * shell-ui.md §10.1's From ticket, through the workspaces actions (docs/integrations.md;
 * wire-protocol.md §6.3): what reaches `workspace-create` for a ticket with and without a
 * worktree, the other repositories associated afterwards, a refusal's `ticket_error` handed back
 * to the sheet in a shape it can show, the notes a successful create leaves as a toast (no
 * ticket file, warnings, or no ticket at all from an older daemon), and ⌥⌘N's request.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandReply } from '../connection';
import { createKelpiStore } from '../state';
import { useWorkspacesFeatureLifecycle } from './workspaces';
import { createFailureOf, createWorkspacesActions, ticketCreateNotes, type WorkspacesActionHost } from './workspaces-actions';

type Commands = WorkspacesActionHost['commands'];

const CREATED = 'aaaaaaaa-0000-4000-8000-000000000009';
const URL = 'https://github.com/acme/api/issues/12';
const TICKET_ECHO = {
    provider: 'github',
    kind: 'issue',
    repo: 'acme/api',
    number: 12,
    key: '#12',
    url: URL,
    title: 'Crash on start'
};

afterEach(() => {
    vi.restoreAllMocks();
});

function setup(reply: CommandReply = { ok: true, workspace_id: CREATED, ticket: TICKET_ECHO, checkout: 'existing-checkout' }) {
    const store = createKelpiStore();
    const createWorkspace = vi.fn<Commands['createWorkspace']>(async () => reply);
    const addRepoAssociation = vi.fn<Commands['addRepoAssociation']>(async () => ({ ok: true }));
    const notifyFailure = vi.fn();
    const activateWorkspaceAndReveal = vi.fn();
    const setSidebarVisible = vi.fn();
    const lifecycle = renderHook(useWorkspacesFeatureLifecycle);
    const actions = createWorkspacesActions({
        store,
        commands: { createWorkspace, addRepoAssociation } as unknown as Commands,
        run: vi.fn(() => true as const),
        notifyFailure,
        activateWorkspaceAndReveal,
        setSidebarVisible,
        lifecycle: lifecycle.result.current
    });
    const sent = (): Record<string, unknown> => (createWorkspace.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
    return { store, createWorkspace, addRepoAssociation, notifyFailure, activateWorkspaceAndReveal, setSidebarVisible, actions, sent, lifecycle };
}

describe('a ticket create with no worktree', () => {
    it('sends the checkout as `repo`, the ticket with ticket_defaults false, and its request id', async () => {
        const h = setup();
        const failure = await h.actions.createWorkspaceFromTicket(
            '#12 Crash on start',
            null,
            { ref: URL, repoPath: '/src/api', requestID: 'req-1' },
            { groupDefaults: false, repoPaths: ['/src/web'], agent: { kind: 'claude', prompt: 'Work on #12', send: false } }
        );
        expect(failure).toBeNull();
        expect(h.sent()).toEqual({
            name: '#12 Crash on start',
            repo: '/src/api',
            groupDefaults: false,
            requestID: 'req-1',
            startAgent: 'claude',
            agentPrompt: 'Work on #12',
            ticket: URL,
            ticketDefaults: false
        });
        // Never `path`: the daemon associates the checkout and writes the ticket file into it.
        expect(h.sent()).not.toHaveProperty('path');
        expect(h.activateWorkspaceAndReveal).toHaveBeenCalledWith(CREATED);
        // Only the OTHER chosen repositories are associated afterwards.
        expect(h.addRepoAssociation.mock.calls.map((call) => call[0])).toEqual([{ workspaceID: CREATED, path: '/src/web' }]);
    });

    it('routes the create\'s progress frames, parsed, to the sheet', async () => {
        const h = setup();
        const onProgress = vi.fn();
        h.createWorkspace.mockImplementationOnce(async (_input, options) => {
            options?.onProgress?.({ kind: 'worktree-create', steps: [{ id: 'ticket', status: 'running' }], checkout: 'existing-checkout' });
            options?.onProgress?.({ kind: 'not-a-create' });
            return { ok: true, workspace_id: CREATED, ticket: TICKET_ECHO };
        });
        await h.actions.createWorkspaceFromTicket('x', null, { ref: URL, repoPath: '/src/api', onProgress });
        expect(onProgress).toHaveBeenCalledTimes(1);
        expect(onProgress).toHaveBeenCalledWith({
            steps: [{ id: 'ticket', status: 'running' }],
            cancelled: false,
            detailed: true,
            checkout: 'existing-checkout'
        });
    });

    it('hands a ticket refusal back as the message plus the failure the sheet shows', async () => {
        const h = setup({
            ok: false,
            error: 'acme requires SAML SSO',
            ticket_error: 'sso-required',
            sso_url: 'https://github.com/orgs/acme/sso'
        });
        const failure = await h.actions.createWorkspaceFromTicket('x', null, { ref: URL, repoPath: '/src/api' });
        expect(failure).toEqual({
            error: 'acme requires SAML SSO',
            ticket: { error: 'acme requires SAML SSO', code: 'sso-required', sso_url: 'https://github.com/orgs/acme/sso' }
        });
        expect(h.activateWorkspaceAndReveal).not.toHaveBeenCalled();
    });

    it('hands any other refusal back as its message alone', async () => {
        const h = setup({ ok: false, error: 'worktree create cancelled' });
        expect(await h.actions.createWorkspaceFromTicket('x', null, { ref: URL, repoPath: '/src/api' })).toBe('worktree create cancelled');
        h.createWorkspace.mockRejectedValueOnce(new Error('connection lost'));
        expect(await h.actions.createWorkspaceFromTicket('x', null, { ref: URL, repoPath: '/src/api' })).toBe('connection lost');
    });
});

describe('a ticket create with a worktree', () => {
    it('adds the ticket, with ticket_defaults false, to the worktree create', async () => {
        const h = setup({ ok: true, workspace_id: CREATED, ticket: { ...TICKET_ECHO, kind: 'pr' }, checkout: 'pr-head' });
        const failure = await h.actions.createWorkspaceWithWorktree(
            '#418 Retry',
            null,
            { repoID: 'r1', name: 'fix-login', branch: 'fix/login', updateMain: false, requestID: 'req-2' },
            '/src/api',
            { ticket: { ref: 'https://github.com/acme/api/pull/418' } }
        );
        expect(failure).toBeNull();
        expect(h.sent()).toMatchObject({
            repo: '/src/api',
            worktree: 'fix-login',
            branch: 'fix/login',
            updateMain: false,
            requestID: 'req-2',
            ticket: 'https://github.com/acme/api/pull/418',
            ticketDefaults: false
        });
    });

    it('hands a ticket refusal back in the shape the sheet shows', async () => {
        const h = setup({ ok: false, error: 'GitHub is not connected', ticket_error: 'not-connected' });
        const failure = await h.actions.createWorkspaceWithWorktree(
            'x',
            null,
            { repoID: 'r1', name: 'x', branch: 'x', updateMain: true },
            '/src/api',
            { ticket: { ref: URL } }
        );
        expect(failure).toEqual({ error: 'GitHub is not connected', ticket: { error: 'GitHub is not connected', code: 'not-connected' } });
    });

    it('does not read a plain worktree create\'s refusal as a ticket failure', async () => {
        const h = setup({ ok: false, error: 'branch exists', ticket_error: 'not-found' });
        const failure = await h.actions.createWorkspaceWithWorktree('x', null, { repoID: 'r1', name: 'x', branch: 'x', updateMain: true }, '/src/api');
        expect(failure).toBe('branch exists');
    });
});

// app-state-core.md §2.9: "New Nested Workspace…" raises the same sheet, From ticket included.
describe('a nested ticket create', () => {
    it('sends the parent with or without a worktree, and never a group', async () => {
        const h = setup();
        expect(
            await h.actions.createWorkspaceFromTicket('#12 Crash on start', null, { ref: URL, repoPath: '/src/api' }, { parentID: 'P1' })
        ).toBeNull();
        expect(h.sent()).toMatchObject({ repo: '/src/api', parent: 'P1', ticket: URL, ticketDefaults: false });
        expect(h.sent()).not.toHaveProperty('group');

        expect(
            await h.actions.createWorkspaceWithWorktree(
                '#12 Crash on start',
                null,
                { repoID: 'r1', name: '12-crash', branch: '12-crash', updateMain: true },
                '/src/api',
                { parentID: 'P1', ticket: { ref: URL } }
            )
        ).toBeNull();
        expect(h.sent()).toMatchObject({ worktree: '12-crash', parent: 'P1', ticket: URL, ticketDefaults: false });
        expect(h.sent()).not.toHaveProperty('group');
    });
});

describe('what a ticket create leaves behind', () => {
    it('raises one sticky toast for a missing ticket file and the warnings', async () => {
        const h = setup({
            ok: true,
            workspace_id: CREATED,
            ticket: TICKET_ECHO,
            checkout: 'new-branch',
            ticket_file_error: '.kelpi is tracked by this repository',
            warnings: ['The head could not be fast-forwarded.']
        });
        await h.actions.createWorkspaceFromTicket('x', null, { ref: URL, repoPath: '/src/api' });
        const toasts = h.store.getState().ui.toasts;
        expect(toasts).toHaveLength(1);
        expect(toasts[0]).toMatchObject({ id: `ticket-create-${CREATED}`, title: 'Created from #12, with notes', workspaceID: CREATED });
        expect(toasts[0]?.body).toBe(
            "No ticket file was written: .kelpi is tracked by this repository. The agent's prompt names the ticket's link instead.\nThe head could not be fast-forwarded."
        );
    });

    it('says nothing when there is nothing to say', async () => {
        const h = setup();
        await h.actions.createWorkspaceFromTicket('x', null, { ref: URL, repoPath: '/src/api' });
        expect(h.store.getState().ui.toasts).toEqual([]);
    });

    it('tells the user when an older daemon made a plain workspace instead', async () => {
        const h = setup({ ok: true, workspace_id: CREATED });
        await h.actions.createWorkspaceWithWorktree('x', null, { repoID: 'r1', name: 'x', branch: 'x', updateMain: true }, '/src/api', {
            ticket: { ref: URL }
        });
        expect(h.store.getState().ui.toasts[0]?.title).toBe('This daemon cannot start workspaces from tickets');
    });

    it('reads the notes and the failure as pure functions too', () => {
        expect(ticketCreateNotes({ ok: true, ticket: TICKET_ECHO, warnings: ['', 7, 'w'] })).toEqual({
            title: 'Created from #12, with notes',
            lines: ['w']
        });
        expect(createFailureOf({ ok: false, error: 'x', ticket_error: 'brand-new-code' }, true)).toEqual({
            error: 'x',
            ticket: { error: 'x', code: null }
        });
        expect(createFailureOf({ ok: false, error: 'x' }, true)).toBe('x');
    });
});

describe('⌥⌘N (new_workspace_from_ticket)', () => {
    it('asks for the workspace sheet with its ticket picker up, and shows the sidebar', () => {
        const h = setup();
        act(() => {
            h.actions.newWorkspaceFromTicket();
        });
        expect(h.setSidebarVisible).toHaveBeenCalledWith(true);
        h.lifecycle.rerender();
        expect(h.lifecycle.result.current.sidebarCreateRequest).toMatchObject({ kind: 'workspace', groupID: null, fromTicket: true });
        act(() => {
            h.actions.newWorkspace();
        });
        h.lifecycle.rerender();
        expect(h.lifecycle.result.current.sidebarCreateRequest).not.toHaveProperty('fromTicket');
    });
});
