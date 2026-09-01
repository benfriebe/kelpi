/**
 * The Settings window (config-keybindings.md §13, shell-ui.md's focus choreography).
 *
 * A modal overlay rather than a second window: the web client has one document, and everything
 * the Swift Settings window does is a form over daemon state. Behaviors that are contracts
 * rather than styling:
 *
 *   - **Escape closes**, and closing hands focus back to the pane the user came from — the same
 *     §10.4 choreography the command palette follows, because a chrome surface must never leave
 *     the window without keyboard focus. A nested editor that uses Escape for its own cancel
 *     (the recorder, an inline rename field) stops the event, so Escape means "the innermost
 *     thing that is open", never "close everything at once".
 *   - **The overlay owns the keyboard while it is open.** Assembly gates the app's key
 *     dispatcher on it, so ⌘D does not split a pane behind the sheet, and the recorder can
 *     capture any combo the user presses.
 *   - **Focus is trapped**: Tab cycles inside the dialog. The tab rail is a roving-tabindex
 *     `tablist` — ↑/↓ (and ←/→) move between tabs, Home/End jump to the ends.
 *
 * The tabs themselves render from props and push verbs; the only state here is which tab is
 * showing.
 */

import type { WsSettingsSnapshot, WsTransportStatus } from '@kelpi/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import { clientKeyBindings, tokens, withAlpha, type ChromeBucket } from '../chrome';
import type { WebFavourite } from '../webpane';
import { AppearanceTab } from './AppearanceTab';
import { GeneralTab } from './GeneralTab';
import { KeybindingsTab } from './KeybindingsTab';
import { LabelsTab } from './LabelsTab';
import { ProfilesTab } from './ProfilesTab';
import { RemoteTab, type RemoteTabActions } from './RemoteTab';
import { RepositoriesTab, type RepositoryEntry } from './RepositoriesTab';
import { DEFAULT_SETTINGS_TAB, SETTINGS_TABS, type SettingsTabIcon, type SettingsTabID } from './catalog';
import {
    CommandGlyph,
    ExternalDriveGlyph,
    AntennaGlyph,
    GearGlyph,
    GlobeGlyph,
    GridGlyph,
    PaintbrushGlyph,
    PersonBadgeKeyGlyph,
    TagGlyph
} from './glyphs';
import { WebTab, type WebTabActions } from './WebTab';
import { WorkspacesTab } from './WorkspacesTab';
import {
    DEFAULT_SETTINGS_PATHS,
    type SettingsActions,
    type SettingsDomainState,
    type SettingsPaths
} from './types';
import { SettingsButton, hoverBackground, useHover } from './ui';

export interface SettingsOverlayProps {
    readonly open: boolean;
    readonly settings: WsSettingsSnapshot;
    readonly domain: SettingsDomainState;
    readonly actions: SettingsActions;
    readonly onClose: () => void;
    /** Which tab to show first; also re-applied whenever the overlay is re-opened. */
    readonly initialTab?: SettingsTabID | undefined;
    readonly paths?: SettingsPaths | undefined;
    readonly bucket?: ChromeBucket | undefined;
    /**
     * §SET-021: what the daemon's control listeners actually did (`welcome.transport`), for the
     * General tab's Network row. Absent = the daemon did not say, which the row renders as
     * "as of daemon start" rather than claiming a bind either way.
     */
    readonly transport?: WsTransportStatus | null | undefined;
    /**
     * A global-hotkey registration failure the Electron shell reported (SET-083). A browser
     * client has no registrar, so this is absent there and the Keybindings tab shows no
     * warning — correct, because nothing tried to register anything.
     */
    readonly globalHotkeyError?: string | null | undefined;
    /**
     * Electron's native directory chooser, for Settings ▸ Repositories' Add / Scan (§SET-053 /
     * §SET-054's `NSOpenPanel`). Absent in a browser, where the path field is the whole input —
     * which is also the only thing that works against a REMOTE daemon.
     */
    readonly onBrowseForFolder?: (() => Promise<string | null>) | undefined;
    /**
     * Settings ▸ Web (§14). Passed as its own prop rather than folded into `SettingsActions`
     * because favourites are not config-file settings: they are daemon state reached by the
     * `web-favourite-*` verbs, and a client that has no web-pane host still shows the tab (it
     * simply shows the empty state).
     */
    readonly web?:
        | {
              readonly favourites: readonly WebFavourite[];
              readonly actions: WebTabActions;
              readonly path?: string | undefined;
          }
        | undefined;
    /**
     * Settings ▸ Remote's verbs (daemon `ws/remote.ts`, owner-only). Like `web`, these are
     * not config-file settings — they are daemon state reached by the `remote-*` commands.
     * Absent = the tab still renders and each verb answers "not available".
     */
    readonly remote?: RemoteTabActions | undefined;
}

const EMPTY_REPOSITORIES: readonly RepositoryEntry[] = [];

const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function SettingsOverlay(props: SettingsOverlayProps): ReactElement | null {
    // H13: `SettingsView.swift:13` opens on `.general`. Nothing here picks a "most useful" tab
    // of its own — the shipped app's landing tab is the landing tab.
    const initial = props.initialTab ?? DEFAULT_SETTINGS_TAB;
    const [tab, setTab] = useState<SettingsTabID>(initial);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const tabRefs = useRef(new Map<SettingsTabID, HTMLButtonElement>());
    const paths = props.paths ?? DEFAULT_SETTINGS_PATHS;

    // Re-opening always lands on the requested tab: a deep link ("Manage labels…") must not be
    // overridden by wherever the user happened to be last time.
    useEffect(() => {
        if (props.open) setTab(initial);
    }, [props.open, initial]);

    useEffect(() => {
        if (!props.open) return;
        tabRefs.current.get(tab)?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge only: moving focus on
        // every tab change would fight a click inside the panel.
    }, [props.open]);

    const bindings = useMemo(() => clientKeyBindings(props.settings.keybindLines), [props.settings.keybindLines]);

    const moveTab = useCallback(
        (delta: number, absolute?: 'first' | 'last'): void => {
            const ids = SETTINGS_TABS.map((entry) => entry.id);
            const at = ids.indexOf(tab);
            const next =
                absolute === 'first'
                    ? 0
                    : absolute === 'last'
                      ? ids.length - 1
                      : (at + delta + ids.length) % ids.length;
            const id = ids[next];
            if (id === undefined) return;
            setTab(id);
            tabRefs.current.get(id)?.focus();
        },
        [tab]
    );

    if (!props.open) return null;

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
            return;
        }
        if (event.key !== 'Tab') return;
        // Trap: the dialog is modal, so Tab must not walk into the panes behind it.
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (nodes === undefined || nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (first === undefined || last === undefined) return;
        const active = document.activeElement;
        if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
            return;
        }
        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        }
    };

    return (
        <div
            data-testid="settings-backdrop"
            className="absolute inset-0 z-50 flex items-center justify-center"
            // run-B m6: at 0.35 the panes behind kept their full brightness and the window did
            // not read as modal at all. 0.62 plus a 2px blur pushes the content behind out of
            // focus without hiding which workspace you are in.
            style={{ background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(2px)' }}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) props.onClose();
            }}
        >
            <div
                ref={dialogRef}
                data-testid="settings-window"
                role="dialog"
                aria-modal="true"
                aria-label="Settings"
                /*
                 * S57: the width has a FLOOR. `SettingsView.swift:61-64` opens the preferences
                 * scene at `minWidth: 500, idealWidth: 600`; `w-[min(880px,92%)]` had no floor
                 * at all, so a 760 px window drove the dialog to 699 px and the Labels tab's
                 * only flexible track — the preset name field — collapsed to 14 px while every
                 * fixed track held its width. 560 px is `minWidth: 500` plus this dialog's own
                 * rail (176) less the Swift's tab strip, i.e. the same content floor.
                 */
                className="flex h-[min(620px,90%)] w-[clamp(560px,92%,880px)] flex-col overflow-hidden rounded-[10px]"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
                    color: tokens.textPrimary
                }}
                onKeyDown={onKeyDown}
            >
                {/*
                 * SET-004: the Swift Settings scene paints its BODY with `surfaceBackground` and
                 * its window toolbar with `headerBackground`, which is what made it read as the
                 * same app as the main window rather than as a system sheet. This dialog has no
                 * OS toolbar, so it carries its own: the title strip is the toolbar, painted with
                 * the same token, and it is where Close lives (a toolbar's job).
                 */}
                <div
                    data-testid="settings-toolbar"
                    className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
                    style={{ background: tokens.headerBackground, borderColor: tokens.divider }}
                >
                    <span className="text-[12px] font-semibold" style={{ color: tokens.textPrimary }}>
                        Settings
                    </span>
                    <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        {SETTINGS_TABS.find((entry) => entry.id === tab)?.label ?? ''}
                    </span>
                    <span className="ml-auto">
                        <SettingsButton testID="settings-close" onClick={props.onClose}>
                            Close
                        </SettingsButton>
                    </span>
                </div>

                <div className="flex min-h-0 flex-1">
                <div
                    role="tablist"
                    aria-label="Settings sections"
                    aria-orientation="vertical"
                    data-testid="settings-tabs"
                    /*
                     * S59: `gap-1`. The rail rows are the port's intended 28.8 px now that S1
                     * layered the reset, but `gap-0.5` left a 2 px row gap — a 30.8 px pitch,
                     * eight rows reading as a paragraph of lines rather than a list of tabs.
                     * 4 px puts the pitch at 32.8, still far denser than the Swift's
                     * icon-over-title `.tabItem`s (~50 × 40 pt).
                     */
                    className="flex w-44 shrink-0 flex-col gap-1 border-r p-2"
                    style={{ borderColor: tokens.divider, background: tokens.sidebarBackground }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                            event.preventDefault();
                            moveTab(1);
                            return;
                        }
                        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                            event.preventDefault();
                            moveTab(-1);
                            return;
                        }
                        if (event.key === 'Home') {
                            event.preventDefault();
                            moveTab(0, 'first');
                            return;
                        }
                        if (event.key === 'End') {
                            event.preventDefault();
                            moveTab(0, 'last');
                        }
                    }}
                >
                    {SETTINGS_TABS.map((entry) => (
                        <RailTab
                            key={entry.id}
                            id={entry.id}
                            label={entry.label}
                            icon={entry.icon}
                            selected={entry.id === tab}
                            registerRef={(node) => {
                                if (node === null) tabRefs.current.delete(entry.id);
                                else tabRefs.current.set(entry.id, node);
                            }}
                            onSelect={() => {
                                setTab(entry.id);
                            }}
                        />
                    ))}
                </div>

                <div
                    role="tabpanel"
                    id={`settings-panel-${tab}`}
                    aria-labelledby={`settings-tab-${tab}`}
                    data-testid="settings-panel"
                    className="min-w-0 flex-1 overflow-y-auto p-4"
                >
                    {tab === 'general' ? (
                        <GeneralTab
                            settings={props.settings}
                            actions={props.actions}
                            paths={paths}
                            transport={props.transport ?? null}
                        />
                    ) : null}
                    {tab === 'repositories' ? (
                        <RepositoriesTab
                            repos={props.domain.repos ?? EMPTY_REPOSITORIES}
                            actions={props.actions}
                            paths={paths}
                            autoDetectRepos={props.settings.general.autoDetectRepos}
                            {...(props.onBrowseForFolder === undefined
                                ? {}
                                : { onBrowse: props.onBrowseForFolder })}
                        />
                    ) : null}
                    {tab === 'keybindings' ? (
                        <KeybindingsTab
                            bindings={bindings}
                            actions={props.actions}
                            configPath={paths.kelpiConfig}
                            globalHotkey={props.settings.general.globalHotkey}
                            globalHotkeyHideOnRepress={props.settings.general.globalHotkeyHideOnRepress}
                            globalHotkeyError={props.globalHotkeyError}
                        />
                    ) : null}
                    {tab === 'appearance' ? (
                        <AppearanceTab
                            settings={props.settings}
                            paths={paths}
                            actions={props.actions}
                            bucket={props.bucket}
                        />
                    ) : null}
                    {tab === 'labels' ? (
                        <LabelsTab
                            presets={props.domain.labelPresets}
                            workspaces={props.domain.workspaces}
                            actions={props.actions}
                            bucket={props.bucket}
                        />
                    ) : null}
                    {tab === 'profiles' ? (
                        <ProfilesTab profiles={props.settings.profiles} actions={props.actions} paths={paths} />
                    ) : null}
                    {tab === 'workspaces' ? (
                        <WorkspacesTab settings={props.settings} actions={props.actions} paths={paths} />
                    ) : null}
                    {tab === 'web' ? (
                        <WebTab
                            favourites={props.web?.favourites ?? EMPTY_FAVOURITES}
                            actions={props.web?.actions ?? NO_WEB_ACTIONS}
                            {...(props.web?.path === undefined ? {} : { path: props.web.path })}
                        />
                    ) : null}
                    {tab === 'remote' ? <RemoteTab actions={props.remote ?? NO_REMOTE_ACTIONS} /> : null}
                </div>
                </div>
            </div>
        </div>
    );
}

interface RailTabProps {
    readonly id: SettingsTabID;
    readonly label: string;
    readonly icon: SettingsTabIcon;
    readonly selected: boolean;
    readonly registerRef: (node: HTMLButtonElement | null) => void;
    readonly onSelect: () => void;
}

/**
 * The rail's glyph, by SF Symbol name (L88).
 *
 * `SettingsView.swift:20-59`'s seven `.tabItem { Label(name, systemImage:) }`s, plus one for the
 * port-only Workspaces tab. **The size is a stated divergence:** an AppKit preferences `TabView`
 * draws its tab icons large, ABOVE the title, and this port's rail is a vertical list (the
 * structural divergence SET-002 already ledgers), so the glyph sits inline at the rail's own
 * 12 px text — one point up at 13 px so it does not read smaller than the word beside it.
 */
const NO_REMOTE_ACTIONS: RemoteTabActions = {
    status: () => Promise.resolve({ ok: false, error: 'remote access is not available' }),
    pair: () => Promise.resolve({ ok: false, error: 'remote access is not available' }),
    revoke: () => Promise.resolve({ ok: false, error: 'remote access is not available' })
};

const RAIL_GLYPH: Readonly<Record<SettingsTabIcon, (props: { readonly size: number }) => ReactElement>> = {
    gear: GearGlyph,
    paintbrush: PaintbrushGlyph,
    externaldrive: ExternalDriveGlyph,
    tag: TagGlyph,
    'person.badge.key': PersonBadgeKeyGlyph,
    command: CommandGlyph,
    globe: GlobeGlyph,
    'square.grid.2x2': GridGlyph,
    'antenna.radiowaves': AntennaGlyph
};

/** The size the note above argues for. */
const RAIL_GLYPH_SIZE = 13;

/**
 * One entry in the tab rail.
 *
 * Its own component purely so it can hold hover state (H11): a `TabView`'s tab items respond
 * to the pointer in AppKit, and the port's rail was inert — the only thing that ever changed
 * colour was the tab you had already selected. The selected fill wins over the hover fill, so
 * the rail never shows two lit rows at once.
 */
function RailTab(props: RailTabProps): ReactElement {
    const { hovered, hoverProps } = useHover(!props.selected);
    const Glyph = RAIL_GLYPH[props.icon];
    return (
        <button
            ref={props.registerRef}
            type="button"
            role="tab"
            id={`settings-tab-${props.id}`}
            aria-selected={props.selected}
            aria-controls={`settings-panel-${props.id}`}
            tabIndex={props.selected ? 0 : -1}
            data-testid={`settings-tab-button-${props.id}`}
            data-icon={props.icon}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors duration-100"
            style={{
                background: props.selected
                    ? withAlpha(tokens.accent, 0.18)
                    : hoverBackground(hovered, 'transparent'),
                color: props.selected || hovered ? tokens.textPrimary : tokens.textSecondary
            }}
            {...hoverProps}
            onClick={props.onSelect}
        >
            <span className="flex shrink-0 items-center">
                <Glyph size={RAIL_GLYPH_SIZE} />
            </span>
            {props.label}
        </button>
    );
}

const EMPTY_FAVOURITES: readonly WebFavourite[] = [];

/** A client with no web wiring still renders the tab; its buttons simply do nothing. */
const NO_WEB_ACTIONS: WebTabActions = {
    renameFavourite: () => {},
    removeFavourite: () => {},
    moveFavourite: () => {}
};
