/**
 * #81: ⌘C copies the terminal selection, ⌘V pastes into the focused pane, and Shift+drag is
 * the only way to select while an application owns the mouse.
 *
 * terminal-surface.md sections 12.1 and 12.2, config-keybindings.md section 4.
 *
 * The user's report is "I can't copy text from a terminal session and paste into another one
 * (but sometimes I can?)". The "sometimes" was copy-on-select: the engine copies on mouse-up and
 * that was the only copy path in the app, so ⌘C fell to the Edit menu's Copy over the hidden
 * textarea's empty DOM selection and the clipboard kept whatever it already held.
 *
 * **The poison is the whole instrument.** Copy-on-select has already put the selection on the
 * clipboard by the time the drag ends, so "the clipboard holds the selection" proves nothing on
 * its own. So the clipboard is overwritten with a sentinel AFTER the drag and BEFORE ⌘C: only a
 * real copy can put the selection back. On the shipped tree the sentinel survives.
 *
 * It is also the double-fire test for the native Edit menu (#47): an Edit ▸ Copy that fired
 * alongside this action would copy the empty textarea selection and leave the clipboard holding
 * the sentinel, which is indistinguishable from no copy at all and fails the same assertion.
 */

/**
 * The source this presses (ui-audit/README.md ▸ The rule). `clipboard.ts` is the two actions'
 * decisions, `pane-registry.ts` the live selection read they depend on, `bindings.ts` the two
 * default triggers, and `App.tsx` the wiring plus the clipboard resolution order.
 */
export const covers = [
    'packages/client/src/app/clipboard.ts',
    'packages/client/src/terminal/pane-registry.ts',
    'packages/core/src/config/bindings.ts',
    'packages/client/src/App.tsx'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const MARK = `KELPI-COPY-${TAG}`;
const LINE = `${MARK}-0123456789ABCDEF`;
const POISON = `KELPI-POISON-${TAG}`;

export default async function ({ page, harness, cli, rec, d, sleep }) {
    /*
     * The workspace this scenario opens for itself goes when this scenario does. In a battery every
     * scenario shares one sandbox, and a workspace left behind is not inert: it changes what
     * `Default` holds, it moves every later workspace's ⌘-digit ordinal, and it leaves the window
     * looking somewhere its successor did not choose (#205 ▸ cleanup discipline).
     */
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initialWorkspaceIDs = new Set(startingWorkspaces.map((workspace) => workspace.id));
    try {
        /*
         * A workspace of this scenario's own, for the reason `workspace-switch-keeps-the-caret.mjs`
         * says out loud: "Default holds when this starts is whatever the scenarios before it left
         * there." The battery runs every scenario against ONE sandbox, and by the time this one runs
         * five earlier scenarios have split panes into Default. This file wants exactly two panes,
         * finds pane A as `domPaneIDs()[0]` and pane B as "the one that is not A", and both of those
         * are wrong in a workspace full of other people's panes: A is narrower than the 25 columns
         * the drag below sweeps, so ⌘C copies one character, and "not A" is as likely to be a pane
         * some other scenario left running as it is the ⌘D split.
         *
         * `workspace create` reveals the new workspace to every client, so the window is on it by the
         * time the settle below returns, and it starts with exactly one pane.
         */
        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', `Copy-${TAG}`, '--json']));
        const workspaceID = created.workspace_id ?? created.id;
        rec.check('a workspace of its own to copy in', typeof workspaceID === 'string', JSON.stringify(created));
        if (typeof workspaceID !== 'string') return;
        await d.settleDom(page, `document.querySelector('[data-workspace-id="${workspaceID}"]')`, { ceilingMs: 10_000 });
        await d.settle(async () => (await d.domPaneIDs(page)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });

        const paneA = (await d.domPaneIDs(page))[0];
        rec.check('a terminal pane to copy from', paneA !== undefined);
        if (paneA === undefined) return;

        const rootFor = (paneID) => `[data-pane-id="${paneID}"][data-terminal-status]`;
        const readGrid = async (paneID) =>
            await page.eval(
                `(() => {
                    const root = document.querySelector('${rootFor(paneID)}');
                    if (root === null) return null;
                    const host = root.querySelector('[data-terminal-host]');
                    const target = host?.querySelector('canvas') ?? host ?? root;
                    const rect = target.getBoundingClientRect();
                    const cell = (root.getAttribute('data-terminal-cell') ?? '').split('x');
                    return {
                        x: rect.x, y: rect.y,
                        cellWidth: Number(cell[0] ?? 0), cellHeight: Number(cell[1] ?? 0),
                        mouse: root.getAttribute('data-terminal-mouse'),
                        selection: Number(root.getAttribute('data-terminal-selection') ?? 0)
                    };
                })()`
            );
        const selectionLength = async (paneID) => (await readGrid(paneID))?.selection ?? 0;
        /*
         * The clipboard is reached through the SHELL, not through the page (#109).
         *
         * `navigator.clipboard.readText` / `writeText` throw `NotAllowedError: Document is not
         * focused` the instant the window is not focused, and this file runs in a battery whose
         * earlier scenarios blur and hide the window on purpose (`dock-bounce-stop-only`), on a
         * machine whose owner is clicking other things. What is under test is which text ends up on
         * the pasteboard, not whether the renderer was allowed to look; the harness ops are
         * Electron's `clipboard` in the main process, the SAME NSPasteboard with no focus rule on
         * it, so every assertion below reads exactly what it read before.
         */
        const readClipboard = async () => String((await harness.clipboardRead()).text);
        /** Seeds the pasteboard and answers with it read back, so the write is proven, not assumed. */
        const writeClipboard = async (text) => String((await harness.clipboardWrite(text)).text);
        const capture = async (paneID) => await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
        const captureUntil = async (paneID, predicate, ceilingMs = 2_500) => {
            const deadline = Date.now() + ceilingMs;
            let text = '';
            do {
                text = await capture(paneID);
                if (predicate(text)) return text;
                await sleep(120);
            } while (Date.now() < deadline);
            return text;
        };

        // ── a second pane to paste into ────────────────────────────────────────────────
        await d.focusPaneBody(page, paneA);
        const before = await d.domPaneIDs(page);
        await page.key('KeyD', { modifiers: d.MOD.meta, key: 'd' });
        const split = await d.settle(async () => (await d.domPaneIDs(page)).length > before.length, { ceilingMs: 8_000 });
        rec.check('⌘D gave us a second pane to paste into', split);
        if (!split) return;
        // The pane ⌘D built, named by the set difference rather than by "the one that is not A":
        // a workspace can hold more than two panes and only one of them is this scenario's.
        const paneB = (await d.domPaneIDs(page)).find((id) => !before.includes(id));
        rec.note(`pane A ${String(paneA)} -> pane B ${String(paneB)}`);

        // ── pane A: printed text, then a real drag over it ─────────────────────────────
        await d.focusPaneBody(page, paneA);
        await d.runInTerminal(page, 'clear', { settleMs: 500 });
        await d.runInTerminal(page, `for i in 1 2 3 4 5 6 7 8; do echo "${LINE}"; done`, { settleMs: 900 });
        await captureUntil(paneA, (text) => text.includes(LINE));

        const grid = await readGrid(paneA);
        if (grid === null || !(grid.cellWidth > 0) || !(grid.cellHeight > 0)) {
            rec.check('the pane publishes its cell metrics (data-terminal-cell)', false, JSON.stringify(grid));
            return;
        }
        /** Pixel at the CENTRE of a zero-based cell, so rounding can never straddle. */
        const at = (col, row) => ({
            x: grid.x + grid.cellWidth * (col + 0.5),
            y: grid.y + grid.cellHeight * (row + 0.5)
        });
        /** Row 3 is inside the eight printed lines on any pane height. */
        const dragAlongRow3 = async (modifiers = 0) => {
            const from = at(0, 3);
            const to = at(24, 3);
            await page.mouse('mouseMoved', from.x, from.y, { button: 'none', buttons: 0, modifiers });
            await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1, modifiers });
            // DURATION-ASSERTION: the drag has to be a drag. A press and release in the same tick is
            // a click, and a click selects nothing.
            await sleep(120);
            await page.mouse('mouseMoved', at(12, 3).x, at(12, 3).y, { button: 'left', buttons: 1, modifiers });
            await sleep(80);
            await page.mouse('mouseMoved', to.x, to.y, { button: 'left', buttons: 1, modifiers });
            await sleep(120);
            await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1, modifiers });
            await sleep(200);
        };

        await dragAlongRow3();
        const selected = await selectionLength(paneA);
        rec.check('the drag made a selection the engine reports', selected > 0, `${String(selected)} characters`);

        // ── the poison, then ⌘C ────────────────────────────────────────────────────────
        const poisoned = await writeClipboard(POISON);
        rec.check('the clipboard was overwritten with the sentinel after the drag', poisoned === POISON, poisoned);
        if (poisoned !== POISON) {
            rec.note('the clipboard could not be written in this lane; the copy assertions cannot run');
            return;
        }
        rec.check('the sentinel really is on the clipboard before ⌘C', (await readClipboard()) === POISON);

        await page.key('KeyC', { modifiers: d.MOD.meta, key: 'c' });
        await sleep(250);
        const copied = await readClipboard();
        rec.note(`clipboard after ⌘C: ${JSON.stringify(copied.slice(0, 80))}`);
        rec.check(
            '⌘C put the terminal selection on the clipboard (#81)',
            copied.includes(MARK),
            `holds ${JSON.stringify(copied.slice(0, 60))}`
        );
        rec.check(
            'and the sentinel is gone, so nothing overwrote the copy afterwards (no Edit menu double-fire)',
            !copied.includes(POISON),
            copied.includes(POISON) ? 'the sentinel survived ⌘C' : 'replaced'
        );
        await rec.shot(page, 'after-copy');

        // ── pane B: ⌘V with no browser paste command attached ──────────────────────────
        //
        // ⌘] rather than a click, deliberately: a focus click is a mouse-up over a cell, and the
        // engine's copy-on-select would replace the clipboard with the one character under the
        // pointer before the paste could read it.
        await page.key('BracketRight', { modifiers: d.MOD.meta, key: ']', keyCode: 221 });
        const focusedB = await d.settle(
            async () =>
                (await page.eval(
                    `document.querySelector('[data-testid="pane-header-${String(paneB)}"]')?.getAttribute('data-focused') === 'true'`
                )) === true,
            { ceilingMs: 4_000 }
        );
        rec.check('⌘] focused the second pane', focusedB);
        await d.runInTerminal(page, 'cat -v', { settleMs: 700 });

        /*
         * No `commands: ['paste']`. The chord alone has to paste, which is the difference this PR
         * makes: the paste is Kelpi's own action resolved against the FOCUSED pane, not the browser's
         * editing command landing on whichever DOM node happens to hold the caret.
         */
        await page.key('KeyV', { modifiers: d.MOD.meta, key: 'v' });
        const pasted = await captureUntil(paneB, (text) => text.includes(MARK), 3_000);
        rec.note(`pane B tail: ${JSON.stringify(pasted.slice(-200))}`);
        rec.check(
            'the ⌘V chord ALONE pasted the copied text into the focused pane (#81)',
            pasted.includes(MARK),
            pasted.slice(-160)
        );
        const occurrences = (pasted.match(new RegExp(MARK, 'g')) ?? []).length;
        rec.check(
            'and it arrived exactly once, so the Edit menu Paste did not also fire',
            occurrences === 1,
            `${String(occurrences)} occurrence(s)`
        );
        await rec.shot(page, 'after-paste');

        // ── Shift+drag, the gesture the docs and the help overlay now name ─────────────
        await cli.run(['pane', 'send-key', '--target', paneB, 'ctrl-c']);
        await d.focusPaneBody(page, paneA);
        await d.runInTerminal(page, "printf '\\033[?1000h'; cat -v", { settleMs: 800 });
        // DECSET 1000 is `vt200` in the port's own vocabulary (`terminal/mouse.ts` MouseTrackingMode).
        const reporting = await d.settle(async () => (await readGrid(paneA))?.mouse === 'vt200', { ceilingMs: 5_000 });
        rec.check('DECSET 1000 reached the client as a live pane mode', reporting, String((await readGrid(paneA))?.mouse));

        if (reporting) {
            await dragAlongRow3();
            const underReporting = await selectionLength(paneA);
            rec.check(
                'with an application owning the mouse, a plain drag selects nothing',
                underReporting === 0,
                `${String(underReporting)} characters selected`
            );
            await dragAlongRow3(d.MOD.shift);
            const shifted = await selectionLength(paneA);
            rec.check(
                'and Shift+drag selects anyway, which is the bypass the help overlay now names',
                shifted > 0,
                `${String(shifted)} characters selected`
            );
            await rec.shot(page, 'shift-drag-selection');
        }
        await cli.run(['pane', 'send-key', '--target', paneA, 'ctrl-c']);
    } finally {
        for (const workspace of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            if (!initialWorkspaceIDs.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        }
        if (startingWorkspace !== null) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);
        }
    }
}
