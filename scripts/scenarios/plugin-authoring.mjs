/** An external author's complete package → develop → update → recover workflow. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { connect, listTargets } from '../ui-audit/lib/cdp.mjs';
import { startBrowserFixture } from '../fixtures/plugin-browser.mjs';

export const covers = ['packages/core/src/plugin-package/', 'packages/cli/src/commands/plugin', 'packages/daemon/src/plugins/', 'packages/client/src/plugins/PluginRevisions', 'packages/client/src/plugins/PluginsTab', 'packages/plugin-sdk/'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginID = 'example.external-author', viewID = pluginID + '.home', browserViewID = pluginID + '.browser', terminalViewID = pluginID + '.terminal';
const quote = JSON.stringify;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const frame = paneID => '[data-testid="plugin-view-' + paneID + '"] iframe';

export default async function ({ page, cli, sandbox, rec, d, shell }) {
    if (!shell) throw new Error('Authoring validation requires its own private instance.');
    await page.watchFrames();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-external-author-'));
    const source = path.join(external, 'project'), archive = path.join(external, 'first.kelpi-plugin');
    const fixture = await startBrowserFixture();
    const json = async args => JSON.parse(await cli.ok(args, { cwd: external }));
    const inside = (paneID, expression) => page.evalInFrame(frame(paneID), expression);
    const ready = (paneID, version) => d.settle(async () => {
        try { return await inside(paneID, 'document.body.dataset.ready === "true" && document.body.dataset.version === ' + quote(version) + (paneID === browserPaneID ? ' && globalThis.presentation?.available === true && globalThis.presentation?.visible === true' : '')); }
        catch { return false; }
    }, { ceilingMs: 15_000 });
    const current = async () => (await json(['plugin', 'list', '--json'])).find(item => item.manifest.id === pluginID);
    const manifestPath = path.join(source, 'kelpi.plugin.json');
    let dev, native, workspace, paneID, terminal, browserPaneID, editorPaneID, manifest, pid;
    const editorRoot = path.join(external, 'editor-process'), editorFile = path.join(external, 'document.md');
    const editorProfiles = new Map();
    const editorState = () => { try { return JSON.parse(fs.readFileSync(path.join(editorRoot, 'state.json'), 'utf8')); } catch { return null; } };
    const chooseTerminal = async view => {
        const selector = '[data-terminal-pane="' + editorPaneID + '"] select[aria-label="Terminal renderer"]';
        if (!await d.settleDom(page, 'document.querySelector(' + quote(selector) + ')')) throw new Error('External-editor renderer selector is missing.');
        await page.eval('(() => { const select = document.querySelector(' + quote(selector) + '); select.value = ' + quote(view) + '; select.dispatchEvent(new Event("change", {bubbles:true})); })()');
    };
    const openEditor = async version => {
        const previousPID = editorState()?.pid;
        fs.rmSync(path.join(editorRoot, 'command.json'), { force: true });
        const button = '[data-testid="open-external-editor-' + editorPaneID + '"]';
        if (!await d.settleDom(page, 'document.querySelector(' + quote(button) + ')')) throw new Error('External-editor control is missing.');
        await page.click(button);
        if (!await d.settle(() => editorState()?.pid > 0 && editorState()?.pid !== previousPID)) throw new Error('External-editor process did not start.');
        await chooseTerminal(terminalViewID);
        if (!await ready(editorPaneID, version)) throw new Error('External-editor renderer did not attach.');
        return editorState().pid;
    };
    const closeEditor = async () => {
        await chooseTerminal('kelpi.shell');
        const sequence = (editorState()?.sequence ?? 0) + 1;
        fs.writeFileSync(path.join(editorRoot, 'command.json'), JSON.stringify({ op: 'exit', sequence }));
        if (!await d.settleDom(page, 'document.querySelector(\'[data-document-pane="' + editorPaneID + '"]\') && !document.querySelector(\'[data-terminal-pane="' + editorPaneID + '"]\')')) throw new Error('External editor did not return to the document.');
    };
    let devOutput = '', devErrors = '';
    const events = () => devOutput.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
    const stopDev = async () => {
        if (!dev || dev.exitCode !== null || dev.signalCode !== null) return;
        const ended = new Promise(resolve => dev.once('close', (code, signal) => resolve({ code, signal })));
        dev.kill('SIGINT');
        const timeout = setTimeout(() => dev.kill('SIGKILL'), 40_000);
        try { return await ended; } finally { clearTimeout(timeout); }
    };
    const writeVersion = (version, { fail = false, stateVersion = 1 } = {}) => {
        manifest.version = version;
        manifest.contributes.views[0].stateVersion = stateVersion;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        fs.writeFileSync(path.join(source, 'backend.mjs'), [
            'export async function activate(api) {',
            ' await api.storage.set("activationVersion", ' + quote(version) + ');',
            fail ? ' throw new Error("Intentional author update failure");' : ' api.commands.register("' + pluginID + '.summary", () => ({ version: ' + quote(version) + ' }));',
            '}',
        ].join('\n'));
        fs.writeFileSync(path.join(source, 'ui', 'app.js'), [
            'const api = globalThis.kelpi; await api.ready;',
            'document.body.dataset.version = ' + quote(version) + ';',
            'document.getElementById("version").textContent = ' + quote(version) + ';',
            'document.getElementById("notes").value = api.state.note ?? "";',
            'document.getElementById("save").onclick = async () => { await api.setState({note: document.getElementById("notes").value}); document.getElementById("status").textContent = "Saved"; };',
            'document.body.dataset.ready = "true";',
        ].join('\n'));
        fs.writeFileSync(path.join(source, 'ui', 'browser.js'), [
            'const api = globalThis.kelpi; await api.ready;',
            'globalThis.surface = await api.browser.attach({element: document.getElementById("page"), onPresentation(value) { globalThis.presentation = value; }});',
            'document.body.dataset.version = ' + quote(version) + ';',
            'document.body.dataset.ready = "true";',
        ].join('\n'));
        fs.writeFileSync(path.join(source, 'ui', 'terminal.js'), [
            'const api = globalThis.kelpi; await api.ready;',
            'document.body.dataset.version = ' + quote(version) + ';',
            'globalThis.session = await api.terminal.attach({cols:80, rows:24, onFrame(frame) {',
            ' if (frame.type === "replay") document.getElementById("output").textContent = "";',
            ' if (frame.type === "replay" || frame.type === "output") document.getElementById("output").textContent += new TextDecoder().decode(frame.data);',
            '}});',
            'document.body.dataset.ready = "true";',
        ].join('\n'));
    };
    const retained = async label => {
        const panes = await json(['pane', 'list', '--workspace', workspace.workspace_id, '--json']);
        const state = await native.eval('browserFixture.state()');
        const checkpoint = path.join(external, 'terminal-' + Date.now() + '.txt');
        await cli.ok(['pane', 'send', '--target', terminal, 'printf "%s:%s" "$$" "$KELPI_AUTHOR_SENTINEL" > ' + shellQuote(checkpoint)]);
        const sameTerminal = await d.settle(() => fs.existsSync(checkpoint) && fs.readFileSync(checkpoint, 'utf8') === pid + ':preserved');
        let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
        rec.check(label, panes.some(item => item.id === paneID && item.type === 'plugin') &&
            panes.some(item => item.id === terminal && item.type === 'shell') &&
            panes.some(item => item.id === browserPaneID && item.type === 'web') && alive && sameTerminal &&
            state.instance === native.identity && state.note === 'Unsaved native page note' && state.clicks === 1,
            JSON.stringify({ terminalPID: pid, nativePage: state.instance }));
    };
    try {
        rec.note('Create and validate a self-contained plugin outside the Kelpi repository');
        await json(['plugin', 'init', source, '--id', pluginID, '--name', 'External author']);
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.activation = 'startup';
        manifest.contributes.commands = [{ id: pluginID + '.summary', title: 'Version' }];
        manifest.contributes.views.push({ id: browserViewID, title: 'Author browser', entry: 'ui/browser.html', placements: ['browser'], stateVersion: 1 });
        manifest.contributes.views.push({ id: terminalViewID, title: 'Author terminal', entry: 'ui/terminal.html', placements: ['terminal'], stateVersion: 1 });
        fs.writeFileSync(path.join(source, 'ui', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px system-ui;background:#15262b;color:#d9eceb;padding:18px}textarea{display:block;width:90%;height:110px;margin:14px 0}button{padding:6px 12px}</style></head><body><h2>External author</h2><p>Version <span id="version"></span></p><textarea id="notes" aria-label="Saved plugin note"></textarea><button id="save">Save note</button><p id="status"></p><script type="module" src="./app.js"></script></body></html>');
        fs.writeFileSync(path.join(source, 'ui', 'browser.html'), '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#14272c;color:#d9eceb;font:12px system-ui}header{height:28px;padding:4px;box-sizing:border-box}#page{height:calc(100% - 28px)}</style></head><body><header>External browser renderer</header><div id="page"></div><script type="module" src="./browser.js"></script></body></html>');
        fs.writeFileSync(path.join(source, 'ui', 'terminal.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="output"></pre><script type="module" src="./terminal.js"></script></body></html>');
        writeVersion('1.0.0');
        const validated = await json(['plugin', 'validate', source, '--json']);
        const packed = await json(['plugin', 'pack', source, '--out', archive, '--json']);
        const second = await json(['plugin', 'pack', source, '--out', path.join(external, 'second.kelpi-plugin'), '--json']);
        rec.check('external project packs reproducibly with the same validated revision', !source.startsWith(repoRoot + path.sep) && validated.revision === packed.revision && packed.sha256 === second.sha256);
        await json(['plugin', 'install', archive, '--trust']);
        rec.check('artifact install activates the external backend', (await current()).revision === packed.revision && (await json(['plugin', 'run', pluginID + '.summary'])).version === '1.0.0');
        workspace = await json(['workspace', 'create', '--name', 'Plugin authoring', '--json']);
        terminal = (await json(['pane', 'list', '--workspace', workspace.workspace_id, '--json']))[0].id;
        const pidPath = path.join(external, 'terminal.pid');
        await cli.ok(['pane', 'send', '--target', terminal, 'export KELPI_AUTHOR_SENTINEL=preserved; printf "%s" "$$" > ' + shellQuote(pidPath)]);
        if (!await d.settle(() => fs.existsSync(pidPath) && Number(fs.readFileSync(pidPath, 'utf8')) > 0)) throw new Error('Terminal did not initialize.');
        pid = Number(fs.readFileSync(pidPath, 'utf8'));
        paneID = (await json(['plugin', 'open', pluginID, viewID, '--workspace', workspace.workspace_id, '--state', '{"note":"Keep this plugin note"}'])).paneID;
        const url = fixture.url + '/page/one?owner=external-author';
        const opened = await cli.ok(['web', 'open', url], { paneID: terminal });
        browserPaneID = /open ok:\s*([0-9a-f-]{36})/i.exec(opened)?.[1];
        if (!browserPaneID) throw new Error('Native browser did not open: ' + opened);
        let target;
        if (!await d.settle(async () => { target = (await listTargets(sandbox.debugPort)).find(item => item.type === 'page' && item.url === url); return target; })) throw new Error('Native target missing.');
        native = await connect(target.webSocketDebuggerUrl, { repoRoot });
        await d.settle(async () => { try { return await native.eval('!!globalThis.browserFixture'); } catch { return false; } });
        await native.eval('document.getElementById("note").value = "Unsaved native page note"; document.getElementById("increment").click(); true');
        native.identity = await native.eval('browserFixture.instance');
        const picker = '[data-browser-pane="' + browserPaneID + '"] select[aria-label="Browser renderer"]';
        await d.settleDom(page, 'document.querySelector(' + quote(picker) + ')');
        await page.eval('(() => { const select = document.querySelector(' + quote(picker) + '); select.value = ' + quote(browserViewID) + '; select.dispatchEvent(new Event("change", {bubbles:true})); })()');
        rec.check('external pane and native browser renderer mount from the installed artifact', await ready(paneID, '1.0.0') && await ready(browserPaneID, '1.0.0'));
        await inside(paneID, 'document.getElementById("notes").value = "Edited plugin note"; document.getElementById("save").click(); true');
        rec.check('the custom view saves edits through the injected SDK', await d.settle(async () => inside(paneID, 'document.getElementById("status").textContent === "Saved" && kelpi.state.note === "Edited plugin note"')));
        await inside(browserPaneID, 'kelpi.setState({nativePreference: "keep"})');
        await rec.shot(page, '01-external-plugin');

        // A document retains its terminal renderer preference after its external editor exits.
        // Keeping that dormant state must not block the unchanged package or later revisions.
        const editorCommand = path.join(external, 'editor');
        fs.writeFileSync(editorCommand, '#!/bin/sh\nexec ' + shellQuote(process.execPath) + ' ' + shellQuote(path.join(repoRoot, 'scripts/fixtures/plugin-terminal.cjs')) + ' ' + shellQuote(editorRoot) + ' "$@"\n', { mode: 0o755 });
        for (const profile of ['.zshenv', '.bash_profile', '.profile']) {
            const file = path.join(sandbox.home, profile);
            editorProfiles.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
            fs.appendFileSync(file, '\nexport EDITOR=' + shellQuote(editorCommand) + '\nexport VISUAL=' + shellQuote(editorCommand) + '\n');
        }
        fs.writeFileSync(editorFile, '# Document retained after its editor closes\n');
        await cli.ok(['open', editorFile], { paneID: terminal });
        if (!await d.settle(async () => { editorPaneID = (await json(['pane', 'list', '--workspace', workspace.workspace_id, '--json'])).find(pane => pane.type === 'markdown')?.id; return !!editorPaneID; })) throw new Error('External-editor document did not open.');
        const editorPID = await openEditor('1.0.0');
        await inside(editorPaneID, 'kelpi.setState({terminalPreference: "keep after editor closes"})');
        rec.check('an attached terminal renderer saves state on the document hosting its live external editor', await d.settle(async () => inside(editorPaneID, 'kelpi.state.terminalPreference === "keep after editor closes" && document.getElementById("output").textContent.includes(' + quote('PID ' + editorPID) + ')')));
        await closeEditor();
        rec.check('leaving external-editor mode preserves the native document before plugin development resumes', (await json(['document', 'get', editorPaneID])).text === fs.readFileSync(editorFile, 'utf8'));

        dev = spawn(process.execPath, [path.join(repoRoot, 'packages/cli/dist/kelpi.js'), 'plugin', 'dev', source, '--trust'], {
            cwd: external, env: { PATH: sandbox.env.PATH, HOME: sandbox.home, KELPI_SOCKET: 'tcp:127.0.0.1:' + sandbox.controlPort, KELPI_REQUIRE_SOCKET: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        dev.stdout.setEncoding('utf8'); dev.stderr.setEncoding('utf8');
        dev.stdout.on('data', data => { devOutput += data; }); dev.stderr.on('data', data => { devErrors += data; });
        if (!await d.settle(() => events().some(event => event.type === 'applied'), { ceilingMs: 15_000 })) throw new Error('Dev did not start: ' + devOutput + devErrors);
        writeVersion('1.1.0');
        rec.check('dev applies valid edits and remounts both views', await ready(paneID, '1.1.0') && await ready(browserPaneID, '1.1.0'));
        const updated = (await current()).revision;
        rec.check('saved plugin and native renderer preferences survive an update', await inside(paneID, 'kelpi.state.note === "Edited plugin note"') && await inside(browserPaneID, 'kelpi.state.nativePreference === "keep"'));
        await retained('update retains pane identities, the terminal PID and unsaved native browser state');
        fs.writeFileSync(manifestPath, '{incomplete edit');
        rec.check('an incomplete manifest is reported without replacing working code', await d.settle(() => events().some(event => event.type === 'invalid')) && (await current()).revision === updated);
        writeVersion('1.2.0', { fail: true });
        rec.check('backend activation failure is reported and the previous revision recovers', await d.settle(() => events().some(event => event.type === 'failed'), { ceilingMs: 15_000 }) && await ready(paneID, '1.1.0') && (await current()).revision === updated);
        rec.check('failed activation does not overwrite plugin storage', await inside(paneID, '(async () => await kelpi.storage.get("activationVersion") === "1.1.0")()'));
        writeVersion('1.3.0');
        rec.check('dev continues after invalid and failed edits', await ready(paneID, '1.3.0') && await ready(browserPaneID, '1.3.0'));
        const stop = await stopDev();
        rec.check('Ctrl-C closes dev cleanly and leaves the installed revision usable', stop?.code === 130 && events().some(event => event.type === 'stopped') && (await current()).manifest.version === '1.3.0', JSON.stringify({ stop, stderr: devErrors }));
        await retained('failure recovery preserves both native sessions');

        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, 'document.querySelector(\'[data-testid="settings-tab-button-plugins"]\')');
        await page.click('[data-testid="settings-tab-button-plugins"]');
        // Stable selectors belong to the real Settings revision controls.
        const revisions = '[data-testid="plugin-revisions-' + pluginID + '"]';
        await d.settleDom(page, 'document.querySelector(' + quote(revisions) + ')');
        await page.click(revisions + ' button[aria-expanded]');
        const oldRevision = revisions + ' [data-plugin-revision="' + packed.revision + '"] button';
        await d.settleDom(page, 'document.querySelector(' + quote(oldRevision) + ') && !document.querySelector(' + quote(oldRevision) + ').disabled');
        await page.eval('document.querySelector(' + quote(oldRevision) + ').scrollIntoView({block:"center"})');
        await rec.shot(page, '02-retained-revisions');
        await page.click(oldRevision);
        rec.check('Settings selects the requested retained revision', await d.settle(async () => (await current()).revision === packed.revision, { ceilingMs: 15_000 }));
        await page.click('[data-testid="settings-close"]');
        rec.check('UI rollback restores old code with saved pane and native view state', await ready(paneID, '1.0.0') && await ready(browserPaneID, '1.0.0') && await inside(paneID, 'kelpi.state.note === "Edited plugin note"') && await inside(browserPaneID, 'kelpi.state.nativePreference === "keep"'));
        await retained('rollback retains the same live native sessions');
        await page.send('Page.reload');
        rec.check('window reload reconnects to the selected retained revision', await ready(paneID, '1.0.0') && await ready(browserPaneID, '1.0.0'));
        await openEditor('1.0.0');
        rec.check('terminal renderer state survives compatible updates and rollback while the document is outside editor mode', await inside(editorPaneID, 'kelpi.state.terminalPreference === "keep after editor closes"'));
        await closeEditor();
        await retained('reopening the saved editor preference preserves the original shell and browser sessions');

        writeVersion('2.0.0', { stateVersion: 2 });
        await json(['plugin', 'install', source, '--trust']);
        if (!await ready(paneID, '2.0.0')) throw new Error('State version update did not mount.');
        await inside(paneID, 'kelpi.setState({note:"Newer saved state"})');
        const blocked = await cli.run(['plugin', 'rollback', pluginID, '--revision', packed.revision]);
        rec.check('rollback refuses incompatible saved state without losing the current pane', blocked.code !== 0 && /state|version/i.test(blocked.stderr) && (await current()).manifest.version === '2.0.0' && await inside(paneID, 'kelpi.state.note === "Newer saved state"'), blocked.stderr);
        const history = await json(['plugin', 'history', pluginID, '--json']);
        rec.check('history explains the blocked retained revision', history.find(item => item.revision === packed.revision)?.problem?.includes('state'));
        await page.key('Comma', { modifiers: 4, key: ',' });
        await d.settleDom(page, 'document.querySelector(\'[data-testid="settings-tab-button-plugins"]\')');
        await page.click('[data-testid="settings-tab-button-plugins"]');
        await d.settleDom(page, 'document.querySelector(' + quote(revisions + ' button[aria-expanded]') + ')');
        if (await page.eval('document.querySelector(' + quote(revisions + ' button[aria-expanded]') + ').getAttribute("aria-expanded") !== "true"')) await page.click(revisions + ' button[aria-expanded]');
        const blockedRow = revisions + ' [data-plugin-revision="' + packed.revision + '"]';
        rec.check('Settings explains and disables a revision that cannot read newer saved state', await d.settleDom(page, 'document.querySelector(' + quote(blockedRow + ' button') + ')?.disabled && document.querySelector(' + quote(blockedRow) + ').textContent.includes("state version 2")'));
        await page.eval('document.querySelector(' + quote(blockedRow) + ').scrollIntoView({block:"center"})');
        await rec.shot(page, '03-blocked-state-rollback');
        await page.click('[data-testid="settings-close"]');
        await retained('refused state rollback leaves the native sessions intact');
        fs.writeFileSync(path.join(rec.outDir, 'authoring-evidence.json'), JSON.stringify({ first: packed.revision, updated, history, events: events(), terminalPID: pid, nativePage: native.identity, editorPaneID }, null, 2) + '\n');
        const files = ['packages/cli/dist/kelpi.js', 'packages/daemon/dist/kelpid.js', 'packages/daemon/dist/runner.mjs', 'packages/shell/dist/main.js', 'packages/client/dist/index.html', 'scripts/scenarios/plugin-authoring.mjs', 'scripts/fixtures/plugin-browser.mjs', 'scripts/fixtures/plugin-terminal.cjs',
            ...fs.readdirSync(path.join(repoRoot, 'packages/client/dist/assets')).filter(name => /\.(js|css)$/.test(name)).map(name => 'packages/client/dist/assets/' + name)];
        fs.writeFileSync(path.join(rec.outDir, 'build-manifest.json'), JSON.stringify(Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repoRoot, file))).digest('hex')])), null, 2) + '\n');
    } finally {
        await stopDev();
        native?.close();
        await fixture.close();
        if (workspace) await cli.run(['workspace', 'delete', workspace.workspace_id]);
        await cli.run(['plugin', 'remove', pluginID]);
        for (const [file, contents] of editorProfiles) {
            if (contents === null) fs.rmSync(file, { force: true });
            else fs.writeFileSync(file, contents);
        }
        fs.rmSync(external, { recursive: true, force: true });
    }
}
