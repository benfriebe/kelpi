/**
 * #67: the shell's desktop notifications, end to end, as agent-lifecycle.md §7 specifies them.
 *
 * Everything §7 promises happens in the OS notification centre: the title and body a pane's
 * agent produced (§7.1, §7.2), the two buttons the `kelpi-agent` category carries (§7.5), the
 * identifier that makes a repost REPLACE rather than pile up (§7.5), and what the default click
 * does (§7.5: activate, switch to that workspace, focus that pane). None of it is in the DOM,
 * none of it is screenshottable, and until the harness channel could see a notification at all
 * the whole section was verified by reading `status.ts`. It is visible now because every
 * notification goes through one seam the channel wraps (`packages/shell/src/notify-present.ts`),
 * so `harness.counters()` carries the records and `harness.notificationClick()` fires the very
 * closure macOS would have fired.
 *
 * HOW THE PRECONDITIONS ARE MET, which is most of what this file is doing between assertions.
 * The daemon decides whether to broadcast at all (`packages/core/src/agent/notifications.ts`):
 * §7.1 and §7.2 both need `!isFocused || !isAppActive`, and §7.1 needs no background work. So
 * the pane that plays the agent is parked in a workspace that is NOT the active one, a second
 * workspace is created after it, which takes the foreground, and the window is blurred, which
 * settles `isAppActive` too. That also makes the §7.5 Open assertion worth making: the pane is
 * somewhere the user is not, so "switches to that workspace and focuses that pane" is a visible
 * change of DOM rather than a no-op.
 *
 * ORDER MATTERS, and not in the order the ops were written. Clicking Open focuses the pane and
 * activates the app, which is exactly the state in which §7.1 says a stop must NOT notify, so
 * the run has to leave again (another workspace, another blur) before the stop event, or the
 * last assertion would be checking the daemon's suppression rather than the notification's
 * shape. The step that does that is marked below.
 *
 * Run it at `--window hidden` or with no `--window` (README: the lane and its placements).
 */

/** §7.5's identifier for a pane's notifications: a newer one replaces the older. */
const dedupeKey = (paneID) => `kelpi-${paneID}`;

/** The live (not yet withdrawn) notifications the shell is holding for one pane. */
const liveFor = (counters, paneID) =>
    counters.recentNotifications.filter((record) => record.key === dedupeKey(paneID) && !record.closed);

// What this scenario actually exercises (verify.mjs's scenario rule selects it by these).
export const covers = [
    'packages/shell/src/notify.ts',
    'packages/shell/src/notify-present.ts',
    'packages/shell/src/status.ts',
    'packages/core/src/agent/notifications.ts',
    'packages/daemon/src/handlers/app/events.ts'
];

export default async function ({ page, harness, cli, rec, d, sleep }) {
    // ── a pane to play the agent in, and a workspace to leave it behind in ──────────
    /*
     * The sandbox is shared with every scenario after this one, and this scenario blurs the window
     * on purpose three times. In the lane `harness.blur()` means "make the page believe it is not
     * focused" - it turns CDP focus emulation off (driver.mjs ▸ setPageFocusEmulation), because the
     * lane's window is never the key window - and a run that ended without the matching
     * `harness.focus()` left every later chord landing nowhere. The trailing `focus()` used to be
     * the last line of the happy path, so any throw above it took the rest of the lane with it;
     * it is a `finally` now, beside the two parking workspaces and the agent pane (#205).
     */
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initial = new Set(startingWorkspaces.map((workspace) => workspace.id));
    let agentPane = null;
    try {
        const created = JSON.parse(await cli.ok(['pane', 'create', '--workspace', 'Default', '--json']));
        const paneID = created.pane_id;
        rec.check('created a pane to play the agent in', typeof paneID === 'string' && paneID.length > 0, JSON.stringify(created));
        agentPane = typeof paneID === 'string' ? paneID : null;
        const env = { KELPI_PANE_ID: paneID };
        await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${paneID}"]')`, { ceilingMs: 5_000 });

        const parked = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Parked A', '--json']));
        const leftDefault = await d.settle(async () => !(await d.domPaneIDs(page)).includes(paneID), { ceilingMs: 5_000 });
        rec.check(
            '§7.1/§7.2 precondition: the agent pane is not the focused pane of the active workspace',
            leftDefault,
            `switched to ${String(parked.name ?? 'Parked A')}; panes on screen: ${JSON.stringify(await d.domPaneIDs(page))}`
        );

        await harness.blur();
        const win = await harness.window();
        rec.check('§7.1 precondition: the window is unfocused, so the app is not active', win.focused === false, JSON.stringify(win));

        const before = await harness.counters();
        rec.note(`notifications before: ${String(before.notifications)}`);

        // ── §7.2: an agent-authored notification, with the §7.5 category on it ──────────
        await cli.run(['event', 'session-start'], { env });
        const notified = await cli.run(['event', 'notification', '--title', 'needs you', '--body', 'a question'], { env });
        rec.check('event notification was accepted', notified.code === 0, notified.stderr || notified.stdout);

        const posted = await d.settle(async () => (await harness.counters()).notifications === before.notifications + 1, {
            ceilingMs: 5_000,
            intervalMs: 100
        });
        const afterNotify = await harness.counters();
        rec.check(
            '§7.2: exactly one notification was shown for the agent-authored event',
            posted && afterNotify.notifications === before.notifications + 1,
            `${String(before.notifications)} -> ${String(afterNotify.notifications)}`
        );
        const first = afterNotify.lastNotification;
        // Deliberately a note and not a check: under the channel the shell keeps posting for real,
        // and `KELPI_HARNESS_QUIET_NOTIFICATIONS=1` records without posting. Every assertion in this
        // file has to hold either way, so the gate's one visible effect is reported, not asserted.
        rec.note(`posted to the OS notification centre: ${String(first?.displayed)}`);
        rec.check(
            '§7.2: its title and body are the ones off the wire',
            first?.title === 'needs you' && first?.body === 'a question',
            JSON.stringify(first)
        );
        rec.check(
            '§7.5: it carries the kelpi-agent category, Open then Dismiss, audibly',
            JSON.stringify(first?.actions) === JSON.stringify(['Open', 'Dismiss']) && first?.silent === false,
            JSON.stringify({ actions: first?.actions, silent: first?.silent })
        );
        rec.check(
            `§7.5: it is tagged with the pane and the identifier ${dedupeKey(paneID)}`,
            first?.paneID === paneID && first?.key === dedupeKey(paneID),
            JSON.stringify({ paneID: first?.paneID, key: first?.key })
        );

        // ── §7.5: the identifier is a REPLACE, not a pile ───────────────────────────────
        // The daemon has no dedupe of its own (`notificationDecision` is a suppression matrix, not
        // a history), so an identical repeat does broadcast again, and the shell's replace-on-repost
        // closes the pane's previous toast before showing the new one. What §7.5 promises is that a
        // pane never has two live notifications, and that is what is asserted.
        const repeat = await cli.run(['event', 'notification', '--title', 'needs you', '--body', 'a question'], { env });
        rec.check('a second, identical event was accepted', repeat.code === 0, repeat.stderr || repeat.stdout);
        const replaced = await d.settle(
            async () => {
                const counters = await harness.counters();
                return counters.notifications > afterNotify.notifications && liveFor(counters, paneID).length === 1;
            },
            { ceilingMs: 5_000, intervalMs: 100 }
        );
        const afterRepeat = await harness.counters();
        const live = liveFor(afterRepeat, paneID);
        rec.check(
            '§7.5: a repost under the same identifier leaves exactly ONE live notification for the pane',
            replaced && live.length === 1,
            `live for the pane: ${JSON.stringify(live.map((record) => record.seq))}, all seen: ${JSON.stringify(
                afterRepeat.recentNotifications.map((record) => ({ seq: record.seq, closed: record.closed }))
            )}`
        );
        rec.check(
            '§7.5: the one still live is the newer of the two, and the older was withdrawn',
            live[0]?.seq === afterRepeat.notifications - 1 &&
                afterRepeat.recentNotifications.find((record) => record.seq === first?.seq)?.closed === true,
            JSON.stringify({ live: live[0]?.seq, replaced: first?.seq })
        );

        // ── §7.5: the default click activates, switches workspace, focuses the pane ─────
        const clicked = await harness.notificationClick();
        rec.note(`notification-click: ${JSON.stringify(clicked)}`);
        const switched = await d.settle(async () => (await d.domPaneIDs(page)).includes(paneID), { ceilingMs: 8_000, intervalMs: 100 });
        rec.check(
            '§7.5 Open: clicking the notification switched to the pane workspace',
            switched,
            `panes on screen: ${JSON.stringify(await d.domPaneIDs(page))}`
        );
        const focused = await d.settleDom(
            page,
            `document.querySelector('[data-testid="pane-header-${paneID}"]')?.getAttribute('data-focused') === 'true'`,
            { ceilingMs: 5_000 }
        );
        rec.check('§7.5 Open: and focused that pane', focused, `data-focused on pane-header-${paneID}`);
        // The same fact from the other side of the wire: the client reports its focus to the daemon,
        // so `is_active` moving back to Default is the switch as the daemon sees it, not the DOM.
        const daemonAgrees = await d.settle(
            async () => {
                const rows = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
                return rows.find((row) => row.is_active === true)?.name === 'Default';
            },
            { ceilingMs: 5_000, intervalMs: 150 }
        );
        rec.check(
            '§7.5 Open: `kelpi workspace list` agrees Default is the active workspace again',
            daemonAgrees,
            await cli.ok(['workspace', 'list', '--json'])
        );
        await rec.shot(page, 'after-open');

        // ── leave again, so §7.1's own precondition holds for the stop ──────────────────
        await cli.ok(['workspace', 'create', '--name', 'Parked B', '--json']);
        await d.settle(async () => !(await d.domPaneIDs(page)).includes(paneID), { ceilingMs: 5_000 });
        await harness.blur();

        // ── §7.1: the synthetic "waiting for input" notification ────────────────────────
        const beforeStop = await harness.counters();
        const stopped = await cli.run(['event', 'stop'], { env });
        rec.check('event stop was accepted', stopped.code === 0, stopped.stderr || stopped.stdout);
        const stopPosted = await d.settle(async () => (await harness.counters()).notifications === beforeStop.notifications + 1, {
            ceilingMs: 5_000,
            intervalMs: 100
        });
        const afterStop = await harness.counters();
        const stopNotification = afterStop.lastNotification;
        rec.check(
            '§7.1: a stop with no background work posts exactly one notification',
            stopPosted && afterStop.notifications === beforeStop.notifications + 1,
            `${String(beforeStop.notifications)} -> ${String(afterStop.notifications)}`
        );
        rec.check(
            '§7.1: its body is the synthetic "Agent is waiting for input"',
            stopNotification?.body === 'Agent is waiting for input',
            JSON.stringify(stopNotification)
        );
        rec.check(
            '§7.1: its title is the pane title, falling back to the workspace name',
            stopNotification?.title === (created.title ?? 'Default'),
            `title=${JSON.stringify(stopNotification?.title)} pane title=${JSON.stringify(created.title ?? null)}`
        );
        rec.check(
            '§7.5: the stop notification carries the same category and identifier',
            JSON.stringify(stopNotification?.actions) === JSON.stringify(['Open', 'Dismiss']) &&
                stopNotification?.key === dedupeKey(paneID),
            JSON.stringify({ actions: stopNotification?.actions, key: stopNotification?.key })
        );

        // ── §7.5 Removal: a close is a withdrawal, and the shell drops it ───────────────
        const closed = await harness.notificationClose();
        rec.note(`notification-close: ${JSON.stringify(closed)}`);
        const afterClose = await harness.counters();
        rec.check(
            '§7.5: closing it withdraws it, and the pane is left with none live',
            afterClose.lastNotification?.closed === true && liveFor(afterClose, paneID).length === 0,
            JSON.stringify(afterClose.recentNotifications.map((record) => ({ seq: record.seq, closed: record.closed })))
        );

    } finally {
        // The page believes it is focused again before anything else: a blur left in place is the
        // one leak here that no later scenario can see coming.
        await harness.restore();
        await harness.focus();
        if (agentPane !== null) await cli.run(['pane', 'close', '--target', agentPane]);
        for (const workspace of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            if (!initial.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        }
        if (startingWorkspace !== null) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);
        }
    }
}
