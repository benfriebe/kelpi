/** Private smoke ownership channel; absent from ordinary daemon launches. */
import net from 'node:net';

/**
 * Establish ownership before boot creates resources. Only this process signals itself: a
 * stale log or reused PID can never authorize the test runner to signal another process.
 * The channel stays with the daemon after its spawning shell exits. Its random capability
 * is consumed here and removed from the environment so panes/plugins cannot inherit it.
 */
export async function connectTestOwner(env: NodeJS.ProcessEnv): Promise<void> {
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
    let stopping = false;
    const stop = (): void => {
        if (stopping) return;
        stopping = true;
        // A stalled shutdown retains the runner's slot; force-killing this daemon could
        // strand its own private descendants before it has finished stopping them.
        process.kill(process.pid, 'SIGTERM');
    };
    await new Promise<void>((resolve, reject) => {
        let started = false;
        let buffer = '';
        socket.setTimeout(5000, () => socket.destroy(new Error('private test owner handshake timed out')));
        socket.on('connect', () => socket.write(JSON.stringify({token, pid:process.pid}) + '\n'));
        socket.on('error', reject);
        socket.on('close', () => {
            if (started) stop();
            else reject(new Error('private test owner closed before startup permission'));
        });
        socket.on('data', chunk => {
            buffer += chunk;
            for (;;) {
                const newline = buffer.indexOf('\n');
                if (newline < 0) break;
                const command = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (command === 'stop') stop();
                else if (command === 'start' && !started && !stopping) {
                    started = true;
                    socket.setTimeout(0);
                    socket.unref();
                    resolve();
                }
            }
        });
    });
}
