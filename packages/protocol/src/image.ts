/**
 * The image pane contract (docs/content-panes.md, "Image panes").
 *
 * An image pane shows one image file, read-only. The daemon serves the file's bytes over the
 * same credentialed `/pane-assets/` route a markdown preview's sibling images use, so nothing
 * here moves pixels over the WebSocket. This module is the one place that says which files
 * are images, so the daemon's `open`, a ⌘-click in a terminal, the ⌘O panel and a markdown
 * preview's link click all agree.
 */

/**
 * Lower-cased extensions (no dot) that open as an image pane: the formats Chromium draws in an
 * `<img>`. HEIC and TIFF are left out on purpose, because the pane could only show an error.
 */
export const IMAGE_OPEN_EXTENSIONS: readonly string[] = ['png', 'apng', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'];

/** True when `filePath` ends in an image extension (case-insensitive). */
export function isImagePath(filePath: string): boolean {
    const base = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return false;
    return IMAGE_OPEN_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase());
}

/**
 * The broadcast a daemon sends when an open image pane's file changed on disk (written,
 * replaced or recreated). A client showing that pane fetches the file again; one that is not
 * ignores it. `version` only ever grows for a pane, so it doubles as a cache-buster.
 */
export const IMAGE_CHANGED_MESSAGE = 'image-changed';
