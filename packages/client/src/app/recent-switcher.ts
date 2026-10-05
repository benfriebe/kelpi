/**
 * The ⌃Tab gesture (docs/superpowers/specs/2026-10-05-recent-workspace-switcher-design.md):
 * the first press snapshots the recent order and highlights the previous workspace, each further
 * press moves the highlight, and releasing the held modifiers commits. Framework-free so the
 * timing rules are unit-tested; `App.tsx` feeds it keydowns, keyups and window blur.
 */

export type HeldModifier = 'ctrl' | 'alt' | 'meta';

export interface ModifierSnapshot {
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
}

export interface SwitcherState {
    readonly order: readonly string[];
    readonly index: number;
    readonly shown: boolean;
}

/** A press released inside this window commits without the overlay ever painting. */
export const SWITCHER_SHOW_DELAY_MS = 150;

/**
 * A gesture started from a web page commits after this long with no further step, until the
 * window has seen a keyup of its own. The page holds the keyboard when the chord is forwarded, and
 * Chromium suppresses that view's keyups after a consumed keydown, so a quick ⌃ release never
 * reaches anyone (docs/config-keybindings.md §7.8).
 */
export const WEB_IDLE_COMMIT_MS = 400;

export interface RecentSwitcherDeps {
    order(): readonly string[];
    commit(workspaceID: string): void;
    onChange(state: SwitcherState | null): void;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(handle: unknown): void;
}

export interface RecentSwitcher {
    /** False when there is nothing to switch to, so the chord falls through to the pane. */
    step(direction: 1 | -1, held: readonly HeldModifier[], options?: { readonly showNow?: boolean }): boolean;
    keyUp(modifiers: ModifierSnapshot): void;
    /** True when a gesture was open (Escape belonged to it). */
    cancel(): boolean;
    blur(): void;
    pick(workspaceID: string): void;
    state(): SwitcherState | null;
}

/** The modifiers the gesture waits on: the trigger's own, minus Shift (which only picks direction). */
export function heldModifiersFromEvent(event: ModifierSnapshot): HeldModifier[] {
    const held: HeldModifier[] = [];
    if (event.ctrlKey) held.push('ctrl');
    if (event.altKey) held.push('alt');
    if (event.metaKey) held.push('meta');
    return held;
}

function isDown(modifier: HeldModifier, snapshot: ModifierSnapshot): boolean {
    if (modifier === 'ctrl') return snapshot.ctrlKey;
    if (modifier === 'alt') return snapshot.altKey;
    return snapshot.metaKey;
}

interface Gesture extends SwitcherState {
    readonly held: readonly HeldModifier[];
    /** The window has the keyboard, so the real release will arrive. */
    readonly live: boolean;
}

export function createRecentSwitcher(deps: RecentSwitcherDeps): RecentSwitcher {
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
    const clearTimer =
        deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let gesture: Gesture | null = null;
    let timer: unknown = null;

    const snapshot = (): SwitcherState | null =>
        gesture === null ? null : { order: gesture.order, index: gesture.index, shown: gesture.shown };
    const publish = (): void => deps.onChange(snapshot());
    const end = (): void => {
        if (timer !== null) clearTimer(timer);
        timer = null;
        gesture = null;
        publish();
    };
    const commit = (workspaceID: string | undefined): void => {
        end();
        if (workspaceID !== undefined) deps.commit(workspaceID);
    };
    const armIdleCommit = (): void => {
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => {
            timer = null;
            if (gesture !== null) commit(gesture.order[gesture.index]);
        }, WEB_IDLE_COMMIT_MS);
    };

    return {
        step(direction, held, options) {
            const showNow = options?.showNow === true;
            if (gesture === null) {
                const order = deps.order();
                if (order.length < 2) return false;
                const index = direction === 1 ? 1 : order.length - 1;
                if (held.length === 0) {
                    commit(order[index]);
                    return true;
                }
                gesture = { order, index, shown: showNow, held, live: !showNow };
                if (showNow) armIdleCommit();
                else {
                    timer = setTimer(() => {
                        timer = null;
                        if (gesture === null) return;
                        gesture = { ...gesture, shown: true };
                        publish();
                    }, SWITCHER_SHOW_DELAY_MS);
                }
                publish();
                return true;
            }
            const count = gesture.order.length;
            gesture = {
                ...gesture,
                index: (gesture.index + direction + count) % count,
                shown: gesture.shown || showNow
            };
            if (!gesture.live) armIdleCommit();
            publish();
            return true;
        },
        keyUp(modifiers) {
            if (gesture === null) return;
            if (gesture.held.some((modifier) => isDown(modifier, modifiers))) {
                // A keyup the WINDOW received with the gesture's modifier still down: it has the
                // keyboard now, so stop guessing and wait for the real release.
                if (!gesture.live) {
                    if (timer !== null) clearTimer(timer);
                    timer = null;
                    gesture = { ...gesture, live: true };
                }
                return;
            }
            commit(gesture.order[gesture.index]);
        },
        cancel() {
            if (gesture === null) return false;
            end();
            return true;
        },
        blur() {
            if (gesture !== null) commit(gesture.order[gesture.index]);
        },
        pick(workspaceID) {
            if (gesture !== null) commit(workspaceID);
        },
        state: snapshot
    };
}
