import { describe, expect, it } from 'vitest';

import { cardChoices, parsePrompt } from './prompts';

describe('parsePrompt', () => {
    it('reads Claude Code’s edit prompt as a numbered menu answered by its digits', () => {
        const prompt = parsePrompt(
            [
                '  Edit phone/PhoneShell.tsx',
                '  90 +     <PaneBody pane={pane} />',
                '',
                '  Do you want to make this edit to',
                '  PhoneShell.tsx?',
                '  ❯ 1. Yes',
                '    2. Yes, allow all edits during this session (shift+tab)',
                '    3. No, and tell Claude what to do differently (esc)',
                ''
            ].join('\n')
        );
        expect(prompt?.question).toBe('Edit phone/PhoneShell.tsx\n90 +     <PaneBody pane={pane} />\nDo you want to make this edit to\nPhoneShell.tsx?');
        expect(prompt?.choices).toEqual([
            { label: 'Yes', hint: '1', keys: '1', submit: false },
            { label: 'Yes, allow all edits during this session', hint: '2', keys: '2', submit: false },
            { label: 'No, and tell Claude what to do differently', hint: '3', keys: '3', submit: false }
        ]);
    });

    it('reads a boxed menu, and a choice that wraps onto a second line', () => {
        const prompt = parsePrompt(
            [
                '╭──────────────────────────────────────╮',
                '│ Bash command                         │',
                '│   git push origin mobile-ui          │',
                '│ Do you want to proceed?              │',
                '│ ❯ 1. Yes                             │',
                '│   2. Yes, and don’t ask again for git │',
                '│      push commands in ~/code/kelpi   │',
                '│   3. No (esc)                        │',
                '╰──────────────────────────────────────╯'
            ].join('\n')
        );
        expect(prompt?.question).toBe('Bash command\ngit push origin mobile-ui\nDo you want to proceed?');
        expect(prompt?.choices.map((choice) => choice.keys)).toEqual(['1', '2', '3']);
        expect(prompt?.choices[2]?.label).toBe('No');
    });

    it('answers with the hotkey a menu prints, when it prints one', () => {
        const prompt = parsePrompt(['Allow command?', '› 1. Yes, proceed (y)', '  2. Yes, and don’t ask again (a)', '  3. No (n)'].join('\n'));
        expect(prompt?.choices.map((choice) => [choice.hint, choice.keys, choice.label])).toEqual([
            ['1', 'y', 'Yes, proceed'],
            ['2', 'a', 'Yes, and don’t ask again'],
            ['3', 'n', 'No']
        ]);
    });

    it('never offers a numbered list from the agent’s own reply: a menu marks its selection', () => {
        const prompt = parsePrompt(['I would do this in three steps:', '1. Move the header', '2. Add the bar', '3. Test it', '', '> '].join('\n'));
        expect(prompt?.choices).toEqual([]);
    });

    it('shows WHAT would proceed: the question runs up to the box edge, across blank lines', () => {
        const prompt = parsePrompt(
            [
                '────────────────────────────────────────',
                ' Bash command',
                '',
                '   rm -rf ~/projects/app/build',
                '   Remove the old build output',
                '',
                ' Do you want to proceed?',
                ' ❯ 1. Yes',
                '   2. Yes, and don’t ask again for rm commands in ~/projects/app',
                '   3. No, and tell Claude what to do differently (esc)',
                ''
            ].join('\n')
        );
        expect(prompt?.question).toBe('Bash command\nrm -rf ~/projects/app/build\nRemove the old build output\nDo you want to proceed?');
        expect(prompt?.choices).toHaveLength(3);
    });

    it('never offers lists from the agent’s own reply, its bullets or the person’s echoed input', () => {
        const reply = ['● 1. Rename the helper', '  2. Update the tests', '  3. Ship it', '', '> '].join('\n');
        const echoed = ['> 1. fix the bug', '  2. add a test', '', '● Done.', '', '> '].join('\n');
        const quoted = ['> 1. Install', '> 2. Configure', ''].join('\n');
        for (const screen of [reply, echoed, quoted]) expect(parsePrompt(screen)?.choices).toEqual([]);
    });

    it('never offers a menu that is not the last thing on screen: it has been answered', () => {
        const answered = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', '● Running the build…', '> '].join('\n');
        expect(parsePrompt(answered)?.choices).toEqual([]);
        // Key hints and a box's bottom edge may follow a live one.
        const hinted = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel · Tab to amend'].join('\n');
        expect(parsePrompt(hinted)?.choices).toHaveLength(2);
    });

    it('needs exactly one selection mark and a question', () => {
        expect(parsePrompt(['Do you want to proceed?', '❯ 1. Yes', '❯ 2. No'].join('\n'))?.choices).toEqual([]);
        expect(parsePrompt(['Pick one', '❯ 1. Yes', '  2. No'].join('\n'))?.choices).toEqual([]);
    });

    it('answers by number when the letters in brackets are not every choice’s own hotkey', () => {
        const prompt = parsePrompt(['Which plan?', '❯ 1. Plan (a)', '  2. Plan (a)'].join('\n'));
        expect(prompt?.choices.map((choice) => choice.keys)).toEqual(['1', '2']);
    });

    it('offers a small card only the first and last answers, never the far-reaching ones between', () => {
        const prompt = parsePrompt(['Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don’t ask again', '  3. No (esc)'].join('\n'));
        expect(cardChoices(prompt?.choices ?? []).map((choice) => choice.label)).toEqual(['Yes', 'No']);
    });

    it('reads a [y/N] question as Yes and No, each submitted with Enter', () => {
        const prompt = parsePrompt('Running tests\nRun `pnpm test --filter guest`? [y/N] ');
        expect(prompt).toEqual({
            question: 'Run `pnpm test --filter guest`?',
            choices: [
                { label: 'Yes', hint: 'y', keys: 'y', submit: true },
                { label: 'No', hint: 'n', keys: 'n', submit: true }
            ]
        });
    });

    it('falls back to the last lines, with no choices, for anything else', () => {
        expect(parsePrompt('Done. Anything else?\n\n> \n')).toEqual({ question: 'Done. Anything else?\n>', choices: [] });
        expect(parsePrompt('\n\n')).toBeNull();
    });
});
