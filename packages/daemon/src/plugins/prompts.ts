import { randomUUID } from 'node:crypto';
import { pluginRecord, type JsonObject, type JsonValue, type PluginContext } from '@kelpi/protocol';

/** #389: the view `ui.show*` methods a backend asks a window to present. */
export const BACKEND_PROMPT_METHODS: readonly string[] = ['ui.showDialog', 'ui.showQuickPick', 'ui.showInput', 'ui.showNotification'];

/** The part of a pending `command:` invocation a prompt holds (service.ts `PendingCall`). */
export interface PromptHoldTarget {
    timer: ReturnType<typeof setTimeout>;
    deadline?: number;
    expire?: () => void;
    holds?: number;
    remaining?: number;
    /** The window `run` RPC that started this command (`reply.progress`), kept alive while a prompt holds it. */
    progress?: ((payload: JsonObject) => void) | undefined;
    heartbeat?: ReturnType<typeof setInterval> | undefined;
}
/** The prompt's direct parent call, and whether it is still waiting for its result. */
export interface PromptParent { readonly call: PromptHoldTarget; live(): boolean }

interface Pending {
    readonly pluginID: string;
    readonly windowID: string;
    clientID?: string;
    watchdog?: ReturnType<typeof setTimeout> | undefined;
    settle(outcome: { value: JsonValue } | { error: Error }): void;
}

/**
 * Pending backend prompts. Each lives until a reply, its backend ending, or its window's
 * client going away; only an unacknowledged one has a deadline.
 */
export class BackendPrompts {
    private readonly pending = new Map<string, Pending>();
    constructor(private readonly options: { broadcast(event: JsonObject): void; ackTimeoutMs?: number | undefined; heartbeatMs?: number | undefined }) {}

    show(plugin: { id: string; name: string }, method: string, args: JsonObject, context: PluginContext, parent?: PromptParent): Promise<JsonValue> {
        const explicit = args['windowID'];
        if (explicit !== undefined && (typeof explicit !== 'string' || !explicit || explicit.length >= 200)) throw new Error('invalid windowID');
        const windowID = explicit ?? context.windowID;
        if (!windowID) throw new Error('NO_WINDOW: the command has no window; run it from a shortcut, the palette or a menu, or pass { windowID }');
        const options = args['options'] ?? {};
        if (!pluginRecord(options)) throw new Error('missing or invalid options');
        let count = 0; for (const entry of this.pending.values()) if (entry.pluginID === plugin.id) count++;
        if (count >= 8) throw new Error('too many pending prompts for this plugin');
        const requestID = randomUUID();
        return new Promise((resolve, reject) => {
            if (parent) hold(parent, this.options.heartbeatMs ?? 10_000);
            const entry: Pending = { pluginID: plugin.id, windowID, settle: outcome => {
                clearTimeout(entry.watchdog); this.pending.delete(requestID);
                if (parent) resume(parent);
                if ('error' in outcome) reject(outcome.error); else resolve(outcome.value);
            } };
            entry.watchdog = setTimeout(() => {
                this.cancel(requestID, entry);
                entry.settle({ error: new Error('NO_WINDOW: no window presented the prompt') });
            }, this.options.ackTimeoutMs ?? 10_000);
            this.pending.set(requestID, entry);
            this.options.broadcast({ type: 'plugin-prompt', requestID, windowID, pluginID: plugin.id, pluginName: plugin.name, method, options });
        });
    }
    /** The window admitted the request; from now on only a reply or the backend ends it. */
    ack(input: JsonObject, context: Partial<PluginContext>): null {
        const entry = this.entry(input, context);
        clearTimeout(entry.watchdog); entry.watchdog = undefined;
        if (context.clientID) entry.clientID = context.clientID;
        return null;
    }
    reply(input: JsonObject, context: Partial<PluginContext>): null {
        const entry = this.entry(input, context);
        // Once a client presents the prompt, only it answers; before the ack the window check alone applies.
        if (entry.clientID !== undefined && context.clientID !== entry.clientID) throw new Error('prompt belongs to another client');
        const { value, error } = input;
        if (typeof error === 'string') entry.settle({ error: new Error(error || 'prompt failed') });
        else if (value === null || typeof value === 'string') entry.settle({ value });
        else throw new Error('prompt reply needs a value or an error');
        return null;
    }
    /** The backend ended (stop, disable, reload, failure, dispose): close its prompts. */
    cancelPlugin(pluginID: string): void {
        for (const [requestID, entry] of this.pending) if (entry.pluginID === pluginID) { this.cancel(requestID, entry); entry.settle({ value: null }); }
    }
    cancelAll(): void { for (const [requestID, entry] of this.pending) { this.cancel(requestID, entry); entry.settle({ value: null }); } }
    /** The acking window's client is gone, so nothing will answer: dismissed, no cancel frame. */
    releaseClient(clientID: string): void {
        for (const entry of [...this.pending.values()]) if (entry.clientID === clientID) entry.settle({ value: null });
    }
    private cancel(requestID: string, entry: Pending): void {
        this.options.broadcast({ type: 'plugin-prompt-cancel', requestID, windowID: entry.windowID });
    }
    private entry(input: JsonObject, context: Partial<PluginContext>): Pending {
        const entry = typeof input['requestID'] === 'string' ? this.pending.get(input['requestID']) : undefined;
        if (!entry) throw new Error('unknown prompt request');
        if (context.windowID !== entry.windowID) throw new Error('prompt belongs to another window');
        return entry;
    }
}

/**
 * Stop the parent's timeout clock while any of its prompts is open, keeping what was left, and
 * re-arm the deadline of the window RPC that started it, which every progress frame resets.
 */
function hold(parent: PromptParent, heartbeatMs: number): void {
    const call = parent.call;
    if (!call.expire || call.deadline === undefined) return;
    call.holds = (call.holds ?? 0) + 1;
    if (call.holds > 1) return;
    clearTimeout(call.timer); call.remaining = Math.max(1, call.deadline - Date.now());
    const progress = call.progress; if (!progress) return;
    // The frame's payload is `{ prompt: 'pending' }`: the command is waiting on a backend prompt.
    const beat = (): void => { if (parent.live()) progress({ prompt: 'pending' }); else { clearInterval(call.heartbeat); call.heartbeat = undefined; } };
    call.heartbeat = setInterval(beat, heartbeatMs); beat();
}
function resume(parent: PromptParent): void {
    const call = parent.call;
    if (!call.expire || !call.holds || --call.holds > 0) return;
    clearInterval(call.heartbeat); call.heartbeat = undefined;
    // A parent that settled or was cancelled meanwhile has no timer to restore.
    if (!parent.live()) return;
    // One more frame restarts the window's 35 s wait now, so it outlasts the (at most 30 s) budget re-armed below.
    call.progress?.({ prompt: 'settled' });
    const remaining = call.remaining ?? 1;
    call.deadline = Date.now() + remaining; call.timer = setTimeout(call.expire, remaining);
}
