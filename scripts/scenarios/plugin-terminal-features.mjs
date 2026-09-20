import fs from 'node:fs';
import { armIncidentDiagnostics, redactFixtureText, removeOwnedRemoteStore } from '../ui-audit/lib/incident-diagnostics.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildBoundTerminalLab } from '../ui-audit/lib/incident-diagnostics-runtime.mjs';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';
import { daemonIDFromSandbox, phoneToLanding, restoreBundledSlots } from '../ui-audit/lib/workbench.mjs';

export const covers = ['examples/plugins/terminal-lab/', 'packages/plugin-sdk/', 'packages/client/src/features/',
    'packages/client/src/plugins/', 'packages/client/src/connection/pty.ts', 'packages/client/src/terminal/',
    'packages/client/src/phone/', 'packages/client/src/App.tsx', 'packages/client/src/app/RemoteWorkspaceView.tsx'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginID = 'example.terminal-lab', viewID = `${pluginID}.terminal`;
const fixture = path.join(repoRoot, 'scripts/fixtures/plugin-terminal.cjs');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const frame = id => `[data-testid="plugin-view-${id}"] iframe`;
const normal = value => value.replaceAll('\r', '').split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
const ptyFrame = (type, paneID, payload) => Buffer.concat([Buffer.from([type]), Buffer.from(paneID.replaceAll('-', ''), 'hex'), payload]);

export default async function ({ page, cli, sandbox, rec, d, harness, sleep, diagnosticsProvenance }) {
    await page.watchFrames();
    const {packagePath,bindExecution} = await buildBoundTerminalLab(repoRoot,{rec,diagnosticsProvenance});
    const originalURL = await page.eval('location.href');
    const originalAgent = await page.eval('({ userAgent: navigator.userAgent, platform: navigator.platform })');
    const originalConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const originalClipboard = String((await harness.clipboardRead()).text);
    const json = async (args, target = cli) => JSON.parse(await target.ok(args));
    const initial = new Set((await json(['workspace', 'list', '--json'])).map(item => item.id));
    const fixtures = [];
    const wire = { outputFrames: 0, outputBytes: 0, replayFrames: 0, replayBytes: 0, ackFrames: 0, ackBytes: 0, resyncs: 0 };
    await page.send('Network.enable');
    const offWire = [page.on('Network.webSocketFrameReceived', ({ response }) => {
        if (response.opcode === 1) { try { if (JSON.parse(response.payloadData).type === 'pty-resync') wire.resyncs++; } catch {} return; }
        if (response.opcode !== 2) return;
        const data = Buffer.from(response.payloadData, 'base64');
        if (data[0] === 1) { wire.outputFrames++; wire.outputBytes += data.length - 17; }
        if (data[0] === 5) { wire.replayFrames++; wire.replayBytes += data.length - 17; }
    }), page.on('Network.webSocketFrameSent', ({ response }) => {
        if (response.opcode !== 2) return;
        const data = Buffer.from(response.payloadData, 'base64');
        if (data[0] === 3 && data.length === 21) { wire.ackFrames++; wire.ackBytes += data.readUInt32BE(17); }
    })];
    const inside = (id, expression) => page.evalInFrame(frame(id), expression);
    const check = (id, expression, ceilingMs = 15_000) => d.settle(async () => {
        try { return await inside(id, expression); } catch { return false; }
    }, { ceilingMs });
    const ready = id => check(id, `document.body.dataset.ready === 'true' && !!globalThis.terminalLab?.session`);
    const native = id => d.settleDom(page, `document.querySelector('[data-terminal-pane="${id}"]')?.dataset.terminalRenderer === 'kelpi.shell' && document.querySelector('[data-terminal-pane="${id}"] [data-terminal-status="live"]')`);
    const choose = async (id, selected = viewID) => {
        const selector = `[data-terminal-pane="${id}"] select[aria-label="Terminal renderer"]`;
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(selector)})`)) throw new Error('Terminal renderer selector is missing');
        await page.eval(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(selected)}; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    };
    const text = id => inside(id, `(() => { const t = terminalLab.terminal, b = t.buffer.active; return Array.from({length:t.rows}, (_, i) => b.getLine(b.baseY+i)?.translateToString(true) ?? '').join(String.fromCharCode(10)); })()`);
    const sameScreen = async (item, label) => {
        let last;
        const equal = await d.settle(async () => {
            try { const server = normal(await item.cli.ok(['pane', 'capture', '--target', item.paneID])); const client = normal(await text(item.paneID)); last = { server: server.slice(-1800), client: client.slice(-1800) }; return client === server && client.includes(label); } catch (error) { last = { error: error.message }; return false; }
        }, { ceilingMs: 20_000 });
        if (!equal) rec.note(`Viewport mismatch: ${JSON.stringify(last)}`);
        return equal;
    };
    const state = item => { try { return JSON.parse(fs.readFileSync(path.join(item.root, 'state.json'), 'utf8')); } catch { return null; } };
    const input = item => fs.readFileSync(path.join(item.root, 'input.bin'));
    const alive = item => {
        try { process.kill(item.pid, 0); return state(item)?.pid === item.pid && Number(fs.readFileSync(path.join(item.root, 'pid'), 'utf8')) === item.pid; } catch { return false; }
    };
    const control = async (item, value) => {
        const sequence = (state(item)?.sequence ?? 0) + 1;
        const file = path.join(item.root, 'command.json');
        fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...value, sequence })); fs.renameSync(`${file}.tmp`, file);
        if (!await d.settle(() => state(item)?.sequence === sequence)) throw new Error('Private terminal fixture did not accept control');
        return sequence;
    };
    const completed = (item, sequence) => d.settle(() => state(item)?.sequence === sequence && !state(item)?.busy, { ceilingMs: 30_000 });
    const launch = async (target, root, workspaceID, paneID) => {
        fs.mkdirSync(root, { recursive: true });
        await target.ok(['pane', 'send', '--target', paneID, `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(root)}`]);
        const item = { cli: target, root, workspaceID, paneID, pid: 0 };
        if (!await d.settle(() => state(item)?.pid > 0)) throw new Error('Private raw terminal fixture did not start');
        item.pid = state(item).pid;
        fixtures.push(item);
        return item;
    };
    const create = async (target, root, name) => {
        const created = await json(['workspace', 'create', '--name', name, '--json'], target);
        const panes = await json(['pane', 'list', '--workspace', created.workspace_id, '--json'], target);
        return launch(target, root, created.workspace_id, panes[0].id);
    };
    const point = async (id, x = 35, y = 30) => { const box = await page.box(frame(id)); return { x: box.x + x, y: box.y + y }; };
    const focus = async id => {
        const focused = await d.settle(async () => {
            try { const p = await point(id); await page.clickAt(p.x, p.y); return await inside(id, `document.activeElement === terminalLab.terminal.textarea`); } catch { return false; }
        }, { ceilingMs: 5000 });
        if (!focused) throw new Error('Real pointer input did not focus Terminal Lab');
    };
    // Read host and renderer focus without repairing either before the first clipboard input.
    const caretProbe = id => () => inside(id, `document.activeElement === terminalLab.terminal.textarea`);
    const caretNow = async id => JSON.stringify(await d.caretNow(page, id, { onTheRenderer: caretProbe(id) }));
    const clipboardCaret = async (label, id) =>
        JSON.stringify(
            await d.clipboardCaret(page, harness, id, {
                label,
                note: message => rec.note(message),
                onTheRenderer: caretProbe(id)
            })
        );
    const selectWorkspace = (id, workspaceID, hostName) => inside(id, `void (async () => { const navigation = await kelpi.ui.getNavigation(); const host = navigation.hosts.find(host => ${hostName ? `host.name === ${JSON.stringify(hostName)}` : `host.kind === 'local'`}); await kelpi.ui.selectWorkspace(host.id, ${JSON.stringify(workspaceID)}); })(); true`);
    const diagnostics = async label => {
        const items = [];
        for (const item of fixtures) {
            const renderer = await inside(item.paneID, `({ session: terminalLab.session.id, presentation: terminalLab.presentation, modes: terminalLab.modes, modifiers: terminalLab.modifiers, frameCount: terminalLab.frameCount, replayCount: terminalLab.replayCount, revealCount: terminalLab.revealCount, resync: document.body.dataset.resync, rows: terminalLab.terminal.rows, cols: terminalLab.terminal.cols, selection: terminalLab.terminal.getSelection(), focused: document.activeElement === terminalLab.terminal.textarea })`).catch(error => ({ unavailable: error.message }));
            if (typeof renderer.selection === 'string') renderer.selection = redactFixtureText(renderer.selection, ['KELPI']);
            const bytes = input(item);
            items.push({ paneID: item.paneID, workspaceID: item.workspaceID, state: state(item), alive: alive(item), inputBytes: bytes.length, inputSha256: createHash('sha256').update(bytes).digest('hex'), renderer });
        }
        const host = await page.eval(`({ focused: document.hasFocus(), terminals: Array.from(document.querySelectorAll('[data-terminal-pane]'), element => ({paneID:element.dataset.terminalPane, renderer:element.dataset.terminalRenderer})) })`).catch(error => ({ unavailable: error.message }));
        fs.writeFileSync(path.join(rec.outDir, `${label}-diagnostics.json`), JSON.stringify({ wire, items, host }, null, 2) + '\n');
    };
    let remoteSandbox, remoteDaemon, local, sizeObserver, incident;
    try {
        incident = await armIncidentDiagnostics({ page, harness, rec, allowed: ['TERMINAL-PASTE-α', 'COPY-SENTINEL', 'KELPI', 'REMOTE-PASTE-β', 'REMOTE-COPY-SENTINEL', 'NON-MAC-COPY-SENTINEL', 'CLEARED-SELECTION'] });
        rec.note('Attaching an SDK-only terminal renderer to a persistent full-screen process');
        local = await create(cli, path.join(sandbox.root, 'terminal-fixture'), 'Terminal Lab');
        bindExecution('local-plugin-install');
        await cli.ok(['plugin', 'install', packagePath, '--trust']);
        await choose(local.paneID);
        if (!await ready(local.paneID)) throw new Error('Terminal Lab failed to consume its initial replay');
        rec.check('isolated SDK-only terminal attaches to the existing full-screen process', alive(local) && await inside(local.paneID, `(() => { try { parent.document.body; return false; } catch { return true; } })()`) && !(await json(['plugin', 'list', '--json'])).find(item => item.manifest.id === pluginID).manifest.backend);
        rec.check('ANSI and Unicode viewport agrees exactly with daemon capture', await sameScreen(local, 'READY'));
        rec.check('application terminal modes cross the renderer bridge', await check(local.paneID, `terminalLab.modes.bracketedPaste && terminalLab.modes.applicationCursorKeys && terminalLab.modes.mouseTracking === 'drag' && terminalLab.modes.mouseFormat === 'sgr'`));
        await incident.addRenderer('local terminal', expression => inside(local.paneID, expression), () => page.eval(`!!document.querySelector(${JSON.stringify(frame(local.paneID))})`));
        await focus(local.paneID);
        let offset = input(local).length;
        await page.key('KeyK', { key: 'k', text: 'k', keyCode: 75 });
        await page.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
        await page.insertText('日本語');
        rec.check('CDP keyboard and injected composition commit reach the same raw process', await d.settle(() => input(local).subarray(offset).includes(Buffer.from('k')) && input(local).subarray(offset).includes(Buffer.from('日本語'))));
        offset = input(local).length;
        await harness.clipboardWrite('TERMINAL-PASTE-α');
        await clipboardCaret('platform paste', local.paneID);
        let caret = await caretNow(local.paneID);
        await page.key('KeyV', { key: 'v', modifiers: d.MOD.meta });
        rec.check('platform paste preserves the application bracketed-paste envelope', await d.settle(() => input(local).subarray(offset).includes(Buffer.from('\x1b[200~TERMINAL-PASTE-α\x1b[201~'))), `${JSON.stringify(redactFixtureText(input(local).subarray(offset).toString(), ['\x1b[200~TERMINAL-PASTE-α\x1b[201~']))} · at the press ${caret}`);
        // Observe the caret without repair; selection and first input remain the operation under test.
        await clipboardCaret('platform Copy', local.paneID);
        await inside(local.paneID, `terminalLab.terminal.select(0, 0, 5); true`);
        await harness.clipboardWrite('COPY-SENTINEL');
        caret = await caretNow(local.paneID);
        await page.key('KeyC', { key: 'c', modifiers: d.MOD.meta });
        rec.check('platform Copy obtains live renderer selection', await d.settle(async () => String((await harness.clipboardRead()).text) === 'KELPI'), `clipboard holds [see redacted incident evidence] · at the press ${caret}`);
        await clipboardCaret('cleared-selection Copy', local.paneID);
        await inside(local.paneID, `terminalLab.terminal.clearSelection(); true`);
        await harness.clipboardWrite('CLEARED-SELECTION');
        caret = await caretNow(local.paneID);
        await page.key('KeyC', { key: 'c', modifiers: d.MOD.meta }); await sleep(120);
        rec.check('cleared selection cannot copy a stale cached value', String((await harness.clipboardRead()).text) === 'CLEARED-SELECTION', `at the press ${caret}`);

        await incident.retireRenderer('local terminal');
        await choose(local.paneID, 'kelpi.shell');
        rec.check('returning to the bundled renderer preserves pane and operating-system PID', await native(local.paneID) && alive(local) && (await json(['pane', 'list', '--workspace', local.workspaceID, '--json'])).some(pane => pane.id === local.paneID));
        await choose(local.paneID); if (!await ready(local.paneID)) throw new Error('Terminal Lab did not reattach');
        let sequence = await control(local, { op: 'burst', bytes: 4 * 1024 * 1024, label: 'FOUR-MIB-COMPLETE' });
        rec.check('four MiB of live ANSI and Unicode output converges without display corruption', await completed(local, sequence) && await sameScreen(local, 'FOUR-MIB-COMPLETE'));
        await inside(local.paneID, `(() => { const t = terminalLab.terminal; globalThis.__terminalScenarioWrite = t.write; t.write = function(data, done) { return globalThis.__terminalScenarioWrite.call(this, data, () => setTimeout(done, 80)); }; })()`);
        let resynced = false;
        const beforeResyncs = wire.resyncs;
        try {
            sequence = await control(local, { op: 'burst', bytes: 4 * 1024 * 1024, delayMs: 1, label: 'BACKPRESSURE-COMPLETE' });
            // The host retains live bytes until the parser consumes them, including device
            // queries. Observe the native reset before removing the artificial parser delay;
            // its renderer callback correctly waits behind those retained live bytes.
            resynced = await completed(local, sequence) && await d.settle(() => wire.resyncs > beforeResyncs);
        } finally { await inside(local.paneID, `terminalLab.terminal.write = globalThis.__terminalScenarioWrite; delete globalThis.__terminalScenarioWrite; true`).catch(() => {}); }
        const recovered = resynced && await check(local.paneID, `document.body.dataset.resync === 'flow-control-drop'`) && await sameScreen(local, 'BACKPRESSURE-COMPLETE') && alive(local);
        rec.check('a slow real renderer triggers native resync and recovers an exact screen', recovered);
        await diagnostics(recovered ? 'recovered-resync' : 'stalled-resync');
        await choose(local.paneID, 'kelpi.shell'); if (!await native(local.paneID)) throw new Error('Native terminal failed to resume before burst');
        const beforeBytes = state(local).bytes;
        sequence = await control(local, { op: 'burst', bytes: 4 * 1024 * 1024, delayMs: 12, scrollback: true, label: 'SWITCH-BURST-COMPLETE' });
        if (!await d.settle(() => state(local)?.busy && state(local).bytes > beforeBytes)) throw new Error('Burst was not active before renderer switch');
        await choose(local.paneID);
        const switchedWhileBusy = state(local)?.busy;
        rec.check('switching renderers during a four MiB burst preserves process and authoritative screen', switchedWhileBusy && await ready(local.paneID) && await completed(local, sequence) && alive(local) && await sameScreen(local, 'SWITCH-BURST-COMPLETE'));
        await inside(local.paneID, `globalThis.__terminalScenarioIdentity = 'before-reload'; true`);
        await page.eval(`(() => { const input = document.createElement('input'); input.id = 'terminal-review-caret'; input.setAttribute('aria-label', 'Review caret sentinel'); document.body.append(input); input.focus(); })()`);
        await cli.ok(['plugin', 'reload', pluginID]);
        rec.check('plugin reload reattaches and replays without restarting the process', await ready(local.paneID) && await check(local.paneID, `globalThis.__terminalScenarioIdentity === undefined`) && alive(local) && await sameScreen(local, 'SWITCH-BURST-COMPLETE'));
        rec.check('delayed renderer attachment preserves an active chrome text field', await page.eval(`document.activeElement === document.getElementById('terminal-review-caret')`));
        await page.eval(`document.getElementById('terminal-review-caret').remove()`);
        await inside(local.paneID, `setTimeout(() => { throw new Error('Intentional terminal renderer failure'); }, 0); true`);
        rec.check('renderer failure activates a bundled fallback with the same process', await native(local.paneID) && alive(local));
        await page.eval(`Array.from(document.querySelectorAll('[data-terminal-pane="${local.paneID}"] button')).find(button => button.textContent === 'Retry renderer').click()`);
        rec.check('retry restores the replacement after failure', await ready(local.paneID) && await sameScreen(local, 'SWITCH-BURST-COMPLETE'));
        await inside(local.paneID, `void Promise.reject(new Error()); true`);
        rec.check('an empty renderer error still activates the bundled fallback', await native(local.paneID) && alive(local));
        await page.eval(`Array.from(document.querySelectorAll('[data-terminal-pane="${local.paneID}"] button')).find(button => button.textContent === 'Retry renderer').click()`);
        rec.check('retry restores the renderer after an empty error', await ready(local.paneID) && alive(local));

        const otherWorkspace = await json(['workspace', 'create', '--name', 'Terminal Lab Hidden Check', '--json']);
        const otherPane = (await json(['pane', 'list', '--workspace', otherWorkspace.workspace_id, '--json']))[0].id;
        if (!await ready(otherPane)) throw new Error('Other workspace renderer did not attach');
        rec.check('leaving a workspace preserves the daemon-owned process', alive(local));
        await selectWorkspace(otherPane, local.workspaceID);
        rec.check('returning to a workspace reattaches to the same process and screen', await ready(local.paneID) && alive(local) && await sameScreen(local, 'SWITCH-BURST-COMPLETE'));
        await cli.ok(['workspace', 'delete', otherWorkspace.workspace_id, '--force']);
        const beforeGrid = state(local).cols;
        await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 650, deviceScaleFactor: 1, mobile: false });
        rec.check('renderer measurements resize the existing PTY through the window connection', await d.settle(() => state(local).cols !== beforeGrid) && await sameScreen(local, 'SWITCH-BURST-COMPLETE'));
        await page.send('Emulation.clearDeviceMetricsOverride');
        const localToken = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        const observer = new WebSocket(`${sandbox.base.replace(/^http/, 'ws')}/ws?token=${localToken}`);
        sizeObserver = observer; observer.binaryType = 'arraybuffer';
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Size observer did not attach')), 10_000);
            observer.addEventListener('open', () => observer.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token: localToken, client: { kind: 'browser', name: 'terminal-size-observer' } })));
            observer.addEventListener('message', ({ data }) => {
                if (typeof data === 'string') { if (JSON.parse(data).type === 'snapshot') { clearTimeout(timeout); resolve(); } return; }
                const bytes = Buffer.from(data);
                if (bytes[0] !== 1 && bytes[0] !== 5) return;
                const ack = Buffer.alloc(4); ack.writeUInt32BE(bytes.length - 17);
                if (observer.readyState === WebSocket.OPEN) observer.send(ptyFrame(3, local.paneID, ack));
            });
            observer.addEventListener('error', error => { clearTimeout(timeout); reject(error); }, { once: true });
        });
        observer.send(JSON.stringify({ type: 'attach-pane', paneID: local.paneID, cols: 73, rows: 19 }));
        observer.send(JSON.stringify({ type: 'take-size-control' }));
        const observerGrid = Buffer.alloc(4); observerGrid.writeUInt16BE(73); observerGrid.writeUInt16BE(19, 2);
        observer.send(ptyFrame(4, local.paneID, observerGrid));
        if (!await d.settle(() => state(local).cols === 73 && state(local).rows === 19)) throw new Error('Second client did not gain native geometry ownership');
        await inside(local.paneID, `terminalLab.session.resize(51, 17); true`); await sleep(150);
        rec.check('plugin resize cannot override another native connection owning PTY geometry', state(local).cols === 73 && state(local).rows === 19 && alive(local));
        if (!await d.settleDom(page, `document.querySelector('[data-testid="take-size-control"]')`)) throw new Error('Native size control affordance did not appear');
        await page.click('[data-testid="take-size-control"]');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 650, deviceScaleFactor: 1, mobile: false });
        rec.check('native size control returns ownership to the plugin renderer window', await d.settle(() => state(local).cols !== 73 && state(local).rows !== 19) && await d.settleDom(page, `!document.querySelector('[data-testid="take-size-control"]')`) && alive(local) && await sameScreen(local, 'SWITCH-BURST-COMPLETE'));
        observer.close(); sizeObserver = null;
        await page.send('Emulation.clearDeviceMetricsOverride');
        // Delay actual parsing of a live query, then force a newer native replay while that
        // callback is still in flight. The old output's protocol reply must remain valid.
        await page.send('Network.enable');
        let resizeReplay = false;
        const offReplay = page.on('Network.webSocketFrameReceived', ({ response }) => {
            if (response.opcode !== 2) return;
            const data = Buffer.from(response.payloadData, 'base64');
            if (data[0] === 5 && data.subarray(1, 17).toString('hex') === local.paneID.replaceAll('-', '').toLowerCase()) resizeReplay = true;
        });
        await inside(local.paneID, `(() => { const t = terminalLab.terminal, write = t.write; globalThis.__terminalScenarioWrite = write; t.write = function(data, done) { const text = typeof data === 'string' ? data : new TextDecoder().decode(data); if (text.includes(String.fromCharCode(27) + '[6n')) { globalThis.__terminalScenarioQueryPending = true; return setTimeout(() => write.call(this, data, done), 1000); } return write.call(this, data, done); }; })()`);
        try {
            offset = input(local).length;
            sequence = await control(local, { op: 'query', label: 'RESIZE-QUERY-COMPLETE' });
            if (!await check(local.paneID, `globalThis.__terminalScenarioQueryPending === true`)) throw new Error('Live query did not reach the delayed parser');
            resizeReplay = false;
            await page.send('Emulation.setDeviceMetricsOverride', { width: 850, height: 630, deviceScaleFactor: 1, mobile: false });
            const supersededBeforeResponse = await d.settle(() => resizeReplay && input(local).length === offset, { ceilingMs: 800 });
            rec.check('a live query still receives its response after a newer resize replay supersedes it', supersededBeforeResponse && await d.settle(() => /\x1b\[[0-9]+;[0-9]+R/.test(input(local).subarray(offset).toString())) && alive(local));
        } finally {
            offReplay();
            await inside(local.paneID, `terminalLab.terminal.write = globalThis.__terminalScenarioWrite; delete globalThis.__terminalScenarioWrite; true`).catch(() => {});
            await page.send('Emulation.clearDeviceMetricsOverride');
        }
        let queuedQuery = false, queuedReplay = false;
        const offQueuedQuery = page.on('Network.webSocketFrameReceived', ({ response }) => {
            if (response.opcode !== 2) return;
            const data = Buffer.from(response.payloadData, 'base64');
            if (data[0] === 1 && data.subarray(17).includes(Buffer.from('\x1b[6n'))) queuedQuery = true;
            if (data[0] === 5 && queuedQuery) queuedReplay = true;
        });
        await inside(local.paneID, `(() => { const t = terminalLab.terminal, write = t.write; globalThis.__terminalScenarioWrite = write; t.write = function(data, done) { const text = typeof data === 'string' ? data : new TextDecoder().decode(data); if (text.includes('QUEUED-QUERY-BLOCKER') && !globalThis.__releaseQueuedWrite) { globalThis.__releaseQueuedWrite = () => write.call(this, data, done); return; } return write.call(this, data, done); }; })()`);
        try {
            await control(local, { op: 'paint', label: 'QUEUED-QUERY-BLOCKER' });
            if (!await check(local.paneID, `typeof globalThis.__releaseQueuedWrite === 'function'`)) throw new Error('Ordinary output did not reach the held renderer');
            offset = input(local).length;
            await control(local, { op: 'query', label: 'RESIZE-QUERY-COMPLETE' });
            if (!await d.settle(() => queuedQuery)) throw new Error('The query did not reach the host behind ordinary output');
            await page.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 640, deviceScaleFactor: 1, mobile: false });
            const superseded = await d.settle(() => queuedReplay && input(local).length === offset);
            await inside(local.paneID, `globalThis.__releaseQueuedWrite(); globalThis.__releaseQueuedWrite = true; true`);
            rec.check('a queued device query survives resize replay before its renderer callback begins', superseded && await d.settle(() => /\x1b\[[0-9]+;[0-9]+R/.test(input(local).subarray(offset).toString())) && alive(local));
        } finally {
            offQueuedQuery();
            await inside(local.paneID, `if (typeof globalThis.__releaseQueuedWrite === 'function') globalThis.__releaseQueuedWrite(); terminalLab.terminal.write = globalThis.__terminalScenarioWrite; delete globalThis.__terminalScenarioWrite; delete globalThis.__releaseQueuedWrite; true`).catch(() => {});
            await page.send('Emulation.clearDeviceMetricsOverride');
        }
        rec.note('Exercising host search through real keyboard input and repeated reveal actions');
        await focus(local.paneID);
        await page.key('KeyF', { key: 'f', modifiers: d.MOD.meta });
        const search = `[data-testid="pane-search-input-${local.paneID}"]`;
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(search)})`)) throw new Error('Native terminal search did not open from the renderer');
        await page.click(search); await page.insertText('SEARCH-ANCHOR');
        if (!await d.settleDom(page, `document.querySelector('[data-testid="pane-search-count-${local.paneID}"]')?.textContent?.includes('/1')`)) rec.note('Search counter: ' + await page.eval(`document.querySelector('[data-testid="pane-search-${local.paneID}"]')?.textContent`));
        await page.key('Enter', { key: 'Enter' });
        rec.check('native terminal search reveals and selects a plugin-rendered hit', await check(local.paneID, `terminalLab.terminal.getSelection() === 'SEARCH-ANCHOR'`));
        const reveal = await inside(local.paneID, `terminalLab.presentation.reveal?.seq`);
        await page.key('Enter', { key: 'Enter' });
        rec.check('repeating the same search hit delivers a fresh reveal action', await check(local.paneID, `terminalLab.presentation.reveal?.seq !== ${JSON.stringify(reveal)} && terminalLab.terminal.getSelection() === 'SEARCH-ANCHOR'`));
        await page.click(`[data-testid="pane-search-close-${local.paneID}"]`);

        rec.note('Local workspace/zoom eviction follows the bundled mounting policy. Remote desktop zoom keeps hidden renderers attached; remote phone mode changes reattach. Each path preserves the daemon-owned process.');
        await cli.ok(['pane', 'split', '--target', local.paneID, '--direction', 'horizontal']);
        const siblingID = (await json(['pane', 'list', '--workspace', local.workspaceID, '--json'])).find(pane => pane.id !== local.paneID).id;
        const sibling = await launch(cli, path.join(sandbox.root, 'terminal-sibling'), local.workspaceID, siblingID);
        if (!await ready(siblingID) || !await ready(local.paneID)) throw new Error('Synchronized sibling renderers did not attach');
        await inside(siblingID, `void kelpi.layout.zoom('${siblingID}'); true`);
        rec.check('local zoom follows native renderer eviction while preserving the process', await d.settleDom(page, `document.querySelector('[data-pane-id="${local.paneID}"]')?.dataset.hidden === 'true' && !document.querySelector(${JSON.stringify(frame(local.paneID))})`) && alive(local));
        await inside(siblingID, `void kelpi.layout.zoom('${siblingID}'); true`);
        rec.check('zooming out replays the original process into its original pane', await ready(local.paneID) && alive(local) && await sameScreen(local, 'RESIZE-QUERY-COMPLETE'));
        await cli.ok(['pane', 'sync', 'on', '--workspace', local.workspaceID]);
        await focus(local.paneID);
        const localOffset = input(local).length, siblingOffset = input(sibling).length;
        await page.key('KeyX', { key: 'x', text: 'x', keyCode: 88 });
        rec.check('keyboard input still mirrors to synchronized sibling processes', await d.settle(() => input(local).subarray(localOffset).includes(Buffer.from('x')) && input(sibling).subarray(siblingOffset).includes(Buffer.from('x'))));
        offset = input(local).length; const beforeMouseSibling = input(sibling).length;
        const p = await point(local.paneID, 75, 70); await page.clickAt(p.x, p.y); await sleep(150);
        rec.check('native SGR mouse reports remain direct and never mirror into a sibling', input(local).subarray(offset).toString().includes('\x1b[<') && input(sibling).length === beforeMouseSibling, JSON.stringify({ source: input(local).subarray(offset).toString(), sibling: input(sibling).subarray(beforeMouseSibling).toString() }));
        await diagnostics('synchronized-input');
        await cli.ok(['pane', 'sync', 'off', '--workspace', local.workspaceID]); await cli.ok(['pane', 'close', '--target', siblingID]);

        await incident.retireRenderer('host');
        await page.send('Page.reload');
        rec.check('window reconnect preserves the process and restores the renderer preference', await ready(local.paneID) && alive(local) && await sameScreen(local, 'RESIZE-QUERY-COMPLETE'));
        await cli.ok(['plugin', 'disable', pluginID]);
        rec.check('disabling a plugin restores the bundled renderer without closing its terminal', await native(local.paneID) && alive(local));
        await cli.ok(['plugin', 'enable', pluginID]); rec.check('reenabling restores the selected renderer', await ready(local.paneID) && alive(local));
        const editorRoot = path.join(sandbox.root, 'external-editor-fixture');
        /*
         * The SHARED `$EDITOR` path, for the reason `plugin-authoring` states in full: the daemon
         * caches its `$VISUAL`/`$EDITOR` resolution for its whole lifetime (CONT-086), so in one
         * sandbox the first scenario to open an external editor decides the command string this one
         * gets. Writing this scenario's script at that one path is what makes the cached command
         * run THIS scenario's fixture (#205).
         */
        const editorCommand = path.join(sandbox.root, 'scenario-external-editor');
        fs.writeFileSync(editorCommand, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} ${quote(editorRoot)} "$@"\n`, { mode: 0o755 });
        const exports = `export EDITOR=${quote(editorCommand)}\nexport VISUAL=${quote(editorCommand)}\n`;
        for (const profile of ['.zshenv', '.bash_profile', '.profile']) fs.appendFileSync(path.join(sandbox.home, profile), exports);
        const editorFile = path.join(sandbox.root, 'external-editor.md'); fs.writeFileSync(editorFile, '# Before the external editor\n');
        await cli.ok(['open', editorFile], { paneID: local.paneID });
        let editorPane;
        if (!await d.settle(async () => { editorPane = (await json(['pane', 'list', '--workspace', local.workspaceID, '--json'])).find(pane => pane.type === 'markdown'); return !!editorPane; })) throw new Error('External-editor document did not open');
        if (!await d.settleDom(page, `document.querySelector('[data-testid="open-external-editor-${editorPane.id}"]')`)) throw new Error('External-editor control did not appear');
        const editor = { cli, root: editorRoot, workspaceID: local.workspaceID, paneID: editorPane.id, pid: 0 };
        /*
         * Pressed until the editor is running, rather than once. The control is a button on a
         * document pane, and under a whole battery's load a press can land while the pane is still
         * re-laying-out - a toast in the corner, a frame that had not settled - and then nothing
         * runs `$EDITOR` and the wait below times out on a pane that is still a document. Pressing
         * it again is what a person does; the note says when it was needed, so a press that is
         * never enough still reads as a defect rather than as patience (#205).
         */
        let editorStarted = false;
        for (let attempt = 0; attempt < 3 && !editorStarted; attempt += 1) {
            if (attempt > 0) rec.note(`the external-editor control did not start $EDITOR; pressing it again (attempt ${String(attempt + 1)})`);
            await page.click(`[data-testid="open-external-editor-${editorPane.id}"]`);
            editorStarted = await d.settle(() => state(editor)?.pid > 0, { ceilingMs: 12_000 });
            if (!editorStarted && !await d.settleDom(page, `document.querySelector('[data-testid="open-external-editor-${editorPane.id}"]')`, { ceilingMs: 3_000 })) break;
        }
        /*
         * Split, and said out loud, because "did not attach" was two very different failures under
         * one sentence and the lane only ever showed the sentence (#205). The first half is the
         * daemon: did `$EDITOR` actually run. The second is the client: did that pane swap its
         * document view for the selected terminal renderer. The ceilings are the generous ones
         * because both legs are a real process start behind a whole battery's load, and the detail
         * carries what the pane looked like when the wait ran out.
         */
        if (!editorStarted) {
            throw new Error(`The external editor process never started after three presses: ${JSON.stringify(state(editor))}`);
        }
        if (!await ready(editor.paneID)) {
            const pane = await page.eval(`JSON.stringify({
                frame: !!document.querySelector('[data-testid="plugin-view-${editorPane.id}"] iframe'),
                terminal: document.querySelector('[data-terminal-pane="${editorPane.id}"]')?.dataset.terminalRenderer ?? null,
                document: !!document.querySelector('[data-document-pane="${editorPane.id}"]'),
                slot: (() => { try { const key = Object.keys(localStorage).find(k => k.startsWith('kelpi.workbench.v1:')); return key === undefined ? null : JSON.parse(localStorage.getItem(key) ?? '{}').terminal ?? null; } catch { return 'unreadable'; } })()
            })`);
            throw new Error(`The external editor started (pid ${String(state(editor)?.pid)}) but its pane never showed the terminal replacement: ${String(pane)}`);
        }
        editor.pid = state(editor).pid;
        fixtures.push(editor);
        const editorScreen = `KELPI TERMINAL LAB\nPID ${editor.pid}\n赤 緑 🐙 café\nREADY\nSEARCH-ANCHOR\nINPUT READY`;
        rec.check('external-editor mode renders exact fixture text on the document pane', alive(editor) && await d.settle(async () => normal(await text(editor.paneID)) === editorScreen) && (await json(['pane', 'list', '--workspace', local.workspaceID, '--json'])).find(pane => pane.id === editor.paneID)?.type === 'markdown');
        await diagnostics('external-editor');
        await rec.shot(page, 'terminal-lab-external-editor');
        await choose(editor.paneID, 'kelpi.shell');
        rec.check('switching an external-editor renderer retains its editor process', await native(editor.paneID) && alive(editor));
        await choose(editor.paneID); if (!await ready(editor.paneID)) throw new Error('External editor replacement did not resume');
        sequence = await control(editor, { op: 'edit', text: '# Saved by the external editor\n', label: 'EDITOR-SAVED' });
        await completed(editor, sequence); await control(editor, { op: 'exit' });
        rec.check('exiting the external editor restores the same document with saved source', await d.settleDom(page, `document.querySelector('[data-document-pane="${editor.paneID}"]') && !document.querySelector('[data-terminal-pane="${editor.paneID}"]')`) && await d.settle(async () => (await json(['document', 'get', editor.paneID])).text === '# Saved by the external editor\n') && alive(local));
        await cli.ok(['pane', 'close', '--target', editor.paneID]);
        await rec.shot(page, 'terminal-lab-desktop');

        rec.note('Validating remote runtime ownership, phone controls and direct browser attachment');
        remoteSandbox = await makeSandbox(repoRoot, { label: 'terminal-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
        diagnosticsProvenance?.bindExecution?.('plugin-terminal-features:remote-daemon-before-start');
        remoteDaemon = startDaemon(remoteSandbox, { repoRoot }); await waitForHealthz(remoteSandbox.base);
        const remoteCLI = makeCli(remoteSandbox, { repoRoot });
        bindExecution('remote-plugin-install');
        await remoteCLI.ok(['plugin', 'install', packagePath, '--trust']);
        const remote = await create(remoteCLI, path.join(remoteSandbox.root, 'terminal-fixture'), 'Remote Terminal');
        const token = fs.readFileSync(path.join(remoteSandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        fs.writeFileSync(sandbox.configPath, `${originalConfig}\nremote-daemon = TerminalRemote:${remoteSandbox.base}/?token=${token}\n`);
        if (!await check(local.paneID, `(async () => (await kelpi.ui.getNavigation()).hosts.some(host => host.name === 'TerminalRemote' && host.connection === 'connected'))()`)) throw new Error('Remote terminal daemon did not connect');
        await selectWorkspace(local.paneID, remote.workspaceID, 'TerminalRemote');
        await choose(remote.paneID); if (!await ready(remote.paneID)) throw new Error('Remote replacement did not attach');
        rec.check('embedded remote terminal replays through the remote runtime', await sameScreen(remote, 'READY') && alive(remote));
        await incident.ensureHost();
        await incident.addRenderer('remote terminal', expression => inside(remote.paneID, expression), () => page.eval(`!!document.querySelector(${JSON.stringify(frame(remote.paneID))})`));
        await focus(remote.paneID); offset = input(remote).length; const localBeforeRemoteInput = input(local).length;
        await page.key('KeyR', { key: 'r', text: 'r', keyCode: 82 });
        rec.check('remote keyboard input reaches only its owning daemon process', await d.settle(() => input(remote).subarray(offset).includes(Buffer.from('r'))) && input(local).length === localBeforeRemoteInput);
        offset = input(remote).length;
        await harness.clipboardWrite('REMOTE-PASTE-β'); await page.key('KeyV', { key: 'v', modifiers: d.MOD.meta });
        rec.check('remote platform paste targets only the remote process', await d.settle(() => input(remote).subarray(offset).includes(Buffer.from('\x1b[200~REMOTE-PASTE-β\x1b[201~'))) && input(local).length === localBeforeRemoteInput, JSON.stringify(redactFixtureText(input(remote).subarray(offset).toString(), ['\x1b[200~REMOTE-PASTE-β\x1b[201~'])));
        await inside(remote.paneID, `terminalLab.terminal.select(0, 0, 5); true`);
        await harness.clipboardWrite('REMOTE-COPY-SENTINEL'); await page.key('KeyC', { key: 'c', modifiers: d.MOD.meta });
        rec.check('remote platform Copy resolves the remote renderer selection', await d.settle(async () => String((await harness.clipboardRead()).text) === 'KELPI'));
        await incident.retireRenderer('remote terminal');
        await incident.retireRenderer('host');
        await remoteCLI.ok(['pane', 'split', '--target', remote.paneID, '--direction', 'horizontal']);
        const remoteSiblingID = (await json(['pane', 'list', '--workspace', remote.workspaceID, '--json'], remoteCLI)).find(pane => pane.id !== remote.paneID).id;
        if (!await ready(remoteSiblingID) || !await ready(remote.paneID)) throw new Error('Remote sibling renderers did not attach');
        await inside(remote.paneID, `globalThis.__terminalScenarioIdentity = 'kept-while-hidden'; void kelpi.layout.zoom('${remoteSiblingID}'); true`);
        rec.check('a remote pane hidden by zoom retains its renderer and attachment', await check(remote.paneID, `terminalLab.presentation.visible === false && globalThis.__terminalScenarioIdentity === 'kept-while-hidden'`));
        offset = input(remote).length;
        await inside(remote.paneID, `terminalLab.session.write('HIDDEN-MUST-NOT-WRITE'); terminalLab.session.resize(1, 1); true`); await sleep(150);
        rec.check('hidden renderer keyboard input and geometry are ignored', input(remote).length === offset && state(remote).cols > 1 && state(remote).rows > 1);
        offset = input(remote).length;
        sequence = await control(remote, { op: 'query', label: 'HIDDEN-QUERY-COMPLETE' });
        rec.check('a hidden renderer still answers live terminal protocol queries', await completed(remote, sequence) && await d.settle(() => /\x1b\[[0-9]+;[0-9]+R/.test(input(remote).subarray(offset).toString())));
        await diagnostics('hidden-session');
        await inside(remoteSiblingID, `void kelpi.layout.zoom('${remoteSiblingID}'); true`);
        rec.check('revealing the hidden pane preserves its original iframe identity', await check(remote.paneID, `terminalLab.presentation.visible && globalThis.__terminalScenarioIdentity === 'kept-while-hidden'`) && alive(remote));
        await remoteCLI.ok(['pane', 'close', '--target', remoteSiblingID]);
        // Touch emulation FIRST (#235): the phone layout is an AND of the narrow side being under
        // 768px and `(pointer: coarse)`, so overriding the metrics first made the app commit a real
        // desktop layout at 390px and remount into the phone one frame later, on the path already
        // under test. This order has no transient at the natural 1280x820 lane window, whose narrow
        // side is 820, and the wait below is what keeps that true for a window that is shorter.
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        /*
         * #235: the phone steps say what went wrong themselves.
         *
         * Every one of these used to report somebody else's problem. The row wait SKIPPED its
         * click when the row never came, so a missing row surfaced as a later check; both toggle
         * clicks let `page.click` throw its selector message; and none of them could tell a
         * control that had not arrived yet from a page with nothing on it at all, which is what a
         * React teardown leaves behind. `phoneAlive` is the second reading, and it is named.
         */
        const phoneAlive = async where => {
            // Settled, not a single read: `tapPhone` asks before the wait for its control, so the
            // first call lands while the app is still switching form factor, and `innerText` is
            // layout-dependent enough that a frame taken mid-transition can answer '' on a page
            // that is perfectly alive. `childElementCount` is the reading that actually means "the
            // root unmounted". Two seconds costs a blank page two seconds and a live page nothing,
            // because `settle` evaluates before it sleeps.
            if (!await d.settle(async () => await page.eval('document.body.childElementCount > 0 && document.body.innerText.length > 0'), { ceilingMs: 2_000 }))
                throw new Error(`the phone shell rendered nothing at ${where}`);
        };
        const tapPhone = async (selector, what) => {
            await phoneAlive(what);
            if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(selector)})`)) throw new Error(`the phone shell never showed ${what}`);
            await page.click(selector);
        };
        // And wait for the answer rather than assuming the frame, which is what makes the order of
        // the two emulation calls above stop mattering: `bindFormFactorAttribute` publishes the
        // form factor the app actually resolved, and the resolution is an AND of the narrow side
        // being under 768px and `(pointer: coarse)`, so a lane window shorter than that would
        // otherwise flip the whole app to phone at full width for a frame.
        if (!await d.settleDom(page, `document.documentElement.dataset.formFactor === 'phone'`))
            throw new Error('the window never resolved to the phone form factor');
        const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${remote.workspaceID}"]`;
        const viewToggle = '[data-testid="phone-view-toggle"]';
        await tapPhone(phoneRow, 'the remote workspace row');
        rec.check('phone remote workspace mounts the same replacement contract', await ready(remote.paneID) && alive(remote));
        await tapPhone(viewToggle, 'its view toggle'); if (!await ready(remote.paneID)) throw new Error('Phone layout renderer did not attach');
        await tapPhone(viewToggle, 'its view toggle');
        rec.check('phone remote pane/layout toggles preserve the process and screen', await ready(remote.paneID) && alive(remote) && await sameScreen(remote, 'HIDDEN-QUERY-COMPLETE'));
        const key = `[data-testid="terminal-key-left-${remote.paneID}"]`;
        await phoneAlive('the phone key bar');
        if (!await d.settleDom(page, `document.querySelector(${JSON.stringify(key)})`)) throw new Error('Remote terminal has no phone key bar');
        offset = input(remote).length; await page.click(key);
        rec.check('phone key bar dispatches application cursor keys through the plugin renderer', await d.settle(() => input(remote).subarray(offset).includes(Buffer.from('\x1bOD'))));
        await focus(remote.paneID);
        const ctrl = `[data-testid="terminal-key-ctrl-${remote.paneID}"]`;
        await tapPhone(ctrl, 'its Control key');
        if (!await check(remote.paneID, `terminalLab.modifiers.ctrl === true`)) throw new Error('Phone Control latch did not reach the renderer');
        offset = input(remote).length;
        await page.key('KeyC', { key: 'c', text: 'c', keyCode: 67 });
        rec.check('phone Control applies to an actual key and clears both latches', await d.settle(() => input(remote).subarray(offset).equals(Buffer.from([3]))) && await check(remote.paneID, `terminalLab.modifiers.ctrl === false`) && await d.settleDom(page, `document.querySelector(${JSON.stringify(ctrl)})?.getAttribute('aria-pressed') === 'false'`), JSON.stringify(input(remote).subarray(offset).toString()));
        await page.key('KeyC', { key: 'c', text: 'c', keyCode: 67 });
        rec.check('the following phone key is unmodified', await d.settle(() => input(remote).subarray(offset).equals(Buffer.from([3, 99]))));
        const alt = `[data-testid="terminal-key-alt-${remote.paneID}"]`;
        for (const [modifier, character, expected] of [['ctrl', '[', '\x1b'], ['ctrl', '\\', '\x1c'], ['alt', '/', '\x1b/'], ['alt', 'X', '\x1bX']]) {
            await tapPhone(modifier === 'ctrl' ? ctrl : alt, `its ${modifier} key`);
            if (!await check(remote.paneID, `terminalLab.modifiers.${modifier} === true`)) throw new Error('Phone modifier did not reach the renderer');
            offset = input(remote).length;
            // Text insertion exercises beforeinput without inventing a physical key code.
            await page.insertText(character);
            rec.check(`phone ${modifier}+${character} preserves software-keyboard character encoding`, await d.settle(() => input(remote).subarray(offset).equals(Buffer.from(expected))), JSON.stringify(input(remote).subarray(offset).toString()));
        }
        await diagnostics('phone-input');
        rec.check('terminal replacement fits the phone viewport', await check(remote.paneID, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`));
        rec.check('the phone key bar fits inside the visible viewport', await d.settleDom(page, `(() => { const box = document.querySelector(${JSON.stringify(ctrl)})?.getBoundingClientRect(); return box && box.height > 0 && box.bottom <= (visualViewport?.height ?? innerHeight) + 1; })()`));
        // The emulated 844px viewport is taller than the native 820px audit window.
        // These are Chromium iframe terminals, so its surface includes every pane and
        // avoids clipping the final 24px through the native-window capture path.
        await rec.shot(rec.summary().placement === 'hidden' ? page : { screenshot: async file => {
            const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64')); return file;
        } }, 'terminal-lab-phone');
        // Back to the landing page BEFORE the window widens again, while the shell is still
        // mounted: it is the one tap that forgets where this scenario took the phone (#205).
        if (!await phoneToLanding(page, d, { note: rec.note })) rec.note('the phone shell did not return to its landing page; the next phone scenario may open where this one left it');
        await page.send('Emulation.clearDeviceMetricsOverride'); await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.send('Page.navigate', { url: `${remoteSandbox.base}/?token=${token}` });
        await choose(remote.paneID); rec.check('direct browser attachment preserves the remote process', await ready(remote.paneID) && alive(remote) && await sameScreen(remote, 'HIDDEN-QUERY-COMPLETE'));
        await page.send('Emulation.setUserAgentOverride', { userAgent: originalAgent.userAgent, platform: 'Linux x86_64' });
        await page.send('Page.reload');
        if (!await ready(remote.paneID)) throw new Error('Non-Mac renderer did not reconnect');
        await focus(remote.paneID); await inside(remote.paneID, `terminalLab.terminal.clearSelection(); true`);
        offset = input(remote).length;
        await harness.clipboardWrite('NON-MAC-COPY-SENTINEL');
        await page.key('KeyC', { key: 'c', modifiers: d.MOD.ctrl, keyCode: 67 });
        rec.check('non-Mac Ctrl+C sends exactly one interrupt with an empty selection', await d.settle(() => input(remote).subarray(offset).equals(Buffer.from([3]))) && String((await harness.clipboardRead()).text) === 'NON-MAC-COPY-SENTINEL');
        await page.send('Emulation.setUserAgentOverride', originalAgent);
        await page.send('Page.navigate', { url: originalURL });
        rec.check('returning to the original window restores its local terminal process', await ready(local.paneID) && alive(local));
        rec.note('Physical mobile keyboards, actual OS IME candidate windows and two simultaneous native windows remain device/manual checks; this scenario used trusted CDP input and phone emulation.');
    } catch (error) { rec.check('terminal scenario exception', false, error?.message ?? error, 'harness'); await rec.flushFirstFailure(); await incident?.freeze('exception'); await diagnostics('failure').catch(() => {}); await rec.shot(page, 'terminal-failure'); throw error; }
    finally {
        await rec.flushFirstFailure();
        await incident?.close();
        const safely = async (what, step) => {
            try { await step(); } catch (error) { rec.check(`cleanup: ${what}`, false, error instanceof Error ? error.message : String(error), 'cleanup'); }
        };
        sizeObserver?.close(); sizeObserver = null;
        await diagnostics('final').catch(() => {});
        for (const off of offWire) off();
        // First, while the shell is still mounted and the host it is on is still configured: the
        // config restore below takes that host out of the navigation and the widening after it
        // unmounts the shell, and neither can be undone from here (#205, `lib/workbench.mjs`).
        await safely('the phone returns to its landing page', async () => { rec.check('cleanup: phone returned to landing', await phoneToLanding(page, d, { note: message => rec.note(`cleanup: ${message}`) }), undefined, 'cleanup'); });
        await safely('config restored', () => fs.writeFileSync(sandbox.configPath, originalConfig));
        await safely('clipboard restored', () => harness.clipboardWrite(originalClipboard));
        await safely('device metrics restored', () => page.send('Emulation.clearDeviceMetricsOverride'));
        await safely('touch emulation restored', () => page.send('Emulation.setTouchEmulationEnabled', { enabled: false }));
        await safely('user agent restored', () => page.send('Emulation.setUserAgentOverride', originalAgent));
        await safely('the window returns to the shell this runner launched', async () => {
            await page.send('Page.navigate', { url: originalURL });
            if (!await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 20_000 })) throw new Error('original window did not reconnect');
        });
        await safely('the terminal placement goes back to bundled', async () => {
            const restored = await restoreBundledSlots(page, d, { terminal: 'kelpi.shell' }, { daemonID: daemonIDFromSandbox(sandbox) });
            rec.check('cleanup: terminal placement restored', restored.ok, restored.detail, 'cleanup');
            if (remoteSandbox) await removeOwnedRemoteStore(page, daemonIDFromSandbox(remoteSandbox), rec);
        });
        await safely('the Settings overlay is closed', async () => {
            if (await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`)) await page.click('[data-testid="settings-close"]');
        });
        await safely('plugin removed', () => cli.ok(['plugin', 'remove', pluginID]));
        await safely('fixture workspaces removed', async () => {
            for (const workspace of await json(['workspace', 'list', '--json'])) if (!initial.has(workspace.id)) await cli.ok(['workspace', 'delete', workspace.id, '--force']);
        });
        await safely('remote daemon stopped', () => remoteDaemon?.stop());
        await safely('remote sandbox removed', () => remoteSandbox?.cleanup());
    }
}
