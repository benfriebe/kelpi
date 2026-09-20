import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// This observer is part of the immutable test, including on historical refs whose
// driver predates an exported renderer watcher. It starts after boot and claims no
// first-document coverage; issue239 has a separate before-navigation regression.
function removeRendererObservers(undo) {
    const failures = [];
    for (const remove of undo) {
        try { remove(); }
        catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Failed to remove every renderer observer');
}
async function observeRenderer(page) {
    let total=0;
    const samples=[];
    const record=(kind,detail)=>{total++;if(samples.length<50)samples.push({kind,detail:String(detail).slice(0,2000)});};
    const undo=[];
    try {
        undo.push(page.on('Runtime.exceptionThrown',params=>record('uncaught',params.exceptionDetails?.exception?.description??params.exceptionDetails?.text??'?')));
        undo.push(page.on('Runtime.consoleAPICalled',params=>{if(params.type==='error')record('console.error',(params.args??[]).map(arg=>String(arg.value??arg.description??'')).join(' '));}));
        await page.send('Runtime.enable');
    } catch(error) {
        try { removeRendererObservers(undo); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Renderer observer setup and teardown failed'); }
        throw error;
    }
    return {finish(rec){
        let primaryError;
        try { rec.check('the renderer threw nothing and logged no error',total===0,JSON.stringify({total,samples,scope:'post-boot'})); }
        catch (error) { primaryError = error; }
        try { removeRendererObservers(undo); }
        catch (cleanupError) {
            if (primaryError) throw new AggregateError([primaryError, cleanupError], 'Renderer evidence and observer teardown failed');
            throw cleanupError;
        }
        if (primaryError) throw primaryError;
    }};
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
        id: 'local-macos-private-two-host-navigation', kind: 'local',
        details: 'Real private primary/two-remote daemons, actual plugin iframes and Settings search; CDP pointer grant/revocation, cross-host selection, subscription and isolation checks followed by daemon restart and client reload. No claim about physical-phone input.',
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
// cleanup-plan:start
async function runCleanupPlan(steps, recordFailure) {
    for (const [label, action] of steps) {
        try {
            await action();
        } catch (error) {
            recordFailure(label, error);
        }
    }
}
function observeOwnedProcess({ name, pid, index, states, exists, cleanup }) {
    states[index] = 'unknown';
    if (!pid) throw new Error(`${name} process id is unavailable`);
    const alive = exists(pid);
    states[index] = alive ? 'live' : 'gone';
    if (alive) cleanup.leaks.push({ name, pid });
}
const allOwnedProcessesProvenGone = states => states.length > 0 && states.every(state => state === 'gone');
function buildRemoteCleanupPlan({ retain, fs, sandbox, previousConfig, page, d, daemon, daemonB, remotePids, remoteBPids, remote, remoteB, exists, cleanup }) {
    const peerStates = remoteBPids.map(() => 'unknown');
    const remoteStates = remotePids.map(() => 'unknown');
    return [
        ['retain remote runtime diagnostics', () => retain('remote-runtime.json',{pids:remotePids,text:daemon?.text(),peerPids:remoteBPids,peerText:daemonB?.text()},'runtime')],
        ['restore primary sandbox config', () => fs.writeFileSync(sandbox.configPath,previousConfig)],
        ['dismiss Settings and wait for remote row removal', async () => {await page.key('Escape');await d.settleDom(page,`!document.querySelector('[data-testid="remote-daemon-Incident193"]')`,{ceilingMs:8000});}],
        ['stop trusted remote daemon', () => daemon?.stop()],
        ['stop untrusted peer daemon', () => daemonB?.stop()],
        ...remoteBPids.map((pid, index) => [`check untrusted peer daemon process ${index}`, () => observeOwnedProcess({name:'second-remote-daemon',pid,index,states:peerStates,exists,cleanup})]),
        ['cleanup untrusted peer sandbox', () => {if(remoteB && allOwnedProcessesProvenGone(peerStates))remoteB.cleanup();}],
        ['check untrusted peer sandbox removal', () => {if(remoteB && fs.existsSync(remoteB.root))cleanup.leaks.push({name:'second-remote-sandbox',path:remoteB.root,processStates:[...peerStates]});}],
        ...remotePids.map((pid, index) => [`check trusted remote daemon process ${index}`, () => observeOwnedProcess({name:'remote-daemon',pid,index,states:remoteStates,exists,cleanup})]),
        ['cleanup trusted remote sandbox', () => {if(remote && allOwnedProcessesProvenGone(remoteStates))remote.cleanup();}],
        ['check trusted remote sandbox removal', () => {if(remote && fs.existsSync(remote.root))cleanup.leaks.push({name:'remote-sandbox',path:remote.root,processStates:[...remoteStates]});}],
    ];
}
function buildPrimaryCleanupPlan({ rendererWatch, runtime, retain, check, daemonPid, shellPid, exists, fs, cleanup, finalRetains = [] }) {
    const observe = (name, pid) => {
        if (!pid) throw new Error(`${name} process id is unavailable`);
        if (exists(pid)) cleanup.leaks.push({ name, pid });
    };
    return [
        ...(rendererWatch ? [['finalize renderer evidence', () => rendererWatch.finish({check(name,ok,detail){check('renderer: '+name,ok,detail);}})]] : []),
        ...(runtime ? [
            ['retain primary daemon output', () => retain('daemon-output.json', { text: runtime.daemon?.text(), shell: runtime.shell?.text(), daemonPid, shellPid }, 'runtime')],
            ['stop primary runtime', async () => {
                // Historical target drivers can attempt file cleanup after a failed
                // stop. Guard that actual deletion boundary inside their lifecycle.
                const removeSandbox = runtime.sandbox.cleanup;
                const pids = [['daemon', daemonPid], ['shell', shellPid]];
                if (runtime.daemon?.pid && runtime.daemon.pid !== daemonPid) pids.push(['current daemon', runtime.daemon.pid]);
                runtime.sandbox.cleanup = () => {
                    for (const [name, pid] of pids) {
                        if (!pid || exists(pid)) throw new Error(`preserving primary sandbox: ${name} exit is unverified`);
                    }
                    return removeSandbox.call(runtime.sandbox);
                };
                try { await runtime.stop(); }
                finally { runtime.sandbox.cleanup = removeSandbox; }
            }],
            ['check primary daemon process', () => observe('daemon', daemonPid)],
            ['check primary shell process', () => observe('shell', shellPid)],
            ['check primary sandbox removal', () => {if (fs.existsSync(runtime.sandbox.root)) cleanup.leaks.push({ path: runtime.sandbox.root });}],
        ] : []),
        ...finalRetains,
    ];
}
// cleanup-plan:end
const recordCleanupFailure = (label, error) => cleanup.errors.push(`${label}: ${String(error?.stack ?? error)}`);
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
    let remote,daemon,remoteCLI;
    const remotePids=[];
    let remoteB,daemonB,remoteBCLI;
    const remoteBPids=[];
    const commandB=async args=>{const r=await remoteBCLI.run(args);calls.push({host:'untrusted-peer',args,result:r});if(r.code!==0)throw new Error(`second remote fixture command failed: ${r.stderr||r.stdout}`);return JSON.parse(r.stdout);};
    const command=async args=>{const r=await remoteCLI.run(args);calls.push({args,result:r});if(r.code!==0)throw new Error(`remote fixture command failed: ${r.stderr||r.stdout}`);return JSON.parse(r.stdout);};
    const shot=async name=>{const file=path.join(out,`${name}.png`);await page.screenshot(file);artifacts.push({role:'visual',path:file,sha256:sha(fs.readFileSync(file))});};
    try {
        remote=await stack.makeSandbox(root,{label:'incident193-remote',clientDir:path.join(root,'packages/client/dist')});
        daemon=stack.startDaemon(remote,{repoRoot:root});remotePids.push(daemon.child?.pid);
        remoteCLI=stack.makeCli(remote,{repoRoot:root});
        await stack.waitForHealthz(remote.base);
        await command(['plugin','install',path.join(root,'examples/plugins/agent-board'),'--trust']);
        const workspace=await command(['workspace','create','--name','Incident193 remote plugin','--json']);
        const pane=await command(['plugin','open','example.agent-board','example.agent-board.board','--workspace',workspace.workspace_id]);
        const token=fs.readFileSync(path.join(remote.runDir,`daemon-v${stack.PROTOCOL_VERSION}.token`),'utf8').trim();
        remoteB=await stack.makeSandbox(root,{label:'i193-peer',clientDir:path.join(root,'packages/client/dist')});
        daemonB=stack.startDaemon(remoteB,{repoRoot:root});remoteBPids.push(daemonB.child?.pid);
        remoteBCLI=stack.makeCli(remoteB,{repoRoot:root});
        await stack.waitForHealthz(remoteB.base);
        await commandB(['plugin','install',path.join(root,'examples/plugins/agent-board'),'--trust']);
        const workspaceB=await commandB(['workspace','create','--name','Incident193 untrusted peer','--json']);
        const paneB=await commandB(['plugin','open','example.agent-board','example.agent-board.board','--workspace',workspaceB.workspace_id]);
        const tokenB=fs.readFileSync(path.join(remoteB.runDir,`daemon-v${stack.PROTOCOL_VERSION}.token`),'utf8').trim();
        fs.writeFileSync(sandbox.configPath,`${previousConfig}\nremote-daemon = Incident193:${remote.base}/?token=${token}\nremote-daemon = Incident193Peer:${remoteB.base}/?token=${tokenB}\n`);
        await page.watchFrames();
        const row=`[data-testid="remote-daemon-Incident193"] [data-workspace-id="${workspace.workspace_id}"]`;
        if(!await d.settleDom(page,`document.querySelector(${JSON.stringify(row)})`,{ceilingMs:12000}))throw new Error('Private remote host fixture did not appear');
        await page.click(row);
        const frame=`[data-testid="plugin-view-${pane.paneID}"] iframe`;
        const ready=()=>d.settle(async()=>{try{return await page.evalInFrame(frame,`(async()=> (await kelpi.snapshot()).state.workspaces.some(w=>w.id===${JSON.stringify(workspace.workspace_id)}))()`);}catch{return false;}},{ceilingMs:15000});
        if(!await ready())throw new Error('Actual remote plugin iframe did not become ready');
        check('control: real remote plugin connects to its owning daemon',true);
        const peerRow=`[data-testid="remote-daemon-Incident193Peer"] [data-workspace-id="${workspaceB.workspace_id}"]`;
        const peerFrame=`[data-testid="plugin-view-${paneB.paneID}"] iframe`;
        const peerReady=()=>d.settle(async()=>{try{return await page.evalInFrame(peerFrame,`(async()=> (await kelpi.snapshot()).state.workspaces.some(w=>w.id===${JSON.stringify(workspaceB.workspace_id)}))()`);}catch{return false;}},{ceilingMs:15000});
        check('control: a second independent saved remote host is connected',await d.settleDom(page,`document.querySelector(${JSON.stringify(peerRow)})`,{ceilingMs:12000}));
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
        check('grant: navigation contains both saved hosts without either credential',allowed.ok && hosts.some(h=>h.name==='Incident193Peer') && !JSON.stringify(allowed.value).includes(token) && !JSON.stringify(allowed.value).includes(tokenB));
        const localHost=hosts.find(h=>h.kind==='local');
        const peerHost=hosts.find(h=>h.name==='Incident193Peer');
        const localWorkspace=localHost?.workspaces[0];
        if(allowed.ok){
            await page.evalInFrame(frame,`(()=>{globalThis.__incidentNavigation=[];globalThis.__incidentNavigationErrors=[];globalThis.__incidentNavigationOff=kelpi.ui.onNavigation(value=>globalThis.__incidentNavigation.push(value),error=>globalThis.__incidentNavigationErrors.push(String(error.message)));return true;})()`);
        }
        check('grant: actual remote navigation subscription receives its initial value',allowed.ok && await d.settle(async()=>await page.evalInFrame(frame,`globalThis.__incidentNavigation?.length>0`),{ceilingMs:5000}));
        const subscriptionWorkspace=await commandB(['workspace','create','--name','Incident193 peer subscription update','--json']);
        check('grant: navigation subscription observes changes on a different remote host',allowed.ok && await d.settle(async()=>await page.evalInFrame(frame,`globalThis.__incidentNavigation?.some(value=>value.hosts.some(host=>host.workspaces.some(w=>w.id===${JSON.stringify(subscriptionWorkspace.workspace_id)})))`),{ceilingMs:5000}));
        if(allowed.ok && localWorkspace){
            await page.evalInFrame(frame,`(()=>{setTimeout(()=>{void kelpi.ui.selectWorkspace(${JSON.stringify(localHost.id)},${JSON.stringify(localWorkspace.id)}).catch(()=>{});},0);return true;})()`);
        }
        check('grant: remote plugin selects an actual local workspace',allowed.ok && Boolean(localWorkspace) && await d.settleDom(page,`!document.querySelector(${JSON.stringify(frame)}) && !!document.querySelector('[data-workspace-id="${localWorkspace?.id}"][data-active="true"]')`,{ceilingMs:6000}));
        await shot('grant-selected-local');
        await page.click(row);
        if(!await ready())throw new Error('Trusted remote plugin did not return after local navigation');
        if(allowed.ok && peerHost){
            await page.evalInFrame(frame,`(()=>{setTimeout(()=>{void kelpi.ui.selectWorkspace(${JSON.stringify(peerHost.id)},${JSON.stringify(workspaceB.workspace_id)}).catch(()=>{});},0);return true;})()`);
        }
        check('grant: trusted remote plugin selects an actual other-host workspace',allowed.ok && Boolean(peerHost) && await d.settleDom(page,`document.querySelector(${JSON.stringify(peerFrame)}) && !document.querySelector(${JSON.stringify(frame)})`,{ceilingMs:6000}));
        await page.click(peerRow);
        if(!await peerReady())throw new Error('Second private remote plugin did not become ready');
        const peerDenied=await page.evalInFrame(peerFrame,`(async()=>{const results=[];for(const [method,args] of [['ui.getNavigation',{}],['ui.selectWorkspace',{hostID:${JSON.stringify(localHost?.id??'local')},workspaceID:${JSON.stringify(localWorkspace?.id??'missing')}}]]){try{await kelpi.call(method,args);results.push({method,denied:false});}catch(error){results.push({method,denied:String(error.message).includes('unavailable for this daemon')});}}return results;})()`);
        check('isolation: granting one saved host leaves another host navigation reads and writes denied',peerDenied.length===2 && peerDenied.every(v=>v.denied),peerDenied);
        check('isolation: second host never receives a saved navigation grant',!fs.readFileSync(sandbox.configPath,'utf8').includes('remote-daemon-navigation-trust = Incident193Peer:'));
        await shot('untrusted-peer-selected');
        await page.click(row);
        if(!await ready())throw new Error('Trusted remote plugin did not return after other-host navigation');
        const invalidTarget=await page.evalInFrame(frame,`(async()=>{try{await kelpi.ui.selectWorkspace(${JSON.stringify(localHost?.id??'local')},${JSON.stringify(workspaceB.workspace_id)});return {rejected:false};}catch(error){return {rejected:true,error:String(error.message)};}})()`);
        check('control: workspace IDs cannot be used with the wrong host',invalidTarget.rejected && await page.eval(`Boolean(document.querySelector(${JSON.stringify(frame)}))`),invalidTarget);
        const prohibited=await page.evalInFrame(frame,`(async()=>{try{await kelpi.ui.selectView('sidebar.primary','kelpi.workspaces');return false;}catch(e){return String(e.message).includes('unavailable for this daemon');}})()`);
        check('control: navigation trust does not grant arbitrary workbench writes',prohibited);
        await toggle(false,'revoke');
        check('revoke: mounted remote plugin loses navigation immediately',await refused());
        const deniedSelect=await page.evalInFrame(frame,`(async()=>{try{await kelpi.ui.selectWorkspace(${JSON.stringify(localHost?.id??'local')},${JSON.stringify(localWorkspace?.id??'missing')});return false;}catch(error){return String(error.message).includes('unavailable for this daemon');}})()`);
        check('revoke: an actual valid local destination is denied after grant removal',deniedSelect && await page.eval(`Boolean(document.querySelector(${JSON.stringify(frame)}))`));
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
        await runCleanupPlan(buildRemoteCleanupPlan({
            retain, fs, sandbox, previousConfig, page, d, daemon, daemonB,
            remotePids, remoteBPids, remote, remoteB, exists, cleanup,
        }), recordCleanupFailure);
    }
    if (JSON.stringify(collectBuildFiles()) !== JSON.stringify(buildFiles)) throw new Error('build output membership changed during incident test');
    const after = buildFiles.map(file => ({ path: file, sha256: sha(fs.readFileSync(path.join(root, file))) }));
    if (JSON.stringify(after) !== JSON.stringify(build)) throw new Error('executed build outputs changed during the incident test');
} catch (error) {
    errors.push(String(error?.stack ?? error));
} finally {
    cleanup.attempted = true;
    await runCleanupPlan(buildPrimaryCleanupPlan({
        rendererWatch, runtime: t, retain, check, daemonPid, shellPid, exists, fs, cleanup,
        finalRetains: [['retain CLI calls', () => retain('cli-calls.json', calls)]],
    }), recordCleanupFailure);
    if (bootAttempted && !t) cleanup.errors.push('boot rejected before returning owned runtime handles; process and sandbox cleanup is unverified and requires external inspection');
    cleanup.completed = cleanup.errors.length === 0 && cleanup.leaks.length === 0;
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
}
process.exitCode = errors.length || !cleanup.completed ? 2 : assertions.some(a => !a.ok) ? 1 : 0;
