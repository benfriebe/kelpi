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
        id: 'local-macos-private-remote-navigation', kind: 'local',
        details: 'Real private primary/remote daemons, actual plugin iframe and Settings search; CDP pointer grant/revocation followed by daemon restart and client reload. No claim about physical-phone input.',
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
    t = await d.boot({ repoRoot: root, label: 'incident193', build: false, window: 'onscreen', log: line => console.log(line) });
    daemonPid = t.daemon?.pid; shellPid = t.shell?.child?.pid;
    rendererWatch = await observeRenderer(t.page);
    retain('native-runtime-identity.json',{shell:await t.harness.ping(),window:await t.harness.window(),node:process.version,platform:process.platform,arch:process.arch,rendererWatchScope:'after-boot; first-document startup belongs to the separate issue239 fixture'},'environment');
    const {page,cli,sandbox}=t;
    const previousConfig=fs.readFileSync(sandbox.configPath,'utf8');
    const remote=await stack.makeSandbox(root,{label:'incident193-remote',clientDir:path.join(root,'packages/client/dist')});
    let daemon=stack.startDaemon(remote,{repoRoot:root});
    const remotePids=[daemon.child?.pid];
    const remoteCLI=stack.makeCli(remote,{repoRoot:root});
    const command=async args=>{const r=await remoteCLI.run(args);calls.push({args,result:r});if(r.code!==0)throw new Error(`remote fixture command failed: ${r.stderr||r.stdout}`);return JSON.parse(r.stdout);};
    const shot=async name=>{const file=path.join(out,`${name}.png`);await page.screenshot(file);artifacts.push({role:'visual',path:file,sha256:sha(fs.readFileSync(file))});};
    try {
        await stack.waitForHealthz(remote.base);
        await command(['plugin','install',path.join(root,'examples/plugins/agent-board'),'--trust']);
        const workspace=await command(['workspace','create','--name','Incident193 remote plugin','--json']);
        const pane=await command(['plugin','open','example.agent-board','example.agent-board.board','--workspace',workspace.workspace_id]);
        const token=fs.readFileSync(path.join(remote.runDir,`daemon-v${stack.PROTOCOL_VERSION}.token`),'utf8').trim();
        fs.writeFileSync(sandbox.configPath,`${previousConfig}\nremote-daemon = Incident193:${remote.base}/?token=${token}\n`);
        await page.watchFrames();
        const row=`[data-testid="remote-daemon-Incident193"] [data-workspace-id="${workspace.workspace_id}"]`;
        if(!await d.settleDom(page,`document.querySelector(${JSON.stringify(row)})`,{ceilingMs:12000}))throw new Error('Private remote host fixture did not appear');
        await page.click(row);
        const frame=`[data-testid="plugin-view-${pane.paneID}"] iframe`;
        const ready=()=>d.settle(async()=>{try{return await page.evalInFrame(frame,`(async()=> (await kelpi.snapshot()).state.workspaces.some(w=>w.id===${JSON.stringify(workspace.workspace_id)}))()`);}catch{return false;}},{ceilingMs:15000});
        if(!await ready())throw new Error('Actual remote plugin iframe did not become ready');
        check('control: real remote plugin connects to its owning daemon',true);
        const navigation=()=>page.evalInFrame(frame,`(async()=>{try{return {ok:true,value:await kelpi.ui.getNavigation()};}catch(e){return {ok:false,error:String(e.message)};}})()`);
        const refused=async()=>{const answer=await navigation();return !answer.ok && answer.error.includes('unavailable for this daemon');};
        check('control: remote plugin navigation is refused by default',await refused());
        const input='[data-testid="settings-search"]';
        const hit='[data-testid="settings-search-result-remote-daemon-navigation-trust"]';
        const checkbox='[data-testid="remote-daemon-navigation-trust-Incident193"]';
        const toggle=async(trusted,label)=>{
            const beforeSearch=fs.readFileSync(sandbox.configPath,'utf8');
            await page.click(row);
            await page.key('Comma',{modifiers:4,key:','});
            if(!await d.settleDom(page,`document.querySelector('${input}')`,{ceilingMs:8000}))throw new Error('Shared Settings-search prerequisite did not open');
            await page.click(input);
            await page.send('Input.dispatchKeyEvent',{type:'rawKeyDown',code:'KeyA',key:'a',windowsVirtualKeyCode:65,modifiers:4,commands:['selectAll']});
            await page.send('Input.dispatchKeyEvent',{type:'keyUp',code:'KeyA',key:'a',windowsVirtualKeyCode:65,modifiers:4});
            await page.key('Backspace');
            await page.insertText('Trust plugins with navigation');
            const found=await d.settleDom(page,`document.querySelector('${hit}')`,{ceilingMs:1500});
            if(found)await page.click(hit);
            const visible=found && await d.settleDom(page,`(()=>{const e=document.querySelector('${checkbox}');if(!e)return false;const b=e.getBoundingClientRect();return e.checkVisibility({checkVisibilityCSS:true}) && b.width>0 && b.height>0 && e===document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);})()`,{ceilingMs:3000});
            check(`${label}: search reveals an unobscured per-host trust checkbox`,visible);
            check(`${label}: search alone does not write trust configuration`,fs.readFileSync(sandbox.configPath,'utf8')===beforeSearch);
            if(visible && await page.eval(`document.querySelector('${checkbox}').checked`)!==trusted)await page.click(checkbox);
            const saved=await d.settle(()=>fs.readFileSync(sandbox.configPath,'utf8').includes('remote-daemon-navigation-trust = Incident193:')===trusted,{ceilingMs:3000});
            check(`${label}: pointer toggle ${trusted?'saves':'revokes'} the per-host grant`,visible && saved);
            await shot(`${label}-trust-checkbox`);
            await page.key('Escape');
            if(!await ready())throw new Error('Private remote plugin did not reattach after Settings');
        };
        await toggle(true,'grant');
        const allowed=await navigation();
        const hosts=allowed.value?.hosts??[];
        check('grant: explicitly trusted remote plugin can read window navigation without credentials',allowed.ok && hosts.some(h=>h.kind==='local') && hosts.some(h=>h.name==='Incident193') && !JSON.stringify(allowed.value).includes(token),{ok:allowed.ok,error:allowed.error,hostCount:hosts.length});
        const prohibited=await page.evalInFrame(frame,`(async()=>{try{await kelpi.ui.selectView('sidebar.primary','kelpi.workspaces');return false;}catch(e){return String(e.message).includes('unavailable for this daemon');}})()`);
        check('control: navigation trust does not grant arbitrary workbench writes',prohibited);
        await toggle(false,'revoke');
        check('revoke: mounted remote plugin loses navigation immediately',await refused());
        await toggle(true,'regrant');
        await daemon.stop();
        daemon=stack.startDaemon(remote,{repoRoot:root});remotePids.push(daemon.child?.pid);
        await stack.waitForHealthz(remote.base);
        if(!await ready())throw new Error('Private remote plugin did not reconnect after owned daemon restart');
        await page.send('Page.reload');
        if(!await d.settleDom(page,`document.querySelector(${JSON.stringify(row)})`,{ceilingMs:12000}))throw new Error('Private remote host did not return after client reload');
        await page.click(row);
        if(!await ready())throw new Error('Private remote plugin did not reattach after reload');
        const persisted=await navigation();
        check('regrant: explicit trust survives daemon restart and client reload',persisted.ok && persisted.value.hosts.some(h=>h.kind==='local'));
        await toggle(false,'final-revoke');
        check('final-revoke: persisted trust is removed and navigation is denied again',await refused());
    } finally {
        retain('remote-runtime.json',{pids:remotePids,text:daemon.text()},'runtime');
        fs.writeFileSync(sandbox.configPath,previousConfig);
        try {await page.key('Escape');await d.settleDom(page,`!document.querySelector('[data-testid="remote-daemon-Incident193"]')`,{ceilingMs:8000});}catch(e){cleanup.errors.push(String(e));}
        try{await daemon.stop();}catch(e){cleanup.errors.push(String(e));}
        for(const pid of remotePids)if(exists(pid))cleanup.leaks.push({name:'remote-daemon',pid});
        if(cleanup.leaks.length===0)remote.cleanup();
        if(fs.existsSync(remote.root))cleanup.leaks.push({name:'remote-sandbox',path:remote.root});
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
