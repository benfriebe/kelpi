#!/usr/bin/env node
/**
 * A mouse-reporting application, small enough to read, for the phone lane to drive a finger over.
 *
 * ## Why a fixture and not a real TUI
 *
 * Issue #123 is a report about Claude Code: on a real Android phone, a scroll drag over its
 * terminal "can scroll into the lower part of the TUI and open the menus", which is its task line
 * listing background agents and monitors. Claude Code is not installable inside the audit's
 * sandbox and would not be a measurement if it were - what it does with a byte is its own
 * business. What CAN be measured is the byte, and that is all this prints: every report the client
 * sends, escaped, in order, with the millisecond it arrived.
 *
 * It asks for exactly what Claude Code asks for - the alternate screen, `?1000h` + `?1002h`
 * (press, release and motion while a button is down) and `?1006h` (SGR coordinates) - so the
 * daemon's own mode tracker (`packages/daemon/src/term/mouse-modes.ts`) sees the same DECSETs and
 * the client's pane publishes `data-terminal-mouse=drag`, which is the state the whole defect
 * lives in.
 *
 * ## What it writes, and where
 *
 * Two places, because they answer different questions:
 *
 *   - **the log file** (`--log`) is the measurement. One line per read, `<ms>\t<escaped>`, so the
 *     step reads bytes rather than pixels and a byte trail can go in a PR.
 *   - **the alternate screen** is the picture. The last few reports and a running count, so a
 *     screenshot of a failing run shows what arrived rather than only that something did.
 *
 * The escaping is `cat -v`'s: `ESC` is `^[`, other C0 bytes are `^` plus the letter, `0x7f` is
 * `^?`, and a byte over 0x7e is `\xNN`. A report is therefore printable and greppable.
 *
 * ## Usage
 *
 *     node mouse-report-probe.mjs --log /path/to/trail.log [--modes 1000,1002,1006] [--alt-scroll]
 *
 * `--modes` with an empty value asks for NOTHING, which is the control: the same fixture, the
 * same alternate screen, no mouse reporting, so the step can tell "a touch sent nothing because
 * the rule held" from "a touch sent nothing because the fixture was not running".
 *
 * `--alt-scroll` adds `?1007h` (xterm's alternate-scroll: a wheel over the alternate screen is
 * arrow keys). It is here to MEASURE that case, not because anything implements it yet - see the
 * PR for #123.
 *
 * It exits on `q`, on Ctrl-C and on Ctrl-D, restoring every mode it set, so the pane it borrows
 * goes back to a prompt the way every other audit fixture leaves one.
 */

import fs from 'node:fs';

function option(name, fallback = null) {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;
    return process.argv[index + 1] ?? '';
}

const logPath = option('log');
if (logPath === null) {
    process.stderr.write('mouse-report-probe: --log <path> is required\n');
    process.exit(2);
}
const altScroll = process.argv.includes('--alt-scroll');
const modes = String(option('modes', '1000,1002,1006'))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** `cat -v`, transcribed: this is what makes a report a line a human and a regex can both read. */
function escapeByte(byte) {
    if (byte === 0x1b) return '^[';
    if (byte < 0x20) return `^${String.fromCharCode(byte + 0x40)}`;
    if (byte === 0x7f) return '^?';
    if (byte > 0x7e) return `\\x${byte.toString(16).padStart(2, '0')}`;
    return String.fromCharCode(byte);
}

const escape = (chunk) => Array.from(chunk, escapeByte).join('');

const started = Date.now();
const log = fs.createWriteStream(logPath, { flags: 'a' });
const write = (text) => process.stdout.write(text);

/** Every mode this process turned on, so the exit path can turn off exactly those. */
const enabled = [...modes, ...(altScroll ? ['1007'] : [])];

let reports = 0;
const recent = [];

function paint() {
    // Home, clear, then a fixed frame: the alternate screen has no scrollback to lose, and a
    // repaint per report is cheaper to read in a screenshot than a scrolling list.
    write('\x1b[H\x1b[2J');
    write(`MOUSE-REPORT-PROBE ready  modes=${enabled.length === 0 ? '(none)' : enabled.join(',')}\r\n`);
    write(`log=${logPath}\r\n`);
    write(`reports=${String(reports)}\r\n`);
    write('--- last 12 ---\r\n');
    for (const line of recent.slice(-12)) write(`${line}\r\n`);
}

function shutdown(code = 0) {
    for (const mode of [...enabled].reverse()) write(`\x1b[?${mode}l`);
    write('\x1b[?1049l');
    try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
        /* a pane that already went away */
    }
    log.end(() => process.exit(code));
}

// The alternate screen FIRST, then the modes, so a reader watching the byte stream sees the same
// order Claude Code emits and the daemon's tracker folds them in the same order.
write('\x1b[?1049h');
for (const mode of enabled) write(`\x1b[?${mode}h`);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

log.write(`# probe start modes=${enabled.join(',') || '(none)'} at ${new Date(started).toISOString()}\n`);
paint();
// The readiness marker goes in the LOG, not on the screen: the step waits on the file so it never
// races a repaint, and `pane capture` cannot see an alternate screen's rows anyway.
log.write(`0\tPROBE-READY\n`);

process.stdin.on('data', (chunk) => {
    const text = escape(chunk);
    // Ctrl-C, Ctrl-D and a plain `q` end it. They are checked before the record so the exit
    // keystroke never lands in the trail a step is about to assert on.
    if (chunk.includes(0x03) || chunk.includes(0x04) || chunk.includes(0x71)) {
        shutdown(0);
        return;
    }
    reports += 1;
    const line = `${String(Date.now() - started)}\t${text}`;
    recent.push(line);
    log.write(`${line}\n`);
    paint();
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
