import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { holdDesktopTestSlot } from './desktop-slot.mjs';
import { fixtureAcceptanceProvenance } from './fixture-acceptance-provenance.mjs';

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
    const provenance = fixtureAcceptanceProvenance({ root, temp });
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
                : driver && s === 'node:net' ? ${JSON.stringify(url(net))}
                : s === './acceptance-provenance.mjs' && c.parentURL?.endsWith('/incident-diagnostics-replay.mjs') ? ${JSON.stringify(url(provenance.module))} : null;
            return target ? { url: target, shortCircuit: true } : next(s, c);
        }});`);
    const scenario = write('scenario', `${sample.dedicated ? "export const windowPlacement = 'offscreen';" : ''}
        export default async () => { ${sample.keep ? '' : "console.log('FIXTURE_READY'); await new Promise(() => {});"} };`);
    const child = spawn(process.execPath, ['--import', hook, path.join(root, 'scripts/scenario.mjs'),
        '--no-build', '--window', 'hidden', '--out', path.join(temp, 'out'), ...(sample.keep ? ['--keep'] : []), scenario],
        { env: provenance.env, stdio: ['ignore', 'pipe', 'pipe'] });
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

it('stops only its connected daemon before pid-file/healthz readiness and after its shell exits', async () => {
    const { ownShellSpawnedDaemon } = await import('./desktop-lifecycle.mjs');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-spawn-cleanup-'));
    const env = { ...process.env };
    const order = [];
    const sentinel = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']});
    const sentinelExit = once(sentinel, 'exit');
    const owner = ownShellSpawnedDaemon(() => ({
        quit: async () => { order.push('shell stopped'); },
        text: () => { throw new Error('logs are not ownership'); }
    }), path.join(temp, 'stale.pid'), {env});
    let child;
    try {
        await once(sentinel.stdout, 'data');
        fs.writeFileSync(path.join(temp, 'stale.pid'), JSON.stringify({pid:sentinel.pid}));
        await owner.ready;
        const stranger = net.createConnection({host:'127.0.0.1', port:Number(env.KELPI_TEST_OWNER_PORT)});
        const rejected = once(stranger, 'close');
        stranger.on('connect', () => stranger.write(JSON.stringify({token:'wrong',pid:sentinel.pid}) + '\n'));
        await rejected;
        const channel = url(path.join(root, 'packages/daemon/src/lifecycle/test-owner.ts'));
        child = spawn(process.execPath, ['--input-type=module', '-e', `
            import {connectTestOwner} from ${JSON.stringify(channel)};
            const owner = await connectTestOwner(process.env);
            if (process.env.KELPI_TEST_OWNER_TOKEN || process.env.KELPI_TEST_OWNER_PORT) throw new Error('capability leaked');
            console.log('ready');
            await owner.whenStopRequested;
            await new Promise(resolve => setTimeout(resolve, 100));
            await owner.confirmStopped();
        `], {env, detached:true, stdio:['ignore','pipe','inherit']});
        const exit = once(child, 'exit');
        await once(child.stdout, 'data');
        await Promise.all([owner.stop(), owner.stop()]);
        expect(order).toEqual(['shell stopped']);
        expect(alive(child.pid)).toBe(false);
        expect(alive(sentinel.pid)).toBe(true);
        expect(await exit).toEqual([0, null]);
    } finally {
        if (child && alive(child.pid)) child.kill('SIGKILL');
        sentinel.kill('SIGKILL'); await sentinelExit;
        fs.rmSync(temp, {recursive:true, force:true});
    }
});

for (const failure of ['refused', 'unknown daemon']) it('retains the slot and attempts remaining cleanup: ' + failure, async () => {
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
    fs.writeFileSync(runner, `import {runDesktopTest, ownDesktopResource, assertDesktopActive, ownShellSpawnedDaemon} from ${JSON.stringify(url(path.join(lib, 'desktop-lifecycle.mjs')))};
        await runDesktopTest(async () => {
            ownDesktopResource({stop:async () => {
                try { assertDesktopActive(); } catch { console.log('CREATION_REFUSED'); }
                console.log('OTHER_CLEANUP');
            }});
            ${failure === 'refused' ? `ownDesktopResource({stop:async () => { throw new Error('fixture refused'); }});` : `ownShellSpawnedDaemon(() => ({quit:async()=>{},text:()=>''}), null);`}
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

for (const evidence of ['missing', 'conflicting']) it(`refuses ${evidence} PID evidence without signalling either process`, async () => {
    const { ownShellSpawnedDaemon } = await import('./desktop-lifecycle.mjs');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-owner-evidence-'));
    const children = [0, 1].map(() => spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], {stdio:['ignore','pipe','ignore']}));
    const exits = children.map(child => once(child, 'exit'));
    try {
        await Promise.all(children.map(child => once(child.stdout, 'data')));
        const file = path.join(temp, 'daemon.pid');
        if (evidence === 'conflicting') fs.writeFileSync(file, JSON.stringify({pid:children[1].pid}));
        const owner = ownShellSpawnedDaemon(() => ({quit:async()=>{}, text:()=>evidence === 'missing' ? '' : `daemon spawned pid=${children[0].pid}`}), file);
        await expect(owner.stop()).rejects.toThrow(/ownership|owner|channel/i);
        expect(children.map(child => alive(child.pid))).toEqual([true, true]);
    } finally {
        children.forEach(child => child.kill('SIGKILL'));
        await Promise.all(exits);
        fs.rmSync(temp, {recursive:true,force:true});
    }
});


it('cancels the actual plugin-dev helper through the real scenario runner before slot handoff', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-direct-helper-'));
    const portFile = path.join(temp, 'port');
    const pidFile = path.join(temp, 'pid');
    const provenance = fixtureAcceptanceProvenance({ root, temp });
    const fixtureRepo = path.join(temp, 'fixture-repo');
    const write = (name, body) => { const p = path.join(temp, name + '.mjs'); fs.writeFileSync(p, body); return p; };
    const server = net.createServer(socket => socket.on('data', () => socket.end(JSON.stringify({ok:true,result:{daemonID:'private-fixture',capabilities:['plugin-dev']}}) + '\n')));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const driverURL = url(path.join(lib, 'driver.mjs'));
    const driver = write('driver', `export {recorder,WINDOW_PLACEMENTS} from ${JSON.stringify(driverURL + '?real')};
        export async function boot({window}) { return {
            page:{eval:async()=>{throw new Error('no DOM');}}, rendererErrors:{finish:()=>{}},
            sandbox:{env:{PATH:process.env.PATH},home:${JSON.stringify(temp)},controlPort:${server.address().port},base:'private fixture'},
            shell:{},debugPort:1,harness:{path:'fixture'},windowPlacement:window,stop:async()=>{}
        }; }`);
    const slot = write('slot', `import fs from 'node:fs';import {holdDesktopTestSlot as hold} from ${JSON.stringify(url(path.join(lib,'desktop-slot.mjs')))};
        export async function holdDesktopTestSlot(){const s=await hold({port:0});fs.writeFileSync(${JSON.stringify(portFile)},String(s.port));return s;}`);
    const hook = write('hook', `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){
        if(s==='./desktop-slot.mjs'&&c.parentURL?.endsWith('/desktop-lifecycle.mjs'))return {url:${JSON.stringify(url(slot))},shortCircuit:true};
        if(s===${JSON.stringify(path.join(lib,'driver.mjs'))})return {url:${JSON.stringify(url(driver))},shortCircuit:true};
        if(s==='./acceptance-provenance.mjs'&&c.parentURL?.endsWith('/incident-diagnostics-replay.mjs'))return {url:${JSON.stringify(url(provenance.module))},shortCircuit:true};return next(s,c);}});`);
    const source = fs.readFileSync(path.join(root, 'scripts/scenarios/plugin-authoring.mjs'), 'utf8');
    const startAt = source.indexOf('        dev = spawn');
    const spawning = source.slice(startAt, source.indexOf('        dev.stdout.setEncoding', startAt));
    const stopping = source.slice(source.indexOf('    const stopDev = async () => {'), source.indexOf('    const writeVersion'));
    // The production helper owns a Node CLI child. Its fixture is deliberately local so this
    // cancellation test does not need the checkout's compiled CLI output.
    const fixtureCLI = path.join(fixtureRepo, 'packages/cli/dist/kelpi.js');
    fs.mkdirSync(path.dirname(fixtureCLI), { recursive: true });
    fs.writeFileSync(fixtureCLI, `console.log('watching');process.on('SIGINT',()=>{
        console.log(JSON.stringify({type:'stopped'}));process.exit(0);});setInterval(()=>{},1000);`);
    // Exact production helper call and stop function, with UI/setup omitted.
    const scenario = write('scenario', `import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
        import * as lifecycle from ${JSON.stringify(url(path.join(lib,'desktop-lifecycle.mjs')))};
        const {spawnDesktopHelper} = lifecycle;
        const repoRoot=${JSON.stringify(fixtureRepo)};
        export default async function({sandbox}) {const external=${JSON.stringify(temp)},source=external;let dev;
            ${stopping}
            try {${spawning}
                fs.writeFileSync(${JSON.stringify(pidFile)},String(dev.pid));
                await new Promise(resolve=>dev.stdout.on('data',chunk=>{process.stdout.write(chunk);if(String(chunk).includes('watching'))resolve();}));
                console.log('FIXTURE_READY');await new Promise(()=>{});
            } finally {await stopDev();}
        }`);
    const child = spawn(process.execPath, ['--import',hook,path.join(root,'scripts/scenario.mjs'),'--no-build','--window','hidden','--out',path.join(temp,'out'),scenario], {env:provenance.env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const exit=once(child,'exit');let pid;
    try {
        await until(()=>output.includes('FIXTURE_READY'),()=>output);
        pid=Number(fs.readFileSync(pidFile,'utf8'));
        child.kill('SIGTERM');
        expect(await exit,output).toEqual([143,null]);
        const slot=await holdDesktopTestSlot({port:Number(fs.readFileSync(portFile,'utf8')),timeoutMs:500,log:()=>{}});
        try { expect(alive(pid),output).toBe(false); } finally { await slot.release(); }
        expect(output).toContain('"type":"stopped"');
    } finally {
        if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}
        if(pid&&alive(pid))process.kill(pid,'SIGKILL');
        await new Promise(resolve=>server.close(resolve));
        fs.rmSync(temp,{recursive:true,force:true});
    }
}, 10_000);
