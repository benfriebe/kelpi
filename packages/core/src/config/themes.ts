/**
 * The built-in TERMINAL themes (`NexTheme`, settings §SET-215/§SET-105/§SET-216).
 *
 * A `NexTheme` in the Swift app is a pair: the ghostty theme **filename** (which is what a
 * `theme = <id>` line names, and is case-sensitive) plus a display name. Ten ship, and the list
 * is closed — `NexTheme.named(id)` matches a built-in or nothing at all, which is the whole of
 * §SET-216: `theme = Whatever-I-Typed` selects nothing, and the terminal keeps whatever the
 * user's own ghostty config already resolved.
 *
 * It lives in `@nex/core` rather than beside the Settings picker that renders it because the
 * DAEMON needs the same table: §SET-105's `theme` key is read from `~/.config/nex/config`, and
 * the daemon is what turns the two config files into one settings snapshot. Two copies of a
 * case-sensitive filename list is exactly the kind of drift this package exists to prevent.
 */

export interface TerminalTheme {
    /** The ghostty theme filename. Case-sensitive — this is what `theme = …` must say. */
    readonly id: string;
    /** What Settings shows. Differs from the id only for the two Solarized entries. */
    readonly name: string;
}

/** `NexTheme.builtIn`, in the Swift order. */
export const BUILT_IN_TERMINAL_THEMES: readonly TerminalTheme[] = [
    { id: 'Dracula', name: 'Dracula' },
    { id: 'Catppuccin Mocha', name: 'Catppuccin Mocha' },
    { id: 'Catppuccin Latte', name: 'Catppuccin Latte' },
    { id: 'Catppuccin Macchiato', name: 'Catppuccin Macchiato' },
    { id: 'Catppuccin Frappe', name: 'Catppuccin Frappé' },
    { id: 'Nord', name: 'Nord' },
    { id: 'Gruvbox Dark', name: 'Gruvbox Dark' },
    { id: 'Gruvbox Light', name: 'Gruvbox Light' },
    { id: 'iTerm2 Solarized Dark', name: 'Solarized Dark' },
    { id: 'iTerm2 Solarized Light', name: 'Solarized Light' }
];

/**
 * `NexTheme.named(id)` — a built-in, or null.
 *
 * §SET-216: the match is EXACT, including case, because the id is a filename on a
 * case-sensitive theme lookup. `dracula` is not `Dracula`, and neither is a typo: both select
 * nothing rather than the nearest thing, which is what leaves the user's own ghostty theme in
 * place instead of silently repainting their terminal.
 */
export function namedTerminalTheme(id: string | null | undefined): TerminalTheme | null {
    if (id === null || id === undefined) return null;
    const trimmed = id.trim();
    if (trimmed === '') return null;
    return BUILT_IN_TERMINAL_THEMES.find((theme) => theme.id === trimmed) ?? null;
}
