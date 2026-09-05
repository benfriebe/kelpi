/**
 * Chrome styling + status-bar settings, parsed out of `~/.config/kelpi/config`.
 *
 * Spec: shell-ui.md §2 (chrome palette, sidebar tint knobs), §8.1 (status-bar gauges), and the
 * Swift `SettingsFeature.State` fields these mirror (`SettingsFeature.swift:52-77`).
 *
 * **Why these are config-file keys and not something else.** In the Swift app every one of
 * them is a `UserDefaults` value, which is a single-process store. This port's settings
 * authority is the daemon, and the daemon's store IS the config file — the same conclusion
 * shell-ui.md's port note already reached for the suppression flags. Making them lines in the
 * file gets three things at once: multiple attached clients agree, a hand-edit and a click are
 * the same operation, and the values survive a daemon restart with no new persistence surface.
 *
 * Kept in its own module rather than folded into `parseGeneralSettings` because these are a
 * different subject (how the window is painted, not how it behaves) and because `GeneralSettings`
 * is a compatibility-shaped type that the CLI, the shell's hotkey reader and the daemon all
 * consume — none of which have any use for a sparkline width.
 *
 * Parse discipline matches `general.ts` exactly: later lines win, unknown keys are ignored, and
 * **a value that fails its per-key rule keeps the prior/default value rather than resetting it**
 * (so one typo in a hand-edited file cannot blank a palette).
 */

import { parseConfigLines } from './lines.js';

export type ChromeAppearancePreference = 'system' | 'light' | 'dark';
export type SparklineStyle = 'line' | 'dots';

/** The six status-bar metrics, in canonical footer order (`SystemStatKind.allCases`). */
export const SYSTEM_STAT_IDS = ['cpu', 'memory', 'load', 'network', 'diskIO', 'diskSpace'] as const;
export type SystemStatID = (typeof SYSTEM_STAT_IDS)[number];

export interface ChromeSettings {
    readonly appearance: ChromeAppearancePreference;
    /** `"<light|dark>:<key>" → "RRGGBB"`. Empty when unset or unparseable. */
    readonly colors: Readonly<Record<string, string>>;
    readonly sidebarColorIntensity: number;
    readonly sidebarAvatarFill: number;
    readonly sidebarAvatarStroke: number;
    /** -1 = "use the appearance preset's `groupBandOpacity`" (the Swift sentinel). */
    readonly sidebarGroupFill: number;
    readonly sidebarGroupStroke: number;
    readonly showSystemStats: boolean;
    /** Canonical order, deduped. */
    readonly enabledSystemStats: readonly SystemStatID[];
    readonly showSystemStatGraphs: boolean;
    readonly sparklineStyle: SparklineStyle;
    /** `#rrggbb` or `''` for "the adaptive chrome tone". */
    readonly sparklineColor: string;
    readonly sparklineWidth: number;
    /**
     * The four search-highlight colours (TERM-021 / SET-219's `KelpiGhosttyDefaults`).
     *
     * The Swift app shipped them as a Kelpi-managed **ghostty defaults file** laid UNDER the
     * user's own `~/.config/ghostty/config`, so libghostty resolved `search-background` and
     * friends with the user's value winning. There is no libghostty here and no layering
     * mechanism to lay anything under: every search highlight in this port is drawn by us —
     * the injected markdown/diff find script, the web pane's find script, and the terminal
     * search reveal — so the Swift file's *purpose* (a Kelpi default the user can override)
     * becomes four kelpi-config keys with exactly the Swift hexes as their defaults.
     *
     * Same discipline as every other key here: an unparseable value keeps the default.
     */
    readonly searchMatchColor: string;
    readonly searchMatchTextColor: string;
    readonly searchMatchCurrentColor: string;
    readonly searchMatchCurrentTextColor: string;
}

/**
 * `NexGhosttyDefaults.swift:12-15`, verbatim: match yellow / black text, current-match orange /
 * black text. Exported because the client's find palettes and the shell's web-find script both
 * need the same fallbacks when no daemon snapshot has arrived yet.
 */
export const DEFAULT_SEARCH_MATCH_COLOR = '#f2d027';
export const DEFAULT_SEARCH_MATCH_TEXT_COLOR = '#000000';
export const DEFAULT_SEARCH_MATCH_CURRENT_COLOR = '#ff7a00';
export const DEFAULT_SEARCH_MATCH_CURRENT_TEXT_COLOR = '#000000';

export const DEFAULT_CHROME_SETTINGS: ChromeSettings = {
    appearance: 'system',
    colors: {},
    sidebarColorIntensity: 1,
    sidebarAvatarFill: 0.2,
    sidebarAvatarStroke: 0.45,
    sidebarGroupFill: -1,
    sidebarGroupStroke: 0,
    showSystemStats: true,
    enabledSystemStats: ['cpu', 'memory', 'load'],
    showSystemStatGraphs: false,
    sparklineStyle: 'line',
    sparklineColor: '',
    sparklineWidth: 28,
    searchMatchColor: DEFAULT_SEARCH_MATCH_COLOR,
    searchMatchTextColor: DEFAULT_SEARCH_MATCH_TEXT_COLOR,
    searchMatchCurrentColor: DEFAULT_SEARCH_MATCH_CURRENT_COLOR,
    searchMatchCurrentTextColor: DEFAULT_SEARCH_MATCH_CURRENT_TEXT_COLOR
};

const HEX6 = /^#?[0-9a-fA-F]{6}$/;

function parseNumberInRange(raw: string, min: number, max: number): number | null {
    const value = Number.parseFloat(raw.trim());
    if (!Number.isFinite(value)) return null;
    return Math.min(max, Math.max(min, value));
}

/** `#rrggbb`, lowercase. Anything else (a name, a short form, junk) is refused. */
export function parseChromeHex(raw: string): string | null {
    const trimmed = raw.trim();
    if (!HEX6.test(trimmed)) return null;
    return `#${trimmed.replace(/^#/, '').toLowerCase()}`;
}

/**
 * The `chrome-colors` blob: compact JSON of `"<bucket>:<key>" → "RRGGBB"`.
 *
 * Entries are validated individually — one bad colour drops that entry, not the map — and the
 * hex is normalized to bare uppercase `RRGGBB` (what `resolveChromeTheme` and the Swift
 * `ChromeStyleTheme` both store), so a `#`-prefixed hand-edit still resolves.
 */
export function parseChromeColors(raw: string): Record<string, string> {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '{}') return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const colors: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        if (!HEX6.test(value.trim())) continue;
        colors[key] = value.trim().replace(/^#/, '').toUpperCase();
    }
    return colors;
}

/** Serialize the override map back to the one-line form the file stores. */
export function serializeChromeColors(colors: Readonly<Record<string, string>>): string {
    const sorted = Object.keys(colors).sort();
    const out: Record<string, string> = {};
    for (const key of sorted) {
        const value = colors[key];
        if (value !== undefined) out[key] = value;
    }
    return JSON.stringify(out);
}

/**
 * The `system-stats` value: comma- (or space-) separated metric ids. Unknown ids are dropped,
 * duplicates collapse, and the result is returned in canonical order — so the file's sorted
 * storage form and the footer's render order are independent, exactly as in the Swift app
 * (which persists `sorted().joined(separator: ",")` and renders `allCases.filter`).
 *
 * An EMPTY value is meaningful ("show none") and must not fall back to the default set, which
 * is why this returns an array rather than null-on-empty.
 */
export function parseSystemStatIDs(raw: string): SystemStatID[] {
    const tokens = raw
        .split(/[,\s]+/)
        .map((token) => token.trim())
        .filter((token) => token !== '');
    const seen = new Set<string>(tokens);
    return SYSTEM_STAT_IDS.filter((id) => seen.has(id));
}

export function serializeSystemStatIDs(ids: readonly string[]): string {
    // Sorted on the way out, matching `SettingsFeature.swift:331-341`'s comma-joined sorted
    // string — so two clients that enable the same set write byte-identical lines.
    return [...new Set(ids.filter((id) => (SYSTEM_STAT_IDS as readonly string[]).includes(id)))]
        .sort()
        .join(',');
}

export function parseChromeSettings(contents: string): ChromeSettings {
    let settings: ChromeSettings = DEFAULT_CHROME_SETTINGS;
    for (const { key, value } of parseConfigLines(contents)) {
        const lowered = value.toLowerCase();
        switch (key) {
            case 'chrome-appearance':
                if (lowered === 'system' || lowered === 'light' || lowered === 'dark') {
                    settings = { ...settings, appearance: lowered };
                }
                break;
            case 'chrome-colors':
                settings = { ...settings, colors: parseChromeColors(value) };
                break;
            case 'sidebar-color-intensity': {
                const parsed = parseNumberInRange(value, 0, 2);
                if (parsed !== null) settings = { ...settings, sidebarColorIntensity: parsed };
                break;
            }
            case 'sidebar-avatar-fill': {
                const parsed = parseNumberInRange(value, 0, 1);
                if (parsed !== null) settings = { ...settings, sidebarAvatarFill: parsed };
                break;
            }
            case 'sidebar-avatar-stroke': {
                const parsed = parseNumberInRange(value, 0, 1);
                if (parsed !== null) settings = { ...settings, sidebarAvatarStroke: parsed };
                break;
            }
            case 'sidebar-group-fill': {
                // -1 is the "use the preset" sentinel, so the floor is -1 rather than 0.
                const parsed = parseNumberInRange(value, -1, 1);
                if (parsed !== null) settings = { ...settings, sidebarGroupFill: parsed };
                break;
            }
            case 'sidebar-group-stroke': {
                const parsed = parseNumberInRange(value, 0, 1);
                if (parsed !== null) settings = { ...settings, sidebarGroupStroke: parsed };
                break;
            }
            case 'show-system-stats':
                // Default is ON, so only a literal `false` disables — the same lenient rule
                // `global-hotkey-hide-on-repress` and `confirm-workspace-delete` use.
                settings = { ...settings, showSystemStats: lowered !== 'false' };
                break;
            case 'system-stats':
                settings = { ...settings, enabledSystemStats: parseSystemStatIDs(value) };
                break;
            case 'show-system-stat-graphs':
                // Default is OFF, so this one is opt-IN: only a literal `true` enables.
                settings = { ...settings, showSystemStatGraphs: lowered === 'true' };
                break;
            case 'sparkline-style':
                if (lowered === 'line' || lowered === 'dots') {
                    settings = { ...settings, sparklineStyle: lowered };
                }
                break;
            case 'sparkline-color': {
                // An EMPTY value is the documented "adaptive chrome default" (SET-044's
                // "Reset graph colour" writes exactly that), so it is accepted, not refused.
                if (value.trim() === '') {
                    settings = { ...settings, sparklineColor: '' };
                    break;
                }
                const hex = parseChromeHex(value);
                if (hex !== null) settings = { ...settings, sparklineColor: hex };
                break;
            }
            case 'sparkline-width': {
                const parsed = parseNumberInRange(value, 16, 80);
                if (parsed !== null) settings = { ...settings, sparklineWidth: Math.round(parsed) };
                break;
            }
            // The four search-highlight colours. Unlike `sparkline-color` an empty value is NOT
            // meaningful here (there is no "adaptive" search highlight to fall back to), so a
            // blank line keeps the Kelpi default exactly as a malformed one does.
            case 'search-match-color': {
                const hex = parseChromeHex(value);
                if (hex !== null) settings = { ...settings, searchMatchColor: hex };
                break;
            }
            case 'search-match-text-color': {
                const hex = parseChromeHex(value);
                if (hex !== null) settings = { ...settings, searchMatchTextColor: hex };
                break;
            }
            case 'search-match-current-color': {
                const hex = parseChromeHex(value);
                if (hex !== null) settings = { ...settings, searchMatchCurrentColor: hex };
                break;
            }
            case 'search-match-current-text-color': {
                const hex = parseChromeHex(value);
                if (hex !== null) settings = { ...settings, searchMatchCurrentTextColor: hex };
                break;
            }
            default:
                break;
        }
    }
    return settings;
}
