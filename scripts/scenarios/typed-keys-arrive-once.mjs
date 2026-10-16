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
 * typed-keys-arrive-once`. The first check holds the engine to that variable (read the way Vite
 * reads it, so a `packages/client/.env*` file counts too), and a stale `dist/` or a build flag that
 * stops working (#353) fails here instead of quietly testing ghostty-web.
 *
 * The battery builds the default engine, so a routine lane proves the ghostty-web half only. The
 * xterm.js half is held down by `cdp.test.mjs`, which pins the event shape that caused it, and by
 * running this file with the variable set.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('../../packages/client/', import.meta.url));

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
 * and popped around the read exactly as an application does; done after a quiet spell rather than
 * at a byte count, so a run that DOES double reads every key typed instead of finishing halfway
 * and leaving the rest (quotes, backslashes, parentheses) to land in the shell.
 */
const READER = `
import fs from 'node:fs';
const [flags, out] = [Number(process.argv[2]), process.argv[3]];
const chunks = [];
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
    clearTimeout(quiet);
    quiet = setTimeout(finish, 1500);
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
    // Vite's own `loadEnv`, from the client's own copy of Vite: the shell's variable over the
    // client's `.env*` files, exactly the value the build substituted.
    const { loadEnv } = await import(createRequire(path.join(clientRoot, 'package.json')).resolve('vite'));
    const configured = loadEnv('production', clientRoot, 'VITE_')['VITE_TERMINAL_ENGINE'] ?? '';
    const wanted = configured.trim().toLowerCase() === 'xterm' ? 'xterm' : 'ghostty';
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
            await d.runInTerminal(page, `${process.execPath} ${reader} ${String(flags)} ${out}`, {
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
            await d.settle(async () => fs.existsSync(out), { ceilingMs: 25_000, intervalMs: 200 });
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
        /*
         * Leave the shared pane at a clean prompt whatever happened above: the battery runs every
         * scenario against one sandbox, and the next one takes this same pane. A reader still
         * running would take its typing; a half-typed quote would swallow its first command.
         * Ctrl-C reaches the reader as a byte in raw mode, so it is sent after the reader's own
         * quiet spell has ended it, and it then cancels whatever line the shell is holding.
         */
        await sleep(1_700);
        await cli.run(['pane', 'send-key', '--target', paneID, 'ctrl-c']);
        await sleep(300);
        await cli.run(['pane', 'send', '--target', paneID, "printf '\\033[<u'; stty sane; clear"]);
        await cli.run(['pane', 'send-key', '--target', paneID, 'enter']);
        await sleep(500);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
