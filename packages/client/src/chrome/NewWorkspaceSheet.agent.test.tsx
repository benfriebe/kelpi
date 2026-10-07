/**
 * shell-ui.md §10.1's Agent row (Kelpi addition): start Claude Code or Codex in a new workspace's
 * first pane (wire-protocol.md §6.3 `start_agent`).
 *
 * What is pinned: the row exists on the workspace sheet only, and only over a daemon that can
 * start agents; the Prompt box and "Send immediately" appear once an agent is chosen; the sheet
 * opens on the two config defaults; the draft carries exactly what is shown (null for None); the
 * three stops sit just before Cancel; and the Prompt box is the one place Return types a newline,
 * with ⌘Return / Ctrl+Return submitting from it, while a Return that ends an IME composition
 * submits nothing from anywhere.
 *
 * Driven through `Sidebar`, as every route to the sheet is, except where the draft itself is the
 * subject and `NewEntrySheet` is mounted bare.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NewEntrySheet, type NewEntryDraft, type NewEntrySheetProps } from './NewWorkspaceSheet';
import { Sidebar } from './index';
import type { ChromeSidebarEntry } from './types';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';

const ENTRIES: ChromeSidebarEntry[] = [
    {
        kind: 'workspace',
        workspace: {
            id: W1,
            name: 'alpha',
            color: 'blue',
            icon: null,
            labels: [],
            panes: [
                {
                    id: `${W1}-p1`,
                    type: 'shell',
                    label: null,
                    title: null,
                    workingDirectory: '/src/app',
                    gitBranch: null,
                    status: 'idle',
                    agentSessionID: null,
                    agentKind: null,
                    agentStartedAt: null,
                    backgroundTaskCount: 0
                }
            ]
        }
    }
];

function openSheet(props: Record<string, unknown> = {}) {
    const onCreateWorkspace = vi.fn().mockResolvedValue(null);
    render(
        <Sidebar
            activeWorkspaceID={W1}
            filter=""
            onFilterChange={vi.fn()}
            rowHeight={20}
            entries={ENTRIES}
            onCreateWorkspace={onCreateWorkspace as never}
            onCreateGroup={vi.fn()}
            {...props}
        />
    );
    fireEvent.click(screen.getByTestId('sidebar-new-workspace'));
    return onCreateWorkspace;
}

/** `NewEntrySheet` on its own, for the draft it hands back. */
function mountBare(props: Partial<NewEntrySheetProps> = {}) {
    const drafts: NewEntryDraft[] = [];
    render(
        <NewEntrySheet
            kind="workspace"
            onCancel={vi.fn()}
            onSubmit={async (draft) => {
                drafts.push(draft);
                return null;
            }}
            {...props}
        />
    );
    fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
    return drafts;
}

const agentSelect = (): HTMLSelectElement => screen.getByTestId('new-workspace-agent') as HTMLSelectElement;
const promptBox = (): HTMLTextAreaElement => screen.getByTestId('new-workspace-agent-prompt') as HTMLTextAreaElement;
const sendBox = (): HTMLInputElement => screen.getByTestId('new-workspace-agent-send') as HTMLInputElement;

describe('the Agent row (shell-ui.md §10.1)', () => {
    it('opens on None, with nothing else of the row drawn', () => {
        openSheet();
        expect(agentSelect().value).toBe('none');
        expect([...agentSelect().options].map((option) => [option.value, option.textContent])).toEqual([
            ['none', 'None'],
            ['claude', 'Claude Code'],
            ['codex', 'Codex']
        ]);
        expect(screen.queryByTestId('new-workspace-agent-prompt')).toBeNull();
        expect(screen.queryByTestId('new-workspace-agent-send')).toBeNull();
    });

    it('reveals a four-row, vertically resizable Prompt box and Send immediately once an agent is chosen', () => {
        openSheet();
        fireEvent.change(agentSelect(), { target: { value: 'claude' } });
        expect(promptBox().rows).toBe(4);
        expect(promptBox().style.resize).toBe('vertical');
        expect(promptBox().getAttribute('aria-label')).toBe('Prompt');
        expect(promptBox().placeholder).toContain('Claude Code');
        expect(sendBox().checked).toBe(false);
        // What the box decides, said in words, both ways.
        expect(screen.getByTestId('new-workspace-agent-hint').textContent).toContain("pasted into Claude Code's input");
        fireEvent.click(sendBox());
        expect(screen.getByTestId('new-workspace-agent-hint').textContent).toContain('runs it at once');

        // Back to None hides them; forward again keeps what was typed (a mis-click costs nothing).
        fireEvent.change(promptBox(), { target: { value: 'keep me' } });
        fireEvent.change(agentSelect(), { target: { value: 'none' } });
        expect(screen.queryByTestId('new-workspace-agent-prompt')).toBeNull();
        fireEvent.change(agentSelect(), { target: { value: 'codex' } });
        expect(promptBox().value).toBe('keep me');
    });

    it('opens on `new-workspace-agent` and `new-workspace-send-prompt`', () => {
        openSheet({ defaultAgent: 'codex', defaultSendPrompt: true });
        expect(agentSelect().value).toBe('codex');
        expect(sendBox().checked).toBe(true);
    });

    it('hands the host the chosen agent with its prompt and send choice, and nothing for None', async () => {
        const onCreateWorkspace = openSheet();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.change(agentSelect(), { target: { value: 'claude' } });
        fireEvent.change(promptBox(), { target: { value: '  Fix it\nthen test  ' } });
        fireEvent.click(sendBox());
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await vi.waitFor(() => expect(onCreateWorkspace).toHaveBeenCalledTimes(1));
        // The prompt goes verbatim: the daemon is where it is normalized.
        expect(onCreateWorkspace.mock.calls[0]?.[3]).toMatchObject({
            agent: { kind: 'claude', prompt: '  Fix it\nthen test  ', send: true }
        });

        cleanup();
        const plain = openSheet();
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'ws' } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await vi.waitFor(() => expect(plain).toHaveBeenCalledTimes(1));
        expect(plain.mock.calls[0]?.[3]).not.toHaveProperty('agent');
    });

    it('drafts `agent: null` for None, and the request for an agent', async () => {
        const drafts = mountBare({ defaultAgent: 'codex' });
        fireEvent.change(promptBox(), { target: { value: 'go' } });
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await vi.waitFor(() => expect(drafts).toHaveLength(1));
        expect(drafts[0]?.agent).toEqual({ kind: 'codex', prompt: 'go', send: false });

        cleanup();
        const none = mountBare();
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await vi.waitFor(() => expect(none).toHaveLength(1));
        expect(none[0]?.agent).toBeNull();
    });

    it('is not drawn at all over a daemon that cannot start agents, whatever the default says', async () => {
        const drafts = mountBare({ canStartAgent: false, defaultAgent: 'claude', defaultSendPrompt: true });
        expect(screen.queryByTestId('new-workspace-agent')).toBeNull();
        expect(screen.queryByTestId('new-workspace-agent-prompt')).toBeNull();
        // Nor is it a Tab stop: profile → mute → Cancel → Create.
        const muted = screen.getByTestId('new-workspace-muted');
        muted.focus();
        fireEvent.keyDown(muted, { key: 'Tab' });
        expect(document.activeElement).toBe(screen.getByTestId('new-workspace-cancel'));
        fireEvent.submit(screen.getByTestId('new-workspace-form'));
        await vi.waitFor(() => expect(drafts).toHaveLength(1));
        expect(drafts[0]?.agent).toBeNull();
    });

    it('is not on the New Group sheet', () => {
        render(<Sidebar activeWorkspaceID={W1} filter="" onFilterChange={vi.fn()} rowHeight={20} entries={ENTRIES} onCreateGroup={vi.fn()} defaultAgent="claude" />);
        fireEvent.click(screen.getByTestId('sidebar-new-menu-toggle'));
        fireEvent.click(screen.getByRole('menuitem', { name: /^New Group/ }));
        expect(screen.getByTestId('new-group-sheet')).toBeTruthy();
        expect(screen.queryByLabelText('Agent')).toBeNull();
        expect(screen.queryByTestId('new-workspace-agent')).toBeNull();
    });
});

describe('the Agent row in the Tab loop (§WS-077)', () => {
    it('puts Agent, Prompt and Send immediately just before Cancel, and wraps', () => {
        openSheet({ defaultAgent: 'claude' });
        const name = screen.getByLabelText('New workspace name');
        fireEvent.change(name, { target: { value: 'ws' } }); // enables Create, so it joins
        const muted = screen.getByTestId('new-workspace-muted');
        muted.focus();
        const step = (shiftKey = false): Element | null => {
            fireEvent.keyDown(document.activeElement as Element, { key: 'Tab', shiftKey });
            return document.activeElement;
        };
        expect(step()).toBe(agentSelect());
        // Tab leaves the Prompt box rather than typing a tab character into it.
        expect(step()).toBe(promptBox());
        expect(step()).toBe(sendBox());
        expect(step()).toBe(screen.getByTestId('new-workspace-cancel'));
        expect(step()).toBe(screen.getByTestId('new-workspace-submit'));
        expect(step()).toBe(name);
        expect(step(true)).toBe(screen.getByTestId('new-workspace-submit'));
        expect(step(true)).toBe(screen.getByTestId('new-workspace-cancel'));
        expect(step(true)).toBe(sendBox());
    });
});

describe('Return (M9) and the Prompt box (plan R12)', () => {
    it('Return in the Prompt box is a newline, not a submit', () => {
        const drafts = mountBare({ defaultAgent: 'claude' });
        // `fireEvent` answers false when the handler called preventDefault: here it must not have,
        // or the textarea's own newline would be eaten.
        expect(fireEvent.keyDown(promptBox(), { key: 'Enter' })).toBe(true);
        expect(fireEvent.keyDown(promptBox(), { key: 'Enter', shiftKey: true })).toBe(true);
        expect(drafts).toHaveLength(0);
    });

    it('⌘Return and Ctrl+Return submit from the Prompt box', async () => {
        const drafts = mountBare({ defaultAgent: 'claude' });
        fireEvent.change(promptBox(), { target: { value: 'line one\nline two' } });
        expect(fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true })).toBe(false);
        await vi.waitFor(() => expect(drafts).toHaveLength(1));
        expect(drafts[0]?.agent?.prompt).toBe('line one\nline two');

        cleanup();
        const ctrl = mountBare({ defaultAgent: 'claude' });
        fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true });
        await vi.waitFor(() => expect(ctrl).toHaveLength(1));
    });

    it('Return still submits from everywhere else in the row', async () => {
        const drafts = mountBare({ defaultAgent: 'claude' });
        fireEvent.keyDown(sendBox(), { key: 'Enter' });
        await vi.waitFor(() => expect(drafts).toHaveLength(1));
        cleanup();
        const fromSelect = mountBare({ defaultAgent: 'claude' });
        fireEvent.keyDown(agentSelect(), { key: 'Enter' });
        await vi.waitFor(() => expect(fromSelect).toHaveLength(1));
    });

    it('a Return that ends an IME composition submits nothing, in the Prompt box or the name field', async () => {
        const drafts = mountBare({ defaultAgent: 'claude' });
        const name = screen.getByLabelText('New workspace name');
        fireEvent.keyDown(name, { key: 'Enter', isComposing: true });
        fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true, isComposing: true });
        // WebKit's spelling of the same keystroke: not composing any more, but keyCode 229.
        fireEvent.keyDown(name, { key: 'Enter', keyCode: 229 });
        await Promise.resolve();
        expect(drafts).toHaveLength(0);
        // The next, ordinary Return submits.
        fireEvent.keyDown(name, { key: 'Enter' });
        await vi.waitFor(() => expect(drafts).toHaveLength(1));
    });
});
