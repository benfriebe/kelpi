/**
 * `ping` (socket-handlers.md §10) — the one command that always succeeds.
 *
 * `nex doctor` keys off every field: `version`/`build` flag CLI/app drift, `pid` tells a stale
 * socket file from a wedged daemon. `protocol` is ADDITIVE (the Swift app never sent it, and
 * the CLI ignores unknown keys) so a daemon-aware CLI can negotiate later.
 */

import { forCommand } from './common.js';
import { ok, type AppHandler } from './context.js';

export function pingHandlerEntries(): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('ping', (_msg, ctx, reply) => {
            ok(reply, {
                version: ctx.version.version,
                build: ctx.version.build,
                pid: process.pid,
                protocol: ctx.version.protocol
            });
        })
    ];
}
