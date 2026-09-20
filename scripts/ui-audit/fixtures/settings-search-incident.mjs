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
        id: 'local-macos-private-settings-search', kind: 'local',
        details: 'Real private daemon and assembled Electron Settings, including a real Settings Lab iframe; incremental CDP keyboard search and pointer input. Does not certify a physical phone or native software keyboard.',
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
    t = await d.boot({ repoRoot: root, label: 'incident173', build: false, window: 'onscreen', log: line => console.log(line) });
    daemonPid = t.daemon?.pid; shellPid = t.shell?.child?.pid;
    rendererWatch = await observeRenderer(t.page);
    retain('native-runtime-identity.json',{shell:await t.harness.ping(),window:await t.harness.window(),node:process.version,platform:process.platform,arch:process.arch,rendererWatchScope:'after-boot; first-document startup belongs to the separate issue239 fixture'},'environment');
    const { page, cli, sandbox } = t;
    const open = async () => {
        if (!await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`)) await page.key('Comma', { modifiers: 4, key: ',' });
        if (!await d.settleDom(page, `document.querySelector('[data-testid="settings-close"]')`, { ceilingMs: 10000 })) throw new Error('Settings fixture did not open');
    };
    const readConfig = () => [fs.readFileSync(sandbox.configPath, 'utf8'), fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8')];
    const input = '[data-testid="settings-search"]';
    const resultSelector = '[data-testid="settings-search-result-sidebar-group-fill"]';
    const targetSelector = '[data-testid="sidebar-group-fill"]';
    const shot = async name => {
        const file = path.join(out, `${name}.png`);
        await page.screenshot(file);
        artifacts.push({ role: 'visual', path: file, sha256: sha(fs.readFileSync(file)) });
    };
    const focusSnapshot = async (phase,query) => {
        const snapshot=await page.eval(`(() => {
            const node=document.querySelector('${input}'),active=document.activeElement,b=node?.getBoundingClientRect();
            const hit=b?document.elementFromPoint(b.x+b.width/2,b.y+b.height/2):null;
            return {focused:node===active,hasFocus:document.hasFocus(),activeTag:active?.tagName,
                activeTestID:active?.dataset?.testid,activeID:active?.id,activeText:active?.textContent?.slice(0,100),
                hitTag:hit?.tagName,hitTestID:hit?.dataset?.testid,hitID:hit?.id,box:b?{x:b.x,y:b.y,width:b.width,height:b.height}:null,
                value:node?.value,events:globalThis.__incident173Events?.slice(-35)};
        })()`);
        calls.push({phase,query,snapshot});return snapshot;
    };
    await page.eval(`(() => {globalThis.__incident173Events=[];
        for(const kind of ['focusin','focusout','pointerdown','pointerup','keydown','keyup','input'])document.addEventListener(kind,e=>{
            const t=e.target;globalThis.__incident173Events.push({at:performance.now(),kind,trusted:e.isTrusted,tag:t?.tagName,id:t?.id,testID:t?.dataset?.testid,key:e.key,activeTag:document.activeElement?.tagName,activeID:document.activeElement?.id});
            if(globalThis.__incident173Events.length>1000)globalThis.__incident173Events.shift();
        },true);return true;})()`);
    const type = async query => {
        if (!await page.eval(`!!document.querySelector('${input}')`)) return { found: false, trail: [] };
        await focusSnapshot('before-click',query);
        const clickBox=await page.click(input); calls.push({phase:'click',query,clickBox});
        await focusSnapshot('after-click',query);
        await page.eval(`globalThis.__incident173Input = document.querySelector('${input}'); true`);
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4 });
        await page.key('Backspace');
        const trail = [];
        for (const character of query) {
            await page.key(character === ' ' ? 'Space' : `Key${character.toUpperCase()}`, { key: character, text: character, keyCode: character.toUpperCase().charCodeAt(0) });
            trail.push(await page.eval(`(() => { const node = document.querySelector('${input}'); return {value:node?.value, same:node === globalThis.__incident173Input, focused:node === document.activeElement}; })()`));
        }
        await focusSnapshot('after-typing',query);
        return { found: true, trail };
    };
    const targetState = () => page.eval(`(() => {
        const target = document.querySelector('${targetSelector}');
        const panel = document.querySelector('[data-testid="settings-panel"]');
        if (!target || !panel) return null;
        const box = target.getBoundingClientRect(), clip = panel.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x+box.width/2, box.y+box.height/2);
        return {visible:target.checkVisibility({checkVisibilityCSS:true}) && box.width>0 && box.height>0 && box.top>=Math.max(0,clip.top)-1 && box.bottom<=Math.min(innerHeight,clip.bottom)+1 && target.contains(hit), focused:target.contains(document.activeElement), highlighted:target.dataset.settingsSearchHit === 'true'};
    })()`);
    await open();
    await page.click('[data-testid="settings-tab-button-appearance"]');
    const precondition = await d.settleDom(page, `document.querySelector('${targetSelector}')`);
    if (!precondition) throw new Error('Original Group band fill control is absent: invalid fixture');
    check('control: Group band fill exists in the original Appearance section', true);
    for (const mode of ['bundled', 'presenter']) {
        if (mode === 'presenter') {
            await open();
            const installed = await cli.run(['plugin', 'install', path.join(root, 'examples/plugins/settings-lab'), '--trust']);
            calls.push({ args: ['plugin', 'install', 'settings-lab', '--trust'], answer: installed });
            if (installed.code !== 0) throw new Error(`Settings Lab fixture failed: ${installed.stderr || installed.stdout}`);
            await page.click('[data-testid="settings-tab-button-plugins"]');
            const ready = await d.settleDom(page, `document.querySelector('select[aria-label="settings.window"]')`);
            if (!ready) throw new Error('Settings presenter fixture select absent');
            const configured = await page.eval(`(() => { const select=document.querySelector('select[aria-label="settings.window"]'); const option=[...select.options].find(x=>x.value.includes('settings-lab')); if(!option)return false; select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
            if (!configured) throw new Error('Settings Lab presenter was not offered');
            if (!await d.settleDom(page, `document.querySelector('[data-testid="settings-presenter"] iframe')`, {ceilingMs:10000})) throw new Error('Settings Lab presenter did not attach');
            await page.watchFrames();
            if (!await d.settle(async()=> { try {return await page.evalInFrame('[data-testid="settings-presenter"] iframe', `document.body.dataset.ready === 'true'`);} catch {return false;} }, {ceilingMs:10000})) throw new Error('Settings Lab presenter never became ready');
            check('control: actual Settings Lab presenter is attached and ready', true);
        }
        const beforeConfig = readConfig();
        for (const query of ['group', 'fill']) {
            const typed = await type(query);
            check(`${mode}: typing ${query} retains input identity and focus`, typed.found && typed.trail.length === query.length && typed.trail.every((s,i)=>s.same && s.focused && s.value === query.slice(0,i+1)), typed);
            const hit = await page.eval(`(() => {const hit=document.querySelector('${resultSelector}');return !!hit && hit.textContent.includes('Group band fill') && hit.closest('section')?.getAttribute('aria-label') === 'Appearance search results';})()`);
            check(`${mode}: ${query} discovers Group band fill with Appearance context`, hit);
        }
        const typed = await type('group band fill');
        let reached = false;
        if (typed.found) {
            const budget = await page.eval(`document.querySelectorAll('[data-testid="settings-window"] button').length + 2`);
            for (let i=0;i<budget;i++) {
                await page.key('Tab');
                if (await page.eval(`document.activeElement?.matches('${resultSelector}')`)) { reached=true;break; }
            }
            if (reached) await page.key('Enter');
        }
        check(`${mode}: search result is reachable with Tab and Enter`, reached);
        const revealed = reached && await d.settle(async()=> {const s=await targetState();return s?.visible && s.focused && s.highlighted;}, {ceilingMs:3000, intervalMs:25});
        check(`${mode}: search reveals the actual visible focused Group band fill control`, revealed, await targetState());
        await shot(`${mode}-group-fill-destination`);
        check(`${mode}: search navigation leaves both config files unchanged`, JSON.stringify(beforeConfig) === JSON.stringify(readConfig()));
        await page.key('Escape');
        check(`${mode}: Escape closes Settings`, await d.settleDom(page, `!document.querySelector('[data-testid="settings-window"]')`));
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
