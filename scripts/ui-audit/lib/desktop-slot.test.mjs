import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { holdDesktopTestSlot } from './desktop-slot.mjs';

const leases = [];
const children = [];
const moduleURL = new URL('./desktop-slot.mjs', import.meta.url).href;
const quiet = () => {};
async function hold(options = {}) {
    const lease = await holdDesktopTestSlot({ port: 0, log: quiet, ...options });
    leases.push(lease);
    return lease;
}
function child(source, cwd) {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], {
        cwd, stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(process);
    let output = '';
    process.stdout.on('data', (chunk) => { output += chunk; });
    process.stderr.on('data', (chunk) => { output += chunk; });
    const exited = once(process, 'exit');
    return { process, exited, output: () => output };
}
async function line(process, expected) {
    await new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => done(new Error(`missing ${expected}: ${output}`)), 5_000);
        const read = (chunk) => {
            output += chunk;
            if (output.includes(expected)) done();
        };
        const exit = () => done(new Error(`child exited before ${expected}: ${output}`));
        const done = (error) => {
            clearTimeout(timer);
            process.stdout.off('data', read);
            process.off('exit', exit);
            error ? reject(error) : resolve();
        };
        process.stdout.on('data', read);
        process.once('exit', exit);
    });
}

afterEach(async () => {
    for (const process of children.splice(0)) {
        if (process.exitCode === null && process.signalCode === null) {
            const exited = once(process, 'exit');
            process.kill('SIGKILL');
            await exited;
        }
    }
    await Promise.all(leases.splice(0).map((lease) => lease.release()));
});

it('excludes a process in another directory until the owner releases the slot', async () => {
    const owner = await hold();
    const contender = child(`
        import { holdDesktopTestSlot } from ${JSON.stringify(moduleURL)};
        await holdDesktopTestSlot({ port: ${owner.port}, pollMs: 10 });
        console.log('desktop work started');
    `, '/');
    await line(contender.process, 'waiting for');
    expect(contender.output()).not.toContain('desktop work started');
    await owner.release();
    expect((await contender.exited)[0], contender.output()).toBe(0);
    expect(contender.output()).toContain('desktop work started');
    // Neither a normal exit nor an explicit release leaves stale ownership behind.
    await hold({ port: owner.port });
});

it('releases after SIGKILL without a stale lock or a PID recovery heuristic', async () => {
    const owner = child(`
        import { holdDesktopTestSlot } from ${JSON.stringify(moduleURL)};
        await holdDesktopTestSlot({ port: 0, log: () => {} }).then(s => console.log('PORT=' + s.port));
        setInterval(() => {}, 1000);
    `);
    await line(owner.process, 'PORT=');
    const port = Number(owner.output().match(/PORT=(\d+)/)[1]);
    await expect(hold({ port, timeoutMs: 30, pollMs: 5 })).rejects.toThrow('timed out waiting');
    owner.process.kill('SIGKILL');
    expect((await owner.exited)[1]).toBe('SIGKILL');
    await hold({ port });
});

it('fails closed on timeout, without releasing the other owner or starting work', async () => {
    const owner = await hold();
    const contender = child(`
        import { holdDesktopTestSlot } from ${JSON.stringify(moduleURL)};
        await holdDesktopTestSlot({ port: ${owner.port}, timeoutMs: 30, pollMs: 5 });
        console.log('desktop work started');
    `);
    expect((await contender.exited)[0]).toBe(1);
    expect(contender.output()).toContain('no desktop test was started');
    expect(contender.output()).not.toContain('\ndesktop work started\n');
    await expect(hold({ port: owner.port, timeoutMs: 0 })).rejects.toThrow('timed out waiting');
});

it('does not keep a completed or failed runner alive', async () => {
    for (const ending of ['', 'throw new Error("fixture failure");']) {
        const runner = child(`
            import { holdDesktopTestSlot } from ${JSON.stringify(moduleURL)};
            await holdDesktopTestSlot({ port: 0 });
            ${ending}
        `);
        expect((await runner.exited)[0]).toBe(ending === '' ? 0 : 1);
        const port = Number(runner.output().match(/127\.0\.0\.1:(\d+)/)[1]);
        await hold({ port });
    }
});

it('propagates non-contention listen errors instead of retrying or bypassing isolation', async () => {
    await expect(hold({ port: -1 })).rejects.toThrow();
});

it('cancels a waiting runner without disturbing the owner', async () => {
    const owner = await hold();
    const waiter = child(`
        import { holdDesktopTestSlot } from ${JSON.stringify(moduleURL)};
        await holdDesktopTestSlot({ port: ${owner.port}, pollMs: 5 });
        console.log('desktop work started');
    `);
    await line(waiter.process, 'waiting for');
    waiter.process.kill('SIGINT');
    expect((await waiter.exited)[1]).toBe('SIGINT');
    expect(waiter.output()).not.toContain('desktop work started');
    await expect(hold({ port: owner.port, timeoutMs: 0 })).rejects.toThrow('timed out waiting');
});

it('keeps a leaf runner exclusive after its non-owning orchestration parent dies', async () => {
    // verify -> audit parent -> leaf: only the leaf owns the port, so killing an ancestor
    // cannot release it or pass a stale environment-token bypass to the next runner.
    const parent = child(`
        import { spawn } from 'node:child_process';
        const leaf = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`
            import { holdDesktopTestSlot } from ${JSON.stringify(moduleURL)};
            const slot = await holdDesktopTestSlot({ port: 0, log: () => {} });
            console.log('LEAF=' + process.pid + ':' + slot.port);
            setTimeout(() => process.exit(), 10_000);
        `)}], { stdio: ['inherit', 'inherit', 'inherit'] });
        setInterval(() => {}, 1000);
    `);
    await line(parent.process, 'LEAF=');
    const [, pid, port] = parent.output().match(/LEAF=(\d+):(\d+)/);
    try {
        parent.process.kill('SIGKILL');
        await parent.exited;
        await expect(hold({ port: Number(port), timeoutMs: 30, pollMs: 5 })).rejects.toThrow('timed out waiting');
    } finally {
        try { process.kill(Number(pid), 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
});
