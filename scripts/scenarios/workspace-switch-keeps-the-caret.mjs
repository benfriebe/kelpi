/**
 * Issue #74: switching workspace by clicking its sidebar row leaves the focused pane able to type.
 *
 * The report, verbatim: "when swapping between workspaces the active panel looks 'active' but I
 * can't type in it, I have to select another pane and then re-select the active pane before I can
 * type". The mechanism is one click long. A sidebar row is a `tabindex=-1` div whose mousedown
 * does not `preventDefault` (`chrome/Sidebar.tsx`), so after the click the ROW holds the DOM
 * caret; the switch unmounts the outgoing panes and mounts the incoming ones; every incoming pane
 * arms the caret arbiter with the row as its owner; the pane wearing the ring claims the caret
 * correctly; and then the LAST engine to finish its wasm load grabs the caret, is told it is not
 * entitled to it, and hands it back to the row. Ring drawn, cursor blinking, keyboard nowhere.
 *
 * Cmd+1 to 9 does not reproduce it, and that difference is the diagnosis: there the outgoing
 * textarea unmounts, `document.activeElement` falls to `<body>`, the arbiter has no owner, and
 * the ring branch does the right thing. So the same switch through the keyboard is the control,
 * and it passes on the shipped tree as well.
 *
 * What this presses, in order: the row click (the reported gesture), the keyboard switch (the
 * control), and two `kelpi pane create` calls in quick succession (the agent-launch route from
 * the same report: "opening claude shell / btw sometimes triggers the no typing bug").
 *
 * NOT a pixel check anywhere: every assertion is DOM state, a keystroke arriving at a real PTY,
 * or the CLI, so it is safe in the hidden lane.
 */

/**
 * The source this presses (the scenario rule; ui-audit/README.md). `pane-focus.ts` holds the
 * arbiter whose ownership rule the fix narrows and the hand-off the switch now makes;
 * `TerminalPane.tsx` is the pane that arms the window and answers its engine's grabs;
 * `Sidebar.tsx` is the row that takes the caret in the first place.
 */
export const covers = [
    'packages/client/src/app/pane-focus.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/chrome/Sidebar.tsx'
];

/** `document.activeElement`, short enough to read in a check detail. */
const CARET_HTML = `(() => { const a = document.activeElement; return a === null ? '<null>' : String(a.outerHTML ?? a.nodeName).slice(0, 120); })()`;

/** The pane whose SURFACE holds the caret, or '' when the caret is not in a pane at all. */
const CARET_PANE = `(() => {
    const a = document.activeElement;
    if (a === null) return '';
    const surface = a.closest('[data-pane-surface]');
    if (surface === null) return '';
    const pane = surface.closest('[data-pane-id]');
    return pane === null ? '' : (pane.getAttribute('data-pane-id') ?? '');
})()`;

/** The pane wearing the focus ring, straight off the grid's own attribute. */
const RINGED_PANE = `(() => {
    const el = document.querySelector('[data-pane-id][data-focused="true"]');
    return el === null ? '' : (el.getAttribute('data-pane-id') ?? '');
})()`;

/** Engines that have built their hidden `<textarea>`, i.e. panes that can take a keystroke. */
const ENGINES_UP = `document.querySelectorAll('[data-pane-surface] textarea').length`;

const cursorFocusOf = (paneID) =>
    `(() => {
        const el = document.querySelector('[data-pane-id="${paneID}"][data-terminal-cursor-focus]');
        return el === null ? '<no terminal root>' : (el.getAttribute('data-terminal-cursor-focus') ?? '');
    })()`;

const panesOf = async (cli, workspace) => JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspace, '--json']));

/** Click a sidebar row by workspace id, which is the gesture the report is about. */
const clickWorkspaceRow = async (page, workspaceID) =>
    await page.click(`[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`);

/**
 * Type into whatever holds the caret and see whether it reached the PTY.
 *
 * The daemon's VT is the only witness that cannot be fooled by the DOM: `kelpi pane capture`
 * reads the pane's own screen server-side, so a keystroke that shows up there went through the
 * engine, the socket and the shell. Polled because the round trip is a real one.
 */
async function typingReaches(page, cli, d, paneID, marker) {
    await page.type(`echo ${marker}`);
    await page.key('Enter');
    let capture = '';
    const landed = await d.settle(
        async () => {
            capture = await cli.ok(['pane', 'capture', '--target', paneID]);
            // The echoed line, not the command line the shell drew: `echo x` prints `x` alone.
            return capture.split('\n').some((line) => line.trim() === marker);
        },
        { ceilingMs: 8_000, intervalMs: 300 }
    );
    return { landed, capture: capture.split('\n').filter((line) => line.trim() !== '').slice(-3).join(' | ') };
}

/** The three assertions the report is made of, for whichever pane should have the keyboard. */
async function assertPaneHasTheKeyboard({ page, cli, rec, d }, { label, paneID, marker }) {
    const caretPane = await page.eval(CARET_PANE);
    rec.check(
        `${label}: the caret is inside the focused pane's surface`,
        caretPane === paneID,
        `caret in pane ${String(caretPane) || '<none>'}, want ${paneID}; activeElement ${String(await page.eval(CARET_HTML))}`
    );

    const typed = await typingReaches(page, cli, d, paneID, marker);
    rec.check(`${label}: what is typed reaches the PTY`, typed.landed, `pane capture tail: ${typed.capture}`);

    /*
     * All three, together, on purpose. The ring and the cursor were never the broken half: the
     * defect is that they said yes while the caret was on a sidebar row, which is what makes the
     * report read as "it looks active and I can't type". Asserting them WITH the caret is the
     * only form of this check that a pane with no keyboard cannot pass.
     */
    const ringed = await page.eval(RINGED_PANE);
    const cursor = await page.eval(cursorFocusOf(paneID));
    rec.check(
        `${label}: the ring, the cursor and the caret all name the same pane`,
        ringed === paneID && cursor === 'true' && caretPane === paneID,
        `ring on ${String(ringed) || '<none>'}, data-terminal-cursor-focus=${String(cursor)}, caret in ${String(caretPane) || '<none>'}`
    );
}

export default async function ({ page, cli, rec, d, sleep }) {
    // ── the workspace the report is about: three shells, the focused one not the last engine ──

    // Read live rather than assumed: the battery runs every scenario in ONE sandbox, so what
    // Default holds when this starts is whatever the scenarios before it left there.
    const defaults = await panesOf(cli, 'Default');
    const defaultID = defaults[0]?.workspace_id;
    rec.check('the sandbox has a Default workspace with panes', typeof defaultID === 'string', JSON.stringify(defaults));
    if (typeof defaultID !== 'string') return;

    const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Two', '--json']));
    const twoID = created.workspace_id ?? created.id;
    rec.check('a second workspace was created', typeof twoID === 'string', JSON.stringify(created));
    if (typeof twoID !== 'string') return;
    await d.settleDom(page, `document.querySelector('[data-workspace-id="${twoID}"]')`, { ceilingMs: 10_000 });

    // `workspace create` reveals the new workspace to every client, so the window is already on
    // Two: the two extra panes below land in the workspace this scenario switches to.
    await cli.ok(['pane', 'create', '--workspace', 'Two']);
    await cli.ok(['pane', 'create', '--workspace', 'Two']);
    const twoPanes = await panesOf(cli, 'Two');
    rec.check('workspace Two has three shell panes', twoPanes.length === 3, JSON.stringify(twoPanes.map((p) => p.id)));
    if (twoPanes.length !== 3) return;

    /*
     * The defect needs the focused pane NOT to be the last engine to come up. Startups are
     * serialized FIFO page-wide and DOM order is pane-id order, so the lowest UUID is the first
     * engine and the highest is the last: focusing the lowest is what makes the last engine's
     * hand-off land on a pane that is not the ringed one.
     *
     * The issue asks for `kelpi pane focus`, which does not exist in this CLI (pane has split,
     * create, close, name, send, send-key, move, move-to-workspace, list, capture, sync, id).
     * Clicking the pane's header is the same state change through a real gesture, and it is what
     * a person does anyway.
     */
    const lowest = [...twoPanes].map((p) => p.id).sort()[0];
    await d.settleDom(page, `${ENGINES_UP} === 3`, { ceilingMs: 30_000 });
    await d.clickPaneHeader(page, lowest);
    const focusedNow = (await panesOf(cli, 'Two')).find((p) => p.is_focused)?.id;
    rec.check(
        'the pane with the LOWEST uuid is the focused one (so the last engine is another pane)',
        focusedNow === lowest,
        `focused ${String(focusedNow)}, lowest ${String(lowest)}, highest ${String([...twoPanes].map((p) => p.id).sort().at(-1))}`
    );

    // ── 1. the reported gesture: away, then back by CLICKING the row ────────────────

    await clickWorkspaceRow(page, defaultID);
    await d.settleDom(page, `${ENGINES_UP} === ${String(defaults.length)}`, { ceilingMs: 30_000 });

    await clickWorkspaceRow(page, twoID);
    /*
     * The precondition, and the one step of the diagnosis that was a hypothesis rather than read
     * from the code: Chromium leaves DOM focus on the `tabindex=-1` row after the click, which
     * is the state every incoming pane arms its arbiter with.
     *
     * A NOTE, not a check, and a settle rather than a single read (#109). The rule: a scenario
     * fails on the behaviour it is about, never on the weather around it. The reason: this reads
     * a state the click only passes THROUGH (the caret sits on the row until an engine collects
     * it), so a one-shot read right after the click is racing the very hand-off the checks below
     * measure. Measured 2026-09-08 00:13: this line alone went red in a battery run while all 14
     * behaviour checks passed, because the caret had already moved on to the terminal. Either
     * reading is a legitimate start for what follows, so the run records which one it got and
     * asserts nothing about it; the short ceiling is there to catch the state, not to wait for it.
     */
    const caretIsTheRow = await d.settle(
        async () =>
            (await page.eval(
                `document.activeElement !== null && document.activeElement.getAttribute('data-testid') === 'workspace-row'`
            )) === true,
        { ceilingMs: 1_000, intervalMs: 50 }
    );
    rec.note(
        caretIsTheRow
            ? 'precondition: the clicked sidebar row is holding the caret (the reported starting state)'
            : `precondition: the caret had already left the clicked row (${String(await page.eval(CARET_HTML))}); the ` +
              'checks below are what this scenario is about either way'
    );

    await d.settleDom(page, `${ENGINES_UP} === 3`, { ceilingMs: 30_000 });
    // The engines' own delayed backup grabs land a tick after they open, and the last one is the
    // whole defect: a dwell here is the assertion's precondition, not impatience.
    await sleep(1_200);
    await rec.shot(page, 'after-the-row-click');
    await assertPaneHasTheKeyboard({ page, cli, rec, d }, { label: 'row click', paneID: lowest, marker: 'caret-ok' });

    // ── 2. the control: the same switch through the keyboard, which was never broken ─

    await clickWorkspaceRow(page, defaultID);
    await d.settleDom(page, `${ENGINES_UP} === ${String(defaults.length)}`, { ceilingMs: 30_000 });
    // The ordinal is the workspace's position in the sidebar, so it is read rather than assumed.
    const ordinalOf = async (workspaceID) =>
        await page.eval(
            `Array.from(document.querySelectorAll('[data-testid="workspace-row"]')).findIndex(el => el.getAttribute('data-workspace-id') === '${workspaceID}') + 1`
        );
    const twoOrdinal = await ordinalOf(twoID);
    rec.note(`workspace Two is row ${String(twoOrdinal)} in the sidebar`);
    await page.key(`Digit${String(twoOrdinal)}`, {
        modifiers: d.MOD.meta,
        key: String(twoOrdinal),
        keyCode: 48 + Number(twoOrdinal)
    });
    await d.settleDom(page, `${ENGINES_UP} === 3`, { ceilingMs: 30_000 });
    await sleep(1_200);
    await assertPaneHasTheKeyboard({ page, cli, rec, d }, { label: 'Cmd+1 / Cmd+2', paneID: lowest, marker: 'control-ok' });

    // ── 3. the agent route: several panes spawned at once, newest wins the ring ──────

    /*
     * "opening claude shell / btw sometimes triggers the no typing bug". A single `pane create`
     * self-corrects (the daemon focuses the new pane and a lone new engine claims correctly);
     * two in quick succession are the failing shape, because the second engine can finish after
     * the first and hand the caret to whatever the arbiter thinks owns it.
     */
    const spawned = [];
    spawned.push(JSON.parse(await cli.ok(['pane', 'create', '--workspace', 'Two', '--json'])).pane_id);
    spawned.push(JSON.parse(await cli.ok(['pane', 'create', '--workspace', 'Two', '--json'])).pane_id);
    rec.note(`spawned ${spawned.join(', ')}`);
    await d.settleDom(page, `${ENGINES_UP} === 5`, { ceilingMs: 30_000 });
    await sleep(1_200);
    const newest = (await panesOf(cli, 'Two')).find((p) => p.is_focused)?.id;
    rec.check(
        'the daemon focused the newest spawned pane',
        newest === spawned[1],
        `focused ${String(newest)}, spawned ${spawned.join(', ')}`
    );
    if (typeof newest === 'string') {
        await assertPaneHasTheKeyboard({ page, cli, rec, d }, { label: 'agent launch', paneID: newest, marker: 'agent-ok' });
    }
    await rec.shot(page, 'after-the-agent-launch');
}
