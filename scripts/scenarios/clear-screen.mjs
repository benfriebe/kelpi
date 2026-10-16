/**
 * ⌘K clears the terminal: screen and scrollback, as Ghostty's macOS `clear_screen` does and as
 * Nex did (config-keybindings.md section 4, category "Terminal"; wire-protocol.md `pane-clear`).
 *
 * The user's report is "Clear Screen (cmd/⌘ + K) no longer works in Kelpi (used to work in Nex)".
 * Nex got the chord from libghostty's default keybinds; Kelpi's own binding layer had no such
 * action, so ⌘K did nothing at all.
 *
 * The daemon does the clearing, in the pane's output stream, so the assertions read the DAEMON's
 * screen (`pane capture --scrollback`, which is also what a reattach would replay). The shipped
 * engine's half of the agreement is `client/src/terminal/clear-screen.wasm.test.ts`; the shots
 * here are the window's.
 *
 * The sandbox's shell is `/bin/sh`, which the daemon does not treat as a line-editing shell (on
 * Linux it is dash, which would type ⌃L into the line), so the pane `exec`s a bare zsh first: the
 * same pid, now a shell whose prompt the daemon can see and whose zle redraws on ⌃L.
 *
 * That pane is one of its own, split off the window's first pane and closed at the end. The
 * battery runs every scenario against one sandbox, and several later ones take
 * `domPaneIDs(page)[0]` and expect `sh`: after an `exec zsh` there, `cmd-backspace-line-kill`
 * sliced its byte matrix off a shorter prompt and `kitty-keeps-system-chords` lost its
 * bracketed paste to zle (#420). The split is `vertical` (stacked, the ⌘⇧D split) so the pane
 * keeps the first pane's width: the redrawn prompt below is checked to be one line, which a soft
 * wrap would break. `pane split` takes only `horizontal | vertical`, and any other word is
 * dropped for the side-by-side default, so the width is checked rather than assumed.
 *
 * Three cases, Ghostty's three:
 *  - at a prompt, with a half-typed command: everything goes, and the shell redraws its prompt
 *    with the typed text still on it;
 *  - while a command runs: the scrollback and the rows above the cursor go, the cursor's row
 *    becomes the top row (Ghostty removes the rows rather than blanking them), and nothing is
 *    typed at the program (no `^L` echoed);
 *  - on the alternate screen: nothing is cleared, the history is still there afterwards, and the
 *    chord is taken rather than typing a bare `k` at the app (Ghostty's macOS encoder writes
 *    nothing for a ⌘ chord).
 */

export const covers = [
    'packages/client/src/app/clear-screen.ts',
    'packages/core/src/config/bindings.ts',
    'packages/daemon/src/term/clear-screen.ts',
    'packages/daemon/src/pty/shell-foreground.ts',
    'packages/daemon/src/handlers/pane/clear.ts'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const TYPED = `echo KELPI-CLEAR-${TAG}`;
const RUNNING = `KELPI-RUNNING-${TAG}`;

/** The pane wearing the focus ring: the one the client's ⌘K clears. */
const RINGED_PANE = `(() => {
    const el = document.querySelector('[data-pane-id][data-focused="true"]');
    return el === null ? '' : (el.getAttribute('data-pane-id') ?? '');
})()`;

export default async function ({ page, cli, rec, d, sleep }) {
    await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
    const firstPane = (await d.domPaneIDs(page))[0];
    rec.check('a terminal pane to split from', firstPane !== undefined);
    if (firstPane === undefined) return;

    const paneID = JSON.parse(await cli.ok(['pane', 'split', '--target', firstPane, '--direction', 'vertical', '--json'])).pane_id;
    rec.note(`target pane: ${String(paneID)} (split off ${String(firstPane)})`);
    try {
        await clearScreenCases({ page, cli, rec, d, sleep, paneID, firstPane });
    } finally {
        await cli.run(['pane', 'close', '--target', paneID]);
        const gone = await d.settle(async () => !(await d.domPaneIDs(page)).includes(paneID), { ceilingMs: 8_000, intervalMs: 150 });
        rec.check('its own pane closed again', gone);
        let refocused = false;
        try {
            await d.focusPaneBody(page, firstPane);
            refocused = await d.settle(async () => (await page.eval(RINGED_PANE)) === firstPane, { ceilingMs: 3_000, intervalMs: 100 });
        } catch {}
        rec.check(
            'and the first pane is still first, with the focus back, for the scenario after this one',
            (await d.domPaneIDs(page))[0] === firstPane && refocused,
            `panes ${JSON.stringify(await d.domPaneIDs(page))}, ringed ${String(await page.eval(RINGED_PANE))}`
        );
    }
}

async function clearScreenCases({ page, cli, rec, d, sleep, paneID, firstPane }) {
    const mounted = await d.settleDom(page, `document.querySelectorAll('[data-pane-id="${paneID}"] [data-pane-surface] textarea').length > 0`, { ceilingMs: 15_000 });
    rec.check('its own pane mounted a terminal surface', mounted);
    if (!mounted) return;
    const widths = await page.eval(`[${JSON.stringify(firstPane)}, ${JSON.stringify(paneID)}].map((id) => document.querySelector('[data-testid="pane-body-' + id + '"]')?.getBoundingClientRect().width ?? 0)`);
    rec.check('and it is stacked below the first pane, at the same width', Math.abs(widths[0] - widths[1]) <= 2 && widths[1] > 0, JSON.stringify(widths));

    const capture = async () => await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
    const captureUntil = async (predicate, ceilingMs = 3_000) => {
        const deadline = Date.now() + ceilingMs;
        let text = '';
        do {
            text = await capture();
            if (predicate(text)) return text;
            await sleep(120);
        } while (Date.now() < deadline);
        return text;
    };
    const pressCmdK = async () => {
        await page.key('KeyK', { modifiers: d.MOD.meta, key: 'k' });
        await sleep(400);
    };
    /** A run of numbered lines long enough to push most of them into the scrollback. */
    const fill = async (prefix) => {
        await d.runInTerminal(page, `for i in $(seq 1 120); do echo ${prefix}-$i; done`, { settleMs: 900 });
    };

    // A CLI split never takes focus, and ⌘K clears the CLIENT's focused pane: without this a
    // ⌘K that cleared the first pane instead could still pass.
    await d.focusPaneBody(page, paneID);
    const focused = await d.settle(async () => (await page.eval(RINGED_PANE)) === paneID, { ceilingMs: 5_000, intervalMs: 100 });
    rec.check('its own pane has the focus the ⌘K presses go to', focused, `ringed ${String(await page.eval(RINGED_PANE))}`);
    if (!focused) return;
    // A pane moments old can lose what is typed before its shell has drawn a prompt
    // (`ui-audit/audit.mjs` ▸ `settleShellPane`), and a mangled `exec` would leave this in sh.
    const prompted = await d.settle(async () => (await capture()).trim().length > 0, { ceilingMs: 10_000, intervalMs: 150 });
    rec.check('its shell drew a prompt before anything was typed', prompted);
    if (!prompted) return;
    await d.runInTerminal(page, `exec zsh -f`, { settleMs: 1_200 });

    // ── at a prompt ────────────────────────────────────────────────────────────────
    await fill('HIST');
    const filled = await captureUntil((text) => text.includes('HIST-120'));
    rec.check('the pane has scrollback to clear', filled.includes('HIST-5\n') && filled.includes('HIST-120'), filled.slice(-80));
    await page.type(TYPED);
    await captureUntil((text) => text.includes(TYPED));
    await rec.shot(page, 'before-cmd-k-at-prompt');

    await pressCmdK();
    const cleared = await captureUntil((text) => !text.includes('HIST-') && text.includes(TYPED));
    rec.note(`after ⌘K at a prompt: ${JSON.stringify(cleared)}`);
    rec.check('⌘K at a prompt empties the scrollback', !cleared.includes('HIST-'), cleared.slice(0, 200));
    rec.check(
        'and the shell redrew its prompt, with the half-typed command still on it, on the TOP row',
        cleared.includes(TYPED) && !cleared.startsWith('\n') && cleared.trim().split('\n').length === 1,
        cleared
    );
    await rec.shot(page, 'after-cmd-k-at-prompt');

    // The typed command still runs: ⌃L redrew the line, it did not eat it.
    await page.key('Enter');
    const ran = await captureUntil((text) => text.includes(`\nKELPI-CLEAR-${TAG}`));
    rec.check('the half-typed command still runs after the clear', ran.includes(`\nKELPI-CLEAR-${TAG}`), ran.slice(-160));

    // ── while a command runs ───────────────────────────────────────────────────────
    await fill('BUSY');
    await d.runInTerminal(page, `printf '${RUNNING}'; sleep 30`, { settleMs: 900 });
    await captureUntil((text) => text.includes(RUNNING));
    await pressCmdK();
    const busy = await captureUntil((text) => !text.includes('BUSY-'));
    rec.note(`after ⌘K while sleep runs: ${JSON.stringify(busy)}`);
    rec.check('⌘K while a command runs empties the scrollback and the rows above', !busy.includes('BUSY-'), busy.slice(0, 200));
    rec.check(
        'and keeps the running command’s own row, moved to the TOP row as Ghostty moves it',
        busy.trim() === RUNNING && !busy.startsWith('\n'),
        busy
    );
    rec.check('and types nothing at the running program (no ^L echoed)', !busy.includes('^L'), busy);
    await rec.shot(page, 'after-cmd-k-while-running');
    await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
    await sleep(600);

    // ── on the alternate screen ────────────────────────────────────────────────────
    await fill('ALT');
    await captureUntil((text) => text.includes('ALT-120'));
    await d.runInTerminal(page, `printf '\\033[?1049h\\033[HFULLSCREEN'; sleep 4; printf '\\033[?1049l'`, { settleMs: 1_000 });
    await pressCmdK();
    await rec.shot(page, 'cmd-k-on-alternate-screen');
    const back = await captureUntil((text) => text.includes('ALT-120') && !text.includes('FULLSCREEN'), 6_000);
    rec.note(`after leaving the alternate screen: ${JSON.stringify(back.slice(-120))}`);
    rec.check('⌘K on the alternate screen clears nothing: the history is all still there', back.includes('ALT-5\n') && back.includes('ALT-120'), back.slice(-160));
    // The engine types the bare letter for a ⌘ chord nothing takes, so a `k` at the prompt that
    // follows is a ⌘K that reached the app. The last line is the prompt, empty.
    const lastLine = back.trimEnd().split('\n').at(-1) ?? '';
    rec.check('and no stray k reached the full-screen app', !/%\s*k$/.test(lastLine), lastLine);
}
