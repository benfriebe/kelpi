/**
 * The chrome/status-bar settings parser.
 *
 * These keys are additive to config-keybindings.md §1.3 (the Swift app keeps them in
 * UserDefaults), so the thing worth asserting is that they obey the SAME parse discipline as
 * §1.3's own keys — later lines win, unknown keys are ignored, and a value that fails its rule
 * keeps the previous one rather than resetting the whole group. A hand-edited config with one
 * typo in it must lose that one line, not a palette.
 */

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_CHROME_SETTINGS,
    parseChromeColors,
    parseChromeHex,
    parseChromeSettings,
    parseSystemStatIDs,
    serializeChromeColors,
    serializeSystemStatIDs
} from './chrome.js';

describe('parseChromeSettings', () => {
    it('is the shipped defaults for an empty file', () => {
        expect(parseChromeSettings('')).toEqual(DEFAULT_CHROME_SETTINGS);
    });

    it('reads every key', () => {
        const parsed = parseChromeSettings(
            [
                'chrome-appearance = dark',
                'chrome-colors = {"dark:accent":"BD93F9"}',
                'sidebar-color-intensity = 1.4',
                'sidebar-avatar-fill = 0.3',
                'sidebar-avatar-stroke = 0.6',
                'sidebar-group-fill = 0.25',
                'sidebar-group-stroke = 0.1',
                'show-system-stats = false',
                'system-stats = network,cpu',
                'show-system-stat-graphs = true',
                'sparkline-style = dots',
                'sparkline-color = #FF8800',
                'sparkline-width = 44'
            ].join('\n')
        );
        expect(parsed.appearance).toBe('dark');
        expect(parsed.colors).toEqual({ 'dark:accent': 'BD93F9' });
        expect(parsed.sidebarColorIntensity).toBeCloseTo(1.4);
        expect(parsed.sidebarAvatarFill).toBeCloseTo(0.3);
        expect(parsed.sidebarAvatarStroke).toBeCloseTo(0.6);
        expect(parsed.sidebarGroupFill).toBeCloseTo(0.25);
        expect(parsed.sidebarGroupStroke).toBeCloseTo(0.1);
        expect(parsed.showSystemStats).toBe(false);
        // Canonical order, not the file's order.
        expect(parsed.enabledSystemStats).toEqual(['cpu', 'network']);
        expect(parsed.showSystemStatGraphs).toBe(true);
        expect(parsed.sparklineStyle).toBe('dots');
        expect(parsed.sparklineColor).toBe('#ff8800');
        expect(parsed.sparklineWidth).toBe(44);
    });

    it('keeps the previous value when a line fails its rule', () => {
        const parsed = parseChromeSettings(
            ['sparkline-width = 44', 'sparkline-width = wide', 'chrome-appearance = mauve'].join('\n')
        );
        expect(parsed.sparklineWidth).toBe(44);
        expect(parsed.appearance).toBe('system');
    });

    it('clamps a numeric value into its range instead of refusing it', () => {
        const parsed = parseChromeSettings(
            ['sidebar-color-intensity = 9', 'sidebar-avatar-fill = -3', 'sparkline-width = 200'].join('\n')
        );
        expect(parsed.sidebarColorIntensity).toBe(2);
        expect(parsed.sidebarAvatarFill).toBe(0);
        expect(parsed.sparklineWidth).toBe(80);
    });

    it('honours -1 as the group-fill sentinel', () => {
        expect(parseChromeSettings('sidebar-group-fill = -1').sidebarGroupFill).toBe(-1);
    });

    /**
     * The two booleans have OPPOSITE defaults, so they need opposite leniency: the on-by-default
     * one takes only a literal `false`, the off-by-default one only a literal `true`. Getting
     * this backwards silently inverts a setting for anyone with a typo in their config.
     */
    it('applies the leniency each boolean’s default calls for', () => {
        expect(parseChromeSettings('show-system-stats = nonsense').showSystemStats).toBe(true);
        expect(parseChromeSettings('show-system-stats = FALSE').showSystemStats).toBe(false);
        expect(parseChromeSettings('show-system-stat-graphs = nonsense').showSystemStatGraphs).toBe(false);
        expect(parseChromeSettings('show-system-stat-graphs = TRUE').showSystemStatGraphs).toBe(true);
    });

    /** SET-044's "Reset graph colour" writes an EMPTY value; it must not fall back. */
    it('treats an empty sparkline colour as “adaptive”, not as a parse failure', () => {
        const parsed = parseChromeSettings(['sparkline-color = #ff0000', 'sparkline-color = '].join('\n'));
        expect(parsed.sparklineColor).toBe('');
    });

    /** An empty metric set means "show none" and must not resurrect the default three. */
    it('treats an empty system-stats list as “no gauges”', () => {
        expect(parseChromeSettings('system-stats = ').enabledSystemStats).toEqual([]);
    });

    it('ignores unknown metric ids rather than failing the line', () => {
        expect(parseChromeSettings('system-stats = cpu,gpu,memory').enabledSystemStats).toEqual([
            'cpu',
            'memory'
        ]);
    });
});

describe('parseChromeColors', () => {
    it('normalizes each entry and drops the ones that are not colours', () => {
        expect(
            parseChromeColors('{"dark:accent":"#bd93f9","light:divider":"nope","dark:paneFocus":42}')
        ).toEqual({ 'dark:accent': 'BD93F9' });
    });

    it('yields an empty map for junk rather than throwing', () => {
        expect(parseChromeColors('not json')).toEqual({});
        expect(parseChromeColors('[1,2,3]')).toEqual({});
        expect(parseChromeColors('')).toEqual({});
    });

    it('round-trips through the serializer with sorted keys', () => {
        const serialized = serializeChromeColors({ 'light:accent': 'AABBCC', 'dark:accent': 'DDEEFF' });
        expect(serialized).toBe('{"dark:accent":"DDEEFF","light:accent":"AABBCC"}');
        expect(parseChromeColors(serialized)).toEqual({ 'dark:accent': 'DDEEFF', 'light:accent': 'AABBCC' });
    });
});

describe('system stat ids', () => {
    it('parses to canonical order and serializes sorted', () => {
        expect(parseSystemStatIDs('diskSpace, cpu  network')).toEqual(['cpu', 'network', 'diskSpace']);
        expect(serializeSystemStatIDs(['network', 'cpu', 'cpu'])).toBe('cpu,network');
        expect(serializeSystemStatIDs(['gpu'])).toBe('');
    });
});

describe('parseChromeHex', () => {
    it('accepts only a full six-digit hex', () => {
        expect(parseChromeHex('#AABBCC')).toBe('#aabbcc');
        expect(parseChromeHex('aabbcc')).toBe('#aabbcc');
        expect(parseChromeHex('#abc')).toBeNull();
        expect(parseChromeHex('rebeccapurple')).toBeNull();
    });
});
