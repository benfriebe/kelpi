/**
 * `copy-on-select` (terminal-surface.md section 12.1) and `middle-click-paste` (section 12.2),
 * pressed for real: the Settings ▸ Workspaces ▸ Panes toggles write the kelpi config keys, and a
 * real mouse drag and a real middle-click in a real pane then do or do not reach the clipboard
 * and the program in the pane.
 *
 * The instruments, none of which a toggle merely moving can satisfy:
 *
 *   1. **the daemon's kelpi config**, read as bytes: the click wrote `copy-on-select = false`;
 *   2. **a page-local clipboard sink**: `navigator.clipboard.writeText` and `readText` are replaced
 *      for this page only, so a write is counted rather than landing on the owner's pasteboard,
 *      and a paste that read the clipboard would type the sink's marker instead of the selection;
 *   3. **`data-terminal-selection`**: the pane's own report of the engine's selection length, so
 *      "nothing was copied" cannot be "nothing was selected";
 *   4. **⌘C**: with copy-on-select off it is the copy that is left, and it must still work;
 *   5. **the program's own stdin**: the fixture appends every byte it reads to a file, so a
 *      middle-click paste is measured where it lands, through the daemon's paste pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';

export const covers = [
    'vendor/ghostty-web-patched',
    'packages/client/src/features/TerminalFeaturePane.tsx',
    'packages/client/src/settings/sections.ts',
    'packages/client/src/settings/WorkspacesTab.tsx',
    'packages/client/src/state/store.ts',
    'packages/client/src/state/settings.test.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/terminal/renderer.ts',
    'packages/client/src/terminal/copy-on-select.wasm.test.ts',
    'packages/client/src/terminal/selection-buffer.ts',
    'packages/client/src/app/terminal-shortcuts.tsx'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const key = `__kelpiCopyOnSelect_${Date.now()}`;
    const ref = `window[${JSON.stringify(key)}]`;
    const readKelpi = () => (fs.existsSync(sandbox.configPath) ? fs.readFileSync(sandbox.configPath, 'utf8') : null);
    const originalKelpi = readKelpi();
    /** The daemon's own answer: the last line for `key` in its config, or null for absent. */
    const configured = (key) =>
        [...(readKelpi() ?? '').matchAll(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(\\S+)[ \\t]*$`, 'gm'))].at(-1)?.[1] ?? null;
    const start = JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((w) => w.is_active)?.id;
    const alpha = `ALPHA-${TAG}`;
    const bravo = `BRAVO-${TAG}`;
    const received = path.join(sandbox.root, `copy-on-select-${TAG}.stdin`);
    const readReceived = () => (fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '');
    let workspaceID;

    /** Open Settings ▸ Workspaces, set one toggle, and wait for the file AND the switch to agree. */
    const setToggle = async (key, enabled) => {
        const toggle = `[data-testid="${key}-toggle"]`;
        await d.openSettingsTab(page, 'workspaces');
        if (!(await d.settleDom(page, `document.querySelector('${toggle}')`, { ceilingMs: 8_000 }))) {
            throw new Error(`Settings ▸ Workspaces has no ${key} toggle`);
        }
        await page.eval(`document.querySelector('${toggle}')?.scrollIntoView({ block: 'center' })`);
        await sleep(200);
        if ((await page.eval(`document.querySelector('${toggle}').checked`)) !== enabled) await page.click(toggle);
        rec.check(
            `the toggle writes ${key} = ${String(enabled)} to the daemon's config`,
            await d.settle(() => configured(key) === String(enabled), { ceilingMs: 8_000, intervalMs: 80 }),
            String(configured(key))
        );
        // The switch moves only when the daemon's snapshot says so, which is also what the pane reads.
        rec.check(
            `and the switch follows the daemon's snapshot (${enabled ? 'on' : 'off'})`,
            await d.settleDom(page, `document.querySelector('${toggle}')?.checked === ${String(enabled)}`, { ceilingMs: 8_000 })
        );
        await page.click('[data-testid="settings-close"]').catch(() => {});
        await d.settleDom(page, `document.querySelector('${d.PAGE.settingsPanel}') === null`, { ceilingMs: 5_000 });
    };

    try {
        await page.eval(`(() => {
            const clipboard = navigator.clipboard;
            const state = {
                clipboard, text: null, writes: 0, reads: 0,
                descriptors: { writeText: Object.getOwnPropertyDescriptor(clipboard, 'writeText'), readText: Object.getOwnPropertyDescriptor(clipboard, 'readText') }
            };
            ${ref} = state;
            Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async text => {
                state.text = String(text); state.writes++;
            } });
            Object.defineProperty(clipboard, 'readText', { configurable: true, value: async () => {
                state.reads++; return 'CLIPBOARD-SINK';
            } });
        })()`);
        workspaceID = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Copy on select', '--path', sandbox.root, '--json'])).workspace_id;
        const paneID = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']))[0].id;
        const root = `[data-pane-id="${paneID}"][data-terminal-status]`;
        if (!(await d.settleDom(page, `document.querySelector('${root}')?.getAttribute('data-terminal-status') === 'live'`))) {
            throw new Error('terminal did not start');
        }

        // Two known words at the top-left of a cleared screen, and no mouse reporting, so a plain
        // drag selects. The fixture holds the screen still until ^C, writing nothing back, and
        // appends every byte it reads to a file.
        const fixture = path.join(sandbox.root, 'copy-on-select.mjs');
        fs.writeFileSync(fixture, `
import fs from 'node:fs';
process.stdin.setRawMode(true);
process.stdout.write('\\x1bc\\x1b[3J' + ${JSON.stringify(alpha)} + '\\r\\n' + ${JSON.stringify(bravo)} + '\\r\\n');
process.stdin.on('data', data => {
    fs.appendFileSync(${JSON.stringify(received)}, data);
    if (data.includes(3)) process.exit(0);
});
`);
        await cli.ok(['pane', 'send', '--target', paneID, `exec ${quote(process.execPath)} ${quote(fixture)}`]);
        if (!(await d.settle(async () => (await cli.ok(['pane', 'capture', '--target', paneID])).includes(bravo)))) {
            throw new Error('fixture output did not arrive');
        }
        await sleep(300);
        const grid = await page.eval(`(() => {
            const r = document.querySelector('${root}'), c = r.querySelector('canvas');
            const b = c.getBoundingClientRect(), cell = r.getAttribute('data-terminal-cell').split('x').map(Number);
            return { x: b.x, y: b.y, cw: cell[0], ch: cell[1] };
        })()`);
        /** Drag across one row's word, by cells, and let go on the canvas. */
        const dragRow = async (row, length) => {
            const from = { x: grid.x + grid.cw * 0.5, y: grid.y + grid.ch * (row + 0.5) };
            const to = { x: grid.x + grid.cw * (length - 0.5), y: from.y };
            await page.mouse('mousePressed', from.x, from.y, { button: 'left' });
            try {
                await sleep(80);
                await page.mouse('mouseMoved', to.x, to.y, { buttons: 1 });
                await sleep(80);
            } finally {
                await page.mouse('mouseReleased', to.x, to.y, { button: 'left' });
            }
        };
        const selected = () => page.eval(`Number(document.querySelector('${root}').getAttribute('data-terminal-selection'))`);
        /** A middle press and release over the pane, as a mouse makes them. */
        const middleClick = async () => {
            const at = { x: grid.x + grid.cw * 10.5, y: grid.y + grid.ch * 5.5 };
            await page.mouse('mousePressed', at.x, at.y, { button: 'middle', buttons: 4 });
            await sleep(40);
            await page.mouse('mouseReleased', at.x, at.y, { button: 'middle', buttons: 0 });
        };

        // ── copy-on-select off ───────────────────────────────────────────────────────
        await setToggle('copy-on-select', false);
        await rec.shot(page, 'copy-on-select-off');
        await page.eval(`${ref}.text = null; ${ref}.writes = 0`);
        await dragRow(0, alpha.length);
        rec.check(
            'with it off, a drag still selects the word',
            await d.settle(async () => (await selected()) === alpha.length, { ceilingMs: 5_000 }),
            String(await selected())
        );
        await sleep(300);
        rec.check('and nothing is written to the clipboard', (await page.eval(`${ref}.writes`)) === 0, String(await page.eval(`${ref}.text`)));
        await page.key('KeyC', { key: 'c', modifiers: d.MOD.meta });
        rec.check(
            '⌘C copies the selection that copy-on-select left alone',
            await d.settle(async () => (await page.eval(`${ref}.text`)) === alpha, { ceilingMs: 5_000 }),
            JSON.stringify(await page.eval(`${ref}.text`))
        );

        // ── middle-click paste, with copy-on-select still off ────────────────────────
        // The clipboard holds ALPHA (the ⌘C above). Select BRAVO, which copy-on-select leaves off
        // the clipboard, and middle-click: the program must receive BRAVO, the selection.
        await page.eval(`${ref}.writes = 0; ${ref}.reads = 0`);
        await dragRow(1, bravo.length);
        await d.settle(async () => (await selected()) === bravo.length, { ceilingMs: 5_000 });
        const before = readReceived();
        await middleClick();
        rec.check(
            'middle-click pastes the last selection into the program, not the clipboard',
            await d.settle(() => readReceived().slice(before.length).includes(bravo), { ceilingMs: 8_000, intervalMs: 80 }),
            JSON.stringify(readReceived().slice(before.length))
        );
        rec.check(
            'and neither read nor wrote the clipboard to do it',
            (await page.eval(`${ref}.writes`)) === 0 && (await page.eval(`${ref}.reads`)) === 0,
            `writes ${String(await page.eval(`${ref}.writes`))}, reads ${String(await page.eval(`${ref}.reads`))}`
        );
        await setToggle('middle-click-paste', false);
        const quiet = readReceived();
        await middleClick();
        await sleep(600);
        rec.check('with middle-click paste off, a middle-click types nothing', readReceived() === quiet, JSON.stringify(readReceived().slice(quiet.length)));
        await setToggle('middle-click-paste', true);

        // ── copy-on-select on again ──────────────────────────────────────────────────
        await setToggle('copy-on-select', true);
        await page.eval(`${ref}.text = null; ${ref}.writes = 0`);
        await dragRow(0, alpha.length);
        rec.check(
            'with it back on, the release copies the drag by itself',
            await d.settle(async () => (await page.eval(`${ref}.text`)) === alpha, { ceilingMs: 5_000 }),
            JSON.stringify(await page.eval(`${ref}.text`))
        );
    } finally {
        try {
            if (workspaceID) await cli.ok(['workspace', 'delete', workspaceID, '--force']);
        } finally {
            if (originalKelpi === null) fs.rmSync(sandbox.configPath, { force: true });
            else fs.writeFileSync(sandbox.configPath, originalKelpi);
            await page.eval(`(() => { const state = ${ref}; if (!state) return;
                for (const [name, descriptor] of Object.entries(state.descriptors)) {
                    if (descriptor) Object.defineProperty(state.clipboard, name, descriptor);
                    else delete state.clipboard[name];
                }
                delete ${ref};
            })()`);
            if (start) {
                const row = `[data-testid="workspace-row"][data-workspace-id="${start}"]`;
                if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`)) await page.click(row);
            }
        }
    }
}
