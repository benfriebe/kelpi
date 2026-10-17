/**
 * #264's two client-side changes, on a real Kelpi: a ⌘V whose clipboard read is refused for want
 * of focus waits for the window to be focused and then pastes once, and a paste that ends with
 * nothing typed says why in the shell log.
 *
 * **What this does NOT do is reproduce #264.** The reported failure needs a real app switch, and
 * a lane window is keyless by construction (`packages/shell/src/audit-window.ts`): its page focus
 * is CDP emulation and is never lost the way a deactivated window loses it. So the refusal is
 * staged in the page: `navigator.clipboard.readText` rejects once with Chromium's own
 * `NotAllowedError: Document is not focused.`, and `document.hasFocus()` reads false until the
 * window's next `focus` event. Everything after that is the product: the dispatcher, the read
 * helper, the wait, the second read, the daemon's paste pipeline and the PTY.
 *
 * The shell's half of #264 (the refused hand-back replayed on window focus, and the keyboard
 * owner logged then) needs a window that can be focused, which the lane never is; it is covered
 * by `packages/shell/src/webhost/deferred-focus.test.ts`.
 */

export const covers = [
    'packages/client/src/app/clipboard.ts',
    'packages/client/src/app/terminal-shortcuts.tsx',
    'packages/client/src/App.tsx',
    'packages/shell/src/main.ts'
];

export const windowPlacement = 'offscreen';

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

export default async function ({ page, harness, cli, shell, rec, d, sleep }) {
    const workspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = workspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const activeWorkspace = async () =>
        JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((w) => w.is_active === true)?.id ?? null;
    let workspaceID = null;
    try {
        workspaceID = JSON.parse(await cli.ok(['workspace', 'create', '--focus', '--name', `Paste-${TAG}`, '--json'])).workspace_id;
        await d.settleDom(page, `document.querySelector('[data-workspace-id="${workspaceID}"]')`, { ceilingMs: 10_000 });
        await d.settle(async () => (await d.domPaneIDs(page)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });
        const pane = (await d.domPaneIDs(page))[0];
        if (!rec.check('a terminal pane to paste into', pane !== undefined)) return;
        await d.clipboardCaret(page, harness, pane, { label: 'the ⌘V chord', note: (message) => rec.note(message) });
        await d.runInTerminal(page, 'cat -v', { settleMs: 700 });
        const capture = async () => await cli.ok(['pane', 'capture', '--target', pane]);
        const count = async (mark) => (await capture()).split(mark).length - 1;

        // ── a read refused for want of focus waits for the focus ─────────────────────────
        const MARK = `KELPI-WAIT-${TAG}`;
        rec.check('the clipboard holds the text to paste', String((await harness.clipboardWrite(MARK)).text) === MARK);
        await page.eval(`(() => {
            const clipboard = navigator.clipboard;
            const realRead = clipboard.readText.bind(clipboard);
            const realHasFocus = document.hasFocus.bind(document);
            let refused = false;
            let focused = false;
            window.__pasteStage = { reads: 0 };
            // Registered before the read helper's own listener, so it runs first on the event.
            window.addEventListener('focus', () => { focused = true; }, { once: true });
            document.hasFocus = () => focused && realHasFocus();
            clipboard.readText = () => {
                window.__pasteStage.reads += 1;
                if (!refused) {
                    refused = true;
                    return Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError'));
                }
                return realRead();
            };
            window.__pasteUnstage = () => {
                clipboard.readText = realRead;
                document.hasFocus = realHasFocus;
            };
            return true;
        })()`);
        try {
            await page.key('KeyV', { modifiers: d.MOD.meta, key: 'v' });
            // Well inside the helper's one-second wait: one capture, then the focus.
            await sleep(150);
            const beforeFocus = await count(MARK);
            await page.eval(`window.dispatchEvent(new Event('focus'))`);
            rec.check('the refused read typed nothing before the focus, and did not give up', beforeFocus === 0, `${String(beforeFocus)}`);
            const landed = await d.settle(async () => (await count(MARK)) === 1, { ceilingMs: 3000, intervalMs: 150 });
            rec.check('once the window is focused the text is pasted (#264)', landed, `${String(await count(MARK))} occurrence(s)`);
            await sleep(400);
            rec.check('exactly once', (await count(MARK)) === 1, `${String(await count(MARK))}`);
            rec.check('read twice: the refusal, then the retry', (await page.eval('window.__pasteStage.reads')) === 2);
        } finally {
            await page.eval('window.__pasteUnstage?.(), true');
        }

        // ── a ⌘V with nothing to paste leaves its reason in the shell log ──────────────────
        await harness.clipboardWrite('');
        await sleep(200);
        const before = shell.lines.length;
        await page.key('KeyV', { modifiers: d.MOD.meta, key: 'v' });
        const logged = await d.settle(() => shell.lines.slice(before).some((line) => line.includes('[paste] nothing typed')), {
            ceilingMs: 3000
        });
        rec.check(
            'an empty clipboard leaves "[paste] nothing typed" in the shell log (#264)',
            logged,
            JSON.stringify(shell.lines.slice(before).slice(-4))
        );
    } finally {
        if (startingWorkspace !== null && (await activeWorkspace()) !== startingWorkspace) {
            await page.eval(`document.querySelector('[data-workspace-id="${startingWorkspace}"]')?.click()`);
            await d.settle(async () => (await activeWorkspace()) === startingWorkspace);
        }
        if (workspaceID !== null) await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}
