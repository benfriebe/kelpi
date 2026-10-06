/**
 * The ⌃Tab gesture (docs/config-keybindings.md §7.8):
 * the first press snapshots the recent order and highlights the previous workspace, each further
 * press moves the highlight, and releasing the held modifiers commits. Framework-free so the
 * timing rules are unit-tested; `App.tsx` feeds it keydowns, keyups and window blur.
 */

import { KELPI_ACTIONS, type KelpiAction } from '@kelpi/core/config';

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
 * How recent a release the window already saw may be and still belong to a relayed chord.
 *
 * A chord pressed in a web page reaches the window through the shell and the daemon, while the
 * shell hands the keyboard over at once, so a quick tap's ⌃ release can arrive BEFORE the chord
 * it ends. A release the window saw this soon before a press made in a page can only be that
 * press's own: until the hand-off the window had no keyboard to see one with
 * (docs/config-keybindings.md §7.8).
 */
export const RELAYED_RELEASE_GRACE_MS = 300;

export interface RecentSwitcherDeps {
    order(): readonly string[];
    commit(workspaceID: string): void;
    onChange?(state: SwitcherState | null): void;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(handle: unknown): void;
    now?(): number;
}

export interface StepOptions {
    /** The chord was pressed in a web page or a frame and passed on to the window. */
    readonly relayed?: boolean;
}

export interface RecentSwitcher {
    /** False when there is nothing to switch to, so the chord falls through to the pane. */
    step(direction: 1 | -1, held: readonly HeldModifier[], options?: StepOptions): boolean;
    keyUp(modifiers: ModifierSnapshot): void;
    /** True when a gesture was open (Escape belonged to it). */
    cancel(): boolean;
    blur(): void;
    pick(workspaceID: string): void;
    /** The current snapshot: the same object until the next change (`useSyncExternalStore`). */
    state(): SwitcherState | null;
    subscribe(listener: () => void): () => void;
}

/** The actions that drive a gesture; every other one is swallowed while it is open. */
export const RECENT_SWITCHER_ACTIONS: ReadonlySet<KelpiAction> = new Set(['next_recent_workspace', 'previous_recent_workspace']);

/**
 * The action registry while a gesture is open: the two recent actions as they are, every other
 * action swallowed. As under a modal, nothing acts behind the switcher - and nothing falls
 * through to the pane either, where a ⌃D would arrive as an EOF.
 */
export function actionsDuringGesture<H>(registry: Partial<Record<KelpiAction, H>>, swallow: H): Partial<Record<KelpiAction, H>> {
    return Object.fromEntries(
        KELPI_ACTIONS.map((action) => [action, RECENT_SWITCHER_ACTIONS.has(action) ? registry[action] : swallow])
    ) as Partial<Record<KelpiAction, H>>;
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
}

export function createRecentSwitcher(deps: RecentSwitcherDeps): RecentSwitcher {
    const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
    const clearTimer =
        deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const now = deps.now ?? ((): number => Date.now());
    let gesture: Gesture | null = null;
    let timer: unknown = null;
    let current: SwitcherState | null = null;
    /** The last keyup the window saw with no gesture open (see `RELAYED_RELEASE_GRACE_MS`). */
    let lastKeyUp: { readonly at: number; readonly modifiers: ModifierSnapshot } | null = null;
    const listeners = new Set<() => void>();

    const publish = (): void => {
        current = gesture === null ? null : { order: gesture.order, index: gesture.index, shown: gesture.shown };
        deps.onChange?.(current);
        for (const listener of [...listeners]) listener();
    };
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
    /** A relayed chord whose release the window has already seen: the gesture is over. */
    const alreadyReleased = (held: readonly HeldModifier[]): boolean =>
        lastKeyUp !== null &&
        now() - lastKeyUp.at <= RELAYED_RELEASE_GRACE_MS &&
        !held.some((modifier) => isDown(modifier, lastKeyUp!.modifiers));

    return {
        step(direction, held, options) {
            if (gesture === null) {
                const order = deps.order();
                if (order.length < 2) return false;
                const index = direction === 1 ? 1 : order.length - 1;
                const released = options?.relayed === true && alreadyReleased(held);
                lastKeyUp = null;
                if (held.length === 0 || released) {
                    commit(order[index]);
                    return true;
                }
                gesture = { order, index, shown: false, held };
                timer = setTimer(() => {
                    timer = null;
                    if (gesture === null) return;
                    gesture = { ...gesture, shown: true };
                    publish();
                }, SWITCHER_SHOW_DELAY_MS);
                publish();
                return true;
            }
            const count = gesture.order.length;
            gesture = { ...gesture, index: (gesture.index + direction + count) % count };
            publish();
            return true;
        },
        keyUp(modifiers) {
            if (gesture === null) {
                lastKeyUp = { at: now(), modifiers: { ctrlKey: modifiers.ctrlKey, altKey: modifiers.altKey, metaKey: modifiers.metaKey } };
                return;
            }
            if (gesture.held.some((modifier) => isDown(modifier, modifiers))) return;
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
        state: () => current,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        }
    };
}
