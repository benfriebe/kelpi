import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { holdDesktopTestSlot } from './desktop-slot.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const url = (p) => pathToFileURL(p).href;
const lib = path.join(root, 'scripts/ui-audit/lib');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate, detail) {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await sleep(10); }
    throw new Error('fixture deadline: ' + detail());
}

// Actual scenario + driver + recorder + guard. Only stack/CDP/native-harness boundaries are
// replaced. Detached Node children deliberately survive a runner that skips awaited stop.
for (const sample of [
    { name: 'SIGINT during initial boot', signal: 'SIGINT', boot: true },
    { name: 'SIGTERM during initial boot', signal: 'SIGTERM', boot: true },
    { name: 'SIGTERM in shared scenario', signal: 'SIGTERM' },
    { name: 'SIGINT in dedicated scenario', signal: 'SIGINT', dedicated: true },
    { name: 'SIGTERM during dedicated boot', signal: 'SIGTERM', dedicated: true, boot: true },
    { name: 'SIGINT while keeping sandbox', signal: 'SIGINT', keep: true }
]) it(sample.name + ' stops all resources before the next owner acquires', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-cancel-'));
    const ledger = path.join(temp, 'ledger');
    const portFile = path.join(temp, 'port');
    fs.writeFileSync(ledger, '');
    const events = () => fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const write = (name, content) => { const file = path.join(temp, name + '.mjs'); fs.writeFileSync(file, content); return file; };
    const slot = write('slot', `import fs from 'node:fs';
        export { DESKTOP_TEST_PORT } from ${JSON.stringify(url(path.join(lib, 'desktop-slot.mjs')))};
        import { holdDesktopTestSlot as hold } from ${JSON.stringify(url(path.join(lib, 'desktop-slot.mjs')))};
        export async function holdDesktopTestSlot() {
            const slot = await hold({ port: 0 }); fs.writeFileSync(${JSON.stringify(portFile)}, String(slot.port)); return slot;
        }`);
    const stack = write('stack', `import fs from 'node:fs'; import { spawn } from 'node:child_process';
        import { once } from 'node:events';
        const record = e => fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify(e) + '\\n');
        let count = 0;
        export const buildAll = async () => {};
        export const clearBackgroundTaskPolicy = () => {};
        export const makeCli = () => ({ run: async () => ({ code: 0, stdout: '[]' }) });
        export const makeSandbox = async () => ({ id: ++count, root: ${JSON.stringify(temp)},
            debugPort: 1, base: 'private fixture', cleanup: () => record({ event: 'sandbox', id: count }) });
        function resource(id, kind) {
            const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150)); console.log('ready'); setInterval(() => {}, 1000)"],
                { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
            record({ event: 'spawn', id, kind, pid: child.pid });
            const ready = once(child.stdout, 'data');
            let stopping;
            return { ready, stop: () => stopping ??= (async () => {
                await ready; record({ event: 'stopping', id, kind });
                const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
                record({ event: 'stopped', id, kind, pid: child.pid });
            })() };
        }
        export function restartableDaemon(box) {
            let owned;
            return { start: async () => {
                owned = resource(box.id, 'daemon'); await owned.ready;
                if (${!!sample.boot} && box.id === ${sample.dedicated ? 2 : 1}) {
                    console.log('FIXTURE_READY'); await new Promise(() => {});
                }
            }, stop: async () => { await owned?.stop(); } };
        }
        export function startShell(box) {
            const owned = resource(box.id, 'shell');
            return { quit: owned.stop, waitForLine: async () => {
                await owned.ready; return 'harness-window: placement=' + (box.id === 2 ? 'offscreen' : 'hidden');
            } };
        }`);
    const cdp = write('cdp', `import { EventEmitter } from 'node:events';
        export const MOD = {}, sleep = async () => {}, listTargets = async () => [];
        export const waitForPageTarget = async () => ({ webSocketDebuggerUrl: 'fixture' });
        export const connect = async () => Object.assign(new EventEmitter(), {
            send: async () => {}, eval: async () => true, close: () => {} });`);
    const net = write('net', `import { EventEmitter } from 'node:events';
        export default { createConnection() {
            const s = new EventEmitter(); s.setEncoding = s.end = () => {};
            s.write = line => { const {id, op} = JSON.parse(line);
                queueMicrotask(() => s.emit('data', JSON.stringify({id, ok:true, result: {released:true}}) + '\\n')); };
            queueMicrotask(() => s.emit('connect')); return s;
        } };`);
    const hook = write('hook', `import { registerHooks } from 'node:module';
        registerHooks({ resolve(s, c, next) {
            const driver = c.parentURL === ${JSON.stringify(url(path.join(lib, 'driver.mjs')))};
            const target = s.endsWith('/desktop-slot.mjs') && (c.parentURL?.endsWith('/desktop-lifecycle.mjs') || c.parentURL?.endsWith('/scenario.mjs')) ? ${JSON.stringify(url(slot))}
                : driver && s === './stack.mjs' ? ${JSON.stringify(url(stack))}
                : driver && s === './cdp.mjs' ? ${JSON.stringify(url(cdp))}
                : driver && s === 'node:net' ? ${JSON.stringify(url(net))} : null;
            return target ? { url: target, shortCircuit: true } : next(s, c);
        }});`);
    const scenario = write('scenario', `${sample.dedicated ? "export const windowPlacement = 'offscreen';" : ''}
        export default async () => { ${sample.keep ? '' : "console.log('FIXTURE_READY'); await new Promise(() => {});"} };`);
    const child = spawn(process.execPath, ['--import', hook, path.join(root, 'scripts/scenario.mjs'),
        '--no-build', '--window', 'hidden', '--out', path.join(temp, 'out'), ...(sample.keep ? ['--keep'] : []), scenario],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const exit = once(child, 'exit');
    let nextSlot;
    try {
        await until(() => output.includes(sample.keep ? '--keep: leaving' : 'FIXTURE_READY'), () => output);
        const port = Number(fs.readFileSync(portFile, 'utf8'));
        let acquired = false;
        nextSlot = holdDesktopTestSlot({ port, timeoutMs: 5000, pollMs: 10, log: () => {} }).then(slot => {
            acquired = true;
            const live = events().filter(e => e.event === 'spawn' && alive(e.pid));
            return { slot, live };
        });
        child.kill(sample.signal);
        await until(() => events().some(e => e.event === 'stopping') || child.signalCode !== null, () => output);
        expect(acquired, 'slot stays held through delayed resource teardown').toBe(false);
        // A second cancellation while stopping must not invoke Node's default signal exit.
        if (child.exitCode === null && child.signalCode === null) child.kill(sample.signal);
        const [code, signal] = await exit;
        const { slot, live } = await nextSlot;
        await slot.release();
        expect({ code, signal }, output).toEqual({ code: sample.signal === 'SIGINT' ? 130 : 143, signal: null });
        expect(live).toEqual([]);
        expect(events().filter(e => e.event === 'stopped')).toHaveLength(events().filter(e => e.event === 'spawn').length);
        expect(events().filter(e => e.event === 'spawn')).toHaveLength(sample.boot ? (sample.dedicated ? 3 : 1) : (sample.dedicated ? 4 : 2));
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        for (const e of events()) if (e.event === 'spawn' && alive(e.pid)) process.kill(e.pid, 'SIGKILL');
        if (nextSlot) { try { await (await nextSlot).slot.release(); } catch { /* failed probe */ } }
        fs.rmSync(temp, { recursive: true, force: true });
    }
}, 10_000);

// Load the real private-process factories used by the audit and all five smokes. Only their
// entrypoint and spawn boundary are substituted: no build, Electron, daemon, or desktop runs.
for (const [file, factories] of [
    ['scripts/ui-audit/lib/stack.mjs', ['startDaemon', 'startShell']],
    ['packages/shell/scripts/smoke.mjs', ['startDaemon', 'startShell']],
    ['packages/shell/scripts/web-smoke.mjs', ['startDaemon', 'startShell']],
    ['packages/shell/scripts/pwa-smoke.mjs', ['startDaemon', 'startProbe']],
    ['packages/shell/scripts/terminal-smoke.mjs', ['startDaemon', 'startShell']],
    ['packages/shell/scripts/packaged-smoke.mjs', ['startApp']]
]) it(file + ' registers private processes before startup awaits', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-leaf-cancel-'));
    const ledger = path.join(temp, 'pids');
    const portFile = path.join(temp, 'port');
    const target = url(path.join(root, file));
    const write = (name, content) => { const p = path.join(temp, name + '.mjs'); fs.writeFileSync(p, content); return url(p); };
    const slot = write('slot', `import fs from 'node:fs';
        export { DESKTOP_TEST_PORT } from ${JSON.stringify(url(path.join(lib, 'desktop-slot.mjs')))};
        import { holdDesktopTestSlot as hold } from ${JSON.stringify(url(path.join(lib, 'desktop-slot.mjs')))};
        export async function holdDesktopTestSlot() { const s = await hold({port:0}); fs.writeFileSync(${JSON.stringify(portFile)}, String(s.port)); return s; }`);
    const spawnFixture = write('spawn', `import fs from 'node:fs'; import { spawn as realSpawn } from 'node:child_process';
        import { once } from 'node:events';
        const ready = [];
        export const waitReady = () => Promise.all(ready);
        export const spawnSync = () => ({ status: 0 });
        export function spawn(_command, _args, options) {
            const child = realSpawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); console.log('ready'); setInterval(() => {}, 1000)"],
                { detached: options.detached, stdio: ['ignore', 'pipe', 'pipe'] });
            fs.appendFileSync(${JSON.stringify(ledger)}, child.pid + '\\n'); ready.push(once(child.stdout, 'data')); return child;
        }`);
    const hook = write('hook', `import { registerHooks } from 'node:module';
        registerHooks({ resolve(s,c,next) {
            if (s === './desktop-slot.mjs' && c.parentURL?.endsWith('/desktop-lifecycle.mjs')) return {url:${JSON.stringify(slot)},shortCircuit:true};
            if (s === 'node:child_process' && c.parentURL === ${JSON.stringify(target)}) return {url:${JSON.stringify(spawnFixture)},shortCircuit:true};
            return next(s,c);
        }, load(u,c,next) {
            const loaded = next(u,c);
            if (u !== ${JSON.stringify(target)}) return loaded;
            let source = String(loaded.source);
            if (!u.endsWith('/stack.mjs')) {
                const start = source.search(/\\n(?:await )?runDesktopTest\\(main\\)/);
                if (start < 0) throw new Error('entrypoint seam missing');
                source = source.slice(0,start) + '\\nexport { ${factories.join(', ')} };';
            }
            return {...loaded, source};
        }});`);
    const runner = write('runner', `import { runDesktopTest } from ${JSON.stringify(url(path.join(lib, 'desktop-lifecycle.mjs')))};
        import * as factory from ${JSON.stringify(target)};
        import { waitReady } from ${JSON.stringify(spawnFixture)};
        await runDesktopTest(async () => {
            const sandbox = { env: process.env, userData: ${JSON.stringify(temp)}, home: ${JSON.stringify(temp)}, probe: ${JSON.stringify(temp)}, debugPort: 1 };
            for (const name of ${JSON.stringify(factories)}) factory[name](sandbox, {repoRoot: ${JSON.stringify(root)}});
            await waitReady(); console.log('FIXTURE_READY'); await new Promise(() => {});
        });`);
    const child = spawn(process.execPath, ['--import', hook, fileURLToPath(runner)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const exit = once(child, 'exit');
    try {
        await until(() => output.includes('FIXTURE_READY'), () => output);
        child.kill('SIGTERM');
        const [code, signal] = await exit;
        expect({code, signal}, output).toEqual({code:143, signal:null});
        const pids = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(Number);
        expect(pids).toHaveLength(factories.length);
        const slot = await holdDesktopTestSlot({port:Number(fs.readFileSync(portFile, 'utf8')), timeoutMs:500, log:() => {}});
        await slot.release();
        expect(pids.filter(alive)).toEqual([]);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (fs.existsSync(ledger)) for (const pid of fs.readFileSync(ledger, 'utf8').trim().split('\n').map(Number)) {
            if (alive(pid)) process.kill(pid, 'SIGKILL');
        }
        fs.rmSync(temp, { recursive:true, force:true });
    }
}, 10_000);

it('stops a shell-spawned private daemon from its spawn log before a pid file or healthz exists', async () => {
    const { ownShellSpawnedDaemon } = await import('./desktop-lifecycle.mjs');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-spawn-cleanup-'));
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100)); console.log('ready'); setInterval(() => {}, 1000)"],
        { detached:true, stdio:['ignore', 'pipe', 'ignore'] });
    const exit = once(child, 'exit');
    const order = [];
    try {
        await once(child.stdout, 'data');
        const owned = ownShellSpawnedDaemon(() => ({
            quit: async () => { order.push('shell stopped'); },
            text: () => { order.push('read spawn log'); return `daemon spawned pid=${child.pid} entry=private node=private`; }
        }), path.join(temp, 'absent.pid'));
        await Promise.all([owned.stop(), owned.stop()]);
        expect(order).toEqual(['shell stopped', 'read spawn log']);
        expect(alive(child.pid)).toBe(false);
        expect(await exit).toEqual([0, null]);
    } finally {
        if (alive(child.pid)) child.kill('SIGKILL');
        fs.rmSync(temp, {recursive:true, force:true});
    }
});

it('attempts remaining cleanup and retains the slot when a resource refuses teardown', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-cleanup-failure-'));
    const portFile = path.join(temp, 'port');
    const slotFile = path.join(temp, 'slot.mjs');
    const hook = path.join(temp, 'hook.mjs');
    const runner = path.join(temp, 'runner.mjs');
    fs.writeFileSync(slotFile, `import fs from 'node:fs';
        import {holdDesktopTestSlot as hold} from ${JSON.stringify(url(path.join(lib, 'desktop-slot.mjs')))};
        export async function holdDesktopTestSlot() { const s=await hold({port:0}); fs.writeFileSync(${JSON.stringify(portFile)}, String(s.port)); return s; }`);
    fs.writeFileSync(hook, `import {registerHooks} from 'node:module';
        registerHooks({resolve(s,c,next) { return s === './desktop-slot.mjs' && c.parentURL?.endsWith('/desktop-lifecycle.mjs')
            ? {url:${JSON.stringify(url(slotFile))},shortCircuit:true} : next(s,c); }});`);
    fs.writeFileSync(runner, `import {runDesktopTest, ownDesktopResource, assertDesktopActive} from ${JSON.stringify(url(path.join(lib, 'desktop-lifecycle.mjs')))};
        await runDesktopTest(async () => {
            ownDesktopResource({stop:async () => {
                try { assertDesktopActive(); } catch { console.log('CREATION_REFUSED'); }
                console.log('OTHER_CLEANUP');
            }});
            ownDesktopResource({stop:async () => { throw new Error('fixture refused'); }});
            throw new Error('run failed');
        });`);
    const child = spawn(process.execPath, ['--import', hook, runner], {stdio:['ignore','pipe','pipe']});
    let output = '';
    child.stdout.on('data', b => {output+=b;}); child.stderr.on('data', b => {output+=b;});
    const exit = once(child, 'exit');
    try {
        await until(() => output.includes('retaining the slot'), () => output);
        expect(output).toContain('OTHER_CLEANUP');
        expect(output).toContain('CREATION_REFUSED');
        child.kill('SIGTERM');
        await expect(holdDesktopTestSlot({port:Number(fs.readFileSync(portFile,'utf8')),timeoutMs:100,pollMs:10,log:()=>{}}))
            .rejects.toThrow('timed out waiting');
        expect(child.exitCode).toBe(null);
        expect(child.signalCode).toBe(null);
    } finally {
        child.kill('SIGKILL'); await exit;
        fs.rmSync(temp,{recursive:true,force:true});
    }
});
