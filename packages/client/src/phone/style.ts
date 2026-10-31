/**
 * The phone shell's derived colours: the handoff canvas's raised cards, tinted waiting surfaces
 * and floating bar, written as mixes of the chrome tokens rather than as the canvas's hex values.
 *
 * The canvas was drawn dark, and its light boards were the same mixes over the light preset. Mixing
 * from `tokens` is what lets one set of components serve both: the chrome's `ThemeProvider` swaps
 * the variables underneath and every surface here follows, the same way a sidebar row does.
 */

import type { CSSProperties } from 'react';

import { perceivedLuminance, type ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';

function mix(color: string, percent: number, base: string): string {
    return `color-mix(in srgb, ${color} ${String(percent)}%, ${base})`;
}

/**
 * The few colours that cannot be a mix, because light and dark want different RULES rather than
 * different inputs: a light page raises its cards to white and fills its buttons with a deeper
 * blue under white text, where a dark one lifts its cards a shade and puts dark text on a lighter
 * blue. The shell writes these on its root for the bucket it is in; everything under it (its
 * sheets included) reads them through `phoneStyle`.
 */
export function phoneThemeVars(bucket: ChromeBucket): CSSProperties {
    const light = bucket === 'light';
    return {
        '--kelpi-phone-accent': light ? '#3F6BA6' : 'var(--kelpi-accent, #6F9BD8)',
        '--kelpi-phone-on-accent': light ? '#FFFFFF' : '#0A0A0C',
        '--kelpi-phone-card': light ? '#FFFFFF' : mix(tokens.textPrimary, 4, tokens.windowBackground),
        '--kelpi-phone-raised': light ? '#FFFFFF' : mix(tokens.textPrimary, 9, tokens.windowBackground),
        '--kelpi-phone-shadow': light ? '0 8px 24px rgba(43, 43, 46, 0.14)' : '0 10px 30px rgba(0, 0, 0, 0.45)',
        '--kelpi-phone-scrim': light ? 'rgba(20, 20, 24, 0.32)' : 'rgba(0, 0, 0, 0.55)'
    } as CSSProperties;
}

/** Text that reads on a fill of this colour: dark on a light swatch, white on a deep one. */
export function textOn(fill: string): string {
    return perceivedLuminance(fill) > 0.6 ? '#0A0A0C' : '#FFFFFF';
}

export const phoneStyle = {
    /** A filled button, the open bar segment: the accent, deepened on a light page. */
    accentFill: 'var(--kelpi-phone-accent, var(--kelpi-accent, #6F9BD8))',
    /** A card on the page: a host card, a workspace tile. */
    card: `var(--kelpi-phone-card, ${mix(tokens.textPrimary, 4, tokens.windowBackground)})`,
    cardBorder: mix(tokens.textPrimary, 12, tokens.windowBackground),
    /** The tile behind a glyph inside a card. */
    well: mix(tokens.textPrimary, 9, tokens.windowBackground),
    /** The floating location bar and the picker card above it. */
    bar: mix(tokens.textPrimary, 7, tokens.windowBackground),
    barBorder: mix(tokens.textPrimary, 15, tokens.windowBackground),
    raised: `var(--kelpi-phone-raised, ${mix(tokens.textPrimary, 9, tokens.windowBackground)})`,
    raisedBorder: mix(tokens.textPrimary, 17, tokens.windowBackground),
    /** The selected segment of the bar, the current row in a list. */
    selected: mix(tokens.textPrimary, 14, tokens.windowBackground),
    /** The well a segmented control sits in. */
    sunken: mix(tokens.textPrimary, 3, tokens.windowBackground),
    /** Something is waiting for the person: the card it is on, its outline, its badge. */
    waitingCard: mix(tokens.statusWaiting, 9, tokens.windowBackground),
    waitingBorder: mix(tokens.statusWaiting, 38, tokens.windowBackground),
    waitingBadge: mix(tokens.statusWaiting, 32, tokens.windowBackground),
    waitingText: mix(tokens.statusWaiting, 55, tokens.textPrimary),
    /** The ring round a waiting dot. */
    waitingHalo: mix(tokens.statusWaiting, 25, 'transparent'),
    /** Text on an accent fill. */
    onAccent: 'var(--kelpi-phone-on-accent, #0A0A0C)',
    scrim: 'var(--kelpi-phone-scrim, rgba(0, 0, 0, 0.55))',
    shadow: 'var(--kelpi-phone-shadow, 0 10px 30px rgba(0, 0, 0, 0.45))'
} as const;
