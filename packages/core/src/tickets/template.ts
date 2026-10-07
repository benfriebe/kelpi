/**
 * The agent prompt a ticket starts with (docs/integrations.md "The prompt").
 *
 * The daemon renders it, never the client: `ticket-resolve` returns the rendered text for the New
 * Workspace sheet to show and edit, and a CLI create (`--from`) renders the same text itself, so
 * there is one renderer and one set of templates.
 *
 * `renderTemplate` is deliberately small: `{{name}}` placeholders, filled in ONE pass over the
 * template, so a value is never expanded again (a title of `{{url}}` stays that text), and a name
 * with no value renders empty and is reported rather than failing (a user template, later, may
 * name something a provider does not have). Names are looked up as own properties only, so
 * `{{constructor}}` is an unknown name, not a function's source.
 *
 * The default templates are one line each, start with a word (never `/`, which Claude Code reads
 * as a slash command), and put the ticket file mention in the middle with a space after it: Codex
 * opens a file picker on a trailing `@path`, and Claude Code would take a comma straight after the
 * path as part of it. There are two of each:
 *
 *   - `ticket-file`: `Read @.kelpi/ticket-418.md first, …`, the file Kelpi wrote into the checkout;
 *   - `url-only`: the ticket's URL alone, used whenever Kelpi did NOT write the file (it could not,
 *     or the checkout tracks `.kelpi`, so whatever is there came from the pull request's author).
 *     An agent is never pointed at a file Kelpi did not write (`withoutTicketFileReference`).
 *
 * There is no `body` variable: a ticket's body goes into the ticket file, where it is marked as
 * untrusted content, and never into the prompt itself. Every variable is one cleaned line
 * (`untrustedLine`), and every one that comes from the ticket's author has its `@` neutralized
 * (`neutralizeMentions`), so `Fix @~/.aws/credentials` cannot attach the user's credentials.
 */

import type { TicketKind, TicketPromptVariant } from '@kelpi/protocol';

import { TICKET_TITLE_MAX_LENGTH } from './names.js';
import { ticketFilePath } from './ticket-file.js';
import { neutralizeMentions, untrustedLine } from './text.js';

export interface RenderedTemplate {
    readonly text: string;
    /** Placeholder names that had no value, each once, in order of first use. */
    readonly unknown: readonly string[];
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Fill `{{name}}` placeholders from `vars` in one pass (module note). */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): RenderedTemplate {
    const unknown: string[] = [];
    const text = template.replace(PLACEHOLDER, (_match, name: string) => {
        if (Object.hasOwn(vars, name)) return vars[name] ?? '';
        if (!unknown.includes(name)) unknown.push(name);
        return '';
    });
    return { text, unknown };
}

/** Every variable a ticket prompt template may name. No `body` (module note). */
export const TICKET_PROMPT_VARIABLES = [
    'key',
    'number',
    'kind',
    'title',
    'url',
    'branch',
    'base',
    'repo',
    'author',
    'labels',
    'ticketFile'
] as const;
export type TicketPromptVariable = (typeof TICKET_PROMPT_VARIABLES)[number];
export type TicketPromptVars = Readonly<Record<TicketPromptVariable, string>>;

/** The default prompts, by kind and variant (module note). */
export const DEFAULT_TICKET_PROMPT_TEMPLATES: Readonly<Record<TicketKind, Readonly<Record<TicketPromptVariant, string>>>> = {
    issue: {
        'ticket-file': 'Work on issue {{key}}: {{title}} ({{url}}). Read @{{ticketFile}} first, it has the full issue.',
        'url-only': 'Work on issue {{key}}: {{title}} ({{url}}). Read the full issue at that URL first.'
    },
    pr: {
        'ticket-file':
            'Pick up pull request {{key}}: {{title}} ({{url}}) on branch {{branch}}. Read @{{ticketFile}} first, it has the description and recent review comments.',
        'url-only':
            'Pick up pull request {{key}}: {{title}} ({{url}}) on branch {{branch}}. Read the description and review comments at that URL first.'
    }
};

/** A branch or base name is cut to this in a prompt. */
const PROMPT_BRANCH_MAX_LENGTH = 100;
/** A login is cut to this. */
const PROMPT_AUTHOR_MAX_LENGTH = 60;
/** All the labels together are cut to this. */
const PROMPT_LABELS_MAX_LENGTH = 200;
/** A URL longer than this is not a ticket's page; the variable is left empty instead. */
const PROMPT_URL_MAX_LENGTH = 300;

export interface TicketPromptInput {
    readonly kind: TicketKind;
    readonly number: number;
    /** `#418`. */
    readonly key: string;
    readonly title: string;
    /** The ticket's page. Only an `https://` URL with no whitespace and no `@` is used. */
    readonly url: string;
    /** `owner/name`. */
    readonly repo: string;
    /** The local branch the workspace works on. */
    readonly branch: string | null;
    /** A pull request's base branch. */
    readonly base: string | null;
    readonly author: string | null;
    readonly labels: readonly string[];
}

/** One untrusted line for a prompt: cleaned, capped, `@` neutralized. */
function promptLine(text: string | null, maxLength: number): string {
    return text === null ? '' : neutralizeMentions(untrustedLine(text, maxLength));
}

/** The variables every ticket prompt is rendered with, each made safe for a one-line prompt. */
export function ticketPromptVars(input: TicketPromptInput): TicketPromptVars {
    const url = input.url.trim();
    return {
        key: promptLine(input.key, 40),
        number: String(input.number),
        kind: input.kind === 'pr' ? 'pull request' : 'issue',
        title: promptLine(input.title, TICKET_TITLE_MAX_LENGTH),
        url: /^https:\/\/[^\s@]+$/.test(url) && url.length <= PROMPT_URL_MAX_LENGTH ? url : '',
        branch: promptLine(input.branch, PROMPT_BRANCH_MAX_LENGTH),
        base: promptLine(input.base, PROMPT_BRANCH_MAX_LENGTH),
        repo: promptLine(input.repo, 141),
        author: promptLine(input.author, PROMPT_AUTHOR_MAX_LENGTH),
        labels: promptLine(input.labels.join(', '), PROMPT_LABELS_MAX_LENGTH),
        ticketFile: ticketFilePath(input.number)
    };
}

/** The default prompt for a ticket, in one variant. */
export function renderTicketPrompt(kind: TicketKind, vars: TicketPromptVars, variant: TicketPromptVariant): string {
    return renderTemplate(DEFAULT_TICKET_PROMPT_TEMPLATES[kind][variant], vars).text;
}

/**
 * A prompt with every reference to the ticket file taken out, for a create where Kelpi did not
 * write that file (`ticket_file_error`). The unedited default becomes the `url-only` default; any
 * other text (the user edited it in the sheet) has each `@<ticket file>` mention, and then each
 * bare mention of the path, replaced by the ticket's URL. Pass the prompt as normalized
 * (`normalizeAgentPrompt`): the comparison with the default is exact.
 */
export function withoutTicketFileReference(prompt: string, kind: TicketKind, vars: TicketPromptVars): string {
    if (prompt === renderTicketPrompt(kind, vars, 'ticket-file')) return renderTicketPrompt(kind, vars, 'url-only');
    return prompt.split(`@${vars.ticketFile}`).join(vars.url).split(vars.ticketFile).join(vars.url);
}
