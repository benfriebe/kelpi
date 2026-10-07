import { describe, expect, it } from 'vitest';

import { TICKET_PROMPT_VARIANTS, TICKET_KINDS } from '@kelpi/protocol';

import {
    DEFAULT_TICKET_PROMPT_TEMPLATES,
    TICKET_PROMPT_VARIABLES,
    renderTemplate,
    renderTicketPrompt,
    ticketPromptVars,
    withoutTicketFileReference,
    type TicketPromptInput
} from './template.js';

describe('renderTemplate', () => {
    it('fills placeholders, with or without spaces inside the braces', () => {
        expect(renderTemplate('Hi {{name}}, {{ name }}!', { name: 'Ben' })).toEqual({ text: 'Hi Ben, Ben!', unknown: [] });
    });

    it('renders an unknown name empty and reports it once, in order', () => {
        expect(renderTemplate('{{a}}-{{b}}-{{a}}-{{c}}', { c: 'C' })).toEqual({ text: '---C', unknown: ['a', 'b'] });
    });

    it('never expands a value again, so a title cannot pull in another variable', () => {
        expect(renderTemplate('{{title}} / {{url}}', { title: '{{url}}', url: 'https://x' }).text).toBe('{{url}} / https://x');
    });

    it('only reads own properties: an object method is an unknown name', () => {
        expect(renderTemplate('[{{constructor}}][{{toString}}][{{__proto__}}]', {})).toEqual({
            text: '[][][{{__proto__}}]',
            unknown: ['constructor', 'toString']
        });
    });

    it('leaves text that is not a placeholder alone', () => {
        expect(renderTemplate('{{ }} {{1x}} {x} {{x', { x: 'X' }).text).toBe('{{ }} {{1x}} {x} {{x');
    });
});

const INPUT: TicketPromptInput = {
    kind: 'issue',
    number: 418,
    key: '#418',
    title: 'Retry login on 401',
    url: 'https://github.com/acme/api/issues/418',
    repo: 'acme/api',
    branch: '418-retry-login-on-401',
    base: null,
    author: 'octocat',
    labels: ['bug', 'auth']
};

describe('ticketPromptVars', () => {
    it('names every variable, and no body', () => {
        const vars = ticketPromptVars(INPUT);
        expect(Object.keys(vars).sort()).toEqual([...TICKET_PROMPT_VARIABLES].sort());
        expect(TICKET_PROMPT_VARIABLES).not.toContain('body');
        expect(vars).toMatchObject({ number: '418', kind: 'issue', ticketFile: '.kelpi/ticket-418.md', labels: 'bug, auth' });
        expect(ticketPromptVars({ ...INPUT, kind: 'pr' }).kind).toBe('pull request');
    });

    it('neutralizes @ in everything the ticket author wrote', () => {
        const vars = ticketPromptVars({ ...INPUT, title: 'Fix @~/.aws/credentials', branch: 'user@fix', author: '@x', labels: ['@l'] });
        expect(vars.title).toBe('Fix ＠~/.aws/credentials');
        for (const key of ['title', 'branch', 'author', 'labels'] as const) expect(vars[key]).not.toContain('@');
        const prompt = renderTicketPrompt('issue', vars, 'ticket-file');
        // The only mention left is Kelpi's own file.
        expect(prompt.match(/@/g)).toHaveLength(1);
        expect(prompt).toContain('@.kelpi/ticket-418.md ');
    });

    it('cleans titles to one line and refuses a URL that could carry a mention or a space', () => {
        expect(ticketPromptVars({ ...INPUT, title: 'a\nb\u202ec' }).title).toBe('a bc');
        expect(ticketPromptVars({ ...INPUT, url: 'https://evil@github.com/x' }).url).toBe('');
        expect(ticketPromptVars({ ...INPUT, url: 'https://github.com/x y' }).url).toBe('');
        expect(ticketPromptVars({ ...INPUT, url: 'javascript:alert(1)' }).url).toBe('');
    });
});

describe('the default prompts', () => {
    it('read as the plan says', () => {
        expect(renderTicketPrompt('issue', ticketPromptVars(INPUT), 'ticket-file')).toBe(
            'Work on issue #418: Retry login on 401 (https://github.com/acme/api/issues/418). Read @.kelpi/ticket-418.md first, it has the full issue.'
        );
        const pr = ticketPromptVars({ ...INPUT, kind: 'pr', url: 'https://github.com/acme/api/pull/418', branch: 'fix/login', base: 'main' });
        expect(renderTicketPrompt('pr', pr, 'ticket-file')).toBe(
            'Pick up pull request #418: Retry login on 401 (https://github.com/acme/api/pull/418) on branch fix/login. Read @.kelpi/ticket-418.md first, it has the description and recent review comments.'
        );
        expect(renderTicketPrompt('pr', pr, 'url-only')).not.toContain('.kelpi');
    });

    it('hold the invariants at the longest inputs: one line, under 800, no leading /, no trailing @path, mention + space', () => {
        const longest: TicketPromptInput = {
            kind: 'pr',
            number: 2_147_483_647,
            key: '#2147483647',
            title: `/${'🚀'.repeat(400)}\n@x`,
            url: `https://github.com/${'o'.repeat(39)}/${'r'.repeat(100)}/pull/2147483647`,
            repo: `${'o'.repeat(39)}/${'r'.repeat(100)}`,
            branch: `@${'b'.repeat(300)}`,
            base: 'm'.repeat(300),
            author: 'a'.repeat(39),
            labels: Array.from({ length: 100 }, (_, index) => `label-${index}`)
        };
        for (const kind of TICKET_KINDS) {
            for (const variant of TICKET_PROMPT_VARIANTS) {
                const prompt = renderTicketPrompt(kind, ticketPromptVars({ ...longest, kind }), variant);
                expect(prompt, `${kind}/${variant}`).not.toMatch(/[\r\n]/);
                expect(prompt.length, `${kind}/${variant}`).toBeLessThan(800);
                expect(prompt.startsWith('/')).toBe(false);
                expect(prompt).toMatch(/^[A-Z]/);
                expect(prompt).not.toMatch(/@\S+$/);
                for (const mention of prompt.matchAll(/@(\S+)/g)) {
                    expect(mention[1]).toBe('.kelpi/ticket-2147483647.md');
                    expect(prompt[(mention.index ?? 0) + mention[0].length]).toBe(' ');
                }
            }
        }
        for (const kind of TICKET_KINDS) {
            expect(DEFAULT_TICKET_PROMPT_TEMPLATES[kind]['ticket-file']).toContain('@{{ticketFile}} ');
            expect(DEFAULT_TICKET_PROMPT_TEMPLATES[kind]['url-only']).not.toContain('ticketFile');
            expect(DEFAULT_TICKET_PROMPT_TEMPLATES[kind]['ticket-file']).not.toContain('{{body}}');
        }
    });
});

describe('withoutTicketFileReference (integrations.md §7)', () => {
    const vars = ticketPromptVars(INPUT);

    it('turns the unedited default into the url-only default', () => {
        const prompt = renderTicketPrompt('issue', vars, 'ticket-file');
        expect(withoutTicketFileReference(prompt, 'issue', vars)).toBe(renderTicketPrompt('issue', vars, 'url-only'));
    });

    it('replaces every mention of the file in an edited prompt with the URL', () => {
        const edited = 'Read @.kelpi/ticket-418.md and also .kelpi/ticket-418.md, then fix it.';
        const result = withoutTicketFileReference(edited, 'issue', vars);
        expect(result).toBe('Read https://github.com/acme/api/issues/418 and also https://github.com/acme/api/issues/418, then fix it.');
        expect(result).not.toContain('.kelpi');
        expect(withoutTicketFileReference('Just fix it.', 'issue', vars)).toBe('Just fix it.');
    });
});
