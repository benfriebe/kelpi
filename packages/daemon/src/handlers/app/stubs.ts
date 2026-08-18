/**
 * The honest-stub mechanism for wire commands whose subsystem has not landed yet.
 *
 * A stubbed command is wired so the CLI gets a truthful, non-zero-exit answer instead of a read
 * timeout: an allowlisted verb replies `{"ok":false,"error":"not supported yet"}`, and a
 * fire-and-forget one stays silent (§1). `handlerTable` rejects duplicates, so a stub and a
 * real handler can never both claim a command — the list below has to shrink as families land.
 *
 * Both original tenants have now moved out: `graft-*` in M7 (`handlers/app/graft.ts`) and
 * `web-*` in M6 (`webpane/handlers.ts`). The list is therefore EMPTY, and the mechanism is kept
 * because the next protocol addition will want it again.
 */

import { fail, type AppHandler } from './context.js';

export const NOT_SUPPORTED_ERROR = 'not supported yet';

/**
 * Wire commands with no implementation, in the protocol's declared order. Currently none —
 * add a command name here (and nowhere else) when a future protocol addition lands ahead of
 * its subsystem.
 */
export const STUBBED_COMMANDS: readonly string[] = [];

export function stubHandlerEntries(): readonly (readonly [string, AppHandler])[] {
    return STUBBED_COMMANDS.map((command) => {
        const handler: AppHandler = (_msg, _ctx, reply) => {
            fail(reply, NOT_SUPPORTED_ERROR);
        };
        return [command, handler] as const;
    });
}
