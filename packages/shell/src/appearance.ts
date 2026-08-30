/**
 * The two appearance facts the SHELL itself needs (APP-012 / SET-049, SET-219 / TERM-021).
 *
 * Everything else about appearance belongs to the client: the daemon parses both config files
 * and pushes a snapshot, and the window is just a frame around the page. Two things escape that
 * rule because they are decided outside the page:
 *
 *   1. **Window transparency.** Electron fixes `transparent` at `new BrowserWindow(...)` — it
 *      cannot be toggled later, unlike AppKit's `NSWindow.isOpaque`, which is what the Swift app
 *      flipped live (`SettingsFeature.swift:527-541`). So the shell has to know the ghostty
 *      `background-opacity` BEFORE it creates the window, which means reading the file rather
 *      than waiting for the daemon's snapshot to arrive over the status socket.
 *   2. **The web pane's find-highlight colours.** They are pasted into a page stylesheet by an
 *      injected script the main process installs, so the value has to exist in this process.
 *
 * Both reads follow `./hotkey.ts`'s discipline exactly: the same `@kelpi/core/config` parsers the
 * daemon uses, the same `KELPID_CONFIG_PATH` / `KELPID_GHOSTTY_CONFIG` overrides so a dev or test
 * shell never reads the developer's real files, and a missing/unreadable file is not an error —
 * it yields the shipped defaults.
 *
 * Pure (fs + parsing only): `./main.ts` owns the window and the injection.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
    DEFAULT_CHROME_SETTINGS,
    parseChromeSettings,
    parseConfigLines
} from '@kelpi/core/config';
import { expandTilde } from '@kelpi/daemon/lifecycle';

import { resolveConfigPath } from './hotkey.js';

/** The daemon's own override name, restated so the shell and the daemon cannot disagree. */
export const GHOSTTY_CONFIG_PATH_ENV = 'KELPID_GHOSTTY_CONFIG';

/** `~/.config/ghostty/config`, or `KELPID_GHOSTTY_CONFIG`. Never creates anything. */
export function resolveGhosttyConfigPath(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string {
    const override = env[GHOSTTY_CONFIG_PATH_ENV]?.trim();
    if (override !== undefined && override.length > 0) return path.resolve(expandTilde(override, home));
    return path.join(home, '.config', 'ghostty', 'config');
}

function readFile(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

/**
 * `background-opacity` from the ghostty config, clamped to 0…1.
 *
 * A deliberately tiny parser rather than an import of the daemon's `parseGhosttyAppearance`:
 * the shell needs ONE key, and the daemon's reader lives behind a service that opens watchers.
 * The line syntax is shared (`@kelpi/core/config`'s splitter), so the two cannot disagree about
 * what a line means.
 */
export function readBackgroundOpacity(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): number {
    const contents = readFile(resolveGhosttyConfigPath(env, home));
    let opacity = 1;
    for (const { key, value } of parseConfigLines(contents)) {
        if (key !== 'background-opacity') continue;
        const parsed = Number.parseFloat(value.trim());
        // Later lines win, and a malformed value keeps the previous one — ghostty's own rule.
        if (Number.isFinite(parsed)) opacity = Math.min(1, Math.max(0, parsed));
    }
    return opacity;
}

export interface WindowTransparency {
    /** The ghostty `background-opacity` this decision was taken from. */
    readonly opacity: number;
    /** True when the window must be created transparent (`opacity < 1`). */
    readonly transparent: boolean;
}

/**
 * SET-049's rule, transcribed: `isOpaque = opacity >= 1.0`.
 *
 * Below 1 the window is created transparent with a fully transparent `backgroundColor`, and the
 * page paints the fill: the client publishes `--kelpi-bg` at the same alpha (see the client's
 * `ThemeProvider`), so the desktop shows through the window fill and the pane fills while the
 * sidebar, header and popovers stay opaque — the same composite the Swift app produced by
 * marking each surface non-opaque.
 */
export function windowTransparency(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): WindowTransparency {
    const opacity = readBackgroundOpacity(env, home);
    return { opacity, transparent: opacity < 1 };
}

/**
 * Did an appearance change cross the boundary the window was created on?
 *
 * `transparent` cannot be toggled on a live `BrowserWindow`, so a change from 0.85 → 0.70 is
 * free (the page repaints) while 1.0 → 0.85 needs a new window. Rather than recreate one under
 * the user — which would tear down every embedded web view and the page's whole renderer — the
 * shell says so and the setting applies on the next launch. That is the honest cheap half of
 * SET-049, and it is stated in the notification the user sees.
 */
export function transparencyNeedsRelaunch(createdTransparent: boolean, opacity: number): boolean {
    return createdTransparent !== opacity < 1;
}

// ── §N31: the window's own background ───────────────────────────────────────────────

/**
 * `windowBackground` from shell-ui.md §2's preset table, both columns.
 *
 * Copied rather than imported, exactly as `./icon.ts` copies the status column and for the same
 * stated reason: the main process does not (and must not) load the renderer bundle. If the
 * preset table changes, both copies change with it — which is why each is named after its key.
 */
export const LIGHT_WINDOW_GROUND = '#EAE8E2';
export const DARK_WINDOW_GROUND = '#0A0A0C';

/**
 * What the window paints where nothing else has (§N31).
 *
 * `new BrowserWindow({ backgroundColor })` is the base colour Chromium's compositor uses for
 * every pixel no layer covers — a resize's newly-exposed edge, a frame produced before the page
 * has painted at the new size, a cold start before first paint. It was a hardcoded `#16161a`,
 * a value in NEITHER theme: 12 units off the dark ground, and a whole appearance away from the
 * light one, so every unpainted pixel of a light-chrome window flashed near-black. The ground
 * is a resolved value now, and it follows the theme for the life of the window.
 *
 * Deliberately NOT applied on the transparent path: below `background-opacity` 1 the window is
 * created with a fully transparent `backgroundColor` on purpose (§N17 / APP-012 — the desktop
 * must show through), and painting a ground there would make the window opaque again.
 */
export interface WindowGroundInput {
    /** `chrome-appearance`. Anything else (including undefined) reads as `system`. */
    readonly appearance?: string | undefined;
    /** The OS colour scheme, for the `system` case. */
    readonly systemDark?: boolean | undefined;
    /** `chrome-colors`: `"<light|dark>:<key>" → "RRGGBB"`. */
    readonly overrides?: Readonly<Record<string, string>> | undefined;
}

const HEX6_GROUND = /^#?[0-9a-fA-F]{6}$/;

/** `resolveChromeTheme`'s `windowBackground`, for the window frame. Always `#RRGGBB`. */
export function resolveWindowGround(input: WindowGroundInput = {}): string {
    const appearance = input.appearance;
    const bucket =
        appearance === 'light' || appearance === 'dark'
            ? appearance
            : input.systemDark === true
              ? 'dark'
              : 'light';
    const base = bucket === 'dark' ? DARK_WINDOW_GROUND : LIGHT_WINDOW_GROUND;
    const raw = input.overrides?.[`${bucket}:windowBackground`];
    // An unparseable override is ignored rather than painted — a mistyped hex must not blank
    // the window, the same rule `resolveTrayStatusPalette` follows for the tray dot.
    if (typeof raw !== 'string' || !HEX6_GROUND.test(raw.trim())) return base;
    const hex = raw.trim();
    return (hex.startsWith('#') ? hex : `#${hex}`).toUpperCase();
}

/** The same answer, read from the kelpi config file this process already owns. */
export function readWindowGround(
    systemDark: boolean,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): string {
    const contents = readFile(resolveConfigPath(env, home));
    const chrome = contents === '' ? DEFAULT_CHROME_SETTINGS : parseChromeSettings(contents);
    return resolveWindowGround({
        appearance: chrome.appearance,
        systemDark,
        overrides: chrome.colors
    });
}

export interface ShellSearchPalette {
    readonly match: string;
    readonly matchText: string;
    readonly current: string;
    readonly currentText: string;
}

/** SET-219's four keys, from the kelpi config (defaults = the Swift `KelpiGhosttyDefaults` hexes). */
export function readSearchPalette(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir()
): ShellSearchPalette {
    const contents = readFile(resolveConfigPath(env, home));
    const chrome = contents === '' ? DEFAULT_CHROME_SETTINGS : parseChromeSettings(contents);
    return {
        match: chrome.searchMatchColor,
        matchText: chrome.searchMatchTextColor,
        current: chrome.searchMatchCurrentColor,
        currentText: chrome.searchMatchCurrentTextColor
    };
}
