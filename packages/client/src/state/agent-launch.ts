/**
 * The client end of starting an agent in a new workspace (wire-protocol.md §6.3, shell-ui.md
 * §10.1): what the window says when the daemon could NOT do what the New Workspace sheet asked.
 *
 * A create that names `start_agent` replies before its first pane has even spawned, and the agent
 * becomes ready seconds later, so the daemon reports the outcome on a frame of its own,
 * `agent-launch`, one per launch. Three outcomes are success (`launched`, `sent`, `prefilled`)
 * and need nobody's attention: this module draws nothing for them. The other two do:
 *
 *   - `fallback`: the agent started, but the prompt was NOT pasted into it;
 *   - `failed`: the launch line was never typed, so no agent started at all.
 *
 * Either way a prompt the user wrote has not reached the agent, and the one thing that must not
 * happen is that it is simply lost. So the frame carries the prompt back, and this module puts it
 * where the user can get at it: a STICKY toast (no timer, `agent-launch-<paneID>`, so a repeat
 * replaces rather than stacks; the `persistence-degraded` pattern in `./bridge.ts`) that says what
 * went wrong in words that name the reason, and that holds the prompt as `Toast.copyText`.
 *
 * ## The clipboard (plan R14)
 *
 *   - **Auto-copy only in the window that asked.** A frame WITHOUT `broadcast` went to the session
 *     that sent the create, so that window writes the prompt to its clipboard at once
 *     (`navigator.clipboard.writeText`; Chromium allows it in a focused window). A `broadcast`
 *     frame went to EVERY window (the create came from the CLI, or its window has gone), and N
 *     windows each writing the same clipboard is N writers for one value, so none of them does:
 *     each offers the copy on a click instead.
 *   - **And only soon after the create.** A launch can end long after the user pressed Create
 *     (a trust dialog holds it for up to `AGENT_READY_MAX_WAIT_MS`, ten minutes), and by then
 *     the clipboard holds whatever they copied since. So the window notes when it SENT each
 *     create that asked for an agent (`noteAgentCreateSent`, by the workspace id its reply
 *     named), and copies by itself only within `AGENT_LAUNCH_AUTO_COPY_MS` of that; a frame
 *     later than that, or for a create this window has no note of, offers the click instead.
 *     Never for `daemon-stopping`: that frame comes from a daemon going away, often because the
 *     app is quitting or updating, not from anything the user is waiting on.
 *   - **The title says which.** "...: copied to the clipboard" once the write has landed; "...:
 *     click to copy it" until then, and for good if the browser refused (a phone, an unfocused
 *     window) or the frame was a broadcast. The click is a user gesture, which is what a browser
 *     asks for before it lets a page write (`activateToast` below; `App`'s `ToastStack`).
 *   - **No clipboard at all** (plain HTTP off localhost exposes no `navigator.clipboard`): the
 *     body shows the prompt's first `PROMPT_EXCERPT_CHARS` characters and names the daemon's copy
 *     of it (`promptFile`), since there is nothing a click could do.
 *
 * Nothing here logs the prompt, on any path (wire-protocol.md §6.3: nothing on either side does).
 *
 * The same toast answers R8's "this daemon is too old" case (`reportAgentStartUnsupported`): a
 * create reply without the `start_agent` echo comes from a daemon that dropped the field and made
 * a plain workspace, so the prompt is just as undelivered.
 */

import {
    WS_AGENT_LAUNCH_MESSAGE,
    WS_AGENT_LAUNCH_OUTCOMES,
    WS_AGENT_LAUNCH_REASONS,
    type AgentKind,
    type WsAgentLaunchOutcome,
    type WsAgentLaunchReason
} from '@kelpi/protocol';

import { AGENT_DISPLAY_NAMES } from '../chrome/types';
import { pageClipboardWriter } from './clipboard';
import type { KelpiStoreApi, Toast } from './store';

/** How much of an undelivered prompt a toast shows when it cannot offer a copy. */
export const PROMPT_EXCERPT_CHARS = 240;

/**
 * How long after the window sent a create the outcome of its agent launch may still write the
 * clipboard by itself. A minute covers every launch that is not held by a trust dialog (the
 * daemon gives up on those after 10 s, or 30 s for a shell that never prints).
 */
export const AGENT_LAUNCH_AUTO_COPY_MS = 60_000;

/**
 * The creates this window sent that asked for an agent, per store (one store per daemon
 * connection): workspace id → when the create was SENT. Written by the create path once its
 * reply names the workspace (`noteAgentCreateSent`), read and forgotten by the frame for it. Kept
 * beside the handler rather than in the store, because nothing renders it.
 */
const sentAgentCreates = new WeakMap<KelpiStoreApi, Map<string, number>>();

/**
 * The create this window sent at `sentAt` made `workspaceID` and asked it to start an agent: its
 * `agent-launch` frame may auto-copy until `AGENT_LAUNCH_AUTO_COPY_MS` after `sentAt`.
 */
export function noteAgentCreateSent(store: KelpiStoreApi, workspaceID: string, sentAt: number): void {
    let creates = sentAgentCreates.get(store);
    if (creates === undefined) {
        creates = new Map();
        sentAgentCreates.set(store, creates);
    }
    // A note past its window can no longer allow anything: drop it rather than keep it forever.
    for (const [id, at] of creates) {
        if (sentAt - at > AGENT_LAUNCH_AUTO_COPY_MS) creates.delete(id);
    }
    creates.set(workspaceID, sentAt);
}

/** When this window sent the create for `workspaceID`, forgetting it (one frame per launch). */
function takeAgentCreateSentAt(store: KelpiStoreApi, workspaceID: string): number | null {
    const creates = sentAgentCreates.get(store);
    const sentAt = creates?.get(workspaceID);
    if (creates === undefined || sentAt === undefined) return null;
    creates.delete(workspaceID);
    return sentAt;
}

/** The toast id for one launch: a second frame for the same pane replaces, never stacks. */
export function agentLaunchToastID(paneID: string): string {
    return `agent-launch-${paneID}`;
}

/** R8's toast: one id for every "too old" create, so a second one replaces the first. */
export const AGENT_START_UNSUPPORTED_TOAST_ID = 'agent-start-unsupported';

/** A decoded `agent-launch` frame (`WsAgentLaunchMessage`). */
export interface AgentLaunchReport {
    readonly workspaceID: string;
    readonly paneID: string;
    /** Null for a kind this client does not know (a newer daemon): the toast says "the agent". */
    readonly agent: AgentKind | null;
    readonly outcome: WsAgentLaunchOutcome;
    /** Null when absent, or a reason this client does not know: the generic sentence is used. */
    readonly reason: WsAgentLaunchReason | null;
    /** The normalized prompt, when there was one (`fallback` / `failed` only). Never blank. */
    readonly prompt: string | null;
    /** The daemon's copy of the prompt, kept for a day. */
    readonly promptFile: string | null;
    /** The originating window was absent or gone, so EVERY window got this frame. */
    readonly broadcast: boolean;
}

const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Read an `agent-launch` frame, or null when it is not one (or names no pane, or an outcome this
 * client does not know: a future outcome is not one to guess the UI for).
 */
export function parseAgentLaunch(message: Record<string, unknown>): AgentLaunchReport | null {
    if (message['type'] !== WS_AGENT_LAUNCH_MESSAGE) return null;
    const workspaceID = nonEmpty(message['workspaceID']);
    const paneID = nonEmpty(message['paneID']);
    const outcome = message['outcome'];
    if (workspaceID === null || paneID === null) return null;
    if (!(WS_AGENT_LAUNCH_OUTCOMES as readonly unknown[]).includes(outcome)) return null;
    const agent = message['agent'];
    const reason = message['reason'];
    const prompt = message['prompt'];
    return {
        workspaceID,
        paneID,
        agent: agent === 'claude' || agent === 'codex' ? agent : null,
        outcome: outcome as WsAgentLaunchOutcome,
        reason: (WS_AGENT_LAUNCH_REASONS as readonly unknown[]).includes(reason) ? (reason as WsAgentLaunchReason) : null,
        // A whitespace-only prompt is no prompt (the daemon's own rule); nothing to copy.
        prompt: typeof prompt === 'string' && prompt.trim() !== '' ? prompt : null,
        promptFile: nonEmpty(message['promptFile']),
        broadcast: message['broadcast'] === true
    };
}

/** The agent's product name; for a kind this client does not know, "the agent" (or "The agent"). */
function agentName(agent: AgentKind | null, startsSentence = true): string {
    if (agent !== null) return AGENT_DISPLAY_NAMES[agent];
    return startsSentence ? 'The agent' : 'the agent';
}

/**
 * What went wrong, in one sentence that names the reason (wire-protocol.md §6.3's table, in the
 * user's words). `fallback` sentences say the agent DID start; `failed` ones say it did not.
 */
export function agentLaunchProblem(report: Pick<AgentLaunchReport, 'agent' | 'outcome' | 'reason'>): string {
    const name = agentName(report.agent);
    const inner = agentName(report.agent, false);
    if (report.outcome === 'failed') {
        switch (report.reason) {
            case 'pane-exited':
                return `The pane closed before ${inner} could be started.`;
            case 'unsupported-shell':
                return `${name} was not started: Send immediately needs the pane's shell to be zsh, bash, sh, dash, ksh or fish.`;
            case 'daemon-stopping':
                return `The Kelpi daemon stopped before ${inner} could be started.`;
            case 'user-typed':
                return `${name} was not started: something was typed into the pane before Kelpi could type the command that starts it.`;
            case 'timeout':
                return `${name} was not started: the pane's shell never showed a prompt Kelpi could type the command at.`;
            default:
                return `${name} was not started.`;
        }
    }
    switch (report.reason) {
        case 'timeout':
            return `${name} started, but was not ready for the prompt in time.`;
        case 'no-session-start':
            return `${name} started, but Kelpi never heard from its SessionStart hook, so it could not tell when ${inner} was ready for the prompt. Run \`kelpi install-hooks\` to install the hooks.`;
        case 'pane-exited':
            return `${name} started, but the pane closed before the prompt could be pasted.`;
        case 'agent-exited':
            return `${name} exited before it was ready for the prompt.`;
        case 'user-typed':
            return `${name} started, but something was typed into the pane first, so the prompt was not pasted over it.`;
        case 'no-bracketed-paste':
            return `${name} started, but did not accept a bracketed paste, so pasting the prompt could have sent it early.`;
        case 'predicate-error':
            return `${name} started, but Kelpi could not tell when it was ready for the prompt.`;
        case 'daemon-stopping':
            return `${name} started, but the Kelpi daemon stopped before the prompt was pasted.`;
        default:
            return `${name} started, but the prompt could not be pasted.`;
    }
}

/** The prompt's first `PROMPT_EXCERPT_CHARS` characters, whitespace runs folded to one space. */
export function promptExcerpt(prompt: string): string {
    const folded = prompt.replace(/\s+/g, ' ').trim();
    return folded.length > PROMPT_EXCERPT_CHARS ? `${folded.slice(0, PROMPT_EXCERPT_CHARS)}…` : folded;
}

/** Where the prompt stands, which the title has to say (R14). */
export type PromptCopyState = 'copied' | 'click' | 'unavailable';

/** Everything an undelivered-prompt toast says, before the copy state is known. */
export interface PromptToastInput {
    readonly id: string;
    /** The title without the copy state: "Prompt not delivered to Codex", "Codex not started". */
    readonly headline: string;
    /** Whether `headline` already names the prompt, so the suffix can say "it". */
    readonly headlineNamesPrompt: boolean;
    /** `agentLaunchProblem`, or R8's sentence. */
    readonly problem: string;
    /** What to do with the prompt once it is on the clipboard. */
    readonly advice: string;
    readonly prompt: string | null;
    readonly promptFile: string | null;
    readonly workspaceID: string | null;
    readonly kind: Toast['kind'];
}

/** The toast for `input` in `state`. Pure, so the three titles are testable as data. */
export function promptToast(input: PromptToastInput, state: PromptCopyState, createdAt: number): Toast {
    const base = {
        id: input.id,
        kind: input.kind,
        // Not the pane: a toast tied to a pane is one a later "clear this pane's notifications"
        // could take away, and this one must stay until the user has the prompt.
        paneID: null,
        workspaceID: input.workspaceID,
        createdAt
    };
    if (input.prompt === null) return { ...base, title: input.headline, body: input.problem };
    if (state === 'unavailable') {
        const where = input.promptFile === null ? '' : ` The whole prompt is saved in ${input.promptFile}.`;
        return {
            ...base,
            title: input.headline,
            body: `${input.problem} It begins: "${promptExcerpt(input.prompt)}"${where}`
        };
    }
    const suffix =
        state === 'copied'
            ? input.headlineNamesPrompt
                ? 'copied to the clipboard'
                : 'prompt copied to the clipboard'
            : input.headlineNamesPrompt
              ? 'click to copy it'
              : 'click to copy the prompt';
    return {
        ...base,
        title: `${input.headline}: ${suffix}`,
        body: `${input.problem} ${input.advice}`,
        copyText: input.prompt
    };
}

export type ClipboardWriter = (text: string) => Promise<void>;

/** Start a clipboard write, turning a writer that throws synchronously into a rejection. */
function startWrite(writeText: ClipboardWriter, text: string): Promise<void> {
    try {
        return writeText(text);
    } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Raise the toast for `input`, and when `autoCopy` (the window that asked, R14) also start the
 * clipboard write. The toast goes up at once saying "click to copy"; a write that lands swaps the
 * title to "copied", but only on the very toast this call raised: one the user has already
 * dismissed, or that a later frame has replaced, is left alone.
 */
export function offerUndeliveredPrompt(
    store: KelpiStoreApi,
    input: PromptToastInput,
    options: { readonly autoCopy: boolean; readonly writeText: ClipboardWriter | null; readonly now?: (() => number) | undefined }
): Toast {
    const now = options.now ?? Date.now;
    const writeText = options.writeText;
    const state: PromptCopyState = writeText === null ? 'unavailable' : 'click';
    const raised = promptToast(input, state, now());
    store.getState().pushToast(raised);
    if (input.prompt === null || writeText === null || !options.autoCopy) return raised;
    void startWrite(writeText, input.prompt).then(
        () => {
            const current = store.getState().ui.toasts.find((toast) => toast.id === input.id);
            if (current !== raised) return;
            store.getState().pushToast(promptToast(input, 'copied', raised.createdAt));
        },
        () => {
            // Refused (no focus, no permission, a phone): the toast already says "click to copy",
            // and the click is the gesture the browser wanted.
        }
    );
    return raised;
}

export interface AgentLaunchHandlerOptions {
    readonly store: KelpiStoreApi;
    /** Defaults to `navigator.clipboard.writeText` (`pageClipboardWriter`); tests pass their own. */
    readonly writeText?: ClipboardWriter | null | undefined;
    readonly now?: (() => number) | undefined;
}

/**
 * The handler `connectStore` subscribes beside `clipboard-write`. Answers with the decoded frame
 * (or null when the message was not one), for the tests; the work is the toast.
 */
export function createAgentLaunchHandler(
    options: AgentLaunchHandlerOptions
): (message: Record<string, unknown>) => AgentLaunchReport | null {
    const now = options.now ?? Date.now;
    return (message) => {
        const report = parseAgentLaunch(message);
        if (report === null) return null;
        // Read (and forgotten) for every outcome: this is the launch's one frame.
        const sentAt = takeAgentCreateSentAt(options.store, report.workspaceID);
        // Success needs nobody's attention: the agent is in the pane, with its prompt if any.
        if (report.outcome !== 'fallback' && report.outcome !== 'failed') return report;
        const failed = report.outcome === 'failed';
        offerUndeliveredPrompt(
            options.store,
            {
                id: agentLaunchToastID(report.paneID),
                headline: failed
                    ? `${agentName(report.agent)} not started`
                    : `Prompt not delivered to ${agentName(report.agent, false)}`,
                headlineNamesPrompt: !failed,
                problem: agentLaunchProblem(report),
                advice: failed ? `Start ${agentName(report.agent, false)} and paste it in.` : 'Paste it in yourself.',
                prompt: report.prompt,
                promptFile: report.promptFile,
                workspaceID: report.workspaceID,
                kind: 'agent-error'
            },
            {
                autoCopy: autoCopy(report, sentAt, now()),
                writeText: options.writeText === undefined ? pageClipboardWriter() : options.writeText,
                now
            }
        );
        return report;
    };
}

/**
 * May this frame write the clipboard without a click? Only in the window that asked (not a
 * broadcast), only within `AGENT_LAUNCH_AUTO_COPY_MS` of that window sending the create, and
 * never for a daemon that is stopping (see the module comment).
 */
function autoCopy(report: AgentLaunchReport, sentAt: number | null, now: number): boolean {
    if (report.broadcast || report.reason === 'daemon-stopping' || sentAt === null) return false;
    return now - sentAt <= AGENT_LAUNCH_AUTO_COPY_MS;
}

/**
 * Plan R8: the create succeeded, but its reply carries no `start_agent` echo, so the daemon that
 * made it predates agent starts and made a plain workspace. Said once, with the prompt offered the
 * same way, auto-copied since this IS the window that asked.
 */
export function reportAgentStartUnsupported(
    store: KelpiStoreApi,
    request: { readonly kind: AgentKind; readonly prompt: string },
    workspaceID: string | null,
    writeText: ClipboardWriter | null = pageClipboardWriter()
): Toast {
    const name = AGENT_DISPLAY_NAMES[request.kind];
    return offerUndeliveredPrompt(
        store,
        {
            id: AGENT_START_UNSUPPORTED_TOAST_ID,
            headline: 'This daemon is too old to start agents',
            headlineNamesPrompt: false,
            problem: `The workspace was created, but without ${name}: the Kelpi daemon it runs on predates starting an agent from New Workspace.`,
            advice: `Start ${name} in it and paste the prompt in.`,
            prompt: request.prompt.trim() === '' ? null : request.prompt,
            promptFile: null,
            workspaceID,
            kind: 'info'
        },
        { autoCopy: true, writeText }
    );
}

/** The toast id for a create that failed outright; one id, so a second failure replaces it. */
export const AGENT_CREATE_FAILED_TOAST_ID = 'agent-create-failed';

/**
 * The create itself failed (its reply was an error, or it never came back), and it had asked
 * for an agent with a prompt. A plain create closes the New Workspace sheet before its reply
 * arrives, so the prompt the user wrote is gone from the screen: offer it back, auto-copied,
 * since this IS the window that asked and the reply has only just arrived. Says why in the
 * daemon's own words. Nothing at all for a request without a prompt: the failure toast the
 * caller raises already says everything.
 */
export function offerPromptOfFailedCreate(
    store: KelpiStoreApi,
    request: { readonly kind: AgentKind; readonly prompt: string },
    error: string,
    writeText: ClipboardWriter | null = pageClipboardWriter()
): Toast | null {
    if (request.prompt.trim() === '') return null;
    const name = AGENT_DISPLAY_NAMES[request.kind];
    return offerUndeliveredPrompt(
        store,
        {
            id: AGENT_CREATE_FAILED_TOAST_ID,
            headline: 'Workspace not created',
            headlineNamesPrompt: false,
            problem: `${error.replace(/\.?$/, '.')} ${name} was not started.`,
            advice: 'Create the workspace again and paste it in.',
            prompt: request.prompt,
            promptFile: null,
            workspaceID: null,
            kind: 'agent-error'
        },
        { autoCopy: true, writeText }
    );
}

/**
 * A click on a toast (`App`'s `ToastStack`). A plain toast is dismissed. One carrying `copyText`
 * starts the clipboard write HERE, inside the click's own task, which is the transient activation
 * a browser wants before it lets a page write, and dismisses once the write lands. If it is
 * refused even then, the toast stays and turns into the variant that shows the prompt's opening
 * (and no longer offers a copy), so the next click dismisses it rather than failing again.
 */
export function activateToast(
    store: KelpiStoreApi,
    toast: Toast,
    writeText: ClipboardWriter | null = pageClipboardWriter()
): void {
    const text = toast.copyText;
    if (text === undefined || writeText === null) {
        store.getState().dismissToast(toast.id);
        return;
    }
    void startWrite(writeText, text).then(
        () => {
            store.getState().dismissToast(toast.id);
        },
        () => {
            const current = store.getState().ui.toasts.find((candidate) => candidate.id === toast.id);
            if (current !== toast) return;
            const { copyText: _copied, ...rest } = toast;
            store.getState().pushToast({
                ...rest,
                title: 'Could not copy the prompt',
                body: `The browser refused the clipboard. The prompt begins: "${promptExcerpt(text)}"`
            });
        }
    );
}
