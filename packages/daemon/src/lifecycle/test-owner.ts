/** Private smoke ownership channel; absent from ordinary daemon launches. */
import net from 'node:net';

export interface TestOwner {
    readonly stopRequested: boolean;
    readonly whenStopRequested: Promise<void>;
    /** Only after startup has settled and every resource it created has stopped. */
    confirmStopped(): Promise<void>;
}

/**
 * Consume the capability before boot builds any pane/plugin environment. The owner queues
 * cancellation; it must never signal a partially booted daemon past its cleanup path. Only
 * foreground test launches use this lifetime, leaving ordinary daemon signals unchanged.
 */
export async function connectTestOwner(env: NodeJS.ProcessEnv): Promise<TestOwner | undefined> {
    const portText = env['KELPI_TEST_OWNER_PORT'];
    const token = env['KELPI_TEST_OWNER_TOKEN'];
    delete env['KELPI_TEST_OWNER_PORT'];
    delete env['KELPI_TEST_OWNER_TOKEN'];
    if (portText === undefined && token === undefined) return;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token ?? '')) {
        throw new Error('invalid private test owner channel');
    }
    const socket = net.createConnection({host:'127.0.0.1', port});
    let stopRequested = false;
    let requestStop!: () => void;
    const whenStopRequested = new Promise<void>(resolve => { requestStop = resolve; });
    const stop = (): void => {
        stopRequested = true;
        requestStop();
    };
    // Catch repeated signals even before startup has installed its ordinary handlers. The
    // test entrypoint serializes startup and stop instead of creating resources after teardown.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
    const dispose = (): void => {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.off(signal, stop);
    };
    let confirmed: Promise<void> | undefined;
    const owner: TestOwner = {
        get stopRequested() { return stopRequested; },
        whenStopRequested,
        confirmStopped() {
            confirmed ??= new Promise<void>(resolve => {
                // A disconnected owner cannot receive a receipt and will retain its slot.
                // Locally, cleanup is already complete, so the daemon may still finish.
                const done = (): void => { dispose(); socket.destroy(); resolve(); };
                if (socket.destroyed) done();
                else {
                    socket.once('close', done);
                    socket.end('stopped\n', done);
                }
            });
            return confirmed;
        }
    };
    try {
        await new Promise<void>((resolve, reject) => {
            let permitted = false;
            let buffer = '';
            socket.setTimeout(5000, () => socket.destroy(new Error('private test owner handshake timed out')));
            socket.on('connect', () => socket.write(JSON.stringify({token, pid:process.pid}) + '\n'));
            socket.on('error', error => { stop(); reject(error); });
            socket.on('close', () => {
                stop();
                if (!permitted) reject(new Error('private test owner closed before startup permission'));
            });
            socket.on('data', chunk => {
                buffer += chunk;
                if (buffer.length > 1024) { socket.destroy(new Error('invalid private test owner command')); return; }
                for (;;) {
                    const newline = buffer.indexOf('\n');
                    if (newline < 0) break;
                    const command = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    if (command === 'stop') stop();
                    if ((command === 'start' || command === 'stop') && !permitted) {
                        permitted = true;
                        socket.setTimeout(0);
                        // Keep the channel referenced until confirmed cleanup: an unresolved
                        // startup/stop must not silently exit and pretend resources are gone.
                        resolve();
                    }
                }
            });
        });
        return owner;
    } catch (error) {
        dispose();
        socket.destroy();
        throw error;
    }
}
