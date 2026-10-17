/**
 * New Workspace from a GitHub ticket, assembled (docs/integrations.md, shell-ui.md §10.1): the
 * real App over a fake socket, with every command answered synthetically. Nothing reaches a daemon
 * or GitHub.
 *
 * What is pinned at this level: ⌥⌘N opens the sheet with the picker up over a daemon that reports
 * GitHub, and is ⌘N over one that does not; the palette's row does the same; the picker's replies
 * come from `ticket-search` / `ticket-resolve`; the create carries the ticket with
 * `ticket_defaults: false`; and Settings ▸ Integrations is wired to the integration verbs, with a
 * link reply's echoed status landing in the store.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { defaultLists, resolveReply, ticket } from './chrome/ticket-fixtures';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const WORKSPACE = 'AAAAAAAA-0000-4000-8000-000000000001';
const CREATED = 'AAAAAAAA-0000-4000-8000-000000000002';
const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const REPO = { id: 'r1', name: 'api', path: '/src/api', worktree_base: '/wt/api', remote_url: 'git@github.com:acme/api.git' };

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

function setup(options: { readonly github?: boolean } = {}) {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const daemon = createDaemonStore(emptyDaemonState('/Users/test'));
    daemon.dispatch({ type: 'create-workspace', id: WORKSPACE, paneID: PANE, name: 'alpha', color: 'blue', now: 1 });
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        store: createKelpiStore(),
        url: 'ws://ticket.test/ws',
        socketFactory: sockets.factory,
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0
    });
    const request = vi.spyOn(runtime.commands, 'raw').mockImplementation(async (payload) => {
        switch (payload['command']) {
            case 'repo-registry':
                return { ok: true, repos: [REPO] } as never;
            case 'ticket-search':
                return defaultLists() as never;
            case 'ticket-resolve':
                return resolveReply(ticket(12, { title: 'Crash on start' })) as never;
            case 'integration-link-token':
                return {
                    ok: true,
                    integrations: [{ provider: 'github', available: true, connected: true, login: 'octo', how: 'token', scopes: ['repo'] }]
                } as never;
            case 'workspace-create':
                return {
                    ok: true,
                    workspace_id: CREATED,
                    workspace_name: String(payload['name'] ?? ''),
                    ticket: { provider: 'github', kind: 'issue', repo: 'acme/api', number: 12, key: '#12', url: 'https://github.com/acme/api/issues/12', title: 'Crash on start' },
                    checkout: 'new-branch'
                } as never;
            case 'plugin':
                return { ok: true, result: payload['action'] === 'identity' ? { daemonID: 'ticket-daemon' } : [] } as never;
            default:
                return { ok: true };
        }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => completeHandshake(sockets.last(), { state: daemon.getState() as unknown as JsonObject }));
    if (options.github !== false) {
        act(() => {
            sockets.last().emit({ type: 'integrations-changed', integrations: [{ provider: 'github', available: true, connected: true, login: 'octo', how: 'oauth', scopes: ['repo'] }] });
        });
    }
    return {
        runtime,
        sent: (command: string) => request.mock.calls.filter(([payload]) => payload['command'] === command).map(([payload]) => payload)
    };
}

const fromTicketChord = (): void => {
    fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true, altKey: true });
};

describe('New Workspace from Ticket, assembled', () => {
    it('⌥⌘N opens the sheet with the picker up, listing the @me tickets', async () => {
        const h = setup();
        fromTicketChord();
        await waitFor(() => expect(screen.getByTestId('new-workspace-ticket-picker-layer')).toBeTruthy());
        await waitFor(() => expect(screen.getByTestId('ticket-picker-row-acme/api#12')).toBeTruthy());
        expect(h.sent('ticket-search')).toEqual([{ command: 'ticket-search', provider: 'github', query: '' }]);
    });

    it('is ⌘N over a daemon that reports no GitHub integration: the sheet, no picker, no From ticket', async () => {
        setup({ github: false });
        fromTicketChord();
        await waitFor(() => expect(screen.getByTestId('new-workspace-sheet')).toBeTruthy());
        expect(screen.queryByTestId('new-workspace-ticket-picker-layer')).toBeNull();
        expect(screen.queryByTestId('new-workspace-from-ticket')).toBeNull();
    });

    it('creates from the picked ticket with ticket_defaults false', async () => {
        const h = setup();
        fromTicketChord();
        const row = await screen.findByTestId('ticket-picker-row-acme/api#12');
        fireEvent.click(row);
        await waitFor(() => expect(screen.getByTestId('new-workspace-ticket')).toBeTruthy());
        expect(h.sent('ticket-resolve')).toEqual([{ command: 'ticket-resolve', ref: 'https://github.com/acme/api/issues/12' }]);
        fireEvent.click(screen.getByTestId('new-workspace-submit'));
        await waitFor(() => expect(h.sent('workspace-create')).toHaveLength(1));
        expect(h.sent('workspace-create')[0]).toMatchObject({
            command: 'workspace-create',
            name: '#12 Crash on start',
            repo: '/src/api',
            worktree: '12-ticket',
            branch: '12-ticket',
            update_main: true,
            ticket: 'https://github.com/acme/api/issues/12',
            ticket_defaults: false,
            group_defaults: false
        });
        await waitFor(() => expect(screen.queryByTestId('new-workspace-sheet')).toBeNull());
        expect(h.runtime.store.getState().ui.activeWorkspaceID).toBe(CREATED);
    });

    it('offers the palette\'s New Workspace from Ticket row, which opens the picker too', async () => {
        setup();
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
        });
        const input = screen.getByTestId('command-palette').querySelector('input') as HTMLInputElement;
        act(() => {
            fireEvent.change(input, { target: { value: 'from ticket' } });
        });
        const row = screen.getAllByTestId('palette-row').find((candidate) => candidate.textContent?.includes('New Workspace from Ticket'));
        expect(row).toBeDefined();
        act(() => {
            fireEvent.click(row as HTMLElement);
        });
        await waitFor(() => expect(screen.getByTestId('new-workspace-ticket-picker-layer')).toBeTruthy());
    });

    it('wires Settings ▸ Integrations to the verbs, and applies a link reply\'s echoed status', async () => {
        const h = setup();
        act(() => {
            h.runtime.store.getState().applyIntegrationsWelcome([{ provider: 'github', available: false, connected: false }], true);
        });
        fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        fireEvent.click(await screen.findByTestId('settings-tab-button-integrations'));
        const field = await screen.findByTestId('integrations-github-token-input');
        fireEvent.change(field, { target: { value: 'ghp_example' } });
        fireEvent.click(screen.getByTestId('integrations-github-token-button'));
        await waitFor(() => expect(h.sent('integration-link-token')).toEqual([{ command: 'integration-link-token', provider: 'github', token: 'ghp_example' }]));
        await waitFor(() => expect(h.runtime.store.getState().integrations.providers[0]).toMatchObject({ connected: true, login: 'octo', how: 'token' }));
    });
});
