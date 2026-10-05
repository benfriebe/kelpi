/**
 * ⌃Tab switches workspaces in most-recently-used order: a quick tap toggles between the last two,
 * holding ⌃ shows the switcher and each Tab steps further back, Escape cancels.
 * docs/superpowers/specs/2026-10-05-recent-workspace-switcher-design.md
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOD, connect, waitForPageTarget } from '../ui-audit/lib/cdp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const covers = [
    'packages/client/src/app/recent-switcher.ts',
    'packages/client/src/app/recent-workspaces.ts',
    'packages/client/src/chrome/RecentWorkspaceSwitcher.tsx',
    'packages/client/src/App.tsx'
];

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    const created = [];
    const active = async () =>
        JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((workspace) => workspace.is_active === true)?.id ?? null;
    const control = (type) =>
        page.send('Input.dispatchKeyEvent', {
            type,
            code: 'ControlLeft',
            key: 'Control',
            windowsVirtualKeyCode: 17,
            nativeVirtualKeyCode: 17,
            modifiers: type === 'keyUp' ? 0 : MOD.ctrl
        });
    const tab = (shift = false) => page.key('Tab', { modifiers: MOD.ctrl | (shift ? MOD.shift : 0) });
    const switcherShown = () => page.eval(`document.querySelector('[data-testid="recent-switcher"]') !== null`);
    const visit = async (id) => {
        await page.eval(`document.querySelector('[data-workspace-id="${id}"]')?.click()`);
        await d.settle(async () => (await active()) === id);
    };
    try {
        for (const name of ['MRU A', 'MRU B', 'MRU C']) {
            created.push(JSON.parse(await cli.ok(['workspace', 'create', '--name', name, '--path', sandbox.root, '--json'])).workspace_id);
        }
        const [a, b, c] = created;
        for (const id of [a, b, c]) await visit(id);

        // Quick tap: C -> B, no overlay.
        await control('rawKeyDown');
        await tab();
        await control('keyUp');
        rec.check('a quick ⌃Tab goes to the previous workspace', await d.settle(async () => (await active()) === b));
        rec.check('a quick ⌃Tab never shows the switcher', (await switcherShown()) === false);

        // Tap again: B -> C (toggle).
        await control('rawKeyDown');
        await tab();
        await control('keyUp');
        rec.check('a second quick ⌃Tab toggles back', await d.settle(async () => (await active()) === c));

        // Hold: C, [B, A] -> two steps lands on A.
        await control('rawKeyDown');
        await tab();
        await sleep(300);
        rec.check('holding ⌃ shows the switcher', await switcherShown());
        await rec.shot(page, 'switcher-held');
        await tab();
        await control('keyUp');
        rec.check('two Tabs while held land two workspaces back', await d.settle(async () => (await active()) === a));
        rec.check('the switcher closes on release', await d.settle(async () => (await switcherShown()) === false));

        // Escape mid-hold: nothing switches.
        await control('rawKeyDown');
        await tab();
        await sleep(300);
        await page.key('Escape', { modifiers: MOD.ctrl });
        await control('keyUp');
        await sleep(300);
        rec.check('Escape cancels the gesture', (await active()) === a && (await switcherShown()) === false);

        // From a focused web page: the chord reaches the window through the shell's relay, and
        // the switcher must take the keyboard so the ⌃ release is seen. Order now: A (active), C, B.
        await cli.ok(['web', 'open', '--focus', 'data:text/html,<title>mru-web</title><input autofocus>']);
        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.title === 'mru-web', timeoutMs: 15_000 });
        const web = await connect(target.webSocketDebuggerUrl, { repoRoot: REPO_ROOT });
        try {
            const webControl = (type) =>
                web.send('Input.dispatchKeyEvent', {
                    type,
                    code: 'ControlLeft',
                    key: 'Control',
                    windowsVirtualKeyCode: 17,
                    nativeVirtualKeyCode: 17,
                    modifiers: type === 'keyUp' ? 0 : MOD.ctrl
                });
            await sleep(500);
            // A quick tap released entirely inside the page, before the switcher can park it. The
            // page swallows the release, so the gesture ends on its idle timer (WEB_IDLE_COMMIT_MS).
            await webControl('rawKeyDown');
            await web.key('Tab', { modifiers: MOD.ctrl });
            await webControl('keyUp');
            rec.check('a quick ⌃Tab released inside a web page switches', await d.settle(async () => (await active()) === c));
            rec.check('…and leaves no switcher behind', await d.settle(async () => (await switcherShown()) === false));
            await visit(a);
            await sleep(500);
            await webControl('rawKeyDown');
            await web.key('Tab', { modifiers: MOD.ctrl });
            rec.check('⌃Tab from a web page opens the switcher at once', await d.settle(switcherShown, { ceilingMs: 2000 }));
            // The page is parked now, so the rest of the gesture is the window's: the window's own
            // document must hold the keyboard, or a real ⌃ release would go to the page.
            rec.check(
                'the window takes the keyboard back from the page',
                await d.settle(() => page.eval(`document.hasFocus() && document.activeElement?.getAttribute('data-testid') === 'recent-switcher'`), { ceilingMs: 2000 })
            );
            // Another Tab, now in the window: its keyup arrives with ⌃ down, so the gesture knows
            // the real release will too and must not commit on the idle timer.
            await tab();
            await sleep(600);
            rec.check('holding ⌃ after the hand-off keeps the switcher open', (await switcherShown()) && (await active()) === a);
            await control('keyUp');
            rec.check('releasing ⌃ after starting in a web page switches', await d.settle(async () => (await active()) === b));
        } finally {
            web.close();
        }

        // Releasing on the workspace the gesture started in (⌃⇧Tab back to row 0) is "never
        // mind": it stays, and its pane gets the caret back from the closed switcher.
        const home = await active();
        await control('rawKeyDown');
        await tab();
        await sleep(300);
        await tab(true);
        await control('keyUp');
        await sleep(300);
        rec.check('releasing on the current workspace keeps it', (await active()) === home);
        rec.check(
            '…and gives its pane the caret back',
            await d.settle(() => page.eval(`document.activeElement?.closest('[data-pane-id]') != null`), { ceilingMs: 2000 })
        );

        // ⌃ is held while the switcher is up, so a click on a row is a ⌃-click.
        await control('rawKeyDown');
        await tab();
        await sleep(300);
        const row = await page.eval(`(() => {
            const r = document.querySelectorAll('[data-testid="recent-switcher-row"]')[2];
            const b = r.getBoundingClientRect();
            return { id: r.getAttribute('data-workspace-id'), x: b.x + b.width / 2, y: b.y + b.height / 2 };
        })()`);
        await page.clickAt(row.x, row.y, { modifiers: MOD.ctrl });
        await control('keyUp');
        rec.check('a ⌃-click on a row switches to it', await d.settle(async () => (await active()) === row.id));

        // A workspace closed mid-gesture is not switched to, and the window keeps showing one.
        const doomed = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'MRU D', '--path', sandbox.root, '--json'])).workspace_id;
        created.push(doomed);
        await visit(doomed);
        await visit(b);
        await control('rawKeyDown');
        await tab();
        await sleep(300);
        await cli.ok(['workspace', 'delete', doomed, '--force']);
        await sleep(300);
        await control('keyUp');
        await sleep(300);
        rec.check('a workspace closed mid-gesture is not switched to', (await active()) === b);
        rec.check('…and the window still shows a workspace', await page.eval(`document.querySelector('[data-pane-id]') !== null`));
    } finally {
        for (const id of created) await cli.ok(['workspace', 'delete', id, '--force']).catch(() => {});
    }
}
