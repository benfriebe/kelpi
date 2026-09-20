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
        id: 'local-macos-private-workspace-deletion', kind: 'local',
        details: 'Real private daemon and Electron application; CLI, trusted CDP pointer input and CDP Command-W. Does not certify physical keyboard input or any remote/device environment.',
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
    t = await d.boot({ repoRoot: root, label: 'incident241', build: false, window: 'onscreen', log: line => console.log(line) });
    daemonPid = t.daemon?.pid; shellPid = t.shell?.child?.pid;
    rendererWatch = await observeRenderer(t.page);
    retain('native-runtime-identity.json',{shell:await t.harness.ping(),window:await t.harness.window(),node:process.version,platform:process.platform,arch:process.arch,rendererWatchScope:'after-boot; first-document startup belongs to the separate issue239 fixture'},'environment');
    const run = async (args, options) => {
        const answer = await t.cli.run(args, options);
        calls.push({ at: new Date().toISOString(), args, answer });
        return answer;
    };
    const json = async (args, options) => {
        const answer = await run(args, options);
        if (answer.code !== 0) throw new Error(`fixture command failed ${args.join(' ')}: ${answer.stderr || answer.stdout}`);
        return JSON.parse(answer.stdout);
    };
    const list = () => json(['workspace', 'list', '--json']);
    const makeIdle = async route => {
        const name = `incident241-${route}`;
        const created = await json(['workspace', 'create', '--name', name, '--json']);
        const id = created.workspace_id;
        const panes = await json(['pane', 'list', '--workspace', id, '--json']);
        const paneId = panes[0]?.id;
        if (!id || !paneId) throw new Error('workspace fixture returned no workspace/pane');
        const session = `incident241-${route}-session`;
        const bound = await run(['event', 'session-start', '--agent', 'codex'], {
            env: { KELPI_PANE_ID: paneId }, stdin: JSON.stringify({ session_id: session })
        });
        if (bound.code !== 0) throw new Error(`session binding failed: ${bound.stderr}`);
        const ready = await d.settle(async () => {
            const now = await json(['pane', 'list', '--workspace', id, '--json']);
            return now.some(p => p.id === paneId && p.status === 'idle' && p.agent_session_id === session);
        }, { ceilingMs: 5000 });
        if (!ready) throw new Error('fixture never established the real idle bound session');
        check(`${route}: real idle bound session established`, true, { id, paneId, session });
        return { id, paneId, name, session };
    };
    const survives = async fixture => {
        if (!(await list()).some(w => w.id === fixture.id)) return false;
        const panes = await json(['pane', 'list', '--workspace', fixture.id, '--json']);
        return panes.some(p => p.id === fixture.paneId && p.status === 'idle' && p.agent_session_id === fixture.session);
    };
    const shot = async name => {
        const file = path.join(out, `${name}.png`);
        await t.page.screenshot(file);
        artifacts.push({ role: 'visual', path: file, sha256: sha(fs.readFileSync(file)) });
    };
    const sentinel = await json(['workspace', 'create', '--name', 'incident241-control', '--json']);
    const cli = await makeIdle('cli');
    const refusal = await run(['workspace', 'delete', cli.id, '--json']);
    const refusalData = JSON.parse(refusal.stdout)[0];
    check('cli: unconfirmed delete refuses an inactive session', refusal.code === 1 && refusalData.active_agents === 1 && refusalData.running === 0 && refusalData.waiting === 0 && refusalData.inactive === 1, refusalData);
    check('cli: refused delete preserves workspace and session', await survives(cli));

    const sidebar = await makeIdle('sidebar');
    if (!await d.settleDom(t.page, `document.querySelector('[data-testid="pane-header-${sidebar.paneId}"]')`, { ceilingMs: 5000 })) throw new Error('sidebar fixture pane never rendered');
    await d.openSidebarMenu(t.page, d.PAGE.workspaceRows, sidebar.name);
    await d.clickMenuItem(t.page, 'Delete');
    const warning = 'This workspace has 1 inactive agent. Deleting it will close it.';
    const sidebarWarning = await d.settleDom(t.page, `document.querySelector('[data-testid="confirm-active-agents"]')?.textContent === ${JSON.stringify(warning)}`, { ceilingMs: 2000 });
    check('sidebar: unconfirmed delete warns about the inactive session', sidebarWarning);
    await shot('sidebar-delete-result');
    await t.page.key('Escape');
    await d.settleDom(t.page, `document.querySelector('[data-testid="confirm-dialog"]') === null`, { ceilingMs: 2000 });
    check('sidebar: cancellation preserves workspace and session', await survives(sidebar));

    const keyboard = await makeIdle('keyboard');
    if (!await d.settleDom(t.page, `document.querySelector('[data-testid="pane-header-${keyboard.paneId}"]')`, { ceilingMs: 5000 })) throw new Error('keyboard fixture pane never rendered');
    await d.clickPaneHeader(t.page, keyboard.paneId);
    await t.page.key('KeyW', { key: 'w', modifiers: d.MOD.meta });
    const keyboardWarning = await d.settleDom(t.page, `document.querySelector('[data-testid="agent-delete-gate"]')?.textContent.includes(${JSON.stringify(warning)})`, { ceilingMs: 2000 });
    check('keyboard: last-pane Command-W warns about the inactive session', keyboardWarning);
    await shot('keyboard-delete-result');
    await t.page.key('Escape');
    check('keyboard: cancellation preserves workspace and session', await survives(keyboard));

    const forced = await makeIdle('forced');
    const confirmed = await run(['workspace', 'delete', forced.id, '--force', '--json']);
    check('control: explicit force deletes only the requested workspace', confirmed.code === 0 && !(await list()).some(w => w.id === forced.id) && (await list()).some(w => w.id === sentinel.workspace_id));
    const empty = await json(['workspace', 'create', '--name', 'incident241-empty', '--json']);
    const deleted = await run(['workspace', 'delete', empty.workspace_id, '--json']);
    check('control: a workspace without agents remains deletable', deleted.code === 0 && !(await list()).some(w => w.id === empty.workspace_id));
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
