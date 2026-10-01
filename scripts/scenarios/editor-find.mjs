/**
 * Issue #305: ⌘F opens a find bar in a scratchpad, and in a markdown pane in edit mode.
 *
 * content-panes.md §4.4. Both editors are a `<textarea>` (`PlainTextEditor`), and both used to
 * decline the `toggle_search` binding so the chord could fall through to "the host's own find".
 * The Electron shell has none, so ⌘F did nothing at all. The editor now draws the shared
 * `PaneSearchOverlay` over a scan of its own buffer, selects and scrolls to the match, paints
 * highlights over the textarea (Chromium does not paint the selection of a textarea that does
 * not hold the caret), and hands the caret back on Escape with the match selected.
 *
 * What this presses: ⇧⌘N for a scratchpad, typing into it, ⌘F with the caret in the editor,
 * a needle, Return / ⇧Return, a match far below and one far to the right (the scroll), and
 * Escape. Then the same on a markdown pane after ⌘E, and ⌘F on its PREVIEW, which must still
 * open the preview's own bar. The markdown half needs the sandbox CLI (`kelpi md`), so an
 * `--attach` run does the scratchpad half alone and says so.
 *
 * The geometry checks read real layout: the current mark has to sit on the row of the line it
 * marks, and inside the textarea's visible box after a scroll. The screenshots are the evidence
 * that the highlights line up with the text; they are only trustworthy outside the hidden lane.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The source this presses (ui-audit/README.md ▸ The rule): the editor that draws the bar, the
 * highlights and the selection, the match model, and the scratchpad body that hands it the token.
 */
export const covers = [
    'packages/client/src/content/PlainTextEditor.tsx',
    'packages/client/src/content/text-find.ts',
    'packages/client/src/content/ScratchpadPane.tsx'
];

const FILLER = Array.from({ length: 140 }, (_unused, index) => `filler line ${String(index + 1)}`);
const LINES = [
    'scratchpad find',
    'the first beta',
    'nothing here',
    'another BETA, then beta',
    ...FILLER,
    'a zebra far below',
    `${'x'.repeat(240)} giraffe at the far right`
];
const TEXT = `${LINES.join('\n')}\n`;
const MARKDOWN = '# Find in the editor\n\nSome **bold** text, and more **bold** after it.\n';

const ACTIVE_TEXTAREA = `(() => { const a = document.activeElement; return a !== null && a.tagName === 'TEXTAREA' && (a.getAttribute('data-testid') ?? '').startsWith('content-textarea-') ? a.getAttribute('data-testid').slice('content-textarea-'.length) : ''; })()`;

/** Everything one check needs about the editor's find, read in one round trip. */
const findState = (paneID) => `(() => {
    const area = document.querySelector('[data-testid="content-textarea-${paneID}"]');
    const bar = document.querySelector('[data-testid="content-find-${paneID}"]');
    const field = document.querySelector('[data-testid="content-find-input-${paneID}"]');
    const count = document.querySelector('[data-testid="content-find-count-${paneID}"]');
    const layer = document.querySelector('[data-testid="content-find-highlights-${paneID}"]');
    const current = layer === null ? null : layer.querySelector('mark[data-find-match="current"]');
    const box = (el) => { if (el === null) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return JSON.stringify({
        open: bar !== null,
        fieldFocused: field !== null && document.activeElement === field,
        textareaFocused: area !== null && document.activeElement === area,
        count: count === null ? null : count.textContent,
        selection: area === null ? null : [area.selectionStart, area.selectionEnd],
        selected: area === null ? null : area.value.slice(area.selectionStart, area.selectionEnd),
        marks: layer === null ? 0 : layer.querySelectorAll('mark').length,
        current: current === null ? null : current.textContent,
        currentBox: box(current),
        areaBox: box(area),
        clientWidth: area === null ? 0 : area.clientWidth,
        clientHeight: area === null ? 0 : area.clientHeight,
        scrollTop: area === null ? 0 : area.scrollTop,
        scrollLeft: area === null ? 0 : area.scrollLeft,
        barBox: box(bar)
    });
})()`;

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    const read = async (paneID) => JSON.parse(String(await page.eval(findState(paneID))));
    const press = async (code, modifiers = 0) => {
        await page.key(code, { modifiers });
        await sleep(120);
    };
    /** Clear the find field one key at a time: ⌘A there would be the app's chord, not the field's. */
    const clearField = async (length) => {
        for (let index = 0; index < length; index += 1) await page.key('Backspace');
        await sleep(120);
    };

    /*
     * A workspace of its own when there is a CLI (a booted sandbox), deleted on the way out with
     * the window put back where it was found. An attached instance has no CLI, so the scratchpad
     * half runs in whatever workspace is on screen there and leaves its scratchpad for a person
     * to look at.
     */
    let ownID = null;
    let homeID = null;
    if (cli) {
        const workspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
        homeID = workspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
        ownID = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Editor Find', '--json'])).id;
        const row = `[data-testid="workspace-row"][data-workspace-id="${String(ownID)}"]`;
        if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);
    } else {
        rec.note('attached: no sandbox CLI, so the scratchpad half runs in the workspace on screen and the markdown half is skipped');
    }

    try {
        await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
        const startPane = (await d.domPaneIDs(page))[0];
        rec.check('a pane to start from', startPane !== undefined);
        if (startPane === undefined) return;
        await d.focusPaneBody(page, startPane);

        // ── a scratchpad (⇧⌘N), and ⌘F with the caret in it ──────────────────────────────
        await press('KeyN', d.MOD.meta | d.MOD.shift);
        const created = await d.settleDom(page, `${ACTIVE_TEXTAREA} !== ''`, { ceilingMs: 8_000 });
        const scratchID = String(await page.eval(ACTIVE_TEXTAREA));
        rec.check('⇧⌘N made a scratchpad that holds the caret', created && scratchID !== '', `active: ${scratchID || '<none>'}`);
        if (scratchID === '') return;
        await page.insertText(TEXT);
        await d.settleDom(page, `document.querySelector('[data-testid="content-textarea-${scratchID}"]').value.length === ${String(TEXT.length)}`, { ceilingMs: 4_000 });

        await press('KeyF', d.MOD.meta);
        const opened = await d.settleDom(page, `document.querySelector('[data-testid="content-find-input-${scratchID}"]') === document.activeElement`, { ceilingMs: 4_000 });
        let state = await read(scratchID);
        rec.check('⌘F in a scratchpad opens the find bar, with the caret in its field (#305)', opened && state.open && state.fieldFocused, JSON.stringify(state));
        rec.check('the bar sits in the pane, at its top-right corner', state.barBox !== null && state.areaBox !== null && state.barBox.x + state.barBox.w <= state.areaBox.x + state.areaBox.w + 2 && state.barBox.y < state.areaBox.y, JSON.stringify({ bar: state.barBox, area: state.areaBox }));

        await page.insertText('beta');
        await d.settleDom(page, `document.querySelector('[data-testid="content-find-count-${scratchID}"]')?.textContent === '1/3'`, { ceilingMs: 3_000 });
        state = await read(scratchID);
        rec.check('typing selects the first match and counts them all', state.count === '1/3' && state.selected === 'beta' && state.marks === 3, JSON.stringify({ count: state.count, selected: state.selected, marks: state.marks }));
        // Line 2 (row 1): the mark's top is the textarea's top, its 8 px inset and one 16 px row.
        const rowOf = (s) => (s.currentBox === null || s.areaBox === null ? null : (s.currentBox.y - s.areaBox.y - 8 + s.scrollTop) / 16);
        rec.check('the current highlight sits on the row of the line it marks', rowOf(state) !== null && Math.abs((rowOf(state) ?? 0) - 1) < 0.2, `row ${String(rowOf(state))} (want 1)`);
        await rec.shot(page, 'scratchpad-first-match');

        await press('Enter');
        state = await read(scratchID);
        rec.check('Return steps to the next match (case-folded: BETA)', state.count === '2/3' && state.selected === 'BETA', JSON.stringify({ count: state.count, selected: state.selected }));
        await press('Enter');
        await press('Enter');
        state = await read(scratchID);
        rec.check('and wraps from the last match to the first', state.count === '1/3' && state.selection?.[0] === TEXT.indexOf('beta'), JSON.stringify({ count: state.count, selection: state.selection }));
        await press('Enter', d.MOD.shift);
        state = await read(scratchID);
        rec.check('⇧Return steps back, wrapping to the last match', state.count === '3/3' && state.selection?.[0] === TEXT.lastIndexOf('beta'), JSON.stringify({ count: state.count, selection: state.selection }));
        await rec.shot(page, 'scratchpad-third-match');

        // A match far below: the textarea scrolls, and the highlight comes with it.
        await clearField('beta'.length);
        await page.insertText('zebra');
        await d.settleDom(page, `document.querySelector('[data-testid="content-find-count-${scratchID}"]')?.textContent === '1/1'`, { ceilingMs: 3_000 });
        await sleep(250);
        state = await read(scratchID);
        const inside = (s) =>
            s.currentBox !== null && s.areaBox !== null &&
            s.currentBox.y >= s.areaBox.y && s.currentBox.y + s.currentBox.h <= s.areaBox.y + s.clientHeight &&
            s.currentBox.x >= s.areaBox.x && s.currentBox.x + s.currentBox.w <= s.areaBox.x + s.clientWidth;
        rec.check('a match below the viewport is scrolled into view, highlighted', state.scrollTop > 0 && state.current === 'zebra' && inside(state), JSON.stringify({ scrollTop: state.scrollTop, current: state.current, mark: state.currentBox, area: state.areaBox, clientHeight: state.clientHeight }));
        rec.check('and its highlight is still on its own row after the scroll', rowOf(state) !== null && Math.abs((rowOf(state) ?? 0) - (LINES.indexOf('a zebra far below'))) < 0.2, `row ${String(rowOf(state))} (want ${String(LINES.indexOf('a zebra far below'))})`);
        await rec.shot(page, 'scratchpad-scrolled-down');

        // A match off to the right of an unwrapped line (the scratchpad keeps wrap="off").
        await clearField('zebra'.length);
        await page.insertText('giraffe');
        await d.settleDom(page, `document.querySelector('[data-testid="content-find-count-${scratchID}"]')?.textContent === '1/1'`, { ceilingMs: 3_000 });
        await sleep(250);
        state = await read(scratchID);
        rec.check('a match past the right edge scrolls sideways into view', state.scrollLeft > 0 && state.current === 'giraffe' && inside(state), JSON.stringify({ scrollLeft: state.scrollLeft, mark: state.currentBox, area: state.areaBox, clientWidth: state.clientWidth }));
        await rec.shot(page, 'scratchpad-scrolled-right');

        await press('Escape');
        state = await read(scratchID);
        rec.check('Escape closes the bar and hands the caret back to the text, on the match', !state.open && state.textareaFocused && state.selected === 'giraffe' && state.marks === 0, JSON.stringify({ open: state.open, textareaFocused: state.textareaFocused, selected: state.selected, marks: state.marks }));
        await rec.shot(page, 'scratchpad-closed');

        // ── a markdown pane: the editor's bar in edit mode, the preview's in view mode ──────
        if (!cli || !sandbox) return;
        const file = path.join(sandbox.root, 'editor-find.md');
        fs.writeFileSync(file, MARKDOWN);
        await cli.ok(['md', '--focus', file]);
        const mdReady = await d.settleDom(page, `document.querySelector('[data-testid^="content-iframe-"]') !== null`, { ceilingMs: 10_000 });
        const mdID = String(await page.eval(`(document.querySelector('[data-testid^="content-iframe-"]')?.getAttribute('data-testid') ?? '').slice('content-iframe-'.length)`));
        rec.check('kelpi md opened a markdown preview', mdReady && mdID !== '', mdID);
        if (mdID === '') return;
        await d.focusPaneBody(page, mdID);
        await press('KeyE', d.MOD.meta);
        const editing = await d.settleDom(page, `${ACTIVE_TEXTAREA} === ${JSON.stringify(mdID)}`, { ceilingMs: 6_000 });
        rec.check('⌘E put the markdown pane in edit mode, caret in the editor', editing, String(await page.eval(ACTIVE_TEXTAREA)));

        await press('KeyF', d.MOD.meta);
        await d.settleDom(page, `document.querySelector('[data-testid="content-find-input-${mdID}"]') === document.activeElement`, { ceilingMs: 4_000 });
        await page.insertText('**bold**');
        await d.settleDom(page, `document.querySelector('[data-testid="content-find-count-${mdID}"]')?.textContent === '1/2'`, { ceilingMs: 3_000 });
        state = await read(mdID);
        rec.check('⌘F in markdown edit mode opens the editor bar over the SOURCE (#305)', state.open && state.count === '1/2' && state.selected === '**bold**' && state.marks === 2, JSON.stringify({ open: state.open, count: state.count, selected: state.selected, marks: state.marks }));
        await press('Enter');
        state = await read(mdID);
        rec.check('Return steps in the markdown editor too', state.count === '2/2' && state.selection?.[0] === MARKDOWN.lastIndexOf('**bold**'), JSON.stringify({ count: state.count, selection: state.selection }));
        await rec.shot(page, 'markdown-edit-find');
        await press('Escape');
        state = await read(mdID);
        rec.check('Escape hands the markdown editor its caret back, on the match', !state.open && state.textareaFocused && state.selection?.[0] === MARKDOWN.lastIndexOf('**bold**'), JSON.stringify({ open: state.open, textareaFocused: state.textareaFocused, selection: state.selection }));

        // ⌘E back to the preview: ⌘F there is the preview's own bar, unchanged.
        await press('KeyE', d.MOD.meta);
        await d.settleDom(page, `document.querySelector('[data-testid="content-iframe-${mdID}"]') !== null`, { ceilingMs: 6_000 });
        rec.check('back in preview mode no bar is open', !(await read(mdID)).open);
        await press('KeyF', d.MOD.meta);
        const previewBar = await d.settleDom(page, `document.querySelector('[data-testid="content-find-${mdID}"]') !== null && document.querySelector('[data-testid="content-iframe-${mdID}"]') !== null`, { ceilingMs: 4_000 });
        rec.check('⌘F over the preview still opens the preview find bar', previewBar);
        await page.insertText('bold');
        await d.settleDom(page, `document.querySelector('[data-testid="content-find-count-${mdID}"]')?.textContent === '1/2'`, { ceilingMs: 3_000 });
        rec.check('and the preview counts its own (rendered) matches', String(await page.eval(`document.querySelector('[data-testid="content-find-count-${mdID}"]')?.textContent ?? ''`)) === '1/2');
        await rec.shot(page, 'markdown-preview-find');
        await press('Escape');

        // The scratchpad's bar stays shut while ⌘F goes elsewhere (a token falling to 0 is not a request).
        rec.check('the scratchpad did not reopen its bar when ⌘F went to the preview', !(await read(scratchID)).open);
    } finally {
        if (cli && ownID !== null) {
            await cli.run(['workspace', 'delete', String(ownID), '--force']);
            const row = `[data-testid="workspace-row"][data-workspace-id="${String(homeID)}"]`;
            if (homeID !== null && (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 }))) await page.click(row);
        }
    }
}
