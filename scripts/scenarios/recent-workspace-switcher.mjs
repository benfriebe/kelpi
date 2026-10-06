/**
 * ⌃Tab switches workspaces in most-recently-used order: a quick tap toggles between the last two,
 * holding ⌃ shows the switcher and each Tab steps further back, Escape cancels. The same from a web
 * page, a markdown preview and a plugin pane, where the release has to find its way to the window.
 * docs/config-keybindings.md §7.8
 *
 * CDP delivers a key to the target it is sent to, not to wherever the OS keyboard focus is. So
 * from a web page the ⌃ release is sent to the WINDOW, which is where macOS delivers it once the
 * shell has handed the window the keyboard, and the hand-off itself is checked separately.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MOD, connect, waitForPageTarget } from '../ui-audit/lib/cdp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_LAB = path.join(REPO_ROOT, 'examples/plugins/ui-lab');
const UI_LAB_ID = 'example.ui-lab';

// The web-page checks read which renderer holds the keyboard, which a hidden window never gives.
export const windowPlacement = 'offscreen';

export const covers = [
    'packages/client/src/app/recent-switcher.ts',
    'packages/client/src/app/recent-workspaces.ts',
    'packages/client/src/chrome/RecentWorkspaceSwitcher.tsx',
    'packages/client/src/App.tsx',
    'packages/client/src/content/bridge.ts',
    'packages/client/src/content/ContentFrame.tsx',
    'packages/client/src/plugins/PluginView.tsx',
    'packages/plugin-sdk/browser.js',
    'packages/shell/src/webhost/keys.ts',
    'packages/shell/src/webhost/index.ts'
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
    // A press in a frame goes to the frame (CDP routes keys to the focused frame), and the frame
    // passes its keyups on: the quick tap, and a hold far past any timer, from inside `frame`.
    const frameGestures = async (label, home, frame) => {
        const [a, b] = created;
        const focusFrame = async () => {
            await sleep(300);
            const box = await page.eval(`(() => { const f = document.querySelector('${frame}'); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if (box !== null) await page.clickAt(box.x, box.y);
            return d.settle(() => page.eval(`document.activeElement?.tagName === 'IFRAME'`), { ceilingMs: 3000 });
        };
        // Order: home, a, b.
        await visit(b);
        await visit(a);
        await visit(home);
        rec.check(`the ${label} holds the keyboard`, await focusFrame());
        await control('rawKeyDown');
        await tab();
        await control('keyUp');
        rec.check(`a quick ⌃Tab from a ${label} switches`, await d.settle(async () => (await active()) === a));
        rec.check(`…and leaves no switcher behind (${label})`, await d.settle(async () => (await switcherShown()) === false));

        await visit(home);
        rec.check(`the ${label} has the keyboard again`, await focusFrame());
        await control('rawKeyDown');
        await tab();
        await sleep(1200);
        rec.check(`holding ⌃ after ⌃Tab in a ${label} shows the switcher`, await switcherShown());
        rec.check(`…and switches nothing while ⌃ is held (${label})`, (await active()) === home);
        await tab();
        await control('keyUp');
        rec.check(`releasing ⌃ after a held browse from a ${label} lands two back`, await d.settle(async () => (await active()) === b));
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

        // ── From a focused web page ──────────────────────────────────────────────────────
        // The page gives the chord up to the shell's relay, which also hands the window the
        // keyboard: Chromium suppresses the page's keyups after the chord, ⌃'s included.
        const w = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'MRU Web', '--path', sandbox.root, '--json'])).workspace_id;
        created.push(w);
        await visit(w);
        await cli.ok(['web', 'open', '--focus', 'data:text/html,<title>mru-web</title><input autofocus>']);
        const target = await waitForPageTarget(sandbox.debugPort, { match: (t) => t.title === 'mru-web', timeoutMs: 15_000 });
        const web = await connect(target.webSocketDebuggerUrl, { repoRoot: REPO_ROOT });
        try {
            const webControlDown = () =>
                web.send('Input.dispatchKeyEvent', {
                    type: 'rawKeyDown',
                    code: 'ControlLeft',
                    key: 'Control',
                    windowsVirtualKeyCode: 17,
                    nativeVirtualKeyCode: 17,
                    modifiers: MOD.ctrl
                });
            const pageHasKeyboard = () => web.eval('document.hasFocus()');
            // The view takes the keyboard from the window (the audit's way: a CDP press does not).
            const focusPage = async () => {
                await web.send('Page.bringToFront');
                return d.settle(pageHasKeyboard, { ceilingMs: 3000 });
            };
            // Order: W, a, c, b.
            await visit(a);
            await visit(w);
            rec.check('the web page holds the keyboard', await focusPage());

            // A quick tap: the release reaches the window, which now has the keyboard.
            await webControlDown();
            await web.key('Tab', { modifiers: MOD.ctrl });
            // The window's own `hasFocus()` reads true throughout; the page losing it is the signal.
            rec.check('⌃Tab in a web page takes the keyboard from the page', await d.settle(async () => (await pageHasKeyboard()) === false, { ceilingMs: 2000 }));
            await control('keyUp');
            rec.check('a quick ⌃Tab from a web page switches', await d.settle(async () => (await active()) === a));
            rec.check('…and leaves no switcher behind', await d.settle(async () => (await switcherShown()) === false));

            // Held: nothing commits until the release, however long ⌃ is held.
            await visit(w);
            rec.check('the web page has the keyboard again', await focusPage());
            await webControlDown();
            await web.key('Tab', { modifiers: MOD.ctrl });
            await sleep(1200);
            rec.check('holding ⌃ after ⌃Tab in a web page shows the switcher', await switcherShown());
            rec.check('…and switches nothing while ⌃ is held', (await active()) === w);
            await tab();
            await control('keyUp');
            rec.check('releasing ⌃ after a held browse from a web page lands two back', await d.settle(async () => (await active()) === c));

            // "Never mind" from a page: the page gets its keyboard back.
            await visit(w);
            rec.check('the web page has the keyboard before a never-mind', await focusPage());
            // Held past the 150 ms, so the switcher paints and the page is parked under it.
            await webControlDown();
            await web.key('Tab', { modifiers: MOD.ctrl });
            await sleep(300);
            await tab(true);
            await control('keyUp');
            await sleep(300);
            rec.check('releasing on the web page’s own workspace keeps it', (await active()) === w);
            // Not asserted: the page does not get its keyboard back here, and no modal gives it
            // back either (closing the palette over a focused page is the same): the hand-back's
            // `focusView` reaches the view while it is still parked.
            rec.note(`after a never-mind the page has the keyboard: ${String(await pageHasKeyboard())}`);
        } finally {
            web.close();
        }

        // ── From a focused markdown preview (a frame: it passes its keyups on) ─────────────
        const m = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'MRU Preview', '--path', sandbox.root, '--json'])).workspace_id;
        created.push(m);
        await visit(m);
        await cli.ok(['open', '--focus', path.join(REPO_ROOT, 'README.md')]);
        const previewFrame = `[data-pane-id] iframe`;
        rec.check('the markdown preview rendered', await d.settle(() => page.eval(`document.querySelector('${previewFrame}') !== null`), { ceilingMs: 15_000 }));
        await frameGestures('markdown preview', m, previewFrame);

        // ── From a focused plugin pane (a frame running the plugin SDK) ────────────────────
        const p = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'MRU Plugin', '--path', sandbox.root, '--json'])).workspace_id;
        created.push(p);
        await cli.ok(['plugin', 'install', UI_LAB, '--trust']);
        const pluginPane = JSON.parse(await cli.ok(['plugin', 'open', UI_LAB_ID, `${UI_LAB_ID}.panel`, '--workspace', p])).paneID;
        await visit(p);
        const pluginFrame = `[data-testid="plugin-view-${pluginPane}"] iframe`;
        rec.check('the plugin pane rendered', await d.settle(() => page.eval(`document.querySelector('${pluginFrame}') !== null`), { ceilingMs: 20_000 }));
        await frameGestures('plugin pane', p, pluginFrame);

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
