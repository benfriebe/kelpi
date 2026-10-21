/**
 * The waiting panes' prompts, read once each and shared by every surface that shows them.
 *
 * Home's cards, the Needs-you sheet and the reply chips under a waiting pane all show the same
 * prompt for the same pane, so the capture is held here, keyed like the attention item
 * (`host/pane`), and read ONCE per wait: when a pane starts waiting somebody asks for it, and the
 * entry is dropped when the pane stops (`forgetPrompts`, driven by the shell's attention model).
 * A reply that the daemon refuses because the screen moved re-reads it, so the next tap answers
 * what is there now.
 *
 * A reply is the prompt's own hotkey, sent with the revision the capture read (`prompts.ts` says
 * why that makes it safe). Module state for the reason `attention.ts`'s clock is: a fact about this
 * page's life, with no owner to live in.
 */

import { useSyncExternalStore } from 'react';

import { isOkReply, replyNumber, replyText } from '../connection';
import type { KelpiRuntime } from '../state';
import { parsePrompt, type PhonePrompt, type PhonePromptChoice } from './prompts';

export interface PhonePromptEntry {
    readonly state: 'reading' | 'ready' | 'failed';
    readonly prompt: PhonePrompt | null;
    /** The screen revision the prompt was read at; null when the host does not report one. */
    readonly revision: number | null;
    /** A reply is on its way: the buttons stand down until the pane stops waiting or it fails. */
    readonly sending: boolean;
    /** The last reply was refused or failed, in words the card can show. */
    readonly notice: string | null;
}

/** How many lines of the screen a prompt is read from. */
const CAPTURE_LINES = 40;
/** How long after a reply the prompt is read again if the pane is still waiting. */
const REREAD_AFTER_MS = 1500;

const entries = new Map<string, PhonePromptEntry>();
const listeners = new Set<() => void>();
let version = 0;

function publish(key: string, entry: PhonePromptEntry | null): void {
    if (entry === null) entries.delete(key);
    else entries.set(key, entry);
    version += 1;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

async function read(key: string, runtime: KelpiRuntime, paneID: string, notice: string | null): Promise<void> {
    const before = entries.get(key);
    publish(key, { state: 'reading', prompt: before?.prompt ?? null, revision: before?.revision ?? null, sending: false, notice });
    try {
        const reply = await runtime.commands.capturePane({ target: paneID, lines: CAPTURE_LINES });
        if (!entries.has(key)) return;
        if (!isOkReply(reply)) {
            publish(key, { state: 'failed', prompt: null, revision: null, sending: false, notice });
            return;
        }
        const prompt = parsePrompt(replyText(reply, 'text') ?? '');
        const revision = replyNumber(reply, 'revision') ?? null;
        publish(key, {
            state: 'ready',
            // A host that reports no revision (a daemon from before #390) cannot refuse a key
            // that arrives after the screen moved, so it is offered Open and never a button.
            prompt: prompt === null || revision !== null ? prompt : { question: prompt.question, choices: [] },
            revision,
            sending: false,
            notice
        });
    } catch {
        if (entries.has(key)) publish(key, { state: 'failed', prompt: null, revision: null, sending: false, notice });
    }
}

/** Read a waiting pane's prompt, unless it has been read (or is being read) already. */
export function requestPrompt(key: string, runtime: KelpiRuntime, paneID: string): void {
    if (entries.has(key)) return;
    void read(key, runtime, paneID, null);
}

/** Drop the prompts of panes that are no longer waiting; their next wait reads afresh. */
export function forgetPrompts(liveKeys: ReadonlySet<string>): void {
    for (const key of [...entries.keys()]) if (!liveKeys.has(key)) publish(key, null);
}

/** The prompt for one waiting pane, live; undefined until somebody has asked for it. */
export function usePhonePrompt(key: string): PhonePromptEntry | undefined {
    useSyncExternalStore(subscribe, () => version, () => version);
    return entries.get(key);
}

/**
 * Answer a prompt with one of its choices. Resolves once the daemon has taken the keys or refused
 * them; a refusal because the screen moved re-reads the prompt and says so.
 */
export async function answerPrompt(key: string, runtime: KelpiRuntime, paneID: string, choice: PhonePromptChoice): Promise<boolean> {
    const entry = entries.get(key);
    if (entry === undefined || entry.state !== 'ready' || entry.sending || entry.revision === null) return false;
    publish(key, { ...entry, sending: true, notice: null });
    try {
        // A KEYPRESS, not a paste: `pane-send` would wrap the key in a bracketed-paste envelope
        // for an agent that turned paste mode on, and a menu acts on keys. Guarded by the
        // revision the prompt was read at, so it lands on that screen or not at all.
        const reply = await runtime.commands.sendKey({ target: paneID, key: choice.keys, ifRevision: entry.revision });
        if (isOkReply(reply) && choice.submit) {
            // A line prompt's Enter, right behind the key it submits.
            await runtime.commands.sendKey({ target: paneID, key: 'enter' });
        }
        if (isOkReply(reply)) {
            // The pane leaves `waitingForInput` when the agent takes the answer, which drops this
            // entry; until then the buttons stay down so a second tap cannot type twice.
            const current = entries.get(key);
            if (current !== undefined) publish(key, { ...current, notice: `Sent “${choice.label}”` });
            // An answer that leaves the agent waiting on something else ("No, and tell Claude
            // what to do") keeps the pane waiting, so look again rather than stay down for good.
            setTimeout(() => {
                if (entries.get(key)?.sending === true) void read(key, runtime, paneID, null);
            }, REREAD_AFTER_MS);
            return true;
        }
        if (reply['code'] === 'SCREEN_CHANGED') {
            void read(key, runtime, paneID, 'The prompt changed. Check it again.');
            return false;
        }
        // Refused outright: nothing was typed. A daemon from before single-key sends says the key
        // is unknown; either way the pane is the place to answer this one.
        const old = /unknown key/i.test(String(reply['error'] ?? ''));
        publish(key, { state: 'failed', prompt: null, revision: null, sending: false, notice: old ? 'This host is too old to answer from here. Open the pane.' : 'That reply did not go through. Open the pane.' });
        return false;
    } catch {
        // No answer at all (a timeout, a dropped link): the key may or may not have been typed,
        // so nothing is offered again from here. The pane shows what actually happened.
        publish(key, { state: 'failed', prompt: null, revision: null, sending: false, notice: 'No answer from the host. Open the pane to check.' });
        return false;
    }
}

/** Test seam: forget every prompt. */
export function resetPrompts(): void {
    entries.clear();
    version += 1;
}
