/**
 * Issue #35: a pane focused while a chrome field holds the caret takes the keyboard when the
 * field lets go, with no second click.
 *
 * The report: "Select a pane and it doesn't always take your typing. The focus ring moves, the
 * pane looks focused, the cursor even blinks in it, but the keystrokes go somewhere else.
 * Clicking the pane a second time fixes it." The cause is that the claim was one-shot. An
 * incoming pane asks `shouldGrabFocus`, which correctly refuses while a sidebar filter, a rename
 * or the palette is mid-edit, and then nothing ever asked again: a terminal's focus effect has
 * deps `[focused, visible, status]` and none of them changes when the field is dismissed. The
 * second click worked because the pointer event blurred the field before the pane's own handler
 * ran.
 *
 * The gesture here is the everyday one from the issue's list, driven end to end: the caret is in
 * the sidebar filter, focus moves to a pane WITHOUT clicking its body (from the CLI, which is
 * also how an agent does it), and the filter is then dismissed with Escape. Nothing clicks the
 * pane at any point, which is the whole assertion.
 *
 * `kelpi pane focus` does not exist in this CLI, so the focus move is `kelpi pane close` on the
 * focused pane: the daemon moves focus to the surviving pane, which is already mounted and live,
 * so the pane that has to claim the caret is an existing one rather than a fresh engine (a fresh
 * engine grabs the caret for itself on `open()` and never reaches this rule).
 *
 * NOT a pixel check anywhere: DOM state, the CLI, and a keystroke arriving at a real PTY.
 */

/**
 * The source this presses (the scenario rule; ui-audit/README.md). `pane-focus.ts` holds
 * `armCaretClaim`, the armed-until-claimed rule; `TerminalPane.tsx` is the pane whose one-shot
 * claim it replaces; `Sidebar.tsx` owns the filter that legitimately refuses it and the Escape
 * that lets it go.
 */
export const covers = [
    'packages/client/src/app/pane-focus.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/chrome/Sidebar.tsx'
];

const CARET_HTML = `(() => { const a = document.activeElement; return a === null ? '<null>' : String(a.outerHTML ?? a.nodeName).slice(0, 120); })()`;

const CARET_PANE = `(() => {
    const a = document.activeElement;
    if (a === null) return '';
    const surface = a.closest('[data-pane-surface]');
    if (surface === null) return '';
    const pane = surface.closest('[data-pane-id]');
    return pane === null ? '' : (pane.getAttribute('data-pane-id') ?? '');
})()`;

const RINGED_PANE = `(() => {
    const el = document.querySelector('[data-pane-id][data-focused="true"]');
    return el === null ? '' : (el.getAttribute('data-pane-id') ?? '');
})()`;

const ENGINES_UP = `document.querySelectorAll('[data-pane-surface] textarea').length`;

const CARET_IN_FILTER = `document.activeElement === document.querySelector('[data-testid="sidebar-filter"]')`;

const panesOf = async (cli, workspace) => JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspace, '--json']));

export default async function ({ page, cli, rec, d, sleep }) {
    // ── two live panes, so the focus move lands on one that is already up ───────────

    // Read live, and put the window on Default explicitly: the battery runs every scenario in
    // ONE sandbox, so neither the pane count nor the workspace on screen is this scenario's to
    // assume.
    const before = await panesOf(cli, 'Default');
    const workspaceID = before[0]?.workspace_id;
    rec.check('the sandbox has a Default workspace with panes', typeof workspaceID === 'string', JSON.stringify(before));
    if (typeof workspaceID !== 'string') return;
    await page.click(`[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`);
    await d.settleDom(page, `${ENGINES_UP} === ${String(before.length)}`, { ceilingMs: 30_000 });

    const spawned = JSON.parse(await cli.ok(['pane', 'create', '--workspace', 'Default', '--json'])).pane_id;
    await d.settleDom(page, `${ENGINES_UP} === ${String(before.length + 1)}`, { ceilingMs: 30_000 });
    // The new pane's own engine grab has to be over before the caret is put in the filter,
    // otherwise the arbiter's hand-off is what the assertions below would be reading.
    await sleep(1_200);

    // ── the caret goes into the sidebar filter, and must stay there ─────────────────

    await page.click('[data-testid="sidebar-filter"]');
    await page.type('Def');
    rec.check(
        'the sidebar filter has the caret',
        (await page.eval(CARET_IN_FILTER)) === true,
        String(await page.eval(CARET_HTML))
    );

    // ── focus moves to the surviving pane, from outside the window ──────────────────

    await cli.ok(['pane', 'close', '--target', spawned, '--workspace', 'Default']);
    await d.settleDom(page, `${ENGINES_UP} === ${String(before.length)}`, { ceilingMs: 30_000 });
    await sleep(600);

    // Whichever pane the daemon moved focus to: the client's ring has to agree with it, and it
    // is the pane the caret is then owed.
    const survivor = (await panesOf(cli, 'Default')).find((pane) => pane.is_focused)?.id;
    rec.check('the daemon moved focus to a surviving pane', typeof survivor === 'string', String(survivor));
    if (typeof survivor !== 'string') return;
    const ringed = await page.eval(RINGED_PANE);
    rec.check('the ring moved to the surviving pane', ringed === survivor, `ring on ${String(ringed)}, want ${survivor}`);
    /*
     * The half that was always right, and must stay right: a caret in use is not taken. This is
     * the guard `shouldGrabFocus` exists for, and a fix that made the pane simply grab the caret
     * would pass every check below while cancelling the edit the user is in the middle of.
     */
    rec.check(
        'the filter KEEPS the caret while the pane takes the ring',
        (await page.eval(CARET_IN_FILTER)) === true,
        String(await page.eval(CARET_HTML))
    );
    await rec.shot(page, 'ring-moved-caret-in-the-filter');

    // ── the field lets go, and the pane collects the caret with no click ────────────

    await page.key('Escape');
    await sleep(600);
    const caretPane = await page.eval(CARET_PANE);
    rec.check(
        'dismissing the filter hands the caret to the pane wearing the ring',
        caretPane === survivor,
        `caret in pane ${String(caretPane) || '<none>'}, want ${survivor}; activeElement ${String(await page.eval(CARET_HTML))}`
    );

    // Nothing has clicked a pane at any point in this scenario: this is the keystroke the report
    // says is lost, arriving at the real PTY.
    await page.type('echo refocus-ok');
    await page.key('Enter');
    let capture = '';
    const landed = await d.settle(
        async () => {
            capture = await cli.ok(['pane', 'capture', '--target', survivor]);
            return capture.split('\n').some((line) => line.trim() === 'refocus-ok');
        },
        { ceilingMs: 8_000, intervalMs: 300 }
    );
    rec.check(
        'what is typed after the field is dismissed reaches the PTY, with no second click',
        landed,
        `pane capture tail: ${capture.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' | ')}`
    );
    await rec.shot(page, 'after-escape');
}
