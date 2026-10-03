/**
 * #303: a plain hover over a terminal link underlines exactly what a ⌘-click there would open.
 *
 * The engine's own link detection used to underline on its own rules: any scheme (an `ssh://`
 * that a ⌘-click then refused), one row of a soft-wrapped URL, an OSC 8 link with no pointer,
 * never a `.md` path. Now the pane asks the daemon the click's question (`probe-terminal-target`)
 * and underlines the cells it names. A canvas cannot be asked what it drew, so the pane publishes
 * the underline it handed the engine as `data-terminal-link-underline` (`row:col+width` runs) and
 * this reads that, next to a screenshot of each phase.
 *
 * Two phases, because the two kinds of pane fail differently:
 *
 *   1. **A shell pane** printing seven kinds of target, hovered with NO modifier: a plain URL, a
 *      refused `ssh://`, an existing and a missing `.md` path, a soft-wrapped URL (both rows),
 *      an OSC 8 link behind prose, and plain prose. Then a ⌘-click on what was underlined, read
 *      off `harness.counters()`, so "underlined" and "opens" are checked against each other.
 *   2. **An any-motion mouse pane (DECSET 1003)**, the way Claude Code runs. Every hover is
 *      reported to the application, and the underline still has to appear.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The source this presses (the scenario rule; ui-audit/README.md ▸ The rule). */
export const covers = [
    'packages/client/src/terminal/link-hover.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/terminal/renderer.ts',
    'packages/daemon/src/ws/desktop.ts',
    'packages/daemon/src/term/service.ts',
    'vendor/ghostty-web-patched/source/lib/renderer.ts',
    'vendor/ghostty-web-patched/source/lib/terminal.ts'
];

const PLAIN_URL = 'https://example.com/plain/url';
const OSC8_URL = 'https://example.com/osc8/changelog';

/**
 * The screen, as a shell script: clear, then one target per row. A file rather than a typed
 * command line, as `cmd-click-codex-links.mjs` explains (OSC 8 carries ESC and backslash).
 *
 * `mode any` turns on 1003 + SGR first and records every byte the pane is sent, with echo and
 * canonical mode off so the reports neither scroll the screen nor wait for a newline.
 */
function screenScript({ markdown, missing, wrapped, csvPath }) {
    const osc8 = (uri, text) => `\\033]8;;${uri}\\033\\\\${text}\\033]8;;\\033\\\\`;
    return [
        '#!/bin/sh',
        '# Written by scripts/scenarios/terminal-link-hover.mjs (#303). Disposable.',
        'mode="$1"',
        'out="$2"',
        ': > "$out"',
        'if [ "$mode" = any ]; then',
        '  stty -echo -icanon min 1 time 0 2>/dev/null',
        "  printf '\\033[?1003h\\033[?1006h'",
        'fi',
        "printf '\\033[2J\\033[H'",
        `printf 'see ${PLAIN_URL} now\\r\\n'`,
        "printf 'refused ssh://host.example/repo here\\r\\n'",
        `printf '${markdown}\\r\\n'`,
        `printf '${missing}\\r\\n'`,
        "printf 'just some prose\\r\\n'",
        `printf '${wrapped}\\r\\n'`,
        `printf 'see ${osc8(OSC8_URL, 'the changelog')} now\\r\\n'`,
        `printf '${csvPath}\\r\\n'`,
        'if [ "$mode" = any ]; then',
        '  dd of="$out" bs=1 count=65536 2>/dev/null',
        'else',
        '  sleep 120',
        'fi',
        ''
    ].join('\n');
}

/** The runs a text of `length` starting at `row:col` covers on a grid `cols` wide. */
function runsFor(row, col, length, cols) {
    const runs = [];
    let left = length;
    let r = row;
    let c = col;
    while (left > 0) {
        const width = Math.min(left, cols - c);
        runs.push(`${String(r)}:${String(c)}+${String(width)}`);
        left -= width;
        r += 1;
        c = 0;
    }
    return runs.join(' ');
}

export default async function ({ page, harness, cli, sandbox, rec, d, sleep }) {
    // ── the pane ────────────────────────────────────────────────────────────────────
    // Waited for, not read once: straight after boot the window may not have drawn a pane yet.
    let shells = [];
    await d.settle(
        async () => {
            const domIDs = new Set(await d.domPaneIDs(page));
            shells = JSON.parse(await cli.ok(['pane', 'list', '--json'])).filter(
                (pane) => pane.type === 'shell' && domIDs.has(pane.id)
            );
            return shells.length > 0;
        },
        { ceilingMs: 10_000, intervalMs: 200 }
    );
    let paneID = null;
    let paneWidth = 0;
    for (const pane of shells) {
        const box = await page.box(`[data-testid="pane-body-${pane.id}"]`);
        if ((box?.width ?? 0) > paneWidth) {
            paneID = pane.id;
            paneWidth = box?.width ?? 0;
        }
    }
    rec.check('there is a shell pane to print the links in', paneID !== null, JSON.stringify(shells.map((p) => p.id)));
    if (paneID === null) return;
    await d.focusPaneBody(page, paneID);

    /*
     * The grid, from the pane's own published metrics. The hover point is the CENTRE of a cell
     * computed from the engine's cell size and the host's origin, which is what the mouse
     * reporter's `cellAt` measures against (#322), so the point names exactly the cell meant.
     */
    const metrics = await page.eval(
        `(() => {
            const root = document.querySelector('[data-pane-id="${paneID}"][data-terminal-cell]');
            const host = root?.querySelector('[data-terminal-host]') ?? null;
            const canvas = host?.querySelector('canvas') ?? null;
            const cell = (root?.getAttribute('data-terminal-cell') ?? '').split('x');
            const rect = (canvas ?? host)?.getBoundingClientRect?.() ?? null;
            return {
                cellW: Number(cell[0] ?? 0), cellH: Number(cell[1] ?? 0),
                clientW: host?.clientWidth ?? 0, clientH: host?.clientHeight ?? 0,
                left: rect?.left ?? 0, top: rect?.top ?? 0
            };
        })()`
    );
    const cols = Math.floor((metrics?.clientW ?? 0) / (metrics?.cellW || 1));
    const rows = Math.floor((metrics?.clientH ?? 0) / (metrics?.cellH || 1));
    rec.note(`grid ${String(cols)} x ${String(rows)}, metrics ${JSON.stringify(metrics)}`);
    rec.check('the pane is big enough for the screen (>= 60 cols, >= 10 rows)', cols >= 60 && rows >= 10, `${String(cols)}x${String(rows)}`);
    if (cols < 60 || rows < 10) return;
    const at = (row, col) => ({
        x: metrics.left + (col + 0.5) * metrics.cellW,
        y: metrics.top + (row + 0.5) * metrics.cellH
    });

    // The targets. Absolute paths, so the daemon resolves them whatever the pane's cwd; the
    // markdown one exists, the missing one does not.
    const markdown = path.join(sandbox.work, 'KELPI-303-NOTES.md');
    fs.writeFileSync(markdown, '# notes\n', 'utf8');
    const missing = path.join(sandbox.work, 'KELPI-303-MISSING.md');
    // #324: a ⌘-click opens a csv path as a table pane, so the hover underlines it too.
    const csvPath = path.join(sandbox.work, 'KELPI-303-DATA.csv');
    fs.writeFileSync(csvPath, 'a,b\n1,2\n', 'utf8');
    const wrapped = `https://example.com/wrapped/${'x'.repeat(cols - 10)}`;
    const scriptPath = path.join(sandbox.work, 'kelpi-303-screen.sh');
    const logPath = path.join(sandbox.work, 'kelpi-303-input.log');
    fs.writeFileSync(scriptPath, screenScript({ markdown, missing, wrapped, csvPath }), 'utf8');

    const underline = () =>
        page.eval(
            `document.querySelector('[data-pane-id="${paneID}"][data-terminal-cell]')?.getAttribute('data-terminal-link-underline') ?? ''`
        );
    const cursor = () =>
        page.eval(
            `document.querySelector('[data-pane-id="${paneID}"][data-terminal-cell] [data-terminal-host]')?.style.cursor ?? ''`
        );
    /** Hover a cell with no button and no modifier, and wait for the underline to settle. */
    const hover = async (label, row, col, want) => {
        // Off the grid first, so every hover is a fresh arrival rather than a move along a link.
        await page.mouse('mouseMoved', metrics.left - 5, metrics.top - 5, { button: 'none', buttons: 0 });
        await sleep(100);
        const point = at(row, col);
        await page.mouse('mouseMoved', point.x, point.y, { button: 'none', buttons: 0 });
        await d.settle(async () => (await underline()) === want, { ceilingMs: 2_500, intervalMs: 50 });
        // Long enough for a wrong answer to land too: "nothing" has to stay nothing.
        await sleep(want === '' ? 400 : 0);
        const got = await underline();
        rec.check(`${label}: ${want === '' ? 'no underline' : `underlined ${want}`}`, got === want, `got "${String(got)}"`);
        return got;
    };

    // Where each printed line starts: a line longer than the grid soft-wraps onto the next row.
    const lines = [
        `see ${PLAIN_URL} now`,
        'refused ssh://host.example/repo here',
        markdown,
        missing,
        'just some prose',
        wrapped,
        'see the changelog now',
        csvPath
    ];
    const starts = [];
    let next = 0;
    for (const line of lines) {
        starts.push(next);
        next += Math.max(1, Math.ceil(line.length / cols));
    }
    rec.check('the screen fits the pane', next <= rows, `${String(next)} rows of ${String(rows)}`);
    if (next > rows) return;
    const [plainRow, sshRow, markdownRow, missingRow, proseRow, wrappedRow, osc8Row, csvRow] = starts;

    // ── 1. a shell pane ───────────────────────────────────────────────────────────────
    await d.runInTerminal(page, `sh ${scriptPath} plain ${logPath}`, { settleMs: 1_200 });

    const plainRuns = runsFor(plainRow, 4, PLAIN_URL.length, cols);
    await hover('a plain URL', plainRow, 10, plainRuns);
    rec.check('with a pointer cursor while it is underlined', (await cursor()) === 'pointer', String(await cursor()));
    await rec.shot(page, 'plain-url-hovered');
    await hover('an ssh:// URL a ⌘-click refuses', sshRow, 12, '');
    rec.check('and no pointer cursor there', (await cursor()) === '', String(await cursor()));
    await hover('an existing .md path', markdownRow, 4, runsFor(markdownRow, 0, markdown.length, cols));
    await hover('a .md path that does not exist', missingRow, 4, '');
    await hover('prose', proseRow, 3, '');
    const wrappedRuns = runsFor(wrappedRow, 0, wrapped.length, cols);
    await hover('the head row of a soft-wrapped URL', wrappedRow, 3, wrappedRuns);
    await hover('the tail row of the same URL', osc8Row - 1, 1, wrappedRuns);
    await rec.shot(page, 'wrapped-url-hovered');
    await hover('an OSC 8 link behind prose', osc8Row, 8, runsFor(osc8Row, 4, 'the changelog'.length, cols));
    await hover('an existing .csv path (#324)', csvRow, 4, runsFor(csvRow, 0, csvPath.length, cols));

    // ── what was underlined is what opens, and what was not does not ─────────────────
    /** ⌘-click a cell; what the shell was asked to open, if anything. */
    const metaClick = async (row, col) => {
        const before = await harness.counters();
        const point = at(row, col);
        await page.clickAt(point.x, point.y, { modifiers: d.MOD.meta });
        await d.settle(async () => (await harness.counters()).externalOpens > before.externalOpens, { ceilingMs: 2_000, intervalMs: 100 });
        const after = await harness.counters();
        return { opened: after.externalOpens - before.externalOpens, url: after.lastExternalUrl };
    };
    const opens = async (label, row, col, url) => {
        const got = await metaClick(row, col);
        rec.check(`${label}: a ⌘-click opens exactly ${url}`, got.opened === 1 && got.url === url, `opened ${String(got.opened)}, ${String(got.url)}`);
    };
    await opens('the plain URL', plainRow, 10, PLAIN_URL);
    await opens('the tail row of the wrapped URL', osc8Row - 1, 1, wrapped);
    await opens('the OSC 8 link', osc8Row, 8, OSC8_URL);

    const refused = await metaClick(sshRow, 12);
    const toast = await d.settle(
        async () =>
            (await page.eval(`(document.querySelector('[data-testid="toast-stack"]')?.textContent ?? '').includes('not an http(s) address')`)) === true,
        { ceilingMs: 3_000, intervalMs: 100 }
    );
    rec.check('the ssh:// URL that was not underlined opens nothing, and says why', refused.opened === 0 && toast, `opened ${String(refused.opened)}, toast ${String(toast)}`);

    // Last, because it opens a pane beside this one; closed again so phase 2 has the same grid.
    const markdownPanes = async () =>
        JSON.parse(await cli.ok(['pane', 'list', '--json'])).filter((pane) => pane.type === 'markdown' && String(pane.file_path ?? '').endsWith('KELPI-303-NOTES.md'));
    const beforePanes = await markdownPanes();
    const point = at(markdownRow, 4);
    await page.clickAt(point.x, point.y, { modifiers: d.MOD.meta });
    await d.settle(async () => (await markdownPanes()).length > beforePanes.length, { ceilingMs: 4_000, intervalMs: 150 });
    const afterPanes = await markdownPanes();
    rec.check('a ⌘-click on the underlined .md path opens it in a markdown pane', afterPanes.length === beforePanes.length + 1, JSON.stringify(afterPanes.map((pane) => pane.id)));
    for (const pane of afterPanes) await cli.run(['pane', 'close', '--target', pane.id]);
    await d.focusPaneBody(page, paneID);

    // Leaving the pane takes it down.
    await hover('a plain URL again', plainRow, 10, plainRuns);
    await page.mouse('mouseMoved', metrics.left - 5, metrics.top - 5, { button: 'none', buttons: 0 });
    await d.settle(async () => (await underline()) === '', { ceilingMs: 1_500, intervalMs: 50 });
    rec.check('leaving the grid takes the underline down', (await underline()) === '', String(await underline()));

    await page.key('KeyC', { modifiers: d.MOD.ctrl });
    await sleep(300);

    // ── 2. an any-motion mouse pane (Claude Code's mode) ─────────────────────────────
    await d.runInTerminal(page, `sh ${scriptPath} any ${logPath}`, { settleMs: 1_200 });
    const reporting = await d.settle(
        async () =>
            (await page.eval(
                `document.querySelector('[data-pane-id="${paneID}"][data-terminal-mouse]')?.getAttribute('data-terminal-mouse')`
            )) === 'any',
        { ceilingMs: 6_000, intervalMs: 100 }
    );
    rec.check('the application turned on any-motion reporting (1003) and the client knows', reporting);
    await hover('a plain URL in a 1003 pane', plainRow, 10, plainRuns);
    await rec.shot(page, 'mode-1003-hovered');
    let reports = '';
    try {
        reports = fs.readFileSync(logPath).toString('latin1');
    } catch {
        reports = '';
    }
    // SGR motion with no button: ESC [ < 35 ; col ; row M.
    rec.check('and the application was still sent the hover as motion reports', /\x1b\[<35;\d+;\d+M/.test(reports), JSON.stringify(reports.slice(0, 120)));

    // ── leave the pane as a human would want it ───────────────────────────────────────
    await page.key('KeyC', { modifiers: d.MOD.ctrl });
    await sleep(300);
    await d.runInTerminal(page, "stty echo icanon; printf '\\033[?1003l\\033[?1006l'; clear", { settleMs: 400 });
}
