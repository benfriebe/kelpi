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
    | 'close'
    | 'pencil'
    | 'eye'
    | 'refresh'
    | 'restart'
    | 'rename'
    | 'terminal'
    | 'font-smaller'
    | 'font-larger';

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
    tag: (
        <>
            <path d="M1.8 5.6 5.6 1.8h4.6v4.6L6.4 10.2z" />
            <circle cx="8" cy="4" r="0.7" />
        </>
    ),
    branch: (
        <>
            <circle cx="3.5" cy="2.8" r="1.3" />
            <circle cx="3.5" cy="9.2" r="1.3" />
            <circle cx="8.5" cy="2.8" r="1.3" />
            <path d="M3.5 4.1v3.8M8.5 4.1v1.2c0 1.2-1 1.8-2.2 2-1 .2-2.8.6-2.8 2" />
        </>
    ),
    zoom: (
        <>
            <path d="M2 4.5V2h2.5M7.5 2H10v2.5M10 7.5V10H7.5M4.5 10H2V7.5" />
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
    )
};

export interface IconProps {
    readonly name: IconName;
    readonly size?: number | undefined;
    readonly className?: string | undefined;
}

export function Icon({ name, size = 12, className }: IconProps): ReactElement {
    return (
        <svg
            data-icon={name}
            aria-hidden="true"
            focusable="false"
            width={size}
            height={size}
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.1}
            strokeLinecap="round"
            strokeLinejoin="round"
            {...(className === undefined ? {} : { className })}
        >
            {PATHS[name]}
        </svg>
    );
}
