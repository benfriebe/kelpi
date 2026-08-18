/**
 * Reply serialization (wire-protocol.md §2.3): exactly one compact JSON object per line,
 * `\n` terminated. The caller closes the connection after writing it — that EOF is the
 * CLI's end-of-reply marker for every allowlisted command except the `web-console --follow`
 * stream, which writes one line per console entry and stays open.
 */

import type { ReplyFailure } from './types.js';

/** One compact JSON line + `\n`. Keys whose value is `undefined` are omitted. */
export function serializeReply(reply: object): string {
    return `${JSON.stringify(reply)}\n`;
}

/** `{"ok":false,"error":…}` with optional typed extras (`active_agents`, …). */
export function errorReply<E extends object>(error: string, extras?: E): ReplyFailure & E {
    return { ok: false, error, ...(extras ?? ({} as E)) };
}

/** Serialize a failure directly; the common path for guard/resolution errors. */
export function serializeError(error: string, extras?: object): string {
    return serializeReply(errorReply(error, extras));
}
