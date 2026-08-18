/**
 * The favicon status badge — the web port of the macOS menu-bar dot and dock badge.
 *
 * agent-lifecycle.md §8.2/§8.4 and shell-ui.md §15 ("the web-only client can degrade to a
 * favicon badge/notification API. Keep the waiting-beats-running priority and theme-colored
 * dots"). So: a terminal glyph with a dot in the top-right corner —
 * `waiting > 0 → statusWaiting`, else `running > 0 → statusRunning`, else no dot — plus the
 * dock-badge equivalent, a waiting count folded into the document title.
 *
 * Everything is injectable. Canvas is unavailable in jsdom (and in any embedder that blocks
 * it), so `createFaviconController` takes a canvas factory and a document, and **degrades to a
 * no-op** rather than throwing when 2D rendering is not available: a missing favicon must
 * never be able to break the app.
 */

export interface FaviconSummary {
    readonly running: number;
    readonly waiting: number;
}

export interface FaviconColors {
    readonly running: string;
    readonly waiting: string;
    /** The glyph itself. */
    readonly foreground: string;
    /** Behind the glyph; transparent when omitted. */
    readonly background?: string | undefined;
}

export const DEFAULT_FAVICON_COLORS: FaviconColors = {
    running: '#5FBE89',
    waiting: '#6F9BD8',
    foreground: '#E6E6EA',
    background: '#0A0A0C'
};

/** §8.2: waiting wins over running; null = draw no dot at all. */
export function faviconBadgeColor(
    summary: FaviconSummary,
    colors: FaviconColors = DEFAULT_FAVICON_COLORS
): string | null {
    if (summary.waiting > 0) return colors.waiting;
    if (summary.running > 0) return colors.running;
    return null;
}

/** §8.4 dock badge → tab title: `(N) Nex` while agents wait, the bare title otherwise. */
export function titleWithBadge(title: string, waiting: number): string {
    return waiting > 0 ? `(${waiting}) ${title}` : title;
}

// ── canvas seams ────────────────────────────────────────────────────────────────────

export interface FaviconContext {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    lineCap: string;
    clearRect(x: number, y: number, w: number, h: number): void;
    fillRect(x: number, y: number, w: number, h: number): void;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    arc(x: number, y: number, radius: number, start: number, end: number): void;
    fill(): void;
    stroke(): void;
}

export interface FaviconCanvas {
    width: number;
    height: number;
    getContext(id: '2d'): FaviconContext | null;
    toDataURL(type?: string): string;
}

export interface DrawFaviconOptions {
    readonly size?: number | undefined;
    readonly colors?: FaviconColors | undefined;
}

/**
 * Draws the terminal glyph + badge and returns a data URL, or null when the canvas cannot
 * give a 2D context.
 */
export function drawFavicon(
    canvas: FaviconCanvas,
    summary: FaviconSummary,
    options: DrawFaviconOptions = {}
): string | null {
    const size = options.size ?? 32;
    const colors = options.colors ?? DEFAULT_FAVICON_COLORS;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;

    ctx.clearRect(0, 0, size, size);
    if (colors.background !== undefined) {
        ctx.fillStyle = colors.background;
        ctx.fillRect(0, 0, size, size);
    }

    // `❯_` — the terminal glyph, drawn as strokes so it stays crisp at 16/32px.
    ctx.strokeStyle = colors.foreground;
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(size * 0.22, size * 0.28);
    ctx.lineTo(size * 0.48, size * 0.5);
    ctx.lineTo(size * 0.22, size * 0.72);
    ctx.moveTo(size * 0.56, size * 0.72);
    ctx.lineTo(size * 0.8, size * 0.72);
    ctx.stroke();

    const badge = faviconBadgeColor(summary, colors);
    if (badge !== null) {
        const radius = size * 0.19;
        ctx.beginPath();
        ctx.arc(size - radius - 1, radius + 1, radius, 0, Math.PI * 2);
        ctx.fillStyle = badge;
        ctx.fill();
    }

    return canvas.toDataURL('image/png');
}

// ── document wiring ─────────────────────────────────────────────────────────────────

interface LinkLike {
    rel: string;
    type: string;
    href: string;
}

export interface FaviconDocument {
    title: string;
    readonly head: { appendChild(node: unknown): unknown } | null;
    querySelector(selectors: string): unknown;
    createElement(tag: 'link'): unknown;
}

export interface FaviconControllerOptions {
    readonly document?: FaviconDocument | undefined;
    readonly createCanvas?: (() => FaviconCanvas | null) | undefined;
    readonly size?: number | undefined;
    readonly colors?: FaviconColors | undefined;
    /** Base document title; the waiting count is prefixed onto it. */
    readonly title?: string | undefined;
    /** Set false to leave `document.title` alone (Electron owns the dock badge there). */
    readonly updateTitle?: boolean | undefined;
}

export interface FaviconController {
    /** Redraws only when the badge state actually changed. */
    update(summary: FaviconSummary): void;
    /** Restores the original href/title. */
    dispose(): void;
}

function defaultCanvasFactory(): FaviconCanvas | null {
    const doc = globalThis.document as { createElement?: (tag: string) => unknown } | undefined;
    const element = doc?.createElement?.('canvas');
    if (element === undefined || element === null) return null;
    return element as unknown as FaviconCanvas;
}

function isLink(value: unknown): value is LinkLike {
    return typeof value === 'object' && value !== null && 'href' in value;
}

/**
 * Keeps `<link rel="icon">` (and optionally the title) in sync with the agent summary. Safe to
 * construct anywhere: with no document, no canvas or no 2D context every method is inert.
 */
export function createFaviconController(options: FaviconControllerOptions = {}): FaviconController {
    const doc = options.document ?? (globalThis.document as unknown as FaviconDocument | undefined);
    const createCanvas = options.createCanvas ?? defaultCanvasFactory;
    const baseTitle = options.title ?? doc?.title ?? 'Nex';
    const updateTitle = options.updateTitle !== false;

    let link: LinkLike | null = null;
    let originalHref: string | null = null;
    let lastKey: string | null = null;

    if (doc !== undefined && doc !== null) {
        const existing = doc.querySelector('link[rel~="icon"]');
        if (isLink(existing)) {
            link = existing;
            originalHref = existing.href;
        } else {
            const created = doc.createElement('link');
            if (isLink(created)) {
                created.rel = 'icon';
                created.type = 'image/png';
                doc.head?.appendChild(created);
                link = created;
                originalHref = '';
            }
        }
    }

    return {
        update(summary: FaviconSummary): void {
            const key = `${summary.waiting > 0 ? 'w' : summary.running > 0 ? 'r' : '-'}:${summary.waiting}`;
            if (key === lastKey) return;
            lastKey = key;

            if (doc !== undefined && doc !== null && updateTitle) {
                doc.title = titleWithBadge(baseTitle, summary.waiting);
            }
            if (link === null) return;
            const canvas = createCanvas();
            if (canvas === null) return;
            const drawOptions: DrawFaviconOptions = {
                ...(options.size === undefined ? {} : { size: options.size }),
                ...(options.colors === undefined ? {} : { colors: options.colors })
            };
            const url = drawFavicon(canvas, summary, drawOptions);
            if (url !== null) link.href = url;
        },
        dispose(): void {
            if (link !== null && originalHref !== null && originalHref.length > 0) link.href = originalHref;
            if (doc !== undefined && doc !== null && updateTitle) doc.title = baseTitle;
            lastKey = null;
        }
    };
}
