/**
 * The verbs `kelpi` dispatches itself (`packages/cli/src/cli.ts`), plus the tokens that act as
 * verbs. Shared with the daemon so a plugin's `contributes.cli` name that would shadow one of them
 * is refused when the plugin is installed, and so the CLI never asks the daemon about a verb it
 * already owns (#391). The CLI's own switch is checked against this list by its tests.
 */
export const BUILTIN_CLI_VERBS: readonly string[] = [
    'document',
    'plugin',
    'event',
    'pane',
    'workspace',
    'group',
    'layout',
    'open',
    'md',
    'diff',
    'graft',
    'web',
    'doctor',
    'daemon',
    'install-hooks',
    'version',
    'help',
];

export function isBuiltinCliVerb(name: string): boolean {
    return BUILTIN_CLI_VERBS.includes(name);
}

/**
 * A plugin `contributes.cli` verb name: one lowercase word, the rule the manifest decoder applies.
 * The CLI screens a word with it before asking the daemon, so a word no plugin could ever declare
 * (empty, a flag, uppercase, spaced, too long) is unknown without a round trip.
 */
export const CLI_VERB_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function isCliVerbName(name: string): boolean {
    return CLI_VERB_NAME_PATTERN.test(name) && name.length <= 32;
}
