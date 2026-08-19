/**
 * The terminal's font: what it is, when it is ready, and how wide a cell is.
 *
 * Three things have to agree or the grid is wrong on screen:
 *
 *   1. **The family stack.** The Swift app rendered terminals with libghostty, which bundles
 *      `JetBrainsMono Nerd Font` and falls back to it for every glyph the user's configured
 *      font lacks — that is why powerlevel10k prompts looked right there. A browser has no
 *      such fallback: Menlo has no Powerline separators and nothing in the Nerd Font private
 *      use areas, so the same prompt renders as a row of tofu boxes. The client therefore
 *      ships the same family (`assets/fonts/`, SIL OFL) and puts it directly behind whatever
 *      the user configured: `[user] → JetBrainsMono Nerd Font → ui-monospace/Menlo → monospace`.
 *
 *   2. **Load timing.** `@font-face` is lazy: the file is only fetched when something asks to
 *      render with it, and `canvas.measureText` before that silently measures the FALLBACK.
 *      Both engines measure their cell exactly once, at construction — a measurement taken
 *      against Menlo and then painted with JetBrains Mono is how a pane ends up with cols the
 *      renderer cannot actually fit (filler overruns, clipped right edge). `loadTerminalFonts`
 *      is the gate: it asks the FontFace API for the faces we bundle and resolves when they
 *      are usable (or when they have definitively failed — a missing font must never wedge a
 *      pane), and everything that measures awaits it first.
 *
 *   3. **The measuring rule.** ghostty-web's renderer takes `Math.ceil(measureText('M').width)`
 *      as the cell width, so a pane measured with the raw fractional width asks for more
 *      columns than the canvas can draw — the canvas ends up wider than the pane and the right
 *      edge is clipped. `measureCellSize` mirrors the engine's own arithmetic, so the geometry
 *      computed before the engine exists matches the geometry it reports afterwards.
 */

/** The bundled family, declared by `styles.css`'s `@font-face` rules. */
export const BUNDLED_TERMINAL_FONT_FAMILY = 'JetBrainsMono Nerd Font';

/** Weights we actually ship (`assets/fonts/`); bold matters for SGR 1. */
export const BUNDLED_TERMINAL_FONT_WEIGHTS: readonly number[] = [400, 700];

/**
 * What every terminal falls back to, in order. The bundled Nerd Font sits in front of the
 * system stack so an unpatched user font still gets glyphs instead of tofu.
 */
export const TERMINAL_FONT_FALLBACKS = `"${BUNDLED_TERMINAL_FONT_FAMILY}", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

/** A family name needs quoting in a CSS font list unless it is a single safe identifier. */
function quoteFamily(family: string): string {
    const trimmed = family.trim();
    if (trimmed === '') return '';
    // Already quoted, or a comma-separated stack the user wrote themselves: pass it through.
    if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.includes(',')) return trimmed;
    return /^[A-Za-z][A-Za-z0-9-]*$/.test(trimmed) ? trimmed : `"${trimmed}"`;
}

/**
 * `[user's family] → bundled Nerd Font → system mono → monospace`.
 *
 * The user's ghostty `font-family` wins for the glyphs it has; everything it is missing —
 * Powerline separators, Nerd Font icons — comes from the bundled face instead of tofu.
 */
export function terminalFontStack(userFamily?: string | null | undefined): string {
    const head = quoteFamily(userFamily ?? '');
    return head === '' ? TERMINAL_FONT_FALLBACKS : `${head}, ${TERMINAL_FONT_FALLBACKS}`;
}

// ── readiness ───────────────────────────────────────────────────────────────────────

interface FontFaceSetLike {
    load(font: string, text?: string): Promise<unknown>;
    readonly ready?: Promise<unknown>;
    readonly status?: string;
}

function fontFaces(): FontFaceSetLike | null {
    if (typeof document === 'undefined') return null;
    const set = (document as Document & { fonts?: FontFaceSetLike }).fonts;
    return set !== undefined && typeof set.load === 'function' ? set : null;
}

/**
 * How long a pane will wait for the font before opening anyway. The bundled face is ~900 KB;
 * over a tailnet on a phone that is not instant, and a blank pane is worse than a pane that
 * corrects its metrics a moment later (which `onTerminalFontsReady` makes it do).
 */
export const TERMINAL_FONT_WAIT_MS = 3_000;

let pending: Promise<void> | null = null;
let ready = false;
const readyListeners = new Set<() => void>();

/**
 * True once the bundled faces have settled — loaded, or definitively failed. Callers use it to
 * skip the await entirely on the common path (every pane after the first).
 */
export function terminalFontsReady(): boolean {
    return ready;
}

/**
 * Fires when the faces settle, or immediately if they already have. Panes use it to re-measure
 * a grid they had to compute against the fallback face because the real one was still in
 * flight — the metrics correction that keeps a slow connection from being permanently wrong.
 */
export function onTerminalFontsReady(listener: () => void): () => void {
    if (ready) {
        listener();
        return () => undefined;
    }
    readyListeners.add(listener);
    return () => readyListeners.delete(listener);
}

function settle(): void {
    if (ready) return;
    ready = true;
    pending = null;
    cellCache.clear();
    for (const listener of [...readyListeners]) {
        readyListeners.delete(listener);
        try {
            listener();
        } catch {
            /* one bad listener must not strand the others */
        }
    }
}

/**
 * Load the bundled faces. Idempotent, cached, and it NEVER rejects: a font that fails to load
 * degrades to the system stack, which is exactly today's behaviour and infinitely better than
 * a pane that refuses to open. It also never waits longer than `TERMINAL_FONT_WAIT_MS`, so a
 * slow link costs a late correction rather than a missing terminal.
 */
export async function loadTerminalFonts(fontSize = 13, waitMs = TERMINAL_FONT_WAIT_MS): Promise<void> {
    if (ready) return;
    if (pending !== null) {
        await raceTimeout(pending, waitMs);
        return;
    }
    const set = fontFaces();
    if (set === null) {
        settle();
        return;
    }
    const size = Number.isFinite(fontSize) && fontSize > 0 ? Math.round(fontSize) : 13;
    pending = (async () => {
        try {
            await Promise.all(
                BUNDLED_TERMINAL_FONT_WEIGHTS.map((weight) =>
                    // The sample text matters: `document.fonts.load` only fetches the faces
                    // that cover the characters asked for, and the whole point of this font is
                    // the private-use icons, so ask for one of those too (U+E0B0, the
                    // Powerline separator every p10k prompt draws).
                    set
                        .load(`${String(weight)} ${String(size)}px "${BUNDLED_TERMINAL_FONT_FAMILY}"`, 'M\u{E0B0}')
                        .catch(() => undefined)
                )
            );
            if (set.ready !== undefined) await set.ready.catch(() => undefined);
        } catch {
            /* a font failure degrades to the system stack; it never blocks a pane */
        } finally {
            settle();
        }
    })();
    await raceTimeout(pending, waitMs);
}

async function raceTimeout(promise: Promise<void>, waitMs: number): Promise<void> {
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
        await promise;
        return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            promise,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, waitMs);
            })
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Test seam: forget that the fonts were loaded. */
export function resetTerminalFontsForTests(): void {
    pending = null;
    ready = false;
    readyListeners.clear();
    cellCache.clear();
}

// ── cell metrics ────────────────────────────────────────────────────────────────────

export interface MeasuredCell {
    readonly width: number;
    readonly height: number;
}

const cellCache = new Map<string, MeasuredCell>();

/**
 * Cell metrics for a font, using **the engine's own arithmetic**: ghostty-web takes
 * `ceil(measureText('M').width)` as the advance and `ceil(ascent + descent) + 2` as the line
 * box, and sizes its canvas to `cols × width`. Measuring any other way (the raw fractional
 * advance, say) hands the pane a column count whose canvas is wider than the pane itself —
 * which is exactly the clipped-right-edge bug.
 *
 * The cache is keyed by size+family and is cleared when the fonts finish loading, so a
 * measurement taken against the fallback face can never outlive it.
 */
export function measureCellSize(fontSize: number, fontFamily: string): MeasuredCell {
    const key = `${String(fontSize)}|${fontFamily}|${ready ? '1' : '0'}`;
    const cached = cellCache.get(key);
    if (cached !== undefined) return cached;
    const measured = measureUncached(fontSize, fontFamily);
    cellCache.set(key, measured);
    return measured;
}

function fallbackCell(fontSize: number): MeasuredCell {
    return {
        width: Math.max(1, Math.ceil(fontSize * 0.6)),
        height: Math.max(1, Math.ceil(fontSize * 1.2) + 2)
    };
}

function measureUncached(fontSize: number, fontFamily: string): MeasuredCell {
    if (typeof document === 'undefined') return fallbackCell(fontSize);
    try {
        // jsdom's `getContext` returns undefined (and logs), so this is `== null`, not `=== null`.
        const context = document.createElement('canvas').getContext('2d');
        if (context === null || context === undefined) return fallbackCell(fontSize);
        context.font = `${String(fontSize)}px ${fontFamily}`;
        const metrics = context.measureText('M');
        const width = Math.ceil(metrics.width);
        if (!Number.isFinite(width) || width <= 0) return fallbackCell(fontSize);
        const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.8;
        const descent = metrics.actualBoundingBoxDescent || fontSize * 0.2;
        const height = Math.ceil(ascent + descent) + 2;
        if (!Number.isFinite(height) || height <= 0) return { width, height: fallbackCell(fontSize).height };
        return { width, height };
    } catch {
        return fallbackCell(fontSize);
    }
}
