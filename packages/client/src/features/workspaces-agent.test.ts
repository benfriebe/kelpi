/**
 * shell-ui.md §10.1's Agent row, through the workspaces actions: what reaches `workspace-create`
 * (wire-protocol.md §6.3) from the plain create and from the worktree create, what never does
 * ("none", a blank prompt, a request that carries no agent), and
 * plan R8's toast when the reply comes back without the `start_agent` echo.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceAgentRequest } from '../chrome';
import type { CommandReply } from '../connection';
import { AGENT_START_UNSUPPORTED_TOAST_ID, createKelpiStore } from '../state';
import { useWorkspacesFeatureLifecycle } from './workspaces';
import { agentCreateFields, createWorkspacesActions, type WorkspacesActionHost } from './workspaces-actions';

type Commands = WorkspacesActionHost['commands'];

const CREATED = 'aaaaaaaa-0000-4000-8000-000000000009';
const CLAUDE: WorkspaceAgentRequest = { kind: 'claude', prompt: 'Fix the login timeout\nthen run the tests', send: false };

/** `navigator.clipboard`, which jsdom does not have: installed per test, removed after. */
function installClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, 'clipboard');
    vi.restoreAllMocks();
});

function setup(reply: CommandReply = { ok: true, workspace_id: CREATED, start_agent: 'claude' }) {
    const store = createKelpiStore();
    const createWorkspace = vi.fn<Commands['createWorkspace']>(async () => reply);
    const addRepoAssociation = vi.fn<Commands['addRepoAssociation']>(async () => ({ ok: true }));
    const notifyFailure = vi.fn();
    const lifecycle = renderHook(useWorkspacesFeatureLifecycle);
    const actions = createWorkspacesActions({
        store,
        commands: { createWorkspace, addRepoAssociation } as unknown as Commands,
        run: vi.fn(() => true as const),
        notifyFailure,
        activateWorkspaceAndReveal: vi.fn(),
        setSidebarVisible: vi.fn(),
        lifecycle: lifecycle.result.current
    });
    const sent = (): Record<string, unknown> => (createWorkspace.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
    return { store, createWorkspace, notifyFailure, actions, sent };
}

describe('the Agent row on the wire (wire-protocol.md §6.3)', () => {
    it('sends the kind and the prompt as typed, and send only when it is ticked', () => {
        const h = setup();
        h.actions.createWorkspace('alpha', null, { agent: CLAUDE });
        expect(h.sent()).toMatchObject({ name: 'alpha', startAgent: 'claude', agentPrompt: CLAUDE.prompt });
        expect(h.sent()).not.toHaveProperty('sendPrompt');

        h.actions.createWorkspace('beta', null, { agent: { kind: 'codex', prompt: '  -v first  ', send: true } });
        // Verbatim: the daemon is the one place a prompt is normalized.
        expect(h.sent()).toMatchObject({ startAgent: 'codex', agentPrompt: '  -v first  ', sendPrompt: true });
    });

    it('sends nothing for no agent, a blank prompt, or a kind the daemon does not know', () => {
        const h = setup();
        // A request with no `agent` at all (the sheet sends none for "None"): the
        // `new-workspace-agent` default is not applied on its behalf.
        h.actions.createWorkspace('plain', null, {});
        expect(Object.keys(h.sent()).filter((key) => /agent|prompt/i.test(key))).toEqual([]);

        h.actions.createWorkspace('bare', null, { agent: { kind: 'claude', prompt: ' \n ', send: true } });
        expect(h.sent()).toMatchObject({ startAgent: 'claude', sendPrompt: true });
        expect(h.sent()).not.toHaveProperty('agentPrompt');

        // "None" is not a kind: even smuggled past the type, it never becomes `start_agent`, and
        // the prompt and send box do not travel without it (the daemon refuses them alone).
        expect(agentCreateFields({ kind: 'none' as never, prompt: 'x', send: true })).toEqual({});
        h.actions.createWorkspace('none', null, { agent: { kind: 'none' as never, prompt: 'x', send: true } });
        expect(Object.keys(h.sent()).filter((key) => /agent|prompt/i.test(key))).toEqual([]);
    });

    it('rides the worktree create too', async () => {
        const h = setup();
        const failure = await h.actions.createWorkspaceWithWorktree(
            'wt',
            null,
            { repoID: 'r1', name: 'wt', branch: 'wt', updateMain: false },
            '/code/app',
            { agent: { ...CLAUDE, send: true } }
        );
        expect(failure).toBeNull();
        expect(h.sent()).toMatchObject({
            repo: '/code/app',
            worktree: 'wt',
            startAgent: 'claude',
            agentPrompt: CLAUDE.prompt,
            sendPrompt: true
        });
        expect(h.store.getState().ui.toasts).toEqual([]);
    });
});

describe('a daemon too old to start agents (plan R8)', () => {
    it('says so when the reply carries no start_agent echo, and offers the prompt', async () => {
        const writeText = vi.fn(async () => {});
        installClipboard(writeText);
        const h = setup({ ok: true, workspace_id: CREATED });
        h.actions.createWorkspace('alpha', null, { agent: CLAUDE });
        await waitFor(() => {
            expect(h.store.getState().ui.toasts.map((toast) => toast.id)).toEqual([AGENT_START_UNSUPPORTED_TOAST_ID]);
        });
        // This IS the window that asked, so the prompt is copied straight away (R14)…
        await waitFor(() => {
            expect(h.store.getState().ui.toasts[0]?.title).toBe(
                'This daemon is too old to start agents: prompt copied to the clipboard'
            );
        });
        expect(writeText).toHaveBeenCalledWith(CLAUDE.prompt);
        const toast = h.store.getState().ui.toasts[0];
        // …and a click copies it again: the text rides the toast.
        expect(toast?.copyText).toBe(CLAUDE.prompt);
        expect(toast?.body).toContain('The workspace was created, but without Claude Code');
        expect(toast?.workspaceID).toBe(CREATED);
    });

    it('shows the opening of the prompt where there is no clipboard to offer, and says so on the worktree path', async () => {
        const h = setup({ ok: true, workspace_id: CREATED });
        await h.actions.createWorkspaceWithWorktree(
            'wt',
            null,
            { repoID: 'r1', name: 'wt', branch: 'wt', updateMain: false },
            '/code/app',
            { agent: CLAUDE }
        );
        const toast = h.store.getState().ui.toasts[0];
        expect(toast?.title).toBe('This daemon is too old to start agents');
        expect(toast?.copyText).toBeUndefined();
        expect(toast?.body).toContain('It begins: "Fix the login timeout then run the tests"');
    });

    it('stays quiet for an echoed reply, a refused create, or a create that asked for no agent', async () => {
        const echoed = setup();
        echoed.actions.createWorkspace('alpha', null, { agent: CLAUDE });
        const refused = setup({ ok: false, error: 'nope' });
        refused.actions.createWorkspace('alpha', null, { agent: CLAUDE });
        const plain = setup({ ok: true, workspace_id: CREATED });
        plain.actions.createWorkspace('alpha', null, {});
        await waitFor(() => expect(refused.notifyFailure).toHaveBeenCalledWith('New workspace', 'nope'));
        await Promise.resolve();
        for (const h of [echoed, refused, plain]) expect(h.store.getState().ui.toasts).toEqual([]);
    });
});
