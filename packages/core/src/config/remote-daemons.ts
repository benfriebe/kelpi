/**
 * `remote-daemon = <name>:<url>` line parsing and serialization — the client's registry of
 * OTHER kelpi daemons it may attach to (multi-daemon groups; config-keybindings.md §1.7).
 *
 * The value splits at its FIRST `:` (the name), and the remainder is the URL verbatim — so
 * `werk:https://werk.taila.ts.net/?token=kd_x` names daemon `werk`. The URL is exactly what
 * the other daemon's own Settings ▸ Remote pairing card hands out: origin plus `?token=`,
 * which is everything a connection needs. Same merge rules as `profile` lines: repeated
 * names, the LATER line wins; order is first appearance.
 */

import { parseConfigLines } from './lines.js';

export interface RemoteDaemon {
    readonly name: string;
    /** The pairing URL (`https://host[:port]/?token=…`) — origin + credential in one string. */
    readonly url: string;
}

export function parseRemoteDaemons(contents: string): RemoteDaemon[] {
    const order: string[] = [];
    const byName = new Map<string, string>();
    for (const line of parseConfigLines(contents)) {
        if (line.key !== 'remote-daemon') continue;
        const separator = line.value.indexOf(':');
        if (separator < 0) continue;
        const name = line.value.slice(0, separator).trim();
        const url = line.value.slice(separator + 1).trim();
        if (name === '' || url === '') continue;
        if (!byName.has(name)) order.push(name);
        byName.set(name, url);
    }
    return order.map((name) => ({ name, url: byName.get(name) ?? '' }));
}

export function serializeRemoteDaemonLines(daemons: readonly RemoteDaemon[]): string[] {
    return daemons.map((daemon) => `remote-daemon = ${daemon.name}:${daemon.url}`);
}
