/**
 * #288: dropping files from Finder onto a terminal pane types their escaped paths, in a plain
 * shell and in a full-screen program that has turned on bracketed paste (an agent's TUI).
 *
 * THE DRAG IS A REAL ONE, AS FAR AS THE PAGE CAN TELL. `Input.dispatchDragEvent` with `data.files`
 * hands the renderer the same `DropData.filenames` a Finder drag does (Chromium's
 * `PopulateDropDataFromPasteboard` fills exactly that field from the pasteboard), so the page sees
 * what it sees for Finder: `types: ["Files"]`, `File` objects, and no path in `text/uri-list` or
 * `text/plain`. Everything after that is the shipped route with nothing stubbed: the page parks the
 * `File`s, the daemon relays `resolve-dropped-files` to this window's shell, the shell reads the
 * paths over its own `webContents.debugger` (`DOM.getFileInfo`), and the page types the escaped
 * answer through `drop-text`. On the tree before #288 every capture below is unchanged: the drop
 * was accepted and silently did nothing.
 *
 * The TUI is a stub, never a real agent: a few lines of Node that turn on bracketed paste
 * (`CSI ? 2004 h`), put the tty in raw mode and print what arrives with the paste markers made
 * visible. What it proves is the part an agent depends on: the path arrives wrapped as a PASTE.
 *
 * The fixtures live under a short `/tmp` directory so the typed path fits one row of a narrow pane
 * and `pane capture` reads it whole.
 */

import fs from 'node:fs';
import path from 'node:path';

export const covers = [
    'packages/client/src/App.tsx',
    'packages/client/src/app/open-file.ts',
    'packages/client/src/app/dropped-files.ts',
    'packages/shell/src/dropped-files.ts',
    'packages/shell/src/status.ts',
    'packages/shell/src/main.ts',
    'packages/daemon/src/ws/sync.ts',
    'packages/daemon/src/ws/desktop.ts'
];

// Input into a frame another window covers is dropped (#206), and a drag is input.
export const windowPlacement = 'offscreen';

const STUB = `
process.stdout.write('\\x1b[?2004h');
process.stdin.setRawMode(true);
process.stdout.write('STUB READY (bracketed paste on)\\r\\n');
process.stdin.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (text.includes('\\x03')) {
        process.stdout.write('\\x1b[?2004l');
        process.exit(0);
    }
    const shown = text.replace(/\\x1b\\[200~/g, '<PASTE>').replace(/\\x1b\\[201~/g, '</PASTE>');
    process.stdout.write('GOT ' + JSON.stringify(shown) + '\\r\\n');
});
`;

/** What a terminal types for a path: the shipped app's (and Ghostty's) backslash escaping. */
const escape = (value) => value.replace(/[ \t\\()[\]{}<>"'`!#$&;|*?]/g, (character) => `\\${character}`);

export default async function ({ page, cli, rec, d, sleep }) {
    const root = fs.mkdtempSync('/tmp/kd-');
    const file = path.join(root, 'drop me (1).txt');
    const folder = path.join(root, 'a folder');
    const stub = path.join(root, 'bp-stub.js');
    fs.writeFileSync(file, 'dropped\n');
    fs.mkdirSync(folder);
    fs.writeFileSync(stub, STUB);
    const typedFile = escape(file);
    const typedFolder = escape(folder);
    rec.note(`fixture ${file} -> types ${typedFile}`);

    let workspaceID;
    try {
        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'File drop', '--json']));
        workspaceID = created.workspace_id ?? created.id;
        await d.settleDom(page, `document.querySelector('[data-workspace-id="${workspaceID}"]')`, { ceilingMs: 10_000 });
        await d.settle(async () => (await d.domPaneIDs(page)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });
        const pane = (await d.domPaneIDs(page))[0];
        rec.check('a terminal pane to drop onto', pane !== undefined);
        if (pane === undefined) return;

        // What the page is handed, recorded in the capture phase before anything handles it.
        await page.eval(`(() => {
            window.__kelpiDropProbe = [];
            window.addEventListener('drop', (event) => {
                const data = event.dataTransfer;
                window.__kelpiDropProbe.push({
                    types: [...(data?.types ?? [])],
                    uriList: data?.getData('text/uri-list') ?? '',
                    files: data?.files?.length ?? 0
                });
            }, true);
        })()`);

        const capture = async () => (await cli.ok(['pane', 'capture', '--target', pane])).replace(/\n/g, '');
        const captureUntil = async (predicate, ceilingMs = 6_000) => {
            const deadline = Date.now() + ceilingMs;
            let text = '';
            do {
                text = await capture();
                if (predicate(text)) return text;
                await sleep(150);
            } while (Date.now() < deadline);
            return text;
        };
        const dropFiles = async (paths) => {
            const box = await page.box(`[data-pane-id="${pane}"] [data-terminal-host]`);
            if (!box) throw new Error('terminal host has no box');
            const data = { items: [], files: paths, dragOperationsMask: 1 };
            for (const type of ['dragEnter', 'dragOver', 'drop']) {
                await page.send('Input.dispatchDragEvent', { type, x: box.cx, y: box.cy, data });
            }
        };
        const toasts = () => page.eval(`document.body.innerText.includes('Drop file')`);

        // ── a plain shell ─────────────────────────────────────────────────────────────
        await d.focusPaneBody(page, pane);
        await d.runInTerminal(page, 'clear', { settleMs: 500 });
        await dropFiles([file]);
        const probe = await page.eval('window.__kelpiDropProbe[0] ?? null');
        rec.note(`the page saw: ${JSON.stringify(probe)}`);
        rec.check(
            'the drop reached the page as Finder’s does: Files, and no path as text',
            probe !== null && probe.types.includes('Files') && probe.uriList === '' && probe.files === 1,
            JSON.stringify(probe)
        );
        const shell = await captureUntil((text) => text.includes(typedFile));
        rec.check('the shell pane received the escaped path', shell.includes(typedFile), shell.slice(-200));
        rec.check(
            'with no newline after it: nothing ran',
            !/denied|no such file|command not found/i.test(shell),
            shell.slice(-200)
        );
        rec.check('and no failure toast', !(await toasts()));
        await rec.shot(page, 'shell-pane-after-drop');

        // Several at once, a folder included, space-separated.
        await page.key('KeyC', { modifiers: d.MOD.ctrl, key: 'c' });
        await d.runInTerminal(page, 'clear', { settleMs: 500 });
        await dropFiles([file, folder]);
        const both = `${typedFile} ${typedFolder}`;
        const multi = await captureUntil((text) => text.includes(both));
        rec.check('a file and a folder dropped together type both paths, space-separated', multi.includes(both), multi.slice(-240));
        await page.key('KeyC', { modifiers: d.MOD.ctrl, key: 'c' });

        // ── a full-screen program with bracketed paste on ────────────────────────────
        await d.runInTerminal(page, 'clear', { settleMs: 500 });
        await d.runInTerminal(page, `${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}`, { settleMs: 400 });
        const ready = await captureUntil((text) => text.includes('STUB READY'));
        rec.check('the bracketed-paste stub is running', ready.includes('STUB READY'), ready.slice(-200));
        const modes = await page.eval(
            `document.querySelector('[data-pane-id="${pane}"][data-terminal-status]')?.getAttribute('data-terminal-bracketed-paste') ?? null`
        );
        if (modes !== null) rec.note(`pane reports bracketed paste: ${modes}`);
        await dropFiles([file]);
        // The stub prints the chunk as JSON, so each typed backslash shows doubled.
        const expected = `GOT "<PASTE>${typedFile.replace(/\\/g, '\\\\')}</PASTE>"`;
        const tui = await captureUntil((text) => text.includes('GOT '));
        rec.note(`the stub printed: ${tui.slice(tui.indexOf('GOT '), tui.indexOf('GOT ') + 160)}`);
        rec.check('the TUI received the escaped path as a bracketed PASTE', tui.includes(expected), tui.slice(-240));
        rec.check('and no failure toast', !(await toasts()));
        await rec.shot(page, 'bracketed-paste-tui-after-drop');
        await page.key('KeyC', { modifiers: d.MOD.ctrl, key: 'c' });
        await sleep(300);
    } finally {
        if (workspaceID !== undefined) await cli.run(['workspace', 'delete', workspaceID, '--force']);
        fs.rmSync(root, { recursive: true, force: true });
    }
}
