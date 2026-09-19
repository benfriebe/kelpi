/** Catchable cancellation owns the same lifetime as the desktop reservation (#207). */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { holdDesktopTestSlot } from './desktop-slot.mjs';

let active;

/** Refuse new private resources once teardown has begun. No effect outside a leaf run. */
export function assertDesktopActive() {
    if (active?.closing) throw new Error('desktop run is stopping');
}

/**
 * Register at creation, before the first await. Normal teardown and cancellation share one
 * promise, so neither can return while the other is still stopping the resource. A successful
 * stop removes its registration; failed cleanup stays owned and fails closed. Idempotence
 * also applies to standalone driver callers that do not own a desktop scope.
 */
export function ownDesktopResource(resource, method = 'stop') {
    const scope = active;
    assertDesktopActive();
    const original = resource[method].bind(resource);
    let stopping;
    const stop = (...args) => {
        stopping ??= Promise.resolve().then(() => original(...args)).then((value) => {
            scope?.cleanups.delete(stop);
            return value;
        });
        return stopping;
    };
    resource[method] = stop;
    scope?.cleanups.add(stop);
    return resource;
}

/** Leaf only: parents must not reserve a slot while awaiting their leaf children. */
export async function runDesktopTest(run) {
    if (active) throw new Error('nested desktop run would deadlock');
    const slot = await holdDesktopTestSlot();
    const scope = { cleanups: new Set(), closing: false };
    active = scope;
    let signal;
    let cancel;
    const cancelled = new Promise((resolve) => { cancel = resolve; });
    const handlers = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, () => {
        if (signal) return; // Repeated Ctrl-C must not release the slot during teardown.
        signal = name;
        scope.closing = true;
        cancel();
    }]));
    for (const [name, handler] of handlers) process.on(name, handler);
    try {
        // The losing run promise remains observed. Closing resources may reject a pending CDP
        // request; that must not become an unhandled rejection and bypass awaited cleanup.
        return await Promise.race([Promise.resolve().then(run), cancelled]);
    } finally {
        scope.closing = true;
        const keepAlive = setInterval(() => {}, 1000);
        const failures = [];
        for (const stop of [...scope.cleanups].reverse()) {
            try { await stop(); } catch (error) { failures.push(error); }
        }
        if (failures.length) {
            console.error('Desktop cleanup failed; retaining the slot because resources may still be live:', failures);
            // An operator may hard-kill a broken runner, but ordinary cancellation must never
            // advertise a free desktop while its owned resource failed to stop.
            await new Promise(() => {});
        }
        await slot.release();
        clearInterval(keepAlive);
        for (const [name, handler] of handlers) process.off(name, handler);
        active = undefined;
        if (signal) process.exit(signal === 'SIGINT' ? 130 : 143);
    }
}

/** A kill request is not an exit acknowledgement, especially at a timeout boundary. */
export async function waitForDesktopChildExit(child, { group = false } = {}) {
    const deadline = Date.now() + 5000;
    const groupAlive = () => {
        if (!group || !child.pid) return false;
        try { process.kill(-child.pid, 0); return true; } catch (error) {
            if (error.code === 'ESRCH') return false;
            throw error;
        }
    };
    while (child.pid && ((child.exitCode === null && child.signalCode === null) || groupAlive())) {
        if (Date.now() >= deadline) throw new Error(`private child ${child.pid} did not exit after teardown`);
        await sleep(20);
    }
}

/** A direct helper belongs to the leaf just as much as its daemon and Electron do. */
export function spawnDesktopHelper(command, args, options, { signal = 'SIGTERM', timeoutMs = 8000 } = {}) {
    assertDesktopActive();
    const child = spawn(command, args, options);
    const closed = new Promise(resolve => child.once('close', resolve));
    // A failed spawn has no process to stop, but must remain an observable command failure.
    let spawnError;
    child.once('error', error => {
        spawnError = error;
        console.error('Private helper failed to start:', error);
    });
    ownDesktopResource(Object.assign(child, { async stop() {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
            child.kill(signal);
            const deadline = Date.now() + timeoutMs;
            while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(20);
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await waitForDesktopChildExit(child);
        }
        // close follows stdio drain; plugin-dev's final stopped event is part of its verdict.
        await closed;
        return { code: spawnError ? -1 : child.exitCode, signal: child.signalCode };
    } }));
    child.once('close', () => { void child.stop().catch(() => {}); });
    return child;
}

/** Register a fixture listener before its first startup await, including partial boot. */
export function listenDesktopServer(server, ...args) {
    assertDesktopActive();
    let ready;
    const owner = ownDesktopResource({ get ready() { return ready; }, async stop() {
        try { await ready; } catch { return; } // A rejected listen never acquired a listener.
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } });
    ready = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(...args, resolve);
    });
    return owner;
}

/**
 * The two smoke phases intentionally let the daemon outlive its spawning shell. A fresh
 * private channel is its ownership receipt, established BEFORE daemon startup. Teardown asks
 * that connected process to stop itself; a numeric PID from a log/file never authorizes a kill.
 * A teardown receipt AND process exit are required: death alone cannot prove child cleanup.
 * PID liveness is used only to wait conservatively for exit (reuse can block, never kill).
 * Missing receipts fail closed, including cancellation before a partial boot can report in.
 */
export function ownShellSpawnedDaemon(shell, _pidFile, { env, timeoutMs = 12_000 } = {}) {
    assertDesktopActive();
    const token = randomBytes(32).toString('hex');
    let closing = false;
    const peers = [];
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.setTimeout(2000, () => socket.destroy());
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > 1024) { socket.destroy(); return; }
            if (!buffer.includes('\n')) return;
            let hello;
            try { hello = JSON.parse(buffer); } catch { socket.destroy(); return; }
            if (hello.token !== token || !Number.isSafeInteger(hello.pid) || hello.pid <= 0 || peers.length) {
                socket.destroy(); return;
            }
            socket.removeAllListeners('data');
            socket.setTimeout(0);
            const peer = { socket, pid: hello.pid, stopped: false };
            peers.push(peer);
            let receipt = '';
            socket.on('data', chunk => {
                receipt += chunk;
                if (receipt.length > 1024) { socket.destroy(); return; }
                if (receipt === 'stopped\n') peer.stopped = true;
            });
            socket.write(closing ? 'stop\n' : 'start\n');
        });
    });
    // Registration precedes listen's first await, so cancellation owns partial setup too.
    let ready = Promise.resolve();
    const owner = ownDesktopResource({ get ready() { return ready; }, async stop() {
        closing = true;
        await ready;
        const instance = shell();
        if (instance) await instance.quit();
        if (instance && peers.length === 0) {
            if (!env) throw new Error('private daemon ownership unknown: owner channel was not configured');
            const deadline = Date.now() + timeoutMs;
            while (peers.length === 0 && Date.now() < deadline) await sleep(20);
            if (peers.length === 0) throw new Error('private daemon ownership unknown: no authenticated owner channel; refusing PID-based cleanup');
        }
        for (const peer of peers) {
            const {socket, pid} = peer;
            if (!socket.destroyed) socket.write('stop\n');
            const deadline = Date.now() + timeoutMs;
            for (;;) {
                let live;
                try { process.kill(pid, 0); live = true; } catch (error) {
                    if (error.code !== 'ESRCH') throw error;
                    live = false;
                }
                if (!live && socket.destroyed) {
                    if (!peer.stopped) throw new Error(`private daemon owner ${pid} exited without confirmed resource teardown`);
                    break;
                }
                if (Date.now() >= deadline) throw new Error(`private daemon owner ${pid} has not acknowledged process exit`);
                await sleep(20);
            }
        }
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } });
    if (env) ready = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({host:'127.0.0.1', port:0}, () => {
            env.KELPI_TEST_OWNER_PORT = String(server.address().port);
            env.KELPI_TEST_OWNER_TOKEN = token;
            resolve();
        });
    });
    return owner;
}
