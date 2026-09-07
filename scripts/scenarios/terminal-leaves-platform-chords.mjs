/**
 * #95: with a terminal pane focused, the chords macOS owns are left to macOS.
 *
 * terminal-surface.md section 10.2.1, config-keybindings.md section 7.4. The user's report is
 * "CMD+H only works in a browser pane": a web pane's page does not consume ⌘H, so Electron
 * redispatches the unhandled key and the `{ role: 'hide' }` accelerator fires; a terminal pane
 * consumed it twice over, so nothing happened. The same held for ⌥⌘H and ⌘M, and under the
 * kitty keyboard protocol the PTY was sent `^[[104;9u` for good measure.
 *
 * ## What this scenario can and cannot press, measured
 *
 * It cannot press the last hop. A CDP-injected key event has no backing `NSEvent`, and
 * Electron's macOS handler for an unhandled key is literally
 * `[[NSApp mainMenu] performKeyEquivalent:event.os_event]` - a message to nil for a synthetic
 * event, so the menu never sees it. **Measured on this tree** before the fix was written, with a
 * probe that pressed ⌘H and ⌘M through CDP while `document.body` had focus, i.e. with nothing at
 * all consuming them: `harness.window()` stayed `visible: true, minimized: false` every time.
 * `harness.press('Cmd+H')` is not an alternative either - it finds the row (`Hide Kelpi`,
 * `Command+H`) and calls its handler, and the app stays up, because a macOS-native `role` row's
 * work happens in Cocoa rather than in the JavaScript click. `harness.hide()` DOES hide the app,
 * and is the wrong instrument on purpose: it is the window call, not the chord.
 *
 * So the run asserts the two ends it can reach, and they are between them the whole of the fix:
 *
 *   1. **the platform's answer exists**, read off the LIVE application menu: five `role` rows
 *      carrying exactly the five accelerators `PLATFORM_CHORDS` names;
 *   2. **the page does not consume the chord**, which is the precise condition the redispatch
 *      runs on. `defaultPrevented` is read off the real event after dispatch, and under the
 *      kitty protocol the PTY's own bytes are read back through `cat -vt`.
 *
 * ## The guards that stop it passing vacuously
 *
 * ⌘B is pressed in both lanes and MUST be consumed: default-prevented in the legacy lane (the
 * engine mapped it), and delivered as `^[[98;9u` in the kitty lane (the interceptor encoded
 * it). A terminal that had simply stopped handling keys would fail those, so "⌘H was not
 * consumed" is an exemption rather than a dead pane. The kitty flags are re-read live at the
 * moment of each press for the same reason.
 *
 * ## What is deliberately NOT pressed
 *
 * ⌘Q and ⌃⌘F. Both are in the set, both are asserted in the menu leg and in the unit tests, and
 * neither is pressed here: the battery runs every scenario against ONE sandbox, so a run that
 * ever did fire Quit or Toggle Full Screen would take the rest of the battery with it. ⌘H and
 * ⌘M are safe to press for the same reason they are worth pressing - they are the user's report,
 * and `harness.restore()` undoes either.
 */

/**
 * The source this presses (ui-audit/README.md ▸ The rule). `platform-chords.ts` is the list;
 * `kitty-keyboard.ts` declines the chords in the encoder; `TerminalPane.tsx` is the capture-phase
 * guard that keeps the ENGINE from preventing their default; `chrome/keys.ts` is the dispatcher
 * whose step 6 lets an unbound chord fall through in the first place.
 */
export const covers = [
    'packages/core/src/config/platform-chords.ts',
    'packages/client/src/terminal/kitty-keyboard.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/chrome/keys.ts'
];

/** role -> the accelerator Electron gives it, exactly as `PLATFORM_CHORDS` restates it. */
const EXPECTED_ROLE_ACCELERATORS = [
    ['hide', 'Command+H'],
    ['hideothers', 'Command+Alt+H'],
    ['togglefullscreen', 'Control+Command+F'],
    ['minimize', 'CommandOrControl+M'],
    ['quit', 'CommandOrControl+Q']
];

/** Per-run, so a workspace name cannot collide with another scenario's in the shared sandbox. */
const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

/** The three chords this run actually presses. `label` is what a check says. */
const PRESSED = [
    { label: '⌘H (Hide)', code: 'KeyH', key: 'h', mods: ['meta'], csi: '^[[104;9u' },
    { label: '⌥⌘H (Hide Others)', code: 'KeyH', key: 'h', mods: ['meta', 'alt'], csi: '^[[104;11u' },
    { label: '⌘M (Minimize)', code: 'KeyM', key: 'm', mods: ['meta'], csi: '^[[109;9u' }
];

const PROBE = `(() => {
    const existing = window.__kelpiChordProbe;
    if (existing !== undefined) { existing.records.length = 0; return 'reused'; }
    const state = { records: [] };
    window.__kelpiChordProbe = state;
    // Capture on window, so it runs whatever any pane below does with propagation; the record's
    // \`prevented\` is filled in on a macrotask, i.e. after dispatch has finished and every
    // listener that could have called preventDefault has run.
    window.addEventListener('keydown', (event) => {
        const record = { code: event.code, meta: event.metaKey, alt: event.altKey, ctrl: event.ctrlKey, prevented: null };
        state.records.push(record);
        setTimeout(() => { record.prevented = event.defaultPrevented; }, 0);
    }, true);
    return 'installed';
})()`;

export default async function ({ page, harness, cli, rec, d, sleep }) {
    // ── 1. the platform's answer exists, on the live menu ───────────────────────────
    const menu = await harness.menu();
    const roles = new Map();
    const walk = (nodes) => {
        for (const node of nodes ?? []) {
            if (node.role) roles.set(node.role, node.accelerator);
            if (node.submenu) walk(node.submenu);
        }
    };
    walk(menu.items ?? menu);
    for (const [role, accelerator] of EXPECTED_ROLE_ACCELERATORS) {
        rec.check(
            `the menu answers ${accelerator} with { role: '${role}' }`,
            roles.get(role) === accelerator,
            `menu says ${JSON.stringify(roles.get(role) ?? null)}`
        );
    }

    // ── 2. a terminal pane to press into, in a workspace of this file's own ────────
    //
    // The same reason `terminal-copy-paste-chords.mjs` gives: the battery runs every scenario
    // against ONE sandbox, and by the time this one runs the Default workspace holds whatever
    // the scenarios before it left there - a pane mid-command, a pane running a reader, a pane
    // that is not even the focused one. This file needs a shell at a prompt, so it makes one.
    const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', `Chords-${TAG}`, '--json']));
    const workspaceID = created.workspace_id ?? created.id;
    rec.check('a workspace of its own to press in', typeof workspaceID === 'string', JSON.stringify(created));
    if (typeof workspaceID !== 'string') return;
    await d.settleDom(page, `document.querySelector('[data-workspace-id="${workspaceID}"]')`, { ceilingMs: 10_000 });
    await d.settle(async () => (await d.domPaneIDs(page)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });

    const paneID = (await d.domPaneIDs(page))[0];
    rec.check('a terminal pane to press into', paneID !== undefined);
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
    /** Enter through the daemon, so an encoded Return can never be what flushes the line. */
    const submit = async () => {
        await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
        await sleep(300);
    };

    const modifiersOf = (names) => names.reduce((bits, name) => bits | d.MOD[name], 0);
    const pressChord = async ({ code, key, mods }) => {
        await page.key(code, { modifiers: modifiersOf(mods), key });
        await sleep(120);
    };
    const records = async () => await page.eval(`JSON.stringify(window.__kelpiChordProbe.records)`);
    /** The probe's verdict for the LAST keydown it saw with this code, or null. */
    const verdictFor = async (code) => {
        // One macrotask past the last dispatch, so every `prevented` is filled in.
        await sleep(60);
        const all = JSON.parse(String(await records()));
        const hit = all.filter((entry) => entry.code === code).at(-1);
        return hit ?? null;
    };

    await d.focusPaneBody(page, paneID);
    rec.note(`probe: ${String(await page.eval(PROBE))}`);

    // ── 3. the legacy lane: the engine must not prevent these ──────────────────────
    //
    // The guard first. ⌘B is not the platform's, so the engine maps it and prevents it; a run
    // where this comes back "not prevented" is a pane that stopped handling keys, and every
    // assertion after it would be meaningless.
    await pressChord({ code: 'KeyB', key: 'b', mods: ['meta'] });
    const guardLegacy = await verdictFor('KeyB');
    rec.check(
        '⌘B is still consumed by the terminal with the protocol off (the engine is live)',
        guardLegacy?.prevented === true,
        JSON.stringify(guardLegacy)
    );
    if (guardLegacy?.prevented !== true) return;

    for (const chord of PRESSED) {
        await pressChord(chord);
        const verdict = await verdictFor(chord.code);
        rec.check(
            `${chord.label} reaches the end of dispatch un-prevented, so the accelerator can fire (#95)`,
            verdict?.prevented === false,
            JSON.stringify(verdict)
        );
    }
    // Belt and braces: if a future Electron ever DID redispatch a synthetic key, this puts the
    // window back before the next scenario runs in the same sandbox.
    rec.note(`window after the legacy lane: ${JSON.stringify(await harness.window())}`);
    await harness.restore();
    await rec.shot(page, 'legacy-lane');

    // ── 4. the kitty lane: nothing may reach the PTY ───────────────────────────────
    //
    // Clear the line first. ⌘B is the guard above and the ENGINE handled it, which in the legacy
    // encoding means a literal `b` on the shell's command line: without this the `printf` below
    // becomes `bprintf` and the protocol is never negotiated.
    await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
    await sleep(400);
    await d.focusPaneBody(page, paneID);
    await d.runInTerminal(page, 'clear', { settleMs: 400 });
    await d.runInTerminal(page, `printf '\\033[>3u'`, { settleMs: 600 });
    await d.runInTerminal(page, 'cat -vt', { settleMs: 800 });

    const negotiated = await d.settle(async () => (await readFlags()) === '3', {
        ceilingMs: 5_000,
        intervalMs: 150
    });
    rec.check(
        'the pane reports the negotiated kitty flags (data-terminal-kitty="3")',
        negotiated,
        String(await readFlags())
    );
    if (!negotiated) return;

    // The same guard again, in the lane where the INTERCEPTOR rather than the engine is the
    // thing that could have gone quiet: ⌘B must arrive on the PTY as the kitty chord.
    await pressChord({ code: 'KeyB', key: 'b', mods: ['meta'] });
    await submit();
    const encoded = await captureUntil((text) => text.includes('^[[98;9u'));
    rec.check(
        '⌘B still reaches the application as `^[[98;9u` (the interceptor is live)',
        encoded.includes('^[[98;9u'),
        encoded.slice(-200)
    );
    if (!encoded.includes('^[[98;9u')) return;

    rec.check('the protocol is STILL on at the moment of the presses', (await readFlags()) === '3', String(await readFlags()));

    for (const chord of PRESSED) {
        await pressChord(chord);
        const verdict = await verdictFor(chord.code);
        rec.check(
            `${chord.label} is un-prevented with the protocol on too (#95)`,
            verdict?.prevented === false,
            JSON.stringify(verdict)
        );
    }
    await submit();
    const screen = await captureUntil((text) => PRESSED.some((chord) => text.includes(chord.csi)));
    rec.note(`screen tail after the platform chords: ${JSON.stringify(screen.slice(-260))}`);
    for (const chord of PRESSED) {
        rec.check(
            `${chord.label} put NOTHING on the PTY (no \`${chord.csi}\`)`,
            !screen.includes(chord.csi),
            screen.includes(chord.csi) ? 'the CSI u sequence is on screen' : 'absent'
        );
    }
    rec.note(`window after the kitty lane: ${JSON.stringify(await harness.window())}`);
    await harness.restore();
    await rec.shot(page, 'kitty-lane');

    /*
     * Put the pane back anyway. The workspace is this file's own, so nothing else will type into
     * it, but the `cat -vt` reader and the pushed kitty stack would otherwise sit there for the
     * rest of the run: exactly the two things this scenario turned on, turned off.
     */
    await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
    await sleep(600);
    await d.runInTerminal(page, `printf '\\033[<1u'`, { settleMs: 500 });
    await d.runInTerminal(page, 'stty sane', { settleMs: 500 });
    await d.runInTerminal(page, 'clear', { settleMs: 500 });
}
