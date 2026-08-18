/**
 * Honest stubs for the subsystems that land later: graft (M7) and web panes (M6).
 *
 * The commands are wired NOW so the CLI gets a truthful, non-zero-exit answer instead of a
 * read timeout: an allowlisted verb replies `{"ok":false,"error":"not supported yet"}`, and a
 * fire-and-forget one stays silent (§1). Boot replaces these entries wholesale once the real
 * handlers exist — a later table merged over this one wins.
 */

import { WIRE_COMMANDS } from '@nex/protocol';

import { fail, type AppHandler } from './context.js';

export const NOT_SUPPORTED_ERROR = 'not supported yet';

/** Every `graft-*` and `web-*` wire command, in the protocol's declared order. */
export const STUBBED_COMMANDS: readonly string[] = WIRE_COMMANDS.filter(
    (command) => command.startsWith('graft-') || command.startsWith('web-')
);

export function stubHandlerEntries(): readonly (readonly [string, AppHandler])[] {
    return STUBBED_COMMANDS.map((command) => {
        const handler: AppHandler = (_msg, _ctx, reply) => {
            fail(reply, NOT_SUPPORTED_ERROR);
        };
        return [command, handler] as const;
    });
}
