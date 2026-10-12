/**
 * Which dispatched messages are §3.1 dual-fires (`dualFireMessage` in `./server.ts`), so a
 * handler can tell the synthesized session-start from a hook's own: #387's `agent.event` is one
 * per hook line, and the dual-fire is the second half of a line, not a hook of its own.
 */

import type { WireMessage } from '@kelpi/protocol';

const dualFires = new WeakSet<WireMessage>();

export function markDualFire<M extends WireMessage>(message: M): M {
    dualFires.add(message);
    return message;
}

export function isDualFire(message: WireMessage): boolean {
    return dualFires.has(message);
}
