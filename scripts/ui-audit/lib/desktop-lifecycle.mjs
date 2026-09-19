/** Catchable cancellation owns the same lifetime as the desktop reservation (#207). */
import fs from 'node:fs';
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

/**
 * Only for the two smoke phases that intentionally exercise the app spawning a detached
 * daemon. The PID comes from this private shell's own spawn log (available before healthz),
 * with its fresh sandbox pid file as fallback. Never inspect the installed app's run dir.
 * Register before starting the shell; stop the shell first so it cannot spawn another daemon.
 */
export function ownShellSpawnedDaemon(shell, pidFile) {
    return ownDesktopResource({ async stop() {
        const instance = shell();
        if (!instance) return;
        await instance.quit();
        let pid = Number(/daemon spawned pid=(\d+)/.exec(instance.text())?.[1]);
        if (!pid && fs.existsSync(pidFile)) pid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
        if (!Number.isSafeInteger(pid) || pid <= 0) return;
        const alive = () => {
            try { process.kill(pid, 0); return true; } catch (error) {
                if (error.code === 'ESRCH') return false;
                throw error;
            }
        };
        const signal = (name) => {
            try { process.kill(pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        };
        if (!alive()) return;
        signal('SIGTERM');
        const deadline = Date.now() + 6000;
        while (alive() && Date.now() < deadline) await sleep(50);
        if (alive()) signal('SIGKILL');
        const killedDeadline = Date.now() + 5000;
        while (alive() && Date.now() < killedDeadline) await sleep(20);
        if (alive()) throw new Error(`private shell-spawned daemon ${pid} survived teardown`);
    } });
}
