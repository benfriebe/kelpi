/**
 * ⌘= / ⌘- / ⌘0 over a focused terminal change THAT PANE'S text size and no other's, under the
 * shipped `font-size-scope = pane` (config-keybindings.md §7.6).
 *
 * The Swift app's libghostty surfaces each had their own size; #175 made it one daemon-wide
 * setting, and the owner asked for the per-pane behaviour back as the default, with the
 * daemon-wide one a Settings choice away (`terminal-text-size-shortcuts.mjs` covers that one).
 * The size lives on the pane in daemon state (`Pane.terminalFontSize`, `pane-font-size`), is
 * persisted, and survives a daemon restart.
 *
 * The instruments, none of which the chord merely being consumed can satisfy:
 *
 *   1. **the measured cell**: `data-terminal-cell`, which the pane publishes from what the
 *      ENGINE measured after the font changed;
 *   2. **`stty size` inside the shell**: the process's own answer, through a real SIGWINCH;
 *   3. **the other pane**: a second terminal that was never focused. Its cell must NOT change,
 *      which is the whole point;
 *   4. **the daemon's ghostty config**: read as bytes, it must NOT change either;
 *   5. **a second client**: a raw WebSocket client of its own, reading the pane out of the
 *      daemon's `snapshot`. That rules out a per-viewer implementation;
 *   6. **a split**: ⌘D over a pane with its own size gives the new pane the same size;
 *   7. **a daemon restart**: the pane comes back still drawn at its own size.
 *
 * And the Settings row that picks the scope: clicking its segments writes `font-size-scope` into
 * the daemon's kelpi config, read as bytes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';

export const covers = [
    'packages/client/src/app/text-size.ts',
    'packages/client/src/App.tsx',
    'packages/client/src/connection/commands.ts',
    'packages/client/src/settings/sections.ts',
    'packages/client/src/state/store.ts',
    'packages/daemon/src/handlers/pane/font-size.ts',
    'packages/daemon/src/store/reducers/panes.ts',
    'packages/daemon/src/db/codec.ts'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
/** The Appearance row's shipped default (`settings/sections.ts`), restated so a drift is visible. */
const DEFAULT_SIZE = 13;

export default async function ({ page, cli, sandbox, daemon, rec, d, sleep }) {
    const readGhostty = () => (fs.existsSync(sandbox.ghosttyConfigPath) ? fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8') : null);
    const originalGhostty = readGhostty();
    const readKelpi = () => (fs.existsSync(sandbox.configPath) ? fs.readFileSync(sandbox.configPath, 'utf8') : null);
    const originalKelpi = readKelpi();
    /** The daemon's own answer: the last `font-size-scope` line in its config, or null for absent. */
    const configuredScope = () => [...(readKelpi() ?? '').matchAll(/^[ \t]*font-size-scope[ \t]*=[ \t]*(\S+)[ \t]*$/gm)].at(-1)?.[1] ?? null;
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initialWorkspaceIDs = new Set(startingWorkspaces.map((workspace) => workspace.id));

    /**
     * What a SECOND client is told a pane's own size is, straight from the daemon's snapshot.
     * Undefined = the pane was not in it.
     */
    const secondClientPaneSize = async (paneID) => {
        const token = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        const socket = new WebSocket(`${sandbox.base.replace(/^http/, 'ws')}/ws?token=${token}`);
        try {
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('the second client never got a snapshot')), 10_000);
                socket.addEventListener('open', () =>
                    socket.send(
                        JSON.stringify({
                            type: 'hello',
                            protocolVersion: PROTOCOL_VERSION,
                            token,
                            client: { kind: 'browser', name: 'kelpi-pane-text-size-reader' }
                        })
                    )
                );
                socket.addEventListener('message', ({ data }) => {
                    if (typeof data !== 'string') return;
                    const message = JSON.parse(data);
                    if (message.type !== 'snapshot') return;
                    clearTimeout(timeout);
                    const panes = (message.state?.workspaces ?? []).flatMap((workspace) => workspace.panes ?? []);
                    resolve(panes.find((pane) => pane.id === paneID)?.terminalFontSize);
                });
                socket.addEventListener('error', (error) => { clearTimeout(timeout); reject(error); }, { once: true });
            });
        } finally {
            try { socket.close(); } catch { /* already gone */ }
        }
    };
    const paneSizeSettlesAt = async (paneID, want, ceilingMs = 8_000) =>
        await d.settle(async () => (await secondClientPaneSize(paneID)) === want, { ceilingMs, intervalMs: 150 });

    const paneRoot = (paneID) => `[data-pane-id="${paneID}"][data-terminal-status]`;
    const readCell = async (paneID) =>
        await page.eval(
            `(() => {
                const root = document.querySelector('${paneRoot(paneID)}');
                if (root === null) return null;
                const cell = (root.getAttribute('data-terminal-cell') ?? '').split('x');
                return { width: Number(cell[0] ?? 0), height: Number(cell[1] ?? 0) };
            })()`
        );
    const cellSettles = async (paneID, test, ceilingMs = 8_000) =>
        await d.settle(async () => {
            const cell = await readCell(paneID);
            return cell !== null && cell.height > 0 && test(cell);
        }, { ceilingMs, intervalMs: 80 });

    /** `terminal-text-size-shortcuts.mjs`'s `stty size` read, verbatim in shape. */
    const shellSize = async (paneID, label = 'the shell') => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const marker = `SIZE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
            await cli.ok(['pane', 'send', '--target', paneID, `echo "${marker} $(stty size | tr ' ' '-')"`]);
            await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
            let answer = null;
            await d.settle(
                async () => {
                    const capture = await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
                    const match = new RegExp(`${marker} (\\d+)-(\\d+)`).exec(capture);
                    if (match === null) return false;
                    answer = { rows: Number(match[1]), cols: Number(match[2]) };
                    return true;
                },
                { ceilingMs: 20_000 }
            );
            if (answer !== null) return answer;
            rec.note(`${label} never echoed its stty marker on attempt ${String(attempt + 1)}; retrying once`);
        }
        rec.note(`FAILED READ: ${label} never echoed the marker, so its PTY size could not be read`);
        return null;
    };

    const press = async (code, key) => {
        await page.key(code, { modifiers: d.MOD.meta, key });
        await sleep(120);
    };

    try {
        // ── a workspace of its own, with two terminals ──────────────────────────────
        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', `PaneTextSize-${TAG}`, '--json']));
        const workspaceID = created.workspace_id ?? created.id;
        rec.check('a workspace of its own to resize in', typeof workspaceID === 'string', JSON.stringify(created));
        if (typeof workspaceID !== 'string') return;
        await d.settleDom(page, `document.querySelector('[data-workspace-id="${workspaceID}"]')`, { ceilingMs: 10_000 });
        await d.settle(async () => (await d.domPaneIDs(page)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });

        const first = (await d.domPaneIDs(page))[0];
        rec.check('a terminal pane to press the chord over', first !== undefined);
        if (first === undefined) return;

        await d.focusPaneBody(page, first);
        const before = await d.domPaneIDs(page);
        await press('KeyD', 'd');
        const split = await d.settle(async () => (await d.domPaneIDs(page)).length > before.length, { ceilingMs: 8_000 });
        rec.check('⌘D gave us a second terminal, the one that never gets pressed', split);
        const other = (await d.domPaneIDs(page)).find((paneID) => paneID !== first);
        if (other === undefined) return;

        await d.focusPaneBody(page, first);
        await sleep(400);

        const baselineCell = await readCell(first);
        const baselineOther = await readCell(other);
        rec.check(
            'both panes publish a measured cell to compare against',
            (baselineCell?.height ?? 0) > 0 && (baselineOther?.height ?? 0) > 0,
            `${JSON.stringify(baselineCell)} · other ${JSON.stringify(baselineOther)}`
        );
        if (!((baselineCell?.height ?? 0) > 0) || !((baselineOther?.height ?? 0) > 0)) return;
        rec.check(
            'both start with no size of their own',
            (await secondClientPaneSize(first)) === null && (await secondClientPaneSize(other)) === null
        );
        const baselineShell = await shellSize(first, 'the focused pane');
        rec.check('the shell reports its PTY size before anything moves', baselineShell !== null, JSON.stringify(baselineShell));

        // ── ⌘+ twice ─────────────────────────────────────────────────────────────────
        await press('Equal', '=');
        await press('Equal', '=');
        rec.check(
            `two ⌘+ gave the focused pane a size of its own, ${String(DEFAULT_SIZE + 2)}, in the daemon's state`,
            await paneSizeSettlesAt(first, DEFAULT_SIZE + 2),
            `a second client reads ${String(await secondClientPaneSize(first))}`
        );
        rec.check(
            'the terminal the chord was pressed over measured a bigger cell',
            await cellSettles(first, (cell) => cell.height > baselineCell.height),
            `${String(baselineCell.height)}px → ${String((await readCell(first))?.height ?? 0)}px`
        );
        // A negative claim, so it needs a dwell before it means anything.
        await sleep(700);
        const otherNow = await readCell(other);
        rec.check(
            'the pane nobody pressed anything over kept its cell',
            otherNow !== null && otherNow.height === baselineOther.height && otherNow.width === baselineOther.width,
            `${JSON.stringify(baselineOther)} → ${JSON.stringify(otherNow)}`
        );
        rec.check('…and has no size of its own', (await secondClientPaneSize(other)) === null);
        rec.check(
            'the daemon-wide ghostty font-size was not touched',
            readGhostty() === originalGhostty,
            JSON.stringify((readGhostty() ?? '').slice(0, 200))
        );
        const grownShell = await shellSize(first, 'the focused pane after ⌘+');
        rec.check(
            'the process inside the pane was told: `stty size` reports fewer columns',
            grownShell !== null && baselineShell !== null && grownShell.cols < baselineShell.cols,
            `${String(baselineShell?.cols)} cols → ${String(grownShell?.cols)} cols`
        );
        await rec.shot(page, 'pane-text-size-after-plus');
        rec.note(
            `EYES - the screenshot above: workspace PaneTextSize-${TAG}'s two terminals, the focused one drawn at ${String(DEFAULT_SIZE + 2)}px and the other still at ${String(DEFAULT_SIZE)}px.`
        );

        // ── ⌘- back onto the default stores null, not 13 ─────────────────────────────
        await press('Minus', '-');
        await press('Minus', '-');
        rec.check(
            'two ⌘- land back on the default, which the pane stores as no size of its own',
            await paneSizeSettlesAt(first, null),
            String(await secondClientPaneSize(first))
        );
        rec.check(
            'and the cell is back to what it was',
            await cellSettles(first, (cell) => cell.height === baselineCell.height),
            `${String(baselineCell.height)}px vs ${String((await readCell(first))?.height ?? 0)}px`
        );

        // ── ⌘0 from a size of its own ────────────────────────────────────────────────
        await press('Minus', '-');
        rec.check('⌘- below the default gives it a smaller size of its own', await paneSizeSettlesAt(first, DEFAULT_SIZE - 1));
        await press('Digit0', '0');
        rec.check('⌘0 drops it', await paneSizeSettlesAt(first, null), String(await secondClientPaneSize(first)));

        // ── the Settings row that picks the scope ────────────────────────────────────
        await d.openSettingsTab(page, 'appearance');
        const rowShown = await d.settleDom(page, `document.querySelector('[data-testid="terminal-font-size-scope"]')`, { ceilingMs: 8_000 });
        rec.check('Settings ▸ Appearance ▸ Terminal has the "⌘+ and ⌘- resize" row', rowShown);
        if (rowShown) {
            await page.eval(`document.querySelector('[data-testid="terminal-font-size-scope"]')?.scrollIntoView({ block: 'center' })`);
            await sleep(300);
            await rec.shot(page, 'pane-text-size-settings-row');
            rec.note('EYES - the screenshot above: the Terminal card with the "⌘+ and ⌘- resize" row under Font size, Focused pane selected.');
            await page.click('[data-testid="terminal-font-size-scope-all"]');
            rec.check(
                'clicking All panes writes font-size-scope = all to the daemon\'s config',
                await d.settle(() => configuredScope() === 'all', { ceilingMs: 8_000, intervalMs: 80 }),
                String(configuredScope())
            );
            await page.click('[data-testid="terminal-font-size-scope-pane"]');
            rec.check(
                'and Focused pane writes it back to pane',
                await d.settle(() => configuredScope() === 'pane', { ceilingMs: 8_000, intervalMs: 80 }),
                String(configuredScope())
            );
        }
        if (await page.eval(`document.querySelector('${d.PAGE.settingsPanel}') !== null`)) {
            await page.click('[data-testid="settings-close"]').catch(() => {});
            await d.settleDom(page, `document.querySelector('${d.PAGE.settingsPanel}') === null`, { ceilingMs: 5_000 });
        }

        // ── a split inherits it ──────────────────────────────────────────────────────
        await d.focusPaneBody(page, first);
        await press('Equal', '=');
        await press('Equal', '=');
        await press('Equal', '=');
        rec.check(`three ⌘+ give it ${String(DEFAULT_SIZE + 3)}`, await paneSizeSettlesAt(first, DEFAULT_SIZE + 3));
        const beforeSplit = await d.domPaneIDs(page);
        await press('KeyD', 'd');
        await d.settle(async () => (await d.domPaneIDs(page)).length > beforeSplit.length, { ceilingMs: 8_000 });
        const third = (await d.domPaneIDs(page)).find((paneID) => !beforeSplit.includes(paneID));
        rec.check('⌘D over the resized pane opened a third terminal', third !== undefined);
        if (third !== undefined) {
            rec.check(
                `the split starts with the same size of its own, ${String(DEFAULT_SIZE + 3)}`,
                await paneSizeSettlesAt(third, DEFAULT_SIZE + 3),
                String(await secondClientPaneSize(third))
            );
            const firstCell = await readCell(first);
            rec.check(
                'and the window draws it with the same cell as the pane it came from',
                firstCell !== null && (await cellSettles(third, (cell) => cell.height === firstCell.height && cell.width === firstCell.width)),
                `${JSON.stringify(firstCell)} vs ${JSON.stringify(await readCell(third))}`
            );
        }

        // ── it survives a daemon restart ─────────────────────────────────────────────
        if (daemon === null) {
            rec.note('attached to an instance this run does not own: the restart arm is skipped');
        } else {
            await daemon.restart();
            const reconnected = await d.settleDom(
                page,
                `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`,
                { ceilingMs: 30_000 }
            );
            rec.check('the window reconnects to the restarted daemon', reconnected);
            rec.check(
                'the restarted daemon loaded the pane with its own size',
                await paneSizeSettlesAt(first, DEFAULT_SIZE + 3, 15_000),
                String(await secondClientPaneSize(first).catch(() => 'unreadable'))
            );
            rec.check(
                'and the window draws it bigger than the pane beside it',
                await cellSettles(first, (cell) => cell.height > baselineOther.height, 20_000),
                `${String((await readCell(first))?.height ?? 0)}px vs ${String(baselineOther.height)}px`
            );
        }
    } catch (error) {
        await rec.shot(page, 'pane-text-size-failure').catch(() => {});
        throw error;
    } finally {
        // The kelpi config goes back byte for byte, so the next scenario gets the shipped scope.
        if (originalKelpi === null) fs.rmSync(sandbox.configPath, { force: true });
        else fs.writeFileSync(sandbox.configPath, originalKelpi);
        if (await page.eval(`document.querySelector('${d.PAGE.settingsPanel}') !== null`).catch(() => false)) {
            await page.click('[data-testid="settings-close"]').catch(() => {});
        }
        for (const workspace of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            if (!initialWorkspaceIDs.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        }
        if (startingWorkspace !== null) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) {
                await page.click(row).catch(() => {});
            }
        }
    }
}
