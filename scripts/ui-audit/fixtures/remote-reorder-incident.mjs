import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// This observer is part of the immutable test, including on historical refs whose
// driver predates an exported renderer watcher. It starts after boot and claims no
// first-document coverage; issue239 has a separate before-navigation regression.
async function observeRenderer(page) {
    let total=0;
    const samples=[];
    const record=(kind,detail)=>{total++;if(samples.length<50)samples.push({kind,detail:String(detail).slice(0,2000)});};
    const undo=[];
    try {
        undo.push(page.on('Runtime.exceptionThrown',params=>record('uncaught',params.exceptionDetails?.exception?.description??params.exceptionDetails?.text??'?')));
        undo.push(page.on('Runtime.consoleAPICalled',params=>{if(params.type==='error')record('console.error',(params.args??[]).map(arg=>String(arg.value??arg.description??'')).join(' '));}));
        await page.send('Runtime.enable');
    } catch(error) {for(const remove of undo)remove();throw error;}
    return {finish(rec){try{rec.check('the renderer threw nothing and logged no error',total===0,JSON.stringify({total,samples,scope:'post-boot'}));}finally{for(const remove of undo)remove();}}};
}

const root = fs.realpathSync(process.env.KELPI_REGRESSION_ROOT);
const reportPath = path.resolve(process.env.KELPI_REGRESSION_REPORT);
const out = `${reportPath}.artifacts`;
fs.mkdirSync(out, { recursive: false });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const assertions = [], errors = [], artifacts = [], calls = [];
const cleanup = { attempted: false, completed: false, errors: [], leaks: [] };
const result = {
    schemaVersion: 1, assertions, errors, cleanup,
    environment: {
        id: 'local-macos-private-remote-reorder', kind: 'local',
        details: 'Real private primary/remote daemons, Electron sidebar, independent WebSocket client and daemon restart; trusted CDP pointer drag. Does not certify a physical input device or Tailscale transport.',
        evidence: { facts: artifacts }
    },
    head: git('rev-parse', 'HEAD'), startedAt: new Date().toISOString(),
};
const retain = (name, value, role = 'diagnostic') => {
    const file = path.join(out, name);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    artifacts.push({ role, path: file, sha256: sha(fs.readFileSync(file)) });
};
const check = (name, ok, detail) => assertions.push({ name, ok: Boolean(ok), detail });
const exists = pid => {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
    }
};
let t, daemonPid, shellPid, rendererWatch;
let bootAttempted = false;
try {
    const d = await import(pathToFileURL(path.join(root, 'scripts/ui-audit/lib/driver.mjs')));
    const stack = await import(pathToFileURL(path.join(root, 'scripts/ui-audit/lib/stack.mjs')));
    await stack.buildAll(root, { force: true, log: line => console.log(line) });
    const collectBuildFiles = () => ['daemon','cli','client','shell'].flatMap(pkg => {
        const base = path.join(root, 'packages', pkg, 'dist');
        return fs.readdirSync(base, {recursive:true,withFileTypes:true}).filter(entry=>entry.isFile())
            .map(entry=>path.relative(root,path.join(entry.parentPath,entry.name)));
    }).sort();
    const buildFiles = collectBuildFiles();
    const build = buildFiles.map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
    const sourceFiles = git('ls-files', '-z').split('\0').filter(Boolean);
    const source = sourceFiles.filter(file => fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).isFile())
        .map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
    retain('source-and-build.json', { head: result.head, source, build, forced: true }, 'build');
    bootAttempted = true;
    t = await d.boot({ repoRoot: root, label: 'incident237', build: false, window: 'onscreen', log: line => console.log(line) });
    daemonPid = t.daemon?.pid; shellPid = t.shell?.child?.pid;
    rendererWatch = await observeRenderer(t.page);
    retain('native-runtime-identity.json',{shell:await t.harness.ping(),window:await t.harness.window(),node:process.version,platform:process.platform,arch:process.arch,rendererWatchScope:'after-boot; first-document startup belongs to the separate issue239 fixture'},'environment');
    const extraDaemons = [], extraSandboxes = [];
    globalThis.__incident237Stack = {
        ...stack,
        async makeSandbox(...args) { const sandbox=await stack.makeSandbox(...args); extraSandboxes.push(sandbox); return sandbox; },
        startDaemon(...args) { const daemon=stack.startDaemon(...args); extraDaemons.push(daemon); return daemon; }
    };
    let count=0;
    const rec = {
        check(name, ok, detail) { check(name, ok, detail); return Boolean(ok); },
        note(message) { calls.push({note:message}); },
        async shot(page,label) {const file=path.join(out,`${++count}-${label}.png`);await page.screenshot(file);artifacts.push({role:'visual',path:file,sha256:sha(fs.readFileSync(file))});}
    };
    try {
        await runReorderScenario({...t,rec,d,repoRoot:root,sleep:d.sleep});
        const file=path.join(out,'remote-reorder-after-reload.png');
        await t.page.screenshot(file);
        artifacts.push({role:'visual',path:file,sha256:sha(fs.readFileSync(file))});
    } finally {
        retain('remote-daemon-output.json',extraDaemons.map(p=>({pid:p.child?.pid,text:p.text(),exited:p.exited})), 'runtime');
        for(const p of extraDaemons) {
            try {await p.stop();} catch(error) {cleanup.errors.push(String(error?.stack??error));}
            if(exists(p.child?.pid)) cleanup.leaks.push({name:'remote-daemon',pid:p.child?.pid});
        }
        for(const sandbox of extraSandboxes) {
            if(fs.existsSync(sandbox.root)) {
                cleanup.leaks.push({name:'remote-sandbox-left-by-scenario',path:sandbox.root});
                sandbox.cleanup();
            }
        }
        delete globalThis.__incident237Stack;
    }
    if (JSON.stringify(collectBuildFiles()) !== JSON.stringify(buildFiles)) throw new Error('build output membership changed during incident test');
    const after = buildFiles.map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
    if (JSON.stringify(after) !== JSON.stringify(build)) throw new Error('executed build outputs changed during the incident test');
} catch (error) {
    errors.push(String(error?.stack ?? error));
} finally {
    cleanup.attempted = true;
    if (rendererWatch) {
        try {rendererWatch.finish({check(name,ok,detail){check('renderer: '+name,ok,detail);}});}
        catch(error){errors.push('renderer evidence finalization: '+String(error?.stack??error));}
    }
    if (t) {
        retain('daemon-output.json', { text: t.daemon?.text(), shell: t.shell?.text(), daemonPid, shellPid }, 'runtime');
        try { await t.stop(); } catch (error) { cleanup.errors.push(String(error?.stack ?? error)); }
        for (const [name, pid] of [['daemon', daemonPid], ['shell', shellPid]]) {
            if (exists(pid)) cleanup.leaks.push({ name, pid });
        }
        if (fs.existsSync(t.sandbox.root)) cleanup.leaks.push({ path: t.sandbox.root });
    }
    if (bootAttempted && !t) cleanup.errors.push('boot rejected before returning owned runtime handles; process and sandbox cleanup is unverified and requires external inspection');
    cleanup.completed = cleanup.errors.length === 0 && cleanup.leaks.length === 0;
    retain('cli-calls.json', calls);
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
}
process.exitCode = errors.length || !cleanup.completed ? 2 : assertions.some(a => !a.ok) ? 1 : 0;

async function runReorderScenario(ctx) {
/** #237: trusted pointer input, two real daemons, and an independent WS mirror. */
const { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } = globalThis.__incident237Stack;


// This is a second connected client, not a command spy. It retains only the two pieces of
// daemon state this scenario checks, advancing them from the real ordered delta stream.
async function observe(remote, token) {
    const ws = new WebSocket(`${remote.base.replace(/^http/, 'ws')}/ws?token=${token}`);
    const mirror = { top: [], groups: [], seq: null, error: null, ws };
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Remote observer snapshot timed out')), 10_000);
        ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Remote observer failed')); });
        ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION,
            token, client: { kind: 'browser', name: 'remote-reorder-observer' } })));
        ws.addEventListener('message', ({ data }) => {
            if (typeof data !== 'string') return;
            const message = JSON.parse(data);
            if (message.type === 'snapshot') {
                mirror.top = message.state.topLevelOrder;
                mirror.groups = message.state.groups;
                mirror.seq = message.seq;
                clearTimeout(timeout); resolve();
            } else if (message.type === 'delta') {
                if (message.seq !== mirror.seq + 1) mirror.error = 'Observer delta sequence gap';
                mirror.seq = message.seq;
                for (const event of message.events) {
                    if (event.kind === 'order-changed') mirror.top = event.topLevelOrder;
                    if (event.kind === 'group-upserted') {
                        mirror.groups = mirror.groups.filter(group => group.id !== event.id);
                        mirror.groups.push(event.group);
                    }
                    if (event.kind === 'group-removed') mirror.groups = mirror.groups.filter(group => group.id !== event.id);
                }
            }
        });
    });
    return mirror;
}

async function incident ({ page, cli, sandbox, rec, d, sleep, repoRoot, harness }) {
    if (!sandbox) throw new Error('This scenario requires private booted instances');
    const previousConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const remote = await makeSandbox(repoRoot, { label: 'reorder-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
    let daemon = startDaemon(remote, { repoRoot });
    let observer;
    const remoteCLI = makeCli(remote, { repoRoot });
    const json = async args => JSON.parse(await remoteCLI.ok(args));
    const host = '[data-testid="remote-daemon-ReorderRemote"]';
    const row = id => `${host} [data-testid="workspace-row"][data-workspace-id="${id}"]`;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const topIDs = () => observer.top.map(entry => entry.id);
    const children = group => observer.groups.find(entry => entry.id === group)?.childOrder;
    const domIDs = () => page.eval(`Array.from(document.querySelectorAll('${host} [data-testid="workspace-row"]'), el => el.dataset.workspaceId)`);
    const box = async id => {
        const b = await page.box(row(id));
        if (!b || b.height <= 0) throw new Error(`Remote row is not measurable: ${id}`);
        return b;
    };
    const drag = async (from, to, after = false) => {
        const a = await box(from), b = await box(to);
        await page.drag(a.cx, a.cy, b.cx, b.y + b.height * (after ? 0.75 : 0.25));
    };
    const begin = async (from, to) => {
        const a = await box(from), b = await box(to);
        await page.mouse('mouseMoved', a.cx, a.cy, { button: 'none', buttons: 0 });
        await page.mouse('mousePressed', a.cx, a.cy);
        await page.mouse('mouseMoved', b.cx, b.y + b.height / 4, { buttons: 1 });
        return { x: b.cx, y: b.y + b.height / 4 };
    };
    const release = p => page.mouse('mouseReleased', p.x, p.y, { buttons: 0 });
    try {
        await harness.focus();
        if (!await page.eval(`!!document.querySelector('[data-testid="sidebar"]')`)) await harness.menuClick({ path: ['View', 'Toggle Sidebar'] });
        await waitForHealthz(remote.base);
        const localBefore = await cli.ok(['workspace', 'list', '--json']);
        const first = (await json(['workspace', 'create', '--name', 'Reorder First', '--json'])).workspace_id;
        const memberA = (await json(['workspace', 'create', '--name', 'Reorder Member A', '--group', 'Reorder Group', '--json'])).workspace_id;
        const memberB = (await json(['workspace', 'create', '--name', 'Reorder Member B', '--group', 'Reorder Group', '--json'])).workspace_id;
        const tail = (await json(['workspace', 'create', '--name', 'Reorder Tail', '--json'])).workspace_id;
        const token = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        observer = await observe(remote, token);
        const group = observer.groups.find(entry => entry.name === 'Reorder Group').id;
        const originalTop = topIDs();
        fs.writeFileSync(sandbox.configPath, `${previousConfig}\nremote-daemon = ReorderRemote:${remote.base}/?token=${token}\n`);
        rec.check('the real remote mirror renders the seeded sibling lists', await d.settleDom(page,
            `document.querySelector(${JSON.stringify(row(tail))}) && document.querySelector('${host} [data-status="connected"]')`, { ceilingMs: 15_000 }));
        // Trust is read from events delivered by CDP; no DOM-dispatched drag events or mocked RPC.
        await page.eval(`(() => { window.__reorderTrusted = []; window.addEventListener('mousedown', e => window.__reorderTrusted.push(e.isTrusted)); })()`);
        await drag(first, tail, true);
        const movedTop = originalTop.filter(id => id !== first); movedTop.splice(movedTop.indexOf(tail) + 1, 0, first);
        const expectedRows = movedTop.flatMap(id => id === group ? [memberA, memberB] : [id]);
        rec.check('top-level move crosses a group slot and echoes to another connected client', await d.settle(() => same(topIDs(), movedTop)));
        rec.check('the initiating UI renders the daemon echo', await d.settle(async () => same(await domIDs(), expectedRows)));
        await drag(memberA, memberB, true);
        rec.check('group move is observed over the independent remote connection', await d.settle(() => same(children(group), [memberB, memberA])));
        const finalRows = movedTop.flatMap(id => id === group ? [memberB, memberA] : [id]);
        rec.check('group order also echoes into the initiating sidebar', await d.settle(async () => same(await domIDs(), finalRows)));
        const localAfter = await cli.ok(['workspace', 'list', '--json']);
        rec.check('remote gestures leave the local daemon workspace order intact', same(JSON.parse(localBefore), JSON.parse(localAfter)));

        observer.ws.close();
        await daemon.stop(); daemon = startDaemon(remote, { repoRoot }); await waitForHealthz(remote.base);
        observer = await observe(remote, token);
        rec.check('a fresh snapshot after daemon restart retains both orders', same(topIDs(), movedTop) && same(children(group), [memberB, memberA]));
        rec.check('the initiating client reconnects and renders persisted order', await d.settle(async () => same(await domIDs(), finalRows), { ceilingMs: 15_000 }));
        await page.send('Page.reload');
        rec.check('a client reload renders the same persisted remote order', await d.settle(async () => same(await domIDs(), finalRows), { ceilingMs: 15_000 }));
        await rec.shot(page, 'remote-order-after-reload');
    } finally {
        observer?.ws.close();
        fs.writeFileSync(sandbox.configPath, previousConfig);
        await d.settleDom(page, `!document.querySelector('${host}')`, { ceilingMs: 10_000 });
        await daemon.stop(); remote.cleanup();
    }
}

return await incident(ctx);
}
