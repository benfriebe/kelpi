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
    /** Passed straight into `new BrowserWindow({...})`; absent on platforms without the style. */
    readonly titleBarStyle?: 'hiddenInset' | undefined;
    readonly trafficLightPosition?: { readonly x: number; readonly y: number } | undefined;
    /** The gutter to advertise to the page — 0 where there are no traffic lights to clear. */
    readonly gutter: number;
}

/**
 * What frame this platform gets.
 *
 * Only macOS has `hiddenInset` and only macOS has traffic lights, so Windows and Linux keep the
 * ordinary frame they already had AND are told to reserve nothing: a Linux build that reserved 80
 * px of empty leading space would be a regression invented by a macOS feature.
 */
export function titleBarStyleFor(platform: string): TitleBarStyleDecision {
    if (platform !== 'darwin') return { gutter: 0 };
    return {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y },
        gutter: TRAFFIC_LIGHT_GUTTER
    };
}

/** `&trafficLightInset=80`, or nothing at all when there is no gutter to declare. */
export function trafficLightQuery(decision: TitleBarStyleDecision): string {
    if (decision.gutter <= 0) return '';
    return `&${TRAFFIC_LIGHT_INSET_PARAM}=${String(decision.gutter)}`;
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
        `frameHeight=${String(frameHeight)} contentHeight=${String(contentHeight)} ` +
        `chromeHeight=${String(frameHeight - contentHeight)}`
    );
}
