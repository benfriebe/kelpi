/**
 * ⌘= / ⌘- / ⌘0 over a focused terminal change the DAEMON-WIDE terminal text size (#175).
 *
 * The report was "⌘+ and ⌘- do not change the terminal text size". The cause was that there was
 * no terminal font-size action at all: the three chords resolved to the markdown preview's own
 * font size, whose handler declines for a terminal and lets the keystroke fall through, to
 * nothing, because ghostty-web's input handler `preventDefault`s every mapped chord, so even the
 * browser's zoom never fired. The owner's scope decision (2026-09-15) is that terminal text size
 * stays ONE setting per daemon (the ghostty `font-size` Settings ▸ Appearance already writes)
 * and the chords become three ordinary actions that change it through the ordinary settings
 * write. config-keybindings.md §7.6.
 *
 * Only a live window can answer this, and the instruments are chosen so that none of them can be
 * satisfied by the chord merely being consumed:
 *
 *   1. **the daemon's file**: `~/.config/ghostty/config` in the sandbox, read as bytes. This is
 *      the setting itself, and the only thing that makes the change daemon-wide;
 *   2. **the measured cell**: `data-terminal-cell`, which the pane publishes from what the
 *      ENGINE measured after the font changed, not from what was asked for;
 *   3. **`stty size` inside the shell**: the process's own answer, through a real SIGWINCH. A
 *      bigger cell in the same box is fewer columns, and nothing but a real reflow produces it;
 *   4. **the other pane**: a second terminal that was never focused and never pressed. Its cell
 *      grows too, which is what "daemon-wide" means and what a per-pane or per-viewer
 *      implementation would fail;
 *   5. **the Appearance row**: the slider the setting belongs to, showing the same number.
 *
 * There is no `kelpi settings` read in the CLI (the CLI has no settings verbs at all), so item 1
 * is the daemon's own store for this key and item 4 is the second reader.
 */

import fs from 'node:fs';

export const covers = [
    'packages/core/src/config/actions.ts',
    'packages/core/src/config/bindings.ts',
    'packages/client/src/settings/contract.ts',
    'packages/client/src/settings/surface.ts',
    'packages/client/src/settings/sections.ts',
    'packages/client/src/settings/catalog.ts',
    'packages/client/src/chrome/keys.ts',
    'packages/client/src/App.tsx',
    'packages/shell/src/menu.ts'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
/** The Appearance row's own numbers (`settings/sections.ts`), restated so a drift is visible. */
const DEFAULT_SIZE = 13;
const MIN_SIZE = 8;

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    const originalGhostty = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initialWorkspaceIDs = new Set(startingWorkspaces.map((workspace) => workspace.id));

    /** The daemon's own answer: the `font-size` line in the file it writes, or null for absent. */
    const configuredSize = () => {
        const match = /^[ \t]*font-size[ \t]*=[ \t]*([\d.]+)[ \t]*$/m.exec(
            fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8')
        );
        return match === null ? null : Number(match[1]);
    };
    const sizeSettlesAt = async (want, ceilingMs = 8_000) =>
        await d.settle(() => configuredSize() === want, { ceilingMs, intervalMs: 60 });

    const paneRoot = (paneID) => `[data-pane-id="${paneID}"][data-terminal-status]`;
    /** What the ENGINE measured, after the fact: the cell the pane publishes on its root. */
    const readCell = async (paneID) =>
        await page.eval(
            `(() => {
                const root = document.querySelector('${paneRoot(paneID)}');
                if (root === null) return null;
                const cell = (root.getAttribute('data-terminal-cell') ?? '').split('x');
                return { width: Number(cell[0] ?? 0), height: Number(cell[1] ?? 0) };
            })()`
        );
    const cellGrowsFrom = async (paneID, before, ceilingMs = 8_000) =>
        await d.settle(async () => ((await readCell(paneID))?.height ?? 0) > before.height, { ceilingMs, intervalMs: 80 });

    /**
     * The shell's OWN answer to how wide its PTY is: `stty size`, through the daemon.
     *
     * The shape is `plugin-pane-chrome.mjs`'s, verbatim, and it is deliberate: the command line
     * is ECHOED into the same scrollback the answer lands in, so `tr ' ' '-'` is what lets the
     * marker plus two numbers match the ANSWER and never the echo. It is a real SIGWINCH
     * measurement rather than a DOM readout: what the process inside the pane believes.
     */
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

    const press = async (code, key, { shift = false } = {}) => {
        await page.key(code, { modifiers: d.MOD.meta | (shift ? d.MOD.shift : 0), key });
        await sleep(120);
    };

    try {
        // ── a workspace of its own, with two terminals ──────────────────────────────
        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', `TextSize-${TAG}`, '--json']));
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
        const panes = await d.domPaneIDs(page);
        const other = panes.find((paneID) => paneID !== first);
        if (other === undefined) return;

        // The caret goes back to the pane the chords are aimed at. A focus CLICK, so the state
        // under test is the shipped one: a terminal host holding the caret, which is the very
        // case the plain "is this a text field" test used to get wrong (it is contenteditable).
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
        const baselineShell = await shellSize(first, 'the focused pane');
        rec.check('the shell reports its PTY size before anything moves', baselineShell !== null, JSON.stringify(baselineShell));
        rec.note(`baseline: cell ${JSON.stringify(baselineCell)} · stty ${JSON.stringify(baselineShell)} · config ${String(configuredSize())}`);

        // ── ⌘+ ───────────────────────────────────────────────────────────────────────
        await press('Equal', '=');
        const stepped = await sizeSettlesAt(DEFAULT_SIZE + 1);
        rec.check(
            `⌘+ stepped the daemon's own font-size to ${String(DEFAULT_SIZE + 1)}`,
            stepped,
            `the ghostty config says ${String(configuredSize())}`
        );
        const grew = await cellGrowsFrom(first, baselineCell);
        const grownCell = await readCell(first);
        rec.check(
            'the terminal the chord was pressed over measured a bigger cell',
            grew,
            `${String(baselineCell.height)}px → ${String(grownCell?.height ?? 0)}px`
        );
        const grewElsewhere = await cellGrowsFrom(other, baselineOther);
        rec.check(
            'so did the pane nobody pressed anything over: the setting is the DAEMON’s, not the pane’s',
            grewElsewhere,
            `${String(baselineOther.height)}px → ${String((await readCell(other))?.height ?? 0)}px`
        );
        await sleep(600);
        const grownShell = await shellSize(first, 'the focused pane after ⌘+');
        rec.check(
            'the process inside the pane was told about it: `stty size` reports fewer columns',
            grownShell !== null && baselineShell !== null && grownShell.cols < baselineShell.cols,
            `${String(baselineShell?.cols)} cols → ${String(grownShell?.cols)} cols (rows ${String(baselineShell?.rows)} → ${String(grownShell?.rows)})`
        );

        // ── ⌘- ───────────────────────────────────────────────────────────────────────
        await press('Minus', '-');
        rec.check(
            `⌘- stepped it back to ${String(DEFAULT_SIZE)}`,
            await sizeSettlesAt(DEFAULT_SIZE),
            `the ghostty config says ${String(configuredSize())}`
        );
        const backCell = await d.settle(
            async () => ((await readCell(first))?.height ?? 0) === baselineCell.height,
            { ceilingMs: 8_000, intervalMs: 80 }
        );
        rec.check('and the cell came back to the size it started at', backCell, JSON.stringify(await readCell(first)));

        // ── ⌘+ held, then ⌘0 ────────────────────────────────────────────────────────
        //
        // Four presses in a row with nothing acknowledged between them: the repeat is the case a
        // step computed from the daemon's last broadcast gets wrong: all four would ask for the
        // same 14 and the write queue would collapse them into one step.
        for (let repeat = 0; repeat < 4; repeat += 1) await press('Equal', '=');
        rec.check(
            `four ⌘+ in a row land four steps (${String(DEFAULT_SIZE)} → ${String(DEFAULT_SIZE + 4)}), not one`,
            await sizeSettlesAt(DEFAULT_SIZE + 4, 12_000),
            `the ghostty config says ${String(configuredSize())}`
        );
        // ⌘⇧= is ⌘+ on a US layout, and is the second default trigger for the same action.
        await press('Equal', '+', { shift: true });
        rec.check(
            '⌘⇧= is the same chord: a shifted `=` steps once more',
            await sizeSettlesAt(DEFAULT_SIZE + 5, 12_000),
            `the ghostty config says ${String(configuredSize())}`
        );

        await press('Digit0', '0');
        rec.check(
            `⌘0 put it back to the shipped default (${String(DEFAULT_SIZE)})`,
            await sizeSettlesAt(DEFAULT_SIZE, 12_000),
            `the ghostty config says ${String(configuredSize())}`
        );

        // A bound is a no-op, not an error: nothing written, and no toast to read.
        const beforeFloor = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
        for (let repeat = 0; repeat < DEFAULT_SIZE - MIN_SIZE + 3; repeat += 1) await press('Minus', '-');
        await d.settle(() => configuredSize() === MIN_SIZE, { ceilingMs: 12_000, intervalMs: 60 });
        await sleep(800);
        const toast = String(await page.eval(`(document.querySelector('[data-testid="toast-stack"]')?.textContent ?? '')`));
        rec.check(
            `⌘- stops at the row's own minimum (${String(MIN_SIZE)}) and raises nothing`,
            configuredSize() === MIN_SIZE && !/font|size/i.test(toast),
            `config ${String(configuredSize())} · toasts ${JSON.stringify(toast.slice(0, 200))} · was ${JSON.stringify(beforeFloor.slice(0, 80))}`
        );
        await press('Digit0', '0');
        rec.check('⌘0 comes back from the floor too', await sizeSettlesAt(DEFAULT_SIZE, 12_000), String(configuredSize()));

        // ── the Appearance row agrees ────────────────────────────────────────────────
        //
        // Pressed once more first, so the row is showing a value that is NOT the default: a row
        // that had failed to follow the setting would read 13 and pass by accident.
        await press('Equal', '=');
        rec.check('one more ⌘+ before reading the slider', await sizeSettlesAt(DEFAULT_SIZE + 1, 12_000), String(configuredSize()));
        await d.openSettingsTab(page, 'appearance');
        const rowValue = await d.settle(
            async () =>
                (await page.eval(
                    `document.querySelector('[data-testid="terminal-font-size-slider"]')?.value === '${String(DEFAULT_SIZE + 1)}'`
                )) === true,
            { ceilingMs: 8_000 }
        );
        const readout = String(
            await page.eval(`(document.querySelector('[data-testid="terminal-font-size"]')?.textContent ?? '')`)
        );
        rec.check(
            'Settings ▸ Appearance ▸ Font size is showing the very number the chord wrote',
            rowValue && readout.includes(`${String(DEFAULT_SIZE + 1)}px`),
            `slider ${String(await page.eval(`document.querySelector('[data-testid="terminal-font-size-slider"]')?.value ?? null`))} · row text ${JSON.stringify(readout.trim())}`
        );
        // The tab opens at the theme gallery, and a shot of the gallery would not show the claim.
        await page.eval(
            `document.querySelector('[data-testid="terminal-font-size"]')?.scrollIntoView({ block: 'center' })`
        );
        await sleep(300);
        await rec.shot(page, 'appearance-row-follows-the-chord');
        rec.note(
            `EYES - the screenshot above: the Settings window on Appearance, the Terminal card's "Font size" slider reading ${String(DEFAULT_SIZE + 1)}px, which is the value ⌘+ just wrote to the daemon's ghostty config.`
        );
        await page.click('[data-testid="settings-close"]');
        await d.settle(async () => (await page.eval(`document.querySelector('${d.PAGE.settingsPanel}') === null`)) === true, {
            ceilingMs: 6_000
        });

        // ── and nothing at all while a chrome text field has the caret ───────────────
        //
        // The sidebar filter is chrome text: a ⌘- typed there is a `-`, not a resize. This is
        // the rule that keeps these three out of `MENU_BAR_ACTIONS` (config-keybindings.md §7.6),
        // and it is asserted on the BYTES of the file so a write of the same value would show.
        await page.click('[data-testid="sidebar-filter"]');
        await sleep(250);
        const focusedFilter = await page.eval(
            `document.activeElement?.getAttribute('data-testid') === 'sidebar-filter'`
        );
        rec.check('the sidebar filter has the caret', focusedFilter === true);
        const beforeTyping = fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8');
        await press('Minus', '-');
        await press('Equal', '=');
        await press('Digit0', '0');
        await sleep(1_200);
        rec.check(
            'the three chords write nothing while a chrome text field owns the keyboard',
            fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8') === beforeTyping,
            `config ${String(configuredSize())}, was ${String(DEFAULT_SIZE + 1)}`
        );
        await page.eval(`document.querySelector('[data-testid="sidebar-filter"]')?.blur()`);
        await d.focusPaneBody(page, first);
        await rec.shot(page, 'two-panes-at-the-stepped-size');
        rec.note(
            `EYES - the screenshot above: the two terminal panes of workspace TextSize-${TAG}, both drawn at ${String(DEFAULT_SIZE + 1)}px, the one the chords were pressed over and the one that was never touched, because the size belongs to the daemon.`
        );
    } catch (error) {
        await rec.shot(page, 'terminal-text-size-failure').catch(() => {});
        throw error;
    } finally {
        /*
         * The ghostty config goes back BYTE FOR BYTE, and first: every pane in the sandbox is
         * drawing at whatever this scenario left in it, and the next scenario in the battery
         * measures panes (#205 ▸ cleanup discipline). The daemon watches the file, so the write
         * is also what puts the running panes back.
         */
        fs.writeFileSync(sandbox.ghosttyConfigPath, originalGhostty);
        await d.settle(() => fs.readFileSync(sandbox.ghosttyConfigPath, 'utf8') === originalGhostty, { ceilingMs: 3_000 });
        await sleep(600);
        if (await page.eval(`document.querySelector('${d.PAGE.settingsPanel}') !== null`)) {
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
