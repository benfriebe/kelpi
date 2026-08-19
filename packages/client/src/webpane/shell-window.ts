/**
 * "Am I the page inside a Nex shell window?"
 *
 * The Electron shell loads the UI with `?shellWindow=<uuid>` — the same id its web-pane host
 * connection declares to the daemon. Two things hang off that one answer:
 *
 *   - **web panes get real pixels.** The client reports where it drew a web pane's page area and
 *     the shell moves a native `WebContentsView` there; a client that is NOT a shell window
 *     draws the "open in the app" card instead, because nothing can paint a page for it.
 *   - **a notification click lands here and nowhere else.** The shell's reveal request names its
 *     window, so a phone attached to the same daemon does not jump because someone clicked a
 *     toast on the desktop.
 *
 * The marker deliberately survives `sanitizedSearch` (which only strips `daemon`/`token`): it is
 * not a credential, it identifies a window, and it has to still be there after a reload.
 */

/** The query parameter the shell appends to the client URL. */
export const SHELL_WINDOW_PARAM = 'shellWindow';

/**
 * The shell window this client is running in, or null in an ordinary browser.
 *
 * `search` defaults to the live location, so callers just call it; tests pass a string.
 */
export function readShellWindowID(search?: string): string | null {
    const raw =
        search ??
        (globalThis as { location?: { search?: string } }).location?.search ??
        '';
    if (raw.length === 0) return null;
    let value: string | null;
    try {
        value = new URLSearchParams(raw).get(SHELL_WINDOW_PARAM);
    } catch {
        return null;
    }
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}
