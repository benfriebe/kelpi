/**
 * #269: a muted workspace's agents keep their status but raise no attention signal, and an
 * unmuted workspace beside it (the conductor) still notifies and bounces.
 *
 * agent-lifecycle.md §7.6. The rule is decided once, in the daemon (`notificationDecision` returns
 * `observersOnly`, the event handler marks the broadcast `muted: true`, the sync hub hands it to
 * plugins and drops it before any window session), so the only honest reading of "no desktop
 * notification, no dock bounce" is the shell's own: `harness.counters()` sees every notification
 * the shell SHOWED and every bounce it asked for. The renderer's toast stack is checked as well. Pane status is read back through the CLI, the row icon and the
 * footer's chips and the row menu's mute checkbox through the DOM (the menu stays open across a
 * toggle each way, pictured in both chrome themes), and persistence through a real daemon restart.
 *
 * PRECONDITIONS, the same two `dock-bounce-stop-only` spells out: the shell must see an unfocused
 * window (`harness.blur()`) and the daemon must believe the app inactive, which only an
 * `app.hide()` delivers (`harness.hide()`); hence the `offscreen` floor below. On top of those,
 * neither agent pane may be the focused pane of the active workspace when the window comes back,
 * or §5.8's focus acknowledgment would clear its waiting status under the footer check. So the
 * run hands the active workspace back to the one it started on before it hides the app.
 */

import fs from 'node:fs';

/** The source this presses (the scenario rule; ui-audit/README.md ▸ The rule). */
export const covers = [
    'packages/core/src/agent/notifications.ts',
    'packages/daemon/src/handlers/app/events.ts',
    'packages/client/src/chrome/Sidebar.tsx',
    'packages/client/src/chrome/StatusFooter.tsx',
    'packages/shell/src/agents.ts'
];

/** The app has to go inactive for a stop to bounce at all; see `dock-bounce-stop-only`. */
export const windowPlacement = 'offscreen';

/** agent-lifecycle §7.5's identifier for a pane's notifications. */
const dedupeKey = (paneID) => `kelpi-${paneID}`;

export default async function ({ page, harness, cli, sandbox, rec, d, sleep, daemon }) {
    const listed = async () => JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const iconOn = (workspaceID) => `document.querySelector('[data-testid="workspace-muted-${workspaceID}"]') !== null`;
    const chipCount = (bucket) =>
        `Number(document.querySelector('[data-testid="count-${bucket}"]')?.getAttribute('data-count') ?? '0')`;
    const firstPane = async (workspaceID) =>
        JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']))[0]?.id ?? null;
    const statusOf = async (workspaceID, paneID) =>
        JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json'])).find((pane) => pane.id === paneID)?.status;

    /** The open context menu's top level (separators as `-`) and the mute row's checkbox state. */
    const readMenu = async () =>
        JSON.parse(
            String(
                await page.eval(`(() => {
                    const menu = document.querySelector('${d.PAGE.contextMenu}');
                    if (menu === null) return JSON.stringify({ order: [] });
                    const order = Array.from(menu.children).map((wrapper) => {
                        const row = wrapper.firstElementChild;
                        return row?.getAttribute('role') === 'separator' ? '-' : (row?.getAttribute('data-menu-item') ?? '?');
                    });
                    const mute = menu.querySelector('[data-menu-item="mute"]');
                    const box = mute?.querySelector('[data-testid="menu-checkbox"]') ?? null;
                    return JSON.stringify({
                        order,
                        role: mute?.getAttribute('role') ?? null,
                        ariaChecked: mute?.getAttribute('aria-checked') ?? null,
                        box: box?.getAttribute('data-state') ?? null,
                        boxLast: box !== null && mute.lastElementChild === box
                    });
                })()`)
            )
        );
    /**
     * The open menu in both chrome themes. `chrome-appearance` is a kelpi config key the daemon
     * watches, so writing it repaints the chrome live with the menu still open (the stamp to wait
     * for is `data-kelpi-theme` on the root); the original config goes back in the `finally`.
     */
    const originalConfig = sandbox?.configPath === undefined ? null : fs.readFileSync(sandbox.configPath, 'utf8');
    const startingTheme = String(await page.eval(`document.documentElement.dataset.kelpiTheme ?? ''`));
    const themedShots = async (label) => {
        if (originalConfig === null) {
            rec.note('LIMIT: no sandbox config (--attach), so the menu is pictured in the current theme only');
            await rec.shot(page, label);
            return;
        }
        for (const bucket of ['light', 'dark']) {
            fs.writeFileSync(sandbox.configPath, `${originalConfig}\nchrome-appearance = ${bucket}\n`);
            const applied = await d.settle(
                async () => (await page.eval(`document.documentElement.dataset.kelpiTheme ?? ''`)) === bucket,
                { ceilingMs: 10_000, intervalMs: 100 }
            );
            if (!applied) rec.note(`the chrome did not switch to ${bucket} within 10 s; the ${bucket} shot is the current theme`);
            await sleep(200);
            await rec.shot(page, `${label}-${bucket}`);
            // …and again with the row highlighted, where the box has to read over the wash.
            const box = JSON.parse(
                String(
                    await page.eval(`(() => {
                        const r = document.querySelector('${d.PAGE.contextMenu} [data-menu-item="mute"]')?.getBoundingClientRect();
                        return JSON.stringify(r === undefined ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 });
                    })()`)
                )
            );
            if (box === null) continue;
            await page.mouse('mouseMoved', box.x, box.y, { button: 'none', buttons: 0 });
            await sleep(200);
            await rec.shot(page, `${label}-${bucket}-hover`);
            // Off the menu again (a pointer elsewhere does not close it), so the next shot is plain.
            await page.mouse('mouseMoved', 900, 600, { button: 'none', buttons: 0 });
            await sleep(150);
        }
    };

    const starting = await listed();
    const home = starting.find((workspace) => workspace.is_active === true)?.id ?? starting[0]?.id ?? null;
    const created = [];
    try {
        // ── 1 · a muted child and an unmuted conductor, as the CLI makes them ────────────
        const child = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Mute Child', '--muted', '--json']));
        if (typeof child.workspace_id === 'string') created.push(child.workspace_id);
        const conductor = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Conductor', '--json']));
        if (typeof conductor.workspace_id === 'string') created.push(conductor.workspace_id);
        const childID = child.workspace_id;
        const conductorID = conductor.workspace_id;

        const flags = await listed();
        const flag = (workspaceID) => flags.find((workspace) => workspace.id === workspaceID)?.muted;
        rec.check(
            'workspace list --json reports the child muted and the conductor unmuted',
            flag(childID) === true && flag(conductorID) === false,
            JSON.stringify(flags.map((workspace) => [workspace.name, workspace.muted]))
        );

        // ── 2 · the row icon, on the muted row only ──────────────────────────────────────
        const childIcon = await d.settleDom(page, iconOn(childID), { ceilingMs: 5_000 });
        const conductorIcon = (await page.eval(iconOn(conductorID))) === true;
        const tooltip = await page.eval(
            `document.querySelector('[data-testid="workspace-muted-${childID}"]')?.getAttribute('title') ?? ''`
        );
        rec.check(
            'the bell-slash sits on the muted row, with its tooltip, and not on the conductor',
            childIcon && !conductorIcon && tooltip === 'Notifications muted',
            JSON.stringify({ childIcon, conductorIcon, tooltip })
        );
        await rec.shot(page, 'muted-row-icon');

        const childPane = await firstPane(childID);
        const conductorPane = await firstPane(conductorID);
        rec.check(
            'each new workspace has a pane to play an agent in',
            typeof childPane === 'string' && typeof conductorPane === 'string',
            JSON.stringify({ childPane, conductorPane })
        );

        // Neither agent pane may be the focused pane of the active workspace (see the header).
        if (home !== null) await page.click(`[data-testid="workspace-row"][data-workspace-id="${home}"]`);
        const leftBoth = await d.settle(
            async () => {
                const onScreen = await d.domPaneIDs(page);
                return !onScreen.includes(childPane) && !onScreen.includes(conductorPane);
            },
            { ceilingMs: 5_000, intervalMs: 100 }
        );
        rec.check(
            'precondition: neither agent pane is on screen, so no focus acknowledgment clears it later',
            leftBoth,
            `panes on screen: ${JSON.stringify(await d.domPaneIDs(page))}`
        );
        const baseline = {
            waiting: Number(await page.eval(chipCount('waiting'))),
            muted: Number(await page.eval(chipCount('muted')))
        };
        rec.note(`footer before: ${JSON.stringify(baseline)}`);

        // ── 3 · the app goes inactive, and both workspaces' agents stop ──────────────────
        await harness.blur();
        const win = await harness.window();
        rec.check('the window is unfocused, so the SHELL would allow a bounce', win.focused === false, JSON.stringify(win));
        const hidden = await harness.hide();
        const wentHidden = await d.settle(async () => (await page.eval(`document.visibilityState === 'hidden'`)) === true, {
            ceilingMs: 8_000,
            intervalMs: 100
        });
        rec.check(
            'the page reports itself hidden, so the DAEMON calls the app inactive',
            wentHidden,
            JSON.stringify(hidden)
        );

        const before = await harness.counters();
        rec.note(`counters before: notifications ${String(before.notifications)}, bounces ${String(before.dockBounces)}`);

        // The muted child first, then a dwell long enough for a banner or a bounce to have landed.
        const childEnv = { KELPI_PANE_ID: childPane };
        await cli.run(['event', 'start'], { env: childEnv });
        const childStop = await cli.run(['event', 'stop'], { env: childEnv });
        rec.check('the child\'s stop was accepted', childStop.code === 0, childStop.stderr || childStop.stdout);
        await sleep(2_000);
        const afterChild = await harness.counters();
        rec.check(
            '§7.6: the muted child\'s stop posts no notification and bounces nothing',
            afterChild.notifications === before.notifications && afterChild.dockBounces === before.dockBounces,
            `notifications ${String(before.notifications)} -> ${String(afterChild.notifications)}, bounces ${String(before.dockBounces)} -> ${String(afterChild.dockBounces)}`
        );
        const childStatus = await statusOf(childID, childPane);
        rec.check('§7.6: the child\'s pane still reports waitingForInput', childStatus === 'waitingForInput', String(childStatus));

        // ── 4 · the conductor, unmuted, still reaches the owner ──────────────────────────
        const conductorEnv = { KELPI_PANE_ID: conductorPane };
        await cli.run(['event', 'start'], { env: conductorEnv });
        const conductorStop = await cli.run(['event', 'stop'], { env: conductorEnv });
        rec.check('the conductor\'s stop was accepted', conductorStop.code === 0, conductorStop.stderr || conductorStop.stdout);
        const reached = await d.settle(
            async () => {
                const counters = await harness.counters();
                return counters.notifications === before.notifications + 1 && counters.dockBounces === before.dockBounces + 1;
            },
            { ceilingMs: 5_000, intervalMs: 100 }
        );
        // A second dwell, so "exactly one" is not just "the first one arrived".
        await sleep(800);
        const afterConductor = await harness.counters();
        rec.check(
            'the conductor\'s stop posts exactly one notification, keyed to its pane, and bounces once',
            reached &&
                afterConductor.notifications === before.notifications + 1 &&
                afterConductor.dockBounces === before.dockBounces + 1 &&
                afterConductor.lastNotification?.key === dedupeKey(conductorPane),
            JSON.stringify({
                notifications: afterConductor.notifications - before.notifications,
                bounces: afterConductor.dockBounces - before.dockBounces,
                key: afterConductor.lastNotification?.key
            })
        );
        rec.check(
            'no notification the shell holds names the muted child\'s pane',
            !afterConductor.recentNotifications.some((record) => record.key === dedupeKey(childPane)),
            JSON.stringify(afterConductor.recentNotifications.map((record) => record.key))
        );

        // ── 5 · back in front: the footer counts the two apart ───────────────────────────
        await harness.restore();
        await harness.focus();
        await d.settle(async () => (await page.eval(`document.visibilityState === 'visible'`)) === true, {
            ceilingMs: 5_000,
            intervalMs: 100
        });
        const footerReady = await d.settleDom(
            page,
            `${chipCount('waiting')} === ${String(baseline.waiting + 1)} && ${chipCount('muted')} === ${String(baseline.muted + 1)}`,
            { ceilingMs: 5_000 }
        );
        const footer = await page.eval(
            `JSON.stringify(Array.from(document.querySelectorAll('[data-testid="footer-keep"] [data-testid^="count-"]')).map(el => [el.getAttribute('data-testid'), el.getAttribute('data-count')]))`
        );
        rec.check(
            'the footer counts the conductor as waiting and the child as muted, muted right after waiting',
            footerReady && String(footer).indexOf('count-waiting') < String(footer).indexOf('count-muted'),
            String(footer)
        );
        await rec.shot(page, 'footer-waiting-and-muted');

        // The renderer's own notification manager (`state/bridge.ts`) would toast any notification
        // it received, under the same `kelpi-<pane>` key; none may name the muted child.
        const toasts = JSON.parse(
            String(
                await page.eval(
                    `JSON.stringify(Array.from(document.querySelectorAll('[data-testid^="toast-"]')).map(el => el.getAttribute('data-testid')))`
                )
            )
        );
        rec.check(
            'no in-app toast names the muted child\'s pane',
            !toasts.includes(`toast-${dedupeKey(childPane)}`),
            JSON.stringify(toasts)
        );

        // ── 6 · the toggle, both ways in the row menu, which stays open; then the CLI ─────
        await d.openSidebarMenu(page, d.PAGE.workspaceRows, 'Mute Child');
        const mutedMenu = await readMenu();
        rec.check(
            'the row menu shows Mute Notifications in its own section above Select All, as a ticked checkbox',
            JSON.stringify(mutedMenu.order.slice(mutedMenu.order.indexOf('move'), mutedMenu.order.indexOf('select-all') + 1)) ===
                JSON.stringify(['move', '-', 'mute', '-', 'select-all']) &&
                mutedMenu.role === 'menuitemcheckbox' &&
                mutedMenu.ariaChecked === 'true' &&
                mutedMenu.box === 'checked' &&
                mutedMenu.boxLast === true,
            JSON.stringify(mutedMenu)
        );
        await themedShots('menu-muted');

        // Off by pointer. The box follows the daemon's delta, so wait for it rather than assume.
        const boxIs = (state) =>
            `document.querySelector('${d.PAGE.contextMenu} [data-menu-item="mute"] [data-testid="menu-checkbox"]')?.getAttribute('data-state') === '${state}'`;
        await d.clickMenuItem(page, 'Mute Notifications');
        const emptied = await d.settleDom(page, boxIs('unchecked'), { ceilingMs: 5_000 });
        const iconGone = await d.settleDom(page, `!(${iconOn(childID)})`, { ceilingMs: 5_000 });
        const unmutedFlag = (await listed()).find((workspace) => workspace.id === childID)?.muted;
        const afterOff = await readMenu();
        rec.check(
            'unticking Mute Notifications keeps the menu open with the box now empty, and clears the flag and the icon',
            emptied && afterOff.order.includes('mute') && afterOff.ariaChecked === 'false' && iconGone && unmutedFlag === false,
            JSON.stringify({ emptied, menu: afterOff, iconGone, muted: unmutedFlag })
        );
        await themedShots('menu-after-toggle-off');

        // Back on from the keyboard: the click left the keyboard on the row.
        const focusedMute = (await page.eval(`document.activeElement?.getAttribute('data-menu-item') === 'mute'`)) === true;
        await page.key('Space', { key: ' ', keyCode: 32 });
        const ticked = await d.settleDom(page, boxIs('checked'), { ceilingMs: 5_000 });
        const iconBack = await d.settleDom(page, iconOn(childID), { ceilingMs: 5_000 });
        const remutedFlag = (await listed()).find((workspace) => workspace.id === childID)?.muted;
        const afterOn = await readMenu();
        rec.check(
            'Space on the still-focused row ticks it again, the menu still open, the flag and the icon back',
            focusedMute && ticked && afterOn.ariaChecked === 'true' && iconBack && remutedFlag === true,
            JSON.stringify({ focusedMute, ticked, menu: afterOn, iconBack, muted: remutedFlag })
        );
        await rec.shot(page, 'menu-after-toggle-on');
        await page.key('Escape', { key: 'Escape' });
        const closed = await d.settleDom(page, `document.querySelector('${d.PAGE.contextMenu}') === null`, { ceilingMs: 3_000 });
        rec.check('Escape closes the menu', closed, closed ? 'closed' : 'still open after 3 s');

        // The CLI, both ways.
        const toggled = await cli.run(['workspace', 'mute', childID, '--toggle']);
        const cliIconGone = await d.settleDom(page, `!(${iconOn(childID)})`, { ceilingMs: 5_000 });
        rec.check(
            'kelpi workspace mute --toggle unmutes, and the icon goes',
            toggled.code === 0 && toggled.stdout.trim() === 'Mute Child: notifications unmuted' && cliIconGone,
            JSON.stringify({ code: toggled.code, stdout: toggled.stdout.trim(), cliIconGone })
        );
        const remuted = await cli.run(['workspace', 'mute', childID]);
        const cliIconBack = await d.settleDom(page, iconOn(childID), { ceilingMs: 5_000 });
        rec.check(
            'kelpi workspace mute puts the flag and the icon back',
            remuted.code === 0 && remuted.stdout.trim() === 'Mute Child: notifications muted' && cliIconBack,
            JSON.stringify({ code: remuted.code, stdout: remuted.stdout.trim(), cliIconBack })
        );

        // ── 7 · a daemon restart keeps it ────────────────────────────────────────────────
        if (daemon === null) {
            rec.note('LIMIT: no sandbox daemon handle (--attach), so the restart check was skipped');
        } else {
            // A connection-state trail, so "connected" afterwards means RE-connected: a read taken
            // before the window noticed the restart would find the old mirror and prove nothing.
            await page.eval(`(() => {
                const root = document.querySelector('[data-connection]');
                globalThis.__muteTrail = [];
                if (root === null) return;
                new MutationObserver(() => globalThis.__muteTrail.push(root.getAttribute('data-connection')))
                    .observe(root, { attributes: true, attributeFilter: ['data-connection'] });
            })()`);
            await daemon.restart();
            const reconnected = await d.settleDom(
                page,
                `globalThis.__muteTrail.some(state => state !== 'connected') && document.querySelector('[data-connection]')?.getAttribute('data-connection') === 'connected'`,
                { ceilingMs: 30_000 }
            );
            rec.note(`connection trail: ${String(await page.eval('JSON.stringify(globalThis.__muteTrail)'))}`);
            const afterRestart = (await listed()).find((workspace) => workspace.id === childID)?.muted;
            const iconAfter = await d.settleDom(page, iconOn(childID), { ceilingMs: 10_000 });
            rec.check(
                'the muted flag and its icon survive a daemon restart',
                reconnected && afterRestart === true && iconAfter,
                JSON.stringify({ reconnected, muted: afterRestart, iconAfter })
            );
            await rec.shot(page, 'after-restart');
        }
    } finally {
        if (originalConfig !== null) {
            fs.writeFileSync(sandbox.configPath, originalConfig);
            await d.settle(async () => (await page.eval(`document.documentElement.dataset.kelpiTheme ?? ''`)) === startingTheme, {
                ceilingMs: 10_000,
                intervalMs: 100
            });
        }
        // `restore` before `focus` (`focus` does not undo `app.hide()`), and both before the
        // clean-up, because a hidden, unfocused window is the next scenario's problem.
        await harness.restore();
        await harness.focus();
        await d.settle(async () => (await page.eval(`document.visibilityState === 'visible'`)) === true, {
            ceilingMs: 5_000,
            intervalMs: 100
        });
        for (const workspaceID of created) await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}
