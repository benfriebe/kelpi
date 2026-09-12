import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';
import { phoneToLanding } from '../ui-audit/lib/workbench.mjs';

export const covers = ['packages/client/src/app/RemoteWorkspaceView.tsx', 'packages/client/src/phone/PhoneRemoteWorkspace.tsx', 'packages/client/src/plugins/', 'packages/daemon/src/plugins/'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginID = 'example.agent-board', viewID = `${pluginID}.board`;

export default async function ({ page, cli, sandbox, rec, d }) {
    const originalURL = await page.eval('location.href');
    const remote = await makeSandbox(repoRoot, { label: 'plugin-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
    const daemonOptions = { repoRoot, packaged: process.env.KELPI_PLUGIN_PACKAGED === '1' };
    if (daemonOptions.packaged) rec.note('The remote daemon and plugin child runtime come from the packaged application.');
    let daemon = startDaemon(remote, daemonOptions);
    const remoteCLI = makeCli(remote, { repoRoot });
    const command = async args => {
        const result = await remoteCLI.run(args);
        if (result.code !== 0) throw new Error(`remote command failed: ${result.stderr || result.stdout}`);
        return JSON.parse(result.stdout);
    };
    const previousConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    try {
        await waitForHealthz(remote.base);
        const localPanes = await cli.ok(['pane', 'list', '--json']);
        await command(['plugin', 'install', path.join(repoRoot, 'examples/plugins/agent-board'), '--trust']);
        const workspace = await command(['workspace', 'create', '--name', 'Remote plugin validation', '--json']);
        const pane = await command(['plugin', 'open', pluginID, viewID, '--workspace', workspace.workspace_id]);
        const token = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        fs.writeFileSync(sandbox.configPath, `${previousConfig}\nremote-daemon = PluginRemote:${remote.base}/?token=${token}\n`);
        await page.watchFrames();
        const row = `[data-testid="remote-daemon-PluginRemote"] [data-workspace-id="${workspace.workspace_id}"]`;
        rec.check('a second real daemon appears in the local sidebar', await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 12_000 }));
        await page.click(row);
        const frame = `[data-testid="plugin-view-${pane.paneID}"] iframe`;
        const ready = () => d.settle(async () => { try { return await page.evalInFrame(frame, `(async () => (await kelpi.snapshot()).state.workspaces.some(workspace => workspace.id === ${JSON.stringify(workspace.workspace_id)}))()`); } catch { return false; } }, { ceilingMs: 15_000 });
        rec.check('remote plugin renders with a working API on its own daemon', await ready());
        const identity = await page.evalInFrame(frame, `JSON.stringify(kelpi.context)`);
        const initialEpoch = await page.evalInFrame(frame, `(async () => (await kelpi.snapshot()).epoch)()`);
        await page.evalInFrame(frame, `kelpi.files.write(${JSON.stringify(path.join(remote.root, 'plugin-probe.txt'))}, 'remote filesystem')`);
        rec.check('file APIs execute on the remote daemon machine', fs.readFileSync(path.join(remote.root, 'plugin-probe.txt'), 'utf8') === 'remote filesystem' && !fs.existsSync(path.join(sandbox.root, 'plugin-probe.txt')));
        const executed = await page.evalInFrame(frame, `kelpi.process.exec(${JSON.stringify(process.execPath)}, ['-e', 'process.stdout.write(process.cwd())'], { cwd: ${JSON.stringify(remote.work)} })`);
        rec.check('process APIs execute in the remote working directory', fs.realpathSync(executed.stdout) === fs.realpathSync(remote.work));
        const cliResult = await page.evalInFrame(frame, `kelpi.process.exec(${JSON.stringify(process.execPath)}, [${JSON.stringify(path.join(repoRoot, 'packages/cli/dist/kelpi.js'))}, 'workspace', 'list', '--json'])`);
        rec.check('a CLI subprocess inherits its plugin daemon route', JSON.parse(cliResult.stdout).some(entry => entry.id === workspace.workspace_id || entry.workspace_id === workspace.workspace_id));
        await page.evalInFrame(frame, `kelpi.setState({ filter: 'remote remembered' })`);
        const before = (await command(['pane', 'list', '--workspace', workspace.workspace_id, '--json'])).length;
        await page.evalInFrame(frame, `document.getElementById('create').click()`);
        rec.check('remote custom UI commands create a remote terminal', await d.settle(async () => (await command(['pane', 'list', '--workspace', workspace.workspace_id, '--json'])).length === before + 1, { ceilingMs: 8_000 }));
        const localAfter = await cli.ok(['pane', 'list', '--json']);
        const ids = text => JSON.parse(text).map(pane => pane.pane_id ?? pane.id).sort().join(',');
        rec.check('remote commands leave the local pane set intact', ids(localPanes) === ids(localAfter));

        await daemon.stop(); daemon = startDaemon(remote, daemonOptions);
        await waitForHealthz(remote.base);
        rec.check('custom pane reconnects after a real daemon process restart', await ready());
        rec.check('restart preserves view state and daemon identity with a new event epoch', await page.evalInFrame(frame, `(async () => kelpi.state.filter === 'remote remembered' && kelpi.context.daemonID === ${JSON.stringify(JSON.parse(identity).daemonID)} && (await kelpi.snapshot()).epoch !== ${JSON.stringify(initialEpoch)})()`));

        // Reload the client URL without Electron's shellWindow identity: the ordinary browser path.
        const localToken = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        await page.send('Page.navigate', { url: `${sandbox.base}/?token=${localToken}` });
        await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 12_000 });
        await page.click(row);
        rec.check('the same remote pane works through the ordinary browser client', await ready());
        await rec.shot(page, 'remote-plugin-after-restart');

        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${workspace.workspace_id}"]`;
        rec.check('the phone host picker includes the plugin workspace', await d.settleDom(page, `document.querySelector(${JSON.stringify(phoneRow)})`, { ceilingMs: 8_000 }));
        await page.click(phoneRow);
        await page.click('[data-testid="phone-title"]');
        await d.settleDom(page, `document.querySelector('[data-testid="phone-pane-show-${pane.paneID}"]')`);
        await page.click(`[data-testid="phone-pane-show-${pane.paneID}"]`);
        rec.check('phone single-pane mode renders the remote plugin and its saved state', await ready() && await page.evalInFrame(frame, `kelpi.state.filter === 'remote remembered'`));
    } finally {
        fs.writeFileSync(sandbox.configPath, previousConfig);
        /*
         * Back to the landing page BEFORE the window widens, while the phone shell is still
         * mounted: `phone/place.ts` remembers `{host, workspaceID}` and a remembered place means
         * the NEXT phone window opens there - on a remote host this block is about to stop -
         * instead of on the host picker this scenario's own first check reads (#205).
         */
        try {
            if (!await phoneToLanding(page, d)) rec.note('cleanup: the phone shell never reached its landing page');
        } catch (error) {
            rec.note(`cleanup: the phone shell never reached its landing page — ${error instanceof Error ? error.message : String(error)}`);
        }
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.send('Page.navigate', { url: originalURL });
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 10_000 });
        await daemon.stop(); remote.cleanup();
    }
}
