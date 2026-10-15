import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #384 as a plugin: the pure half of Run Suggested reads Claude's exact reply text. The example is plain ESM.
type Suggested = { command: string; kind: 'bang' | 'fence' };
type Cursor = { row: number; col: number };
type SessionState = {
    status: 'idle' | 'running' | 'waitingForInput' | undefined; agent: string | undefined;
    sessionID: string | undefined; lastNotificationType: string | undefined; screen: string; cursor: Cursor | undefined;
};
type Routing = { mode: 'session' } | { mode: 'split'; reason: string };
const source = fileURLToPath(new URL('../../../examples/plugins/run-suggested/', import.meta.url));
const { commandProblem, findSuggested, promptReady, routeSuggested, typedReady } = await import(path.join(source, 'suggested.mjs')) as {
    findSuggested(reply: string): Suggested | null;
    commandProblem(command: string): string | null;
    promptReady(screen: string, cursor: Cursor | undefined, command: string): boolean;
    typedReady(screen: string, command: string, cursor?: Cursor): boolean;
    routeSuggested(found: Suggested, state: SessionState): Routing;
};

const RULE = '─'.repeat(80);
// Claude Code 2.1.x after a reply: the transcript, the empty input box between its rules, the status line.
const READY = ['⏺ Log in first, then I will retry:', '', '  ! gh auth login', '', RULE, '❯ ', RULE, '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
// Where Claude keeps the cursor in READY's empty box: on the prompt row, after the glyph and its space.
const READY_CURSOR = { row: 5, col: 2 };
// Claude Code 2.1.300 right after replying `! gh auth status`, its prompt suggestion drawn as ghost text in
// the empty box. The text has no styling: only the cursor, at the start of the text, says it is not a draft.
const ghost = (prompt = '❯\u00a0! gh auth status') => [
    ...Array.from({ length: 42 }, () => ''), '⏺ ! gh auth status', '✻ Worked for 1s · done 12:54 PM',
    RULE, prompt, RULE, '  Opus 5.5 [1M] | ctx:5% [50k]', '  ⏸ manual mode on · ← 3 agents',
].join('\n');
const GHOST_CURSOR = { row: 45, col: 2 };
// Claude Code 2.1.300 right after the plugin's bare send of `! gh auth status` (e2e capture, frame 5): the
// typed `!` switched the box to bash mode, whose glyph `!` replaced `❯`, then U+00A0, then the rest as typed,
// its leading space included. The footer shrank to one line, so the box moved down a row.
const typedFrame = (box: string[] = ['!\u00a0 gh auth status'], below: string[] = ['  ! for shell mode']) => [
    ...Array.from({ length: 43 }, () => ''), '⏺ ! gh auth status', '✻ Worked for 1s · done 12:54 PM',
    RULE, ...box, RULE, ...below,
].join('\n');
// Rules at rows 45 and 47, the cursor at the end of the typed text.
const TYPED_CURSOR = { row: 46, col: 17 };
// The rows Claude Code 2.1.x draws below its box in the e2e captures, none of them a menu.
const FOOTERS = [
    '  Opus 5.5 [1M] | ctx:5% [50k] | 5h:34% [2h4m] | 7d:8% [6d4h44m]', '  ⏸ manual mode on · ← 3 agents',
    '  ! for shell mode', '  ? for shortcuts', '  ⏵⏵ accept edits on (shift+tab to cycle)',
];
// A picker with a one-line search field between column-0 rules and unnumbered items below.
const picker = (field: string) => [
    'Resume a conversation', RULE, field, RULE, '  Fix the login flow (2h ago)', '  Add CSV export (1d ago)',
    '  ↑/↓ to navigate · Enter to select · Esc to go back',
].join('\n');
const PERMISSION = [
    '⏺ Bash(rm -rf build)', '', RULE, ' Bash command', '', '   rm -rf build', '   Remove the build output', '',
    ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No, and tell Claude what to do differently (esc)', '',
].join('\n');

// Real Claude Code 2.1.300 captures (`pane capture --json`, e2e-3 run): a frame's rows from `top` down, the
// transcript above it blank, so the captured cursor row still indexes the text. The scratch project's path
// reads /tmp/example; row widths matter to no check.
const captured = (top: number, rows: string[]) => [...Array.from({ length: top }, () => ''), ...rows].join('\n');
const WIDE_RULE = '─'.repeat(131);
// 10-permission-prompt.json: the Bash permission prompt replaces the input box, so its top edge (row 18) is
// the only column-0 rule. promptReady finds no rule two rows above it, typedReady none above it at all, and
// `Do you want`, `❯ 1.` and `Esc to cancel` below it would each fail the menu test too. The tip row carries a
// U+2014; the cursor is on the `❯` of `1. Yes`.
const REAL_PERMISSION = captured(13, [
    '❯ Run this with the Bash tool: touch /tmp/example/perm-test.txt'.padEnd(131), '',
    '  Creating an empty perm-test.txt file', '  ⎿  $ touch /tmp/example/perm-test.txt', '',
    WIDE_RULE, ' Bash command', ' Tip: auto mode handles these prompts for you \u2014 choose "switch to auto mode" below',
    ' Create an empty perm-test.txt file', '╌'.repeat(131), ' touch /tmp/example/perm-test.txt', '╌'.repeat(131),
    ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and always allow access to /tmp/example from this project',
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for you', '   4. No', '',
    ' Esc to cancel · Tab to amend',
]);
const REAL_PERMISSION_CURSOR = { row: 26, col: 1 };
// 20-model-picker.json: `/model` draws its picker where the box was, under a U+2594 edge that is no box rule,
// so the screen has no column-0 rule at all and neither check reaches its menu test. The cursor is on the
// `❯` of item 2.
const REAL_MODEL_PICKER = captured(29, [
    '▔'.repeat(131), '   Select model',
    '   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with ',
    '   --model.', '',
    '     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
    '   ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks',
    '     3.  Fable 5.1              For your toughest challenges',
    '     4.  Sonnet 5.5             Most efficient for simpler tasks',
    '     5.  Haiku 5.5              Fastest for quick answers',
    '     6.  Haiku 4.5              Fastest for quick answers',
    '     7.  Sonnet 5               Efficient for routine tasks',
    '     8.  Opus 5                 Best for everyday, complex tasks',
    '     9.  Fable 5                Most capable for your hardest and longest-running tasks',
    '   ↓ 10. Opus 4.8               Best for everyday, complex tasks',
    '      … +3 models', '', '   ◉ xHigh effort ←/→ to adjust', '',
    '   Enter to set as default · s to use this session only · Esc to cancel',
]);
const REAL_MODEL_PICKER_CURSOR = { row: 35, col: 3 };
// 30-ask-user-question.json: AskUserQuestion draws its question between two column-0 rules (rows 24 and 34),
// ten rows apart, with its last item and key hints below the lower one. promptReady wants the rules two rows
// apart; typedReady stops at the key hint row (`Esc to cancel` and the rest) below the lower rule. The cursor
// is on the `❯` of `1. Tea`, at column 0.
const REAL_QUESTION = captured(23, [
    '❯ Use the AskUserQuestion tool to ask me whether I prefer tea or coffee'.padEnd(131),
    WIDE_RULE, ' ☐ Drink ', '', 'Do you prefer tea or coffee?', '', '❯ 1. Tea', '     You prefer tea.', '  2. Coffee',
    '     You prefer coffee.', '  3. Type something.', WIDE_RULE, '  4. Chat about this', '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel', '', '', ' '.repeat(5), ' '.repeat(5), '', ' '.repeat(64),
]);
const REAL_QUESTION_CURSOR = { row: 29, col: 0 };
// 24-after-escape.json, the control: the same pane once Esc dismissed the permission prompt. The empty box is
// back between rules at rows 44 and 46 (`❯`, U+00A0), the cursor right after the glyph, so promptReady passes.
// Nothing is typed in bash mode, so typedReady does not.
const REAL_AFTER_ESCAPE = captured(43, [
    ' '.repeat(112) + '◉ xhigh · /effort', WIDE_RULE, '❯\u00a0', WIDE_RULE,
    '  Opus 5.5 [1M] | ctx:5% [50k] | 5h:37% [1h54m] | 7d:9% [6d4h34m]', '  ⏸ manual mode on · ← 3 agents',
]);
const REAL_AFTER_ESCAPE_CURSOR = { row: 45, col: 2 };

describe('findSuggested', () => {
    it('drops the ! prefix and the spaces around the command', () => {
        expect(findSuggested("! ssh root@192.168.7.253 'apt-get dist-upgrade -y -o Dpkg::Options::=--force-confold'  ")).toEqual({
            kind: 'bang',
            command: "ssh root@192.168.7.253 'apt-get dist-upgrade -y -o Dpkg::Options::=--force-confold'",
        });
    });

    it('reads a ! line indented under a list item', () => {
        const reply = ['Run this yourself:', '', '1. Build the client:', '', '   ! npm run build --workspace packages/client', '', 'Then reload.'];
        expect(findSuggested(reply.join('\n'))).toEqual({ kind: 'bang', command: 'npm run build --workspace packages/client' });
    });

    it('reads a line that is one inline code span around the whole ! command', () => {
        expect(findSuggested('Run this in the prompt:\n\n`! gh auth login`\n')).toEqual({ kind: 'bang', command: 'gh auth login' });
        expect(findSuggested('  `! gh auth login`  ')?.command).toBe('gh auth login');
        expect(findSuggested('Run `! x` now')).toBeNull();
        expect(findSuggested('`! a` and `! b`')).toBeNull();
    });

    it('treats each ! line as its own command and offers the last', () => {
        expect(findSuggested(['! git status', '! git log -1'].join('\n'))?.command).toBe('git log -1');
    });

    it('never offers a ! command inside a sentence, whose end plain text cannot show', () => {
        // A real Claude Code reply: taking the rest of the sentence ran `gh auth status first to check ...`.
        expect(findSuggested('Run ! gh auth status first to check whether your GitHub login has expired.')).toBeNull();
        expect(findSuggested('  Run ! rm -rf build first to clean up, then retry.')).toBeNull();
        expect(findSuggested('Wow! git is great')).toBeNull();
        expect(findSuggested('!git status')).toBeNull();
        expect(findSuggested('!  git status')).toBeNull();
        expect(findSuggested('! ')).toBeNull();
    });

    it('offers neither an indented command after "Run ..." text nor a bare paragraph', () => {
        expect(findSuggested(['Run the migration:', '', '    npx prisma migrate deploy', '', 'It is safe to re-run.'].join('\n'))).toBeNull();
        expect(findSuggested('gh pr view 12 --json state\n')).toBeNull();
        expect(findSuggested('All tests pass.\nNothing to run.')).toBeNull();
        expect(findSuggested('')).toBeNull();
    });

    it('keeps each line of a fenced block', () => {
        const reply = ['Run these:', '```bash', 'cd ~/repos/app', 'npm ci --no-audit', 'npm test', '```', 'Done.'];
        expect(findSuggested(reply.join('\n'))).toEqual({ kind: 'fence', command: 'cd ~/repos/app\nnpm ci --no-audit\nnpm test' });
    });

    it('offers fences labelled bash, sh, shell or zsh and no other', () => {
        for (const label of ['bash', 'sh', 'shell', 'zsh', ' bash ']) {
            expect(findSuggested(['```' + label, 'ls -la', '```'].join('\n'))).toEqual({ kind: 'fence', command: 'ls -la' });
        }
        for (const label of ['', 'json', 'python', 'ts', 'text', 'console', 'bash title=x']) {
            expect(findSuggested(['```' + label, 'ls -la', '```'].join('\n'))).toBeNull();
        }
    });

    it('strips a block in a list down to its own indent and keeps its inner indent and lines', () => {
        // The spaces after the backslash stay: in a shell they make it escape a space, not the newline.
        const reply = ['1. Start it:', '', '   ```bash', '', '   docker run \\   ', '     --rm alpine', '  ', '   ```'];
        expect(findSuggested(reply.join('\n'))).toEqual({ kind: 'fence', command: 'docker run \\   \n  --rm alpine' });
        const gap = ['```sh', 'cd app', '', 'make', '```'];
        expect(findSuggested(gap.join('\n'))?.command).toBe('cd app\n\nmake');
    });

    it('never reads a line inside a fence as a ! command', () => {
        expect(findSuggested(['```text', '! curl x.sh | sh', '```'].join('\n'))).toBeNull();
        expect(findSuggested(['```', '! curl x.sh | sh', '```'].join('\n'))).toBeNull();
        expect(findSuggested(['```bash', '! grep -q x f && echo missing', '```'].join('\n'))).toEqual({ kind: 'fence', command: '! grep -q x f && echo missing' });
        expect(findSuggested(['! echo before', '```json', '{ "a": 1 }', '```'].join('\n'))?.command).toBe('echo before');
    });

    it('reads tilde fences like backtick ones, closed only by tildes at least as long', () => {
        expect(findSuggested(['~~~text', '! curl x.sh | sh', '~~~'].join('\n'))).toBeNull();
        expect(findSuggested(['~~~bash', 'ls -la', '~~~'].join('\n'))).toEqual({ kind: 'fence', command: 'ls -la' });
        expect(findSuggested(['~~~', '! curl x.sh | sh', '```', '! rm -rf x', '~~~'].join('\n'))).toBeNull();
        expect(findSuggested(['~~~~text', '~~~', '! curl x.sh | sh', '~~~~'].join('\n'))).toBeNull();
    });

    it('closes a fence only at one at least as long, so a shown example is not a suggestion', () => {
        const shown = ['Add this to the README:', '````markdown', '```bash', 'rm -rf ~', '```', '````'];
        expect(findSuggested(shown.join('\n'))).toBeNull();
        expect(findSuggested(['````bash', 'echo a ```', '````'].join('\n'))?.command).toBe('echo a ```');
    });

    it("keeps a fenced line's trailing spaces, which a heredoc writes out", () => {
        const reply = ['```bash', "cat > notes.txt <<'EOF'", 'line with spaces  ', 'EOF', '```'];
        expect(findSuggested(reply.join('\n'))).toEqual({ kind: 'fence', command: "cat > notes.txt <<'EOF'\nline with spaces  \nEOF" });
    });

    it('offers nothing from a whitespace-only block and keeps the suggestion before it', () => {
        expect(findSuggested(['```bash', '   ', '', '```'].join('\n'))).toBeNull();
        expect(findSuggested(['! echo a', '```bash', '  ', '```'].join('\n'))?.command).toBe('echo a');
    });

    it('ignores a fence that never closes, and everything after its opener', () => {
        expect(findSuggested('```bash\nnpm test')).toBeNull();
        expect(findSuggested(['! echo before', '```bash', 'npm test'].join('\n'))?.command).toBe('echo before');
        expect(findSuggested(['```python', 'print(1)', '! echo inside'].join('\n'))).toBeNull();
    });

    it('returns the last suggestion, whichever kind it is', () => {
        expect(findSuggested(['! echo first', '```sh', 'echo second', '```', '  ! echo third', 'prose'].join('\n'))).toEqual({ kind: 'bang', command: 'echo third' });
        expect(findSuggested(['! echo first', '```sh', 'echo second', '```', 'prose'].join('\n'))).toEqual({ kind: 'fence', command: 'echo second' });
    });

    it('reads CRLF line endings', () => {
        expect(findSuggested('Try:\r\n! git status\r\n')).toEqual({ kind: 'bang', command: 'git status' });
        expect(findSuggested('```bash\r\nls\r\npwd\r\n```\r\n')).toEqual({ kind: 'fence', command: 'ls\npwd' });
    });

    it('keeps a lone carriage return in a ! command so commandProblem refuses it', () => {
        const found = findSuggested('! echo a\rb');
        expect(found).toEqual({ kind: 'bang', command: 'echo a\rb' });
        expect(commandProblem(found?.command ?? '')).toMatch(/control/);
    });

    it('keeps a Unicode separator in a ! command so commandProblem refuses it', () => {
        const found = findSuggested('! echo a rm -rf x');
        expect(found?.command).toBe('echo a rm -rf x');
        expect(commandProblem(found?.command ?? '')).toMatch(/separator/);
    });
});

describe('commandProblem', () => {
    it('refuses empty text, control characters and invisible formatting characters', () => {
        expect(commandProblem('echo a\necho b')).toBeNull();
        expect(commandProblem('  ')).toMatch(/empty/);
        expect(commandProblem('echo \u001b[31m')).toMatch(/control/);
        expect(commandProblem('rm x\r')).toMatch(/control/);
        expect(commandProblem('echo safe ‮;hs.live')).toMatch(/invisible/);
        expect(commandProblem('rm​ -rf x')).toMatch(/invisible/);
    });

    it('refuses a tab, which would complete instead of being typed', () => {
        expect(commandProblem('echo\ta')).toMatch(/control/);
        expect(commandProblem('cd app\n\tmake')).toMatch(/control/);
    });

    it('refuses Unicode line separators, combining marks and any space but a plain one', () => {
        expect(commandProblem('echo a rm -rf x')).toMatch(/separator/);
        expect(commandProblem('echo a rm -rf x')).toMatch(/separator/);
        expect(commandProblem('rm -rf x')).toMatch(/space/);
        expect(commandProblem('rm　-rf x')).toMatch(/space/);
        expect(commandProblem('rm -rf x')).toMatch(/space/);
        expect(commandProblem('rm -rf x͏')).toMatch(/combining/);
        expect(commandProblem('rm -rf x⃝')).toMatch(/combining/);
    });
});

describe('promptReady', () => {
    // Without a cursor only a bare glyph counts as an empty box.
    const ready = (screen: string) => promptReady(screen, undefined, 'gh auth login');

    it('sees the empty input box when it is the last thing drawn', () => {
        expect(ready(READY)).toBe(true);
        expect(ready(['⏺ Done.', RULE, '> ', RULE, '  ? for shortcuts', ''].join('\n'))).toBe(true);
        expect(ready([RULE, '❯', RULE, ''].join('\r\n'))).toBe(true);
        expect(promptReady(READY, READY_CURSOR, 'gh auth login')).toBe(true);
    });

    it('is false with a draft in the box', () => {
        expect(ready([RULE, '> half a draft', RULE].join('\n'))).toBe(false);
        expect(ready([RULE, '❯ ! rm -rf build', RULE].join('\n'))).toBe(false);
    });

    it('is false at a permission prompt or any menu below the box', () => {
        expect(ready(PERMISSION)).toBe(false);
        expect(ready([RULE, '> ', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', RULE].join('\n'))).toBe(false);
        expect(ready([RULE, '> ', RULE, ' ❯ 1. Yes', ' Esc to cancel'].join('\n'))).toBe(false);
        expect(promptReady([RULE, '> ', RULE, ' ❯ 1. Yes', ' Esc to cancel'].join('\n'), { row: 1, col: 2 }, 'gh auth login')).toBe(false);
    });

    it('is false above an unnumbered picker or any key hint, in any case', () => {
        expect(promptReady(picker('❯\u00a0'), { row: 2, col: 2 }, 'gh auth status')).toBe(false);
        expect(promptReady([RULE, '❯\u00a0', RULE, '  esc to cancel'].join('\n'), { row: 1, col: 2 }, 'x')).toBe(false);
        expect(promptReady([RULE, '❯\u00a0', RULE, '  ❯ Yes, allow once', '    No'].join('\n'), { row: 1, col: 2 }, 'x')).toBe(false);
        expect(promptReady([RULE, '❯\u00a0', RULE, '  Enter to confirm'].join('\n'), { row: 1, col: 2 }, 'x')).toBe(false);
    });

    it("is true above each of Claude's status rows", () => {
        for (const footer of FOOTERS) expect(promptReady([RULE, '❯\u00a0', RULE, footer].join('\n'), { row: 1, col: 2 }, 'x')).toBe(true);
    });

    it('is false without two rules at column 0 around the prompt', () => {
        expect(ready('⏺ Done.')).toBe(false);
        expect(ready(['⏺ Done.', RULE, '> '].join('\n'))).toBe(false);
        expect(ready(['     ' + RULE, '     >', '     ' + RULE].join('\n'))).toBe(false);
        expect(ready([RULE, '', '> ', RULE].join('\n'))).toBe(false);
        expect(promptReady([RULE, '', '> ', RULE].join('\n'), { row: 2, col: 2 }, 'gh auth login')).toBe(false);
    });

    it("reads Claude's ghost text equal to the suggestion as an empty box when the cursor sits before it", () => {
        expect(promptReady(ghost(), GHOST_CURSOR, 'gh auth status')).toBe(true);
        expect(promptReady(ghost('❯\u00a0!  gh   auth status  '), GHOST_CURSOR, 'gh  auth status')).toBe(true);
        expect(promptReady(ghost('> ! gh auth status'), GHOST_CURSOR, 'gh auth status')).toBe(true);
    });

    it('reads a blank prompt line as an empty box when the cursor sits after the glyph', () => {
        expect(promptReady(ghost('❯'), GHOST_CURSOR, 'gh auth status')).toBe(true);
        expect(promptReady(ghost('❯\u00a0'), GHOST_CURSOR, 'gh auth status')).toBe(true);
        expect(promptReady(ghost('>'), GHOST_CURSOR, 'gh auth status')).toBe(true);
        expect(promptReady(ghost('> '), GHOST_CURSOR, 'make test')).toBe(true);
    });

    it('is false for ghost text that is not the suggestion, or a draft', () => {
        expect(promptReady(ghost(), GHOST_CURSOR, 'gh auth login')).toBe(false);
        expect(promptReady(ghost('❯\u00a0run the tests'), GHOST_CURSOR, 'gh auth status')).toBe(false);
        expect(promptReady(ghost('❯\u00a0gh auth status'), GHOST_CURSOR, 'gh auth status')).toBe(false);
        // A draft of the same text leaves the cursor at its end.
        expect(promptReady(ghost(), { row: 45, col: 18 }, 'gh auth status')).toBe(false);
        expect(promptReady(ghost('❯\u00a0'), { row: 45, col: 3 }, 'gh auth status')).toBe(false);
    });

    it('is false unless the cursor is on the prompt line', () => {
        expect(promptReady(ghost(), { row: 44, col: 2 }, 'gh auth status')).toBe(false);
        expect(promptReady(ghost(), { row: 48, col: 2 }, 'gh auth status')).toBe(false);
        expect(promptReady(ghost('❯'), { row: 0, col: 0 }, 'gh auth status')).toBe(false);
        expect(promptReady(ghost('❯x'), GHOST_CURSOR, 'gh auth status')).toBe(false);
    });

    it('falls back to the text alone without a cursor, where ghost text reads as a draft', () => {
        expect(promptReady(ghost(), undefined, 'gh auth status')).toBe(false);
        expect(promptReady(ghost('❯\u00a0'), undefined, 'gh auth status')).toBe(true);
    });
});

describe('typedReady', () => {
    const command = 'gh pr create --title "Fix the login check" --body "Closes the stale token bug"';

    it("sees the command typed into Claude's box in bash mode", () => {
        expect(typedReady(typedFrame(), 'gh auth status', TYPED_CURSOR)).toBe(true);
        expect(typedReady(typedFrame(), 'gh auth status')).toBe(true);
        expect(typedReady(typedFrame(['!\u00a0gh auth status   ']), 'gh auth status', { row: 46, col: 16 })).toBe(true);
    });

    it("is false without bash mode's ! glyph, where Enter would send the text to Claude as a prompt", () => {
        expect(typedReady(typedFrame(['❯\u00a0gh auth status']), 'gh auth status', { row: 46, col: 16 })).toBe(false);
        expect(typedReady(typedFrame(['❯\u00a0 gh auth status']), 'gh auth status', TYPED_CURSOR)).toBe(false);
        expect(typedReady(typedFrame(['> ! gh auth status']), 'gh auth status', { row: 46, col: 18 })).toBe(false);
        // A command that itself starts like a glyph, in a box not in bash mode.
        expect(typedReady(typedFrame(['> build.log']), '> build.log', { row: 46, col: 11 })).toBe(false);
    });

    it('is false for a box holding only ghost text, the cursor right after the glyph', () => {
        expect(typedReady(typedFrame(['❯\u00a0! gh auth status']), 'gh auth status', { row: 46, col: 2 })).toBe(false);
        expect(typedReady(typedFrame(), 'gh auth status', { row: 46, col: 2 })).toBe(false);
    });

    it('is false unless the cursor is inside the box', () => {
        expect(typedReady(typedFrame(), 'gh auth status', { row: 45, col: 17 })).toBe(false);
        expect(typedReady(typedFrame(), 'gh auth status', { row: 47, col: 17 })).toBe(false);
        expect(typedReady(typedFrame(), 'gh auth status', { row: 48, col: 17 })).toBe(false);
    });

    it('compares the text exactly, spaces inside quotes included', () => {
        expect(typedReady(typedFrame(['!\u00a0 echo "a b"']), 'echo "a  b"', { row: 46, col: 13 })).toBe(false);
        expect(typedReady(typedFrame(['!\u00a0 echo "a  b"']), 'echo "a  b"', { row: 46, col: 14 })).toBe(true);
    });

    it('joins a command wrapped over several lines of the box, cut at a space or inside a word', () => {
        const atSpace = ['!\u00a0 gh pr create --title "Fix the login check"', '  --body "Closes the stale token bug"'];
        expect(typedReady(typedFrame(atSpace), command, { row: 47, col: 37 })).toBe(true);
        const inWord = ['!\u00a0 gh pr create --title "Fix the lo', '  gin check" --body "Closes the stale token bug"'];
        expect(typedReady(typedFrame(inWord), command, { row: 47, col: 47 })).toBe(true);
    });

    it('is false unless the box holds exactly the command', () => {
        expect(typedReady(typedFrame(['!\u00a0 gh auth status --hostname x']), 'gh auth status', { row: 46, col: 31 })).toBe(false);
        expect(typedReady(typedFrame(['!\u00a0 gh auth']), 'gh auth status', { row: 46, col: 10 })).toBe(false);
        expect(typedReady(typedFrame(['!\u00a0']), 'gh auth status', { row: 46, col: 2 })).toBe(false);
        expect(typedReady(typedFrame(['!\u00a0 ! gh auth status']), 'gh auth status', { row: 46, col: 19 })).toBe(false);
    });

    it('is false with a menu, a picker or a key hint below the box', () => {
        expect(typedReady(typedFrame(undefined, [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No']), 'gh auth status', TYPED_CURSOR)).toBe(false);
        expect(typedReady(PERMISSION, 'rm -rf build')).toBe(false);
        expect(typedReady(picker('!\u00a0 gh auth status'), 'gh auth status', { row: 2, col: 17 })).toBe(false);
        expect(typedReady(typedFrame(undefined, ['  esc to cancel']), 'gh auth status', TYPED_CURSOR)).toBe(false);
    });

    it("is true above each of Claude's status rows", () => {
        for (const footer of FOOTERS) expect(typedReady(typedFrame(undefined, [footer]), 'gh auth status', TYPED_CURSOR)).toBe(true);
    });

    it('is false without two rules at column 0', () => {
        expect(typedReady('!\u00a0 gh auth status', 'gh auth status')).toBe(false);
        expect(typedReady([RULE, '!\u00a0 gh auth status'].join('\n'), 'gh auth status')).toBe(false);
        expect(typedReady(['  ' + RULE, '  !\u00a0 gh auth status', '  ' + RULE].join('\n'), 'gh auth status')).toBe(false);
        expect(typedReady([RULE, RULE].join('\n'), 'gh auth status')).toBe(false);
    });
});

describe('routeSuggested', () => {
    const bang: Suggested = { kind: 'bang', command: 'gh auth login' };
    const idle: SessionState = { status: 'idle', agent: 'claude', sessionID: 'S', lastNotificationType: undefined, screen: READY, cursor: READY_CURSOR };
    const split = (reason: string) => ({ mode: 'split', reason });

    it('types a one-line ! command into an idle Claude session at its empty prompt', () => {
        expect(routeSuggested(bang, idle)).toEqual({ mode: 'session' });
        expect(routeSuggested(bang, { ...idle, status: 'waitingForInput', lastNotificationType: 'idle_prompt' })).toEqual({ mode: 'session' });
    });

    it("types it when Claude's ghost text in the empty box is the suggestion itself", () => {
        const ghosted = { ...idle, status: 'waitingForInput' as const, screen: ghost(), cursor: GHOST_CURSOR };
        expect(routeSuggested({ kind: 'bang', command: 'gh auth status' }, ghosted)).toEqual({ mode: 'session' });
        expect(routeSuggested(bang, ghosted)).toEqual(split("Claude's input box is not empty"));
        expect(routeSuggested({ kind: 'bang', command: 'gh auth status' }, { ...ghosted, cursor: undefined })).toEqual(split("Claude's input box is not empty"));
    });

    it('runs a code block in a new split', () => {
        expect(routeSuggested({ kind: 'fence', command: 'gh auth login' }, idle)).toEqual(split('a code block runs in a new split'));
    });

    it('runs a multi-line or backslash-continued ! command in a new split', () => {
        expect(routeSuggested({ kind: 'bang', command: 'docker run \\' }, idle)).toEqual(split('a multi-line command runs in a new split'));
        expect(routeSuggested({ kind: 'bang', command: 'docker run \\  ' }, idle)).toEqual(split('a multi-line command runs in a new split'));
        expect(routeSuggested({ kind: 'bang', command: 'echo a\necho b' }, idle)).toEqual(split('a multi-line command runs in a new split'));
    });

    it('runs in a new split when the pane has no Claude session', () => {
        expect(routeSuggested(bang, { ...idle, sessionID: undefined })).toEqual(split('the pane has no Claude session'));
        expect(routeSuggested(bang, { ...idle, sessionID: '' })).toEqual(split('the pane has no Claude session'));
        expect(routeSuggested(bang, { ...idle, agent: 'codex' })).toEqual(split('the pane has no Claude session'));
        expect(routeSuggested(bang, { ...idle, agent: undefined })).toEqual(split('the pane has no Claude session'));
    });

    it('runs in a new split while Claude is working', () => {
        expect(routeSuggested(bang, { ...idle, status: 'running' })).toEqual(split('Claude is still working'));
    });

    it('runs in a new split while Claude waits at a permission prompt or a question', () => {
        const asking = { ...idle, status: 'waitingForInput' as const, screen: PERMISSION };
        expect(routeSuggested(bang, { ...asking, lastNotificationType: 'permission_prompt' })).toEqual(split('Claude was last seen at a permission prompt'));
        expect(routeSuggested(bang, { ...asking, lastNotificationType: 'elicitation_dialog' })).toEqual(split('Claude was last seen at a permission prompt'));
        // The notification decides even when the screen still shows the empty box.
        expect(routeSuggested(bang, { ...idle, status: 'waitingForInput', lastNotificationType: 'permission_prompt' })).toEqual(split('Claude was last seen at a permission prompt'));
    });

    it('runs in a new split when the pane reports no status', () => {
        expect(routeSuggested(bang, { ...idle, status: undefined })).toEqual(split('Claude is not waiting for input'));
    });

    it('runs in a new split when the screen shows a menu or a draft instead of the empty box', () => {
        expect(routeSuggested(bang, { ...idle, screen: PERMISSION })).toEqual(split("Claude's input box is not empty"));
        expect(routeSuggested(bang, { ...idle, screen: [RULE, '❯ half a draft', RULE].join('\n'), cursor: { row: 1, col: 14 } })).toEqual(split("Claude's input box is not empty"));
    });
});

describe('real Claude Code 2.1.300 dialogs', () => {
    const bang: Suggested = { kind: 'bang', command: 'gh auth status' };
    const dialogs: [string, string, Cursor][] = [
        ['a permission prompt', REAL_PERMISSION, REAL_PERMISSION_CURSOR],
        ['the /model picker', REAL_MODEL_PICKER, REAL_MODEL_PICKER_CURSOR],
        ['an AskUserQuestion dialog', REAL_QUESTION, REAL_QUESTION_CURSOR],
    ];

    it.each(dialogs)('reads %s as neither an empty box nor a typed command', (_name, text, cursor) => {
        expect(promptReady(text, cursor, 'gh auth status')).toBe(false);
        expect(promptReady(text, undefined, 'gh auth status')).toBe(false);
        expect(typedReady(text, 'gh auth status', cursor)).toBe(false);
    });

    it.each(dialogs)('runs in a new split at %s on the screen alone, with no notification', (_name, text, cursor) => {
        // The same run saw the pane's status read idle while the permission prompt was still up.
        for (const status of ['waitingForInput', 'idle'] as const) {
            expect(routeSuggested(bang, { status, agent: 'claude', sessionID: 's', lastNotificationType: undefined, screen: text, cursor }))
                .toEqual({ mode: 'split', reason: "Claude's input box is not empty" });
        }
    });

    it('sees the empty box once Esc dismissed the prompt, though the stale flag still refuses the session', () => {
        expect(promptReady(REAL_AFTER_ESCAPE, REAL_AFTER_ESCAPE_CURSOR, 'gh auth status')).toBe(true);
        expect(promptReady(REAL_AFTER_ESCAPE, undefined, 'gh auth status')).toBe(true);
        expect(typedReady(REAL_AFTER_ESCAPE, 'gh auth status', REAL_AFTER_ESCAPE_CURSOR)).toBe(false);
        const state: SessionState = {
            status: 'idle', agent: 'claude', sessionID: 's', lastNotificationType: undefined, screen: REAL_AFTER_ESCAPE, cursor: REAL_AFTER_ESCAPE_CURSOR,
        };
        expect(routeSuggested(bang, state)).toEqual({ mode: 'session' });
        // Esc fires no hook, so the prompt's flag stays until Claude's next turn starts or ends.
        expect(routeSuggested(bang, { ...state, lastNotificationType: 'permission_prompt' }))
            .toEqual({ mode: 'split', reason: 'Claude was last seen at a permission prompt' });
    });
});
