/**
 * #82: ⌘Backspace kills the line, legacy and under the kitty protocol.
 *
 * terminal-surface.md section 10.3, config-keybindings.md section 4 (category "Terminal").
 *
 * The user's report is "CMD+BACKSPACE doesn't clear the full line (sometimes?)". It sent one DEL
 * in a shell pane (the legacy encoder drops super, so ⌘Backspace was byte-identical to Backspace)
 * and `CSI 127;9u` in an agent pane, which a TUI ignores. Ghostty's macOS default sends `0x15`.
 *
 * **The instrument is `stty -icanon -echo; cat -v`, not plain `cat -v`.** `0x15` is VKILL: in
 * canonical mode the line discipline eats it to erase the line being assembled, and no program
 * ever sees the byte. With `-icanon` the tty passes it straight through and `cat -v` prints `^U`,
 * so the assertion reads the byte the PTY actually received rather than a side effect. The
 * user-visible half is measured separately, at a real shell prompt, where the line discipline
 * doing its job IS the behaviour.
 *
 * The modifier matrix is asserted alongside, because the risk of a fix like this is that it
 * changes a Backspace it had no business touching: bare, ctrl and alt must be exactly what they
 * were.
 */

/**
 * The source this presses (ui-audit/README.md ▸ The rule). `line-editing.ts` holds the bytes and
 * the decision, `bindings.ts` the three default triggers, `pane-registry.ts` the write seam that
 * carries them, and `kitty-keyboard.ts` is the layer this has to sit above.
 */
export const covers = [
    'packages/client/src/app/line-editing.ts',
    'packages/core/src/config/bindings.ts',
    'packages/client/src/terminal/pane-registry.ts',
    'packages/client/src/terminal/kitty-keyboard.ts'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const TYPED = `KELPI-KILL-${TAG}`;

export default async function ({ page, cli, rec, d, sleep }) {
    await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
    const paneID = (await d.domPaneIDs(page))[0];
    rec.check('a terminal pane to type into', paneID !== undefined);
    if (paneID === undefined) return;
    rec.note(`target pane: ${String(paneID)}`);

    const paneRoot = `[data-pane-id="${paneID}"][data-terminal-status]`;
    const readFlags = async () =>
        await page.eval(
            `(() => document.querySelector('${paneRoot}')?.getAttribute('data-terminal-kitty') ?? null)()`
        );
    const capture = async () => await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
    const captureUntil = async (predicate, ceilingMs = 2_500) => {
        const deadline = Date.now() + ceilingMs;
        let text = '';
        do {
            text = await capture();
            if (predicate(text)) return text;
            await sleep(120);
        } while (Date.now() < deadline);
        return text;
    };
    /** Enter through the daemon: under the kitty protocol a Return keystroke may not be `\r`. */
    const submit = async () => {
        await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
        await sleep(300);
    };

    await d.focusPaneBody(page, paneID);

    // ── the byte matrix, with the line discipline out of the way ───────────────────
    await d.runInTerminal(page, 'clear', { settleMs: 500 });
    await d.runInTerminal(page, 'stty -icanon -echo; cat -v', { settleMs: 900 });

    const pressBackspace = async (modifiers = 0) => {
        await page.key('Backspace', { modifiers, key: 'Backspace' });
        // DURATION-ASSERTION: keystroke SPACING. The presses are read back out of `cat -v` as a
        // sequence, and keys dispatched in the same tick coalesce before the PTY sees them.
        await sleep(140);
    };

    await pressBackspace(d.MOD.meta);
    const killed = await captureUntil((text) => text.includes('^U'));
    rec.note(`screen after ⌘Backspace: ${JSON.stringify(killed.slice(-120))}`);
    rec.check(
        '⌘Backspace reaches the PTY as ^U (0x15), Ghostty s macOS default (#82)',
        killed.includes('^U'),
        killed.slice(-120)
    );
    rec.check(
        'and NOT as a bare DEL, which is what it used to send',
        killed.includes('^U') && !killed.replace(/\^U/g, '').includes('^?'),
        killed.slice(-120)
    );

    await page.key('ArrowLeft', { modifiers: d.MOD.meta, key: 'ArrowLeft' });
    await sleep(140);
    await page.key('ArrowRight', { modifiers: d.MOD.meta, key: 'ArrowRight' });
    await sleep(140);
    const arrows = await captureUntil((text) => text.includes('^A') && text.includes('^E'));
    rec.check(
        '⌘← is ^A and ⌘→ is ^E, the two siblings Ghostty ships in the same block',
        arrows.includes('^A') && arrows.includes('^E'),
        arrows.slice(-120)
    );

    // The modifiers this fix must NOT have touched.
    const before = await capture();
    await pressBackspace(0);
    await pressBackspace(d.MOD.ctrl);
    await pressBackspace(d.MOD.alt);
    const matrix = (await captureUntil((text) => text.length > before.length)).slice(before.length - 40);
    rec.note(`matrix tail: ${JSON.stringify(matrix.slice(-80))}`);
    rec.check('a bare Backspace is still ^? (DEL)', matrix.includes('^?'), matrix.slice(-80));
    rec.check('ctrl+Backspace is still ^H (0x08)', matrix.includes('^H'), matrix.slice(-80));
    rec.check('alt+Backspace is still ESC DEL (^[^?)', matrix.includes('^[^?'), matrix.slice(-80));
    await rec.shot(page, 'legacy-byte-matrix');

    // ── the same chord with the kitty protocol negotiated ──────────────────────────
    await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
    await sleep(600);
    await d.runInTerminal(page, 'stty sane', { settleMs: 500 });
    await d.runInTerminal(page, 'clear', { settleMs: 400 });
    await d.runInTerminal(page, `printf '\\033[>3u'`, { settleMs: 600 });
    await d.runInTerminal(page, 'stty -icanon -echo; cat -vt', { settleMs: 900 });
    const negotiated = await d.settle(async () => (await readFlags()) === '3', { ceilingMs: 5_000, intervalMs: 150 });
    rec.check('the pane reports the negotiated kitty flags (data-terminal-kitty="3")', negotiated, String(await readFlags()));

    if (negotiated) {
        const kittyBefore = await capture();
        await pressBackspace(d.MOD.meta);
        const kitty = await captureUntil((text) => text.length > kittyBefore.length, 2_000);
        const tail = kitty.slice(kittyBefore.length - 40);
        rec.note(`screen after ⌘Backspace with the protocol on: ${JSON.stringify(tail.slice(-120))}`);
        rec.check(
            'with the protocol ON it is still ^U, because a bound chord never reaches the encoder',
            tail.includes('^U'),
            tail.slice(-120)
        );
        rec.check(
            'and never the kitty PRESS chord `^[[127;9u` the TUI ignores',
            !tail.includes('^[[127;9u'),
            tail.includes('^[[127;9u') ? 'the CSI u sequence is on screen' : 'absent'
        );
        /*
         * The release (`^[[127;9:3u`) IS still there, and it is not #82's. The app's dispatcher
         * is a `keydown` listener only, so every bound chord has always leaked its kitty release
         * this way (⌘D does too). Applications key off presses, so it is inert; noted here rather
         * than asserted away, because a scenario that pretended otherwise would be lying about
         * what is on the wire.
         */
        rec.note(
            `kitty release still emitted for the consumed press (pre-existing for every bound chord): ${String(tail.includes('^[[127;9:3u'))}`
        );
        await rec.shot(page, 'kitty-still-kills');
    }

    // ── the user-visible half: a real prompt, cleared ──────────────────────────────
    await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
    await sleep(600);
    await d.runInTerminal(page, `printf '\\033[<1u'`, { settleMs: 500 });
    await d.runInTerminal(page, 'stty sane', { settleMs: 500 });
    await d.runInTerminal(page, 'clear', { settleMs: 500 });
    await page.type(TYPED);
    const typed = await captureUntil((text) => text.includes(TYPED), 2_000);
    rec.check('the line is on the prompt before the kill', typed.includes(TYPED), typed.slice(-120));
    await page.key('Backspace', { modifiers: d.MOD.meta, key: 'Backspace' });
    await sleep(400);
    await submit();
    const cleared = await capture();
    rec.note(`prompt after ⌘Backspace: ${JSON.stringify(cleared.slice(-160))}`);
    /*
     * Enter submitted an EMPTY line, so the shell printed a fresh prompt and never ran anything.
     * Both halves are needed: a one-character DEL (what the shipped tree sends) leaves a
     * TRUNCATED marker, which the shell then runs, so the assertion cannot look for the marker
     * verbatim. It looks for the prefix, and for the shell complaining at all.
     */
    rec.check(
        '⌘Backspace cleared the whole line at a real prompt (#82)',
        !cleared.includes('command not found') && !cleared.includes(TYPED.slice(0, 11)),
        cleared.slice(-160)
    );
    await rec.shot(page, 'prompt-cleared');
}
