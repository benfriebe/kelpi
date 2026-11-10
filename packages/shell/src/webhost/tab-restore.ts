/**
 * What a discarded tab keeps, and how it comes back (issue #467). Pure, so the history arithmetic
 * is testable without Electron; `./tab.ts` takes the record and runs the plan.
 *
 * **Why the rebuild is two steps.** Electron's `navigationHistory.restore()` puts a whole
 * back/forward list back, and each entry's `pageState` brings its scroll position and form values
 * with it. But it refuses to run on a view that has loaded anything ("Cannot restore history on
 * webContents that have previously loaded a page"), and `./tab.ts`'s bootstrap needs a loaded
 * renderer before CDP can install the injected scripts: a fresh view has no renderer and every
 * CDP command sent to it never answers. Loading the page first and installing the scripts after
 * would cost the document-start console lines and the actuator's early hooks.
 *
 * So the restore IS the renderer-raising load, pointed at an `about:blank` entry at the front of
 * the list (every tab's own bootstrap left one there, and one is added if Chromium's 50-entry cap
 * dropped it). The bootstrap then installs the scripts and the tab goes to the entry it was on,
 * which is a history navigation and restores that entry's page state. Measured on Electron 43.4
 * with a page scrolled to 1500 px and a filled form field: back/forward, the scroll position and
 * the field all came back, and a document-start script ran in the restored page.
 */

/** Electron's `NavigationEntry`, restated so this module needs no Electron. */
export interface HistoryEntry {
    readonly url: string;
    readonly title: string;
    readonly pageState?: string | undefined;
}

/** Everything a discarded tab's view leaves behind, beyond the address and title. */
export interface TabRestore {
    readonly entries: readonly HistoryEntry[];
    /** The entry the tab was on. */
    readonly index: number;
    /** Per tab, not per origin: `./tab.ts` re-applies it after every load. */
    readonly zoomFactor: number;
    /** §4.3: the address the tab was last asked for, which a reload of an error card retries. */
    readonly lastAttemptedURL: string;
    /** The tab was showing Kelpi's error card for `lastAttemptedURL`; it comes back showing it. */
    readonly failedLoad: boolean;
    /** WEB-033: the tab had been asked to load something, so its load brackets are reported. */
    readonly navigated: boolean;
}

export interface RestorePlan {
    /** The list to hand `navigationHistory.restore()`, `about:blank` first. */
    readonly entries: readonly HistoryEntry[];
    /**
     * The entry to go to once the scripts are in, or null when there is nothing to load. Always
     * the entry the tab was on, an error card included: loading anything else from the
     * `about:blank` the restore starts on would prune every entry after it.
     */
    readonly target: number | null;
}

const BLANK: HistoryEntry = { url: 'about:blank', title: '' };

export function restorePlan(restore: TabRestore): RestorePlan {
    const blankFirst = restore.entries[0]?.url === 'about:blank';
    const entries = blankFirst ? restore.entries : [BLANK, ...restore.entries];
    const index = Number.isInteger(restore.index) ? restore.index + (blankFirst ? 0 : 1) : -1;
    const entry = entries[index];
    const target = index > 0 && entry !== undefined && entry.url !== 'about:blank' && entry.url !== '' ? index : null;
    return { entries, target };
}
