import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { holdDesktopTestSlot } from './desktop-slot.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const url = p => pathToFileURL(p).href;
const lifecycle = url(path.join(root, 'scripts/ui-audit/lib/desktop-lifecycle.mjs'));
const slotURL = url(path.join(root, 'scripts/ui-audit/lib/desktop-slot.mjs'));
const { build } = createRequire(path.join(root, 'packages/daemon/package.json'))('esbuild');
let temp;
let bundle;
let serial = 0;
const write = (dir, name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
const live = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code !== 'ESRCH') throw error; return false; } };
async function until(check, detail, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error('fixture deadline: ' + detail());
        await sleep(10);
    }
}
function launch(args, options = {}) {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], ...options });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', b => { output += b; });
    return { child, output: () => output, exit: once(child, 'exit') };
}
const exited = process => process.child.exitCode !== null || process.child.signalCode !== null;
async function waitExit(process) { await until(() => exited(process), process.output); return process.exit; }
async function killFixture(process) {
    if (!process) return;
    if (!exited(process)) process.child.kill('SIGKILL');
    await process.exit;
}

beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-owner-'));
    bundle = path.join(temp, 'daemon.mjs');
    // Actual main, owner channel, composition, restore/spawn gate and shutdown. Only the PTY
    // transport is a harmless Node child; the WS startup seam can pause or reject. No desktop.
    await build({
        entryPoints: [path.join(root, 'packages/daemon/src/main.ts')], outfile: bundle,
        bundle: true, platform: 'node', format: 'esm', target: 'node24', external: ['node-pty'],
        banner: { js: `import {createRequire as fixtureRequire} from 'node:module';
            import {fileURLToPath as fixtureFileURL} from 'node:url';import {dirname as fixtureDirname} from 'node:path';
            const require=fixtureRequire(import.meta.url);const __filename=fixtureFileURL(import.meta.url);const __dirname=fixtureDirname(__filename);` },
        plugins: [{ name: 'private-boot-boundaries', setup(builder) {
            builder.onLoad({ filter: /packages\/daemon\/src\/pty\/spawner\.ts$/ }, () => ({ loader: 'ts', contents: `
                import {spawn} from 'node:child_process';
                export const nodePtySpawner=request=>{
                    const child=spawn(process.execPath,['-e',"setTimeout(()=>process.exit(0),20000);setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
                    child.unref();console.log('OWNED_CHILD='+child.pid+' SECRET='+Boolean(request.env.KELPI_TEST_OWNER_TOKEN));
                    return {pid:child.pid,write(){},resize(){},pause(){},resume(){},kill(signal){child.kill(signal);},
                        onData(){},onExit(fn){child.on('exit',(code,signal)=>fn(code??0,signal));}};
                };` }));
            builder.onLoad({ filter: /packages\/daemon\/src\/ws\/server\.ts$/ }, ({ path: file }) => {
                const source = fs.readFileSync(file, 'utf8');
                const needle = '        async start() {';
                if (source.split(needle).length !== 2) throw new Error('WS startup fixture seam changed');
                return { loader: 'ts', contents: source.replace(needle, needle + `
                    if(process.env.OWNER_FIXTURE_MODE!=='ready') {
                        console.log('BOOT_PENDING');
                        await new Promise((resolve,reject)=>process.once('message',message=>{
                            if(message==='reject')reject(new Error('owned startup fixture failure'));else resolve();
                        }));
                    }`) };
            });
        } }]
    });
});
afterAll(() => { if (temp) fs.rmSync(temp, { recursive: true, force: true }); });

for (const mode of ['ready', 'resume', 'reject', 'stalled', 'before-boot', 'unconfirmed-exit']) {
    it('owns daemon startup through ' + mode, async () => {
        const dir = path.join(temp, 'c' + serial++); fs.mkdirSync(dir);
        const slot = write(dir, 'slot.mjs', `import fs from 'node:fs';import {holdDesktopTestSlot as hold} from ${JSON.stringify(slotURL)};
            export async function holdDesktopTestSlot(){const s=await hold({port:0});fs.writeFileSync(${JSON.stringify(path.join(dir,'port'))},String(s.port));return s;}`);
        const hook = write(dir, 'hook.mjs', `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){
            if(s==='./desktop-slot.mjs'&&c.parentURL?.endsWith('/desktop-lifecycle.mjs'))return {url:${JSON.stringify(url(slot))},shortCircuit:true};return next(s,c);}});`);
        const runnerFile = write(dir, 'runner.mjs', `import {runDesktopTest,ownShellSpawnedDaemon} from ${JSON.stringify(lifecycle)};
            await runDesktopTest(async()=>{const env={};const owner=ownShellSpawnedDaemon(()=>({quit:async()=>console.log('SHELL_QUIT')}),null,{env,timeoutMs:${mode === 'stalled' ? 250 : 4000}});
                await owner.ready;console.log('CHANNEL '+JSON.stringify(env));await new Promise(resolve=>process.once('message',resolve));
                await Promise.all([owner.stop(),owner.stop()]);});process.exit(0);`);
        const runner = launch(['--import', hook, runnerFile]);
        let daemon;
        let helperPid;
        let port;
        try {
            await until(() => runner.output().includes('CHANNEL '), runner.output);
            const ownerEnv = JSON.parse(runner.output().split('CHANNEL ')[1].split('\n')[0]);
            port = Number(fs.readFileSync(path.join(dir, 'port'), 'utf8'));
            if (mode === 'before-boot') {
                runner.child.kill('SIGTERM');
                await until(() => runner.output().includes('SHELL_QUIT'), runner.output);
            }
            const home = path.join(dir, 'home'); fs.mkdirSync(home);
            daemon = launch([bundle, 'start', '--foreground'], { env: {
                PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', TMPDIR: dir,
                XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
                KELPID_RUN_DIR: path.join(dir, 'run'), KELPID_DB_PATH: path.join(dir, 'state.db'),
                KELPID_CONFIG_PATH: path.join(dir, 'no-config'), KELPID_SOCKET_PATH: path.join(dir, 'compat.sock'),
                KELPID_HTTP_HOST: '127.0.0.1', KELPID_HTTP_PORT: '0', OWNER_FIXTURE_MODE: mode, ...ownerEnv
            } });
            if (mode === 'before-boot') {
                expect(await waitExit(daemon), daemon.output()).toEqual([0, null]);
                expect(daemon.output()).not.toContain('OWNED_CHILD');
                expect(fs.existsSync(path.join(dir, 'run'))).toBe(false);
                expect(await waitExit(runner), runner.output()).toEqual([143, null]);
            } else {
                await until(() => daemon.output().includes('OWNED_CHILD='), daemon.output);
                helperPid = Number(daemon.output().match(/OWNED_CHILD=(\d+)/)[1]);
                expect(daemon.output()).toContain('SECRET=false');
                if (mode === 'unconfirmed-exit') daemon.child.kill('SIGKILL');
                if (mode === 'reject') daemon.child.send('reject');
                if (mode === 'stalled' || mode === 'resume') runner.child.kill('SIGTERM');
                else runner.child.send('finish');
                if (mode === 'resume') {
                    await until(() => runner.output().includes('SHELL_QUIT'), runner.output);
                    await expect(holdDesktopTestSlot({ port, timeoutMs: 100, pollMs: 10, log: () => {} })).rejects.toThrow('timed out');
                    expect(exited(daemon)).toBe(false);
                    expect(live(helperPid)).toBe(true);
                    runner.child.kill('SIGTERM'); // repeated cancellation cannot bypass cleanup
                    daemon.child.send('continue');
                }
                if (mode === 'stalled' || mode === 'unconfirmed-exit') {
                    await until(() => runner.output().includes('retaining the slot'), runner.output);
                    if (mode === 'unconfirmed-exit') expect(runner.output()).toContain('without confirmed resource teardown');
                    await expect(holdDesktopTestSlot({ port, timeoutMs: 100, pollMs: 10, log: () => {} })).rejects.toThrow('timed out');
                    expect(exited(runner)).toBe(false);
                    expect(live(helperPid)).toBe(true);
                    if (mode === 'stalled') {
                        expect(exited(daemon)).toBe(false);
                        // It may eventually finish boot, but it must stop before reporting
                        // teardown, and a failed runner cleanup stays visibly fail-closed.
                        daemon.child.kill('SIGTERM');
                        daemon.child.send('continue');
                        expect(await waitExit(daemon), daemon.output()).toEqual([0, null]);
                        expect(live(helperPid)).toBe(false);
                        await expect(holdDesktopTestSlot({ port, timeoutMs: 50, pollMs: 10, log: () => {} })).rejects.toThrow('timed out');
                    }
                } else {
                    expect(await waitExit(daemon), daemon.output()).toEqual([mode === 'reject' ? 1 : 0, null]);
                    expect(await waitExit(runner), runner.output()).toEqual([mode === 'resume' ? 143 : 0, null]);
                    expect(live(helperPid)).toBe(false);
                    expect(daemon.output()).toContain('kelpid stopped');
                    if (mode === 'reject') expect(daemon.output()).toContain('owned startup fixture failure');
                }
            }
        } finally {
            // Only exact fixture handles/PIDs created above. Controlled fail-closed cases
            // deliberately need this explicit cleanup; no lookup/recovery of other owners.
            await killFixture(daemon);
            await killFixture(runner);
            if (helperPid && live(helperPid)) {
                process.kill(helperPid, 'SIGKILL');
                await until(() => !live(helperPid), () => 'fixture child ' + helperPid);
            }
            if (port) {
                const next = await holdDesktopTestSlot({ port, timeoutMs: 500, pollMs: 10, log: () => {} });
                await next.release();
            }
        }
    }, 12_000);
}
