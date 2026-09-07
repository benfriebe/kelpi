/**
 * #80: with the kitty keyboard protocol on, ⌘V still pastes.
 *
 * terminal-surface.md §10.2.1. The user's report is "sometimes I need to press CMD+V to paste,
 * sometimes it's CONTROL+V", and the "sometimes" is an application having negotiated the
 * protocol in that pane. The pane's capture-phase interceptor encoded ⌘V as `CSI 118;9u` and
 * called `preventDefault()`, which killed the paste the engine and the shell's Edit menu would
 * otherwise have delivered.
 *
 * The measurement is the PTY's own bytes, read back through `cat -vt`, because that is the one
 * place the difference is visible: `^[[118;9u` on the shipped tree, the payload inside the
 * `^[[200~` envelope on this one.
 *
 * Two guards keep it from passing vacuously:
 *   1. the protocol is asserted LIVE (`data-terminal-kitty="3"`) at the moment of the press,
 *      and the run stops if it is not, so a scenario that quietly lost the negotiation cannot
 *      report a green ⌘V;
 *   2. ⌘B is pressed first and MUST arrive as `^[[98;9u`. That proves the interceptor is
 *      running and encoding super chords, so "⌘V was not encoded" is an exemption rather than
 *      an interceptor that happened to be asleep.
 */

/**
 * The source this presses (ui-audit/README.md ▸ The rule). `kitty-keyboard.ts` holds
 * `isSystemEditingChord` and the encoder it guards; `TerminalPane.tsx` is the capture-phase
 * interceptor whose `preventDefault()` is what the exemption exists to avoid.
 */
export const covers = [
    'packages/client/src/terminal/kitty-keyboard.ts',
    'packages/client/src/terminal/TerminalPane.tsx'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const PAYLOAD = `KELPI-KITTY-PASTE-${TAG}`;

export default async function ({ page, harness, cli, rec, d, sleep }) {
    // The first workspace's pane is painted a beat after the app root is up, and a run that
    // asked for it too early would fail as "no pane" rather than as the thing under test.
    await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
    const paneIDs = await d.domPaneIDs(page);
    const paneID = paneIDs[0];
    rec.check('a terminal pane to negotiate in', paneID !== undefined, JSON.stringify(paneIDs));
    if (paneID === undefined) return;
    rec.note(`target pane: ${String(paneID)}`);

    const paneRoot = `[data-pane-id="${paneID}"][data-terminal-status]`;
    const readFlags = async () =>
        await page.eval(
            `(() => document.querySelector('${paneRoot}')?.getAttribute('data-terminal-kitty') ?? null)()`
        );
    const capture = async () => await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
    /** Poll the pane's screen for the state the assertion below reads, then read it once more. */
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
    /** Enter through the daemon, so a kitty-encoded Return can never be what flushes the line. */
    const submit = async () => {
        await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
        await sleep(300);
    };

    await d.focusPaneBody(page, paneID);
    // Bracketed paste ON and the protocol negotiated, in one line, then a reader that prints
    // what the PTY actually received.
    await d.runInTerminal(page, `printf '\\033[?2004h\\033[>3u'`, { settleMs: 600 });
    await d.runInTerminal(page, 'cat -vt', { settleMs: 800 });

    const negotiated = await d.settle(async () => (await readFlags()) === '3', { ceilingMs: 5_000, intervalMs: 150 });
    rec.check('the pane reports the negotiated kitty flags (data-terminal-kitty="3")', negotiated, String(await readFlags()));
    if (!negotiated) return;

    // ── guard: the interceptor IS running, and it does encode super chords ──────────
    await page.key('KeyB', { modifiers: d.MOD.meta, key: 'b' });
    await sleep(120);
    await submit();
    const encoded = await captureUntil((text) => text.includes('^[[98;9u'));
    rec.check(
        '⌘B still reaches the application as the kitty chord `^[[98;9u` (the interceptor is live)',
        encoded.includes('^[[98;9u'),
        encoded.slice(-200)
    );
    if (!encoded.includes('^[[98;9u')) return;

    // ── the fix: ⌘V is handed to the layers below, and a real paste happens ─────────
    /*
     * The seed goes through the SHELL, not through the page (#109).
     *
     * `navigator.clipboard.writeText` needs the document focused, and throws `NotAllowedError:
     * Document is not focused` the instant it is not. Measured 2026-09-08 00:13: this line
     * failed exactly that way in a hidden-lane battery whose earlier scenario had blurred the
     * window, and passed alone every time. The window's focus is not this scenario's subject
     * (⌘V with the kitty protocol on is), so the seed must not depend on it: `clipboardWrite`
     * is Electron's `clipboard` in the main process, the same NSPasteboard with no focus rule,
     * and it answers with what it reads back so this is proof rather than an "it did not throw".
     */
    const seeded = await harness.clipboardWrite(PAYLOAD);
    rec.check('the clipboard holds the payload', seeded.text === PAYLOAD, JSON.stringify(seeded));
    if (seeded.text !== PAYLOAD) {
        rec.note('the clipboard could not be seeded in this lane; the paste assertion below cannot run');
        return;
    }

    rec.check('the protocol is STILL on at the moment of the press', (await readFlags()) === '3', String(await readFlags()));

    // ⌘V exactly as Chromium delivers it on macOS: the chord AND the editing command. Without
    // `commands`, a dispatched keydown is a chord with no paste behind it and the step would
    // measure nothing.
    await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        code: 'KeyV',
        key: 'v',
        windowsVirtualKeyCode: 86,
        nativeVirtualKeyCode: 86,
        modifiers: d.MOD.meta,
        commands: ['paste']
    });
    // DURATION-ASSERTION: the key HOLD. A keyDown/keyUp pair with no time between them is not a
    // keypress the engine's own handling will honour.
    await sleep(40);
    await page.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        code: 'KeyV',
        key: 'v',
        windowsVirtualKeyCode: 86,
        nativeVirtualKeyCode: 86,
        modifiers: d.MOD.meta
    });

    const pasted = await captureUntil((text) => text.includes(PAYLOAD) || text.includes('^[[118;9u'));
    await submit();
    const after = await captureUntil((text) => text.includes(PAYLOAD) || text.includes('^[[118;9u'));
    rec.note(`screen tail after ⌘V: ${JSON.stringify(after.slice(-240))}`);

    rec.check(
        'the payload reached the PTY (⌘V pasted at all)',
        after.includes(PAYLOAD),
        `pasted=${String(pasted.includes(PAYLOAD))} after-enter=${String(after.includes(PAYLOAD))}`
    );
    rec.check(
        'and it arrived inside the bracketed-paste envelope `^[[200~`',
        after.includes(`^[[200~${PAYLOAD}`),
        JSON.stringify(after.split('\n').find((line) => line.includes('^[[200~')) ?? '(no bracketed line)')
    );
    rec.check(
        'and ⌘V was NOT encoded as the kitty chord `^[[118;9u` (#80)',
        !after.includes('^[[118;9u'),
        after.includes('^[[118;9u') ? 'the CSI u sequence is on screen' : 'absent'
    );
    await rec.shot(page, 'kitty-cmd-v-pasted');

    /*
     * Put the pane back the way it was found.
     *
     * The battery runs every scenario against ONE sandbox, and both this file and
     * `terminal-copy-paste-chords.mjs` take `domPaneIDs(page)[0]`, so this is literally the same
     * pane. Left as it stands at the last assertion it has `cat -vt` in the foreground and the
     * kitty protocol pushed at `>3u`, which means the next scenario's `clear`, its `for` loop and
     * its `printf '\\033[?1000h'` are all just text echoed at `cat`: its drag then selects this
     * scenario's leftovers, its ⌘C copies them, and its mouse mode never arrives.
     *
     * `cmd-click-codex-links.mjs` and `cmd-backspace-line-kill.mjs` both already end this way;
     * this file is the one that came first and did not. Exactly the three things it turned on,
     * turned off: the foreground reader, the kitty stack, bracketed paste.
     */
    await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
    await sleep(600);
    await d.runInTerminal(page, `printf '\\033[?2004l\\033[<1u'`, { settleMs: 500 });
    await d.runInTerminal(page, 'stty sane', { settleMs: 500 });
    await d.runInTerminal(page, 'clear', { settleMs: 500 });
}
