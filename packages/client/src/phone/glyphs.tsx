/**
 * The phone shell's own glyphs, drawn on a 24 px grid.
 *
 * The chrome's icons (`chrome/icons.tsx`) are a 12 px grid for a sidebar row and a title bar, and
 * at a thumb's size they read thin. The phone's Home, location bar and picker were drawn on a 24
 * px grid in the handoff canvas, so these are those paths, stroked in `currentColor` like every
 * chrome glyph and decorative unless a label is given.
 */

import type { ReactElement } from 'react';

export type PhoneGlyphName =
    | 'agent'
    | 'terminal'
    | 'diff'
    | 'globe'
    | 'plugin'
    | 'doc'
    | 'note'
    | 'table'
    | 'image'
    | 'server'
    | 'check'
    | 'chevron-up'
    | 'chevron-down'
    | 'chevron-left'
    | 'chevron-right'
    | 'search'
    | 'plus'
    | 'x'
    | 'qr'
    | 'clipboard'
    | 'gear'
    | 'ellipsis'
    | 'layout'
    | 'folder'
    | 'bell'
    | 'bell-off'
    | 'retry'
    | 'pencil'
    | 'sync'
    | 'resize'
    | 'palette';

const PATHS: Readonly<Record<PhoneGlyphName, string>> = {
    agent: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    terminal: 'M4 6l5 5-5 5M12 18h8',
    diff: 'M12 3v8M8 7h8M8 19h8',
    globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18',
    plugin: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
    doc: 'M7 3h7l5 5v13H7zM14 3v5h5',
    note: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3',
    table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
    server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
    check: 'M5 12.5l4.5 4.5L19 7',
    'chevron-up': 'M6 15l6-6 6 6',
    'chevron-down': 'M6 9l6 6 6-6',
    'chevron-left': 'M15 6l-6 6 6 6',
    'chevron-right': 'M9 6l6 6-6 6',
    search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M16.5 16.5L20 20',
    plus: 'M12 5v14M5 12h14',
    x: 'M6 6l12 12M18 6L6 18',
    qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2',
    clipboard: 'M9 3h6v4H9zM9 5H6v16h12V5h-3M9 12h6M9 16h4',
    gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
    ellipsis: 'M5 12h.01M12 12h.01M19 12h.01',
    layout: 'M4 4h16v16H4zM12 4v16M12 12h8',
    folder: 'M3 6h6l2 2h10v11H3z',
    bell: 'M9 19a3 3 0 0 0 6 0M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3z',
    'bell-off': 'M9 19a3 3 0 0 0 6 0M6 9a6 6 0 0 1 9.5-4.9M18 11v3l2 3H8M3 3l18 18',
    retry: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    sync: 'M4 7h12M13 4l3 3-3 3M20 17H8M11 14l-3 3 3 3',
    resize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    palette: 'M5 7l5 5-5 5M12 17h7'
};

export interface PhoneGlyphProps {
    readonly name: PhoneGlyphName;
    readonly size?: number | undefined;
    /** Stroke width on the 24 px grid; the canvas drew most glyphs at 1.8 to 2. */
    readonly weight?: number | undefined;
    /** A label makes the glyph an image a screen reader announces; without one it is decoration. */
    readonly label?: string | undefined;
}

export function PhoneGlyph(props: PhoneGlyphProps): ReactElement {
    const size = props.size ?? 18;
    // The ellipsis is three dots, which only show at a heavier stroke.
    const weight = props.weight ?? (props.name === 'ellipsis' ? 3 : 1.9);
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={weight}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            data-glyph={props.name}
            {...(props.label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': props.label })}
        >
            <path d={PATHS[props.name]} />
        </svg>
    );
}
