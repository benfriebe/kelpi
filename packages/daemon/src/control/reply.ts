/**
 * Reply handles for the control transport (wire-protocol.md §2.3–§2.5).
 *
 * Contract the CLI depends on:
 *   - a reply is **one compact JSON line + `\n`**, then EOF (the CLI reads until EOF, not
 *     until the first newline — see port note 4);
 *   - `web-console --follow` is the single exception: it keeps writing lines and never
 *     closes until the client goes away;
 *   - writing to a vanished client is harmless (`EPIPE` is swallowed — port note 13);
 *   - when the peer disconnects, every handle bound to that connection is released and its
 *     disconnect callbacks fire once, which is how follow-stream subscribers are reaped
 *     (`socketSubscriberDisconnected`, port note 5).
 *
 * `close()` ends the writable side (that FIN is the client's end-of-reply marker) and then
 * destroys the socket once the bytes have flushed.
 */

import type { Socket } from 'node:net';

import { serializeReply } from '@nex/protocol';

import type { ReplyHandle } from '../seams.js';

export interface ReplyHandleHooks {
    /** A write failed (`EPIPE` when the client already hung up). Diagnostics only. */
    readonly onWriteError?: ((error: Error) => void) | undefined;
    /** The handle became unusable (peer gone, or we closed it). Diagnostics only. */
    readonly onRelease?: ((handle: ReplyHandle) => void) | undefined;
}

/** A `ReplyHandle` the owning transport can also tear down when the peer vanishes. */
export interface TransportReplyHandle extends ReplyHandle {
    /** Transport-side: the connection died; fires the disconnect callbacks once. */
    peerGone(): void;
    /** Lines written so far (tests / diagnostics). */
    readonly sent: number;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function createReplyHandle(socket: Socket, hooks: ReplyHandleHooks = {}): TransportReplyHandle {
    let dead = false;
    let sent = 0;
    let callbacks: (() => void)[] = [];

    const release = (): void => {
        if (dead) return;
        dead = true;
        const pending = callbacks;
        callbacks = [];
        for (const callback of pending) {
            try {
                callback();
            } catch (error) {
                hooks.onWriteError?.(toError(error));
            }
        }
        hooks.onRelease?.(handle);
    };

    const handle: TransportReplyHandle = {
        send(payload) {
            if (dead || socket.destroyed || socket.writableEnded) return;
            try {
                socket.write(serializeReply(payload));
                sent += 1;
            } catch (error) {
                // A client that `^C`d between request and reply: nothing to do but note it.
                hooks.onWriteError?.(toError(error));
            }
        },
        close() {
            if (dead) return;
            // Flush, FIN (the CLI's EOF), then let go of the descriptor.
            if (!socket.destroyed && !socket.writableEnded) {
                try {
                    socket.end(() => {
                        socket.destroy();
                    });
                } catch (error) {
                    hooks.onWriteError?.(toError(error));
                    socket.destroy();
                }
            }
            release();
        },
        get closed() {
            return dead;
        },
        onDisconnect(callback) {
            // Registering after the fact still has to reap the subscriber.
            if (dead) {
                callback();
                return;
            }
            callbacks.push(callback);
        },
        peerGone() {
            release();
        },
        get sent() {
            return sent;
        }
    };

    return handle;
}
