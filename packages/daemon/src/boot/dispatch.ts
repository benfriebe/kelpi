/**
 * Merging the handler families into the one `ControlDispatcher` both transports share.
 *
 * The control socket has already decided reply-vs-silence by the time a message gets here
 * (wire-protocol.md §4 allowlist, applied in `control/server.ts`), so this layer only has to
 * route by command name and be honest when it cannot:
 *
 *   - known command → its handler, with the composed context;
 *   - unknown command WITH a reply handle → `{"ok":false,"error":"unknown command: …"}` so a
 *     newer CLI talking to an older daemon gets a non-zero exit instead of a read timeout;
 *   - unknown command WITHOUT one → silence (§1 fire-and-forget: the server never writes a
 *     byte on those connections);
 *   - a handler that THROWS → the same `{"ok":false,…}` shape rather than a hung reader.
 *     The Swift app cannot throw here (its handlers are total), so this is a superset that
 *     only fires on a daemon bug — and a bug must not wedge the caller's CLI.
 *
 * Tables are merged first-wins, so a family added later cannot silently steal a command from
 * one that already owns it; a duplicate is reported through `onError` and dropped.
 */

import type { JsonObject, WireMessage } from '@kelpi/protocol';
import type { PluginOperationChannel } from '../plugins/operations.js';

import type { CommandHandler, ControlDispatchItem, ControlDispatcher, HandlerTable, ReplyHandle } from '../seams.js';

export interface DispatcherOptions<Ctx> {
    readonly ctx: Ctx;
    /** Merged first-wins. */
    readonly tables: readonly HandlerTable<Ctx>[];
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly operations?: PluginOperationChannel;
}

export function unknownCommandError(command: string): string {
    return `unknown command: ${command}`;
}

/** One lookup table from many, first table wins. */
export function mergeHandlerTables<Ctx>(
    tables: readonly HandlerTable<Ctx>[],
    onDuplicate?: ((command: string) => void) | undefined
): ReadonlyMap<string, CommandHandler<Ctx>> {
    const merged = new Map<string, CommandHandler<Ctx>>();
    for (const table of tables) {
        for (const [command, handler] of table) {
            if (merged.has(command)) {
                onDuplicate?.(command);
                continue;
            }
            merged.set(command, handler);
        }
    }
    return merged;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function failClosed(reply: ReplyHandle | null, error: string): void {
    if (reply === null || reply.closed) return;
    reply.send({ ok: false, error });
    reply.close();
}

export function createDispatcher<Ctx>(options: DispatcherOptions<Ctx>): ControlDispatcher {
    const table = mergeHandlerTables(options.tables, (command) => {
        options.onError?.(new Error(`duplicate handler for '${command}'`), 'dispatcher');
    });

    const dispatch = (msg: WireMessage, reply: ReplyHandle | null): void => {
        const handler = table.get(msg.command);
        if (handler === undefined) {
            failClosed(reply, unknownCommandError(msg.command));
            return;
        }
        try {
            handler(msg, options.ctx, reply);
        } catch (error) {
            const failure = toError(error);
            options.onError?.(failure, `handler ${msg.command}`);
            failClosed(reply, `internal error: ${failure.message}`);
        }
    };
    const dispatchBatch = (items: readonly ControlDispatchItem[]): void => {
        const first = items[0]; if (!first) return;
        const { message: msg, reply } = first;
        const run = (firstReply = reply): void => {
            for (let index = 0; index < items.length; index++) {
                const item = items[index]!;
                dispatch(item.message, index === 0 ? firstReply : item.reply);
            }
        };
        const operations = options.operations;
        if (!operations?.hasOperationHooks(msg.command)) { run(); return; }
        const payload = msg as unknown as JsonObject;
        let invoked = false;
        void operations.interceptOperation(payload, {
            ...(typeof payload['workspace_id'] === 'string' ? { workspaceID: payload['workspace_id'] } : {}),
            ...(typeof payload['pane_id'] === 'string' ? { paneID: payload['pane_id'] } : {})
        }, 'cli', () => new Promise<JsonObject>(resolve => {
            invoked = true;
            if (reply === null) {
                // The legacy wire deliberately has no completion reply for these verbs.
                run(null); resolve({ ok: true, completion: 'dispatched' }); return;
            }
            if (reply.closed) { resolve({ ok: false, error: 'command caller disconnected' }); return; }
            let observed = false;
            const complete = (value: JsonObject): void => { if (!observed) { observed = true; clearTimeout(timer); resolve(value); } };
            const timer = setTimeout(() => complete({ ok: false, error: 'operation completion was not observed within 60 seconds' }), 60_000);
            timer.unref?.();
            reply.onDisconnect(() => complete({ ok: false, error: 'command caller disconnected' }));
            const tracked: ReplyHandle = {
                get closed() { return reply.closed; },
                send(value) { reply.send(value); complete(value as JsonObject); },
                close() { reply.close(); complete({ ok: false, error: 'daemon produced no reply' }); },
                onDisconnect(callback) { reply.onDisconnect(callback); }
            };
            run(tracked);
        })).then(result => {
            if (!invoked && reply !== null && !reply.closed) { reply.send(result); reply.close(); }
        }, error => {
            options.onError?.(toError(error), `plugin hooks ${msg.command}`);
            failClosed(reply, toError(error).message);
        });
    };
    const dispatcher: ControlDispatcher = (message, reply) => dispatchBatch([{ message, reply }]);
    dispatcher.dispatchBatch = dispatchBatch;
    return dispatcher;
}
