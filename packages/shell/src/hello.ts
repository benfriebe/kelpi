/**
 * The `hello` frame both of the shell's daemon sockets send (`./status.ts` and
 * `./webhost/client.ts`).
 *
 * It is one function rather than two literals because of a compatibility rule that is easy to
 * break by accident. The shell authenticates its upgrades with an `Authorization: Bearer`
 * header — the token stays out of URLs and logs — while a browser can only put the token in
 * the query string. Since the daemon stopped refusing unauthenticated upgrades (a browser
 * cannot see WHY an upgrade failed, so a 401 became an infinite reconnect loop;
 * `daemon/src/ws/http.ts`), the handshake is where authentication happens for everyone.
 *
 * The daemon therefore exempts a **bearer-authenticated** connection from presenting the token
 * again — an upgrade-authenticated socket whose hello omits it stays authenticated
 * (`daemon/src/ws/sync.ts`). The shell does not lean on that exemption: it sends the token in
 * the hello too, so it authenticates identically whichever half the daemon checks, and the
 * exemption stays a safety net rather than a dependency. That is what this module guarantees,
 * and what `hello.test.ts` pins.
 */

import { WS_PROTOCOL_VERSION, type JsonObject } from '@kelpi/protocol';

export interface ShellHelloOptions {
    /** The run dir's token; the same value the bearer header carries. */
    readonly token: string;
    /** Diagnostics: shows up in the daemon's logs. */
    readonly name: string;
    readonly version: string;
    /** `['web-pane-host']` claims the web-pane host role in the handshake (M6). */
    readonly capabilities?: readonly string[] | undefined;
}

/** The exact object a shell socket writes as its first frame. */
export function shellHello(options: ShellHelloOptions): JsonObject {
    return {
        type: 'hello',
        protocolVersion: WS_PROTOCOL_VERSION,
        token: options.token,
        client: {
            kind: 'electron',
            name: options.name,
            version: options.version,
            ...(options.capabilities === undefined ? {} : { capabilities: [...options.capabilities] })
        }
    };
}
