/**
 * What a waiting agent is asking, read off its screen, for the phone's quick replies.
 *
 * The daemon knows a pane is waiting but not what for: the question lives only on the pane's
 * screen. `pane-capture` reads that screen with its REVISION (#390), and a key carrying the
 * revision is refused if a single byte has reached the screen since. So a quick reply is the
 * person answering exactly the prompt they were shown, or nothing at all.
 *
 * "Waiting" is also simply an agent that finished its turn, so most screens read here are the
 * agent's last REPLY, full of numbered lists, quoted input and bullets. Recognising too little is
 * the safe failure (the card falls back to Open, which is what the phone did before quick replies
 * existed), so a screen is offered as answers only when it is unmistakably a live prompt:
 *
 *   - a NUMBERED MENU, Claude Code's and Codex's approval prompt: consecutive `1.` … `n.` lines
 *     (at most nine) with EXACTLY ONE marked selected by `❯` or `›`, a question ending in `?`
 *     above them, and nothing below them but blank lines, the box's bottom edge and key hints.
 *     Agents' replies use `●` and `>` and never draw a selection mark, and a menu that is not the
 *     last thing on screen has already been answered. A choice is answered with its hotkey: the
 *     letter in a trailing `(y)` when EVERY choice prints a different one, else its number;
 *   - a `[y/N]` QUESTION as the last line: `y` or `n`, then Enter.
 *
 * The question carries everything between the menu and the box's top edge (or a rule), blank
 * lines dropped, so a card asking "Do you want to proceed?" also shows WHAT would proceed.
 */

export interface PhonePromptChoice {
    /** What the button says: the menu's own words, without its hotkey hint. */
    readonly label: string;
    /** "1", "2", "y": shown on the button so it matches what the screen says. */
    readonly hint: string;
    /** The key to type: one printable character. */
    readonly keys: string;
    /** Whether Enter follows the key (a line prompt) or not (a menu acts on the key). */
    readonly submit: boolean;
}

export interface PhonePrompt {
    /** The question, as the screen asked it. */
    readonly question: string;
    /** Empty when the prompt was not one this file can answer: the card offers Open only. */
    readonly choices: readonly PhonePromptChoice[];
}

/** The side borders a TUI draws round a prompt, stripped from a line's ends (its indent is kept). */
const LEFT_BORDER = /^(\s*)[│┃](\s?)/;
const RIGHT_BORDER = /\s*[│┃]\s*$/;
const MENU_LINE = /^(?:([❯›])\s*)?(\d+)[.)]\s+(.+)$/;
const HOTKEY_HINT = /\s*\(([a-z])\)\s*$/i;
/** Trailing key hints that are not the choice's hotkey: `(esc)`, `(shift+tab)`, `(ctrl+c)`. */
const OTHER_HINT = /\s*\((?:esc|shift\+tab|tab|ctrl\+\w|enter)\)\s*$/i;
const YES_NO = /^(.*?)\s*[[(]\s*([yY])\s*\/\s*([nN])\s*[\])]\s*[:?]?\s*$/;
/** A line under a menu that only says which keys do what ("Esc to cancel", "↑↓ to select"). */
const KEY_HINT_LINE = /\b(esc|enter|tab|cancel|select|navigate|confirm)\b/i;
const MAX_CHOICES = 9;
const MAX_QUESTION_LINES = 8;

function clean(line: string): string {
    return line.replace(LEFT_BORDER, '$1').replace(RIGHT_BORDER, '').trimEnd();
}

/** A horizontal rule or a box's top or bottom edge. */
function isRule(line: string): boolean {
    return /^[─━╭╮╰╯┌┐└┘-]{3,}$/.test(line.trim());
}

/** The question above a menu: up to the box's top edge or a rule, blank lines dropped. */
function questionAbove(lines: readonly string[], end: number): string {
    const picked: string[] = [];
    for (let at = end - 1; at >= 0 && picked.length < MAX_QUESTION_LINES; at -= 1) {
        const line = lines[at] ?? '';
        if (isRule(line)) break;
        if (line.trim().length > 0) picked.unshift(line.trim());
    }
    return picked.join('\n');
}

/** Only blank lines, box edges and key hints may sit under a live menu. */
function onlyTrailerBelow(lines: readonly string[], last: number): boolean {
    for (let at = last + 1; at < lines.length; at += 1) {
        const line = (lines[at] ?? '').trim();
        if (line.length === 0 || isRule(line)) continue;
        if (line.length <= 80 && KEY_HINT_LINE.test(line)) continue;
        return false;
    }
    return true;
}

function numberedMenu(lines: readonly string[]): PhonePrompt | null {
    let bottom = lines.length - 1;
    while (bottom >= 0 && !MENU_LINE.test((lines[bottom] ?? '').trim())) bottom -= 1;
    if (bottom < 0) return null;
    const run: { number: number; text: string; at: number; marked: boolean }[] = [];
    let last = bottom;
    for (let at = bottom; at >= 0; at -= 1) {
        const raw = lines[at] ?? '';
        const match = MENU_LINE.exec(raw.trim());
        if (match !== null) {
            run.unshift({ number: Number(match[2]), text: match[3] ?? '', at, marked: match[1] !== undefined });
            continue;
        }
        // A long choice wraps onto a deeper-indented line under it; anything else ends the menu.
        if (raw.trim().length > 0 && /^\s{3,}/.test(raw) && run.length > 0) continue;
        break;
    }
    // The last choice may itself wrap onto deeper-indented lines below it.
    while (last + 1 < lines.length && (lines[last + 1] ?? '').trim().length > 0 && /^\s{5,}/.test(lines[last + 1] ?? '') && !KEY_HINT_LINE.test(lines[last + 1] ?? '')) last += 1;
    if (!onlyTrailerBelow(lines, last)) return null;
    const counts = run.every((entry, index) => entry.number === index + 1);
    const marked = run.filter((entry) => entry.marked).length;
    if (run.length < 2 || run.length > MAX_CHOICES || !counts || marked !== 1) return null;
    const question = questionAbove(lines, run[0]?.at ?? 0);
    if (!question.includes('?')) return null;
    const hotkeys = run.map((entry) => HOTKEY_HINT.exec(entry.text)?.[1]?.toLowerCase());
    const letters = hotkeys.every((key) => key !== undefined) && new Set(hotkeys).size === hotkeys.length;
    const choices = run.map((entry, index) => ({
        label: entry.text.replace(HOTKEY_HINT, '').replace(OTHER_HINT, '').trim(),
        hint: String(entry.number),
        keys: letters ? (hotkeys[index] ?? String(entry.number)) : String(entry.number),
        submit: false
    }));
    return { question, choices };
}

function yesNo(lines: readonly string[]): PhonePrompt | null {
    const last = [...lines].reverse().find((line) => line.trim().length > 0);
    if (last === undefined) return null;
    const match = YES_NO.exec(last.trim());
    if (match === null) return null;
    const question = (match[1] ?? '').trim();
    return {
        question: question.length > 0 ? question : last.trim(),
        choices: [
            { label: 'Yes', hint: 'y', keys: 'y', submit: true },
            { label: 'No', hint: 'n', keys: 'n', submit: true }
        ]
    };
}

/** The last few non-empty lines, for a prompt this file does not recognise. */
function tail(lines: readonly string[]): string {
    return lines
        .filter((line) => line.trim().length > 0 && !isRule(line))
        .slice(-2)
        .map((line) => line.trim())
        .join('\n');
}

/** Read a captured screen; null when it holds nothing to show at all. */
export function parsePrompt(screen: string): PhonePrompt | null {
    const lines = screen.split('\n').map(clean);
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim().length === 0) lines.pop();
    if (lines.length === 0) return null;
    const recent = lines.slice(-40);
    return numberedMenu(recent) ?? yesNo(recent) ?? { question: tail(recent), choices: [] };
}

/**
 * The answers a SMALL card offers: the first choice and the last (in an approval menu, Yes and
 * No). The choices between are the far-reaching ones ("Yes, and don't ask again"), and a card too
 * narrow for the whole menu must never put one of those a tap away without No beside it.
 */
export function cardChoices(choices: readonly PhonePromptChoice[]): readonly PhonePromptChoice[] {
    if (choices.length <= 2) return choices;
    const first = choices[0];
    const last = choices[choices.length - 1];
    return first === undefined || last === undefined ? [] : [first, last];
}
