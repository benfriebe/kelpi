/** Private scenario process: raw input log, full-screen ANSI output, deterministic bursts. */
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const root = process.argv[2];
if (!root) throw new Error('A private fixture directory is required.');
fs.mkdirSync(root, { recursive: true });
const stateFile = path.join(root, 'state.json');
const inputFile = path.join(root, 'input.bin');
const commandFile = path.join(root, 'command.json');
const state = { pid: process.pid, sequence: 0, busy: false, bytes: 0, cols: process.stdout.columns, rows: process.stdout.rows, label: 'READY' };
fs.writeFileSync(path.join(root, 'pid'), String(process.pid));
fs.writeFileSync(inputFile, '');
const save = () => { fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); fs.renameSync(`${stateFile}.tmp`, stateFile); };
const paint = () => {
    state.cols = process.stdout.columns; state.rows = process.stdout.rows;
    process.stdout.write('\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1002h\x1b[?1006h\x1b[H\x1b[2J' +
        '\x1b[1;36mKELPI TERMINAL LAB\x1b[0m\r\n' +
        `PID ${process.pid}\r\n` + '\x1b[31m赤\x1b[32m 緑\x1b[0m 🐙 café\r\n' +
        `${state.label}\r\n` + 'SEARCH-ANCHOR\r\n' + 'INPUT READY\r\n');
    save();
};
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', data => fs.appendFileSync(inputFile, data));
process.stdout.on('resize', () => { if (!state.busy) paint(); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async value => {
    state.sequence = value.sequence; state.label = value.label ?? `STEP-${state.sequence}`; state.busy = true; save();
    try {
        if (value.op === 'edit') {
            if (!process.argv[3]) throw new Error('This fixture has no external-editor file.');
            fs.writeFileSync(process.argv[3], value.text);
        }
        if (value.op === 'exit') { state.busy = false; save(); process.exit(0); }
        if (value.op === 'query') process.stdout.write('\x1b[6n');
        if (value.op === 'burst') {
            if (value.scrollback) process.stdout.write('\x1b[?1049l\x1b[H\x1b[2J');
            const line = Buffer.from('\x1b[33m0123456789 αβγ 赤 緑 🐙 café ansi continuation 012345678901234567890123456789\x1b[0m\r\n');
            const chunk = Buffer.concat(Array.from({ length: 128 }, () => line));
            for (let sent = 0; sent < (value.bytes ?? 4 * 1024 * 1024); sent += chunk.length) {
                if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
                state.bytes += chunk.length;
                if (sent % (chunk.length * 8) === 0) save();
                await pause(value.delayMs ?? 4);
            }
        }
    } finally { state.busy = false; paint(); }
};
setInterval(() => {
    if (state.busy || !fs.existsSync(commandFile)) return;
    try { const next = JSON.parse(fs.readFileSync(commandFile, 'utf8')); if (next.sequence > state.sequence) void command(next); } catch { /* Atomic control file can be absent between writes. */ }
}, 25);
process.on('SIGTERM', () => { process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?1049l'); process.exit(0); });
paint();
