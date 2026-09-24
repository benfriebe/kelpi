/**
 * The Help surface (APP-027 / APP-063), as an overlay rather than a window.
 *
 * The Swift app opened a second `WindowGroup` scene (`NexApp.swift:220-224`, a 420×300
 * content-sized panel with the app icon, the version, a link into Settings ▸ Keybindings and a
 * GitHub link). A web client has one document and a daemon-served UI that also runs in a plain
 * browser tab, so the same content lands as a modal overlay in the window it belongs to. Both
 * halves of the Swift panel are here — the version and the two links — plus the thing that panel
 * only *pointed at*: **the keybindings themselves**, read from the live map.
 *
 * "Live" is the point. The rows are built from the same `KeyBindingMap` the dispatcher resolves,
 * which is the daemon's parsed `keybind` lines, so a rebound ⌘D shows its new trigger here, an
 * unbound action shows a dash rather than a shortcut that does nothing, and the list can never
 * drift from what the keyboard actually does. They arrive as the keymap model (`keymap.ts`), the
 * value the chrome snapshot publishes, which adds the primary daemon's plugin commands grouped by
 * plugin, with the shortcut each one really runs on after the user's overrides and collisions.
 *
 * The CLI column exists because half of what this app can do has no key at all: the section is
 * a short, honest pointer at `kelpi --help` and the verbs a GUI user is most likely to want.
 */

import { useEffect, useRef, type ReactElement } from 'react';

import type { ChromeKeymap, ChromeKeymapCommand } from '../plugins/chrome';
import { tokens } from './tokens';

/** APP-063's repository link, unchanged from `HelpView.swift:5`. */
export const HELP_GITHUB_URL = 'https://github.com/benfriebe/nex';

export interface HelpCliEntry {
    readonly command: string;
    readonly description: string;
}

export interface HelpMouseEntry {
    readonly gesture: string;
    readonly description: string;
}

/**
 * The pointer gestures a terminal pane answers, and the one nothing else in the app says out
 * loud (#81).
 *
 * **Shift+drag** is the whole reason this section exists. Once an application turns on mouse
 * reporting, a press inside the pane is sent to that application instead of starting a
 * selection, and any selection already made is cleared (terminal-surface.md section 12.1;
 * ghostty's own rule, `Surface.zig:3850-3852`). Shift is the bypass, and it is ghostty's
 * `mouse-shift-capture = false` default rather than an invention. Without it written down, "I
 * can't copy text out of my agent pane" is unanswerable: dragging in a pane running Claude Code
 * or vim simply does nothing visible, and there is no affordance anywhere that says why.
 */
export const HELP_MOUSE_ENTRIES: readonly HelpMouseEntry[] = [
    { gesture: 'Drag', description: 'select text in a terminal pane' },
    { gesture: 'Double-click', description: 'select the word under the pointer' },
    {
        gesture: 'Shift+drag',
        description: 'select text even while an app owns the mouse (vim, Claude Code, less)'
    },
    { gesture: '⌘-click', description: 'open the path or URL under the pointer' }
];

/**
 * The CLI pointers. Deliberately short: this is a signpost, not `kelpi --help` reproduced in the
 * window, and every line here is a verb a GUI user reaches for and cannot otherwise find.
 */
export const HELP_CLI_ENTRIES: readonly HelpCliEntry[] = [
    { command: 'kelpi --help', description: 'every command, with its flags' },
    { command: 'kelpi doctor', description: 'check the CLI ↔ app connection when commands stop landing' },
    { command: 'kelpi md <file>', description: 'open a markdown preview pane' },
    { command: 'kelpi diff [path]', description: 'open a diff pane for a repo or path' },
    { command: 'kelpi pane split|send|capture', description: 'drive panes from a script or an agent' },
    { command: 'kelpi workspace create --worktree <name>', description: 'a new workspace on a fresh git worktree' }
];

export interface HelpOverlayProps {
    /** The live keyboard map, `buildKeymap`'s whole value rather than the snapshot's bounded one. */
    readonly keymap: ChromeKeymap;
    /** `CFBundleShortVersionString`'s equivalent — the daemon's reported version. */
    readonly version: string;
    readonly onClose: () => void;
    /** Opens Settings ▸ Keybindings (APP-063's "customize" link). */
    readonly onOpenKeybindings?: (() => void) | undefined;
    /** Opens Settings ▸ Plugins, where plugin shortcuts are changed. */
    readonly onOpenPlugins?: (() => void) | undefined;
    /** Electron only: hand the repository URL to the system browser. */
    readonly onOpenLink?: ((url: string) => void) | undefined;
}

/** What runs on a plugin command's shortcut instead of it, in words. */
function shadowNote(shadowed: NonNullable<ChromeKeymapCommand['shadowed']>): string {
    return `${shadowed.shortcut} runs ${shadowed.by}${shadowed.plugin === null ? '' : ` (${shadowed.plugin})`}`;
}

/** What that shortcut runs right now, while the command it belongs to does not apply. */
function currentlyNote(shortcut: string, currently: NonNullable<ChromeKeymapCommand['currently']>): string {
    return `${shortcut} currently runs ${currently.by} (${currently.plugin})`;
}

export function HelpOverlay(props: HelpOverlayProps): ReactElement {
    const closeRef = useRef<HTMLButtonElement | null>(null);

    // A modal that does not take the keyboard leaves the next keystroke going to a pane behind
    // it; focusing the close button also makes Escape and Tab behave the way a dialog should.
    useEffect(() => {
        closeRef.current?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [props]);

    return (
        <div
            data-testid="help-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Kelpi Help"
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            style={{ background: 'rgba(0, 0, 0, 0.45)' }}
            onClick={(event) => {
                if (event.target === event.currentTarget) props.onClose();
            }}
        >
            <div
                className="flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-xl"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    boxShadow: '0 24px 64px rgba(0,0,0,0.45)'
                }}
            >
                <header
                    className="flex shrink-0 items-center gap-3 px-5 py-4"
                    style={{ borderBottom: `1px solid ${tokens.divider}` }}
                >
                    <span
                        aria-hidden
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-[15px] font-semibold"
                        style={{ background: tokens.accent, color: '#0B0B0F' }}
                    >
                        kelpi
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-semibold">Kelpi</div>
                        <div data-testid="help-version" className="text-[12px]" style={{ color: tokens.textTertiary }}>
                            Version {props.version}
                        </div>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        data-testid="help-close"
                        aria-label="Close help"
                        className="rounded px-2 py-1 text-[12px]"
                        style={{ color: tokens.textSecondary, border: `1px solid ${tokens.divider}` }}
                        onClick={props.onClose}
                    >
                        Close
                    </button>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                    <section data-testid="help-keybindings">
                        <div className="mb-2 flex items-baseline gap-3">
                            <h2 className="text-[13px] font-semibold">Keyboard Shortcuts</h2>
                            {props.onOpenKeybindings === undefined ? null : (
                                <button
                                    type="button"
                                    data-testid="help-open-keybindings"
                                    className="text-[12px] underline"
                                    style={{ color: tokens.accent }}
                                    onClick={props.onOpenKeybindings}
                                >
                                    Settings ▸ Keybindings
                                </button>
                            )}
                        </div>
                        {props.keymap.sections.map((section) => (
                            <div key={section.category} className="mb-3" data-help-category={section.category}>
                                <div
                                    className="mb-1 text-[11px] font-semibold tracking-wide uppercase"
                                    style={{ color: tokens.textTertiary }}
                                >
                                    {section.category}
                                </div>
                                <div className="flex flex-col">
                                    {section.actions.map((row) => (
                                        <div
                                            key={row.action}
                                            data-help-action={row.action}
                                            className="flex items-baseline justify-between gap-4 py-[3px] text-[12px]"
                                        >
                                            <span style={{ color: tokens.textSecondary }}>{row.title}</span>
                                            <span
                                                data-help-shortcut={row.shortcut ?? ''}
                                                className="shrink-0 font-mono text-[11px]"
                                                style={{
                                                    color: row.shortcut === null ? tokens.textTertiary : tokens.textPrimary
                                                }}
                                            >
                                                {row.shortcut ?? '-'}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </section>

                    {props.keymap.plugins.length === 0 ? null : (
                        <section data-testid="help-plugins" className="mt-4">
                            <div className="mb-2 flex items-baseline gap-3">
                                <h2 className="text-[13px] font-semibold">Plugin Commands</h2>
                                {props.onOpenPlugins === undefined ? null : (
                                    <button
                                        type="button"
                                        data-testid="help-open-plugins"
                                        className="text-[12px] underline"
                                        style={{ color: tokens.accent }}
                                        onClick={props.onOpenPlugins}
                                    >
                                        Settings ▸ Plugins
                                    </button>
                                )}
                            </div>
                            {props.keymap.plugins.map((plugin, index) => (
                                // Two plugins may share a display name, so the key is positional.
                                <div key={index} className="mb-3" data-help-plugin={plugin.name}>
                                    <div
                                        className="mb-1 text-[11px] font-semibold tracking-wide break-words uppercase"
                                        style={{ color: tokens.textTertiary }}
                                    >
                                        {plugin.name}
                                    </div>
                                    <div className="flex flex-col">
                                        {plugin.commands.map((row) => (
                                            <div
                                                key={row.id}
                                                data-help-command={row.id}
                                                className="flex items-baseline justify-between gap-4 py-[3px] text-[12px]"
                                            >
                                                <span className="flex min-w-0 flex-col">
                                                    <span className="break-words" style={{ color: tokens.textSecondary }}>
                                                        {row.title}
                                                    </span>
                                                    {row.shadowed === null ? null : (
                                                        <span
                                                            data-help-shadowed-by={row.shadowed.by}
                                                            className="text-[11px] break-words"
                                                            style={{ color: tokens.textTertiary }}
                                                        >
                                                            {shadowNote(row.shadowed)}
                                                        </span>
                                                    )}
                                                    {row.currently === null || row.shortcut === null ? null : (
                                                        <span
                                                            data-help-currently-by={row.currently.by}
                                                            className="text-[11px] break-words"
                                                            style={{ color: tokens.textTertiary }}
                                                        >
                                                            {currentlyNote(row.shortcut, row.currently)}
                                                        </span>
                                                    )}
                                                </span>
                                                <span
                                                    data-help-shortcut={row.shortcut ?? ''}
                                                    className="shrink-0 font-mono text-[11px]"
                                                    style={{
                                                        color: row.shortcut === null ? tokens.textTertiary : tokens.textPrimary,
                                                        textDecoration: row.shadowed === null ? undefined : 'line-through'
                                                    }}
                                                >
                                                    {row.shortcut ?? row.shadowed?.shortcut ?? '-'}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </section>
                    )}

                    <section data-testid="help-mouse" className="mt-4">
                        <h2 className="mb-2 text-[13px] font-semibold">Mouse</h2>
                        <div className="flex flex-col">
                            {HELP_MOUSE_ENTRIES.map((entry) => (
                                <div
                                    key={entry.gesture}
                                    data-help-gesture={entry.gesture}
                                    className="flex items-baseline justify-between gap-4 py-[3px] text-[12px]"
                                >
                                    <span style={{ color: tokens.textSecondary }}>{entry.description}</span>
                                    <span
                                        className="shrink-0 font-mono text-[11px]"
                                        style={{ color: tokens.textPrimary }}
                                    >
                                        {entry.gesture}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section data-testid="help-cli" className="mt-4">
                        <h2 className="mb-2 text-[13px] font-semibold">Command Line</h2>
                        <div className="flex flex-col">
                            {HELP_CLI_ENTRIES.map((entry) => (
                                <div
                                    key={entry.command}
                                    className="flex items-baseline justify-between gap-4 py-[3px] text-[12px]"
                                >
                                    <span className="font-mono text-[11px]" style={{ color: tokens.textPrimary }}>
                                        {entry.command}
                                    </span>
                                    <span
                                        className="shrink-0 text-right"
                                        style={{ color: tokens.textTertiary }}
                                    >
                                        {entry.description}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                <footer
                    className="flex shrink-0 items-center justify-between px-5 py-3 text-[12px]"
                    style={{ borderTop: `1px solid ${tokens.divider}` }}
                >
                    <a
                        data-testid="help-github"
                        href={HELP_GITHUB_URL}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: tokens.accent }}
                        onClick={(event) => {
                            if (props.onOpenLink === undefined) return;
                            // The shell hands http(s) links to the system browser; letting the
                            // anchor navigate would replace the app in its own window.
                            event.preventDefault();
                            props.onOpenLink(HELP_GITHUB_URL);
                        }}
                    >
                        GitHub Repository
                    </a>
                    <span style={{ color: tokens.textTertiary }}>Press Escape to close</span>
                </footer>
            </div>
        </div>
    );
}
