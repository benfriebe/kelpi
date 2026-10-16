/**
 * #354: every key typed into a terminal reaches the PTY exactly once, on either engine, with the
 * kitty keyboard protocol off and with it on at tuicr's flags (1|2).
 *
 * The report was "with the xterm.js engine, keys typed into tuicr arrive twice": `:q!` became
 * `::qq!`. It was not tuicr and not the kitty protocol: the shell's own command line doubled too.
 * It was this harness. `page.type` sent each character as a `keyDown` that already carried its
 * text AND a separate `char`, which no keyboard does; xterm.js typed both, ghostty-web had no path
 * that could see the second. `cdp.mjs` ▸ `typedKeyEvents` has the whole of it.
 *
 * The measurement is the PTY's own bytes: a reader program puts the TTY in raw mode, optionally
 * pushes kitty flags, and writes back exactly what it read. Every printable ASCII character is
 * typed, because the two engines take different paths per key (ghostty-web cancels some keys and
 * receives others through `beforeinput`; xterm.js reads the virtual key code, which used to be
 * wrong for punctuation).
 *
 * Run it on the fallback engine with `VITE_TERMINAL_ENGINE=xterm node scripts/scenario.mjs
 * typed-keys-arrive-once`. The first check holds the engine to that variable, so a stale `dist/`
 * or a build flag that stops working (#353) fails here instead of quietly testing ghostty-web.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The source this drives (ui-audit/README.md ▸ The rule). `renderer.ts` selects the engine from
 * the build variable (#353); `TerminalPane.tsx` and `kitty-keyboard.ts` are the capture-phase
 * interceptor every keystroke passes before the engine sees it.
 */
export const covers = [
    'packages/client/src/terminal/renderer.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/terminal/kitty-keyboard.ts'
];

/** Every printable ASCII character, space to tilde. */
const TYPED = Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) => String.fromCharCode(0x20 + index)).join('');

/**
 * The reader. Raw mode so the line discipline neither echoes nor buffers; the kitty flags pushed
 * and popped around the read exactly as an application does; done after `expected` bytes, or
 * after a quiet spell so a short read still reports what it got.
 */
const READER = `
import fs from 'node:fs';
const [flags, out, expected] = process.argv.slice(2).map((arg, i) => (i === 1 ? arg : Number(arg)));
const chunks = [];
let total = 0;
let quiet;
const finish = () => {
    process.stdin.setRawMode(false);
    if (flags !== 0) process.stdout.write('\\x1b[<u');
    fs.writeFileSync(out, JSON.stringify(Buffer.concat(chunks).toString('latin1')));
    process.stdout.write('\\r\\nREAD-DONE\\r\\n');
    process.exit(0);
};
process.stdin.setRawMode(true);
if (flags !== 0) process.stdout.write('\\x1b[>' + flags + 'u');
process.stdout.write('READY-' + flags + '\\r\\n');
process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
    total += chunk.length;
    clearTimeout(quiet);
    if (total >= expected) setTimeout(finish, 400);
    else quiet = setTimeout(finish, 6000);
});
quiet = setTimeout(finish, 20000);
`;

export default async function ({ page, cli, rec, d, sleep }) {
    await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
    const paneID = (await d.domPaneIDs(page))[0];
    rec.check('a terminal pane to type into', paneID !== undefined, JSON.stringify(await d.domPaneIDs(page)));
    if (paneID === undefined) return;

    const paneRoot = `[data-pane-id="${paneID}"][data-terminal-status]`;
    const readFlags = async () =>
        await page.eval(`(() => document.querySelector('${paneRoot}')?.getAttribute('data-terminal-kitty') ?? null)()`);
    const capture = async () => await cli.ok(['pane', 'capture', '--target', paneID]);

    // ── the engine is the one the build asked for (#353) ────────────────────────────
    const wanted = (process.env['VITE_TERMINAL_ENGINE'] ?? '').trim().toLowerCase() === 'xterm' ? 'xterm' : 'ghostty';
    await d.settle(async () => (await page.eval(`document.querySelector('${paneRoot} canvas, ${paneRoot} .xterm') !== null`)) === true, {
        ceilingMs: 10_000,
        intervalMs: 150
    });
    const engine = (await page.eval(`document.querySelector('${paneRoot} .xterm') !== null`)) ? 'xterm' : 'ghostty';
    rec.check(`the pane runs the ${wanted} engine VITE_TERMINAL_ENGINE selects`, engine === wanted, `found ${engine}`);
    if (engine !== wanted) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-typed-keys-'));
    const reader = path.join(dir, 'reader.mjs');
    fs.writeFileSync(reader, READER);
    await d.focusPaneBody(page, paneID);

    try {
        // 0: the protocol off. 3: DISAMBIGUATE_ESCAPE_CODES | REPORT_EVENT_TYPES, what tuicr asks for.
        for (const flags of [0, 3]) {
            const out = path.join(dir, `got-${String(flags)}.json`);
            // Typed, not sent through the daemon: the command line is the first thing that doubled.
            await d.runInTerminal(page, `${process.execPath} ${reader} ${String(flags)} ${out} ${String(TYPED.length)}`, {
                settleMs: 200
            });
            const ready = await d.settle(async () => (await capture()).includes(`READY-${String(flags)}`), {
                ceilingMs: 8_000,
                intervalMs: 150
            });
            rec.check(`the reader started (flags ${String(flags)})`, ready, (await capture()).trim().slice(-300));
            if (!ready) return;
            const negotiated = await d.settle(async () => (await readFlags()) === String(flags), { ceilingMs: 5_000, intervalMs: 100 });
            rec.check(`the pane publishes data-terminal-kitty="${String(flags)}"`, negotiated, String(await readFlags()));
            if (!negotiated) return;

            await page.type(TYPED);
            await d.settle(async () => fs.existsSync(out), { ceilingMs: 30_000, intervalMs: 200 });
            const got = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
            rec.check(
                `each of the ${String(TYPED.length)} printable characters reached the PTY exactly once (kitty flags ${String(flags)})`,
                got === TYPED,
                got === null ? 'the reader wrote nothing' : `got ${String(got.length)} bytes: ${JSON.stringify(got.slice(0, 160))}`
            );
            await d.settle(async () => (await capture()).includes('READ-DONE'), { ceilingMs: 5_000, intervalMs: 150 });
            await d.runInTerminal(page, 'clear', { settleMs: 400 });
        }
        rec.check('the reader popped its flags on the way out', (await readFlags()) === '0', String(await readFlags()));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
