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
            await sleep(500);
            await web.send('Input.dispatchKeyEvent', {
                type: 'rawKeyDown',
                code: 'ControlLeft',
                key: 'Control',
                windowsVirtualKeyCode: 17,
                nativeVirtualKeyCode: 17,
                modifiers: MOD.ctrl
            });
            await web.key('Tab', { modifiers: MOD.ctrl });
            rec.check('⌃Tab from a web page opens the switcher at once', await d.settle(switcherShown, { ceilingMs: 2000 }));
            // The page is parked now, so the rest of the gesture is the window's: the window's own
            // document must hold the keyboard, or a real ⌃ release would go to the page.
            rec.check(
                'the window takes the keyboard back from the page',
                await d.settle(() => page.eval(`document.hasFocus() && document.activeElement?.getAttribute('data-testid') === 'recent-switcher'`), { ceilingMs: 2000 })
            );
            await control('keyUp');
            rec.check('releasing ⌃ after starting in a web page switches', await d.settle(async () => (await active()) === c));
        } finally {
            web.close();
        }
    } finally {
        for (const id of created) await cli.ok(['workspace', 'delete', id, '--force']).catch(() => {});
    }
}
