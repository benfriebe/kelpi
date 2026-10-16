/**
 * #327: a link in a pane scrolled into history underlines and opens, and the right one.
 *
 * The daemon's buffer never scrolls. A ⌘-click (or a hover) in a pane scrolled back used to send
 * only the viewport row, which the daemon read off its LIVE screen: usually nothing opened,
 * sometimes the wrong thing did, and the #303 underline was switched off in history to hide it.
 * Now the click carries how far up the pane is and the rows around it, and the daemon finds the
 * row it means.
 *
 * The screen script clears the screen and the scrollback, then prints three links as the very
 * first lines of the buffer and enough filler to push them into history, so that scrolled to the
 * top they sit on known rows:
 *
 *   row 0  see https://example.com/history/top now
 *   row 1  ✅ https://example.com/history/emoji      (two cells of emoji first, #329)
 *   row 2+ x…x https://example.com/history/long      (one line, soft-wrapped)
 *
 *   1. Scrolled to the top: a hover underlines each link and a ⌘-click opens exactly it.
 *   2. Then the pane is split, which narrows it. The engine reflows history on a column change
 *      and the daemon does not (`NO_REFLOW`); the settled-resize resync (terminal-surface.md
 *      §5.2) then replays the daemon's buffer into the engine, so the two count history the same
 *      way again. Scrolled back to the top, the links still underline and open.
 *
 * What the daemon does when the rows around a click are NOT where the offset says (output or a
 * resize landing between the engine's frame and the click) cannot be staged deterministically
 * against a real app; `ws/desktop.test.ts` ("a click in history") drives it on the real
 * emulator, and `App.openflow.test.tsx` the toast it raises.
 */

import fs from 'node:fs';
import path from 'node:path';

export const covers = [
    'packages/client/src/App.tsx',
    'packages/client/src/app/link-click.ts',
    'packages/client/src/connection/commands.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/terminal/link-hover.ts',
    'packages/client/src/terminal/renderer.ts',
    'packages/daemon/src/term/service.ts',
    'packages/daemon/src/ws/desktop.ts'
];

const TOP_URL = 'https://example.com/history/top';
const EMOJI_URL = 'https://example.com/history/emoji';
const LONG_URL = 'https://example.com/history/long';

export default async function ({ page, harness, cli, sandbox, rec, d, sleep }) {
    let shells = [];
    await d.settle(
        async () => {
            const domIDs = new Set(await d.domPaneIDs(page));
            shells = JSON.parse(await cli.ok(['pane', 'list', '--json'])).filter((pane) => pane.type === 'shell' && domIDs.has(pane.id));
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
    rec.check('there is a shell pane to print the links in', paneID !== null);
    if (paneID === null) return;
    await d.focusPaneBody(page, paneID);
    const paneRoot = `[data-pane-id="${paneID}"][data-terminal-cell]`;

    /** The pane's grid and where its cells are, read off what it publishes. */
    const measure = async () => {
        const m = await page.eval(
            `(() => {
                const root = document.querySelector(${JSON.stringify(paneRoot)});
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
        return {
            ...m,
            cols: Math.floor(m.clientW / (m.cellW || 1)),
            rows: Math.floor(m.clientH / (m.cellH || 1)),
            at: (row, col) => ({ x: m.left + (col + 0.5) * m.cellW, y: m.top + (row + 0.5) * m.cellH })
        };
    };
    let grid = await measure();
    rec.note(`grid ${String(grid.cols)} x ${String(grid.rows)}`);
    // Split in two, each half must still hold the longest history link line (39 columns). The
    // full scenario lane leaves the window with fewer columns than a fresh one (87 measured).
    rec.check('the pane is wide enough to split and still hold the links (>= 84 cols)', grid.cols >= 84, String(grid.cols));
    if (grid.cols < 84) return;
    const wideCols = grid.cols;
    const long = `${'x'.repeat(wideCols - 12)} ${LONG_URL}`;

    const script = path.join(sandbox.work, 'kelpi-327-history.sh');
    fs.writeFileSync(
        script,
        [
            '#!/bin/sh',
            '# Written by scripts/scenarios/terminal-link-history.mjs (#327). Disposable.',
            "printf '\\033[2J\\033[3J\\033[H'",
            `printf 'see ${TOP_URL} now\\r\\n'`,
            `printf '✅ ${EMOJI_URL}\\r\\n'`,
            `printf '${long}\\r\\n'`,
            `i=0; while [ $i -lt ${String(grid.rows + 30)} ]; do printf 'filler %s\\r\\n' $i; i=$((i+1)); done`,
            'sleep 300',
            ''
        ].join('\n'),
        'utf8'
    );
    await d.runInTerminal(page, `sh ${script}`, { settleMs: 1_500 });

    const underline = () => page.eval(`document.querySelector(${JSON.stringify(paneRoot)})?.getAttribute('data-terminal-link-underline') ?? ''`);
    const toasts = () => page.eval(`document.querySelector('[data-testid="toast-stack"]')?.textContent ?? ''`);
    const toTop = async () => {
        const centre = grid.at(Math.floor(grid.rows / 2), Math.floor(grid.cols / 2));
        await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centre.x, y: centre.y, deltaX: 0, deltaY: -1_000_000 });
        await sleep(400);
    };
    const hover = async (label, row, col, want) => {
        await page.mouse('mouseMoved', grid.left - 5, grid.top - 5, { button: 'none', buttons: 0 });
        await sleep(100);
        const point = grid.at(row, col);
        await page.mouse('mouseMoved', point.x, point.y, { button: 'none', buttons: 0 });
        await d.settle(async () => (await underline()) === want, { ceilingMs: 3_000, intervalMs: 50 });
        await sleep(want === '' ? 400 : 0);
        const got = await underline();
        rec.check(`${label}: ${want === '' ? 'no underline' : `underlined ${want}`}`, got === want, `got "${String(got)}"`);
    };
    const metaClick = async (row, col) => {
        const before = await harness.counters();
        const point = grid.at(row, col);
        await page.clickAt(point.x, point.y, { modifiers: d.MOD.meta });
        await d.settle(async () => (await harness.counters()).externalOpens > before.externalOpens, { ceilingMs: 2_500, intervalMs: 100 });
        const after = await harness.counters();
        return { opened: after.externalOpens - before.externalOpens, url: after.lastExternalUrl };
    };
    const opens = async (label, row, col, url) => {
        const got = await metaClick(row, col);
        rec.check(`${label}: a ⌘-click opens exactly ${url}`, got.opened === 1 && got.url === url, `opened ${String(got.opened)}, ${String(got.url)}`);
    };

    // ── 1. scrolled to the top of history ────────────────────────────────────────────
    await toTop();
    await hover('the top link, in history', 0, 10, `0:4+${String(TOP_URL.length)}`);
    await rec.shot(page, 'history-top-hovered');
    await opens('the top link, in history', 0, 10, TOP_URL);
    // ✅ is two cells and a space, so the URL starts at column 3.
    await hover('the link after an emoji, in history', 1, 6, `1:3+${String(EMOJI_URL.length)}`);
    await opens('the last cell of the link after an emoji, in history', 1, 3 + EMOJI_URL.length - 1, EMOJI_URL);
    // The long line's URL starts on row 2 and wraps onto row 3; its tail opens the whole URL.
    await opens('the wrapped tail of the long line\'s link, in history', 3, 4, LONG_URL);

    // ── 2. split: the engine reflows history, the daemon does not ────────────────────
    await cli.ok(['pane', 'split', '--target', paneID]);
    await d.settle(async () => (await measure()).cols < wideCols - 10, { ceilingMs: 6_000, intervalMs: 200 });
    await sleep(800);
    grid = await measure();
    rec.note(`after the split: grid ${String(grid.cols)} x ${String(grid.rows)}`);
    rec.check('the split narrowed the pane', grid.cols < wideCols - 10, `${String(grid.cols)} cols, from ${String(wideCols)}`);
    await d.focusPaneBody(page, paneID);
    await toTop();
    await hover('the top link after the split', 0, 10, `0:4+${String(TOP_URL.length)}`);
    await rec.shot(page, 'history-top-hovered-after-split');
    await opens('the top link after the split', 0, 10, TOP_URL);

    await hover('the link after an emoji after the split', 1, 6, `1:3+${String(EMOJI_URL.length)}`);
    await opens('the link after an emoji after the split', 1, 6, EMOJI_URL);
    rec.check('and no failure toast anywhere along the way', !/Open (path|link)/.test(await toasts()), await toasts());

    // ── leave the pane as a human would want it ───────────────────────────────────────
    const panes = JSON.parse(await cli.ok(['pane', 'list', '--json']));
    for (const pane of panes) {
        if (pane.type === 'shell' && !shells.some((shell) => shell.id === pane.id)) await cli.run(['pane', 'close', '--target', pane.id]);
    }
    await d.focusPaneBody(page, paneID);
    await page.key('KeyC', { modifiers: d.MOD.ctrl });
    await sleep(300);
    await d.runInTerminal(page, 'clear', { settleMs: 300 });
}
