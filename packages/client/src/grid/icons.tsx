/**
 * The header's glyph set — hand-rolled inline SVG, deliberately dependency-free.
 *
 * The Swift app uses SF Symbols; there is no icon package in the client's dependency set
 * and none may be added, so these are 12×12 stroke shapes that read at header size. They
 * carry `aria-hidden` because every one of them sits inside a labelled control.
 */

import type { ReactElement } from 'react';

export type IconName =
    | 'document'
    | 'note'
    | 'plusminus'
    | 'globe'
    | 'tag'
    | 'branch'
    | 'zoom'
    | 'broadcast'
    | 'broadcast-off'
    | 'split-right'
    | 'split-down'
    | 'ellipsis'
    | 'close'
    | 'pencil'
    | 'eye'
    | 'refresh'
    | 'restart'
    | 'rename'
    | 'copy'
    | 'terminal'
    | 'font-smaller'
    | 'font-larger'
    | 'chevron-up'
    | 'chevron-down';

const PATHS: Record<IconName, ReactElement> = {
    document: (
        <>
            <path d="M3 1.5h4l2 2v7H3z" />
            <path d="M7 1.5v2h2" />
        </>
    ),
    note: (
        <>
            <path d="M2.5 2h7v8h-7z" />
            <path d="M4 4.5h4M4 6.5h4M4 8.5h2" />
        </>
    ),
    plusminus: (
        <>
            <path d="M3 3.5h3M4.5 2v3" />
            <path d="M3 8.5h6" />
            <path d="M7 3.5h2" />
        </>
    ),
    globe: (
        <>
            <circle cx="6" cy="6" r="4.2" />
            <path d="M1.8 6h8.4M6 1.8c1.6 1.8 1.6 6.6 0 8.4-1.6-1.8-1.6-6.6 0-8.4z" />
        </>
    ),
    /**
     * L34 — `tag.fill` is FILLED. `PaneHeaderView.swift:82` asks for the filled variant, and the
     * port drew the outline one, which at 8 px reads as a wireframe next to the solid status dot
     * beside it. One `evenodd` path: the tag body, then the eyelet as a second subpath so it
     * punches a hole rather than needing a background colour to paint over.
     */
    tag: (
        <path
            fill="currentColor"
            fillRule="evenodd"
            stroke="none"
            d="M1.8 5.6 5.6 1.8h4.6v4.6L6.4 10.2zM8.75 4a.75.75 0 1 0-1.5 0 .75.75 0 1 0 1.5 0"
        />
    ),
    branch: (
        <>
            <circle cx="3.5" cy="2.8" r="1.3" />
            <circle cx="3.5" cy="9.2" r="1.3" />
            <circle cx="8.5" cy="2.8" r="1.3" />
            <path d="M3.5 4.1v3.8M8.5 4.1v1.2c0 1.2-1 1.8-2.2 2-1 .2-2.8.6-2.8 2" />
        </>
    ),
    /**
     * L34 — `arrow.up.left.and.arrow.down.right` (`PaneHeaderView.swift:103`): TWO diagonal
     * arrows on one axis, not four corner brackets. The bracket form is the crop/frame glyph and
     * reads as "fit to frame"; the arrow pair is the one macOS uses for zoom, and it is what the
     * shipped ZOOM badge shows.
     */
    zoom: (
        <>
            <path d="M2.2 2.2 5.2 5.2M2.2 5.4V2.2h3.2" />
            <path d="M9.8 9.8 6.8 6.8M9.8 6.6v3.2H6.6" />
        </>
    ),
    broadcast: (
        <>
            <circle cx="6" cy="6" r="1.2" />
            <path d="M3.6 3.6a3.4 3.4 0 0 0 0 4.8M8.4 3.6a3.4 3.4 0 0 1 0 4.8" />
            <path d="M1.9 1.9a5.8 5.8 0 0 0 0 8.2M10.1 1.9a5.8 5.8 0 0 1 0 8.2" />
        </>
    ),
    'broadcast-off': (
        <>
            <path d="M2 2.5h2M5 2.5h2M8 2.5h2M2 9.5h2M5 9.5h2M8 9.5h2" />
            <path d="M2 2.5v2M2 7.5v2M10 2.5v2M10 7.5v2" />
        </>
    ),
    'split-right': (
        <>
            <rect x="1.5" y="2" width="9" height="8" rx="1" />
            <path d="M6 2v8" />
        </>
    ),
    'split-down': (
        <>
            <rect x="1.5" y="2" width="9" height="8" rx="1" />
            <path d="M1.5 6h9" />
        </>
    ),
    /**
     * §S40 — the overflow ••• the header folds its trailing buttons into below the width where
     * they stop fitting. Filled dots on this file's own 12-unit grid, geometrically identical
     * to `chrome/icons.tsx`'s `ellipsis`, so the two ••• menus in the app carry one glyph.
     */
    ellipsis: (
        <>
            <circle cx="2.6" cy="6" r="0.85" fill="currentColor" stroke="none" />
            <circle cx="6" cy="6" r="0.85" fill="currentColor" stroke="none" />
            <circle cx="9.4" cy="6" r="0.85" fill="currentColor" stroke="none" />
        </>
    ),
    close: <path d="m3 3 6 6M9 3l-6 6" />,
    pencil: (
        <>
            <path d="m2.5 9.5 1-2.5 5-5 1.5 1.5-5 5z" />
            <path d="M2.5 9.5 4 9" />
        </>
    ),
    eye: (
        <>
            <path d="M1.5 6S3.3 3 6 3s4.5 3 4.5 3-1.8 3-4.5 3S1.5 6 1.5 6z" />
            <circle cx="6" cy="6" r="1.2" />
        </>
    ),
    refresh: (
        <>
            <path d="M9.6 6a3.6 3.6 0 1 1-1.1-2.6" />
            <path d="M9.8 1.6v2.6H7.2" />
        </>
    ),
    restart: (
        <>
            <path d="M2.4 6a3.6 3.6 0 1 0 1.1-2.6" />
            <path d="M2.2 1.6v2.6h2.6" />
        </>
    ),
    /**
     * Rename: a pencil over the line it writes on.
     *
     * It used to be a bare serif "I" — the shape every OS uses for a TEXT CURSOR rather than for
     * an action — so the audit read it as an unexplained I-beam sitting in the pane header
     * (run-B m1). Same tooltip and accessible name ("Rename pane"); a glyph that says what the
     * button does. Distinct from `pencil` (markdown's edit toggle) by its baseline.
     */
    rename: (
        <>
            <path d="m2.4 7.6 1-2.4 4.1-4.1 1.4 1.4-4.1 4.1z" />
            <path d="M2.2 10.4h7.6" />
        </>
    ),
    /** §TERM-103: two offset sheets — the `doc.on.doc` the Swift's copy menu button uses. */
    copy: (
        <>
            <rect x="1.5" y="1.5" width="6.5" height="7" rx="1" />
            <path d="M4 10.5h5.5a1 1 0 0 0 1-1V4" />
        </>
    ),
    terminal: (
        <>
            <rect x="1.5" y="2" width="9" height="8" rx="1" />
            <path d="m3.5 4.5 2 1.5-2 1.5M6.5 8h2.5" />
        </>
    ),
    // §3.16's two preview font-size controls: a small "A" beside a minus / a plus.
    'font-smaller': (
        <>
            <path d="M1.6 8.4 3.6 3.6l2 4.8M2.3 6.8h2.6" />
            <path d="M7.2 6.4h3.4" />
        </>
    ),
    'font-larger': (
        <>
            <path d="M1.6 8.4 3.6 3.6l2 4.8M2.3 6.8h2.6" />
            <path d="M7.2 6.4h3.4M8.9 4.7v3.4" />
        </>
    ),
    // The search overlay's previous/next chevrons (`PaneSearchOverlay.tsx`), the same pair the
    // Swift overlay drew with SF Symbols `chevron.up` / `chevron.down`.
    'chevron-up': <path d="m3 7.4 3-3 3 3" />,
    'chevron-down': <path d="m3 4.6 3 3 3-3" />
};

/**
 * L25/L37 — the SF Symbol weight ramp, as stroke widths in the 12-unit viewBox.
 *
 * `PaneHeaderView.swift` and `PaneSearchOverlay.swift` do not draw every glyph at one weight:
 * the split icons are plain `.font(.system(size: 10))`, the search chevrons are `.medium`
 * (`PaneSearchOverlay.swift:50,60`) and both ✕ glyphs are `.semibold` at 9 pt
 * (`PaneHeaderView.swift:265`, `PaneSearchOverlay.swift:70`) — deliberately smaller AND bolder
 * than their neighbours. A stroke in viewBox units scales with `size`, so rendering the ✕ at 9
 * without a weight bump made it thinner than the 10 px icons beside it, which is the opposite of
 * what the Swift asks for.
 *
 * SF Symbols publishes no stroke numbers, so the two bumps are the ramp's usual proportions
 * (~15% for medium, ~40% for semibold) applied to the regular 1.1 — an approximation, and stated
 * as one.
 */
export const ICON_STROKE = { regular: 1.1, medium: 1.3, semibold: 1.5 } as const;

export type IconWeight = keyof typeof ICON_STROKE;

export interface IconProps {
    readonly name: IconName;
    readonly size?: number | undefined;
    readonly weight?: IconWeight | undefined;
    readonly className?: string | undefined;
}

export function Icon({ name, size = 12, weight = 'regular', className }: IconProps): ReactElement {
    return (
        <svg
            data-icon={name}
            data-weight={weight}
            aria-hidden="true"
            focusable="false"
            width={size}
            height={size}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={ICON_STROKE[weight]}
            strokeLinecap="round"
            strokeLinejoin="round"
            {...(className === undefined ? {} : { className })}
        >
            {PATHS[name]}
        </svg>
    );
}
