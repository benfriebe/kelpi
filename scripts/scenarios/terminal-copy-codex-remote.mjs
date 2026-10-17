/**
 * #170: ⌘C copies Shift-dragged conversation text from a Codex-shaped pane in a remote host's
 * workspace, in the desktop window and in the page loaded with no shell window behind it, with a
 * local workspace's pane as the control.
 *
 * The no-shell page is the client a browser over Tailscale runs (the daemon URL, no
 * `shellWindow`, so no shell to defer to), but still inside Electron: it does not measure a
 * browser's own clipboard permission model or native menus. Chrome grants `clipboard.writeText`
 * during a key press without a prompt, as the shell's policy does (`shell/src/main.ts` ▸
 * `applyPermissionPolicy`), so the page code is what differs and what this measures.
 *
 * The local control copies conversation rows only, and only in the desktop window. Measured on
 * this machine, a local pane in the no-shell page intermittently took no selection from a Shift
 * drag at all, and a local pane's Shift press on the last screen row kept the previous selection;
 * neither is the remote asymmetry #170 reports, so neither is asserted here.
 *
 * terminal-surface.md section 12.1.
 *
 * The report: in a remote session, Shift-drag highlights Codex conversation text but ⌘C does
 * not copy it, while the shell prompt and Codex's status line do. Codex owns the mouse (so the
 * highlight is Shift-drag) and draws an inline viewport: conversation rows scroll inside a
 * top-anchored scrolling region and go into history, with the composer and status line pinned
 * below it. The fixture below draws exactly that, so the same selection rules the real agent
 * meets are the ones measured, with no network and no model.
 *
 * Three copies per remote lane: a conversation row with the output at rest; the pinned status
 * line, the half of the report that did copy; and another conversation row after more conversation has
 * streamed in under the selection, moving it up the region and into history between the drag and
 * the chord. The engine's own handling of a selection whose rows move or are trimmed is measured with
 * stronger instrumentation by `terminal-selection-trim.mjs`; this file is about the chord reaching
 * the right renderer in every lane.
 *
 * **Only ⌘C may put the row back.** Copy-on-select (on by default, and not switchable at all
 * before #368, which the pre-#226 measurement needs) writes the dragged text asynchronously, and a
 * write landing after the sentinel would pass for a ⌘C that never happened (measured: the
 * pre-#226 tree passed the at-rest remote copy that way). So its write is given time to land,
 * then the clipboard gets a sentinel, and the row coming back before the chord is a failure.
 * Every drag in a lane selects a different text, so ⌘C returning exactly that text is never left
 * over from an earlier one. What the drag left (the engine's selection length, whether
 * copy-on-select wrote) goes into a failed check's detail, so a missed drag reads as one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, startDaemon, waitForHealthz, makeCli, PROTOCOL_VERSION } from '../ui-audit/lib/stack.mjs';

export const covers = [
    'packages/client/src/app/clipboard.ts',
    'packages/client/src/app/terminal-shortcuts.tsx',
    'packages/client/src/app/RemoteWorkspaceView.tsx',
    'packages/client/src/terminal/pane-registry.ts',
    'vendor/ghostty-web-patched/source/lib/selection-manager.ts'
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const POISON = `KELPI-POISON-${TAG}`;
const STATUS = 'gpt-5-codex high · 94% context left';
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** A Codex-shaped TUI: mouse reporting, a top-anchored region of conversation, a pinned footer. */
function writeFixture(file, signalDir) {
    fs.writeFileSync(file, `
import fs from 'node:fs';
import path from 'node:path';
process.stdin.setRawMode(true);
let rows = process.stdout.rows, region = rows - 4;
const w = (s) => process.stdout.write(s);
const line = (n) => 'codex-conversation-${TAG}-' + String(n).padStart(5, '0');
const footer = () => {
    w('\\x1b7');
    w('\\x1b[' + (rows - 2) + ';1H\\x1b[2K\\u203a Ask Codex to do anything');
    w('\\x1b[' + rows + ';1H\\x1b[2K' + ${JSON.stringify(STATUS)});
    w('\\x1b8');
};
let next = 0;
const emit = (count) => { for (let i = 0; i < count; i++) w('\\r\\n' + line(next++)); footer(); };
w('\\x1bc\\x1b[3J\\x1b[?1000h\\x1b[?1002h\\x1b[?1006h');
w('\\x1b[1;' + region + 'r');
w('\\x1b[' + region + ';1H');
emit(400);
// Codex re-anchors its viewport on a resize (a second client attaching resizes the pane). Only the
// footer is redrawn: new conversation here would shift the rows a lane has already read.
process.stdout.on('resize', () => {
    rows = process.stdout.rows; region = rows - 4;
    w('\\x1b[1;' + region + 'r\\x1b[' + region + ';1H');
    footer();
});
let seen = 0;
setInterval(() => {
    const signal = path.join(${JSON.stringify(signalDir)}, 'more-' + (seen + 1));
    if (fs.existsSync(signal)) { seen++; emit(40); }
}, 25);
process.stdin.on('data', (data) => { if (data.includes(3)) process.exit(0); });
`);
}

export default async function ({ page, harness, cli, sandbox, rec, d, sleep }) {
    const originalURL = await page.eval('location.href');
    const previousConfig = fs.readFileSync(sandbox.configPath, 'utf8');
    const startingWorkspace = JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((workspace) => workspace.is_active === true)?.id ?? null;
    const remote = await makeSandbox(repoRoot, { label: 'codex-copy-remote', clientDir: path.join(repoRoot, 'packages/client/dist') });
    const daemon = startDaemon(remote, { repoRoot });
    const remoteCLI = makeCli(remote, { repoRoot });
    const remoteOK = async (args) => {
        const result = await remoteCLI.run(args);
        if (result.code !== 0) throw new Error(`remote command failed: ${result.stderr || result.stdout}`);
        return result.stdout;
    };
    const readClipboard = async () => String((await harness.clipboardRead()).text);
    const writeClipboard = async (text) => String((await harness.clipboardWrite(text)).text);
    // Fixtures and their signal files live in a directory of this run's own, removed afterwards,
    // so a later scenario in the same sandbox never meets a stale signal.
    const scratch = fs.mkdtempSync(path.join(sandbox.root, `codex-copy-${TAG}-`));
    let localWorkspace = null;
    try {
        try {
            await waitForHealthz(remote.base);

            // ── one Codex-shaped pane on each daemon ────────────────────────────────────
            const startPane = async (run, root, label) => {
                // A background create: each lane opens its workspace's row itself before it reads the pane.
                const created = JSON.parse(await run(['workspace', 'create', '--name', `${label}-${TAG}`, '--path', root, '--json']));
                const workspaceID = created.workspace_id ?? created.id;
                const paneID = JSON.parse(await run(['pane', 'list', '--workspace', workspaceID, '--json']))[0].id;
                const signalDir = path.join(scratch, `signal-${label}`);
                fs.mkdirSync(signalDir, { recursive: true });
                const fixture = path.join(scratch, `codex-${label}.mjs`);
                writeFixture(fixture, signalDir);
                return { workspaceID, paneID, signalDir, fixture, run, signals: 0 };
            };
            const local = await startPane((args) => cli.ok(args), sandbox.root, 'local');
            localWorkspace = local.workspaceID;
            const far = await startPane(remoteOK, remote.root, 'remote');

            const token = fs.readFileSync(path.join(remote.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
            fs.writeFileSync(sandbox.configPath, `${previousConfig}\nremote-daemon = CodexRemote:${remote.base}/?token=${token}\n`);

            const rootFor = (paneID) => `[data-pane-id="${paneID}"][data-terminal-status]`;
            const live = (paneID) => d.settleDom(page, `document.querySelector('${rootFor(paneID)}')?.getAttribute('data-terminal-status') === 'live'`, { ceilingMs: 15_000 });
            const started = new Set();

            const openLocal = async () => {
                const row = `[data-testid="workspace-row"][data-workspace-id="${local.workspaceID}"]`;
                await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 10_000 });
                await page.click(row);
            };
            const openRemote = async () => {
                const row = `[data-testid="remote-daemon-CodexRemote"] [data-workspace-id="${far.workspaceID}"]`;
                if (!(await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 15_000 }))) throw new Error('the remote workspace never appeared in the sidebar');
                await page.click(row);
            };

            const grid = (paneID) =>
                page.eval(`(() => {
                    const r = document.querySelector('${rootFor(paneID)}'); const c = r?.querySelector('canvas');
                    if (!c) return null;
                    const b = c.getBoundingClientRect(), cell = (r.getAttribute('data-terminal-cell') ?? '').split('x').map(Number);
                    return { x: b.x, y: b.y, cw: cell[0], ch: cell[1], mouse: r.getAttribute('data-terminal-mouse') };
                })()`);
            const toasts = () => page.eval(`[...document.querySelectorAll('[data-testid="toast-stack"]')].map((node) => node.textContent).join(' | ')`);

            const lane = async (name, pane, open, { status = true } = {}) => {
                await open();
                if (!(await live(pane.paneID))) {
                    rec.check(`${name}: the pane is live`, false);
                    return;
                }
                if (!started.has(pane.paneID)) {
                    started.add(pane.paneID);
                    await pane.run(['pane', 'send', '--target', pane.paneID, `exec ${quote(process.execPath)} ${quote(pane.fixture)}`]);
                }
                const capture = async () => (await pane.run(['pane', 'capture', '--target', pane.paneID])).split('\n');
                // Settled, not just drawn: a resize from this window attaching redraws the footer,
                // so the screen is read only once two captures a moment apart agree.
                // The screen rows are mapped onto this window's canvas, so the window must be drawing
                // the same grid the daemon has: right after a page loads it may still be resizing.
                const windowRows = () =>
                    page.eval(`(() => {
                        const r = document.querySelector('${rootFor(pane.paneID)}'); const c = r?.querySelector('canvas');
                        const ch = Number((r?.getAttribute('data-terminal-cell') ?? '').split('x')[1] ?? 0);
                        return c && ch > 0 ? Math.round(c.getBoundingClientRect().height / ch) : 0;
                    })()`);
                let screen = [];
                let why = '';
                const steady = await d.settle(async () => {
                    const first = (await capture()).join('\n');
                    await sleep(250);
                    const second = await capture();
                    screen = second;
                    const rows = second.length > 0 && second.at(-1) === '' ? second.length - 1 : second.length;
                    const window = await windowRows();
                    why = `still changing ${String(first !== second.join('\n'))}, status line shown ${String(second.some((row) => row.includes(STATUS)))}, window rows ${String(window)}, screen rows ${String(rows)}`;
                    return first === second.join('\n') && second.some((row) => row.includes(STATUS)) && window === rows;
                }, { ceilingMs: 20_000, intervalMs: 50 });
                rec.check(`${name}: the Codex-shaped fixture is drawing, and has settled at this window's size`, steady, why);
                if (!steady) return;
                const drag = (await d.settleDom(page, `document.querySelector('${rootFor(pane.paneID)}')?.getAttribute('data-terminal-mouse') === 'drag'`, { ceilingMs: 5_000 }));
                rec.check(`${name}: the application owns the mouse (button-drag reporting)`, drag);
                if (!drag) return;

                // Two conversation rows from the third screen row down, well above the footer: one
                // copied at rest, the other copied after more output has moved it.
                const conversation = screen.map((row, index) => ({ text: row.trim(), index })).filter((row) => row.index >= 2 && row.text.startsWith('codex-conversation-'));
                const atRest = conversation[0]?.text ?? '';
                const rowIndex = conversation[0]?.index ?? -1;
                const expected = conversation[1]?.text ?? '';
                const movedIndex = conversation[1]?.index ?? -1;
                const statusIndex = screen.findIndex((row) => row.trim() === STATUS);
                rec.check(`${name}: two conversation rows and the status line to select`, atRest !== '' && expected !== '' && statusIndex > movedIndex, JSON.stringify(screen.slice(0, 4)));
                if (atRest === '' || expected === '' || statusIndex < 0) return;

                await d.clipboardCaret(page, harness, pane.paneID, { label: `${name} ⌘C`, note: (message) => rec.note(message), refocus: () => d.focusPaneBody(page, pane.paneID) });
                // The canvas where it IS, re-read before every drag and only once it has stopped
                // moving: right after a page load the layout can still be settling.
                const steadyGrid = async () => {
                    let last = null;
                    const still = await d.settle(async () => {
                        const now = await grid(pane.paneID);
                        const same = now !== null && last !== null && now.x === last.x && now.y === last.y && now.cw === last.cw && now.ch === last.ch;
                        last = now;
                        return same;
                    }, { ceilingMs: 3_000, intervalMs: 150 });
                    return still ? last : null;
                };

                /** Shift-drag across `text` on screen row `row`, and check the drag selected it. */
                /**
                 * Shift-drag across `text` on screen row `row`, then put the sentinel on the clipboard.
                 * Returns what the drag left as witnesses (the engine's selection length, whether
                 * copy-on-select wrote the text), for the ⌘C check's detail: a failed ⌘C after a
                 * drag that selected nothing is a missed drag, not the bug.
                 */
                const select = async (row, text) => {
                    const g = await steadyGrid();
                    rec.check(`${name}: the pane's canvas is in place (${text.slice(-5)})`, g !== null);
                    if (g === null) return null;
                    const y = g.y + g.ch * (row + 0.5);
                    const from = { x: g.x + g.cw * 0.5, y }, to = { x: g.x + g.cw * (text.length - 0.5), y };
                    const modifiers = d.MOD.shift;
                    const selected = () => page.eval(`Number(document.querySelector('${rootFor(pane.paneID)}')?.getAttribute('data-terminal-selection') ?? 0)`);
                    await page.mouse('mousePressed', from.x, from.y, { button: 'left', clickCount: 1, modifiers });
                    try {
                        await sleep(80);
                        await page.mouse('mouseMoved', to.x, to.y, { button: 'left', buttons: 1, modifiers });
                        await sleep(120);
                    } finally {
                        await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1, modifiers });
                    }
                    // Copy-on-select's write is asynchronous: let it land (or not) before the sentinel,
                    // so it cannot arrive after it and pass for a ⌘C.
                    const copiedOnSelect = await d.settle(async () => (await readClipboard()) === text, { ceilingMs: 1_500 });
                    await sleep(300);
                    const witnesses = `drag left ${String(await selected())} characters selected; copy-on-select ${copiedOnSelect ? 'wrote the text' : 'wrote nothing'}`;
                    const poisoned = await writeClipboard(POISON);
                    // A clipboard that will not hold the sentinel leaves ⌘C unmeasured, which is a
                    // failure of this lane rather than a pass.
                    rec.check(`${name}: the clipboard holds the sentinel before ⌘C (${text.slice(-5)})`, poisoned === POISON, poisoned.slice(0, 80));
                    return poisoned === POISON ? witnesses : null;
                };
                const copy = async (text, label, witnesses) => {
                    // The row coming back on its own before the chord would be a late copy-on-select
                    // write passing for ⌘C. (Anything else is some other process on this machine
                    // writing the pasteboard, which ⌘C then overwrites anyway.)
                    await sleep(200);
                    const early = (await readClipboard()) === text;
                    rec.check(`${name}: nothing put the row back before ⌘C (${text.slice(-5)})`, !early);
                    if (early) return;
                    await page.key('KeyC', { modifiers: d.MOD.meta, key: 'c' });
                    const copied = (await d.settle(async () => (await readClipboard()) === text, { ceilingMs: 3_000 })) ? text : await readClipboard();
                    rec.check(`${name}: ${label}`, copied === text, `expected ${JSON.stringify(text)}, clipboard ${JSON.stringify(copied.slice(0, 80))}; ${witnesses}; toasts ${JSON.stringify(await toasts())}`);
                };

                const first = await select(rowIndex, atRest);
                if (first !== null) await copy(atRest, '⌘C copies the Shift-dragged conversation row', first);

                // The pinned status line, which the report says did copy.
                if (status) {
                    const third = await select(statusIndex, STATUS);
                    if (third !== null) await copy(STATUS, '⌘C copies the pinned status line too', third);
                }

                const second = await select(movedIndex, expected);
                if (second !== null) {
                    pane.signals += 1;
                    fs.writeFileSync(path.join(pane.signalDir, `more-${String(pane.signals)}`), '');
                    const moved = await d.settle(async () => !(await capture()).some((row) => row.trim() === expected), { ceilingMs: 5_000 });
                    rec.check(`${name}: more conversation streamed in and moved the selected row off screen`, moved);
                    // DURATION-ASSERTION: the capture above is the daemon's screen; this is the
                    // time given for the same 40 lines to reach this window's engine. Nothing in
                    // the page exposes its grid's text to wait on instead.
                    await sleep(400);
                    await copy(expected, '⌘C still copies that row after more output moved it into history', second);
                }

                await rec.shot(page, name);
            };

            await lane('desktop local', local, openLocal, { status: false });
            await lane('desktop remote', far, openRemote);

            // The page with no shell window identity: the daemon URL a browser on another Mac
            // loads through `tailscale serve` (see the header for what this does not measure).
            const localToken = fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();
            await page.send('Page.navigate', { url: `${sandbox.base}/?token=${localToken}` });
            await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 15_000 });
            rec.check('the page now has no shell window behind it', (await page.eval(`new URL(location.href).searchParams.has('shellWindow')`)) === false);
            await lane('no-shell page remote', far, openRemote);
        } finally {
            fs.writeFileSync(sandbox.configPath, previousConfig);
            try {
                await page.send('Page.navigate', { url: originalURL });
                const back = await d.settleDom(page, `document.querySelector('[data-testid="kelpi-app"]')?.getAttribute('data-connection') === 'connected'`, { ceilingMs: 15_000 });
                if (!back) rec.note('cleanup: the window did not reconnect after returning to its own URL');
                if (localWorkspace !== null) await cli.ok(['workspace', 'delete', localWorkspace, '--force']);
                if (startingWorkspace !== null) {
                    const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
                    if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 5_000 })) await page.click(row);
                }
            } catch (error) {
                rec.note(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    } finally {
        // Outermost, so a cleanup step above that throws can never leave a second daemon running
        // for the rest of the battery.
        await daemon.stop();
        remote.cleanup();
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}
