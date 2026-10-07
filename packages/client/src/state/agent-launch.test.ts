/**
 * wire-protocol.md §6.3's `agent-launch`, client end (`./agent-launch.ts`), driven with synthetic
 * frames: success draws nothing; a prompt that was not delivered becomes a sticky toast that
 * holds it (`Toast.copyText`), auto-copied only in the window that asked (plan R14), with a title
 * that says whether it was copied or needs a click; and a click on such a toast copies it inside
 * the gesture before dismissing.
 */

import { WS_AGENT_LAUNCH_REASONS, type WsAgentLaunchMessage } from '@kelpi/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    AGENT_LAUNCH_AUTO_COPY_MS,
    PROMPT_EXCERPT_CHARS,
    activateToast,
    agentLaunchProblem,
    agentLaunchToastID,
    createAgentLaunchHandler,
    noteAgentCreateSent,
    offerPromptOfFailedCreate,
    parseAgentLaunch,
    promptExcerpt
} from './agent-launch';
import { createKelpiStore, type Toast } from './store';

const W = 'aaaaaaaa-0000-4000-8000-000000000001';
const P = 'dddddddd-0000-4000-8000-000000000001';
const PROMPT = 'Fix the login timeout.\nThen run the tests.';
const NOW = 1_755_500_000_000;

function frame(patch: Partial<WsAgentLaunchMessage> = {}): Record<string, unknown> {
    return {
        type: 'agent-launch',
        workspaceID: W,
        paneID: P,
        agent: 'claude',
        outcome: 'fallback',
        reason: 'timeout',
        prompt: PROMPT,
        promptFile: '/Users/test/Library/Application Support/kelpid/prompts/p.txt',
        ...patch
    };
}

/** A clipboard writer whose promise the test settles by hand. */
function deferredWriter() {
    const calls: { text: string; resolve: () => void; reject: (error: Error) => void }[] = [];
    const writeText = vi.fn(
        (text: string) =>
            new Promise<void>((resolve, reject) => {
                calls.push({ text, resolve, reject });
            })
    );
    return { writeText, calls };
}

/**
 * A window whose create for W was sent `sentAgo` ms before NOW (`noteAgentCreateSent`, as the
 * create path writes it once the reply names the workspace); null = this window sent none.
 */
function setup(writeText: ((text: string) => Promise<void>) | null, sentAgo: number | null = 2_000) {
    const store = createKelpiStore();
    if (sentAgo !== null) noteAgentCreateSent(store, W, NOW - sentAgo);
    const handle = createAgentLaunchHandler({ store, writeText, now: () => NOW });
    const toasts = (): readonly Toast[] => store.getState().ui.toasts;
    return { store, handle, toasts };
}

const settle = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

describe('parseAgentLaunch', () => {
    it('reads a frame, and nothing that is not one', () => {
        expect(parseAgentLaunch(frame({ broadcast: true }))).toEqual({
            workspaceID: W,
            paneID: P,
            agent: 'claude',
            outcome: 'fallback',
            reason: 'timeout',
            prompt: PROMPT,
            promptFile: '/Users/test/Library/Application Support/kelpid/prompts/p.txt',
            broadcast: true
        });
        expect(parseAgentLaunch({ type: 'clipboard-write', paneID: P })).toBeNull();
        expect(parseAgentLaunch(frame({ paneID: '' }))).toBeNull();
        // A future outcome is not one to guess a UI for.
        expect(parseAgentLaunch({ ...frame(), outcome: 'teleported' })).toBeNull();
    });

    it('keeps a frame from a newer daemon readable: an unknown agent or reason degrades to the generic words', () => {
        const report = parseAgentLaunch({ ...frame(), agent: 'gemini', reason: 'solar-flare', prompt: '   ' });
        expect(report).toMatchObject({ agent: null, reason: null, prompt: null, broadcast: false });
        expect(agentLaunchProblem({ agent: null, outcome: 'fallback', reason: null })).toBe(
            'The agent started, but the prompt could not be pasted.'
        );
        expect(agentLaunchProblem({ agent: null, outcome: 'failed', reason: 'pane-exited' })).toBe(
            'The pane closed before the agent could be started.'
        );
    });

    it('says what happened before the line, and what a missing SessionStart hook means', () => {
        expect(agentLaunchProblem({ agent: 'claude', outcome: 'failed', reason: 'user-typed' })).toBe(
            'Claude Code was not started: something was typed into the pane before Kelpi could type the command that starts it.'
        );
        expect(agentLaunchProblem({ agent: 'codex', outcome: 'failed', reason: 'timeout' })).toBe(
            "Codex was not started: the pane's shell never showed a prompt Kelpi could type the command at."
        );
        expect(agentLaunchProblem({ agent: 'claude', outcome: 'fallback', reason: 'no-session-start' })).toBe(
            'Claude Code started, but Kelpi never heard from its SessionStart hook, so it could not tell when Claude Code was ready for the prompt. Run `kelpi install-hooks` to install the hooks.'
        );
        // None of them falls through to the generic sentence any more.
        for (const reason of ['user-typed', 'timeout'] as const) {
            expect(agentLaunchProblem({ agent: 'claude', outcome: 'failed', reason })).not.toBe('Claude Code was not started.');
        }
    });

    it('has a sentence for every reason the protocol names, on both outcomes', () => {
        for (const reason of WS_AGENT_LAUNCH_REASONS) {
            for (const outcome of ['fallback', 'failed'] as const) {
                const sentence = agentLaunchProblem({ agent: 'codex', outcome, reason });
                expect(sentence).toMatch(/\.$/);
                expect(sentence).toContain('Codex');
            }
        }
    });
});

describe('the agent-launch handler', () => {
    it('draws nothing for a launch that worked', () => {
        const h = setup(vi.fn(async () => {}));
        for (const outcome of ['launched', 'sent', 'prefilled'] as const) {
            const { reason: _none, prompt: _p, promptFile: _f, ...rest } = frame();
            expect(h.handle({ ...rest, outcome })?.outcome).toBe(outcome);
        }
        expect(h.toasts()).toEqual([]);
    });

    it('raises a sticky toast for a fallback, copies the prompt in the window that asked, and says it did', async () => {
        const writer = deferredWriter();
        const h = setup(writer.writeText);
        h.handle(frame());

        // At once: up, holding the prompt, saying "click" until the write lands.
        expect(h.toasts()).toHaveLength(1);
        const raised = h.toasts()[0];
        expect(raised).toMatchObject({
            id: agentLaunchToastID(P),
            title: 'Prompt not delivered to Claude Code: click to copy it',
            copyText: PROMPT,
            workspaceID: W,
            // Not tied to the pane: nothing that clears a pane's notifications may take it away.
            paneID: null
        });
        expect(raised?.body).toBe('Claude Code started, but was not ready for the prompt in time. Paste it in yourself.');
        expect(writer.writeText).toHaveBeenCalledWith(PROMPT);

        writer.calls[0]?.resolve();
        await settle();
        expect(h.toasts()).toHaveLength(1);
        expect(h.toasts()[0]?.title).toBe('Prompt not delivered to Claude Code: copied to the clipboard');
        // Still offers the copy (a click copies again, then dismisses), and still has no timer.
        expect(h.toasts()[0]?.copyText).toBe(PROMPT);
    });

    it('does NOT auto-copy a broadcast: every window got it, so each offers a click instead (R14)', async () => {
        const writer = deferredWriter();
        const h = setup(writer.writeText);
        h.handle(frame({ broadcast: true }));
        await settle();
        expect(writer.writeText).not.toHaveBeenCalled();
        expect(h.toasts()[0]).toMatchObject({
            title: 'Prompt not delivered to Claude Code: click to copy it',
            copyText: PROMPT
        });
    });

    it('keeps saying "click" when the browser refuses the write', async () => {
        const writer = deferredWriter();
        const h = setup(writer.writeText);
        h.handle(frame({ agent: 'codex', reason: 'user-typed' }));
        writer.calls[0]?.reject(new Error('Document is not focused.'));
        await settle();
        expect(h.toasts()[0]?.title).toBe('Prompt not delivered to Codex: click to copy it');
        expect(h.toasts()[0]?.body).toContain('something was typed into the pane first');
    });

    it('does not bring back a toast the user dismissed before the write landed', async () => {
        const writer = deferredWriter();
        const h = setup(writer.writeText);
        h.handle(frame());
        h.store.getState().dismissToast(agentLaunchToastID(P));
        writer.calls[0]?.resolve();
        await settle();
        expect(h.toasts()).toEqual([]);
    });

    it('names a launch that never happened, and offers its prompt the same way', () => {
        const h = setup(vi.fn(async () => {}));
        h.handle(frame({ outcome: 'failed', reason: 'unsupported-shell', agent: 'codex' }));
        expect(h.toasts()[0]).toMatchObject({
            title: 'Codex not started: click to copy the prompt',
            copyText: PROMPT
        });
        expect(h.toasts()[0]?.body).toBe(
            "Codex was not started: Send immediately needs the pane's shell to be zsh, bash, sh, dash, ksh or fish. Start Codex and paste it in."
        );
    });

    it('a failure with no prompt is reported without a copy', () => {
        const h = setup(vi.fn(async () => {}));
        const { prompt: _p, promptFile: _f, ...rest } = frame();
        h.handle({ ...rest, outcome: 'failed', reason: 'pane-exited' });
        expect(h.toasts()[0]).toMatchObject({
            title: 'Claude Code not started',
            body: 'The pane closed before Claude Code could be started.'
        });
        expect(h.toasts()[0]?.copyText).toBeUndefined();
    });

    it('with no clipboard API at all (plain HTTP), shows the opening of the prompt and where the rest is', () => {
        const h = setup(null);
        const long = `${'word '.repeat(80)}END`;
        h.handle(frame({ prompt: long }));
        const toast = h.toasts()[0];
        expect(toast?.title).toBe('Prompt not delivered to Claude Code');
        expect(toast?.copyText).toBeUndefined();
        expect(toast?.body).toContain(`It begins: "${promptExcerpt(long)}"`);
        expect(toast?.body).toContain('saved in /Users/test/Library/Application Support/kelpid/prompts/p.txt');
        expect(promptExcerpt(long)).toHaveLength(PROMPT_EXCERPT_CHARS + 1);
        expect(promptExcerpt(long).endsWith('…')).toBe(true);
        expect(promptExcerpt('a\n\n  b')).toBe('a b');
    });

    it('does not auto-copy for a create this window has no note of', async () => {
        const writer = deferredWriter();
        const h = setup(writer.writeText, null);
        h.handle(frame());
        await settle();
        expect(writer.writeText).not.toHaveBeenCalled();
        expect(h.toasts()[0]?.title).toBe('Prompt not delivered to Claude Code: click to copy it');
    });

    it('does not auto-copy once AGENT_LAUNCH_AUTO_COPY_MS has passed since the create was sent', async () => {
        const writer = deferredWriter();
        const late = setup(writer.writeText, AGENT_LAUNCH_AUTO_COPY_MS + 1);
        late.handle(frame());
        await settle();
        expect(writer.writeText).not.toHaveBeenCalled();
        expect(late.toasts()[0]).toMatchObject({ title: 'Prompt not delivered to Claude Code: click to copy it', copyText: PROMPT });

        const edge = setup(writer.writeText, AGENT_LAUNCH_AUTO_COPY_MS);
        edge.handle(frame());
        expect(writer.writeText).toHaveBeenCalledTimes(1);
    });

    it('never auto-copies for a daemon that is stopping, however recent the create', async () => {
        const writer = deferredWriter();
        const h = setup(writer.writeText, 0);
        h.handle(frame({ reason: 'daemon-stopping' }));
        h.handle(frame({ outcome: 'failed', reason: 'daemon-stopping', paneID: 'other-pane' }));
        await settle();
        expect(writer.writeText).not.toHaveBeenCalled();
        expect(h.toasts()).toHaveLength(2);
    });

    it('uses a note once: the launch has one frame, so a second for the workspace does not copy', async () => {
        const writer = deferredWriter();
        const h = setup(writer.writeText);
        const { reason: _none, prompt: _p, promptFile: _f, ...rest } = frame();
        h.handle({ ...rest, outcome: 'prefilled' });
        h.handle(frame());
        await settle();
        expect(writer.writeText).not.toHaveBeenCalled();
    });

    it('replaces, never stacks, a second frame for the same pane', () => {
        const h = setup(vi.fn(async () => {}));
        h.handle(frame({ broadcast: true }));
        h.handle(frame({ broadcast: true, reason: 'agent-exited' }));
        expect(h.toasts()).toHaveLength(1);
        expect(h.toasts()[0]?.body).toContain('exited before it was ready');
    });
});

describe('a create that failed outright (offerPromptOfFailedCreate)', () => {
    it('offers a non-blank prompt back, auto-copied, and nothing for a blank one', async () => {
        const writer = deferredWriter();
        const store = createKelpiStore();
        expect(offerPromptOfFailedCreate(store, { kind: 'claude', prompt: ' \n' }, 'nope', writer.writeText)).toBeNull();
        expect(store.getState().ui.toasts).toEqual([]);
        const toast = offerPromptOfFailedCreate(store, { kind: 'codex', prompt: PROMPT }, 'another create is already making it.', writer.writeText);
        expect(toast).toMatchObject({
            title: 'Workspace not created: click to copy the prompt',
            body: 'another create is already making it. Codex was not started. Create the workspace again and paste it in.',
            copyText: PROMPT
        });
        expect(writer.writeText).toHaveBeenCalledWith(PROMPT);
    });
});

describe('a click on a toast (activateToast)', () => {
    const plain: Toast = {
        id: 'plain',
        kind: 'info',
        title: 'Hello',
        body: 'world',
        paneID: null,
        workspaceID: null,
        createdAt: NOW
    };
    const copying: Toast = { ...plain, id: 'copying', copyText: PROMPT };

    it('dismisses a plain toast without touching the clipboard', () => {
        const store = createKelpiStore();
        store.getState().pushToast(plain);
        const writeText = vi.fn(async () => {});
        activateToast(store, plain, writeText);
        expect(writeText).not.toHaveBeenCalled();
        expect(store.getState().ui.toasts).toEqual([]);
    });

    it('starts the write inside the click, and dismisses once it lands', async () => {
        const store = createKelpiStore();
        store.getState().pushToast(copying);
        const writer = deferredWriter();
        activateToast(store, copying, writer.writeText);
        // Synchronously, inside the gesture: this is what the browser checks.
        expect(writer.writeText).toHaveBeenCalledWith(PROMPT);
        expect(store.getState().ui.toasts).toHaveLength(1);
        writer.calls[0]?.resolve();
        await settle();
        expect(store.getState().ui.toasts).toEqual([]);
    });

    it('a refused write keeps the toast, now showing the prompt and no longer offering a copy', async () => {
        const store = createKelpiStore();
        store.getState().pushToast(copying);
        const writer = deferredWriter();
        activateToast(store, copying, writer.writeText);
        writer.calls[0]?.reject(new Error('NotAllowedError'));
        await settle();
        const toast = store.getState().ui.toasts[0];
        expect(toast?.title).toBe('Could not copy the prompt');
        expect(toast?.body).toContain('Fix the login timeout. Then run the tests.');
        expect(toast?.copyText).toBeUndefined();
        // So the next click just dismisses it.
        if (toast !== undefined) activateToast(store, toast, writer.writeText);
        expect(store.getState().ui.toasts).toEqual([]);
    });

    it('dismisses when this page has no clipboard to write', () => {
        const store = createKelpiStore();
        store.getState().pushToast(copying);
        activateToast(store, copying, null);
        expect(store.getState().ui.toasts).toEqual([]);
    });
});
