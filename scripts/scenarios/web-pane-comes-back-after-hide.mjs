/**
 * #75: hide the window, come back, and a web pane's page is still there.
 *
 * The user's words: "switching desktops and coming back to kelpi, lots of panes are just blank,
 * no retry / reload option either". The shell parks every web pane's `WebContentsView` in its
 * off-screen holder while the window is away and, before this fix, DELETED the placement, so
 * nothing ever put the page back: the client's geometry reporter dedupes an identical re-render,
 * so it had nothing to say, and macOS emits no dependable event on the way back in.
 *
 * The instrument is the shell's own line, which is the only external evidence there is: a native
 * view is composited by the WINDOW, so a screenshot of the page shows the hole as empty whether
 * the page is in it or not, and `page.screenshot` under `--window hidden` is blank regardless.
 *
 *     web pane <id> view owner=main|holder bounds=x,y w×h (reason)
 *
 * The deeper harness (`scripts/ui-audit/web-view-restore.mjs`) measures the same chain in more
 * places, times each leg and runs the minimise variant; this is the one-behaviour scenario the
 * verify battery selects when the shell's placement books change.
 */

/**
 * The source this presses (the scenario rule; ui-audit/README.md ▸ The rule). `embed.ts` holds
 * the park-with-memory the fix is; `webhost/index.ts` holds the reconciler that notices the
 * window came back, which no unit test can reach because it reads a real `BrowserWindow`;
 * `main.ts` wires the window events to both.
 */
export const covers = [
    'packages/shell/src/webhost/embed.ts',
    'packages/shell/src/webhost/index.ts',
    'packages/shell/src/main.ts'
];

const PLACEMENT = /web pane ([0-9A-Fa-f-]{36}) view owner=(main|holder) bounds=(\S+ \S+|-) \(([^)]*)\)/;

/** The last placement line for a pane, as `{ owner, bounds, reason }`, or null. */
function ownerOf(shell, paneID) {
    let latest = null;
    for (const line of shell.lines) {
        const match = PLACEMENT.exec(line);
        if (match === null || match[1] !== paneID) continue;
        latest = { owner: match[2], bounds: match[3], reason: match[4] };
    }
    return latest;
}

export default async function ({ page, harness, cli, shell, rec, d, sleep }) {
    if (shell === null) {
        rec.check('this scenario needs the shell process this runner launched', false, 'run it without --attach');
        return;
    }

    /*
     * What this scenario is about to add to a sandbox it shares with every scenario after it: one
     * web pane, and one workspace to prove a park the CLIENT asked for is not the shell's to undo.
     * Both are taken back in the `finally` below. A leftover web pane is not inert: it draws a URL
     * field that takes the caret, and its pane is NOT an engine, so
     * `workspace-switch-keeps-the-caret` used to wait 112 s for an engine count that could never
     * be reached and then find the ring on this pane (#205).
     */
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initial = new Set(startingWorkspaces.map((workspace) => workspace.id));
    let openedPane = null;
    try {
        const opened = await cli.ok(['web', 'open', 'about:blank']);
        const paneID = (/open ok:\s*([0-9a-f-]{36})/i.exec(opened) ?? [])[1];
        rec.check('a web pane opened', typeof paneID === 'string', opened.trim());
        openedPane = paneID ?? null;
        if (paneID === undefined) return;
        await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${paneID}"]')`, { ceilingMs: 10_000 });

        const placed = await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 20_000, intervalMs: 50 });
        rec.check('its view is in the shell window to begin with', placed, JSON.stringify(ownerOf(shell, paneID)));
        if (!placed) return;
        // Against a STILL layout, which is the precondition of the bug: a layout that moves repairs
        // itself by accident, and then the scenario would pass on a broken build.
        await sleep(1500);
        const before = ownerOf(shell, paneID);

        const hidden = await harness.hide();
        rec.note(`hide(): ${JSON.stringify(hidden)}`);
        const parked = await d.settle(() => ownerOf(shell, paneID)?.owner === 'holder', {
            ceilingMs: 10_000,
            intervalMs: 50
        });
        // The reason is recorded rather than asserted: measured on this Electron, ⌘H (`app.hide()`)
        // usually emits no `hide` event at all, so the park is normally the host's own reconciler
        // (`window-not-visible`) rather than the event (`window-hidden`). Both are correct parks.
        rec.check(
            'hiding the window takes the page off screen',
            parked,
            JSON.stringify(ownerOf(shell, paneID))
        );

        await sleep(2000);
        const restored = await harness.restore();
        rec.note(`restore(): ${JSON.stringify(restored)}`);
        const back = await d.settle(() => ownerOf(shell, paneID)?.owner === 'main', { ceilingMs: 15_000, intervalMs: 50 });
        rec.check(
            'coming back puts the page on screen again, with no user action (#75)',
            back,
            back ? JSON.stringify(ownerOf(shell, paneID)) : 'ISSUE #75: the page is still in the off-screen holder'
        );
        rec.check(
            'it comes back in the box it left',
            back && ownerOf(shell, paneID)?.bounds === before?.bounds,
            `${String(before?.bounds)} -> ${String(ownerOf(shell, paneID)?.bounds)}`
        );

        // The guard-rail, and the one way this fix could be worse than the bug: a park the CLIENT
        // asked for is not the shell's to undo. This passes on a broken build too, which is what
        // stops the scenario being a restatement of the fix.
        await cli.ok(['workspace', 'create', '--name', 'elsewhere']);
        const parkedOnPurpose = await d.settle(() => ownerOf(shell, paneID)?.owner === 'holder', {
            ceilingMs: 15_000,
            intervalMs: 50
        });
        rec.check('switching workspace still parks the page', parkedOnPurpose, JSON.stringify(ownerOf(shell, paneID)));
        await harness.hide();
        await sleep(1000);
        await harness.restore();
        await sleep(3000);
        rec.check(
            'a page parked on purpose is NOT put back by a hide and a return',
            ownerOf(shell, paneID)?.owner === 'holder',
            JSON.stringify(ownerOf(shell, paneID))
        );

        // The whole trail, in the results file: a failure here is a statement about a sequence, and
        // the sequence is unreadable from a single "still in the holder".
        for (const line of shell.lines.filter((line) => /web pane .* view owner=|web host (park|restor|ignor|asking)/.test(line))) {
            rec.note(line.trim());
        }
    } finally {
        if (openedPane !== null) await cli.run(['pane', 'close', '--target', openedPane]);
        for (const workspace of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            if (!initial.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        }
        // The window follows `workspace create`, so it is looking at the workspace just deleted:
        // put it back on the one this scenario found it on.
        if (startingWorkspace !== null) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);
        }
    }
}
