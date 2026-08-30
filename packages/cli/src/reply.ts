/**
 * The shared reply pipeline (cli.md §6): four helpers, one wording each.
 *
 * `readReplyOrExit` → transport failure and empty replies; `parseReplyOrExit` → invalid JSON
 * and the `{ok:false,error}` envelope; `decodeReply` is the two composed, which is what almost
 * every request/response verb uses. `decodeReplyAllowingFailure` is the bulk-delete variant:
 * a well-formed `ok:false` is RETURNED so the batch can record it and continue, while
 * transport/empty/invalid-JSON stay fatal for the whole batch.
 *
 * The two commands with bespoke empty-reply handling (`pane send` treats it as success,
 * `send-key`/`resize`/`move`/`sync` as "this Kelpi is too old") call the raw send themselves and
 * then `parseReplyOrExit`; that split is a mixed-version compatibility shim the port keeps.
 */

import { errLine, exit } from './io.js';
import { asBool, asString, parseJsonObject, type JsonObject } from './json.js';
import { printTransportFailure, sendJSONAndReadReply, type ReadOptions } from './transport.js';

export async function readReplyOrExit(payload: JsonObject, command: string, options: ReadOptions = {}): Promise<string> {
    const data = await sendJSONAndReadReply(payload, options);
    if (data === null) {
        printTransportFailure(command);
        exit(1);
    }
    if (data.length === 0) {
        errLine(`${command}: no response from Kelpi (upgrade required?)`);
        errLine(
            'Repair: if the running Kelpi is recent, the app may be wedged — try `kelpi doctor` first, then restart Kelpi if needed.'
        );
        exit(1);
    }
    return data;
}

export function parseReplyOrExit(data: string, command: string): JsonObject {
    const json = parseJsonObject(data);
    if (json === null) {
        errLine(`${command}: invalid JSON response`);
        exit(1);
    }
    if (asBool(json['ok']) === false) {
        errLine(`${command}: ${asString(json['error']) ?? 'unknown error'}`);
        exit(1);
    }
    return json;
}

export async function decodeReply(payload: JsonObject, command: string, options: ReadOptions = {}): Promise<JsonObject> {
    const data = await readReplyOrExit(payload, command, options);
    return parseReplyOrExit(data, command);
}

/** Bulk `workspace delete`: `{ok:false}` comes back instead of exiting. */
export async function decodeReplyAllowingFailure(payload: JsonObject, command: string): Promise<JsonObject> {
    const data = await readReplyOrExit(payload, command);
    const json = parseJsonObject(data);
    if (json === null) {
        errLine(`${command}: invalid JSON response`);
        exit(1);
    }
    return json;
}
