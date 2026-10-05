/**
 * Issue #339 - the click that brings a background window forward focuses the pane under it.
 *
 * Electron's `acceptFirstMouse` is off by default on macOS, and with it off Chromium's
 * `-[RenderWidgetHostViewCocoa acceptsFirstMouse:]` answers NO for a normal window: AppKit spends
 * the click on activating the window and never hands the `mouseDown` to the page. So a click on
 * the right pane of a background Kelpi brought the window forward with the ring and the caret
 * still on the left pane, and the next keystrokes went there. The shell now turns it on
 * (`packages/shell/src/main.ts`), which is what lets this module see that press at all.
 *
 * What the press then DOES is Ghostty's rule, which is what the Swift app shipped: its
 * `SurfaceView` keeps `acceptsFirstMouse` off and watches `leftMouseDown` with a local monitor
 * instead, and when the window or the app is not focused it makes the clicked surface first
 * responder and lets the click go no further, so it is not encoded to the pty
 * (`SurfaceView_AppKit.swift` `localEventLeftMouseDown`, Ghostty issue 2595). Here that is:
 *
 *   - the press focuses the pane it landed in, through the grid that owns that pane
 *     ({@link onActivationPress}), and
 *   - the whole gesture is consumed at the window, ahead of every other listener: no `vim`
 *     cursor jump or Claude Code click reported to the application, no selection started, and
 *     no button, header control or sidebar row pressed. Off a pane the click does exactly what
 *     it did before this module existed, which is activate the window and nothing else.
 *
 * WHICH press activated the window is the shell's to say. The renderer's own focus traffic
 * cannot tell it apart from a click that moves the keyboard back from a web pane's native view
 * (Chromium makes the clicked view first responder before dispatching the press in both cases),
 * and consuming that one would cost a sidebar click every time a web page had the keyboard. The
 * shell's `shell-activation` relay is about the OS window and nothing else (`state/activation.ts`,
 * `ui.appActive`). Its "active" report travels shell → daemon → here and can lose the race with
 * the press, so a press also counts when the OS made it (`event.timeStamp`, the platform time)
 * before that report arrived. Only the FIRST primary press after an inactive report is ever a
 * candidate, so a lost report costs at most one click.
 *
 * Every way this can fail to recognise the press (no shell, a page reloaded behind another app,
 * the report winning by more than a click's worth) leaves it an ordinary click, which with
 * `acceptFirstMouse` on still focuses the pane it lands in.
 */

type Listener = (target: Element) => void;

const listeners = new Set<Listener>();

/**
 * Hear the press that activated the window, with the element it landed on.
 *
 * Each `PaneGrid` subscribes and acts only on a press inside its own container, so a remote
 * workspace's grid focuses its pane through its own daemon exactly as its header and bodies do.
 */
export function onActivationPress(listener: Listener): () => void {
    listeners.add(listener);
    return (): void => {
        listeners.delete(listener);
    };
}

/**
 * The rule, without the DOM.
 *
 * `pending` is true from an inactive report until the first primary press after it;
 * `activeSince` is when the report that the window is active again arrived (null while it is
 * still inactive); `pressedAt` is the press's own `timeStamp`, on the same clock.
 */
export function isActivatingPress(pending: boolean, activeSince: number | null, pressedAt: number): boolean {
    if (!pending) return false;
    return activeSince === null || pressedAt < activeSince;
}

export interface ActivationClickOptions {
    /** Where presses arrive. The window, in the capture phase, so this runs before anyone else. */
    readonly target: Window;
    /** Whether the shell window is active, as last reported (`ui.appActive`). */
    readonly isActive: () => boolean;
    /** Subscribe to changes of it; returns the unsubscribe. */
    readonly onActiveChange: (listener: (active: boolean) => void) => () => void;
    /** The clock `event.timeStamp` is on. */
    readonly now?: () => number;
}

/** The pointer and compatibility mouse events of one press, in the order a browser raises them. */
const PRESSES = ['pointerdown', 'mousedown'] as const;
const RELEASES = ['pointerup', 'mouseup'] as const;

export function installActivationClick(options: ActivationClickOptions): () => void {
    const { target } = options;
    const now = options.now ?? ((): number => performance.now());

    let pending = !options.isActive();
    let activeSince: number | null = null;
    /** Where the consumed gesture is: its press seen, its release seen, or none in flight. */
    let phase: 'idle' | 'pressed' | 'released' = 'idle';
    let endTimer: ReturnType<typeof setTimeout> | null = null;

    const consume = (event: Event): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
    };

    const end = (): void => {
        phase = 'idle';
        if (endTimer !== null) {
            clearTimeout(endTimer);
            endTimer = null;
        }
    };

    const onPress = (event: Event): void => {
        // The compatibility `mousedown` of a `pointerdown` already consumed. A browser that
        // honours the cancelled `pointerdown` never raises it; one that does not must not let it
        // through either.
        if (phase === 'pressed' && event.type === 'mousedown') {
            consume(event);
            return;
        }
        end();
        if (!(event instanceof MouseEvent) || event.button !== 0 || !pending) return;
        const activating = isActivatingPress(pending, activeSince, event.timeStamp);
        pending = false;
        if (!activating) return;
        consume(event);
        phase = 'pressed';
        const landed = event.target;
        if (!(landed instanceof Element)) return;
        for (const listener of [...listeners]) listener(landed);
    };

    const onRelease = (event: Event): void => {
        if (phase === 'idle') return;
        consume(event);
        phase = 'released';
        // The `click` a release produces is dispatched in the same task as the release, so one
        // task later the gesture is over whether a click came or not (a release outside the
        // press's element raises none).
        endTimer ??= setTimeout(end, 0);
    };

    const onClick = (event: Event): void => {
        if (phase === 'idle') return;
        consume(event);
        end();
    };

    const unsubscribe = options.onActiveChange((active) => {
        if (active) {
            activeSince = now();
            return;
        }
        pending = true;
        activeSince = null;
    });
    for (const type of PRESSES) target.addEventListener(type, onPress, true);
    for (const type of RELEASES) target.addEventListener(type, onRelease, true);
    target.addEventListener('click', onClick, true);
    target.addEventListener('pointercancel', end, true);

    return (): void => {
        unsubscribe();
        for (const type of PRESSES) target.removeEventListener(type, onPress, true);
        for (const type of RELEASES) target.removeEventListener(type, onRelease, true);
        target.removeEventListener('click', onClick, true);
        target.removeEventListener('pointercancel', end, true);
        end();
    };
}
