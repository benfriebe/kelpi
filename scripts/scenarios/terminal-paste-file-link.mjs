/**
 * #382: ⌘V types a copied file's path, from a clipboard holding a PNG plus a file link (exactly
 * what CleanShot's Copy makes), and a ⌘V that finds nothing says so.
 *
 * terminal-surface.md section 12.2 (steps 3 and 4).
 *
 * The page's clipboard API cannot see that clipboard at all: `readText()` is empty and `read()`
 * answers one item with no types, because Chromium hides the image beside a file link. So ⌘V
 * typed nothing and showed nothing. The window's shell reads its own pasteboard and the page
 * types the path the way a drop of the same file types it.
 *
 * The clipboard is the REAL pasteboard, seeded with the issue's own reproduction (a JXA script
 * writing one item with `public.png` and `public.file-url`), because a page-local stub is exactly
 * what cannot reproduce this: the bug is in what Chromium shows the page. The runner holds the
 * desktop slot, which is what serialises the shared clipboard between runs.
 *
 * Four presses: the file link (its path typed, escaped); an empty clipboard (a toast, nothing
 * typed); a PNG with no link (TERM-043's upload route, unchanged); and the file link again in the
 * page with no shell window (the browser client), which explains instead of typing.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';

export const covers = [
    'packages/client/src/app/clipboard.ts',
    'packages/client/src/app/dropped-files.ts',
    'packages/client/src/App.tsx',
    'packages/shell/src/clipboard-files.ts',
    'packages/shell/src/status.ts',
    'packages/daemon/src/ws/sync.ts'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const NOTHING = 'the clipboard holds no text, image or file to paste';
const BROWSER = 'a browser does not reveal where a copied file lives';
const ICON = '/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/GenericDocumentIcon.icns';

/** The issue's reproduction: one pasteboard item, the PNG's bytes, and (optionally) its file link. */
function seedPasteboard(file, { link }) {
    const script = `
ObjC.import("AppKit");
var pb = $.NSPasteboard.generalPasteboard;
pb.clearContents;
var item = $.NSPasteboardItem.alloc.init;
item.setDataForType($.NSData.dataWithContentsOfFile(${JSON.stringify(file)}), "public.png");
${link ? `item.setStringForType($.NSURL.fileURLWithPath(${JSON.stringify(file)}).absoluteString, "public.file-url");` : ''}
pb.writeObjects($.NSArray.arrayWithObject(item));
var types = pb.pasteboardItems.objectAtIndex(0).types, out = [];
for (var i = 0; i < types.count; i++) out.push(ObjC.unwrap(types.objectAtIndex(i)));
out.join(",");`;
    return execFileSync('osascript', ['-l', 'JavaScript', '-e', script]).toString().trim();
}

function clearPasteboard() {
    execFileSync('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.clearContents; "cleared"']);
}

export default async function ({ page, harness, cli, sandbox, rec, d, sleep }) {
    const originalURL = await page.eval('location.href');
    const startingWorkspace = JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((workspace) => workspace.is_active === true)?.id ?? null;
    // A short path with a space in it, so the escaping is visible and the typed line does not wrap.
    const dir = fs.mkdtempSync(`/tmp/kelpi-paste-${TAG}-`);
    const shot = path.join(dir, 'Shot 1.png');
    const escaped = shot.replaceAll(' ', '\\ ');
    let workspaceID = null;
    try {
        execFileSync('sips', ['-s', 'format', 'png', ICON, '--out', shot], { stdio: 'ignore' });

        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', `Paste-${TAG}`, '--path', sandbox.root, '--json']));
        workspaceID = created.workspace_id ?? created.id;
        const paneID = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']))[0].id;
        const root = `[data-pane-id="${paneID}"][data-terminal-status]`;
        rec.check('a terminal pane to paste into', await d.settleDom(page, `document.querySelector('${root}')?.getAttribute('data-terminal-status') === 'live'`, { ceilingMs: 15_000 }));
        // `cat -v` echoes what arrives, control bytes included, so the capture shows exactly what
        // the paste typed and nothing runs.
        await cli.ok(['pane', 'send', '--target', paneID, 'cat -v']);
        await sleep(500);

        // The typed text, with soft-wrapped rows joined back into one line.
        const typed = async () =>
            (await cli.ok(['pane', 'capture', '--target', paneID]))
                .split('\n')
                .map((row) => row.trimEnd())
                .join('');
        const toasts = () => page.eval(`[...document.querySelectorAll('[data-testid="toast-stack"]')].map((node) => node.textContent).join(' | ')`);
        const press = async (label) => {
            await d.clipboardCaret(page, harness, paneID, { label, note: (message) => rec.note(message), refocus: () => d.focusPaneBody(page, paneID) });
            await page.key('KeyV', { modifiers: d.MOD.meta, key: 'v', keyCode: 86 });
        };

        // ── 1. CleanShot's clipboard: a PNG plus its file link ──────────────────────────
        const seeded = seedPasteboard(shot, { link: true });
        rec.check('the pasteboard holds a PNG and a file link, and no text (the issue’s clipboard)', seeded === 'public.png,public.file-url', seeded);
        const pageView = await page.eval(`(async () => {
            try { return { text: await navigator.clipboard.readText(), items: (await navigator.clipboard.read()).map((item) => item.types) }; }
            catch (error) { return { error: String(error) }; }
        })()`);
        rec.note(`what the page's clipboard API sees: ${JSON.stringify(pageView)}`);
        await press('⌘V over a file link');
        const pathTyped = await d.settle(async () => (await typed()).includes(escaped), { ceilingMs: 6_000 });
        rec.check('⌘V typed the copied file’s own path, escaped as a drop types it', pathTyped, `expected ${escaped}; toasts ${JSON.stringify(await toasts())}`);
        rec.check('and wrote no PNG copy of it', !(await typed()).includes('kelpi-clipboard-images'));
        await rec.shot(page, 'pasted-file-link');

        // ── 2. an empty clipboard ───────────────────────────────────────────────────────
        await page.key('Enter');
        const before = await typed();
        clearPasteboard();
        await press('⌘V over an empty clipboard');
        rec.check('⌘V over an empty clipboard says so in a toast', await d.settle(async () => (await toasts()).includes(NOTHING), { ceilingMs: 6_000 }), JSON.stringify(await toasts()));
        await sleep(300);
        rec.check('and types nothing', (await typed()) === before);
        await rec.shot(page, 'empty-clipboard-toast');

        // ── 3. a PNG with no link: TERM-043's upload, unchanged ─────────────────────────
        rec.check('the pasteboard holds a PNG alone', seedPasteboard(shot, { link: false }) === 'public.png');
        await press('⌘V over a PNG');
        rec.check(
            '⌘V over a PNG with no link still types an uploaded copy’s path',
            await d.settle(async () => /kelpi-clipboard-images\/clipboard-[0-9a-f-]+\.png/.test(await typed()), { ceilingMs: 6_000 }),
            JSON.stringify((await typed()).slice(-200))
        );

        // ── 4. the page with no shell window: the browser client ────────────────────────
        const token = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
        await page.send('Page.navigate', { url: `${sandbox.base}/?token=${token}` });
        await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 15_000 });
        const row = `[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`;
        if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 10_000 })) await page.click(row);
        await d.settleDom(page, `document.querySelector('${root}')?.getAttribute('data-terminal-status') === 'live'`, { ceilingMs: 15_000 });
        await page.key('Enter');
        const beforeBrowser = await typed();
        seedPasteboard(shot, { link: true });
        await press('⌘V over a file link with no shell');
        rec.check(
            'with no shell to ask, ⌘V over a file link explains why it has no path',
            await d.settle(async () => (await toasts()).includes(BROWSER), { ceilingMs: 6_000 }),
            JSON.stringify(await toasts())
        );
        rec.check('and types nothing', (await typed()) === beforeBrowser);
    } finally {
        try {
            await page.send('Page.navigate', { url: originalURL });
            await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 15_000 });
            if (workspaceID !== null) await cli.ok(['workspace', 'delete', workspaceID, '--force']);
            if (startingWorkspace !== null) {
                const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
                if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 5_000 })) await page.click(row);
            }
        } catch (error) {
            rec.note(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            // The pasteboard is the machine's: never leave it holding a link to the file deleted next.
            try {
                clearPasteboard();
            } catch (error) {
                rec.note(`cleanup: the pasteboard could not be cleared (${error instanceof Error ? error.message : String(error)})`);
            }
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}
