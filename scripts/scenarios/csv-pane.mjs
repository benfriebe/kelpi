/**
 * Issue #324: a .csv opens as an editable table (docs/csv-pane.md).
 *
 * What this presses, in a real window against a real daemon: `kelpi open data.csv`, the grid's
 * header row, a quoted field with a comma and one with a newline, typing into a cell and Return,
 * the file on disk afterwards (the edited line changed, every other line byte-identical), ⌘Z, a
 * header click to sort (the file untouched), the pane header's header-row toggle, ⌘F with
 * Return stepping, ⌘E to raw text and back, and an external rewrite of the file that the grid
 * picks up on its own. Then a 600,000-row file (past the 8,000,000 px spacer cap, so the scaled
 * scroll mapping is live): the first rows before the index finishes, the row count after it, a
 * jump to the end, and an edit near the end that leaves the head of the file byte-identical.
 * Last, the phone layout: tap to select, tap again to edit (the editor must hold focus, which is
 * what raises a phone keyboard), and a long-press for the table menu.
 *
 * Needs the sandbox CLI, so an `--attach` run only notes that it was skipped.
 */

const BIG_ROWS = 600_000;
const bigSource = () => {
    const parts = ['id,label,value\n'];
    for (let n = 1; n <= BIG_ROWS; n += 1) parts.push(`${String(n)},row ${String(n)},${String(n * 3)}\n`);
    return parts.join('');
};

import fs from 'node:fs';
import path from 'node:path';

import { phoneToLanding } from '../ui-audit/lib/workbench.mjs';

/** The source this presses (ui-audit/README.md ▸ The rule). */
export const covers = [
    'packages/client/src/content/csv/CsvGrid.tsx',
    'packages/client/src/content/csv/CsvPane.tsx',
    'packages/client/src/content/csv/csv-model.ts',
    'packages/client/src/content/csv/csv-client.ts',
    'packages/daemon/src/content/csv/service.ts',
    'packages/daemon/src/content/csv/document.ts',
    'packages/daemon/src/content/csv/writer.ts'
];

const LINES = [
    'name,city,note',
    'Ada,London,"first, with a comma"',
    'Grace,Arlington,plain',
    'Linus,Helsinki,"two',
    'lines"',
    'Margaret,Boston,plain'
];
const SOURCE = `${LINES.join('\n')}\n`;

/** Everything one check needs about the grid, read in one round trip. */
const gridState = (paneID) => `(() => {
    const grid = document.querySelector('[data-testid="csv-grid-${paneID}"]');
    if (grid === null) return JSON.stringify({ present: false });
    const text = (el) => el === null ? null : (el.textContent ?? '').trim();
    const cell = (view, col) => text(grid.querySelector('[data-testid="csv-cell-' + view + '-' + col + '"]'));
    const header = (col) => text(grid.querySelector('[data-testid="csv-header-' + col + '"]'));
    const status = (id) => text(document.querySelector('[data-testid="' + id + '-${paneID}"]'));
    return JSON.stringify({
        present: true,
        headers: [header(0), header(1), header(2)],
        rows: [0, 1, 2, 3, 4].map((view) => [cell(view, 0), cell(view, 1), cell(view, 2)]),
        sortIndicator: grid.querySelector('[data-testid^="csv-sort-indicator-"]') !== null,
        saving: status('csv-status-saving'),
        statusRows: status('csv-status-rows'),
        notice: status('csv-status-notice'),
        error: status('csv-status-error'),
        findOpen: document.querySelector('[data-testid="content-find-${paneID}"]') !== null,
        findCount: text(document.querySelector('[data-testid="content-find-count-${paneID}"]')),
        rawOpen: document.querySelector('[data-testid="content-textarea-${paneID}"]') !== null
    });
})()`;

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    if (!cli || !sandbox) {
        rec.note('attached: no sandbox CLI, so the csv scenario was skipped');
        return;
    }
    const press = async (code, modifiers = 0) => {
        await page.key(code, { modifiers });
        await sleep(150);
    };

    const workspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const homeID = workspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'CSV Pane', '--json']));
    const ownID = created.workspace_id ?? created.id;
    rec.check('a workspace of its own was created', typeof ownID === 'string', JSON.stringify(created));
    if (typeof ownID !== 'string') return;
    const row = `[data-testid="workspace-row"][data-workspace-id="${String(ownID)}"]`;
    if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);

    const file = path.join(sandbox.root, 'people.csv');
    fs.writeFileSync(file, SOURCE);

    try {
        await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });

        // ── open ────────────────────────────────────────────────────────────────────────
        await cli.ok(['open', '--focus', file]);
        const opened = await d.settleDom(page, `document.querySelector('[data-testid^="csv-grid-"]') !== null`, { ceilingMs: 10_000 });
        const paneID = String(await page.eval(`(document.querySelector('[data-testid^="csv-grid-"]')?.getAttribute('data-testid') ?? '').slice('csv-grid-'.length)`));
        rec.check('kelpi open people.csv opened a table pane (#324)', opened && paneID !== '', paneID);
        if (paneID === '') return;
        const read = async () => JSON.parse(String(await page.eval(gridState(paneID))));
        await d.settleDom(page, `document.querySelector('[data-testid="csv-cell-1-0"]')?.textContent?.includes('Ada') === true`, { ceilingMs: 8_000 });

        let state = await read();
        rec.check('the first row is the header row', state.headers[0]?.includes('name') && state.headers[1]?.includes('city') && state.headers[2]?.includes('note'), JSON.stringify(state.headers));
        rec.check('a quoted field keeps its comma in one cell', state.rows[1]?.[2]?.includes('first, with a comma') === true, JSON.stringify(state.rows[1]));
        rec.check('a quoted field with a newline stays one row', state.rows[3]?.[0] === 'Linus' && state.rows[4]?.[0] === 'Margaret', JSON.stringify(state.rows));
        await rec.shot(page, 'csv-opened');

        // ── edit a cell ─────────────────────────────────────────────────────────────────
        await page.click(`[data-testid="csv-cell-2-1"]`);
        await sleep(150);
        await page.insertText('Paris');
        await press('Enter');
        await d.settleDom(page, `document.querySelector('[data-testid="csv-cell-2-1"]')?.textContent?.includes('Paris') === true`, { ceilingMs: 4_000 });
        state = await read();
        rec.check('typing into a selected cell and Return edits it', state.rows[2]?.[1] === 'Paris', JSON.stringify(state.rows[2]));
        const saved = await d.settle(async () => fs.readFileSync(file, 'utf8').includes('Grace,Paris,plain'), { ceilingMs: 6_000, intervalMs: 150 });
        const onDisk = fs.readFileSync(file, 'utf8');
        const expected = SOURCE.replace('Grace,Arlington,plain', 'Grace,Paris,plain');
        rec.check('autosave wrote the edit, and every other line is byte-identical', saved && onDisk === expected, JSON.stringify(onDisk));

        // ── undo ────────────────────────────────────────────────────────────────────────
        await press('KeyZ', d.MOD.meta);
        const undone = await d.settle(async () => fs.readFileSync(file, 'utf8') === SOURCE, { ceilingMs: 6_000, intervalMs: 150 });
        state = await read();
        rec.check('⌘Z undoes the edit in the grid and on disk', undone && state.rows[2]?.[1] === 'Arlington', JSON.stringify({ cell: state.rows[2], disk: fs.readFileSync(file, 'utf8') }));

        // ── sort by a header click ──────────────────────────────────────────────────────
        await page.click(`[data-testid="csv-header-1"]`);
        await d.settleDom(page, `document.querySelector('[data-testid^="csv-sort-indicator-"]') !== null`, { ceilingMs: 6_000 });
        await sleep(300);
        state = await read();
        const cities = state.rows.slice(1).map((r) => r[1]);
        rec.check('clicking a header sorts the rows by it, header pinned', state.sortIndicator && JSON.stringify(cities) === JSON.stringify(['Arlington', 'Boston', 'Helsinki', 'London']) && state.headers[1]?.includes('city') === true, JSON.stringify(state.rows));
        rec.check('sorting never rewrites the file', fs.readFileSync(file, 'utf8') === SOURCE);
        await rec.shot(page, 'csv-sorted');
        // asc -> desc -> off
        await page.click(`[data-testid="csv-header-1"]`);
        await sleep(300);
        await page.click(`[data-testid="csv-header-1"]`);
        await d.settleDom(page, `document.querySelector('[data-testid^="csv-sort-indicator-"]') === null`, { ceilingMs: 6_000 });
        await d.settleDom(page, `document.querySelector('[data-testid="csv-cell-1-0"]')?.textContent?.includes('Ada') === true`, { ceilingMs: 4_000 });
        rec.check('a third click returns to file order', (await read()).rows[1]?.[0] === 'Ada');

        // ── header-row toggle in the pane header ────────────────────────────────────────
        const toggle = `[data-testid="pane-header-row-${paneID}"]`;
        const hasToggle = await d.settleDom(page, `document.querySelector(${JSON.stringify(toggle)}) !== null`, { ceilingMs: 4_000 });
        rec.check('the pane header has a header-row toggle', hasToggle);
        if (hasToggle) {
            await page.click(toggle);
            await d.settleDom(page, `(document.querySelector('[data-testid="csv-header-0"]')?.textContent ?? '').trim() === 'A'`, { ceilingMs: 4_000 });
            state = await read();
            rec.check('with the header row off, columns are lettered and row 1 is data', state.headers[0] === 'A' && state.rows[0]?.[0] === 'name', JSON.stringify({ headers: state.headers, first: state.rows[0] }));
            await page.click(toggle);
            await d.settleDom(page, `(document.querySelector('[data-testid="csv-header-0"]')?.textContent ?? '').includes('name')`, { ceilingMs: 4_000 });
            rec.check('and back on, row 1 is the header again', (await read()).headers[0]?.includes('name') === true);
        }

        // ── find ────────────────────────────────────────────────────────────────────────
        await page.click(`[data-testid="csv-cell-1-0"]`);
        await press('KeyF', d.MOD.meta);
        const findOpen = await d.settleDom(page, `document.querySelector('[data-testid="content-find-input-${paneID}"]') === document.activeElement`, { ceilingMs: 4_000 });
        rec.check('⌘F opens the find bar with the caret in its field', findOpen);
        await page.insertText('plain');
        const counted = await d.settleDom(page, `(document.querySelector('[data-testid="content-find-count-${paneID}"]')?.textContent ?? '').includes('2')`, { ceilingMs: 6_000 });
        rec.check('find counts the matching cells', counted, String((await read()).findCount));
        await press('Enter');
        rec.check('Return steps to the next match', ((await read()).findCount ?? '').startsWith('2'), String((await read()).findCount));
        await rec.shot(page, 'csv-find');
        await press('Escape');
        rec.check('Escape closes the find bar', !(await read()).findOpen);

        // ── ⌘E raw text and back ────────────────────────────────────────────────────────
        await page.click(`[data-testid="csv-cell-1-0"]`);
        await press('KeyE', d.MOD.meta);
        const raw = await d.settleDom(page, `document.querySelector('[data-testid="content-textarea-${paneID}"]')?.value === ${JSON.stringify(SOURCE)}`, { ceilingMs: 6_000 });
        rec.check('⌘E shows the raw text of the file', raw);
        await rec.shot(page, 'csv-raw');
        await press('KeyE', d.MOD.meta);
        const back = await d.settleDom(page, `document.querySelector('[data-testid="csv-grid-${paneID}"]') !== null && document.querySelector('[data-testid="csv-cell-1-0"]')?.textContent?.includes('Ada') === true`, { ceilingMs: 8_000 });
        rec.check('⌘E again returns to the table', back);

        // ── an external rewrite ─────────────────────────────────────────────────────────
        const rewritten = SOURCE.replace('Margaret,Boston,plain', 'Margaret,Cambridge,plain\nAlan,Wilmslow,plain');
        const temp = `${file}.tmp`;
        fs.writeFileSync(temp, rewritten);
        fs.renameSync(temp, file);
        const reloaded = await d.settleDom(page, `[...document.querySelectorAll('[data-testid="csv-grid-${paneID}"] [role="gridcell"]')].some((el) => (el.textContent ?? '').includes('Wilmslow'))`, { ceilingMs: 8_000 });
        rec.check('an external save of the file reloads the grid', reloaded);
        await rec.shot(page, 'csv-reloaded');

        // ── a large file ────────────────────────────────────────────────────────────────
        const bigFile = path.join(sandbox.root, 'big.csv');
        const big = bigSource();
        fs.writeFileSync(bigFile, big);
        const head = big.slice(0, 1024 * 1024);
        const openedAt = Date.now();
        await cli.ok(['open', '--focus', bigFile]);
        const bigReady = await d.settleDom(page, `[...document.querySelectorAll('[data-testid^="csv-grid-"]')].some((grid) => grid.querySelector('[data-testid="csv-cell-1-1"]')?.textContent?.includes('row 1') === true)`, { ceilingMs: 15_000 });
        const firstRowsMs = Date.now() - openedAt;
        const bigID = String(await page.eval(`(() => { const grids = [...document.querySelectorAll('[data-testid^="csv-grid-"]')].filter((grid) => grid.getAttribute('data-testid') !== 'csv-grid-${paneID}'); return (grids[0]?.getAttribute('data-testid') ?? '').slice('csv-grid-'.length); })()`));
        rec.check('a 600,000-row file shows its first rows quickly', bigReady && bigID !== '' && firstRowsMs < 5_000, `${String(firstRowsMs)} ms, pane ${bigID}`);
        if (bigID !== '') {
            const counted = await d.settleDom(page, `(document.querySelector('[data-testid="csv-status-rows-${bigID}"]')?.textContent ?? '').replace(/[^0-9]/g, '').startsWith('600000')`, { ceilingMs: 30_000 });
            rec.check('the status line counts every row once indexing finishes', counted, String(await page.eval(`document.querySelector('[data-testid="csv-status-rows-${bigID}"]')?.textContent ?? ''`)));
            const bigGrid = `[data-testid="csv-grid-${bigID}"]`;
            const scroller = `[data-testid="csv-scroller-${bigID}"]`;
            const capped = Number(await page.eval(`document.querySelector(${JSON.stringify(scroller)})?.scrollHeight ?? 0`));
            rec.check('the spacer is capped below the browser height limit', capped > 0 && capped <= 8_100_000, `${String(capped)} px`);
            // A scrollbar drag to the very bottom: the last row must come into view.
            await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(scroller)}); el.scrollTop = el.scrollHeight; return true; })()`);
            const atEnd = await d.settleDom(page, `document.querySelector('${bigGrid} [data-testid="csv-cell-${String(BIG_ROWS)}-0"]')?.textContent === '${String(BIG_ROWS)}'`, { ceilingMs: 8_000 });
            rec.check('dragging the scrollbar to the bottom reaches the last row', atEnd);
            await rec.shot(page, 'csv-big-end');
            const target = BIG_ROWS - 5;
            const cell = `${bigGrid} [data-testid="csv-cell-${String(target)}-1"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(cell)}) !== null`, { ceilingMs: 4_000 })) {
                await page.click(cell);
                await sleep(150);
                await page.insertText('edited near the end');
                await press('Enter');
                const savedAt = Date.now();
                const bigSaved = await d.settle(async () => fs.readFileSync(bigFile, 'utf8').includes(`${String(target)},edited near the end,${String(target * 3)}`), { ceilingMs: 20_000, intervalMs: 250 });
                const after = fs.readFileSync(bigFile, 'utf8');
                rec.check('an edit near the end of a large file saves, head byte-identical', bigSaved && after.startsWith(head) && after.length === big.length + 'edited near the end'.length - `row ${String(target)}`.length, `${String(Date.now() - savedAt)} ms`);
            } else rec.check('the row near the end is on screen to edit', false);
        }

        // ── phone ───────────────────────────────────────────────────────────────────────
        await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        try {
            await d.settleDom(page, `document.querySelector('[data-testid="phone-shell"]') !== null`, { ceilingMs: 8_000 });
            // The phone opens on its landing page: pick this workspace, then its pane list.
            const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${String(ownID)}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(phoneRow)}) !== null`, { ceilingMs: 6_000 })) await page.click(phoneRow);
            if (await d.settleDom(page, `document.querySelector('[data-testid="phone-title"]') !== null`, { ceilingMs: 6_000 })) await page.click('[data-testid="phone-title"]');
            const show = `[data-testid="phone-pane-show-${paneID}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(show)}) !== null`, { ceilingMs: 6_000 })) await page.click(show);
            const phoneGrid = await d.settleDom(page, `document.querySelector('[data-testid="phone-shell"] [data-testid="csv-grid-${paneID}"] [data-testid="csv-cell-1-1"]') !== null`, { ceilingMs: 8_000 });
            const phoneIDs = String(await page.eval(`[...document.querySelectorAll('[data-testid^="phone-"], [data-testid^="csv-grid-"]')].map((el) => el.getAttribute('data-testid')).slice(0, 40).join(' ')`));
            rec.check('the phone shows the csv pane as a table', phoneGrid, phoneIDs);
            if (!phoneGrid) await rec.shot(page, 'csv-phone-missing');
            if (phoneGrid) {
                const phoneCell = `[data-testid="phone-shell"] [data-testid="csv-grid-${paneID}"] [data-testid="csv-cell-1-1"]`;
                await page.tap(phoneCell);
                await sleep(250);
                await page.tap(phoneCell);
                const focused = await d.settleDom(page, `document.activeElement?.getAttribute('data-testid') === 'csv-editor-${paneID}'`, { ceilingMs: 3_000 });
                rec.check('tapping the selected cell edits it with the editor focused (raises the keyboard)', focused, String(await page.eval(`document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? ''`)));
                // A second tap edits the existing value with the caret at its end, as phone
                // spreadsheets do (typing over a selected cell on a desktop replaces it instead).
                await page.insertText(' & Lyon');
                await press('Enter');
                const phoneSaved = await d.settle(async () => fs.readFileSync(file, 'utf8').includes('Ada,London & Lyon,'), { ceilingMs: 6_000, intervalMs: 150 });
                rec.check('a phone edit saves to disk', phoneSaved, fs.readFileSync(file, 'utf8').split('\n')[1] ?? '');
                await rec.shot(page, 'csv-phone-edit');
                const holdCell = `[data-testid="phone-shell"] [data-testid="csv-grid-${paneID}"] [data-testid="csv-cell-2-0"]`;
                const point = await page.touchPoint(holdCell, { label: 'long-press' });
                await page.touch('touchStart', [point]);
                await sleep(750);
                await page.touch('touchEnd', [point]);
                const menu = await d.settleDom(page, `document.querySelector('[data-testid="context-menu"]') !== null`, { ceilingMs: 3_000 });
                rec.check('a long-press opens the table menu', menu);
                await rec.shot(page, 'csv-phone-menu');
                if (menu) await press('Escape');
            }
        } finally {
            if (!await phoneToLanding(page, d, { note: rec.note })) rec.note('the phone shell did not return to its landing page');
            await page.send('Emulation.clearDeviceMetricsOverride');
            await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        }
    } finally {
        await cli.run(['workspace', 'delete', String(ownID), '--force']);
        const home = `[data-testid="workspace-row"][data-workspace-id="${String(homeID)}"]`;
        if (homeID !== null && (await d.settleDom(page, `document.querySelector(${JSON.stringify(home)})`, { ceilingMs: 8_000 }))) await page.click(home);
    }
}
