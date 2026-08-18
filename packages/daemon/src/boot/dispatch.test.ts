import { describe, expect, it, vi } from 'vitest';

import type { CommandHandler, HandlerTable, ReplyHandle } from '../seams.js';
import { createDispatcher, mergeHandlerTables, unknownCommandError } from './dispatch.js';

interface Ctx {
    readonly seen: string[];
}

function stubReply(): ReplyHandle & { readonly payloads: Record<string, unknown>[] } {
    const payloads: Record<string, unknown>[] = [];
    let closed = false;
    return {
        payloads,
        send(payload) {
            payloads.push(payload);
        },
        close() {
            closed = true;
        },
        get closed() {
            return closed;
        },
        onDisconnect: () => {}
    };
}

function table(entries: readonly (readonly [string, CommandHandler<Ctx>])[]): HandlerTable<Ctx> {
    return new Map(entries);
}

describe('mergeHandlerTables', () => {
    it('is first-wins and reports the duplicate', () => {
        const duplicates: string[] = [];
        const first: CommandHandler<Ctx> = (_m, ctx) => ctx.seen.push('first');
        const second: CommandHandler<Ctx> = (_m, ctx) => ctx.seen.push('second');
        const merged = mergeHandlerTables([table([['ping', first]]), table([['ping', second]])], (command) =>
            duplicates.push(command)
        );

        const ctx: Ctx = { seen: [] };
        merged.get('ping')?.({ command: 'ping' }, ctx, null);
        expect(ctx.seen).toEqual(['first']);
        expect(duplicates).toEqual(['ping']);
    });
});

describe('createDispatcher', () => {
    it('routes a known command to its handler with the composed context', () => {
        const ctx: Ctx = { seen: [] };
        const dispatch = createDispatcher<Ctx>({
            ctx,
            tables: [table([['ping', (msg, c) => c.seen.push(msg.command)]])]
        });
        dispatch({ command: 'ping' }, null);
        expect(ctx.seen).toEqual(['ping']);
    });

    it('answers an unknown command that has a reply handle, and closes it', () => {
        const dispatch = createDispatcher<Ctx>({ ctx: { seen: [] }, tables: [] });
        const reply = stubReply();
        dispatch({ command: 'ping' }, reply);
        expect(reply.payloads).toEqual([{ ok: false, error: unknownCommandError('ping') }]);
        expect(reply.closed).toBe(true);
    });

    it('stays silent on an unknown fire-and-forget command', () => {
        const onError = vi.fn();
        const dispatch = createDispatcher<Ctx>({ ctx: { seen: [] }, tables: [], onError });
        // Fire-and-forget: the transport never allocated a handle, so there is nothing to
        // write and nothing to report.
        expect(() => dispatch({ command: 'stop', pane_id: 'X', background_tasks: 0 }, null)).not.toThrow();
        expect(onError).not.toHaveBeenCalled();
    });

    it('turns a throwing handler into a structured failure instead of a hung reader', () => {
        const onError = vi.fn();
        const dispatch = createDispatcher<Ctx>({
            ctx: { seen: [] },
            tables: [
                table([
                    [
                        'ping',
                        () => {
                            throw new Error('boom');
                        }
                    ]
                ])
            ],
            onError
        });

        const reply = stubReply();
        dispatch({ command: 'ping' }, reply);
        expect(reply.payloads).toEqual([{ ok: false, error: 'internal error: boom' }]);
        expect(reply.closed).toBe(true);
        expect(onError).toHaveBeenCalledWith(expect.any(Error), 'handler ping');
    });

    it('does not double-answer when the handler already replied before throwing', () => {
        const dispatch = createDispatcher<Ctx>({
            ctx: { seen: [] },
            tables: [
                table([
                    [
                        'ping',
                        (_msg, _ctx, reply) => {
                            reply?.send({ ok: true });
                            reply?.close();
                            throw new Error('after the reply');
                        }
                    ]
                ])
            ]
        });

        const reply = stubReply();
        dispatch({ command: 'ping' }, reply);
        expect(reply.payloads).toEqual([{ ok: true }]);
    });
});
