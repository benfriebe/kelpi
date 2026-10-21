/**
 * The picker's New pane grid: which kinds of pane a phone can open, and how each is opened on the
 * host the workspace lives on.
 *
 * Every kind goes through that host's own `runtime.commands`, so the origin and a remote host are
 * one code path, and every one is a FOCUSING open (#295's rule for a person's gesture), which is
 * what puts the new pane on screen: the phone shows the daemon's focused pane.
 *
 *   terminal    `pane-create` in the workspace
 *   claude      a terminal, then `claude` typed into it
 *   codex       a terminal, then `codex` typed into it
 *   scratchpad  `create-scratchpad`
 *   web         `web-open` on a blank page, split off the pane on screen
 *   diff        `open-diff` on the repository the pane on screen is working in
 *
 * There is no daemon verb that starts an agent, so the two agent kinds are a terminal with the
 * agent's command typed into it, exactly what a person would type; the agent then reports itself
 * through its hooks like any other. It is typed only once the shell has drawn something: a new
 * pane's PTY is not spawned until a client attaches at its real size (`pty/spawn-gate.ts`), and a
 * `pane-send` before that would spawn it at a fallback size and start the agent at the wrong width,
 * or land before a prompt that flushes typeahead.
 *
 * A markdown pane is not offered: it opens a FILE, and a phone has no file to point at. A diff
 * opens on the repository the pane on screen is working in, so it needs no path. Plugin views are
 * listed beside these by the picker, from the host's plugin list.
 */

import { isOkReply, replyError, replyText } from '../connection';
import { pluginRequest } from '../plugins/client';
import type { KelpiRuntime } from '../state';

export type PhoneNewPaneKind = 'terminal' | 'claude' | 'codex' | 'scratchpad' | 'web' | 'diff';

export interface PhoneNewPaneOption {
    readonly kind: PhoneNewPaneKind;
    readonly label: string;
}

export const PHONE_NEW_PANE_OPTIONS: readonly PhoneNewPaneOption[] = [
    { kind: 'terminal', label: 'Terminal' },
    { kind: 'claude', label: 'Claude' },
    { kind: 'codex', label: 'Codex' },
    { kind: 'web', label: 'Web' },
    { kind: 'scratchpad', label: 'Scratch' },
    { kind: 'diff', label: 'Diff' }
];

export interface PhoneNewPaneTarget {
    readonly runtime: KelpiRuntime;
    readonly workspaceID: string;
    /** The pane on screen, which a web pane splits off; null for an empty workspace. */
    readonly anchorPaneID: string | null;
    /** The folder a Diff pane compares: the pane on screen's working directory, when it has one. */
    readonly repoPath: string | null;
}

/** How long a new agent pane may take to draw its first prompt before the command is typed anyway. */
const PROMPT_WAIT_MS = 8_000;
const PROMPT_POLL_MS = 250;
/**
 * How long the phone is given to attach the new pane before the first look at its screen. A
 * capture is itself a demand for the terminal (`pane-capture` flushes the spawn gate), so looking
 * before the phone has attached would spawn the shell at the fallback size this wait exists to
 * avoid. The phone shows the focused pane, which the create just made the new one, so its attach
 * is a render and a round trip away.
 */
const ATTACH_GRACE_MS = 1_200;

async function waitForFirstOutput(runtime: KelpiRuntime, paneID: string, sleep: (ms: number) => Promise<void>): Promise<void> {
    await sleep(ATTACH_GRACE_MS);
    const deadline = Date.now() + PROMPT_WAIT_MS;
    while (Date.now() < deadline) {
        try {
            const reply = await runtime.commands.capturePane({ target: paneID, lines: 5 });
            if (isOkReply(reply) && (replyText(reply, 'text') ?? '').trim().length > 0) return;
        } catch {
            // A capture that fails says nothing about the prompt; keep looking until the deadline.
        }
        await sleep(PROMPT_POLL_MS);
    }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open one pane of `kind`. Resolves to null once the daemon has taken it (and, for an agent, been
 * typed to), or to what went wrong in words a toast can show.
 */
export async function openPhonePane(target: PhoneNewPaneTarget, kind: PhoneNewPaneKind, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<string | null> {
    const { runtime, workspaceID } = target;
    try {
        switch (kind) {
            case 'scratchpad': {
                const reply = await runtime.commands.createScratchpad({ workspaceID });
                return isOkReply(reply) ? null : replyError(reply);
            }
            case 'web': {
                const reply = await runtime.commands.raw({
                    command: 'web-open',
                    url: 'about:blank',
                    private: false,
                    ...(target.anchorPaneID === null ? {} : { pane_id: target.anchorPaneID, target: target.anchorPaneID }),
                    focus: true,
                    gesture: true
                });
                return isOkReply(reply) ? null : replyError(reply);
            }
            case 'diff': {
                if (target.repoPath === null) return 'This pane has no folder to diff.';
                const reply = await runtime.commands.openDiff({ repoPath: target.repoPath, focus: true });
                return isOkReply(reply) ? null : replyError(reply);
            }
            case 'terminal':
            case 'claude':
            case 'codex': {
                const reply = await runtime.commands.createPane({ workspace: workspaceID });
                if (!isOkReply(reply)) return replyError(reply);
                if (kind === 'terminal') return null;
                const paneID = replyText(reply, 'pane_id');
                if (paneID === undefined) return `Opened a terminal, but could not start ${kind} in it.`;
                await waitForFirstOutput(runtime, paneID, sleep);
                const sent = await runtime.commands.sendText({ target: paneID, text: kind });
                return isOkReply(sent) ? null : replyError(sent);
            }
        }
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/** Open a plugin's pane view in the workspace; null, or what went wrong. */
export async function openPhonePluginView(target: PhoneNewPaneTarget, pluginID: string, viewID: string): Promise<string | null> {
    try {
        await pluginRequest(target.runtime, 'open', { pluginID, viewID, workspaceID: target.workspaceID, focus: true });
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
