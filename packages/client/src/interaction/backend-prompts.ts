/**
 * A plugin BACKEND's dialogs, quick picks, inputs and notifications (#389), presented through the
 * window's one interaction surface exactly as a view's are, so a selected `interaction.prompts` or
 * `interaction.notifications` presenter draws them unchanged.
 *
 * The daemon broadcasts `plugin-prompt` to every client; a window keeps only frames naming its own
 * shell window, acks the ones its surface admitted, and answers with `prompt-reply`. No React here:
 * `App` creates the bridge once and attaches each runtime.
 *
 * One scope per plugin backend rather than one per request. The surface refuses a second scope with
 * the same owner id, and the owner id is what `surface.ownerRef` keys on, so a stable
 * `backend:<pluginID>` owner is the only way two prompts from one backend share an owner ref. A
 * scope can only be withdrawn whole, though, so cancelling one prompt of several disposes the
 * plugin's scope and re-raises the others, in order, on a fresh one (acked only if not yet). The
 * daemon cancels one of several only on its ack watchdog; a backend's teardown cancels them all.
 */

import type { JsonObject, JsonValue } from '@kelpi/protocol';
import type { ConnectionStatus } from '../connection';
import type { InteractionScope, InteractionSurface } from './surface';

export const BACKEND_PROMPT_UNAVAILABLE = 'Window UI is unavailable for this daemon in this window.';

/** The two connection events the bridge listens to; `KelpiConnection` satisfies it. */
export interface BackendPromptConnection {
    on(event: 'message', listener: (message: JsonObject) => void): () => void;
    on(event: 'status', listener: (status: ConnectionStatus) => void): () => void;
}

export interface BackendPromptBridgeOptions<R extends { readonly connection: BackendPromptConnection }> {
    readonly surface: InteractionSurface;
    /** `readShellWindowID()`: a window without one presents no backend prompt. */
    readonly shellWindowID: string | null;
    /** The primary workbench runtime, the same rule as a view's `ui.show*`. */
    isPrimary(runtime: R): boolean;
    /** `pluginRequest(runtime, action, input)`. */
    send(runtime: R, action: 'prompt-ack' | 'prompt-reply', input: JsonObject): Promise<unknown>;
}

export interface BackendPromptBridge<R> {
    /** Detaching withdraws that runtime's prompts, which then answer null. */
    attach(runtime: R): () => void;
    dispose(): void;
}

interface Prompt {
    readonly requestID: string;
    readonly method: string;
    readonly options: unknown;
    /** Set when the ack goes out, so a prompt re-raised before its first ack still gets one. */
    acked: boolean;
}

interface Group {
    scope: InteractionScope;
    readonly owner: { readonly id: string; readonly pluginID: string; readonly pluginName: string };
    /** Insertion order is the order a re-raise restores. */
    readonly prompts: Map<string, Prompt>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** Already settled, so it loses a race only to a request the surface has already refused. */
const ADMITTED = Promise.resolve(Symbol('admitted'));

export function createBackendPromptBridge<R extends { readonly connection: BackendPromptConnection }>(
    options: BackendPromptBridgeOptions<R>
): BackendPromptBridge<R> {
    const { surface, shellWindowID } = options;
    const runtimes = new Map<R, { groups: Map<string, Group>; off: () => void }>();

    const send = (runtime: R, action: 'prompt-ack' | 'prompt-reply', input: JsonObject): void => {
        // `unknown prompt request` is the daemon having settled it already; nothing to do either way.
        // A renderer's connection declares no window, so each answer names the one it came from.
        void options.send(runtime, action, { ...input, windowID: shellWindowID }).catch((error: unknown) => console.debug('backend prompt', action, message(error)));
    };

    const forget = (groups: Map<string, Group>, group: Group, requestID: string): void => {
        group.prompts.delete(requestID);
        if (group.prompts.size > 0) return;
        groups.delete(group.owner.pluginID);
        group.scope.dispose();
    };

    const raise = (runtime: R, groups: Map<string, Group>, group: Group, prompt: Prompt, ack: boolean): void => {
        const { scope } = group;
        const live = (): boolean => group.scope === scope && group.prompts.get(prompt.requestID) === prompt;
        let request: Promise<JsonValue>;
        try {
            request = scope.request(prompt.method, prompt.options);
        } catch (error) {
            forget(groups, group, prompt.requestID);
            send(runtime, 'prompt-reply', { requestID: prompt.requestID, error: message(error) });
            return;
        }
        // `scope.request` is async (surface.ts), so a refusal is already rejected here and an admitted
        // request never rejects; racing a settled marker tells the two apart without waiting for the
        // answer. The catch above covers a synchronous throw if that ever changes.
        void Promise.race([request, ADMITTED]).then(
            () => {
                if (!ack || !live()) return;
                prompt.acked = true;
                send(runtime, 'prompt-ack', { requestID: prompt.requestID });
            },
            (error: unknown) => {
                if (!live()) return;
                forget(groups, group, prompt.requestID);
                send(runtime, 'prompt-reply', { requestID: prompt.requestID, error: message(error) });
            }
        );
        void request.then(
            (value) => {
                if (!live()) return;
                forget(groups, group, prompt.requestID);
                send(runtime, 'prompt-reply', { requestID: prompt.requestID, value });
            },
            () => undefined
        );
    };

    const present = (runtime: R, groups: Map<string, Group>, frame: JsonObject, requestID: string): void => {
        if (!options.isPrimary(runtime)) {
            send(runtime, 'prompt-reply', { requestID, error: BACKEND_PROMPT_UNAVAILABLE });
            return;
        }
        if ([...groups.values()].some((group) => group.prompts.has(requestID))) return;
        const pluginID = text(frame['pluginID']);
        let group = groups.get(pluginID);
        if (group === undefined) {
            const owner = { id: `backend:${pluginID}`, pluginID, pluginName: text(frame['pluginName']) };
            try {
                group = { scope: surface.createScope(owner), owner, prompts: new Map() };
            } catch (error) {
                send(runtime, 'prompt-reply', { requestID, error: message(error) });
                return;
            }
            groups.set(pluginID, group);
        }
        const prompt: Prompt = { requestID, method: text(frame['method']), options: frame['options'], acked: false };
        group.prompts.set(requestID, prompt);
        raise(runtime, groups, group, prompt, true);
    };

    const cancel = (runtime: R, groups: Map<string, Group>, requestID: string): void => {
        const group = [...groups.values()].find((entry) => entry.prompts.has(requestID));
        if (group === undefined) return;
        if (group.prompts.size === 1) {
            forget(groups, group, requestID);
            return;
        }
        group.prompts.delete(requestID);
        group.scope.dispose();
        try {
            group.scope = surface.createScope(group.owner);
        } catch (error) {
            groups.delete(group.owner.pluginID);
            for (const prompt of group.prompts.values())
                send(runtime, 'prompt-reply', { requestID: prompt.requestID, error: message(error) });
            group.prompts.clear();
            return;
        }
        for (const prompt of [...group.prompts.values()]) raise(runtime, groups, group, prompt, !prompt.acked);
    };

    /** The daemon answers null for a window that went away, so a drop sends nothing. */
    const drop = (groups: Map<string, Group>): void => {
        for (const group of [...groups.values()]) {
            group.prompts.clear();
            group.scope.dispose();
        }
        groups.clear();
    };

    const detach = (runtime: R): void => {
        const held = runtimes.get(runtime);
        if (held === undefined) return;
        runtimes.delete(runtime);
        held.off();
        // Still live, so each settles null through `raise` and the backend is not left waiting.
        for (const group of [...held.groups.values()]) group.scope.dispose();
    };

    return {
        attach(runtime) {
            if (runtimes.has(runtime)) return () => {};
            const groups = new Map<string, Group>();
            const offMessage = runtime.connection.on('message', (frame) => {
                const type = frame['type'];
                if (type !== 'plugin-prompt' && type !== 'plugin-prompt-cancel') return;
                const requestID = text(frame['requestID']);
                // Broadcast to every client: the check is the party that knows which window it is.
                if (shellWindowID === null || frame['windowID'] !== shellWindowID || requestID === '') return;
                if (type === 'plugin-prompt') present(runtime, groups, frame, requestID);
                else cancel(runtime, groups, requestID);
            });
            const offStatus = runtime.connection.on('status', (status) => {
                if (status !== 'connected') drop(groups);
            });
            const held = {
                groups,
                off: () => {
                    offMessage();
                    offStatus();
                }
            };
            runtimes.set(runtime, held);
            return () => {
                if (runtimes.get(runtime) === held) detach(runtime);
            };
        },
        dispose() {
            for (const runtime of [...runtimes.keys()]) detach(runtime);
        }
    };
}
