/**
 * A scratchpad's wrap toggle: the header button that switches the editor between a horizontal
 * scrollbar (the default) and soft wrap, kept on the pane in the daemon.
 *
 * content-panes.md §7 and §8. What this presses: ⇧⌘N for a scratchpad, a line far wider than the
 * pane, then the header's wrap button. The checks read real layout rather than the attribute
 * alone: unwrapped, the textarea scrolls sideways and the gutter counts one row per line; wrapped,
 * nothing is off to the right and the gutter's measured rows outnumber its lines. A daemon restart
 * then has to bring the scratchpad back still wrapping, which is the DB column doing its job, and a
 * second press turns it off again.
 */

export const covers = [
    'packages/client/src/content/ScratchpadPane.tsx',
    'packages/client/src/content/PlainTextEditor.tsx',
    'packages/client/src/content/client.ts',
    'packages/client/src/pane-chrome/model.ts',
    'packages/daemon/src/content/service.ts',
    'packages/daemon/src/store/reducers/panes.ts',
    'packages/daemon/src/db/codec.ts'
];

const LONG = `${'wrap me '.repeat(60)}end`;
const TEXT = `first line\n${LONG}\nlast line\n`;

const ACTIVE_TEXTAREA = `(() => { const a = document.activeElement; return a !== null && a.tagName === 'TEXTAREA' && (a.getAttribute('data-testid') ?? '').startsWith('content-textarea-') ? a.getAttribute('data-testid').slice('content-textarea-'.length) : ''; })()`;

/** Everything one check needs about the editor and its header button, in one round trip. */
const editorState = (paneID) => `(() => {
    const area = document.querySelector('[data-testid="content-textarea-${paneID}"]');
    const gutter = document.querySelector('[data-testid="content-gutter-${paneID}"]');
    const button = document.querySelector('[data-testid="pane-wrap-${paneID}"]');
    return JSON.stringify({
        present: area !== null,
        wrap: area === null ? null : area.getAttribute('wrap'),
        length: area === null ? 0 : area.value.length,
        scrollWidth: area === null ? 0 : area.scrollWidth,
        clientWidth: area === null ? 0 : area.clientWidth,
        rowsTotal: Number(gutter?.getAttribute('data-rows-total') ?? 0),
        lines: Number(gutter?.getAttribute('data-lines') ?? 0),
        label: button === null ? null : button.getAttribute('aria-label'),
        icon: button === null ? null : (button.querySelector('svg')?.getAttribute('data-icon') ?? null)
    });
})()`;

export default async function ({ page, cli, daemon, rec, d, sleep }) {
    const read = async (paneID) => JSON.parse(String(await page.eval(editorState(paneID))));
    const settled = async (paneID, predicate, ceilingMs = 6_000) =>
        await d.settle(async () => predicate(await read(paneID)), { ceilingMs, intervalMs: 150 });

    let ownID = null;
    let homeID = null;
    if (cli) {
        const workspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
        homeID = workspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
        ownID = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Scratchpad Wrap', '--json'])).id;
        const row = `[data-testid="workspace-row"][data-workspace-id="${String(ownID)}"]`;
        if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);
    } else {
        rec.note('attached: no sandbox CLI, so this runs in the workspace on screen and leaves its scratchpad there');
    }

    try {
        await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
        const startPane = (await d.domPaneIDs(page))[0];
        rec.check('a pane to start from', startPane !== undefined);
        if (startPane === undefined) return;
        await d.focusPaneBody(page, startPane);

        // ── a scratchpad with a line far wider than the pane ─────────────────────────────
        await page.key('KeyN', { modifiers: d.MOD.meta | d.MOD.shift });
        const created = await d.settleDom(page, `${ACTIVE_TEXTAREA} !== ''`, { ceilingMs: 8_000 });
        const paneID = String(await page.eval(ACTIVE_TEXTAREA));
        rec.check('⇧⌘N made a scratchpad that holds the caret', created && paneID !== '', `active: ${paneID || '<none>'}`);
        if (paneID === '') return;
        await page.insertText(TEXT);
        await settled(paneID, (state) => state.length === TEXT.length);

        let state = await read(paneID);
        rec.check(
            'a new scratchpad scrolls sideways: wrap off, the long line runs past the right edge',
            state.wrap === 'off' && state.scrollWidth > state.clientWidth + 50,
            JSON.stringify(state)
        );
        rec.check('its gutter counts one row per line', state.lines === 4 && state.rowsTotal === 4, JSON.stringify(state));
        rec.check('the header offers to wrap', state.label === 'Wrap lines' && state.icon === 'wrap', JSON.stringify(state));
        await rec.shot(page, 'scratchpad-unwrapped');

        // ── the header button turns wrapping on ──────────────────────────────────────────
        await page.click(`[data-testid="pane-wrap-${paneID}"]`);
        const wrapped = await settled(paneID, (s) => s.wrap === 'soft' && s.rowsTotal > s.lines);
        state = await read(paneID);
        rec.check(
            'one press soft-wraps it: nothing is off to the right',
            wrapped && state.scrollWidth <= state.clientWidth + 1,
            JSON.stringify(state)
        );
        rec.check(
            'the gutter measures the wrapped rows, so its rows outnumber its four lines',
            state.lines === 4 && state.rowsTotal > 4,
            JSON.stringify(state)
        );
        rec.check('the header now offers to stop', state.label === 'Stop wrapping lines' && state.icon === 'no-wrap', JSON.stringify(state));
        rec.check('the text is untouched', state.length === TEXT.length, String(state.length));
        await rec.shot(page, 'scratchpad-wrapped');

        // ── it is the pane's, in the daemon: a restart keeps it ──────────────────────────
        if (daemon === null) {
            rec.note('attached to an instance this run does not own: the restart arm is skipped');
        } else {
            // The text has to be in the DB before the old daemon goes: wait out both debounces.
            await sleep(1_500);
            await daemon.restart();
            const reconnected = await d.settleDom(
                page,
                `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`,
                { ceilingMs: 30_000 }
            );
            rec.check('the window reconnects to the restarted daemon', reconnected);
            const kept = await settled(paneID, (s) => s.present && s.length === TEXT.length && s.wrap === 'soft', 20_000);
            state = await read(paneID);
            rec.check('the restarted daemon brings the scratchpad back still wrapping', kept, JSON.stringify(state));
        }

        // ── and a second press turns it off again ────────────────────────────────────────
        await page.click(`[data-testid="pane-wrap-${paneID}"]`);
        const unwrapped = await settled(paneID, (s) => s.wrap === 'off' && s.rowsTotal === s.lines);
        state = await read(paneID);
        rec.check(
            'a second press goes back to the sideways scrollbar',
            unwrapped && state.scrollWidth > state.clientWidth + 50 && state.label === 'Wrap lines',
            JSON.stringify(state)
        );
    } catch (error) {
        await rec.shot(page, 'scratchpad-wrap-failure').catch(() => {});
        throw error;
    } finally {
        if (cli && ownID !== null) {
            await cli.run(['workspace', 'delete', String(ownID), '--force']);
            if (homeID !== null) {
                const row = `[data-testid="workspace-row"][data-workspace-id="${String(homeID)}"]`;
                if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) {
                    await page.click(row).catch(() => {});
                }
            }
        }
    }
}
