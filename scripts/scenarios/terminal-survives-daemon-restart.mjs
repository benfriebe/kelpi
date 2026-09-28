/**
 * #273: a shell survives a daemon restart when the terminal host holds it.
 *
 * docs/terminal-host.md. The daemon is restarted the way a promote or an app update restarts it,
 * with SIGUSR2 (a handoff), in a sandbox whose terminals run in the terminal host. Everything a
 * user would notice is checked from the outside: the window reconnects, the pane's shell is the
 * SAME process (its `$$` does not change), its scrollback is still there, and output the shell
 * printed while no daemon was attached arrives exactly once.
 */

export const covers = [
    'packages/daemon/src/host/server.ts',
    'packages/daemon/src/host/client.ts',
    'packages/daemon/src/boot/compose.ts',
    'packages/daemon/src/term/service.ts'
];

/** Needs the terminal host, which every other sandbox runs without. */
export const terminalHost = true;

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

export default async function ({ page, cli, daemon, rec, d, sleep }) {
    if (daemon === null) {
        rec.note('LIMIT: no sandbox daemon handle (--attach); nothing to restart');
        return;
    }
    await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
    const paneID = (await d.domPaneIDs(page))[0];
    rec.check('a terminal pane to restart under', paneID !== undefined);
    if (paneID === undefined) return;

    const capture = async () => await cli.ok(['pane', 'capture', '--target', paneID, '--scrollback']);
    const captureUntil = async (predicate, ceilingMs = 5_000) => {
        const deadline = Date.now() + ceilingMs;
        let text = '';
        do {
            text = await capture();
            if (predicate(text)) return text;
            await sleep(150);
        } while (Date.now() < deadline);
        return text;
    };
    const shellPid = (text, marker) => {
        const found = [...text.matchAll(new RegExp(`${marker}=(\\d+)`, 'g'))].map((match) => match[1]);
        return found.at(-1) ?? null;
    };

    await cli.ok(['pane', 'send', '--target', paneID, `printf 'BEFORE-${TAG}=%s\\n' $$`]);
    const before = shellPid(await captureUntil((text) => text.includes(`BEFORE-${TAG}=`)), `BEFORE-${TAG}`);
    rec.check('the shell reports its pid', before !== null, String(before));
    // Printed while no daemon is attached: the host must hold it and deliver it exactly once.
    await cli.ok(['pane', 'send', '--target', paneID, `(sleep 2; echo GAP-${TAG}-$((2+3))) &`]);
    await cli.ok(['pane', 'send', '--target', paneID, `echo MARK-${TAG}-$((6*7))`]);
    await captureUntil((text) => text.includes(`MARK-${TAG}-42`));

    await page.eval(`(() => {
        const root = document.querySelector('[data-connection]');
        globalThis.__handoffTrail = [];
        if (root === null) return;
        new MutationObserver(() => globalThis.__handoffTrail.push(root.getAttribute('data-connection')))
            .observe(root, { attributes: true, attributeFilter: ['data-connection'] });
    })()`);
    const generation = daemon.generation;
    await daemon.restart({ handoff: true });
    rec.check('the daemon was really replaced', daemon.generation === generation + 1, `generation ${daemon.generation}`);
    rec.note(`restart: stop ${String(daemon.lastStopMs)} ms, start ${String(daemon.lastStartMs)} ms`);
    const reconnected = await d.settleDom(
        page,
        `globalThis.__handoffTrail.some(state => state !== 'connected') && document.querySelector('[data-connection]')?.getAttribute('data-connection') === 'connected'`,
        { ceilingMs: 30_000 }
    );
    rec.check('the window reconnects to the new daemon', reconnected, String(await page.eval('JSON.stringify(globalThis.__handoffTrail)')));

    const after = await captureUntil((text) => text.includes(`GAP-${TAG}-5`), 8_000);
    rec.check('the scrollback from before the restart is still there', after.includes(`MARK-${TAG}-42`));
    const gapCount = after.split(`GAP-${TAG}-5`).length - 1;
    rec.check('output printed while no daemon ran arrives exactly once', gapCount === 1, `seen ${gapCount} time(s)`);

    await cli.ok(['pane', 'send', '--target', paneID, `printf 'AFTER-${TAG}=%s\\n' $$`]);
    const afterPid = shellPid(await captureUntil((text) => text.includes(`AFTER-${TAG}=`)), `AFTER-${TAG}`);
    rec.check('the pane is still the same shell process', afterPid !== null && afterPid === before, `${String(before)} → ${String(afterPid)}`);
    await rec.shot(page, 'after-handoff');
}
