/**
 * The screen and clipboard are shared even when every run has a private sandbox (#207).
 * A loopback listener is an OS-owned mutex: bind is atomic across worktrees, and process
 * exit (including SIGKILL) releases it without stale files or PID-reuse recovery races.
 * This is a harness reservation, not a Kelpi daemon endpoint. Never inherit a bypass into
 * children: audit shards must each wait their turn; the sharding parent takes no slot.
 */
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export const DESKTOP_TEST_PORT = 19735;

/**
 * Hold until this runner exits, including its teardown and --keep lifetime. The listener
 * is unref'ed so it cannot keep a completed runner alive. release() is for bounded callers
 * (and unit tests); entrypoints deliberately leave ownership with the process.
 *
 * No environment override: two worktrees choosing different slots would lose isolation.
 * `port` is an injection point for non-desktop tests, which use an ephemeral port.
 */
export async function holdDesktopTestSlot({
    port = DESKTOP_TEST_PORT,
    timeoutMs = 30 * 60_000,
    pollMs = 250,
    log = (message) => process.stdout.write(`[desktop-slot] ${message}\n`)
} = {}) {
    const started = performance.now();
    let nextNotice = 0;
    for (;;) {
        const server = net.createServer((socket) => socket.destroy());
        try {
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
            });
        } catch (error) {
            if (error.code !== 'EADDRINUSE') throw error;
            const elapsed = performance.now() - started;
            if (elapsed >= timeoutMs) {
                throw new Error(`timed out waiting for the desktop test slot at 127.0.0.1:${port}; ` +
                    'another runner (or an unrelated listener) still owns it; no desktop test was started');
            }
            if (elapsed >= nextNotice) {
                log(`waiting for 127.0.0.1:${port} (${Math.floor(elapsed / 1000)}s); screen and clipboard are shared`);
                nextNotice = elapsed + 30_000;
            }
            await sleep(Math.min(pollMs, timeoutMs - elapsed));
            continue;
        }
        server.unref();
        const boundPort = server.address().port;
        log(`acquired 127.0.0.1:${boundPort} for pid ${process.pid}`);
        let released;
        return {
            port: boundPort,
            release() {
                released ??= new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
                return released;
            }
        };
    }
}
