/**
 * Window frame persistence + the off-screen clamp (docs/current/shell-ui.md §1
 * "Window frame persistence (Electron shell)").
 *
 * The macOS app keeps the windowed frame in UserDefaults, skipping saves while it is in (or
 * transitioning to/from) native fullscreen, so the stored frame is always the windowed one.
 * On restore the frame is kept only if a screen fully fits it AND that screen contains the
 * window's top 28pt drag strip with at least 80pt of grabbable width; otherwise the window is
 * recentred on the current screen, shrunk to fit. The point is that a window restored from a
 * display that has since been unplugged must never come back with its title bar off-screen.
 *
 * Everything here is pure except the two file helpers, and the clamp takes plain rectangles
 * rather than Electron `Display` objects so it is unit-testable without a GUI.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** The slice of Electron's `Display` the clamp uses. */
export interface DisplayLike {
    readonly workArea: Rect;
}

/** shell-ui.md §1: "Window minimum size 600 × 400". */
export const MIN_WINDOW_WIDTH = 600;
export const MIN_WINDOW_HEIGHT = 400;
export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 820;

/** The title-bar strip that has to stay grabbable. */
export const DRAG_STRIP_HEIGHT = 28;
export const MIN_GRABBABLE_WIDTH = 80;

export const WINDOW_STATE_FILE = 'window-state.json';

export interface ShellWindowState {
    readonly bounds: Rect | null;
    readonly fullScreen: boolean;
    /**
     * §APP-060: is the window assigned to **all** Mission Control desktops?
     *
     * The Swift app read the user's Dock "Assign To → All Desktops" choice out of
     * `com.apple.spaces`'s `app-bindings` and applied it as `.canJoinAllSpaces` when the window
     * was first parented, so the assignment survived a reboot. That plist is private, undocumented
     * and version-fragile, and Electron cannot read the Dock's binding at all — so this port owns
     * the setting instead of borrowing it: the tray offers the toggle, `setVisibleOnAllWorkspaces`
     * applies it, and it is stored HERE so it survives a relaunch.
     *
     * The divergence is recorded rather than hidden: a user who sets the assignment from the DOCK
     * menu still gets it for that session (macOS applies it to the running app), but only the
     * in-app toggle persists across launches.
     */
    readonly visibleOnAllWorkspaces: boolean;
}

export const DEFAULT_WINDOW_STATE: ShellWindowState = {
    bounds: null,
    fullScreen: false,
    visibleOnAllWorkspaces: false
};

function overlap(aStart: number, aLength: number, bStart: number, bLength: number): number {
    return Math.max(0, Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart));
}

function contains(area: Rect, bounds: Rect): boolean {
    return (
        bounds.x >= area.x &&
        bounds.y >= area.y &&
        bounds.x + bounds.width <= area.x + area.width &&
        bounds.y + bounds.height <= area.y + area.height
    );
}

/** The drag strip is the top `DRAG_STRIP_HEIGHT` of the window. */
export function dragStrip(bounds: Rect): Rect {
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: DRAG_STRIP_HEIGHT };
}

/** Does this display expose enough of the window's title bar to grab it? */
export function stripIsGrabbable(area: Rect, bounds: Rect): boolean {
    const strip = dragStrip(bounds);
    const horizontal = overlap(strip.x, strip.width, area.x, area.width);
    const vertical = overlap(strip.y, strip.height, area.y, area.height);
    return horizontal >= MIN_GRABBABLE_WIDTH && vertical > 0;
}

function fitSize(bounds: Rect, area: Rect): { width: number; height: number } {
    return {
        width: Math.max(MIN_WINDOW_WIDTH, Math.min(bounds.width, area.width)),
        height: Math.max(MIN_WINDOW_HEIGHT, Math.min(bounds.height, area.height))
    };
}

function centreOn(area: Rect, bounds: Rect): Rect {
    const size = fitSize(bounds, area);
    return {
        x: Math.round(area.x + (area.width - size.width) / 2),
        y: Math.round(area.y + (area.height - size.height) / 2),
        ...size
    };
}

function shiftInto(area: Rect, bounds: Rect): Rect {
    const size = fitSize(bounds, area);
    return {
        x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - size.width)),
        y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - size.height)),
        ...size
    };
}

/**
 * Restore-time clamp.
 *
 * 1. A display whose work area fully contains the frame → keep it verbatim.
 * 2. Else a display that still shows a grabbable slice of the title bar → shift the frame
 *    into that display (shrinking it to fit).
 * 3. Else recentre on the primary display (first entry when none is named).
 * With no displays at all (a headless edge case) the frame is returned size-clamped only.
 */
export function clampBoundsToDisplays(
    bounds: Rect,
    displays: readonly DisplayLike[],
    primary?: DisplayLike | undefined
): Rect {
    const sized: Rect = {
        ...bounds,
        width: Math.max(MIN_WINDOW_WIDTH, Math.round(bounds.width)),
        height: Math.max(MIN_WINDOW_HEIGHT, Math.round(bounds.height))
    };
    if (displays.length === 0) return sized;

    for (const display of displays) {
        if (contains(display.workArea, sized) && stripIsGrabbable(display.workArea, sized)) return sized;
    }
    for (const display of displays) {
        if (stripIsGrabbable(display.workArea, sized)) return shiftInto(display.workArea, sized);
    }
    const home = primary ?? displays[0];
    return home === undefined ? sized : centreOn(home.workArea, sized);
}

/** The frame a first launch gets: default size, centred on the primary display. */
export function defaultBounds(primary: DisplayLike | undefined): Rect {
    const size = { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
    if (primary === undefined) return { x: 0, y: 0, ...size };
    return centreOn(primary.workArea, { x: 0, y: 0, ...size });
}

// ── persistence ─────────────────────────────────────────────────────────────────────

export function windowStateFile(userDataDir: string): string {
    return path.join(userDataDir, WINDOW_STATE_FILE);
}

function readRect(value: unknown): Rect | null {
    if (typeof value !== 'object' || value === null) return null;
    const source = value as Record<string, unknown>;
    const numbers = ['x', 'y', 'width', 'height'].map((key) => source[key]);
    if (!numbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null;
    const [x, y, width, height] = numbers as [number, number, number, number];
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
}

/** A missing / corrupt file is "no stored state", never an error. */
export function readWindowState(file: string): ShellWindowState {
    let raw: string;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return DEFAULT_WINDOW_STATE;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return DEFAULT_WINDOW_STATE;
    }
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_WINDOW_STATE;
    const source = parsed as Record<string, unknown>;
    return {
        bounds: readRect(source['bounds']),
        fullScreen: source['fullScreen'] === true,
        // Opt-IN: a file written before §APP-060 has no such key, and "not stored" means the
        // ordinary single-desktop window every user starts with.
        visibleOnAllWorkspaces: source['visibleOnAllWorkspaces'] === true
    };
}

/** Best effort: losing the frame is a cosmetic problem, never a crash. */
export function writeWindowState(file: string, state: ShellWindowState): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {
        // Read-only userData: the window simply opens at its default frame next time.
    }
}
