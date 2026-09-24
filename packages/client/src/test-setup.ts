/**
 * Shared setup for the client's jsdom suites.
 *
 * jsdom keeps one `localStorage` per test FILE, and the window persists real state in it: the view
 * selections, the sidebar width, and the root arrangement (`plugins/arrangement.ts`), which now
 * includes whether the sidebar and the Inspector are open. A test that opens the Inspector would
 * otherwise hand every later test in its file an open Inspector. Each test starts from an empty
 * store; one that needs saved state writes it itself.
 */
import { afterEach } from 'vitest';

afterEach(() => {
    try {
        globalThis.localStorage?.clear();
    } catch {
        /* a suite that stubbed storage away has nothing to clear */
    }
});
