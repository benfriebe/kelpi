/**
 * ⌘K clears a terminal pane's screen and its scrollback.
 *
 * terminal-surface.md section 10.4, config-keybindings.md section 4 (category "Terminal").
 *
 * The report is "Clear Screen (⌘K) no longer works in Kelpi". The pre-port app got the chord from
 * libghostty's own default (`super+k=clear_screen`); this port ships its own binding table, which
 * had no such action, so the chord fell through to the terminal as a keystroke and cleared
 * nothing.
 *
 * **The instrument is `pane capture --scrollback`, not the canvas.** The history that matters is
 * the daemon's: it is what a re-attach replays, what `pane capture` reads and what a handoff
 * checkpoints. A clear that only wiped the window's engine would pass a screenshot and bring the
 * whole history back on the next workspace switch.
 */

/**
 * The source this presses (ui-audit/README.md ▸ The rule). `clear-screen.ts` is the action,
 * `bindings.ts` its default trigger, `service.ts` the buffer it empties, `streams.ts` the re-seed
 * that puts every attached window on the emptied buffer, and `desktop.ts` the verb between them.
 */
export const covers = [
    'packages/client/src/app/clear-screen.ts',
    'packages/core/src/config/bindings.ts',
    'packages/daemon/src/term/service.ts',
    'packages/daemon/src/ws/streams.ts',
    'packages/daemon/src/ws/desktop.ts'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const HISTORY = `KELPI-HISTORY-${TAG}`;
const AFTER = `KELPI-AFTER-${TAG}`;
const KEPT = `KELPI-KEPT-${TAG}`;
const ABOVE = `KELPI-ABOVE-${TAG}`;
const CURSOR = `KELPI-CURSOR-${TAG}`;
const BELOW = `KELPI-BELOW-${TAG}`;
const LINES = 200;

export default async function ({ page, cli, rec, d, sleep }) {
    await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
    const paneID = (await d.domPaneIDs(page))[0];
    rec.check('a terminal pane to type into', paneID !== undefined);
    if (paneID === undefined) return;
    rec.note(`target pane: ${String(paneID)}`);

    const capture = async () => await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
    const captureUntil = async (predicate, ceilingMs = 4_000) => {
        const deadline = Date.now() + ceilingMs;
        let text = '';
        do {
            text = await capture();
            if (predicate(text)) return text;
            await sleep(120);
        } while (Date.now() < deadline);
        return text;
    };
    const historyLines = (text) => text.split('\n').filter((line) => line.startsWith(`${HISTORY}-`)).length;
    const pressClear = async () => {
        await page.key('KeyK', { key: 'k', keyCode: 75, modifiers: d.MOD.meta });
        await sleep(400);
    };

    await d.focusPaneBody(page, paneID);

    // ── a pane with history well past one screen ───────────────────────────────────
    await d.runInTerminal(page, `for i in $(seq 1 ${String(LINES)}); do echo ${HISTORY}-$i; done`, { settleMs: 900 });
    const filled = await captureUntil((text) => text.includes(`${HISTORY}-${String(LINES)}`));
    rec.note(`history lines before ⌘K: ${String(historyLines(filled))}`);
    rec.check(
        'the pane holds its history before the clear',
        historyLines(filled) === LINES,
        `${String(historyLines(filled))} of ${String(LINES)}`
    );
    await rec.shot(page, 'before-clear');

    // ── the chord ──────────────────────────────────────────────────────────────────
    await pressClear();
    const cleared = await captureUntil((text) => historyLines(text) === 0);
    rec.note(`buffer after ⌘K: ${JSON.stringify(cleared.slice(-200))}`);
    rec.check(
        '⌘K empties the screen and the scrollback',
        historyLines(cleared) === 0,
        `${String(historyLines(cleared))} history lines still in the buffer`
    );
    await rec.shot(page, 'after-clear');

    // The chord is consumed: nothing it stands for may reach the shell as typed text.
    await d.runInTerminal(page, `echo ${AFTER}`, { settleMs: 600 });
    const after = await captureUntil((text) => text.split('\n').some((line) => line.trim() === AFTER));
    rec.note(`buffer after the next command: ${JSON.stringify(after.slice(-200))}`);
    rec.check(
        'the prompt still takes a command afterwards',
        after.split('\n').some((line) => line.trim() === AFTER),
        after.slice(-200)
    );
    rec.check(
        'and ⌘K typed nothing into it',
        !after.includes('command not found') && !after.includes(`k${`echo ${AFTER}`}`),
        after.slice(-200)
    );

    // ── a program drawing around its cursor keeps what is on and under that row ─────
    // An agent's input box in miniature: a row above the cursor, the cursor's row, a row beneath
    // it, and a program (`cat`) that will not repaint any of them.
    await d.runInTerminal(page, `printf '${ABOVE}\\n${CURSOR}\\n${BELOW}\\033[1A'; cat`, { settleMs: 700 });
    await captureUntil((text) => text.includes(BELOW));
    await pressClear();
    const around = await captureUntil((text) => !text.includes(ABOVE));
    rec.note(`buffer after ⌘K with rows around the cursor: ${JSON.stringify(around.slice(-200))}`);
    rec.check('the rows above the cursor are cleared', !around.includes(ABOVE), around.slice(-200));
    rec.check(
        'the cursor s row and the row beneath it are kept, moved to the top',
        around.trimEnd().split('\n').map((line) => line.trim()).join('|') === `${CURSOR}|${BELOW}`,
        around.slice(-200)
    );
    await rec.shot(page, 'rows-under-the-cursor-kept');
    await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
    await sleep(500);

    // ── a full-screen program keeps its screen, and the history behind it ──────────
    await d.runInTerminal(page, `for i in $(seq 1 ${String(LINES)}); do echo ${KEPT}-$i; done`, { settleMs: 900 });
    await captureUntil((text) => text.includes(`${KEPT}-${String(LINES)}`));
    await d.runInTerminal(page, `printf '\\033[?1049h\\033[H${KEPT}-ALT'; cat`, { settleMs: 700 });
    await pressClear();
    const alternate = await cli.ok(['pane', 'capture', '--target', paneID]);
    rec.check(
        'on the alternate screen ⌘K leaves the program s screen alone',
        alternate.includes(`${KEPT}-ALT`),
        alternate.slice(0, 120)
    );
    await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
    await sleep(500);
    await d.runInTerminal(page, `printf '\\033[?1049l'`, { settleMs: 600 });
    const restored = await capture();
    rec.check(
        'and the history behind it is still there when the program exits',
        restored.includes(`${KEPT}-${String(LINES)}`),
        restored.slice(-160)
    );
}
