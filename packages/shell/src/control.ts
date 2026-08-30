/**
 * A minimal control-protocol client for the main process.
 *
 * The shell almost never talks to the control socket — state comes over the WS status
 * connection and every user action happens in the renderer. The exception is Finder
 * "Open With": a file URL arrives in the main process (possibly before the window exists),
 * and the daemon's `open` verb is the thing that turns it into a pane.
 *
 * It dials the RUN DIR's socket (`daemon-v<PROTO>.sock`), never `/tmp/nex.sock`. The compat
 * path belongs to whatever `kelpi` CLI the user has installed — on a development machine that
 * is the shipped Swift app — and the shell has no business connecting to a daemon it did not
 * discover through the run dir.
 */

import net from 'node:net';

import { createLineBuffer, type JsonObject } from '@kelpi/protocol';

export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

export interface ControlResult {
    readonly ok: boolean;
    readonly reply?: JsonObject | undefined;
    readonly error?: string | undefined;
}

/**
 * Send one newline-JSON command. Fire-and-forget verbs never answer, so `expectReply: false`
 * resolves as soon as the bytes are written; allowlisted verbs resolve on the reply line.
 */
export function sendControlCommand(
    socketPath: string,
    payload: JsonObject,
    options: { readonly expectReply?: boolean; readonly timeoutMs?: number } = {}
): Promise<ControlResult> {
    const expectReply = options.expectReply ?? false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

    return new Promise<ControlResult>((resolve) => {
        const socket = net.connect({ path: socketPath });
        const buffer = createLineBuffer();
        let settled = false;

        const finish = (result: ControlResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };

        const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
        timer.unref?.();

        socket.on('connect', () => {
            socket.write(`${JSON.stringify(payload)}\n`, () => {
                if (!expectReply) finish({ ok: true });
            });
        });
        socket.on('data', (chunk: Buffer) => {
            for (const line of buffer.push(chunk)) {
                try {
                    const parsed: unknown = JSON.parse(line);
                    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                        const reply = parsed as JsonObject;
                        finish({ ok: reply['ok'] === true, reply });
                        return;
                    }
                } catch {
                    // Not JSON: keep reading until the timeout says otherwise.
                }
            }
        });
        socket.on('error', (error: Error) => finish({ ok: false, error: error.message }));
        socket.on('close', () => finish({ ok: false, error: 'connection closed' }));
    });
}
