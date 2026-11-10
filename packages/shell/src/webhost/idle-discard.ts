/**
 * When an unused web tab is discarded (issue #467). The timing rule is kept pure so it can be
 * tested without Electron; `./tab.ts` does the discard and `./index.ts` decides whether the host
 * allows it.
 *
 * Every tab is a `WebContentsView` with its own renderer, and until #467 nothing closed one
 * except closing its pane. On 2026-11-09 the live app had 38 web tabs across 15 panes (mostly
 * GitHub pull requests left open for days) in 41 renderers totalling 10.3 GB, the largest share
 * of Kelpi's ~14.8 GB.
 *
 * **What counts as use.** Being on screen, and any verb that touches the page (`navigate`,
 * `capture`, `exec`, the actuator, a `wait` for as long as it runs). A tab that has been neither
 * for the delay is discarded: `./tab.ts` keeps its address, its back/forward history (with the
 * scroll position and form values Chromium saves per entry) and its zoom, and closes the view.
 * The registry keeps the tab, and it is rebuilt from that record when it is shown again or a
 * verb needs its page (`./registry.ts` ▸ `restore`).
 *
 * **Unlike #466's sleep, a tab that was never on screen counts too.** A background tab, or one of
 * the tabs every workspace's web panes build at launch, holds a whole renderer from the moment it
 * loads, so its clock starts when it is created.
 *
 * **Why a long delay.** A discarded tab comes back as a fresh load of the same page: scrolled to
 * where it was and with its form fields filled, but with any other in-page state (a playing
 * video, an unsent chat line held in a script, an agent's `window.x`) gone. An hour leaves
 * everything a person flips between alone and still collects the tabs left open for days.
 * `web-tab-discard-minutes` changes it, and 0 turns discarding off.
 */

/** How long a tab stays loaded with nothing using it, unless the setting says otherwise. */
export const DEFAULT_DISCARD_MINUTES = 60;

/**
 * The delay in milliseconds, or null when discarding is off: `KELPI_WEB_TAB_DISCARD_MS` when it
 * is a positive whole number (the web smoke, which cannot wait an hour), else the setting's
 * minutes, where 0 means never.
 */
export function discardDelay(
    minutes: number,
    env: Readonly<Record<string, string | undefined>>
): number | null {
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    const raw = env['KELPI_WEB_TAB_DISCARD_MS'];
    if (raw !== undefined && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
    return Math.round(minutes) * 60_000;
}

export interface IdleDiscardHooks {
    /**
     * The tab has been unused for the delay. Returns true when a discard is under way (the tab
     * then either goes away or calls `restart`), false when it was refused and the count should
     * start again.
     */
    discard(): boolean;
    readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

export interface IdleDiscardTimers {
    readonly set: (callback: () => void, ms: number) => unknown;
    readonly clear: (handle: unknown) => void;
}

export interface IdleDiscardOptions {
    /** Null: discarding is off until `setDelay` says otherwise. */
    readonly delayMs: number | null;
    /** Test seam; defaults to the global `setTimeout` / `clearTimeout`. */
    readonly timers?: IdleDiscardTimers | undefined;
}

export interface IdleDiscard {
    /** The view went into the shell window: it is in use for as long as it stays there. */
    placed(): void;
    /** The view went back to the holder: the count starts. */
    parked(): void;
    /**
     * Something is about to use the page. Keeps the tab loaded until the returned release is
     * called, then for the delay again. The release is safe to call more than once.
     */
    use(): () => void;
    /** The setting changed. The count starts again from now under the new delay. */
    setDelay(delayMs: number | null): void;
    /** A discard that was under way did not happen (the page asked to stay): count again. */
    restart(): void;
    dispose(): void;
}

const defaultTimers: IdleDiscardTimers = {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
};

export function createIdleDiscard(hooks: IdleDiscardHooks, options: IdleDiscardOptions): IdleDiscard {
    const timers = options.timers ?? defaultTimers;
    let delayMs = options.delayMs;
    /** A new tab starts in the holder, so it is idle from birth. */
    let embedded = false;
    let busy = 0;
    let disposed = false;
    let timer: unknown = null;

    const cancel = (): void => {
        if (timer === null) return;
        timers.clear(timer);
        timer = null;
    };

    const schedule = (): void => {
        cancel();
        if (disposed || embedded || busy > 0 || delayMs === null) return;
        timer = timers.set(fire, delayMs);
    };

    function fire(): void {
        timer = null;
        if (disposed || embedded || busy > 0 || delayMs === null) return;
        let started = false;
        try {
            started = hooks.discard();
        } catch (error) {
            hooks.onError?.(error, 'idle-discard');
        }
        // Refused (or failed): left loaded, exactly as every tab was before #467, and asked
        // again after another full delay rather than on every tick.
        if (!started) schedule();
    }

    schedule();

    return {
        placed() {
            if (disposed) return;
            embedded = true;
            cancel();
        },

        parked() {
            if (disposed) return;
            embedded = false;
            schedule();
        },

        use() {
            if (disposed) return () => {};
            busy += 1;
            cancel();
            let released = false;
            return () => {
                if (released) return;
                released = true;
                busy -= 1;
                schedule();
            };
        },

        setDelay(next) {
            if (disposed) return;
            delayMs = next;
            schedule();
        },

        restart() {
            schedule();
        },

        dispose() {
            disposed = true;
            cancel();
        }
    };
}
