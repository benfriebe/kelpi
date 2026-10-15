/**
 * Run Suggested (#384 as a plugin): find the last shell command Claude suggested in a reply, check it
 * is safe to type, and decide where it runs. The reply is the exact text Claude's Stop hook carries
 * (`AgentHookEvent.lastAssistantMessage`), so nothing here undoes screen wraps. Only the idle check
 * reads the screen. Everything here is pure; backend.mjs does the I/O.
 */

/** @typedef {{ command: string, kind: 'bang' | 'fence' }} Suggested */

/** @param {string} line */
const lead = line => line.length - line.trimStart().length;
// `s`: a U+2028 in the command stays in it, so commandProblem names it instead of the line being skipped.
const BANG = /^\s*! (\S.*)$/s;
// Any fence opens a code block; only one labelled for a shell is a suggestion. A closing fence is at
// least as long as its opener, so a ````markdown block can show a ```bash one without it counting.
const FENCE_OPEN = /^\s*(`{3,})\s*([^`]*?)\s*$/;
const FENCE_CLOSE = /^\s*(`{3,})\s*$/;
const SHELL = new Set(['bash', 'sh', 'shell', 'zsh']);
/** @param {string} line @param {number} ticks */
const closes = (line, ticks) => (FENCE_CLOSE.exec(line)?.[1]?.length ?? 0) >= ticks;

/**
 * A fence's body as one command: common indent removed, trailing spaces and blank edge lines dropped.
 * @param {string[]} body
 */
function fenceCommand(body) {
    const lines = body.map(line => line.trimEnd());
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines.at(-1)) lines.pop();
    const indent = Math.min(...lines.filter(Boolean).map(lead));
    return lines.map(line => line.slice(indent)).join('\n');
}

/**
 * The last command Claude suggested in the reply text, or null: a line that is `! cmd` alone, or the
 * body of a closed fence labelled bash, sh, shell or zsh. A `!` inside a sentence is never offered:
 * nothing marks where its command ends. Lines inside any fence are code, never `! cmd` lines, and a
 * fence that never closes runs to the end of the reply.
 * @param {string} reply
 * @returns {Suggested | null}
 */
export function findSuggested(reply) {
    const lines = reply.replace(/\r/g, '').split('\n');
    /** @type {Suggested | null} */
    let found = null;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const open = FENCE_OPEN.exec(line);
        if (open) {
            const ticks = open[1]?.length ?? 3;
            let close = i + 1;
            while (close < lines.length && !closes(lines[close] ?? '', ticks)) close += 1;
            if (close >= lines.length) break; // never closed (or cut at the hook's cap)
            const command = SHELL.has(open[2] ?? '') ? fenceCommand(lines.slice(i + 1, close)) : '';
            if (command.trim()) found = { kind: 'fence', command };
            i = close;
            continue;
        }
        const command = BANG.exec(line)?.[1]?.trim();
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
const MENU = /[>❯]\s*\d+\.|Do you want|Esc to cancel/;

/**
 * True when the screen ends with Claude Code's input box empty: a bare `>` or `❯` prompt between its
 * two rules, and no menu below it. A permission prompt or a half-typed draft replaces the bare prompt,
 * and typing there would answer it. `screen` is `TerminalRead.text`; Claude Code 2.1.x draws on the
 * alternate screen, so `altScreen` says nothing here.
 * @param {string} screen
 */
export function promptReady(screen) {
    const lines = screen.replace(/\r/g, '').split('\n');
    const rules = lines.flatMap((line, index) => (BOX_RULE.test(line) ? [index] : []));
    const below = rules.at(-1);
    const above = rules.at(-2);
    if (below === undefined || above !== below - 2 || !PROMPT_EMPTY.test(lines[below - 1] ?? '')) return false;
    return !lines.slice(below + 1).some(line => MENU.test(line));
}

/**
 * What the caller knows about the pane the suggestion came from. From `panes.list`: `status` is
 * `PaneInfo.status`, `agent` is `PaneInfo.agent`, `sessionID` is `PaneInfo.agentSessionID` (or the
 * Stop event's `sessionID`). `lastNotificationType` is the `notificationType` of the pane's last
 * Claude Notification since its last Stop, and `screen` is `TerminalRead.text`.
 * @typedef {{
 *   status: 'idle' | 'running' | 'waitingForInput' | undefined,
 *   agent: string | undefined,
 *   sessionID: string | undefined,
 *   lastNotificationType: string | undefined,
 *   screen: string
 * }} SessionState
 * @typedef {{ mode: 'session' } | { mode: 'split', reason: string }} Routing
 */

// A finished reply and a permission prompt are both waitingForInput; the notification and the screen tell them apart.
const READY_STATUSES = new Set(['idle', 'waitingForInput']);
const PROMPTS = new Set(['permission_prompt', 'elicitation_dialog']);

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
    if (PROMPTS.has(state.lastNotificationType ?? '')) return split('Claude is waiting at a permission prompt');
    if (!READY_STATUSES.has(state.status ?? '')) return split('Claude is not waiting for input');
    if (!promptReady(state.screen)) return split("Claude's input box is not empty");
    return { mode: 'session' };
}
