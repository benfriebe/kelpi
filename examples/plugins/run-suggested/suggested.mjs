/**
 * Run Suggested (#384 as a plugin): find the last shell command Claude suggested in a reply, check it
 * is safe to type, and decide where it runs. The reply is the exact text Claude's Stop hook carries
 * (`AgentHookEvent.lastAssistantMessage`), so nothing here undoes screen wraps. Only the idle and
 * typed checks read the screen. Everything here is pure; backend.mjs does the I/O.
 */

/** @typedef {{ command: string, kind: 'bang' | 'fence' }} Suggested */

/** @param {string} line */
const lead = line => line.length - line.trimStart().length;
// `s`: a U+2028 in the command stays in it, so commandProblem names it instead of the line being skipped.
const BANG = /^\s*! (\S.*)$/s;
// A line that is one inline code span holding the whole `! cmd`: the backticks mark where it ends.
const SPAN = /^\s*`(! \S[^`]*)`\s*$/;
// Any fence, of backticks or tildes, opens a code block; only one labelled for a shell is a suggestion.
// A closing fence is the same character and at least as long as its opener, so a ````markdown block
// can show a ```bash one without it counting. A backtick fence's label holds no backtick.
const FENCE_OPEN = /^\s*(`{3,}(?=[^`]*$)|~{3,})\s*(.*?)\s*$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const SHELL = new Set(['bash', 'sh', 'shell', 'zsh']);
/** @param {string} line @param {string} fence */
const closes = (line, fence) => {
    const close = FENCE_CLOSE.exec(line)?.[1] ?? '';
    return close[0] === fence[0] && close.length >= fence.length;
};

/**
 * A fence's body as one command: blank edge lines dropped and the common indent removed. Every other
 * space stays, trailing ones too: a heredoc's lines are data.
 * @param {string[]} body
 */
function fenceCommand(body) {
    const lines = [...body];
    while (lines.length && !lines[0]?.trim()) lines.shift();
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
    const indent = Math.min(...lines.filter(line => line.trim()).map(lead));
    return lines.map(line => line.slice(indent)).join('\n');
}

/**
 * The last command Claude suggested in the reply text, or null: a line that is `! cmd` alone (bare,
 * or as one inline code span), or the body of a closed fence labelled bash, sh, shell or zsh. A `!`
 * inside a sentence is never offered: nothing marks where its command ends. Lines inside any fence
 * are code, never `! cmd` lines, and a fence that never closes runs to the end of the reply.
 * @param {string} reply
 * @returns {Suggested | null}
 */
export function findSuggested(reply) {
    // Only CRLF endings: a lone \r stays in its line, so commandProblem refuses the command instead
    // of it running as different text.
    const lines = reply.replace(/\r\n/g, '\n').split('\n');
    /** @type {Suggested | null} */
    let found = null;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const open = FENCE_OPEN.exec(line);
        if (open) {
            const fence = open[1] ?? '```';
            let close = i + 1;
            while (close < lines.length && !closes(lines[close] ?? '', fence)) close += 1;
            if (close >= lines.length) break; // never closed (or cut at the hook's cap)
            const command = SHELL.has(open[2] ?? '') ? fenceCommand(lines.slice(i + 1, close)) : '';
            if (command.trim()) found = { kind: 'fence', command };
            i = close;
            continue;
        }
        const command = BANG.exec(SPAN.exec(line)?.[1] ?? line)?.[1]?.trim();
        if (command) found = { kind: 'bang', command };
    }
    return found;
}

// Tab, ESC, CR and the rest: anything that could act as a keystroke instead of text. A tab is refused
// too (it would complete in a shell or Claude's box). Only \n passes, for a fence's lines, which
// routeSuggested sends to a new split.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/**
 * Why `command` may not be typed into a pane, or null.
 * @param {string} command
 * @returns {string | null}
 */
export function commandProblem(command) {
    if (!command.trim()) return 'the command is empty';
    // Invisible format characters (bidi overrides, zero-width) could make the text shown differ from what runs.
    if (/\p{Cf}/u.test(command)) return 'the command contains an invisible formatting character';
    if (/[\p{Zl}\p{Zp}]/u.test(command)) return 'the command contains a Unicode line or paragraph separator';
    if (/[\p{Mn}\p{Me}]/u.test(command)) return 'the command contains a combining mark';
    if (/[^\P{Zs} ]/u.test(command)) return 'the command contains a space other than a plain space';
    if (CONTROL.test(command)) return 'the command contains a control character';
    return null;
}

// The input box's own rules start at column 0; rules inside reply text or tool output are indented.
const BOX_RULE = /^[─━═]{20,}\s*$/;
const PROMPT_EMPTY = /^[>❯]\s*$/;
// The glyph, then (unless the row was trimmed to it) one space and whatever the box shows after it.
const PROMPT_LINE = /^[>❯](?:\s(.*))?$/s;
// Where the cursor sits in an empty box: after the glyph and its space (`>`, `❯` and U+00A0 are one cell each).
const PROMPT_COL = 2;
// Any line below the box that belongs to a menu or picker: numbered or pointed-at items, a question,
// or a key hint. Claude's status rows there (model and context, mode, `! for shell mode`) match none.
const MENU = /[>❯]\s*\d+\.|do you want|esc to|enter to|to navigate|↑\/↓|^\s*[>❯]\s/im;

/** @param {string} text */
const collapse = text => text.replace(/\s+/g, ' ').trim();

/**
 * True when the screen ends with Claude Code's input box empty: one prompt line between its two
 * rules, and no menu below it. A permission prompt or a half-typed draft replaces the empty prompt,
 * and typing there would answer it. `screen` is `TerminalRead.text`; Claude Code 2.1.x draws on the
 * alternate screen, so `altScreen` says nothing here.
 *
 * Claude's prompt suggestion draws its predicted next prompt as dim ghost text in the empty box,
 * and right after a `! cmd` reply that prediction is usually the same line. The text carries no
 * styling, so `cursor` (`TerminalRead.cursor`, whose row indexes `screen`'s lines) tells the two
 * apart: an empty box keeps the cursor on the prompt line right after the glyph, at the start of
 * any ghost text, while a draft leaves it at its end. With the cursor there, the box counts as
 * empty when the rest of the line is blank or reads `! ` + `command`. Without a cursor, only a bare
 * glyph counts.
 * @param {string} screen @param {{ row: number, col: number } | undefined} cursor @param {string} command
 */
export function promptReady(screen, cursor, command) {
    const lines = screen.replace(/\r/g, '').split('\n');
    const rules = lines.flatMap((line, index) => (BOX_RULE.test(line) ? [index] : []));
    const below = rules.at(-1);
    const above = rules.at(-2);
    if (below === undefined || above !== below - 2) return false;
    if (lines.slice(below + 1).some(line => MENU.test(line))) return false;
    const prompt = lines[below - 1] ?? '';
    if (!cursor) return PROMPT_EMPTY.test(prompt);
    const match = PROMPT_LINE.exec(prompt);
    if (!match || cursor.row !== below - 1 || cursor.col !== PROMPT_COL) return false;
    const rest = collapse(match[1] ?? '');
    return rest === '' || rest === collapse('! ' + command);
}
// Claude's bash mode: the typed `!` switches the box to running shell commands, and its glyph
// replaces `❯`. Claude Code 2.1.300 draws `! gh auth status` typed into the empty box as `!`, U+00A0,
// then the rest of what was typed, its leading space included.
const BASH_PROMPT = /^!\s*/;

/**
 * True when the screen ends with Claude Code's input box in bash mode holding exactly `command`,
 * and no menu below it: what must still show before Enter goes to the box. Without the `!` glyph,
 * Enter would send the text to Claude as a prompt. `cursor` (the same read's) must be in the box,
 * and not right after the glyph, where Claude keeps it in front of ghost text: a box showing only
 * Claude's prediction `❯ ! cmd` holds nothing typed. The text after the glyph and its spaces must
 * equal `command` exactly, spaces inside quotes included. A command too long for one line wraps:
 * its lines, each trimmed, are joined with nothing (a cut inside a word) or one space (a cut at a
 * space). Ghost text drawn after what was typed makes it false, which leaves the command typed and
 * unrun.
 * @param {string} screen @param {string} command @param {{ row: number, col: number }} [cursor]
 */
export function typedReady(screen, command, cursor) {
    const lines = screen.replace(/\r/g, '').split('\n');
    const rules = lines.flatMap((line, index) => (BOX_RULE.test(line) ? [index] : []));
    const below = rules.at(-1);
    const above = rules.at(-2);
    if (below === undefined || above === undefined) return false;
    if (lines.slice(below + 1).some(line => MENU.test(line))) return false;
    const [first = '', ...rest] = lines.slice(above + 1, below);
    if (!first.startsWith('!')) return false;
    if (cursor && (cursor.row <= above || cursor.row >= below || (cursor.row === above + 1 && cursor.col === PROMPT_COL))) return false;
    const parts = [first.replace(BASH_PROMPT, ''), ...rest.map(line => line.trimStart())].map(line => line.trimEnd());
    return parts.join('') === command || parts.join(' ') === command;
}

/**
 * What the caller knows about the pane the suggestion came from. From `panes.list`: `status` is
 * `PaneInfo.status`, `agent` is `PaneInfo.agent`, `sessionID` is `PaneInfo.agentSessionID` (or the
 * Stop event's `sessionID`). `lastNotificationType` is the `notificationType` of the pane's last
 * Claude Notification since its last Stop, `screen` is `TerminalRead.text` and `cursor` is
 * `TerminalRead.cursor` of the same read.
 * @typedef {{
 *   status: 'idle' | 'running' | 'waitingForInput' | undefined,
 *   agent: string | undefined,
 *   sessionID: string | undefined,
 *   lastNotificationType: string | undefined,
 *   screen: string,
 *   cursor: { row: number, col: number } | undefined
 * }} SessionState
 * @typedef {{ mode: 'session' } | { mode: 'split', reason: string }} Routing
 */

// A finished reply and a permission prompt are both waitingForInput; the notification and the screen tell them apart.
const READY_STATUSES = new Set(['idle', 'waitingForInput']);
/** Notification types that mean Claude is asking something, not waiting at its prompt. */
export const PROMPTS = new Set(['permission_prompt', 'elicitation_dialog']);

/**
 * Where the suggestion runs: typed into the Claude session it came from, or in a new shell split
 * (with the reason, shown to the user). It goes into the session only when Claude wrote it with `!`
 * (meant for the user to run there), it is one line, and the pane is a live Claude session that is
 * not mid-reply, not asking anything, and shows its empty input box.
 * A trailing `\` counts as more than one line: with Enter after it, Claude's box starts a new line.
 * @param {Suggested} found
 * @param {SessionState} state
 * @returns {Routing}
 */
export function routeSuggested(found, state) {
    /** @param {string} reason @returns {Routing} */
    const split = reason => ({ mode: 'split', reason });
    if (found.kind !== 'bang') return split('a code block runs in a new split');
    if (found.command.includes('\n') || found.command.trimEnd().endsWith('\\')) return split('a multi-line command runs in a new split');
    if (state.agent !== 'claude' || !state.sessionID) return split('the pane has no Claude session');
    if (state.status === 'running') return split('Claude is still working');
    if (PROMPTS.has(state.lastNotificationType ?? '')) return split('Claude was last seen at a permission prompt');
    if (!READY_STATUSES.has(state.status ?? '')) return split('Claude is not waiting for input');
    if (!promptReady(state.screen, state.cursor, found.command)) return split("Claude's input box is not empty");
    return { mode: 'session' };
}
