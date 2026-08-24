/**
 * The Settings empty-state glyphs (M45).
 *
 * `RepoRegistryView.swift:33-35` (`externaldrive`, 36 pt), `LabelPresetsSettingsView.swift:85-87`
 * (`tag`, 28 pt), `ProfilesSettingsView.swift:127-129` (`person.badge.key`, 34 pt) and
 * `SettingsView.swift:710-712` (`star`, 28 pt) each open their empty state with one large SF
 * Symbol. **None of the four exists in `chrome/icons.tsx`'s set** — its `ChromeIconName` union is
 * the sidebar / status-bar / pane-header glyph list, whose nearest members are `drive`
 * (`internaldrive`) and `diskio` (`externaldrive.badge.timemachine`), and there is nothing at all
 * near `tag`, `person.badge.key` or `star`. Adding four entries to that union would put Settings
 * glyphs in the chrome's shared table for no other caller, so they live here instead, drawn on
 * the SAME 12×12 grid and with the same stroke conventions `ChromeIcon` uses — so a Settings
 * glyph and a chrome glyph read as one family.
 *
 * "SF Symbols → hand-rolled SVG glyphs" is the ledgered Electron-impossibility class; this is one
 * more instance of it, and `LabelsTab.tsx`'s own `TrashGlyph` is the precedent inside Settings.
 */

import type { ReactElement } from 'react';

interface GlyphProps {
    /** The Swift `.font(.system(size:))` value, drawn 1:1 as CSS pixels. */
    readonly size: number;
}

function Glyph(props: { readonly size: number; readonly children: ReactElement }): ReactElement {
    return (
        <svg
            aria-hidden
            viewBox="0 0 12 12"
            width={props.size}
            height={props.size}
            fill="none"
            stroke="currentColor"
            // The stroke is scaled DOWN as the glyph grows: `ChromeIcon`'s 1.2 is tuned for
            // 12 px, and at 36 px it would draw a poster. SF Symbols keep an optical weight
            // instead, which at these sizes is roughly a constant 1.4 device pixels.
            strokeWidth={Math.max(0.45, (1.4 * 12) / props.size)}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {props.children}
        </svg>
    );
}

/** `externaldrive` — a drive enclosure with its activity pip. */
export function ExternalDriveGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <>
                <rect x="1.2" y="3.6" width="9.6" height="4.8" rx="1.2" />
                <circle cx="8.8" cy="6" r="0.6" fill="currentColor" stroke="none" />
                <path d="M3 6h3.2" />
            </>
        </Glyph>
    );
}

/** `tag` — a pennant with its eyelet. */
export function TagGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <>
                <path d="M6.3 1.4H10a.6.6 0 0 1 .6.6v3.7a1 1 0 0 1-.3.7l-4 4a1 1 0 0 1-1.4 0L1.6 7.1a1 1 0 0 1 0-1.4l4-4a1 1 0 0 1 .7-.3z" />
                <circle cx="8.4" cy="3.6" r="0.75" />
            </>
        </Glyph>
    );
}

/** `person.badge.key` — a head and shoulders with a key badged on the trailing side. */
export function PersonBadgeKeyGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <>
                <circle cx="4.7" cy="3.5" r="1.9" />
                <path d="M1.3 10.4c0-2 1.5-3.4 3.4-3.4 .8 0 1.5.2 2.1.6" />
                <circle cx="8.4" cy="7.9" r="1.4" />
                <path d="M9.5 8.7 11 10.2M10.1 9.3l-.6.6" />
            </>
        </Glyph>
    );
}

/** `star` — the outlined five-point star. */
export function StarGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <path d="M6 1.3 7.45 4.4l3.35.45-2.45 2.3.6 3.3L6 8.85 2.05 10.45l.6-3.3L.2 4.85l3.35-.45z" />
        </Glyph>
    );
}
