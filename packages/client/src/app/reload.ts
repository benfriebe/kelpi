/**
 * "Restart UI" — the ••• menu's way out of a wedged renderer.
 *
 * The daemon owns every pane, PTY and session; the renderer is a view of them, and a view can
 * be thrown away. That is what makes this safe where the other restarts are not: a reload
 * reconnects to the same daemon and replays every visible pane from its server-side VT
 * (`terminal/ingest.ts`), and the credentials it needs were remembered at boot before the
 * token was stripped from the address bar (`main.tsx`, `app/config.ts`), so the reloaded page
 * signs in exactly as the first one did. The shell's View ▸ Force Reload does the same thing
 * from the native menu; this is the same action within reach of a browser client and a
 * trackpad.
 *
 * A seam rather than a bare `location.reload()` in the menu: jsdom's `Location` is
 * unforgeable, so the menu test replaces this module instead of the browser.
 */
export function restartUI(): void {
    location.reload();
}
