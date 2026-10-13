/**
 * Which dispatched messages are §3.1 dual-fires (`dualFireMessage` in `./server.ts`), so a
 * handler can tell the synthesized session-start from a hook's own: #387's `agent.event` is one
 * per hook line, and the dual-fire is the second half of a line, not a hook of its own. Each
 * remembers the primary message of the line it was synthesized from, so the second half pairs
 * with its own first half and never with an unrelated line's.
 */

import type { WireMessage } from '@kelpi/protocol';

const dualFires = new WeakMap<WireMessage, WireMessage>();

export function markDualFire<M extends WireMessage>(message: M, primary: WireMessage): M {
    dualFires.set(message, primary);
    return message;
}

export function isDualFire(message: WireMessage): boolean {
    return dualFires.has(message);
}

/** The primary message of the line `message` is the dual-fire of; undefined for any other message. */
export function dualFirePrimary(message: WireMessage): WireMessage | undefined {
    return dualFires.get(message);
}
