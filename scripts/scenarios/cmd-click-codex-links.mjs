/**
 * #83: ⌘-click a link in a full-screen TUI pane, the way Codex draws one.
 *
 * The user report is "cant CMD+Click links from codex sessions to open in web browser", and the
 * three reasons are all properties of a ratatui-style TUI rather than of Codex:
 *
 *   1. it emits OSC 8, so the cells hold a TITLE and the address is only an attribute;
 *   2. it hard-wraps by positioning the cursor per row, so `isWrapped` is false and the daemon's
 *      `cellText` has nothing to re-join on;
 *   3. it glues box-drawing borders straight onto the content, so the token kept the `│`.
 *
 * **Reproduced without Codex**, because a scenario that needs Codex installed, logged in and
 * printing a particular message is a scenario that runs once. What Codex does that matters is
 * exactly the escape sequences below, and a `printf` emits them identically: enter the alternate
 * screen with mouse reporting (`1049h`, `1000h`, `1006h`), then CUP-position every row so nothing
 * autowraps, and draw three bordered boxes, one plain-text hard-wrapped URL and two hyperlinked.
 *
 * The assertion is `harness.counters()` (#83 added `externalOpens` / `lastExternalUrl`): the URL
 * the shell hands the OS is otherwise invisible to a driver, and "which URL" is the whole bug.
 * Under the harness the open is recorded INSTEAD of performed, so no browser appears.
 *
 * What fails on the shipped tree, and why each check is here:
 *   - the OSC 8 boxes open NOTHING at all (the token is prose, or a border-glued fragment);
 *   - the plain box's head row opens nothing either, because `│` was not a token break;
 *   - every one of those is silent: the client only spoke for `opened: 'missing'`;
 *   - and the ⌘-click is ALSO delivered to the TUI as a plain button press, which this scenario
 *     reads off the PTY itself.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The source this presses (the scenario rule; ui-audit/README.md ▸ The rule).
 *
 * `desktop.ts` owns the decision (OSC 8 first, the box-drawing token break, the clipped-URL
 * refusal); `service.ts` owns the OSC 8 read out of the emulator's private buffer, which no unit
 * test can prove reaches a REAL pane driven by a REAL PTY; `mouse.ts` owns the ⌘ report bypass,
 * whose whole point is a byte that must NOT appear on the PTY.
 */
export const covers = [
    'packages/daemon/src/ws/desktop.ts',
    'packages/daemon/src/term/service.ts',
    'packages/client/src/terminal/mouse.ts'
];

/** The three URLs the boxes carry. Long on purpose: a truncation has to be visible as one. */
const PLAIN_URL = 'https://example.com/wrapped/path/that/continues/here';
const OSC8_WRAPPED_URL = 'https://example.com/osc8/wrapped/across/two/rows';
const OSC8_TITLED_URL = 'https://example.com/full/path/from/osc8';

/**
 * The TUI, as a shell script.
 *
 * A file rather than a typed command line: the box-drawing characters are multi-byte UTF-8 and
 * the OSC 8 sequences carry ESC and backslash, none of which survive a CDP keystroke stream
 * reliably. The script is written into the sandbox's own work directory and run by the pane's
 * shell, so every byte reaches the PTY exactly as authored.
 *
 * `stty -echo -icanon` is load-bearing twice over. Without `-echo` the mouse reports the TUI is
 * sent would be echoed back onto the alternate screen and scroll the boxes out from under the
 * clicks; without `-icanon` the tty would hold every byte until a newline that a mouse report
 * never contains, and the log would read empty whatever happened. `dd bs=1` then writes each
 * byte through as it arrives, so the log is readable from Node between clicks.
 */
function tuiScript() {
    const cup = (row, col) => `\\033[${String(row)};${String(col)}H`;
    // `\\033\\\\` is what the shell's printf must SEE to emit ESC + backslash (String Terminator).
    const osc8 = (uri, text) => `\\033]8;;${uri}\\033\\\\${text}\\033]8;;\\033\\\\`;
    const top = '┌──────────────────────────────┐';
    const bottom = '└──────────────────────────────┘';
    return [
        '#!/bin/sh',
        '# Written by scripts/scenarios/cmd-click-codex-links.mjs (#83). Disposable.',
        'out="$1"',
        ': > "$out"',
        'stty -echo -icanon min 1 time 0 2>/dev/null',
        "printf '\\033[?1049h\\033[?1000h\\033[?1006h\\033[2J'",
        '',
        '# Box A: a PLAIN url, hard-wrapped, filling the frame to both borders.',
        `printf '${cup(2, 3)}${top}'`,
        `printf '${cup(3, 3)}│https://example.com/wrapped/pa│'`,
        `printf '${cup(4, 3)}│th/that/continues/here        │'`,
        `printf '${cup(5, 3)}${bottom}'`,
        '',
        '# Box B: the SAME shape, but hyperlinked. Both rows carry the whole URI.',
        `printf '${cup(7, 3)}${top}'`,
        `printf '${cup(8, 3)}│${osc8(OSC8_WRAPPED_URL, 'https://example.com/osc8/wrapp')}│'`,
        `printf '${cup(9, 3)}│${osc8(OSC8_WRAPPED_URL, 'ed/across/two/rows')}            │'`,
        `printf '${cup(10, 3)}${bottom}'`,
        '',
        '# Box C: a hyperlink behind PROSE, which is how a markdown link renders.',
        `printf '${cup(12, 3)}${top}'`,
        `printf '${cup(13, 3)}│${osc8(OSC8_TITLED_URL, 'read the changelog')}            │'`,
        `printf '${cup(14, 3)}${bottom}'`,
        '',
        '# Hold the pane open and record every byte the TUI is sent.',
        'dd of="$out" bs=1 count=4096 2>/dev/null',
        ''
    ].join('\n');
}

export default async function ({ page, harness, cli, sandbox, rec, d, sleep }) {
    const scriptPath = path.join(sandbox.work, 'kelpi-83-tui.sh');
    const logPath = path.join(sandbox.work, 'kelpi-83-tui-input.log');
    fs.writeFileSync(scriptPath, tuiScript(), 'utf8');

    // ── the pane ────────────────────────────────────────────────────────────────────
    const domIDs = new Set(await d.domPaneIDs(page));
    const shells = JSON.parse(await cli.ok(['pane', 'list', '--json'])).filter(
        (pane) => pane.type === 'shell' && domIDs.has(pane.id)
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
    rec.check('there is a shell pane to draw the TUI in', paneID !== null, JSON.stringify(shells.map((p) => p.id)));
    if (paneID === null) return;
    rec.note(`pane ${paneID} (${String(Math.round(paneWidth))}px wide)`);
    await d.focusPaneBody(page, paneID);

    // ── the TUI ─────────────────────────────────────────────────────────────────────
    await d.runInTerminal(page, `sh ${scriptPath} ${logPath}`, { settleMs: 1_500 });

    // Mouse reporting reaching the CLIENT is a precondition for half of this scenario, and it
    // is published on the pane rather than inferred (§TERM-037).
    const reporting = await d.settle(
        async () =>
            (await page.eval(
                `document.querySelector('[data-pane-id="${paneID}"][data-terminal-mouse]')?.getAttribute('data-terminal-mouse')`
            )) === 'vt200',
        { ceilingMs: 6_000, intervalMs: 100 }
    );
    rec.check('the TUI turned mouse reporting on and the client knows (1000 + 1006)', reporting);

    /*
     * The grid, read from the pane's own published metrics, and the click point computed with
     * the CLIENT's arithmetic rather than the engine's.
     *
     * `cellFromPoint` (app/open-file.ts) divides the HOST BOX by cols and rows, so a point built
     * the same way resolves to exactly the cell it names, whatever the sub-pixel difference
     * between `width / cols` and the engine's own cell advance. That matters here because the
     * assertions are about which BUFFER CELL the daemon read, not about which pixel was painted.
     */
    const metrics = await page.eval(
        `(() => {
            const root = document.querySelector('[data-pane-id="${paneID}"][data-terminal-cell]');
            const host = root?.querySelector('[data-terminal-host]') ?? null;
            const cell = (root?.getAttribute('data-terminal-cell') ?? '').split('x');
            const rect = host?.getBoundingClientRect?.() ?? null;
            return {
                cellW: Number(cell[0] ?? 0), cellH: Number(cell[1] ?? 0),
                clientW: host?.clientWidth ?? 0, clientH: host?.clientHeight ?? 0,
                left: rect?.left ?? 0, top: rect?.top ?? 0,
                width: rect?.width ?? 0, height: rect?.height ?? 0
            };
        })()`
    );
    rec.note(`grid metrics: ${JSON.stringify(metrics)}`);
    const cols = Math.floor((metrics?.clientW ?? 0) / (metrics?.cellW || 1));
    const rows = Math.floor((metrics?.clientH ?? 0) / (metrics?.cellH || 1));
    rec.note(`grid: ${String(cols)} x ${String(rows)}`);
    rec.check(
        'the pane is big enough for the three boxes (>= 40 cols, >= 15 rows)',
        cols >= 40 && rows >= 15,
        `${String(cols)}x${String(rows)}`
    );
    if (cols < 40 || rows < 15) return;

    /** The pixel at the centre of a 0-based viewport cell. */
    const at = (row, col) => ({
        x: metrics.left + (col + 0.5) * (metrics.width / cols),
        y: metrics.top + (row + 0.5) * (metrics.height / rows)
    });

    await rec.shot(page, 'tui-drawn');

    // ── the clicks ──────────────────────────────────────────────────────────────────

    /** ⌘-click a cell and report what the shell was asked to open, if anything. */
    const metaClick = async (label, row, col) => {
        const before = await harness.counters();
        const point = at(row, col);
        await page.clickAt(point.x, point.y, { modifiers: d.MOD.meta });
        await d.settle(async () => (await harness.counters()).externalOpens > before.externalOpens, {
            ceilingMs: 3_000,
            intervalMs: 100
        });
        const after = await harness.counters();
        rec.note(
            `${label}: row ${String(row)} col ${String(col)} -> opens ${String(before.externalOpens)}` +
                ` -> ${String(after.externalOpens)}, url ${String(after.lastExternalUrl)}`
        );
        return { opened: after.externalOpens - before.externalOpens, url: after.lastExternalUrl };
    };

    // Box C, the markdown-link case: the cells say "read the changelog" and nothing else.
    // Column 10 is the middle of that title (the box starts at 1-based column 3, the border
    // takes one cell, so the title starts at 0-based column 3).
    const titled = await metaClick('OSC 8 title', 12, 10);
    rec.check('a ⌘-click on an OSC 8 TITLE opens exactly one URL', titled.opened === 1, String(titled.opened));
    rec.check(
        'and it is the whole address the escape sequence carried, not the words on screen',
        titled.url === OSC8_TITLED_URL,
        `${String(titled.url)} (want ${OSC8_TITLED_URL})`
    );

    // Box B: the same URL hyperlinked across two hard-wrapped rows. Both rows must answer in
    // full; the head row must not answer the fragment it displays.
    const wrappedHead = await metaClick('OSC 8 head row', 7, 12);
    rec.check('a ⌘-click on the HEAD row of a hyperlinked wrapped URL opens once', wrappedHead.opened === 1, String(wrappedHead.opened));
    rec.check(
        'and it opens the COMPLETE url, not the fragment that row displays',
        wrappedHead.url === OSC8_WRAPPED_URL,
        `${String(wrappedHead.url)} (want ${OSC8_WRAPPED_URL})`
    );

    const wrappedTail = await metaClick('OSC 8 tail row', 8, 8);
    rec.check('a ⌘-click on the TAIL row opens once too', wrappedTail.opened === 1, String(wrappedTail.opened));
    rec.check(
        'and the tail row also opens the complete url',
        wrappedTail.url === OSC8_WRAPPED_URL,
        `${String(wrappedTail.url)} (want ${OSC8_WRAPPED_URL})`
    );

    /*
     * Box A: the same shape with NO hyperlink, which is the case the daemon cannot solve and
     * must therefore not get wrong. The head row displays a valid URL that is the wrong one;
     * `clippedByBorder` declines it because it runs flush into the frame, and the client says
     * so. Opening the truncated address is the behaviour being removed, so this check is the
     * one that must NOT read "opened 1".
     */
    const plainHead = await metaClick('plain head row', 2, 12);
    rec.note(`the whole address that box A would have needed: ${PLAIN_URL}`);
    rec.check(
        'a ⌘-click on the head row of a NON-hyperlinked wrapped URL opens nothing',
        plainHead.opened === 0,
        `opened ${String(plainHead.opened)} (${String(plainHead.url)})`
    );
    // The toast lives for ERROR_TOAST_MS (6s), so this has to be read promptly after the click.
    const toast = await d.settle(
        async () =>
            (await page.eval(
                `(document.querySelector('[data-testid="toast-stack"]')?.textContent ?? '').includes('probably cut off')`
            )) === true,
        { ceilingMs: 3_000, intervalMs: 100 }
    );
    rec.check('and it is not silent: the client says the link is probably cut off', toast);
    await rec.shot(page, 'clipped-toast');

    const plainTail = await metaClick('plain tail row', 3, 8);
    rec.check(
        'the tail row of a NON-hyperlinked wrapped URL opens nothing (documented limitation)',
        plainTail.opened === 0,
        `opened ${String(plainTail.opened)}`
    );

    // ── the TUI's own mouse ─────────────────────────────────────────────────────────
    //
    // Every click above was a ⌘-click, and not one of them may have reached the application.
    const readLog = () => {
        try {
            return fs.readFileSync(logPath);
        } catch {
            return Buffer.alloc(0);
        }
    };
    const afterMeta = readLog();
    rec.check(
        'not one ⌘-click was ALSO reported to the TUI as a button press',
        afterMeta.length === 0,
        `${String(afterMeta.length)} bytes: ${JSON.stringify(afterMeta.toString('latin1'))}`
    );

    // A PLAIN click at the same point is the application's, and still is.
    const beforePlain = await harness.counters();
    const point = at(12, 10);
    await page.clickAt(point.x, point.y);
    const reported = await d.settle(async () => readLog().length > 0, { ceilingMs: 4_000, intervalMs: 100 });
    const bytes = readLog().toString('latin1');
    rec.note(`plain click delivered: ${JSON.stringify(bytes)}`);
    // SGR 1006: ESC [ < button ; col ; row M for the press, lowercase m for the release.
    const sgr = /\x1b\[<0;(\d+);(\d+)M/.exec(bytes);
    rec.check('a PLAIN click still reaches the TUI as an SGR mouse report', reported && sgr !== null, JSON.stringify(bytes));
    if (sgr !== null) {
        // 1-based in the report; the title sits on screen row 13, and the click was at 0-based
        // viewport row 12.
        rec.check('and it names the cell that was clicked', Number(sgr[2]) === 13, `row ${String(sgr[2])} of ${String(bytes)}`);
    }
    const afterPlain = await harness.counters();
    rec.check(
        'a plain click opens nothing: ⌘ is what makes it a link click',
        afterPlain.externalOpens === beforePlain.externalOpens,
        `${String(beforePlain.externalOpens)} -> ${String(afterPlain.externalOpens)}`
    );

    // ── leave the pane in a state a human could use ────────────────────────────────
    await page.key('KeyC', { modifiers: d.MOD.ctrl });
    await sleep(300);
    await d.runInTerminal(page, "stty echo icanon; printf '\\033[?1000l\\033[?1006l\\033[?1049l'", { settleMs: 400 });
}
