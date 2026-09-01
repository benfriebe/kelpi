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

// ── the tab rail (L88) ──────────────────────────────────────────────────────────────
//
// `SettingsView.swift:20-59` labels every one of the seven tabs `Label(name, systemImage:)` —
// `gear`, `paintbrush`, `externaldrive`, `tag`, `person.badge.key`, `command`, `globe`. The port's
// rail carried the seven NAMES and nothing else, which is the one place in the window where the
// shipped app leans on the glyph: a tab rail is scanned, not read. Three of the seven already
// existed above (the empty states use them); the four below complete the set, drawn on the same
// 12 × 12 grid with the same stroke convention so a rail glyph and an empty-state glyph are one
// family.

/** `gear` — the toothed ring with its hub. */
export function GearGlyph(props: GlyphProps): ReactElement {
    // Eight teeth on a 12 × 12 grid, generated rather than hand-listed so they stay even.
    const teeth = [0, 45, 90, 135, 180, 225, 270, 315].map((degrees) => {
        const radians = (degrees * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const from = { x: 6 + cos * 3.5, y: 6 + sin * 3.5 };
        const to = { x: 6 + cos * 4.9, y: 6 + sin * 4.9 };
        return `M${from.x.toFixed(2)} ${from.y.toFixed(2)}L${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
    });
    return (
        <Glyph size={props.size}>
            <>
                <circle cx="6" cy="6" r="3.5" />
                <circle cx="6" cy="6" r="1.35" />
                <path d={teeth.join('')} />
            </>
        </Glyph>
    );
}

/** `paintbrush` — a bristle head on an angled handle. */
export function PaintbrushGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <>
                <path d="M10.4 1.6 6.1 5.9" />
                <path d="M5.0 4.6 7.4 7.0 5.1 9.3 2.7 6.9z" />
                <path d="M2.9 9.1 1.3 10.7" />
            </>
        </Glyph>
    );
}

/** `command` — the looped ⌘ cloverleaf. */
export function CommandGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <path d="M4.6 4.6h2.8v2.8H4.6zM4.6 4.6H3.2a1.4 1.4 0 1 1 1.4-1.4zM7.4 4.6h1.4a1.4 1.4 0 1 0-1.4-1.4zM4.6 7.4H3.2a1.4 1.4 0 1 0 1.4 1.4zM7.4 7.4h1.4a1.4 1.4 0 1 1-1.4 1.4z" />
        </Glyph>
    );
}

/** `globe` — the meridian-and-parallel world. */
export function GlobeGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <>
                <circle cx="6" cy="6" r="4.8" />
                <path d="M1.2 6h9.6" />
                <path d="M6 1.2c1.5 1.4 2.3 3 2.3 4.8S7.5 9.4 6 10.8C4.5 9.4 3.7 7.8 3.7 6s.8-3.4 2.3-4.8z" />
            </>
        </Glyph>
    );
}

/**
 * `square.grid.2x2` — the port-only **Workspaces** tab.
 *
 * There is no Swift symbol to copy because there is no Swift tab: `catalog.ts` appends this one
 * after the seven (SET-002). A rail where seven entries carry a glyph and the eighth carries a
 * gap would read as a broken row, so it gets the neutral grid symbol AppKit uses for "several of
 * a thing" — chosen here, not ported.
 */
export function GridGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <>
                <rect x="1.4" y="1.4" width="3.8" height="3.8" rx="0.9" />
                <rect x="6.8" y="1.4" width="3.8" height="3.8" rx="0.9" />
                <rect x="1.4" y="6.8" width="3.8" height="3.8" rx="0.9" />
                <rect x="6.8" y="6.8" width="3.8" height="3.8" rx="0.9" />
            </>
        </Glyph>
    );
}

/**
 * `antenna.radiowaves.left.and.right` — the port-only **Remote** tab (pair devices, tailnet
 * URLs). Like the Workspaces grid, there is no Swift tab to copy a symbol from: a mast with
 * a wave arc each side, on the same 12 × 12 grid and stroke convention as its rail siblings.
 */
export function AntennaGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <>
                <circle cx="6" cy="5.4" r="1.1" />
                <path d="M6 6.5v4.3" />
                <path d="M3.4 7.6a3.8 3.8 0 0 1 0-4.9" />
                <path d="M8.6 2.7a3.8 3.8 0 0 1 0 4.9" />
                <path d="M1.7 9.2a6.4 6.4 0 0 1 0-8.1" />
                <path d="M10.3 1.1a6.4 6.4 0 0 1 0 8.1" />
            </>
        </Glyph>
    );
}

/** `folder.badge.gearshape` — the Repositories toolbar's Scan button (L86). */
export function FolderBadgeGearGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <>
                <path d="M1.1 9.2V2.9h3.1l1 1.2h3.9v2" />
                <path d="M1.1 9.2h4.4" />
                <circle cx="8.6" cy="8.4" r="1.9" />
                <path d="M8.6 5.9v.7M8.6 10.2v.7M6.6 8.4h.7M9.9 8.4h.7" />
            </>
        </Glyph>
    );
}

/** `plus` — the Repositories toolbar's Add button (L86). */
export function PlusGlyph(props: GlyphProps): ReactElement {
    return (
        <Glyph size={props.size}>
            <path d="M6 1.9v8.2M1.9 6h8.2" />
        </Glyph>
    );
}
