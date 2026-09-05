/**
 * Settings ▸ Appearance (SET-023…SET-046).
 *
 * This tab was read-only through M8 for a reason that has now been fixed rather than argued
 * with: the daemon parsed `~/.config/ghostty/config` and never wrote it, and the chrome
 * styling had no daemon-side home at all. Both halves are now writable, and the split between
 * them is the organising idea of the whole tab:
 *
 *   - **kelpi-owned** — the chrome palette, the sidebar tint knobs and the status-bar gauges are
 *     `key = value` lines in `~/.config/kelpi/config`, written with `set-general-setting`
 *     (`@kelpi/protocol` `WsChromeSettings` documents each key). They are ours, so they live in
 *     our file.
 *   - **ghostty-owned** — background, opacity, font and terminal theme belong to ghostty's
 *     config, written with `set-ghostty-setting`, which touches only the seven keys the daemon
 *     can read back and preserves every other line of a user's file byte-for-byte.
 *
 * Nothing here holds a copy of the settings. Every control renders from the daemon snapshot
 * and every gesture is a verb whose result arrives as a `settings-changed` broadcast — so a
 * hand-edit, a second window and this tab cannot disagree, and the picker you just dragged
 * settles on whatever the file actually says.
 */

import { BUILT_IN_TERMINAL_THEMES } from '@kelpi/core/config';
import { DEFAULT_WS_CHROME_SETTINGS, type WsSettingsSnapshot } from '@kelpi/protocol';
import { useRef, useState, type ChangeEvent, type ReactElement } from 'react';

import {
    BUILT_IN_CHROME_THEMES,
    ChromeIcon,
    ChromeThemeError,
    INVALID_THEME_MESSAGE,
    OVERRIDABLE_CHROME_KEYS,
    SYSTEM_STAT_KINDS,
    SYSTEM_STAT_META,
    builtInStyleTheme,
    chromeThemeFileJson,
    chromeThemeShareCode,
    decodeChromeStyleTheme,
    normalizeHexColor,
    parseChromeThemeCode,
    presetChromeTheme,
    tokens,
    withAlpha,
    type BuiltInChromeTheme,
    type ChromeBucket,
    type ChromeStyleTheme,
    type OverridableChromeKey
} from '../chrome';
import { TERMINAL_EDGE_PADDING, TERMINAL_EDGE_PADDING_TOP } from '../terminal';
import { ColorField, SegmentedField, SelectField, SliderField, TextField } from './controls';
import type { SettingsActions, SettingsPaths } from './types';
import {
    KeyChip,
    SettingsButton,
    SettingsFooterNote,
    SettingsRow,
    SettingsSection,
    SettingsToggle,
    hoverBackground,
    useHover
} from './ui';

export interface AppearanceTabProps {
    readonly settings: WsSettingsSnapshot;
    readonly paths: SettingsPaths;
    readonly actions: SettingsActions;
    /** Which override bucket the colour pickers edit — the scheme currently resolved. */
    readonly bucket?: ChromeBucket | undefined;
}

/** `ChromeColorKey.displayName`, verbatim. */
const COLOR_KEY_LABEL: Readonly<Record<OverridableChromeKey, string>> = {
    windowBackground: 'Window gaps',
    sidebarBackground: 'Sidebar',
    footerBackground: 'Status bar / footer',
    headerBackground: 'Pane header / title bar',
    surfaceBackground: 'Surface (Settings, sheets, palette)',
    accent: 'Sidebar highlight',
    paneFocus: 'Pane focus',
    divider: 'Dividers / borders',
    statusRunning: 'Running',
    statusWaiting: 'Awaiting input',
    statusInactive: 'Inactive'
};

/** `ChromeColorKey.isAgentStatus` — the three that get their own section. */
const AGENT_STATUS_KEYS: readonly OverridableChromeKey[] = ['statusRunning', 'statusWaiting', 'statusInactive'];

function isAgentStatusKey(key: OverridableChromeKey): boolean {
    return AGENT_STATUS_KEYS.includes(key);
}

/**
 * `KelpiTheme.builtIn` — the ten terminal themes, by their ghostty theme id (which IS the
 * `theme = <id>` value; the ids are case-sensitive filenames).
 *
 * Re-exported from `@kelpi/core/config` rather than declared here: §SET-105's `theme` key is read
 * by the DAEMON (it decides which theme the settings snapshot reports), so the table has to be
 * one table. The export name is kept so every existing importer is unchanged.
 */
export { BUILT_IN_TERMINAL_THEMES };

function percentLabel(value: number): string {
    return `${String(Math.round(value * 100))}%`;
}

/**
 * A compact mock of the chrome — sidebar strip, header bar, three agent dots — painted in a
 * preset's palette, so the gallery previews how a theme looks before it is applied
 * (`ThemeSwatch`).
 */
function ThemeSwatch(props: { readonly preset: BuiltInChromeTheme }): ReactElement {
    const palette = props.preset.palette;
    const hex = (value: string): string => `#${value}`;
    return (
        <div
            aria-hidden
            className="flex h-[46px] overflow-hidden rounded-md"
            style={{ background: hex(palette.windowBackground), border: `1px solid ${hex(palette.divider)}` }}
        >
            <div
                className="flex w-[38px] shrink-0 flex-col gap-1 p-1.5"
                style={{ background: hex(palette.sidebarBackground) }}
            >
                <span className="h-1 w-[18px] rounded-full" style={{ background: hex(palette.accent) }} />
                <span className="h-[3px] w-[13px] rounded-full" style={{ background: hex(palette.divider) }} />
                <span className="h-[3px] w-[15px] rounded-full" style={{ background: hex(palette.divider) }} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col" style={{ background: hex(palette.surfaceBackground) }}>
                <div className="h-[10px] w-full shrink-0" style={{ background: hex(palette.headerBackground) }} />
                <div className="flex items-center gap-1 px-1.5 pt-1.5">
                    <span className="h-[5px] w-[5px] rounded-full" style={{ background: hex(palette.statusRunning) }} />
                    <span className="h-[5px] w-[5px] rounded-full" style={{ background: hex(palette.statusWaiting) }} />
                    <span className="h-[5px] w-[5px] rounded-full" style={{ background: hex(palette.statusInactive) }} />
                </div>
            </div>
        </div>
    );
}

/**
 * One cell in the preset gallery: the swatch mock, the theme's name, and — H11 — a response to
 * the pointer.
 *
 * `SettingsView.swift:556-569`'s cells are `Button`s, so AppKit lit them; these were seven
 * static images in a grid with no hover, no cursor and no press, which is why the gallery read
 * as decoration rather than as seven things you can click. The hover fill sits UNDER the swatch
 * (a padded, rounded box) rather than on it, because the swatch's whole job is to show the
 * preset's own colours untinted.
 */
function ThemePresetCell(props: {
    readonly preset: BuiltInChromeTheme;
    readonly onApply: () => void;
}): ReactElement {
    const { hovered, hoverProps } = useHover();
    return (
        <button
            type="button"
            data-testid={`theme-preset-${props.preset.name.toLowerCase().replace(/\s+/g, '-')}`}
            title={`Apply the ${props.preset.name} theme (${
                props.preset.appearance === 'dark' ? 'Dark' : 'Light'
            })`}
            // L84: `VStack(spacing: 5)` and the name in `.primary` (`SettingsView.swift:559-566`).
            // The port had a 4 px gap and `textSecondary`, which — with the cell also being inert
            // before H11 — is what made the gallery read as seven captioned images rather than as
            // seven buttons. No `cursor` either (L89): macOS shows the arrow over a control.
            className="flex flex-col gap-[5px] rounded p-1 text-left transition-colors duration-100"
            style={{ background: hoverBackground(hovered, 'transparent') }}
            {...hoverProps}
            onClick={props.onApply}
        >
            <ThemeSwatch preset={props.preset} />
            <span className="truncate text-[11px]" style={{ color: tokens.textPrimary }}>
                {props.preset.name}
            </span>
        </button>
    );
}

/**
 * §APP-014 — the terminal theme's RESOLUTION, said out loud.
 *
 * The Swift app never needed this row: libghostty owned the lookup, and a name it could not
 * find simply left the palette alone. Here the daemon does the lookup, which means it can also
 * report what happened — and the report is the difference between "I picked Dracula and
 * nothing changed" and "Dracula is not installed on this machine".
 *
 * Three states, and only two of them draw:
 *
 *   - **resolved** — the palette came from a file: a strip of the colours it defines and the
 *     path they came from, so the answer is checkable rather than asserted.
 *   - **unresolved** — the name is set and produced no palette: the daemon's sentence, in the
 *     advisory tone this tab uses elsewhere. The terminal keeps the preset it had, which is
 *     the pre-§APP-014 behaviour — the note is what stops that being silent.
 *   - **nothing configured** — nothing to say.
 */
export const THEME_NOTE_WARNING_COLOR = '#D08A28';

/** The order a swatch strip reads in: document colours first, then the ANSI eight. */
const SWATCH_KEYS = [
    'background',
    'foreground',
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white'
] as const;

export function TerminalThemeNote(props: {
    readonly resolution: WsSettingsSnapshot['appearance']['terminalTheme'];
}): ReactElement | null {
    const { resolution } = props;
    if (resolution.error !== null) {
        return (
            <span
                data-testid="terminal-theme-error"
                role="status"
                className="rounded px-2 py-1 text-[11px]"
                style={{
                    color: THEME_NOTE_WARNING_COLOR,
                    background: withAlpha(THEME_NOTE_WARNING_COLOR, 0.1)
                }}
            >
                {resolution.error}
            </span>
        );
    }
    const swatches = SWATCH_KEYS.map((key) => resolution.palette[key]).filter(
        (value): value is string => typeof value === 'string'
    );
    if (resolution.path === null || swatches.length === 0) return null;
    return (
        <span
            data-testid="terminal-theme-resolved"
            className="flex items-center gap-2 px-2 text-[11px]"
            style={{ color: tokens.textTertiary }}
        >
            <span aria-hidden className="flex h-3 overflow-hidden rounded-sm">
                {swatches.map((color, index) => (
                    <span
                        key={`${color}-${String(index)}`}
                        data-testid="terminal-theme-swatch"
                        className="h-3 w-3"
                        style={{ background: color }}
                    />
                ))}
            </span>
            <span data-testid="terminal-theme-path" className="truncate font-mono">
                {resolution.path}
            </span>
        </span>
    );
}

export function AppearanceTab(props: AppearanceTabProps): ReactElement {
    const appearance = props.settings.appearance;
    const chrome = props.settings.chrome;
    const actions = props.actions;
    const [status, setStatus] = useState<string | null>(null);
    const importRef = useRef<HTMLInputElement | null>(null);

    // Which bucket the colour pickers write into. The caller passes the scheme this window is
    // actually resolved at; without one, fall back to the ghostty background's own verdict —
    // the same rule that decides the chrome bucket in the first place.
    const bucket: ChromeBucket = props.bucket ?? (appearance.isDark ? 'dark' : 'light');
    const preset = presetChromeTheme(bucket);

    /** The resolved value of one overridable key: the override if set, else the preset. */
    const colorValue = (key: OverridableChromeKey): string => {
        const override = chrome.colors[`${bucket}:${key}`];
        const hex = override === undefined ? null : normalizeHexColor(override);
        return hex ?? (preset[key] as string);
    };

    const writeColors = (next: Readonly<Record<string, string>>): void => {
        // The whole map on one line, sorted, so two clients writing the same overrides produce
        // byte-identical files (`serializeChromeColors`'s contract, mirrored here).
        const sorted: Record<string, string> = {};
        for (const key of Object.keys(next).sort()) sorted[key] = next[key] as string;
        actions.setGeneralSetting('chrome-colors', JSON.stringify(sorted));
    };

    /**
     * SET-219's four keys. They are KELPI keys (the kelpi config file), not ghostty ones: the Swift
     * app shipped them as a ghostty defaults file only because libghostty drew the highlight —
     * here every search highlight is ours, so they live where the rest of the chrome palette
     * does. An unparseable value is dropped rather than written.
     */
    const writeSearchColor = (key: string, hex: string): void => {
        const normalized = normalizeHexColor(hex);
        if (normalized === null) return;
        actions.setGeneralSetting(key, normalized.toLowerCase());
    };

    const setColor = (key: OverridableChromeKey, hex: string): void => {
        const normalized = normalizeHexColor(hex);
        if (normalized === null) return;
        writeColors({ ...chrome.colors, [`${bucket}:${key}`]: normalized.replace(/^#/, '') });
    };

    /** The current chrome styling captured as a shareable document (`currentTheme`). */
    const currentTheme = (name?: string): ChromeStyleTheme => ({
        version: 1,
        ...(name === undefined ? {} : { name }),
        colorOverrides: { ...chrome.colors },
        sidebarColorIntensity: chrome.sidebarColorIntensity,
        sidebarAvatarFillOpacity: chrome.sidebarAvatarFill,
        sidebarAvatarStrokeOpacity: chrome.sidebarAvatarStroke,
        sidebarGroupFillOpacity: chrome.sidebarGroupFill,
        sidebarGroupStrokeOpacity: chrome.sidebarGroupStroke,
        sparklineColorHex: chrome.sparklineColor,
        sparklineWidth: chrome.sparklineWidth,
        sparklineStyle: chrome.sparklineStyle
    });

    /**
     * SET-030: a style theme overwrites the colour overrides (BOTH buckets), the four sidebar
     * opacities, the intensity and all three sparkline fields — and deliberately leaves the
     * recipient's chrome appearance mode and terminal background alone.
     */
    const applyStyleTheme = (theme: ChromeStyleTheme): void => {
        writeColors(theme.colorOverrides);
        actions.setGeneralSetting('sidebar-color-intensity', String(theme.sidebarColorIntensity));
        actions.setGeneralSetting('sidebar-avatar-fill', String(theme.sidebarAvatarFillOpacity));
        actions.setGeneralSetting('sidebar-avatar-stroke', String(theme.sidebarAvatarStrokeOpacity));
        actions.setGeneralSetting('sidebar-group-fill', String(theme.sidebarGroupFillOpacity));
        actions.setGeneralSetting('sidebar-group-stroke', String(theme.sidebarGroupStrokeOpacity));
        actions.setGeneralSetting('sparkline-color', theme.sparklineColorHex);
        actions.setGeneralSetting('sparkline-width', String(Math.round(theme.sparklineWidth)));
        actions.setGeneralSetting('sparkline-style', theme.sparklineStyle);
    };

    const applyPreset = (entry: BuiltInChromeTheme): void => {
        // SET-024: switch to the palette's native mode FIRST, then overwrite the styling.
        actions.setGeneralSetting('chrome-appearance', entry.appearance);
        applyStyleTheme(builtInStyleTheme(entry));
        setStatus(`Applied “${entry.name}” (${entry.appearance === 'dark' ? 'Dark' : 'Light'}).`);
    };

    const exportTheme = (): void => {
        const name = 'MyTheme';
        try {
            const blob = new Blob([chromeThemeFileJson(currentTheme(name))], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${name}.nextheme`;
            anchor.click();
            // Revoke on the next tick: revoking synchronously can beat the download starting.
            setTimeout(() => {
                URL.revokeObjectURL(url);
            }, 0);
            setStatus(`Exported “${name}”.`);
        } catch (error) {
            setStatus(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const importTheme = (event: ChangeEvent<HTMLInputElement>): void => {
        const file = event.target.files?.[0];
        // Clear the input so re-picking the SAME file fires `change` again.
        event.target.value = '';
        if (file === undefined) return;
        void file
            .text()
            .then((text) => {
                const theme = decodeChromeStyleTheme(JSON.parse(text));
                applyStyleTheme(theme);
                const label = theme.name ?? file.name.replace(/\.[^.]+$/, '');
                setStatus(`Imported “${label}”.`);
            })
            .catch((error: unknown) => {
                setStatus(error instanceof ChromeThemeError ? error.message : INVALID_THEME_MESSAGE);
            });
    };

    const copyCode = (): void => {
        void navigator.clipboard
            ?.writeText(chromeThemeShareCode(currentTheme()))
            .then(() => {
                setStatus('Theme code copied to the clipboard.');
            })
            .catch(() => {
                setStatus("Couldn't generate a theme code.");
            });
    };

    const pasteCode = (): void => {
        void navigator.clipboard
            ?.readText()
            .then((text) => {
                if (text.trim() === '') {
                    setStatus('The clipboard has no theme code to paste.');
                    return;
                }
                const theme = parseChromeThemeCode(text);
                applyStyleTheme(theme);
                setStatus(
                    `Imported theme from the clipboard${theme.name === undefined ? '' : ` (“${theme.name}”)`}.`
                );
            })
            .catch((error: unknown) => {
                setStatus(
                    error instanceof ChromeThemeError ? error.message : "That clipboard text isn't a Kelpi theme."
                );
            });
    };

    const setStatEnabled = (kind: string, enabled: boolean): void => {
        const next = new Set(chrome.enabledSystemStats);
        if (enabled) next.add(kind);
        else next.delete(kind);
        // Sorted on the wire, matching the Swift comma-joined sorted string; the FOOTER
        // re-imposes canonical order, so the two orders never have to agree.
        actions.setGeneralSetting('system-stats', [...next].sort().join(','));
    };

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-appearance">
            <SettingsSection
                title="Preset themes"
                hint="One-click chrome palettes based on popular editor themes. Each recolours the sidebar, title bar, status bar and agent dots, and switches Light/Dark to suit. Your terminal theme is unchanged; tweak any colour below afterwards."
                testID="appearance-presets"
            >
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))' }}>
                    {BUILT_IN_CHROME_THEMES.map((entry) => (
                        <ThemePresetCell
                            key={entry.name}
                            preset={entry}
                            onApply={() => {
                                applyPreset(entry);
                            }}
                        />
                    ))}
                </div>
            </SettingsSection>

            <SettingsSection title="Save & share" testID="appearance-share">
                <div className="flex flex-wrap items-center gap-2">
                    <SettingsButton testID="theme-export" onClick={exportTheme}>
                        Export…
                    </SettingsButton>
                    <SettingsButton
                        testID="theme-import"
                        onClick={() => {
                            importRef.current?.click();
                        }}
                    >
                        Import…
                    </SettingsButton>
                    <span className="flex-1" />
                    <SettingsButton testID="theme-copy-code" onClick={copyCode}>
                        Copy Code
                    </SettingsButton>
                    <SettingsButton testID="theme-paste-code" onClick={pasteCode}>
                        Paste Code
                    </SettingsButton>
                    {/*
                     * Inside the button row, not a sibling of it: L79 gives every DIRECT child of
                     * a section its own padded band and a hairline, and a `hidden` input is still
                     * a child — as a sibling it drew an empty 12 px strip with a rule above it,
                     * between the buttons and their caption.
                     */}
                    <input
                        ref={importRef}
                        type="file"
                        accept=".nextheme,.json,application/json"
                        className="hidden"
                        data-testid="theme-import-input"
                        aria-hidden
                        tabIndex={-1}
                        onChange={importTheme}
                    />
                </div>
                <p className="text-[11px]" style={{ color: tokens.textTertiary }} data-testid="theme-status">
                    {status ??
                        'Save your custom chrome colours and sidebar styling as a shareable .nextheme file or a copyable code. Importing restyles the chrome without changing your light/dark mode or terminal background.'}
                </p>
            </SettingsSection>

            <SettingsSection
                title="Chrome"
                hint="Themes the Kelpi window chrome (sidebar, title bar, status bar). Independent of the terminal theme below."
                testID="appearance-chrome"
            >
                <SegmentedField
                    label="Appearance"
                    testID="chrome-appearance"
                    value={chrome.appearance}
                    options={[
                        { value: 'system', label: 'System' },
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' }
                    ]}
                    onChange={(next) => {
                        actions.setGeneralSetting('chrome-appearance', next);
                    }}
                />
            </SettingsSection>

            <SettingsSection title="Chrome colours" testID="appearance-colors">
                {OVERRIDABLE_CHROME_KEYS.filter((key) => !isAgentStatusKey(key)).map((key) => (
                    <ColorField
                        key={key}
                        testID={`chrome-color-${key}`}
                        label={COLOR_KEY_LABEL[key]}
                        value={colorValue(key)}
                        onChange={(hex) => {
                            setColor(key, hex);
                        }}
                    />
                ))}
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        Editing the {bucket === 'dark' ? 'Dark' : 'Light'} palette - switch Appearance above to edit
                        the other.
                    </span>
                    <SettingsButton
                        testID="chrome-colors-reset"
                        disabled={Object.keys(chrome.colors).length === 0}
                        onClick={() => {
                            // SET-034: clears BOTH buckets and blanks the stored JSON.
                            writeColors({});
                            setStatus('Chrome colours reset.');
                        }}
                    >
                        Reset
                    </SettingsButton>
                </div>
            </SettingsSection>

            <SettingsSection
                title="Agent status"
                hint="The dot / badge colour shown for each agent state across the status bar, sidebar, pane headers, title bar and menu-bar icon."
                testID="appearance-agent-colors"
            >
                {AGENT_STATUS_KEYS.map((key) => (
                    <ColorField
                        key={key}
                        testID={`chrome-color-${key}`}
                        label={COLOR_KEY_LABEL[key]}
                        value={colorValue(key)}
                        onChange={(hex) => {
                            setColor(key, hex);
                        }}
                    />
                ))}
            </SettingsSection>

            {/*
             * L81: TWO sections, as `SettingsView.swift:384-409` has them — "Sidebar" over the one
             * slider that says how VIVID everything is, and "Sidebar fill & stroke" over the four
             * that say WHICH element. Each carries its own closing caption. The port had merged
             * them into one section under a single hint, which put five sliders in a row with
             * nothing marking the change of subject.
             */}
            <SettingsSection
                title="Sidebar"
                hint="Scales how vivid the group bands and workspace avatars are."
                testID="appearance-sidebar"
            >
                <SliderField
                    label="Colour intensity"
                    testID="sidebar-intensity"
                    value={chrome.sidebarColorIntensity}
                    min={0}
                    max={2}
                    step={0.05}
                    onChange={(next) => {
                        actions.setGeneralSetting('sidebar-color-intensity', next.toFixed(2));
                    }}
                />
            </SettingsSection>

            <SettingsSection
                title="Sidebar fill & stroke"
                hint="Fill = colour wash, border = outline. The intensity above multiplies these."
                testID="appearance-sidebar-style"
            >
                <SliderField
                    label="Avatar fill"
                    testID="sidebar-avatar-fill"
                    value={chrome.sidebarAvatarFill}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(next) => {
                        actions.setGeneralSetting('sidebar-avatar-fill', next.toFixed(2));
                    }}
                />
                <SliderField
                    label="Avatar border"
                    testID="sidebar-avatar-stroke"
                    value={chrome.sidebarAvatarStroke}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(next) => {
                        actions.setGeneralSetting('sidebar-avatar-stroke', next.toFixed(2));
                    }}
                />
                <SliderField
                    label="Group band fill"
                    testID="sidebar-group-fill"
                    // -1 means "use the appearance preset"; the slider shows the preset value it
                    // stands for rather than an impossible negative percentage.
                    detail={chrome.sidebarGroupFill < 0 ? 'Following the appearance preset.' : undefined}
                    value={chrome.sidebarGroupFill < 0 ? preset.groupBandOpacity : chrome.sidebarGroupFill}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(next) => {
                        actions.setGeneralSetting('sidebar-group-fill', next.toFixed(2));
                    }}
                />
                <SliderField
                    label="Group band border"
                    testID="sidebar-group-stroke"
                    value={chrome.sidebarGroupStroke}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(next) => {
                        actions.setGeneralSetting('sidebar-group-stroke', next.toFixed(2));
                    }}
                />
            </SettingsSection>

            <SettingsSection
                title="Terminal"
                hint="These four keys belong to ghostty and are written to its config file; every other line in it is preserved exactly."
                testID="appearance-terminal"
            >
                <SelectField
                    label="Theme"
                    testID="terminal-theme"
                    detail="A ghostty theme id. Choosing one hands the background to the theme."
                    value={appearance.theme ?? ''}
                    options={[
                        { value: '', label: 'None (Custom)' },
                        ...BUILT_IN_TERMINAL_THEMES.map((entry) => ({ value: entry.id, label: entry.name }))
                    ]}
                    onChange={(next) => {
                        if (next === '') {
                            // SET-040's inverse: dropping the theme returns to the custom
                            // background path, so the key is REMOVED rather than blanked.
                            actions.setGhosttySetting('theme', null);
                            return;
                        }
                        actions.setGhosttySetting('theme', next);
                        // SET-040: a theme owns the background, so an explicit `background`
                        // line would silently win over it. Removing it is what makes the
                        // picker mean what it says.
                        actions.setGhosttySetting('background', null);
                    }}
                />

                {/* §APP-014: what the picked name actually RESOLVED to, or why it did not. */}
                <TerminalThemeNote resolution={appearance.terminalTheme} />

                {appearance.theme === null ? (
                    <ColorField
                        label="Background colour"
                        testID="terminal-background"
                        detail="Painted behind every pane - terminal, markdown, diff, scratchpad."
                        value={appearance.backgroundColor}
                        onChange={(hex) => {
                            const normalized = normalizeHexColor(hex);
                            if (normalized === null) return;
                            actions.setGhosttySetting('background', normalized.toLowerCase());
                        }}
                    />
                ) : (
                    <SettingsRow
                        label="Background colour"
                        detail="Hidden while a theme is selected - the theme owns the background. Choose “None (Custom)” to set one."
                        testID="terminal-background-locked"
                    >
                        <span
                            data-testid="appearance-swatch"
                            data-color={normalizeHexColor(appearance.backgroundColor)}
                            role="img"
                            aria-label={`Background ${appearance.backgroundColor}`}
                            className="h-5 w-9 rounded"
                            style={{
                                background: withAlpha(appearance.backgroundColor, appearance.backgroundOpacity),
                                border: `1px solid ${tokens.divider}`
                            }}
                        />
                    </SettingsRow>
                )}

                <SliderField
                    label="Background opacity"
                    testID="terminal-opacity"
                    // APP-012 / SET-049: panes follow the value immediately; the WINDOW's own
                    // transparency is fixed when Electron creates it, so crossing 1.0 takes a
                    // relaunch. Said here rather than discovered.
                    detail="Blended into every pane fill as rgba(background, opacity). Below 1 the window itself becomes transparent on the next launch."
                    value={appearance.backgroundOpacity}
                    min={0.1}
                    max={1}
                    step={0.05}
                    onChange={(next) => {
                        actions.setGhosttySetting('background-opacity', next.toFixed(2));
                    }}
                />

                <TextField
                    label="Font family"
                    testID="terminal-font-family"
                    detail="Blank means the renderer's own default."
                    placeholder="default"
                    value={appearance.fontFamily ?? ''}
                    onCommit={(next) => {
                        actions.setGhosttySetting('font-family', next.trim() === '' ? null : next.trim());
                    }}
                />
                <SliderField
                    label="Font size"
                    testID="terminal-font-size"
                    value={appearance.fontSize ?? 13}
                    min={8}
                    max={32}
                    step={1}
                    format={(value) => `${String(Math.round(value))}px`}
                    onChange={(next) => {
                        actions.setGhosttySetting('font-size', String(Math.round(next)));
                    }}
                />
                <SliderField
                    label="Padding (horizontal)"
                    testID="terminal-padding-x"
                    detail="Pixels kept clear at the pane's left and right edges - ghostty's window-padding-x."
                    value={appearance.windowPaddingX ?? TERMINAL_EDGE_PADDING}
                    min={0}
                    max={32}
                    step={1}
                    format={(value) => `${String(Math.round(value))}px`}
                    onChange={(next) => {
                        actions.setGhosttySetting('window-padding-x', String(Math.round(next)));
                    }}
                />
                <SliderField
                    label="Padding (vertical)"
                    testID="terminal-padding-y"
                    detail="Pixels between the pane's top edge and row 1 - ghostty's window-padding-y. The bottom edge keeps the sub-cell remainder."
                    value={appearance.windowPaddingY ?? TERMINAL_EDGE_PADDING_TOP}
                    min={0}
                    max={32}
                    step={1}
                    format={(value) => `${String(Math.round(value))}px`}
                    onChange={(next) => {
                        actions.setGhosttySetting('window-padding-y', String(Math.round(next)));
                    }}
                />

                <SettingsRow
                    label="Resolved appearance"
                    detail="The daemon's luminance verdict on the background - it, not the OS setting, picks light or dark for panes."
                    testID="appearance-bucket"
                >
                    <KeyChip>{appearance.isDark ? 'dark' : 'light'}</KeyChip>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection
                title="Search highlight"
                hint="What a search match is painted with - the markdown/diff find bar, a web pane's find bar, and the terminal's search selection. Kelpi ships the Swift app's colours; these override them."
                testID="appearance-search"
            >
                <ColorField
                    label="Match"
                    testID="search-match-color"
                    detail="Every match that is not the current one."
                    value={chrome.searchMatchColor}
                    onChange={(hex) => {
                        writeSearchColor('search-match-color', hex);
                    }}
                />
                <ColorField
                    label="Match text"
                    testID="search-match-text-color"
                    value={chrome.searchMatchTextColor}
                    onChange={(hex) => {
                        writeSearchColor('search-match-text-color', hex);
                    }}
                />
                <ColorField
                    label="Current match"
                    testID="search-match-current-color"
                    detail="The one Return jumps to."
                    value={chrome.searchMatchCurrentColor}
                    onChange={(hex) => {
                        writeSearchColor('search-match-current-color', hex);
                    }}
                />
                <ColorField
                    label="Current match text"
                    testID="search-match-current-text-color"
                    value={chrome.searchMatchCurrentTextColor}
                    onChange={(hex) => {
                        writeSearchColor('search-match-current-text-color', hex);
                    }}
                />
                <SettingsRow
                    label="Preview"
                    detail="A line of text with one ordinary match and the current one, in the colours above."
                    testID="search-preview-row"
                >
                    <span className="flex items-center gap-1 text-[12px]" style={{ color: tokens.textSecondary }}>
                        <span
                            data-testid="search-preview-match"
                            data-color={normalizeHexColor(chrome.searchMatchColor)}
                            className="rounded px-1"
                            style={{ background: chrome.searchMatchColor, color: chrome.searchMatchTextColor }}
                        >
                            match
                        </span>
                        <span
                            data-testid="search-preview-current"
                            data-color={normalizeHexColor(chrome.searchMatchCurrentColor)}
                            className="rounded px-1"
                            style={{
                                background: chrome.searchMatchCurrentColor,
                                color: chrome.searchMatchCurrentTextColor
                            }}
                        >
                            current
                        </span>
                    </span>
                </SettingsRow>
                <SettingsButton
                    testID="search-colors-reset"
                    onClick={() => {
                        writeSearchColor('search-match-color', DEFAULT_WS_CHROME_SETTINGS.searchMatchColor);
                        writeSearchColor('search-match-text-color', DEFAULT_WS_CHROME_SETTINGS.searchMatchTextColor);
                        writeSearchColor(
                            'search-match-current-color',
                            DEFAULT_WS_CHROME_SETTINGS.searchMatchCurrentColor
                        );
                        writeSearchColor(
                            'search-match-current-text-color',
                            DEFAULT_WS_CHROME_SETTINGS.searchMatchCurrentTextColor
                        );
                    }}
                >
                    Reset search colours
                </SettingsButton>
            </SettingsSection>

            <SettingsSection
                title="Status bar"
                hint="Live system metrics on the right of the bottom status bar. Hover any metric for a detail graph over time."
                testID="appearance-status-bar"
            >
                <SettingsRow label="Show system stats" testID="stats-master-row">
                    <SettingsToggle
                        testID="stats-master-toggle"
                        label="Show system stats"
                        checked={chrome.showSystemStats}
                        onChange={(next) => {
                            actions.setGeneralSetting('show-system-stats', next ? 'true' : 'false');
                        }}
                    />
                </SettingsRow>

                {chrome.showSystemStats ? (
                    <>
                        <div className="ml-4 flex flex-col gap-1.5" data-testid="stats-kinds">
                            {SYSTEM_STAT_KINDS.map((kind) => (
                                <SettingsRow
                                    key={kind}
                                    label={SYSTEM_STAT_META[kind].displayName}
                                    /*
                                     * M51: `SettingsView.swift:444-447` labels each of these six
                                     * rows `Label(kind.displayName, systemImage: kind.systemImage)`
                                     * — the SAME glyph the status bar draws for that metric. The
                                     * port already carried it (`SYSTEM_STAT_META[kind].icon`,
                                     * which `StatusFooter` reads) and simply never put it in the
                                     * row, so the list and the thing it configures stopped
                                     * looking like each other.
                                     */
                                    icon={<ChromeIcon name={SYSTEM_STAT_META[kind].icon} size={12} />}
                                    testID={`stats-kind-${kind}`}
                                >
                                    <SettingsToggle
                                        testID={`stats-kind-toggle-${kind}`}
                                        label={SYSTEM_STAT_META[kind].displayName}
                                        checked={chrome.enabledSystemStats.includes(kind)}
                                        onChange={(next) => {
                                            setStatEnabled(kind, next);
                                        }}
                                    />
                                </SettingsRow>
                            ))}
                        </div>

                        <details className="rounded" data-testid="stats-graphs">
                            <summary className="px-2 py-1 text-[12px]" style={{ color: tokens.textPrimary }}>
                                Mini graphs
                            </summary>
                            <div className="mt-1.5 flex flex-col gap-1.5">
                                <SettingsRow label="Show mini graphs" testID="stats-graphs-row">
                                    <SettingsToggle
                                        testID="stats-graphs-toggle"
                                        label="Show mini graphs"
                                        checked={chrome.showSystemStatGraphs}
                                        onChange={(next) => {
                                            actions.setGeneralSetting(
                                                'show-system-stat-graphs',
                                                next ? 'true' : 'false'
                                            );
                                        }}
                                    />
                                </SettingsRow>
                                <SegmentedField
                                    label="Graph style"
                                    testID="sparkline-style"
                                    value={chrome.sparklineStyle}
                                    options={[
                                        { value: 'line', label: 'Line' },
                                        { value: 'dots', label: 'Stacked dots' }
                                    ]}
                                    onChange={(next) => {
                                        actions.setGeneralSetting('sparkline-style', next);
                                    }}
                                />
                                <ColorField
                                    label="Graph colour"
                                    testID="sparkline-color"
                                    // An empty stored hex means "adaptive": the picker has to
                                    // show SOMETHING, so it shows the tone the footer actually
                                    // draws with, and "Reset" is what puts it back to adaptive.
                                    value={chrome.sparklineColor === '' ? preset.textSecondary : chrome.sparklineColor}
                                    onChange={(hex) => {
                                        const normalized = normalizeHexColor(hex);
                                        if (normalized === null) return;
                                        actions.setGeneralSetting('sparkline-color', normalized.toLowerCase());
                                    }}
                                />
                                <SliderField
                                    label="Graph width"
                                    testID="sparkline-width"
                                    // L82: this row is not a `sliderRow` in the Swift — it writes
                                    // its own `HStack` and gives the readout `.frame(width: 32)`
                                    // (`SettingsView.swift:472-474`), because a bare 16…80 does
                                    // not need a percentage's column.
                                    readoutWidth={32}
                                    value={chrome.sparklineWidth}
                                    min={16}
                                    max={80}
                                    step={2}
                                    format={(value) => String(Math.round(value))}
                                    onChange={(next) => {
                                        actions.setGeneralSetting('sparkline-width', String(Math.round(next)));
                                    }}
                                />
                                <div className="flex justify-end">
                                    <SettingsButton
                                        testID="sparkline-color-reset"
                                        onClick={() => {
                                            // An empty hex is the documented "adaptive chrome
                                            // default" value, not a cleared setting.
                                            actions.setGeneralSetting('sparkline-color', '');
                                        }}
                                    >
                                        Reset graph colour
                                    </SettingsButton>
                                </div>
                            </div>
                        </details>
                    </>
                ) : null}
            </SettingsSection>

            <SettingsFooterNote>
                Terminal colours and fonts: <span className="font-mono">{props.paths.ghosttyConfig}</span>. Chrome
                palette, sidebar and status bar: <span className="font-mono">{props.paths.kelpiConfig}</span>. Both are
                watched - save either file and this window follows.
            </SettingsFooterNote>
        </div>
    );
}

/** Re-exported for the tests and the audit: the exact percent readout the sliders show. */
export { percentLabel as appearancePercentLabel };
