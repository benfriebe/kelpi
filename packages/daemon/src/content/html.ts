/**
 * Shared HTML/theme primitives for the content renderers (content-panes.md §3.1–§3.2, §3.7).
 *
 * Both renderers (markdown, diff) emit a **complete HTML document** with an inline stylesheet
 * and an `<html class="dark|light">` chosen from the *ghostty background color's luminance* —
 * not the OS theme (§3.1 + port note 9). The page background itself stays transparent; the
 * pane container behind it paints `rgba(background, opacity)` so content panes blend with
 * terminal panes (§3.8).
 */

/** `& → &amp;`, `< → &lt;`, `> → &gt;`, `" → &quot;`, in that order (§3.2). */
export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export interface Rgb {
    readonly r: number;
    readonly g: number;
    readonly b: number;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa` (alpha ignored). Anything else → null. */
export function parseHexColor(color: string): Rgb | null {
    const raw = color.trim().replace(/^#/, '');
    const expand = (value: string): number => Number.parseInt(value.repeat(2), 16);
    if (/^[0-9a-fA-F]{3}$/.test(raw)) {
        return {
            r: expand(raw[0] as string),
            g: expand(raw[1] as string),
            b: expand(raw[2] as string)
        };
    }
    if (/^[0-9a-fA-F]{6}$/.test(raw) || /^[0-9a-fA-F]{8}$/.test(raw)) {
        return {
            r: Number.parseInt(raw.slice(0, 2), 16),
            g: Number.parseInt(raw.slice(2, 4), 16),
            b: Number.parseInt(raw.slice(4, 6), 16)
        };
    }
    return null;
}

/** `0.299r + 0.587g + 0.114b`, components in 0..1 (§3.1). Unparseable colors read as black. */
export function perceivedLuminance(color: string): number {
    const rgb = parseHexColor(color);
    if (rgb === null) return 0;
    return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

/** §3.1: `isDark = luminance < 0.5`. */
export function isDarkBackground(color: string): boolean {
    return perceivedLuminance(color) < 0.5;
}

/**
 * The daemon's fallback ghostty background. The Swift app reads the user's ghostty config; the
 * daemon has no ghostty, so callers pass a configured color and this is what they get when they
 * do not. It matches the web client's `--kelpi-term-bg` fallback so an unconfigured daemon and an
 * unconfigured client agree on light/dark.
 */
export const DEFAULT_CONTENT_BACKGROUND = '#0A0A0C';

/** §3.8: accepted for parity, unused by the renderers (the pane container applies it). */
export const DEFAULT_CONTENT_BACKGROUND_OPACITY = 1;

export interface ContentAppearance {
    /** Ghostty background color; picks the light/dark theme only. */
    readonly backgroundColor?: string | undefined;
    /** Threaded for parity with the Swift renderers, which also ignore it (§3.8). */
    readonly backgroundOpacity?: number | undefined;
}

export interface HtmlDocumentOptions {
    readonly isDark: boolean;
    /** Inline stylesheet contents (no `<style>` tags). */
    readonly style: string;
    /** Everything between `<body>` and `</body>`. */
    readonly body: string;
    /** `<base href>` so relative `<img src>` resolves (port note 4). */
    readonly baseHref?: string | undefined;
}

/** The §3.7 wrapper, shared by markdown and diff (§5.4: "same doctype/html-class/head"). */
export function htmlDocument(options: HtmlDocumentOptions): string {
    const base =
        options.baseHref === undefined
            ? ''
            : `<base href="${escapeHtml(options.baseHref)}">\n`;
    return (
        '<!DOCTYPE html>\n' +
        `<html class="${options.isDark ? 'dark' : 'light'}">\n` +
        '<head>\n' +
        '<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        base +
        '<style>\n' +
        options.style +
        '</style>\n' +
        '</head>\n' +
        '<body>\n' +
        options.body +
        '</body>\n' +
        '</html>\n'
    );
}
