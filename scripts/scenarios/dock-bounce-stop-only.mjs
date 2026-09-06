/**
 * #55: the dock bounces on the daemon's attention-request (an agent STOP), not on every
 * transition into waitingForInput.
 *
 * agent-lifecycle.md §7.2, §7.3, §14 invariant 6. The bounce is a native call nothing in the
 * page can observe, so the count comes from the shell's harness channel. The bounce only fires
 * while the window is unfocused (status.ts), so the scenario blurs it first.
 *
 * PRECONDITION, learned from running this under the functional lane's placements (#65). Blurring
 * is not one condition but two, and the scenario used to check only the easy one:
 *
 *   1. the SHELL must see an unfocused window: `status.ts` ▸ `attention-request` is gated on
 *      `!host.isWindowFocused()`, and `harness.blur()` settles that;
 *   2. the DAEMON must believe the app is inactive before it broadcasts `attention-request` at
 *      all (agent-lifecycle §7.1). Its `isAppActive` is `presence().anyVisible`, which is the
 *      clients' reported `document.visibilityState` and nothing else, so the bounce needs the
 *      renderer to go hidden, which happens when AppKit stops counting the window as visible.
 *
 * `BrowserWindow.blur()` is `orderBack:` on macOS, so (2) follows from (1) only when something
 * is then in front of the window: true at the shipped placement (the frame sits where other
 * windows are) and true at `--window hidden` (a zero-opacity frame is not visible to AppKit's
 * occlusion at all), false at `--window onscreen` and `--window offscreen`, where nothing ever
 * covers the frame. Without the check below that reads as "a stop does not bounce the dock",
 * which is a diagnosis of the product for a property of the placement.
 */

/**
 * The source this presses (the scenario rule; ui-audit/README.md ▸ The rule). `status.ts` holds the
 * one bounce path, the `attention-request` case and its window-focus gate; `agents.ts` owns the
 * waiting set whose entry deliberately does NOT bounce, which is the negative half of this check;
 * `handlers/app/events.ts` is the daemon end that decides an `attention-request` is broadcast at
 * all (agent-lifecycle §7.1), and it is the half no shell-side unit test can reach.
 */
export const covers = [
    'packages/shell/src/status.ts',
    'packages/shell/src/agents.ts',
    'packages/daemon/src/handlers/app/events.ts'
];

export default async function ({ page, harness, cli, rec, d, sleep }) {
    const created = JSON.parse(await cli.ok(['pane', 'create', '--workspace', 'Default', '--json']));
    const paneID = created.pane_id;
    rec.check('created a pane to play the agent in', typeof paneID === 'string' && paneID.length > 0, JSON.stringify(created));
    const env = { KELPI_PANE_ID: paneID };
    await d.settleDom(page, `document.querySelector('[data-testid="pane-header-${paneID}"]')`, { ceilingMs: 5_000 });

    await harness.blur();
    const win = await harness.window();
    rec.check('the window is unfocused, so the SHELL would allow a bounce', win.focused === false, JSON.stringify(win));

    // The other half, and the one that actually decides whether a bounce is ever requested.
    const wentHidden = await d.settle(async () => (await page.eval(`document.visibilityState === 'hidden'`)) === true, {
        ceilingMs: 4_000,
        intervalMs: 100
    });
    rec.check(
        'the page reports itself hidden, so the DAEMON will call the app inactive',
        wentHidden,
        wentHidden
            ? undefined
            : 'the blurred window is still visible to AppKit, so document.visibilityState stayed "visible" and the ' +
              'daemon suppresses attention-request. Expected at --window onscreen and --window offscreen, where ' +
              'nothing ever covers the frame; run this scenario at --window hidden or with no --window at all.'
    );

    const start = await harness.counters();
    rec.note(`counters before: ${JSON.stringify(start)}`);

    // A notification moves the pane to waitingForInput (§7.1) but is NOT the stop path.
    const session = await cli.run(['event', 'session-start'], { env });
    rec.note(`session-start: exit ${String(session.code)} ${session.stderr.trim()}`);
    const notified = await cli.run(['event', 'notification', '--title', 'needs you', '--body', 'a question'], { env });
    rec.check('event notification was accepted', notified.code === 0, notified.stderr || notified.stdout);
    await sleep(1_200);
    const afterNotification = await harness.counters();
    rec.check('a notification does NOT bounce the dock', afterNotification.dockBounces === start.dockBounces, `${String(start.dockBounces)} -> ${String(afterNotification.dockBounces)}`);

    // The stop path: the daemon broadcasts attention-request and the shell bounces once.
    const stopped = await cli.run(['event', 'stop'], { env });
    rec.check('event stop was accepted', stopped.code === 0, stopped.stderr || stopped.stdout);
    const bounced = await d.settle(async () => (await harness.counters()).dockBounces === afterNotification.dockBounces + 1, { ceilingMs: 5_000, intervalMs: 100 });
    const afterStop = await harness.counters();
    rec.check('a stop bounces the dock exactly once', bounced && afterStop.dockBounces === afterNotification.dockBounces + 1, `${String(afterNotification.dockBounces)} -> ${String(afterStop.dockBounces)}`);
    rec.note(`counters after: ${JSON.stringify(afterStop)}`);

    await harness.focus();
    await rec.shot(page, 'after-stop');
}
