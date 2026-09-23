/**
 * The root arrangement, live: hidden bands, Zen Mode, declared band heights and the persisted
 * arrangement, driven through every route a user has onto them.
 *
 * Checks, in order:
 *
 *   1. the bundled toolbar and status bar at their own 32 and 24 px, and no strip;
 *   2. Layout Lab's three views at the 36, 22 and 180 px their manifest declares;
 *   3. ⌃⌘Return enters Zen Mode: all five bands gone, the grid is the window below the 8 px strip,
 *      the shell's PTY gained rows AND columns, the hidden plugin views are still mounted and told
 *      `visible=false`, the entry toast names the chord, and the shell hid the traffic lights;
 *   4. the recovery floor in Zen Mode: the palette, Settings (whose row says "Zen Mode") and Help;
 *   5. a palette row and ⇧⌘S act inside Zen Mode without leaving it;
 *   6. the strip's handle restores exactly the pre-Zen arrangement, the same plugin documents
 *      included, and the traffic lights come back;
 *   7. the View menu row carries ⌃⌘↩ and the NATIVE accelerator (the route that wins over a focused
 *      web page) toggles Zen Mode both ways;
 *   8. a plugin running `kelpi.zenMode.toggle` enters it, and it survives a reload;
 *   9. disabling Layout Lab with the status bar hidden leaves it hidden and puts the bundled
 *      toolbar back at 32 px; enabling brings the view back, still hidden;
 *  10. Reset Window Arrangement from Settings shows everything again;
 *  11. the phone never draws the strip, and a Zen Mode window turned phone and back is still in it.
 *
 * Every check reads the DOM, the window's own store, the CLI or the shell's log; none reads a pixel,
 * so `--window hidden` is enough to pass. Use `--window offscreen` or `onscreen` for the screenshots.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonIDFromSandbox, openPlacementSettings, phoneToLanding, restoreBundledSlots } from '../ui-audit/lib/workbench.mjs';

/*
 * `examples/plugins/layout-lab/` is the example; `plugins/` holds the arrangement model, its store,
 * the hidden slots and the Settings row; `chrome/` the strip and the dispatcher's exemption;
 * `features/` the chrome commands and palette rows; `App.tsx` the verbs, the menu relay and the
 * report; `protocol/src/plugins.ts` validates `bandHeights`, which check 2 is what would catch;
 * `shell/` owns the View rows and the traffic lights; `core/src/config/` the actions and ⌃⌘↩.
 */
export const covers = ['examples/plugins/layout-lab/', 'packages/client/src/plugins/', 'packages/client/src/chrome/',
    'packages/client/src/features/', 'packages/client/src/App.tsx', 'packages/client/src/app/', 'packages/protocol/src/plugins.ts',
    'packages/protocol/src/ws/', 'packages/daemon/src/ws/', 'packages/shell/src/titlebar.ts', 'packages/shell/src/menu.ts',
    'packages/shell/src/status.ts', 'packages/core/src/config/'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const labID = 'example.layout-lab', labPath = path.join(repoRoot, 'examples/plugins/layout-lab');
const frame = placement => `[data-workbench-slot="${placement}"] iframe`;
const STRIP_PX = 8;

export default async function ({ page, cli, sandbox, harness, shell, rec, d }) {
    await page.watchFrames();
    const MOD = d.MOD;
    const json = async args => JSON.parse(await cli.ok(args));
    const initial = new Set((await json(['workspace', 'list', '--json'])).map(workspace => workspace.id));
    const daemonID = daemonIDFromSandbox(sandbox);
    const storeKey = `kelpi.workbench.layout.v1:${String(daemonID)}`;
    const inFrame = (placement, expression) => page.evalInFrame(frame(placement), expression);
    const frameCheck = (placement, expression, ceilingMs = 12_000) => d.settle(async () => {
        try { return await inFrame(placement, expression) === true; } catch { return false; }
    }, { ceilingMs });

    /** Everything the arrangement decides, read off the window in one go. */
    const layout = () => page.eval(`(() => {
        const q = selector => document.querySelector(selector);
        const slot = placement => q('[data-workbench-slot="' + placement + '"]');
        const shown = placement => { const element = slot(placement); return !!element && getComputedStyle(element).display !== 'none'; };
        const height = element => element ? Math.round(element.getBoundingClientRect().height) : null;
        const strip = q('[data-testid="restore-strip"]');
        const grid = q('[data-testid="pane-grid"]')?.getBoundingClientRect();
        return {
            strip: strip ? strip.getAttribute('data-zen') : null,
            stripHeight: height(strip),
            nativeToolbar: height(q('[data-testid="top-bar"]')),
            nativeStatus: height(q('[data-testid="status-footer"]')),
            topbar: !!q('[data-testid="top-bar"]') || shown('topbar'),
            statusbar: !!q('[data-testid="status-footer"]') || shown('statusbar'),
            panel: shown('panel.bottom'),
            heights: { topbar: shown('topbar') ? height(slot('topbar')) : null, statusbar: shown('statusbar') ? height(slot('statusbar')) : null, panel: shown('panel.bottom') ? height(slot('panel.bottom')) : null },
            sidebar: !!q('[data-testid="sidebar-slot"]'),
            inspector: !!q('[data-testid="inspector-slot"]'),
            grid: grid ? { top: Math.round(grid.top), bottom: Math.round(grid.bottom), left: Math.round(grid.left), right: Math.round(grid.right) } : null,
            window: { width: innerWidth, height: innerHeight }
        };
    })()`);
    const settleLayout = async (predicate, label, ceilingMs = 8_000) => {
        let last = null;
        const ok = await d.settle(async () => { last = await layout(); return predicate(last); }, { ceilingMs });
        if (!ok) rec.note(`${label}: last layout ${JSON.stringify(last)}`);
        return ok;
    };
    const everyBand = state => state.topbar && state.statusbar && state.sidebar && state.strip === null;
    const zenState = state => state.strip === 'true' && !state.topbar && !state.statusbar && !state.panel && !state.sidebar && !state.inspector;
    const saved = () => page.eval(`JSON.parse(localStorage.getItem(${JSON.stringify(storeKey)}) ?? 'null')`);
    const zenChord = () => page.key('Enter', { modifiers: MOD.ctrl | MOD.meta });
    const lightLines = pattern => (shell?.lines ?? []).filter(line => pattern.test(line)).length;
    const HIDDEN_LIGHTS = /titlebar: traffic lights hidden \(report\)/, SHOWN_LIGHTS = /titlebar: traffic lights shown \(report\)/;

    /** The shell's own `stty size`, echoed past a marker so the echoed command line cannot match. */
    const shellSize = async (paneID) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const marker = `SIZE${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
            await cli.ok(['pane', 'send', '--target', paneID, `echo "${marker} $(stty size | tr ' ' '-')"`]);
            await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
            let answer = null;
            await d.settle(async () => {
                const match = new RegExp(`${marker} (\\d+)-(\\d+)`).exec(await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']));
                if (match !== null) answer = { rows: Number(match[1]), cols: Number(match[2]) };
                return answer !== null;
            }, { ceilingMs: 20_000 });
            if (answer !== null) return answer;
        }
        return null;
    };
    const settleSize = async (paneID, predicate, label) => {
        let last = null;
        const ok = await d.settle(async () => { last = await shellSize(paneID); return last !== null && predicate(last); }, { ceilingMs: 30_000 });
        if (!ok) rec.note(`${label}: the PTY never reached the expected size; last read ${JSON.stringify(last)}`);
        return last;
    };
    const closeSettings = async () => { if (await page.eval(`!!document.querySelector('[data-testid="settings-close"]')`)) await page.click('[data-testid="settings-close"]'); };
    const chooseLab = async () => {
        if (!await openPlacementSettings(page, d)) throw new Error('Settings did not open on its Plugins tab');
        for (const [slot, view] of [['topbar', 'toolbar'], ['statusbar', 'status'], ['panel.bottom', 'panel']]) await page.eval(`(() => {
            const select = document.querySelector('select[aria-label="${slot}"]'); select.value = '${labID}.${view}'; select.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        await closeSettings();
        for (const placement of ['topbar', 'statusbar', 'panel.bottom']) {
            if (!await frameCheck(placement, `document.body.dataset.ready === 'true'`)) throw new Error(`Layout Lab did not attach in ${placement}`);
        }
    };
    const menuRow = async label => d.findMenuItem((await harness.menu()).items, new RegExp(`^${label}$`));

    let workspaceID = null;
    try {
        // A battery hands this window whatever the scenario before it left; start from the default
        // arrangement through the menu row whose relay this also proves.
        await harness.menuClick({ path: ['View', 'Reset Window Arrangement'] });
        await settleLayout(everyBand, 'reset before the run');
        const created = await json(['workspace', 'create', '--name', 'Root layout', '--json']);
        workspaceID = created.workspace_id;
        const paneID = (await json(['pane', 'list', '--workspace', workspaceID, '--json']))[0].id;
        await d.settleDom(page, `document.querySelector('[data-testid="workspace-row"][data-workspace-id="${workspaceID}"][data-active="true"]')`, { ceilingMs: 10_000 });

        // 1. The bundled bars are untouched by any of this.
        const bundled = await layout();
        rec.check('the bundled toolbar and status bar keep their own 32 and 24 px, and no strip is drawn',
            bundled.nativeToolbar === 32 && bundled.nativeStatus === 24 && bundled.strip === null, JSON.stringify(bundled));

        // 2. Declared heights.
        await cli.ok(['plugin', 'install', labPath, '--trust']);
        await chooseLab();
        rec.check('Layout Lab’s three bands come up at the 36, 22 and 180 px its manifest declares',
            await settleLayout(state => state.heights.topbar === 36 && state.heights.statusbar === 22 && state.heights.panel === 180, 'declared heights'));
        await rec.shot(page, 'layout-lab-bands');

        // 3. Zen Mode on the chord.
        const before = await settleSize(paneID, () => true, 'the shell before Zen Mode');
        await inFrame('topbar', `(window.__rootLayoutMarker = 'kept', true)`);
        const hiddenLightsBefore = lightLines(HIDDEN_LIGHTS);
        await zenChord();
        rec.check('⌃⌘Return hides the toolbar, status bar, bottom panel and both sidebars and draws the strip',
            await settleLayout(zenState, 'Zen Mode on the chord'));
        const zen = await layout();
        rec.check('the grid is the whole window below the 8 px strip',
            zen.stripHeight === STRIP_PX && zen.grid !== null && Math.abs(zen.grid.top - STRIP_PX) <= 1 && Math.abs(zen.grid.bottom - zen.window.height) <= 1
                && zen.grid.left <= 1 && Math.abs(zen.grid.right - zen.window.width) <= 1, JSON.stringify(zen));
        const during = before === null ? null : await settleSize(paneID, size => size.rows > before.rows && size.cols > before.cols, 'the shell in Zen Mode');
        rec.check('the shell’s PTY gained rows and columns', before !== null && during !== null && during.rows > before.rows && during.cols > before.cols,
            `${JSON.stringify(before)} -> ${JSON.stringify(during)}`);
        rec.check('the hidden plugin views stay mounted and are told they are not visible',
            await frameCheck('topbar', `document.body.dataset.visible === 'false'`) && await frameCheck('statusbar', `document.body.dataset.visible === 'false'`)
                && await frameCheck('panel.bottom', `document.body.dataset.visible === 'false'`));
        rec.check('entering Zen Mode raises one toast naming the way out',
            await d.settleDom(page, `[...document.querySelectorAll('*')].some(element => element.children.length === 0 && /to leave Zen Mode\\./.test(element.textContent ?? ''))`));
        if (process.platform === 'darwin' && shell) {
            rec.check('the shell hid the traffic lights for the hidden toolbar',
                await d.settle(async () => lightLines(HIDDEN_LIGHTS) > hiddenLightsBefore, { ceilingMs: 8_000 }));
        } else rec.note('traffic lights: not a macOS shell, nothing to hide');
        await rec.shot(page, 'zen-mode');
        const handle = await page.box('[data-testid="restore-strip-handle"]');
        await page.mouse('mouseMoved', handle.cx, handle.cy);
        rec.check('the handle grows into a labelled button on hover',
            await d.settleDom(page, `document.querySelector('[data-testid="restore-strip-handle"]')?.getAttribute('data-expanded') === 'true'`));
        await rec.shot(page, 'zen-mode-handle');
        await page.mouse('mouseMoved', Math.round(zen.window.width / 2), Math.round(zen.window.height / 2));

        // 4. The recovery floor.
        await page.key('KeyP', { modifiers: MOD.meta });
        const palette = await d.settleDom(page, `document.querySelector('[data-testid="command-palette"]')`);
        await page.key('Escape');
        const settings = await openPlacementSettings(page, d)
            && await d.settleDom(page, `document.querySelector('[data-testid="window-arrangement-status"]')?.textContent === 'Window arrangement: Zen Mode'`);
        await closeSettings();
        await page.key('Slash', { modifiers: MOD.meta, key: '/' });
        const help = await d.settleDom(page, `document.querySelector('[data-testid="help-overlay"]')`);
        await page.key('Escape');
        await d.settleDom(page, `!document.querySelector('[data-testid="help-overlay"]')`);
        rec.check('the palette, Settings (naming Zen Mode) and Help all open in Zen Mode', palette && settings && help, JSON.stringify({ palette, settings, help }));

        // 5. Live toggles inside Zen Mode.
        await page.key('KeyP', { modifiers: MOD.meta });
        await d.settleDom(page, `document.querySelector('[data-testid="command-palette"] input')`);
        await page.insertText('Show Status Bar'); await page.key('Enter');
        await page.key('KeyS', { modifiers: MOD.meta | MOD.shift });
        rec.check('a palette row and ⇧⌘S show a band and a sidebar without leaving Zen Mode',
            await settleLayout(state => state.strip === 'true' && state.statusbar && state.sidebar && !state.topbar, 'toggles inside Zen Mode'));

        // 6. The handle restores the recorded arrangement, not the one toggled inside.
        const shownLightsBefore = lightLines(SHOWN_LIGHTS);
        await page.click('[data-testid="restore-strip-handle"]');
        rec.check('the handle restores exactly the pre-Zen arrangement',
            await settleLayout(state => everyBand(state) && state.panel && !state.inspector && state.heights.topbar === 36 && state.heights.statusbar === 22, 'after the handle'));
        rec.check('the same plugin documents come back visible, never reloaded',
            await frameCheck('topbar', `window.__rootLayoutMarker === 'kept' && document.body.dataset.visible === 'true'`)
                && await frameCheck('panel.bottom', `Number(document.body.dataset.hiddenCount) >= 1`));
        if (process.platform === 'darwin' && shell) {
            rec.check('the traffic lights came back with the toolbar', await d.settle(async () => lightLines(SHOWN_LIGHTS) > shownLightsBefore, { ceilingMs: 8_000 }));
        }

        // 7. The native View row and its accelerator.
        const row = await menuRow('Toggle Zen Mode');
        const accelerator = String(row?.accelerator ?? '');
        const parts = new Set(accelerator.toLowerCase().split('+'));
        rec.check('View ▸ Toggle Zen Mode carries ⌃⌘↩', row !== null && parts.has('control') && (parts.has('commandorcontrol') || parts.has('command') || parts.has('cmd')) && parts.has('return'), accelerator);
        await harness.press(accelerator || 'Control+CommandOrControl+Return');
        const viaMenu = await settleLayout(zenState, 'Zen Mode from the native accelerator');
        await harness.press(accelerator || 'Control+CommandOrControl+Return');
        rec.check('the native accelerator enters and leaves Zen Mode', viaMenu && await settleLayout(everyBand, 'leaving from the native accelerator'));

        // 8. A plugin runs the chrome command, and Zen Mode survives a reload.
        await inFrame('topbar', `(document.querySelector('[data-command="kelpi.zenMode.toggle"]').click(), true)`);
        rec.check('a plugin running kelpi.zenMode.toggle enters Zen Mode', await settleLayout(zenState, 'Zen Mode from Layout Lab'));
        await page.send('Page.reload');
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 20_000 });
        const reloaded = await settleLayout(zenState, 'Zen Mode after a reload', 15_000);
        const store = await saved();
        rec.check('Zen Mode survives a reload from the window’s own store', reloaded && store?.zenSnapshot?.topbar === true, JSON.stringify(store));
        await zenChord();
        await settleLayout(everyBand, 'leaving after the reload');

        // 9. The arrangement is not the plugin's.
        await harness.menuClick({ path: ['View', 'Toggle Status Bar'] });
        await settleLayout(state => !state.statusbar, 'status bar hidden from the menu');
        await cli.ok(['plugin', 'disable', labID]);
        rec.check('disabling Layout Lab leaves the status bar hidden and puts the bundled toolbar back at 32 px',
            await settleLayout(state => state.nativeToolbar === 32 && !state.statusbar && !state.panel, 'after disable'));
        await cli.ok(['plugin', 'enable', labID]);
        rec.check('enabling it brings the views back, the status bar still hidden',
            await frameCheck('topbar', `document.body.dataset.ready === 'true'`, 15_000) && await settleLayout(state => state.heights.topbar === 36 && !state.statusbar, 'after enable'));

        // 10. Reset from Settings.
        await harness.menuClick({ path: ['View', 'Toggle Toolbar'] });
        await settleLayout(state => state.strip === 'false', 'toolbar hidden from the menu');
        await openPlacementSettings(page, d);
        const described = await d.settleDom(page, `document.querySelector('[data-testid="window-arrangement-status"]')?.textContent === 'Window arrangement: toolbar hidden, status bar hidden'`);
        // The row sits below a long Workbench views list, and a click lands where the box IS.
        await page.eval(`document.querySelector('[data-testid="reset-window-arrangement"]')?.scrollIntoView({ block: 'center' })`);
        await page.click('[data-testid="reset-window-arrangement"]');
        const reset = await d.settleDom(page, `document.querySelector('[data-testid="window-arrangement-status"]')?.textContent === 'Window arrangement: every band shown'`);
        await closeSettings();
        const restored = await settleLayout(state => everyBand(state) && state.panel, 'after the reset');
        rec.check('Settings names what is hidden and Reset Window Arrangement shows it all', described && reset && restored, JSON.stringify({ described, reset, restored }));

        // 11. The phone.
        await zenChord();
        await settleLayout(zenState, 'Zen Mode before the phone');
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const phone = await d.settleDom(page, `document.querySelector('[data-testid="phone-shell"]') && !document.querySelector('[data-testid="restore-strip"]')`, { ceilingMs: 10_000 });
        if (!await phoneToLanding(page, d, { note: rec.note })) rec.note('the phone shell did not return to its landing page');
        await page.send('Emulation.clearDeviceMetricsOverride');
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        rec.check('the phone never draws the strip, and the desktop comes back still in Zen Mode', phone && await settleLayout(zenState, 'back from the phone', 10_000));
        await zenChord();
        await settleLayout(everyBand, 'leaving Zen Mode at the end');
        await rec.shot(page, 'restored');
    } catch (error) { await rec.shot(page, 'failure-live'); throw error; }
    finally {
        const safely = async (what, step) => {
            try { await step(); } catch (error) { rec.note(`cleanup: ${what}: ${error instanceof Error ? error.message : String(error)}`); }
        };
        await safely('device metrics are cleared', () => page.send('Emulation.clearDeviceMetricsOverride'));
        await safely('touch emulation is cleared', () => page.send('Emulation.setTouchEmulationEnabled', { enabled: false }));
        await safely('the window arrangement goes back to the default', () => harness.menuClick({ path: ['View', 'Reset Window Arrangement'] }));
        await safely('the three bands go back to bundled', async () => {
            const restored = await restoreBundledSlots(page, d, { topbar: 'kelpi.topbar', statusbar: 'kelpi.statusbar', 'panel.bottom': '' }, { daemonID });
            if (!restored.ok) rec.note(`cleanup: the band placements were not restored: ${String(restored.detail)}`);
        });
        await safely('the Settings overlay is closed', closeSettings);
        await cli.run(['plugin', 'remove', labID]);
        for (const workspace of await json(['workspace', 'list', '--json'])) if (!initial.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
    }
}
