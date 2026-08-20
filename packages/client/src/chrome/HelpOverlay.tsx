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
 * which is the daemon's parsed `keybind` lines — so a rebound ⌘D shows its new trigger here, an
 * unbound action shows an em dash rather than a shortcut that does nothing, and the list can
 * never drift from what the keyboard actually does.
 *
 * The CLI column exists because half of what this app can do has no key at all: the section is
 * a short, honest pointer at `nex --help` and the verbs a GUI user is most likely to want.
 */

import type { KeyBindingMap, NexAction } from '@nex/core/config';
import { useEffect, useRef, type ReactElement } from 'react';

import { ACTION_CATALOG, VISIBLE_CATEGORIES, type SettingsCategory } from '../settings/catalog';
import { shortcutForAction } from './keys';
import { tokens } from './tokens';

/** APP-063's repository link, unchanged from `HelpView.swift:5`. */
export const HELP_GITHUB_URL = 'https://github.com/benfriebe/nex';

export interface HelpCliEntry {
    readonly command: string;
    readonly description: string;
}

/**
 * The CLI pointers. Deliberately short: this is a signpost, not `nex --help` reproduced in the
 * window, and every line here is a verb a GUI user reaches for and cannot otherwise find.
 */
export const HELP_CLI_ENTRIES: readonly HelpCliEntry[] = [
    { command: 'nex --help', description: 'every command, with its flags' },
    { command: 'nex doctor', description: 'check the CLI ↔ app connection when commands stop landing' },
    { command: 'nex md <file>', description: 'open a markdown preview pane' },
    { command: 'nex diff [path]', description: 'open a diff pane for a repo or path' },
    { command: 'nex pane split|send|capture', description: 'drive panes from a script or an agent' },
    { command: 'nex workspace create --worktree <name>', description: 'a new workspace on a fresh git worktree' }
];

export interface HelpOverlayProps {
    readonly bindings: KeyBindingMap;
    /** `CFBundleShortVersionString`'s equivalent — the daemon's reported version. */
    readonly version: string;
    readonly onClose: () => void;
    /** Opens Settings ▸ Keybindings (APP-063's "customize" link). */
    readonly onOpenKeybindings?: (() => void) | undefined;
    /** Electron only: hand the repository URL to the system browser. */
    readonly onOpenLink?: ((url: string) => void) | undefined;
}

interface Row {
    readonly action: NexAction;
    readonly label: string;
    readonly shortcut: string | undefined;
}

function rowsFor(category: SettingsCategory, bindings: KeyBindingMap): Row[] {
    return ACTION_CATALOG.filter((entry) => entry.category === category).map((entry) => ({
        action: entry.action,
        label: entry.label,
        shortcut: shortcutForAction(bindings, entry.action)
    }));
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
            aria-label="Nex Help"
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
                        nex
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-semibold">Nex</div>
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
                        {VISIBLE_CATEGORIES.map((category) => {
                            const rows = rowsFor(category, props.bindings);
                            if (rows.length === 0) return null;
                            return (
                                <div key={category} className="mb-3" data-help-category={category}>
                                    <div
                                        className="mb-1 text-[11px] font-semibold tracking-wide uppercase"
                                        style={{ color: tokens.textTertiary }}
                                    >
                                        {category}
                                    </div>
                                    <div className="flex flex-col">
                                        {rows.map((row) => (
                                            <div
                                                key={row.action}
                                                data-help-action={row.action}
                                                className="flex items-baseline justify-between gap-4 py-[3px] text-[12px]"
                                            >
                                                <span style={{ color: tokens.textSecondary }}>{row.label}</span>
                                                <span
                                                    data-help-shortcut={row.shortcut ?? ''}
                                                    className="shrink-0 font-mono text-[11px]"
                                                    style={{
                                                        color:
                                                            row.shortcut === undefined
                                                                ? tokens.textTertiary
                                                                : tokens.textPrimary
                                                    }}
                                                >
                                                    {row.shortcut ?? '—'}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
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
