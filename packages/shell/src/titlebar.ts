/**
 * §APP-046 — the hidden title bar, and the one number the page has to be told about.
 *
 * The shipped app is `.windowStyle(.hiddenTitleBar)` with its own 32pt strip drawn UP INTO the
 * traffic-light row (`NexApp.swift:50,205`; `ContentView.swift:611-615`'s
 * `ignoresSafeArea(.container, edges: .top)`). The port kept a standard frame for one stated
 * reason — "the client's top bar does not reserve the traffic lights' inset yet, so the buttons
 * would sit on top of its controls" — which left two stacked strips: a native title bar and the
 * client's own, one above the other.
 *
 * This module is the missing half. It fixes the geometry in ONE place and hands the page the only
 * part of it the page needs (how much leading room to keep clear), so the two sides cannot drift:
 * the shell positions the buttons, the client reserves the gutter, and a change to either is a
 * change to this file.
 *
 * There is no Electron in here, so the numbers and the URL parameter can be tested directly.
 */

/**
 * The client's title-bar strip, in CSS pixels — `TopBar`'s `h-8`, and shell-ui.md §3's "custom
 * 32pt-high bar". The traffic lights are centred against THIS, not against a native title bar,
 * because with `hiddenInset` there is no longer a native one.
 */
export const TITLE_BAR_HEIGHT = 32;

/** macOS's three window buttons are 12pt tall; centring them in the strip is the y inset. */
export const TRAFFIC_LIGHT_DIAMETER = 12;

/** Leading inset of the button cluster. 13 keeps the close button's centre near the 20pt mark. */
export const TRAFFIC_LIGHT_X = 13;

/** Vertically centred in the drawn strip: `(32 − 12) / 2`. */
export const TRAFFIC_LIGHT_Y = (TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2;

/**
 * How much leading room the PAGE must leave empty, in CSS pixels.
 *
 * 80 is the shipped app's own number (`WindowTitleBar.swift:82-95`, shell-ui.md §3: "80 leading
 * (clears traffic lights)"). The cluster itself ends at 13 + 52 = 65, so this is the Swift's
 * measurement with the Swift's slack, not a fresh guess.
 */
export const TRAFFIC_LIGHT_GUTTER = 80;

/** The query parameter the shell appends so the client knows what to reserve. */
export const TRAFFIC_LIGHT_INSET_PARAM = 'trafficLightInset';

export interface TitleBarStyleDecision {
    /** Passed straight into `new BrowserWindow({...})`; absent on platforms without a style. */
    readonly titleBarStyle?: 'hiddenInset' | 'hidden' | undefined;
    readonly trafficLightPosition?: { readonly x: number; readonly y: number } | undefined;
    /** The gutter to advertise to the page — 0 where there are no traffic lights to clear. */
    readonly gutter: number;
    /**
     * Whether the PAGE must draw the minimise / maximise / close cluster itself.
     *
     * True on Windows and Linux, and only there. macOS keeps native traffic lights (`hiddenInset`
     * positions them, and `gutter` is how the page gets out of their way); a browser tab has a
     * frame it does not own. This is the one bit those two cases cannot infer for themselves.
     */
    readonly windowControls: boolean;
    /**
     * Whether to fold the application menu bar away (Alt reveals it, accelerators keep working).
     *
     * Electron draws `Menu.setApplicationMenu`'s menu as an in-window strip on Windows and Linux.
     * On a KDE session it is usually exported to the desktop's global menu over DBus and no strip
     * appears — which is exactly the trap: the platform where it is INVISIBLE is the one a
     * developer is likely to test on. Windows has no such escape hatch, so an unhidden menu bar
     * there would put a strip above the drawn one and rebuild the two-stacked-strips defect this
     * whole item exists to remove.
     *
     * macOS has no in-window menu bar to hide (the menu lives in the system bar), so the flag is
     * false there and Electron ignores it either way.
     */
    readonly autoHideMenuBar: boolean;
}

/**
 * What frame this platform gets.
 *
 * All three desktop platforms now hide the native strip, so the client's own 32 px bar IS the
 * title bar everywhere — but they get there by two different routes, because only macOS can hand
 * the window's buttons to the page's care:
 *
 *   - **macOS** — `hiddenInset`. The three traffic lights are still drawn and still operated by
 *     AppKit; the shell only positions them (`trafficLightPosition`) and tells the page how much
 *     leading room to keep clear (`gutter`).
 *   - **Windows and Linux** — `hidden`. There is no equivalent of a positioned native cluster:
 *     Electron's `titleBarOverlay` (the Window Controls Overlay) is documented for both, but on a
 *     KDE/Wayland session Chromium reports `navigator.windowControlsOverlay.visible === true`,
 *     returns a titlebar-area rect spanning the FULL window width, and then draws no buttons at
 *     all. A frame whose controls exist only on some desktops is worse than none, so the page
 *     draws its own on both (`windowControls`) and nothing is reserved for a native cluster.
 *
 * `hidden` keeps the resize border on both: Windows through `thickFrame` (Electron's default, so
 * edge-drag, Aero Snap and the drop shadow survive), Linux through the window manager, which goes
 * on servicing edge drags for an undecorated window — verified on KDE/Wayland.
 *
 * What Windows gives up with a drawn cluster is the Snap Layouts flyout, which Windows shows only
 * for a real (or overlay-drawn) maximise button. Its keyboard equivalent, Win+Z, is untouched.
 *
 * Anything that is not one of the three keeps the ordinary frame it already had: an unknown
 * platform is exactly where inventing a frameless window with app-drawn controls could leave a
 * user with no way to close it.
 */
export function titleBarStyleFor(platform: string): TitleBarStyleDecision {
    if (platform === 'darwin') {
        return {
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y },
            gutter: TRAFFIC_LIGHT_GUTTER,
            windowControls: false,
            autoHideMenuBar: false
        };
    }
    if (platform === 'win32' || platform === 'linux') {
        // No `gutter`: the page draws the buttons, so it already knows how wide they are. The
        // one thing it cannot know is THAT it has to draw them, which is `windowControls`.
        return { titleBarStyle: 'hidden', gutter: 0, windowControls: true, autoHideMenuBar: true };
    }
    return { gutter: 0, windowControls: false, autoHideMenuBar: false };
}

/** `&trafficLightInset=80`, or nothing at all when there is no gutter to declare. */
export function trafficLightQuery(decision: TitleBarStyleDecision): string {
    if (decision.gutter <= 0) return '';
    return `&${TRAFFIC_LIGHT_INSET_PARAM}=${String(decision.gutter)}`;
}

/** The query parameter that asks the page to draw the window's own buttons. */
export const WINDOW_CONTROLS_PARAM = 'windowControls';

/**
 * `&windowControls=1`, or nothing at all.
 *
 * The third parameter of the same family as `?windowTransparent=` and `?trafficLightInset=`, and
 * for the same reason all three exist: the page cannot see the frame around it. Absent means
 * "something else draws the window's buttons, or there are none to draw" — which is right for
 * macOS (AppKit draws them), for a browser tab (the browser does), and for an unknown platform
 * (the ordinary frame does).
 */
export function windowControlsQuery(decision: TitleBarStyleDecision): string {
    return decision.windowControls ? `&${WINDOW_CONTROLS_PARAM}=1` : '';
}

/**
 * The line `createWindow` logs, so the smoke and the audit can assert the frame from OUTSIDE the
 * page — the one place the "two stacked strips" defect is visible.
 *
 * `frame` and `content` are the window's outer and inner heights. With a hidden title bar they
 * are equal; with a standard frame the content is ~28 px shorter, because the native strip has
 * taken that height for itself. That difference IS §APP-046's claim.
 */
export function titleBarLogLine(options: {
    readonly decision: TitleBarStyleDecision;
    readonly frameHeight: number;
    readonly contentHeight: number;
}): string {
    const { decision, frameHeight, contentHeight } = options;
    const style = decision.titleBarStyle ?? 'default';
    const lights =
        decision.trafficLightPosition === undefined
            ? 'none'
            : `${String(decision.trafficLightPosition.x)},${String(decision.trafficLightPosition.y)}`;
    return (
        `titlebar: style=${style} trafficLights=${lights} gutter=${String(decision.gutter)} ` +
        `windowControls=${decision.windowControls ? 'client' : 'native'} ` +
        `menuBar=${decision.autoHideMenuBar ? 'autohide' : 'default'} ` +
        `frameHeight=${String(frameHeight)} contentHeight=${String(contentHeight)} ` +
        `chromeHeight=${String(frameHeight - contentHeight)}`
    );
}
