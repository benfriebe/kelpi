/**
 * #267: ⌘= / ⌘- / ⌘0 over a paired remote daemon's terminal change THAT daemon's text size, and
 * the remote pane is drawn at that daemon's size.
 *
 * Two real daemons: this window's own, and a second one paired with a `remote-daemon =` line,
 * whose workspace is opened from the sidebar. Before #267 the chords did nothing there (the window
 * dispatcher stands down over a remote workspace, and the text-size step declined), and a remote
 * terminal with no size of its own was drawn at the engine's built-in 13 whatever the remote
 * daemon's ghostty `font-size` said.
 *
 * The instruments, none of which a chord being merely consumed can satisfy:
 *
 *   1. **the remote daemon's own state**, read by a raw WebSocket client of that daemon (the
 *      pane's `terminalFontSize`) and by reading its ghostty config file as bytes;
 *   2. **this daemon's ghostty config and pane**, which must not change;
 *   3. **the measured cell** (`data-terminal-cell`) the remote pane publishes in this window.
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION, WS_PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';

export const covers = [
    'packages/client/src/app/text-size.ts',
    'packages/client/src/app/terminal-shortcuts.tsx',
    'packages/client/src/app/RemoteWorkspaceView.tsx',
    'packages/client/src/phone/PhoneRemoteWorkspace.tsx',
    'packages/client/src/features/TerminalFeaturePane.tsx'
];

const REMOTE_NAME = 'TextSizeRemote';
const REMOTE_DEFAULT = 16;

/** A pane as a second client of `base` reads it out of that daemon's snapshot. */
async function snapshotPane(base, token, paneID) {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${token}`);
    try {
        return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('no snapshot')), 10_000);
            socket.addEventListener('open', () => socket.send(JSON.stringify({
                type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token, client: { kind: 'browser', name: 'remote-text-size-reader' }
            })));
            socket.addEventListener('message', ({ data }) => {
                if (typeof data !== 'string') return;
                const message = JSON.parse(data);
                if (message.type !== 'snapshot') return;
                clearTimeout(timeout);
                const panes = (message.state?.workspaces ?? []).flatMap((workspace) => workspace.panes ?? []);
                resolve(panes.find((pane) => pane.id === paneID));
            });
            socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('socket error')); }, { once: true });
        });
    } finally {
        try { socket.close(); } catch { /* already gone */ }
    }
}

export default async function ({ page, cli, sandbox, rec, d, sleep, repoRoot }) {
    if (!sandbox) throw new Error('This scenario requires a private booted instance');
    const previousConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const readLocalGhostty = () => (fs.existsSync(sandbox.ghosttyConfigPath) ? fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8') : null);
    const originalLocalGhostty = readLocalGhostty();
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initialWorkspaceIDs = new Set(startingWorkspaces.map((workspace) => workspace.id));

    const remote = await makeSandbox(repoRoot, { label: 'text-size-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
    // The remote daemon's own "All panes" size, so its terminals are not drawn at the default.
    fs.writeFileSync(remote.ghosttyConfigPath, `font-size = ${String(REMOTE_DEFAULT)}\n`);
    const daemon = startDaemon(remote, { repoRoot });
    const remoteCLI = makeCli(remote, { repoRoot });
    const readRemoteGhostty = () => fs.readFileSync(remote.ghosttyConfigPath, 'utf8');
    const remoteFontSizeLine = () => [...readRemoteGhostty().matchAll(/^[ \t]*font-size[ \t]*=[ \t]*(\S+)/gm)].at(-1)?.[1] ?? null;

    const readCell = async (paneID) =>
        await page.eval(`(() => {
            const root = document.querySelector('[data-pane-id="${paneID}"][data-terminal-status]');
            if (root === null) return null;
            const cell = (root.getAttribute('data-terminal-cell') ?? '').split('x');
            return { width: Number(cell[0] ?? 0), height: Number(cell[1] ?? 0) };
        })()`);
    const cellSettles = async (paneID, test, ceilingMs = 10_000) =>
        await d.settle(async () => {
            const cell = await readCell(paneID);
            return cell !== null && cell.height > 0 && test(cell);
        }, { ceilingMs, intervalMs: 100 });
    const press = async (code, key) => {
        await page.key(code, { modifiers: d.MOD.meta, key });
        await sleep(150);
    };

    try {
        await waitForHealthz(remote.base);
        const token = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        const localToken = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        const created = JSON.parse(await remoteCLI.ok(['workspace', 'create', '--name', 'Remote text size', '--json']));
        const remoteWorkspace = created.workspace_id ?? created.id;
        const remotePanes = JSON.parse(await remoteCLI.ok(['pane', 'list', '--workspace', remoteWorkspace, '--json']));
        const remotePane = (Array.isArray(remotePanes) ? remotePanes : remotePanes.panes ?? [])[0]?.id;
        rec.check('the remote daemon has a workspace with a shell', typeof remotePane === 'string', JSON.stringify(remotePanes).slice(0, 300));
        if (typeof remotePane !== 'string') return;
        const remotePaneSize = async () => (await snapshotPane(remote.base, token, remotePane))?.terminalFontSize;

        // ── a local terminal to compare against, and to prove the local daemon untouched ───
        const local = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Local text size', '--json']));
        const localWorkspace = local.workspace_id ?? local.id;
        await d.settleDom(page, `document.querySelector('[data-workspace-id="${localWorkspace}"]')`, { ceilingMs: 10_000 });
        await d.settle(async () => (await d.domPaneIDs(page)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });
        const localPane = (await d.domPaneIDs(page))[0];
        const localCell = localPane === undefined ? null : await (async () => { await cellSettles(localPane, () => true); return await readCell(localPane); })();
        rec.check('a local terminal publishes a measured cell at the local default', (localCell?.height ?? 0) > 0, JSON.stringify(localCell));
        if (localPane === undefined || localCell === null) return;

        // ── pair the remote daemon and open its workspace ─────────────────────────────
        fs.writeFileSync(sandbox.configPath, `${previousConfig}\nremote-daemon = ${REMOTE_NAME}:${remote.base}/?token=${token}\n`);
        const row = `[data-testid="remote-daemon-${REMOTE_NAME}"] [data-workspace-id="${remoteWorkspace}"]`;
        rec.check('the paired daemon appears in the sidebar', await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 15_000 }));
        await page.click(row);
        rec.check(
            `the remote terminal is drawn at the REMOTE daemon's ${String(REMOTE_DEFAULT)}, bigger than the local default`,
            await cellSettles(remotePane, (cell) => cell.height > localCell.height, 15_000),
            `remote ${JSON.stringify(await readCell(remotePane))} vs local ${JSON.stringify(localCell)}`
        );
        const remoteBaseline = await readCell(remotePane);

        // ── font-size-scope = pane (the shipped default) on the remote ────────────────
        await d.focusPaneBody(page, remotePane);
        await sleep(300);
        // Four presses in a row, then a dwell: exactly +4 and stable, so a doubled step (a menu
        // accelerator as well as the pane) or a press lost while the engine rebuilds both fail.
        for (let press4 = 0; press4 < 4; press4 += 1) await page.key('Equal', { modifiers: d.MOD.meta, key: '=' });
        await d.settle(async () => (await remotePaneSize()) === REMOTE_DEFAULT + 4, { ceilingMs: 8_000, intervalMs: 150 });
        await sleep(1_000);
        rec.check(
            `four ⌘= gave the remote pane a size of its own on ITS daemon, exactly ${String(REMOTE_DEFAULT + 4)}`,
            (await remotePaneSize()) === REMOTE_DEFAULT + 4,
            String(await remotePaneSize())
        );
        rec.check(
            'and this window drew the remote terminal with a bigger cell',
            await cellSettles(remotePane, (cell) => cell.height > (remoteBaseline?.height ?? 0)),
            `${JSON.stringify(remoteBaseline)} → ${JSON.stringify(await readCell(remotePane))}`
        );
        rec.check('the local daemon’s pane kept no size of its own', (await snapshotPane(sandbox.base, localToken, localPane))?.terminalFontSize == null);
        rec.check('the local ghostty config was not touched', readLocalGhostty() === originalLocalGhostty);
        rec.check('the remote ghostty config was not touched under pane scope', remoteFontSizeLine() === String(REMOTE_DEFAULT), String(remoteFontSizeLine()));
        await rec.shot(page, 'remote-text-size-pane');
        rec.note(`EYES - the screenshot above: the ${REMOTE_NAME} workspace, its terminal four points bigger than its daemon's ${String(REMOTE_DEFAULT)}.`);

        await press('Minus', '-');
        rec.check(`⌘- stepped it down once, to ${String(REMOTE_DEFAULT + 3)}`, await d.settle(async () => (await remotePaneSize()) === REMOTE_DEFAULT + 3, { ceilingMs: 8_000, intervalMs: 150 }), String(await remotePaneSize()));
        await press('Digit0', '0');
        rec.check('⌘0 dropped the remote pane’s own size', await d.settle(async () => (await remotePaneSize()) == null, { ceilingMs: 8_000, intervalMs: 150 }), String(await remotePaneSize()));

        // ── font-size-scope = all on the remote: its daemon-wide size ─────────────────
        fs.appendFileSync(remote.configPath, '\nfont-size-scope = all\n');
        await sleep(1500);
        await d.focusPaneBody(page, remotePane);
        await sleep(300);
        for (let press4 = 0; press4 < 4; press4 += 1) await page.key('Equal', { modifiers: d.MOD.meta, key: '=' });
        await d.settle(() => remoteFontSizeLine() === String(REMOTE_DEFAULT + 4), { ceilingMs: 8_000, intervalMs: 150 });
        await sleep(1_000);
        rec.check(
            `under the remote's font-size-scope = all, four ⌘= wrote the REMOTE daemon's ghostty font-size, exactly ${String(REMOTE_DEFAULT + 4)}`,
            remoteFontSizeLine() === String(REMOTE_DEFAULT + 4),
            String(remoteFontSizeLine())
        );
        rec.check('and gave no pane a size of its own', (await remotePaneSize()) == null);
        rec.check('the local ghostty config still was not touched', readLocalGhostty() === originalLocalGhostty);
        rec.check(
            'this window drew the remote terminal at the new daemon-wide size',
            await cellSettles(remotePane, (cell) => cell.height > (remoteBaseline?.height ?? 0)),
            `${JSON.stringify(remoteBaseline)} → ${JSON.stringify(await readCell(remotePane))}`
        );

        // ── back on a local workspace, the chord is the local daemon's again ──────────
        const localRow = `[data-testid="workspace-row"][data-workspace-id="${localWorkspace}"]`;
        await page.click(localRow);
        await d.settleDom(page, `document.querySelector('[data-pane-id="${localPane}"][data-terminal-status]') !== null`, { ceilingMs: 8_000 });
        await d.focusPaneBody(page, localPane);
        await sleep(300);
        const remoteBefore = remoteFontSizeLine();
        await press('Equal', '=');
        rec.check(
            'on a local workspace ⌘= steps the local pane',
            await d.settle(async () => (await snapshotPane(sandbox.base, localToken, localPane))?.terminalFontSize === 14, { ceilingMs: 8_000, intervalMs: 150 })
        );
        rec.check('and leaves the remote daemon alone', remoteFontSizeLine() === remoteBefore, String(remoteFontSizeLine()));
    } catch (error) {
        await rec.shot(page, 'remote-text-size-failure').catch(() => {});
        throw error;
    } finally {
        fs.writeFileSync(sandbox.configPath, previousConfig);
        await d.settleDom(page, `!document.querySelector('[data-testid="remote-daemon-${REMOTE_NAME}"]')`, { ceilingMs: 10_000 }).catch(() => {});
        for (const workspace of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            if (!initialWorkspaceIDs.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        }
        if (startingWorkspace !== null) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row).catch(() => {});
        }
        await daemon.stop(); remote.cleanup();
    }
}
