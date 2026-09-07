/**
 * #96: View ▸ Recover Interface puts the web panes back, instead of blanking them.
 *
 * The user's words: "pressing the recover interface button caused the web pane to go blank, and
 * was only recovered by going in and out of the workspace." #79 added the row for a window that
 * has gone unusable and parked every native view with `releaseViews`, the FORGETTING release, so
 * the placement went with the view; the client still believed the pane was placed and its
 * geometry reporter drops an identical re-render, so nothing on either side ever put the page
 * back. The fix parks with the placement kept and held and asks every client to re-state, so a
 * pane a client still draws comes back on its own and one nobody draws stays parked.
 *
 * The instrument is the shell's own line, which is the only external evidence there is: a native
 * view is composited by the WINDOW, so a screenshot of the page shows the hole as empty whether
 * the page is in it or not, and `page.screenshot` under `--window hidden` is blank regardless.
 *
 *     web pane <id> view owner=main|holder bounds=x,y w×h (reason)
 *
 * It reads the TRAIL rather than the current owner: a working fix takes the view out and puts it
 * back in tens of milliseconds, so a poll can miss the holder state entirely and report "it never
 * parked" about a build that parked and recovered perfectly.
 *
 * `scripts/ui-audit/web-view-restore.mjs` measures the same chain in more places, times the
 * round trip and adds the leaked-view case (a placement the client has forgotten, which stays
 * parked); this is the one-behaviour scenario the verify battery selects.
 */

/**
 * The source this presses (the scenario rule; ui-audit/README.md ▸ The rule). `main.ts` wires the
 * menu row's main-process half and the watchdog; `unresponsive.ts` is the watchdog's rule, whose
 * second strike takes the same path; `webhost/index.ts` holds the recovery park, the re-statement
 * ask and the reconciler rule that lets a held park stand, none of which a unit test can reach
 * because they read a real `BrowserWindow` and a real socket.
 */
export const covers = [
    'packages/shell/src/main.ts',
    'packages/shell/src/unresponsive.ts',
    'packages/shell/src/webhost/index.ts'
];

const PLACEMENT = /web pane ([0-9A-Fa-f-]{36}) view owner=(main|holder) bounds=(\S+ \S+|-) \(([^)]*)\)/;

/** Every placement line for a pane, in order, as `{ owner, bounds, reason }`. */
function trail(shell, paneID, from = 0) {
    const entries = [];
    for (const line of shell.lines.slice(from)) {
        const match = PLACEMENT.exec(line);
        if (match === null || match[1] !== paneID) continue;
        entries.push({ owner: match[2], bounds: match[3], reason: match[4] });
    }
    return entries;
}

export default async function ({ page, harness, cli, shell, rec, d, sleep }) {
    if (shell === null) {
        rec.check('this scenario needs the shell process this runner launched', false, 'run it without --attach');
        return;
    }

    const opened = await cli.ok(['web', 'open', 'about:blank']);
    const paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1];
    rec.check('a web pane opened', typeof paneID === 'string', opened.trim());
    if (paneID === undefined) return;
    await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${paneID}"]')`, { ceilingMs: 10_000 });

    const placed = await d.settle(() => trail(shell, paneID).at(-1)?.owner === 'main', {
        ceilingMs: 20_000,
        intervalMs: 50
    });
    rec.check('its view is in the shell window to begin with', placed, JSON.stringify(trail(shell, paneID).at(-1)));
    if (!placed) return;
    // Against a STILL layout, which is the precondition of the bug: a layout that moves repairs
    // itself by accident, and then the scenario would pass on a broken build.
    await sleep(1500);
    const before = trail(shell, paneID).at(-1);
    const mark = shell.lines.length;

    const clicked = await harness.menuClick({ path: ['View', 'Recover Interface'] });
    rec.note(`menuClick(View > Recover Interface): ${JSON.stringify(clicked)}`);

    const since = () => trail(shell, paneID, mark);
    const parkedAt = () => since().findIndex((entry) => entry.owner === 'holder' && entry.reason === 'recover-interface');
    const back = () => {
        const at = parkedAt();
        return at < 0 ? undefined : since().slice(at + 1).find((entry) => entry.owner === 'main');
    };
    await d.settle(() => back() !== undefined, { ceilingMs: 10_000, intervalMs: 25 });

    rec.check('the chord takes the page off screen (owner=holder, recover-interface)', parkedAt() >= 0, JSON.stringify(since()));
    rec.check(
        'and puts it straight back, with no user action (#96)',
        back() !== undefined,
        back() === undefined ? 'ISSUE #96: the page is still in the off-screen holder' : JSON.stringify(back())
    );
    rec.check('it comes back in the box it left', back()?.bounds === before?.bounds, `${String(before?.bounds)} -> ${String(back()?.bounds)}`);
    // `attached`, not `moved`: the view was really out of the window, and what put it back was
    // the client re-stating its geometry rather than the shell replaying its own books.
    rec.check('as an attach, i.e. re-derived from the client', back()?.reason === 'attached', `reason=${String(back()?.reason)}`);

    /*
     * The guard rail, and the one way this fix could be worse than the bug: a pane the CLIENT
     * parked is not the shell's to put back, and the chord must not resurrect it. This passes on
     * a broken build too, which is what stops the scenario being a restatement of the fix.
     */
    await cli.ok(['workspace', 'create', '--name', 'elsewhere']);
    const parkedOnPurpose = await d.settle(() => trail(shell, paneID).at(-1)?.owner === 'holder', {
        ceilingMs: 15_000,
        intervalMs: 50
    });
    rec.check('switching workspace still parks the page', parkedOnPurpose, JSON.stringify(trail(shell, paneID).at(-1)));
    const guardMark = shell.lines.length;
    await harness.menuClick({ path: ['View', 'Recover Interface'] });
    await sleep(4000);
    rec.check(
        'a page parked on purpose is NOT put back by the chord',
        trail(shell, paneID, guardMark).every((entry) => entry.owner !== 'main'),
        JSON.stringify(trail(shell, paneID, guardMark))
    );

    // The whole trail, in the results file: a failure here is a statement about a sequence, and
    // the sequence is unreadable from a single "still in the holder".
    for (const line of shell.lines.filter((line) =>
        /web pane .* view owner=|web host (park|restor|ignor|asking|recovery|dropped|:)|menu: Recover Interface/.test(line)
    )) {
        rec.note(line.trim());
    }
}
