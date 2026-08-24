/**
 * The web pane's own glyph set.
 *
 * Hand-rolled, like `grid/icons.tsx`: the client has no icon package and may not add one, and
 * these shapes are specific to the browser chrome rather than to the pane header's set.
 *
 * They live in their own module rather than inside `WebPane.tsx` because §M37 puts the **same**
 * `scope` crosshair in two places — the chrome's pickup button and the pickup panel's own header
 * — which is the pairing `WebBatchInspectPanel.swift:95-109` draws (`Image(systemName: "scope")`
 * in the panel header, accent-tinted, echoing `WebPaneChrome.swift:243-249`'s button). Importing
 * it back out of `WebPane.tsx` would be a cycle, since `WebPane.tsx` renders `BatchPanel`.
 */

import type { ReactElement } from 'react';

export const GLYPHS = {
    back: 'M7.5 2.5 4 6l3.5 3.5',
    forward: 'M4.5 2.5 8 6l-3.5 3.5',
    reload: 'M9.5 6a3.5 3.5 0 1 1-1.03-2.47M9.5 2v2.2H7.3',
    plus: 'M6 2.5v7M2.5 6h7',
    close: 'M3.5 3.5l5 5M8.5 3.5l-5 5',
    code: 'M4.2 3.5 1.7 6l2.5 2.5M7.8 3.5 10.3 6 7.8 8.5',
    /** §12's scope button: a crosshair, the cursor the armed picker puts on the page. */
    scope: 'M6 1.6v2M6 8.4v2M1.6 6h2M8.4 6h2M6 3.9A2.1 2.1 0 1 0 6 8.1a2.1 2.1 0 0 0 0-4.2',
    /** §13's storage panel: a cookie/database cylinder. */
    storage: 'M2.4 3.2c0-.9 1.6-1.6 3.6-1.6s3.6.7 3.6 1.6-1.6 1.6-3.6 1.6-3.6-.7-3.6-1.6ZM2.4 3.2v5.6c0 .9 1.6 1.6 3.6 1.6s3.6-.7 3.6-1.6V3.2M2.4 6c0 .9 1.6 1.6 3.6 1.6S9.6 6.9 9.6 6',
    /**
     * L63's bookmarks button: SF `book` — an open book, spine down the middle.
     *
     * `WebPaneChrome.swift:117` draws it at 22×22 beside the URL bar, which is where the port
     * now draws it too; the caret that used to live inside the field is gone.
     */
    book: 'M6 3.3C5 2.5 3.7 2.2 2.3 2.4v6.3c1.4-.2 2.7.1 3.7.9 1-.8 2.3-1.1 3.7-.9V2.4c-1.4-.2-2.7.1-3.7.9ZM6 3.3v6.3',
    /** WEB-040: `lock` — a private pane's storage button, shackle open on a persistent one. */
    lock: 'M3.4 5.4h5.2v4.2H3.4zM4.4 5.4V3.9a1.6 1.6 0 0 1 3.2 0v1.5',
    'lock-open': 'M3.4 5.4h5.2v4.2H3.4zM4.4 5.4V3.9a1.6 1.6 0 0 1 3.2 0'
} as const;

export type GlyphName = keyof typeof GLYPHS;

/**
 * L78 — the two SF Symbol weights the chrome actually uses, as stroke widths.
 *
 * `WebPaneChrome.swift:226,246` draw the scope and the padlock at
 * `weight: armed ? .semibold : .medium`, so an armed picker or an open storage panel is a
 * *heavier* glyph as well as an accent-coloured one. Every port glyph was pinned at `1.1`, which
 * is the medium, so the weight half of that signal was missing. `1.4` is the semibold: SF's
 * medium→semibold step is a ~25 % stroke increase at these sizes, which is what 1.1→1.4 is.
 */
export const GLYPH_STROKE_MEDIUM = 1.1;
export const GLYPH_STROKE_SEMIBOLD = 1.4;

export function Glyph({
    name,
    size = 12,
    strokeWidth = GLYPH_STROKE_MEDIUM
}: {
    readonly name: GlyphName;
    readonly size?: number;
    readonly strokeWidth?: number;
}): ReactElement {
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
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d={GLYPHS[name]} />
        </svg>
    );
}
