/**
 * Private scenario process: a stand-in for codex's TUI, so a scenario can start "an agent" from New
 * Workspace with no network and no real agent (`scripts/scenarios/new-workspace-agent-prompt.mjs`).
 *
 * It does exactly what the daemon's codex readiness rule reads off a screen
 * (`packages/core/src/agent/launch.ts` ▸ `codexReadiness`) and nothing more: the alternate screen,
 * bracketed paste (`CSI ? 2004 h`), and a composer row that starts with `›` (U+203A). Then it
 * echoes what it is given:
 *
 *   - a bracketed paste (`ESC [200~ … ESC [201~`) is unwrapped onto the composer, its CRs and LFs
 *     kept as line breaks, never as a submit;
 *   - a bare Enter (CR or LF) OUTSIDE a paste is the only submit: it prints `SUBMITTED: <json>` and
 *     clears the composer;
 *   - its own argv is printed on the second row (`ARGV: <json>`), which is where send mode's prompt
 *     arrives;
 *   - other escape sequences (focus, mouse, cursor reports) are skipped; Ctrl-C exits.
 *
 * Everything it sees is also written to `$KELPI_FAKE_AGENT_DIR` (`state.json`, rewritten atomically
 * after every change, and `input.bin`, the raw bytes), so a scenario can read the outcome without
 * parsing a screen. The directory comes from the environment, not argv, because argv is the thing
 * under test.
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.KELPI_FAKE_AGENT_DIR;
if (!dir) throw new Error('KELPI_FAKE_AGENT_DIR is required.');
fs.mkdirSync(dir, { recursive: true });

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const state = { pid: process.pid, argv: process.argv.slice(2), composer: '', pastes: 0, submitted: [], exited: false };
const inputFile = path.join(dir, 'input.bin');
const stateFile = path.join(dir, 'state.json');
fs.writeFileSync(inputFile, '');

const save = () => {
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
};

const paint = () => {
    const rows = ['\x1b[1mFAKE CODEX\x1b[0m (scenario stand-in, no network)', `ARGV: ${JSON.stringify(state.argv)}`];
    for (const text of state.submitted) rows.push(`SUBMITTED: ${JSON.stringify(text)}`);
    rows.push('');
    const lines = state.composer.split('\n');
    lines.forEach((line, index) => rows.push(`${index === 0 ? '›' : ' '} ${line}`));
    process.stdout.write(`\x1b[H\x1b[2J${rows.join('\r\n')}`);
    save();
};

const exit = () => {
    state.exited = true;
    save();
    process.stdout.write('\x1b[?2004l\x1b[?1049l');
    process.exit(0);
};

// Input is parsed across chunks: a paste or an escape sequence can be split between two reads.
let pending = '';
let pasting = false;
/** A CSI sequence (`ESC [` params intermediates final) or an SS3 one (`ESC O x`), or null if incomplete. */
const escapeLength = (text) => {
    if (text.length < 2) return null;
    if (text[1] === 'O') return text.length >= 3 ? 3 : null;
    if (text[1] !== '[') return 1; // a lone ESC (or Alt+key): drop the ESC alone
    for (let index = 2; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
    return null;
};

const consume = () => {
    let changed = false;
    for (;;) {
        if (pending === '') break;
        if (pasting) {
            const end = pending.indexOf(PASTE_END);
            // Hold back a tail that could be the start of the end marker.
            const take = end >= 0 ? end : Math.max(0, pending.length - (PASTE_END.length - 1));
            if (take > 0) {
                state.composer += pending.slice(0, take).replace(/\r\n?/g, '\n');
                changed = true;
            }
            if (end < 0) {
                pending = pending.slice(take);
                break;
            }
            pending = pending.slice(end + PASTE_END.length);
            pasting = false;
            state.pastes += 1;
            changed = true;
            continue;
        }
        const char = pending[0];
        if (char === '\x1b') {
            if (pending.startsWith(PASTE_START)) {
                pending = pending.slice(PASTE_START.length);
                pasting = true;
                continue;
            }
            if (PASTE_START.startsWith(pending)) break; // maybe a paste start, split across reads
            const length = escapeLength(pending);
            if (length === null) break;
            pending = pending.slice(length);
            continue;
        }
        pending = pending.slice(1);
        if (char === '\x03') exit();
        if (char === '\r' || char === '\n') {
            // The one submit: a bare Enter, outside any paste.
            state.submitted.push(state.composer);
            state.composer = '';
            changed = true;
        } else if (char === '\x7f' || char === '\b') {
            state.composer = state.composer.slice(0, -1);
            changed = true;
        } else if (char >= ' ') {
            state.composer += char;
            changed = true;
        }
    }
    if (changed) paint();
};

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
    fs.appendFileSync(inputFile, chunk);
    pending += chunk;
    consume();
});
process.stdin.on('end', exit);
process.stdout.on('resize', paint);
process.on('SIGTERM', exit);
process.on('SIGHUP', exit);

// Alternate screen, then bracketed paste, then the composer: the order codex itself draws them.
process.stdout.write('\x1b[?1049h\x1b[?2004h');
paint();
