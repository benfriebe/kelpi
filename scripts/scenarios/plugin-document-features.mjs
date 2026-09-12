import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';
import { daemonIDFromSandbox, phoneToLanding, restoreBundledSlots } from '../ui-audit/lib/workbench.mjs';

export const covers = ['examples/plugins/document-lab/', 'packages/plugin-sdk/', 'packages/client/src/features/',
    'packages/client/src/plugins/', 'packages/client/src/content/', 'packages/client/src/app/RemoteWorkspaceView.tsx',
    'packages/client/src/phone/PhoneRemoteWorkspace.tsx', 'packages/client/src/App.tsx', 'packages/daemon/src/plugins/documents.ts'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginID = 'example.document-lab', viewID = `${pluginID}.editor`, packagePath = path.join(repoRoot, 'examples/plugins/document-lab');
const frame = id => `[data-testid="plugin-view-${id}"] iframe`;

export default async function ({ page, cli, sandbox, rec, d }) {
    await page.watchFrames();
    const json = async (args, opts) => JSON.parse(await cli.ok(args, opts));
    const originalURL = await page.eval('location.href'), config = fs.readFileSync(sandbox.configPath, 'utf8');
    const initial = new Set((await json(['workspace', 'list', '--json'])).map(workspace => workspace.id));
    const inside = (id, expression) => page.evalInFrame(frame(id), expression);
    const check = (id, expression, ceilingMs = 12_000) => d.settle(async () => {
        try { return await inside(id, expression); } catch { return false; }
    }, { ceilingMs });
    const ready = id => check(id, `document.body.dataset.ready === 'true'`);
    const choose = async (id, kind, choice = viewID) => {
        const selector = `[data-document-pane="${id}"] select[aria-label="${kind} renderer"]`;
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(selector)})`)) throw new Error(`Missing ${kind} renderer selector`);
        await page.eval(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(choice)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    };
    const click = async (id, target) => {
        if (!await check(id, `(() => { const element = document.querySelector(${JSON.stringify(target)}); return element && !element.disabled && !element.hidden && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0; })()`)) throw new Error(`Missing, hidden or disabled ${target}`);
        // An OOPIF can expose its new DOM geometry before Chromium routes input to its
        // surface, especially after mode changes/reloads in the hidden lane. Observe a
        // trusted pointer move reaching the target before issuing the single real click.
        await inside(id, `(() => {
            const element = document.querySelector(${JSON.stringify(target)});
            element.scrollIntoView({block:'nearest',inline:'nearest'});
            const observed = globalThis.__documentScenarioPointer = {};
            const move = event => { observed.reached = event.isTrusted && element.contains(event.target); observed.x = event.clientX; observed.y = event.clientY; };
            document.addEventListener('pointermove', move, true);
            observed.stop = () => document.removeEventListener('pointermove', move, true);
        })()`);
        try {
            let point;
            if (!await d.settle(async () => {
                const inner = await inside(id, `(() => { const box = document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return {x:box.x+box.width/2,y:box.y+box.height/2}; })()`);
                const outer = await page.box(frame(id));
                point = { x: outer.x + inner.x, y: outer.y + inner.y };
                await page.mouse('mouseMoved', point.x, point.y, { button: 'none', buttons: 0 });
                return await inside(id, `(() => { const seen = globalThis.__documentScenarioPointer; return seen.reached && Math.abs(seen.x - ${inner.x}) < 1 && Math.abs(seen.y - ${inner.y}) < 1; })()`);
            }, { ceilingMs: 5_000 })) throw new Error(`Pointer did not reach ${target}`);
            await page.clickAt(point.x, point.y);
        } finally { await inside(id, `globalThis.__documentScenarioPointer?.stop()`).catch(() => {}); }
    };
    const type = async (id, text) => {
        await click(id, '#editor');
        if (!await check(id, `document.activeElement === document.getElementById('editor')`)) throw new Error(`Editor did not receive keyboard focus: ${JSON.stringify(await inside(id, `({active:document.activeElement?.tagName, body:{...document.body.dataset}, value:document.getElementById('editor').value})`))}`);
        // CDP needs the platform edit command as well as the chord to select textarea text.
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4 });
        await page.insertText(text);
        if (!await check(id, `document.getElementById('editor').value === ${JSON.stringify(text)}`)) throw new Error(`Keyboard edit did not reach textarea: ${JSON.stringify(await inside(id, `({active:document.activeElement?.tagName, body:document.body.dataset, value:document.getElementById('editor').value})`))}`);
    };
    const snapshot = id => json(['document', 'get', id]);
    const savedText = (id, text) => d.settle(async () => { const state = await snapshot(id); return state.text === text && !state.dirty; });
    let remote = null, remoteDaemon = null, watcher = null;
    try {
        const directory = path.join(sandbox.root, 'document-repository'); fs.mkdirSync(directory); const repository = fs.realpathSync(directory);
        const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        git(['init', '--initial-branch=main']); const markdownFile = path.join(repository, 'notes.md');
        fs.writeFileSync(markdownFile, '# Document Lab\n\nOriginal text\n'); git(['add', '.']);
        git(['-c', 'user.name=Kelpi Scenario', '-c', 'user.email=scenario@localhost', 'commit', '-m', 'Private fixture']);
        fs.appendFileSync(markdownFile, '\nDiff fixture\n');
        const workspace = await json(['workspace', 'create', '--name', 'Document Lab', '--path', repository, '--json']);
        const workspaceID = workspace.workspace_id;
        const panes = () => json(['pane', 'list', '--workspace', workspaceID, '--json']);
        const terminal = (await panes())[0].id;
        await cli.ok(['open', markdownFile], { cwd: repository, paneID: terminal });
        await cli.ok(['diff'], { cwd: repository, paneID: terminal });
        let markdown, diff;
        if (!await d.settle(async () => { const rows = await panes(); markdown = rows.find(pane => pane.type === 'markdown'); diff = rows.find(pane => pane.type === 'diff'); return markdown && diff; })) throw new Error('Documents did not open');
        await cli.ok(['plugin', 'install', packagePath, '--trust']);
        rec.note('Selecting Markdown renderer'); await choose(markdown.id, 'markdown');
        if (!await ready(markdown.id)) throw new Error('Markdown renderer failed to attach');
        rec.check('native markdown attaches to a real isolated SDK-only renderer', await inside(markdown.id, `(() => { try { parent.document.body; return false; } catch { return true; } })()`) && (await json(['plugin', 'list', '--json'])).find(plugin => plugin.manifest.id === pluginID).manifest.backend === undefined);
        rec.check('replacement markdown reads the existing file and preserves pane identity', await check(markdown.id, `document.getElementById('preview').textContent.includes('Original text')`) && (await panes()).find(pane => pane.id === markdown.id).type === 'markdown');
        rec.check('other document types retain their native renderer', await page.eval(`document.querySelector('[data-document-pane="${diff.id}"]').dataset.documentRenderer === 'kelpi.diff'`));
        const created = await inside(markdown.id, `kelpi.panes.scratchpad(${JSON.stringify(workspaceID)})`);
        const scratch = created.paneID;
        await cli.ok(['pane', 'close', '--target', terminal]);
        await choose(scratch, 'scratchpad'); await choose(diff.id, 'diff');
        if (!await ready(scratch) || !await ready(diff.id)) throw new Error('Scratchpad/diff renderer failed to attach');
        rec.check('diff exposes raw source and remains read-only', await check(diff.id, `document.getElementById('preview').textContent.includes('+Diff fixture') && document.getElementById('editor').hidden && document.getElementById('save').disabled`));
        rec.check('SDK discovery includes three independently selectable document placements', await inside(markdown.id, `(async () => { const workbench = await kelpi.ui.getWorkbench(); return ['document.markdown','document.scratchpad','document.diff'].every(id => workbench.slots.find(slot => slot.id === id)?.viewID === '${viewID}'); })()`));

        await click(markdown.id, '#mode');
        if (!await check(markdown.id, `!document.getElementById('editor').hidden`)) throw new Error('Markdown did not enter edit mode');
        await type(markdown.id, '# Edited by a plugin\n\nSaved through the daemon.\n');
        rec.check('replacement edits autosave through the native file buffer', await savedText(markdown.id, '# Edited by a plugin\n\nSaved through the daemon.\n') && fs.readFileSync(markdownFile, 'utf8').includes('Saved through the daemon.'));
        await choose(markdown.id, 'markdown', 'kelpi.markdown');
        rec.check('switching back preserves the native edit mode and exact text', await d.settleDom(page, `document.querySelector('[data-document-pane="${markdown.id}"] textarea')?.value.includes('Saved through the daemon.')`));
        await choose(markdown.id, 'markdown'); if (!await ready(markdown.id)) throw new Error('Reselected markdown did not attach');
        await click(markdown.id, '#mode');
        rec.check('preview mode survives renderer changes', await check(markdown.id, `!document.getElementById('preview').hidden && document.getElementById('preview').textContent.includes('Edited by a plugin')`));

        await inside(scratch, `(() => { const editor = document.getElementById('editor'); for (let i = 1; i <= 24; i++) { editor.value = 'Rapid input ' + i; editor.dispatchEvent(new Event('input', {bubbles:true})); } })()`);
        rec.check('rapid input preserves the newest draft through serialized revision checks', await savedText(scratch, 'Rapid input 24') && await check(scratch, `document.body.dataset.pending === 'false' && !document.body.dataset.error`));
        const watched = []; let streamBuffer = '';
        watcher = spawn(process.execPath, [path.join(repoRoot, 'packages/cli/dist/kelpi.js'), 'document', 'watch', scratch], {
            env: { PATH: sandbox.env.PATH, HOME: sandbox.home, KELPI_SOCKET: `tcp:127.0.0.1:${sandbox.controlPort}`, KELPI_REQUIRE_SOCKET: '1' }, stdio: ['ignore', 'pipe', 'pipe']
        });
        watcher.stdout.on('data', chunk => {
            streamBuffer += chunk.toString(); let index;
            while ((index = streamBuffer.indexOf('\n')) >= 0) { const line = streamBuffer.slice(0, index); streamBuffer = streamBuffer.slice(index + 1); if (line) watched.push(JSON.parse(line)); }
        });
        if (!await d.settle(() => watched.some(reply => reply.result?.text === 'Rapid input 24'))) throw new Error('CLI document watch did not send initial state');
        const streamed = await snapshot(scratch);
        await json(['document', 'edit', scratch, '--revision', streamed.revision, '--text', 'Streamed edit']);
        rec.check('CLI watch streams initial and subsequently saved source snapshots', await d.settle(() => watched.some(reply => reply.result?.text === 'Streamed edit')));
        watcher.kill('SIGTERM'); watcher = null;
        await click(scratch, '#wrap');
        await cli.ok(['plugin', 'reload', pluginID]); if (!await ready(scratch)) throw new Error('Reload did not attach');
        rec.check('renderer UI state persists independently of native document source', await check(scratch, `document.getElementById('wrap').getAttribute('aria-pressed') === 'false' && document.getElementById('editor').value === 'Streamed edit'`));

        const previous = await snapshot(scratch);
        const winner = await json(['document', 'edit', scratch, '--revision', previous.revision, '--text', 'Concurrent CLI winner']);
        const loser = await cli.run(['document', 'edit', scratch, '--revision', previous.revision, '--text', 'Stale overwrite']);
        rec.check('CLI revisions reject stale edits without replacing the winner', loser.code !== 0 && `${loser.stdout}${loser.stderr}`.includes('DOCUMENT_CONFLICT') && (await snapshot(scratch)).text === winner.text);
        await savedText(scratch, winner.text);
        const rejected = await inside(scratch, `(async () => { const draft = await kelpi.documents.stage('Recover this rejected draft', ${JSON.stringify(previous.revision)}); return kelpi.documents.applyDraft(draft.id, ${JSON.stringify(previous.revision)}).then(() => false, error => error.code === 'DOCUMENT_CONFLICT'); })()`);
        rec.check('browser conflict reports a typed error and preserves the rejected input outside the iframe', rejected && await d.settleDom(page, `document.querySelector('[data-testid="document-recovery-${scratch}"]')`));
        const refused = await inside(scratch, `kelpi.panes.close({paneID:${JSON.stringify(scratch)}}).then(() => false, error => error.message.includes('unapplied'))`);
        rec.check('closing through the SDK refuses to orphan an unapplied draft', refused && (await panes()).some(pane => pane.id === scratch));
        await inside(scratch, `setTimeout(() => { throw new Error('Scenario renderer failure'); }, 0); true`);
        rec.check('a failed renderer falls back to the bundled editor with recovery controls', await d.settleDom(page, `document.querySelector('[data-document-pane="${scratch}"]').dataset.documentRenderer === 'kelpi.scratchpad' && document.querySelector('[data-testid="document-recovery-${scratch}"]')`));
        await page.click(`[data-testid="document-recovery-${scratch}"] button`);
        rec.check('the recovery review retains the exact rejected text', await page.eval(`document.querySelector('[data-testid="document-recovery-${scratch}"] textarea').value === 'Recover this rejected draft'`));
        await page.send('Page.reload'); if (!await ready(scratch)) throw new Error('Window reload did not restore renderer');
        rec.check('window reload preserves both renderer choice and the recovery draft', await d.settleDom(page, `document.querySelector('[data-testid="document-recovery-${scratch}"]')`));
        await page.eval(`document.querySelectorAll('[data-testid="document-recovery-${scratch}"] button')[1].click()`);
        rec.check('explicit recovery restores and saves through a fresh guarded revision', await savedText(scratch, 'Recover this rejected draft') && await d.settleDom(page, `!document.querySelector('[data-testid="document-recovery-${scratch}"]')`));

        await click(markdown.id, '#mode');
        const held = `${repository}-held`; fs.renameSync(repository, held);
        try {
            await type(markdown.id, '# Keep these unsaved changes\n');
            if (!await d.settle(async () => (await snapshot(markdown.id)).error)) throw new Error('Expected failed disk save');
            const failedClose = await cli.run(['pane', 'close', '--target', markdown.id]);
            rec.check('failed disk saves retain the buffer and refuse CLI close', failedClose.code !== 0 && (await snapshot(markdown.id)).text === '# Keep these unsaved changes\n');
        } finally { fs.renameSync(held, repository); }
        const dirty = await snapshot(markdown.id);
        await json(['document', 'save', markdown.id, '--revision', dirty.revision]);
        rec.check('repairing storage permits an explicit save of the retained buffer', fs.readFileSync(markdownFile, 'utf8') === '# Keep these unsaved changes\n');

        rec.note('Validating remote document ownership');
        remote = await makeSandbox(repoRoot, { label: 'document-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
        remoteDaemon = startDaemon(remote, { repoRoot }); await waitForHealthz(remote.base);
        const remoteCLI = makeCli(remote, { repoRoot });
        await remoteCLI.ok(['plugin', 'install', packagePath, '--trust']);
        const remoteWorkspace = JSON.parse(await remoteCLI.ok(['workspace', 'create', '--name', 'Remote Documents', '--json']));
        const remoteTerminal = JSON.parse(await remoteCLI.ok(['pane', 'list', '--workspace', remoteWorkspace.workspace_id, '--json']))[0].id;
        const remoteFile = path.join(remote.root, 'remote.md'); fs.writeFileSync(remoteFile, '# Remote document\n');
        await remoteCLI.ok(['open', remoteFile], { paneID: remoteTerminal });
        let remotePane;
        await d.settle(async () => { remotePane = JSON.parse(await remoteCLI.ok(['pane', 'list', '--workspace', remoteWorkspace.workspace_id, '--json'])).find(pane => pane.type === 'markdown'); return remotePane; });
        const remoteToken = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        fs.writeFileSync(sandbox.configPath, `${config}\nremote-daemon = DocumentRemote:${remote.base}/?token=${remoteToken}\n`);
        if (!await check(scratch, `(async () => (await kelpi.ui.getNavigation()).hosts.some(host => host.name === 'DocumentRemote' && host.connection === 'connected'))()`)) throw new Error('Remote did not connect');
        await inside(scratch, `void (async () => { const navigation = await kelpi.ui.getNavigation(); await kelpi.ui.selectWorkspace(navigation.hosts.find(host => host.name === 'DocumentRemote').id, '${remoteWorkspace.workspace_id}'); })(); true`);
        rec.check('remote native documents render through their owning runtime', await d.settleDom(page, `document.querySelector('[data-document-pane="${remotePane.id}"]')?.dataset.documentRenderer === 'kelpi.markdown'`));
        await choose(remotePane.id, 'markdown');
        if (!await ready(remotePane.id)) throw new Error('Remote replacement did not attach');
        await click(remotePane.id, '#mode'); await type(remotePane.id, '# Changed on the remote\n');
        rec.check('embedded remote renderer edits only its remote file', await check(remotePane.id, `document.getElementById('status').textContent === 'Saved'`) && fs.readFileSync(remoteFile, 'utf8') === '# Changed on the remote\n' && fs.readFileSync(markdownFile, 'utf8') === '# Keep these unsaved changes\n');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${remoteWorkspace.workspace_id}"]`;
        if (await d.settleDom(page, `document.querySelector(${JSON.stringify(phoneRow)})`)) await page.click(phoneRow);
        await page.click('[data-testid="phone-title"]');
        await d.settleDom(page, `document.querySelector('[data-testid="phone-pane-show-${remotePane.id}"]')`);
        await page.click(`[data-testid="phone-pane-show-${remotePane.id}"]`);
        rec.check('phone single-pane view mounts the same remote document renderer', await ready(remotePane.id) && await check(remotePane.id, `document.getElementById('editor').value === ${JSON.stringify('# Changed on the remote\n')}`));
        rec.check('document controls fit the phone viewport', await check(remotePane.id, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
        await rec.shot(page, 'document-phone-ready');
        // Back to the landing page BEFORE the window widens again, while the shell is still mounted.
        if (!await phoneToLanding(page, d)) rec.note('the phone shell did not return to its landing page; the next phone scenario may open where this one left it');
        await page.send('Emulation.clearDeviceMetricsOverride'); await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        const beforeRestart = JSON.parse(await remoteCLI.ok(['document', 'get', remotePane.id]));
        await remoteDaemon.stop(); remoteDaemon = startDaemon(remote, { repoRoot }); await waitForHealthz(remote.base);
        const obsolete = await remoteCLI.run(['document', 'edit', remotePane.id, '--revision', beforeRestart.revision, '--text', 'Obsolete write']);
        rec.check('daemon restart restores saved documents and invalidates old revision tokens', obsolete.code !== 0 && `${obsolete.stdout}${obsolete.stderr}`.includes('DOCUMENT_CONFLICT') && await ready(remotePane.id) && await check(remotePane.id, `document.getElementById('editor').value === ${JSON.stringify('# Changed on the remote\n')}`));
        await page.send('Page.navigate', { url: `${remote.base}/?token=${remoteToken}` });
        await choose(remotePane.id, 'markdown');
        rec.check('direct browser attachment supports its own document preference', await ready(remotePane.id));
        await page.send('Page.navigate', { url: originalURL }); if (!await ready(scratch)) throw new Error('Primary document did not restore');
        const ids = (await panes()).map(pane => pane.id).sort();
        await cli.ok(['plugin', 'disable', pluginID]);
        rec.check('disable restores all native documents without replacing panes', await d.settleDom(page, `!document.querySelector('[data-document-renderer="${viewID}"]')`) && JSON.stringify((await panes()).map(pane => pane.id).sort()) === JSON.stringify(ids));
        await cli.ok(['plugin', 'enable', pluginID]); rec.check('reenabling restores saved per-type renderer choices', await ready(scratch) && await ready(markdown.id) && await ready(diff.id));
        await rec.shot(page, 'document-lab-ready');
    } catch (error) { await rec.shot(page, 'failure-live'); throw error; }
    finally {
        watcher?.kill('SIGTERM');
        fs.writeFileSync(sandbox.configPath, config);
        await page.send('Emulation.clearDeviceMetricsOverride'); await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        try { if (!await phoneToLanding(page, d)) rec.note('cleanup: the phone shell never reached its landing page'); } catch { /* the window may be mid-navigation */ }
        await page.send('Page.navigate', { url: originalURL }).catch(() => {});
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 20_000 }).catch(() => {});
        // The three document slots are the WINDOW's and outlive `plugin remove` (#205, #201).
        try {
            const restored = await restoreBundledSlots(page, d, { 'document.markdown': 'kelpi.markdown', 'document.scratchpad': 'kelpi.scratchpad', 'document.diff': 'kelpi.diff' }, { daemonID: daemonIDFromSandbox(sandbox) });
            if (!restored.ok) rec.note(`cleanup: the document placements were not restored — ${String(restored.detail)}`);
            if (restored.others !== null) rec.note(`cleanup: a stopped daemon's store still holds ${String(restored.others)}`);
        } catch (error) {
            rec.note(`cleanup: the document placements were not restored — ${error instanceof Error ? error.message : String(error)}`);
        }
        await cli.run(['plugin', 'remove', pluginID]);
        for (const workspace of await json(['workspace', 'list', '--json'])) if (!initial.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        if (remoteDaemon) await remoteDaemon.stop(); remote?.cleanup();
    }
}
