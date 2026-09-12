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
 *
 * ── On a phone it is a full-screen sheet (B5) ───────────────────────────────────────
 *
 * **An owner-directed divergence from the shipped Swift app, like every phone rule in this
 * program** (MOBILE-PLAN.md §4 B5; `chrome/form-factor.ts` carries the standing note). There is no
 * Swift phone Settings to port: the shipped app is a Mac app and its preferences scene is an
 * AppKit `TabView` in a resizable window.
 *
 * Under `useFormFactor() === 'phone'` this component renders a different tree entirely: the dialog
 * fills the viewport with no backdrop margin, no radius and no shadow (a sheet that covers the
 * screen has no edge to draw), and the vertical tab RAIL becomes a two-screen push navigation -
 * the list of tabs, then one tab's content behind a back button. The rail is what forces it: it is
 * `w-44` (176 px) of fixed chrome beside a dialog with a 560 px content floor (§S57), which is 736
 * px of horizontal demand on a viewport that is 390 px wide.
 *
 * The tab CONTENT is the same components with the same props on both form factors; only the
 * navigation around them changes. `settings/*Tab.tsx` is untouched by B5.
 */

import type { WsSettingsSnapshot, WsTransportStatus } from '@kelpi/protocol';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactElement,
    type ReactNode,
    type RefObject
} from 'react';

import {
    ChromeIcon,
    clientKeyBindings,
    defaultFormFactorWindow,
    tokens,
    useFormFactor,
    withAlpha,
    type ChromeBucket,
    type FormFactorWindow
} from '../chrome';
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
import { NO_SETTINGS_CHORDS, SettingsPresenterSlot } from './presenter-slot';
import { settingsSectionHasNative } from './sections';
import type { SettingsSurface } from './surface';
import {
    DEFAULT_SETTINGS_PATHS,
    type SettingsActions,
    type SettingsDomainState,
    type SettingsPaths
} from './types';
import { SettingsButton, hoverBackground, useHover } from './ui';
import { useSettingsSection } from './use-settings';

export interface SettingsOverlayProps {
    readonly pluginContent?: import('react').ReactNode;
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
    /**
     * B5 - the window the form-factor signal is read from. Defaults to the page's own, which is
     * what assembly passes (nothing). It exists so a jsdom test can hand in a phone: jsdom has no
     * `matchMedia` at all, so a real window there always answers `desktop`.
     */
    readonly formFactorWindow?: FormFactorWindow | undefined;
    /**
     * The window's settings surface (`settings/surface.ts`), when assembly has one.
     *
     * What it owns here is ROUTING: which section is showing, validated against the catalog. The
     * rail, the Escape, the focus trap, the phone rule and PR #181's `initialTab` re-application
     * all stay in this component, because they are the modal's behaviour rather than the settings
     * model's - and because a replaceable presenter must never be able to route the user away
     * from the section that would let them switch it off.
     *
     * Absent (a fixture, a unit test, an embedder) the overlay holds the selection itself, which
     * is exactly what it did before the surface existed.
     */
    readonly surface?: SettingsSurface | undefined;
    /**
     * Whether a selected plugin view may draw the rail and the panel (`App`: `!phoneActive`).
     *
     * Desktop only, and only with a `surface`: the routing, the drafts and the write queue a
     * presenter acts through are the surface's, and the phone sheet is a two-screen push navigation
     * over a software keyboard a frame cannot read. False - or absent - is the bundled panel,
     * always, which is what every fixture and every existing test gets.
     */
    readonly presenters?: boolean | undefined;
    /** The small relayed set from `settingsPresenterChords`, never `allViewChords`. */
    readonly presenterChords?: readonly string[] | undefined;
    /**
     * How many modal registrations the ASSEMBLY holds while this dialog is open.
     *
     * `App` registers one presence covering Settings, Help and the create sheet, so it passes 1;
     * anything above that number is a peer surface raised over the dialog (a palette, a prompt, the
     * quit dialog), which owns the caret and its own Escape for as long as it is up. A dialog
     * rendered on its own registers nothing, which is the default.
     */
    readonly modalPresence?: number | undefined;
    /**
     * The native report of a failed presenter (a toast), raised once per failing generation.
     *
     * The dialog does not draw its own: Settings is a surface you can be looking at when it fails,
     * and the window's toast stack is where every other failure in this client is reported. The
     * standing state lives in Settings ▸ Plugins beside the Retry row.
     */
    readonly onPresenterFailure?: ((detail: string) => void) | undefined;
}

const EMPTY_REPOSITORIES: readonly RepositoryEntry[] = [];

/**
 * The floor for a row a thumb has to hit, in CSS px.
 *
 * Apple's Human Interface Guidelines have said 44x44 pt since the first iPhone, and the rail rows
 * this replaces are 28.8 px (§S59) - sized for a pointer that lands where it is aimed. Applied to
 * the tab list, the toolbar's buttons and nothing else: the tab CONTENT is the desktop's, and
 * re-spacing it is B5's explicit non-goal.
 */
const PHONE_ROW_MIN_PX = 44;

/**
 * The phone sheet's own edge insets.
 *
 * A3 paints the phone chrome's safe areas on the top bar and the footer, which an overlay is not
 * part of - it covers them. So a full-screen sheet respects the notch and the home indicator on
 * its OWN box, and this is the one place that is written down.
 *
 * Each one is wrapped in `calc()`. A browser computes `calc(env(x))` and `env(x)` identically, but
 * a BARE `env()` is dropped by a CSS parser that does not know the function, and jsdom's is one
 * (measured: `style.setProperty('padding-top', 'env(safe-area-inset-top)')` leaves `paddingTop`
 * empty, while the `calc()` form round-trips verbatim). Since jsdom is where the unit tests read
 * these back, the wrapper is what makes the rule testable at all off a device.
 */
const PHONE_SAFE_AREA = {
    paddingTop: 'calc(env(safe-area-inset-top))',
    paddingBottom: 'calc(env(safe-area-inset-bottom))',
    paddingLeft: 'calc(env(safe-area-inset-left))',
    paddingRight: 'calc(env(safe-area-inset-right))'
} as const;

const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function SettingsOverlay(props: SettingsOverlayProps): ReactElement | null {
    // H13: `SettingsView.swift:13` opens on `.general`. Nothing here picks a "most useful" tab
    // of its own — the shipped app's landing tab is the landing tab.
    const initial = props.initialTab ?? DEFAULT_SETTINGS_TAB;
    const surface = props.surface ?? null;
    /*
     * Where the selection lives.
     *
     * With a surface it is the surface's (which, in the app, is `App`'s own `settingsTab` behind
     * a validator - so every deep link, the palette, the menu and ⌘, keep routing exactly as they
     * did). Without one this component holds it, which is what every fixture and every unit test
     * below relies on. `setTab` is the one writer either way, so the rail, the arrow keys and the
     * phone's list rows are untouched by which of the two is in force.
     */
    const [heldTab, setHeldTab] = useState<SettingsTabID>(initial);
    const routed = useSettingsSection(surface);
    const tab = routed ?? heldTab;
    const setTab = useCallback(
        (id: SettingsTabID): void => {
            if (surface === null) {
                setHeldTab(id);
                return;
            }
            surface.setSection(id);
        },
        [surface]
    );
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const tabRefs = useRef(new Map<SettingsTabID, HTMLButtonElement>());
    const backRef = useRef<HTMLButtonElement | null>(null);
    const paths = props.paths ?? DEFAULT_SETTINGS_PATHS;

    const formFactorWindow = props.formFactorWindow ?? defaultFormFactorWindow();
    const phone = useFormFactor(formFactorWindow) === 'phone';

    /*
     * B5 - which of the phone sheet's two screens is showing. Unread on a desktop, where the rail
     * and the panel are on screen together.
     *
     * The landing screen is the LIST, and a deep link is what pushes a tab. The signal for "this
     * was a deep link" is `initialTab` naming something other than the default, and that is forced
     * by the assembly: `App.tsx:2667`'s `openSettings(tab = DEFAULT_SETTINGS_TAB)` defaults the
     * argument, so ⌘, the ••• menu, the sidebar and the palette all arrive here as
     * `initialTab === 'general'` and are indistinguishable from "no deep link" at this boundary.
     * The three real deep links in the app name a tab that is not General - "Manage labels…"
     * (`App.tsx:4097`), Help's keybindings link (`:4452`) and Manage favourites (`:3825`) - so the
     * rule lands each of them on its tab, with the back button, and lands every plain open on the
     * list. General stays one tap away, which is where a landing tab belongs on a phone anyway.
     */
    const [pushed, setPushed] = useState((routed ?? initial) !== DEFAULT_SETTINGS_TAB);

    /*
     * The section the sheet LANDS on, kept in a ref so the open-edge effect below can read it
     * without taking it as a dependency. With a surface it is the routed section (which is what
     * the deep link set); without one it is `initialTab`, as it always was.
     */
    const landingRef = useRef(routed ?? initial);
    landingRef.current = routed ?? initial;

    // Re-opening always lands on the requested tab: a deep link ("Manage labels…") must not be
    // overridden by wherever the user happened to be last time. Only the HELD selection needs
    // resetting - a surface is routed by the host, which is what changed `initialTab` in the first
    // place, so re-applying it here would be this component telling the host what it just said.
    useEffect(() => {
        if (props.open) setHeldTab(initial);
    }, [props.open, initial]);

    /*
     * …and the phone's screen is re-derived on the same edge, for the same reason.
     *
     * The second dependency is the SIGNAL to re-derive, not the value derived. Without a surface it
     * is `initialTab`, because that is the only way a deep link can arrive while the sheet is open.
     * With one it is a constant, because every plain navigation changes the routed section (and
     * therefore `initialTab`) too: keeping `initial` there would re-run this on every tap and
     * un-push the user the moment they opened the General row.
     */
    const pushSignal = surface === null ? initial : DEFAULT_SETTINGS_TAB;
    useEffect(() => {
        if (props.open) setPushed(landingRef.current !== DEFAULT_SETTINGS_TAB);
    }, [props.open, pushSignal]);

    useEffect(() => {
        if (!props.open) return;
        // The phone sheet has no rail to focus; its own rule is the effect below.
        if (phone) return;
        // `initial`, not `tab` (#176): this runs in the same commit as the reset above, before it
        // has re-rendered, so `tab` still holds wherever the last visit ended and focus would land
        // on that rail button while the rail selects `initial`.
        tabRefs.current.get(initial)?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge only: `initial` and
        // `phone` are left out on purpose. A deep link that arrives while the panel is already open
        // moves the selection but not focus (pre-existing; the phone effect below does follow it).
    }, [props.open]);

    /*
     * B5 - the phone sheet's focus, on the open edge AND on every push and pop.
     *
     * Not cosmetic: Escape is handled by `onKeyDown` on the dialog element, and React delivers a
     * keydown to that handler only when the event's target is inside it. A sheet that opened with
     * focus still on the pane behind it would have no Escape at all, which §10.4's choreography
     * (and the test that pins it) requires. So the list focuses the row for the current tab and a
     * pushed screen focuses its back button, which is also the reading order a screen reader
     * announces after each transition.
     *
     * `tab` is a dependency for the open edge (#176): the first run reads the last visit's tab,
     * because the reset above has not re-rendered yet, and a re-open that stays on the list changes
     * nothing else that would run this again. A phone only changes the tab by pushing it or on that
     * reset, so this never moves focus under a click inside a panel.
     */
    useEffect(() => {
        if (!props.open || !phone) return;
        if (pushed) backRef.current?.focus();
        else tabRefs.current.get(tab)?.focus();
    }, [props.open, phone, pushed, tab]);

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
        [tab, setTab]
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

    const currentLabel = SETTINGS_TABS.find((entry) => entry.id === tab)?.label ?? '';

    /*
     * The tab CONTENT, lifted out of the desktop panel so the phone sheet renders the SAME
     * elements with the SAME props. A fragment adds no node, so the desktop panel below is the
     * markup it always was; "no tab content changes" (B5) is enforced by there being exactly one
     * copy of this block rather than by a promise.
     */
    /*
     * One tab's content, drawn by the component that has always drawn it.
     *
     * `nativeOnly` is the half: the whole tab for the bundled panel, and the hand-built REMAINDER
     * when a presenter has the dialog. Three tabs take that half as a prop because three tabs have
     * a remainder - General's failed-bind line and footer, Workspaces' footer, Appearance's gallery,
     * colour map, theme picker and resets - and the other six are native in full, so the remainder
     * IS the tab.
     *
     * One list rather than two arms: which tab is a list of descriptors is `sections.ts`'s business
     * and changes as rows move onto the shared model, and a branch here that had to agree with it
     * was a second place for that fact to live.
     */
    const tabContent = (nativeOnly: boolean): ReactNode => (
        <>
            {tab === 'general' ? (
                <GeneralTab
                    settings={props.settings}
                    actions={props.actions}
                    paths={paths}
                    transport={props.transport ?? null}
                    {...(surface === null ? {} : { surface })}
                    {...(nativeOnly ? { part: 'native' as const } : {})}
                />
            ) : null}
            {tab === 'workspaces' ? (
                <WorkspacesTab
                    settings={props.settings}
                    actions={props.actions}
                    paths={paths}
                    {...(surface === null ? {} : { surface })}
                    {...(nativeOnly ? { part: 'native' as const } : {})}
                />
            ) : null}
            {tab === 'plugins' ? <div data-testid="settings-tab-plugins">{props.pluginContent ?? <p>Plugin management is unavailable.</p>}</div> : null}
            {tab === 'repositories' ? (
                <RepositoriesTab
                    repos={props.domain.repos ?? EMPTY_REPOSITORIES}
                    actions={props.actions}
                    paths={paths}
                    autoDetectRepos={props.settings.general.autoDetectRepos}
                    {...(props.onBrowseForFolder === undefined ? {} : { onBrowse: props.onBrowseForFolder })}
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
                    {...(surface === null ? {} : { surface })}
                    {...(nativeOnly ? { part: 'native' as const } : {})}
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
            {tab === 'web' ? (
                <WebTab
                    favourites={props.web?.favourites ?? EMPTY_FAVOURITES}
                    actions={props.web?.actions ?? NO_WEB_ACTIONS}
                    {...(props.web?.path === undefined ? {} : { path: props.web.path })}
                />
            ) : null}
            {tab === 'remote' ? (
                <RemoteTab
                    actions={props.remote ?? NO_REMOTE_ACTIONS}
                    daemons={props.settings.remoteDaemons}
                    {...(props.actions.setRemoteDaemons === undefined
                        ? {}
                        : { onSaveDaemons: props.actions.setRemoteDaemons.bind(props.actions) })}
                />
            ) : null}
        </>
    );

    /*
     * The rail and the panel, as ONE node.
     *
     * It is the bundled half of `SettingsPresenterSlot` on a desktop, and the whole dialog body on
     * a phone or without a surface, so there is exactly one copy of this markup whoever draws
     * around it. Nothing in it moved: same nodes, same classes, same test ids.
     */
    const panelRow = (
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
                {tabContent(false)}
            </div>
        </div>
    );

    /*
     * What the HOST keeps drawing when a presenter has the dialog.
     *
     * A section the bundled panel owns whatever is selected - Plugins in full, Remote, Profiles,
     * Repositories, Labels, Keybindings and its two recorders, Web - is drawn here, below the
     * frame, with the presenter still painting the rail beside it. That is what keeps the route to
     * "Restore bundled views" and "Retry presenter" in the same place whoever is painting, and it
     * is the same node either way: `tabContent` has exactly one copy.
     *
     * A partly projected section (projected fields plus a hand-built remainder) lands here too: the
     * frame draws the fields and this draws the rest.
     */
    const nativeRemainder = settingsSectionHasNative(tab) ? (
        <div
            role="group"
            aria-label={currentLabel}
            data-testid="settings-native-remainder"
            className="min-w-0 overflow-y-auto border-t p-4"
            /*
             * Sized to its CONTENT, not to half the dialog.
             *
             * Both boxes were `flex-1` at first, which reads as "share the body" - and a flex item
             * with a zero basis shares it evenly whatever is in it. General's remainder is two
             * sentences and a footer; it took half the height while the presenter's panel was
             * clipped mid-row. So: `flex: none` (a content-sized item that neither grows nor
             * shrinks), the presenter's frame keeps `flex: 1 1 0` beside it and takes the rest, and
             * a ceiling of 45% with the scroller this box already had stops Appearance's long
             * remainder - the preset gallery, the colour map, the share codes - from pushing the
             * frame out of the dialog. Inline rather than a class because it is a rule about this
             * box's relationship to its sibling, and because it is what the test can read back.
             */
            style={{ borderColor: tokens.divider, flex: 'none', maxHeight: '45%' }}
        >
            {tabContent(true)}
        </div>
    ) : null;

    if (phone) {
        return (
            <div
                data-testid="settings-backdrop"
                /*
                 * B5: no dim, no blur and no centring. The sheet covers the viewport, so a scrim
                 * would be a 390x844 rectangle nobody can see, and `backdropFilter` on a
                 * full-screen box is a compositing cost with no picture to show for it. The
                 * backdrop stays in the tree (it is what carries the test id every settings step
                 * looks for, and it is the stacking context) painted with the sheet's own token so
                 * a sub-pixel seam at the safe-area edge cannot show a different colour.
                 *
                 * `fixed`, not `absolute`: a sheet that claims to fill the SCREEN has to be
                 * positioned against the viewport rather than against whatever box it is mounted
                 * in. This overlay happens to sit at App's root today, where the two agree, but
                 * B1's `PhoneShell` replaces that assembly wholesale and the palette next door is
                 * already mounted one level in (§M53). The rule should not depend on the mount
                 * point. Nothing between here and the document is a containing block for a fixed
                 * element (`App.tsx:3921` and `:3979` are `position: relative` with no transform,
                 * filter or containment), so this resolves to the viewport and escapes the root's
                 * `overflow-hidden` - measured live by `phone-settings-sheet`.
                 */
                className="fixed inset-0 z-50 flex"
                style={{ background: tokens.surfaceBackground }}
            >
                <div
                    ref={dialogRef}
                    data-testid="settings-window"
                    data-phone-sheet="true"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Settings"
                    /*
                     * No radius, no border, no shadow: §S57's clamped width and the 620 px height
                     * are a WINDOW's geometry, and this is not a window. A sheet that fills the
                     * screen has no edge to draw and nothing behind it to lift off.
                     */
                    className="flex h-full w-full min-w-0 flex-col overflow-hidden"
                    style={{
                        background: tokens.surfaceBackground,
                        color: tokens.textPrimary,
                        ...PHONE_SAFE_AREA
                    }}
                    onKeyDown={onKeyDown}
                >
                    {/*
                     * One header for both screens (SET-004's toolbar, at a thumb's size): back and
                     * the tab's name when a tab is pushed, "Settings" when it is not, and Close on
                     * the trailing edge either way - "the close affordance stays reachable on both
                     * screens" is the requirement, and a header that only exists on one of them is
                     * how that gets lost.
                     */}
                    <div
                        data-testid="settings-toolbar"
                        className="flex shrink-0 items-center gap-2 border-b px-2"
                        style={{
                            background: tokens.headerBackground,
                            borderColor: tokens.divider,
                            minHeight: `${String(PHONE_ROW_MIN_PX)}px`
                        }}
                    >
                        {pushed ? (
                            <PhoneSheetButton
                                buttonRef={backRef}
                                testID="settings-phone-back"
                                ariaLabel="Back to Settings"
                                onClick={() => {
                                    setPushed(false);
                                }}
                            >
                                <span aria-hidden className="flex rotate-180 items-center">
                                    <ChromeIcon name="chevron-right" size={12} />
                                </span>
                                Settings
                            </PhoneSheetButton>
                        ) : null}
                        <span className="truncate text-[15px] font-semibold" style={{ color: tokens.textPrimary }}>
                            {pushed ? currentLabel : 'Settings'}
                        </span>
                        <span className="ml-auto">
                            <PhoneSheetButton testID="settings-close" onClick={props.onClose}>
                                Close
                            </PhoneSheetButton>
                        </span>
                    </div>

                    {pushed ? (
                        /*
                         * Not `role="tabpanel"`: there is no tablist on this screen to be a panel
                         * of, and an `aria-labelledby` pointing at a button that is not rendered
                         * is a broken relationship rather than a lenient one. A labelled group is
                         * what a pushed screen actually is. The test id is the desktop's, because
                         * it names the same thing.
                         */
                        <div
                            role="group"
                            aria-label={currentLabel}
                            data-testid="settings-panel"
                            className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4"
                        >
                            {tabContent(false)}
                        </div>
                    ) : (
                        <div
                            data-testid="settings-phone-list"
                            /*
                             * A group of buttons, not `role="list"`: a list wants `listitem`
                             * children, and putting that role on the row would REPLACE its button
                             * role - a screen reader would announce a list item that cannot be
                             * pressed. The rows are buttons; the group is what names them.
                             */
                            role="group"
                            aria-label="Settings sections"
                            className="min-h-0 flex-1 overflow-y-auto"
                        >
                            {SETTINGS_TABS.map((entry) => (
                                <PhoneTabRow
                                    key={entry.id}
                                    id={entry.id}
                                    label={entry.label}
                                    icon={entry.icon}
                                    registerRef={(node) => {
                                        if (node === null) tabRefs.current.delete(entry.id);
                                        else tabRefs.current.set(entry.id, node);
                                    }}
                                    onSelect={() => {
                                        setTab(entry.id);
                                        setPushed(true);
                                    }}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        );
    }

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
                        {currentLabel}
                    </span>
                    <span className="ml-auto">
                        <SettingsButton testID="settings-close" onClick={props.onClose}>
                            Close
                        </SettingsButton>
                    </span>
                </div>

                {/*
                  * Who draws the rail and the panel.
                  *
                  * The slot is the ONE decision point: with no surface, on a phone, with nothing
                  * selected, with the connection down or with this generation latched, it renders
                  * `panelRow` inside a `display: contents` wrapper - so the bundled dialog is the
                  * markup it has always been, node for node. With a presenter painting, the frame
                  * takes the row's box and the host draws the native remainder below it.
                  */}
                {surface === null ? (
                    panelRow
                ) : (
                    <SettingsPresenterSlot
                        surface={surface}
                        enabled={props.presenters === true}
                        visible
                        chords={props.presenterChords ?? NO_SETTINGS_CHORDS}
                        ownModals={props.modalPresence ?? 0}
                        /* `flex: 1 1 0` with `min-height: 0`: the frame takes whatever the
                         * content-sized remainder below it leaves, and may be shrunk to nothing
                         * rather than overflowing the dialog. */
                        className="flex min-h-0 flex-1"
                        onClose={props.onClose}
                        {...(props.onPresenterFailure === undefined
                            ? {}
                            : { onFailure: props.onPresenterFailure })}
                    >
                        {({ presented }) => (presented ? nativeRemainder : panelRow)}
                    </SettingsPresenterSlot>
                )}
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

// ── the phone sheet's own controls (B5) ─────────────────────────────────────────────

/**
 * The glyph size on the phone list.
 *
 * The rail's is 13 px, argued up one point from its 12 px text so it does not read smaller than
 * the word beside it (L88). The list's row is 44 px rather than 28.8 and its label is 15 px rather
 * than 12, so the same argument lands on 17: the glyph tracks the text it sits next to.
 */
const PHONE_GLYPH_SIZE = 17;

interface PhoneSheetButtonProps {
    readonly children: ReactNode;
    readonly testID: string;
    readonly ariaLabel?: string | undefined;
    readonly buttonRef?: RefObject<HTMLButtonElement | null> | undefined;
    readonly onClick: () => void;
}

/**
 * A header control sized for a thumb.
 *
 * Not `SettingsButton`: that one is 11 px text in `py-1` with a border, i.e. about 22 px tall, and
 * it draws a HOVER fill as its whole "this is clickable" signal (§H11). A phone has no hover -
 * `(hover: none)` is half of what `chrome/form-factor.ts` matched on - so the fill would never
 * appear and the control would be both inert-looking and half the height a thumb needs. This one
 * is `PHONE_ROW_MIN_PX` tall, carries the same tokens, and `settings/ui.tsx` is untouched (it is
 * shared by every tab and is not B5's to change).
 */
function PhoneSheetButton(props: PhoneSheetButtonProps): ReactElement {
    return (
        <button
            ref={props.buttonRef ?? null}
            type="button"
            data-testid={props.testID}
            aria-label={props.ariaLabel ?? undefined}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-[15px]"
            style={{ color: tokens.accent, minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

interface PhoneTabRowProps {
    readonly id: SettingsTabID;
    readonly label: string;
    readonly icon: SettingsTabIcon;
    readonly registerRef: (node: HTMLButtonElement | null) => void;
    readonly onSelect: () => void;
}

/**
 * One row of the phone sheet's tab list: the glyph, the name, a disclosure chevron.
 *
 * Name, glyph, order and count come from `SETTINGS_TABS` - the same catalog the desktop rail reads
 * - so the two navigations cannot drift. Deliberately NOT `role="tab"`: this row does not reveal a
 * panel beside it, it pushes a screen over the top of the list, and a `tab` with no visible
 * `tabpanel` is a promise to a screen reader that the DOM does not keep. There is no selected
 * state to paint either, for the same reason: on the list screen no tab is showing.
 *
 * The test id is the desktop rail's (`settings-tab-button-<id>`) because it names the same thing -
 * "the control that takes you to this tab" - which is what lets the audit's existing settings
 * helpers reach a tab on either form factor.
 */
function PhoneTabRow(props: PhoneTabRowProps): ReactElement {
    const Glyph = RAIL_GLYPH[props.icon];
    return (
        <button
            ref={props.registerRef}
            type="button"
            id={`settings-tab-${props.id}`}
            data-testid={`settings-tab-button-${props.id}`}
            data-icon={props.icon}
            className="flex w-full items-center gap-3 border-b px-4 text-left text-[15px]"
            style={{
                borderColor: tokens.divider,
                color: tokens.textPrimary,
                minHeight: `${String(PHONE_ROW_MIN_PX)}px`
            }}
            onClick={props.onSelect}
        >
            <span className="flex shrink-0 items-center" style={{ color: tokens.textSecondary }}>
                <Glyph size={PHONE_GLYPH_SIZE} />
            </span>
            <span className="min-w-0 flex-1 truncate">{props.label}</span>
            <span aria-hidden className="flex shrink-0 items-center" style={{ color: tokens.textTertiary }}>
                <ChromeIcon name="chevron-right" size={12} />
            </span>
        </button>
    );
}
