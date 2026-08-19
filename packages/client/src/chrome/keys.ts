/**
 * The single keydown interceptor (WP3.5).
 *
 * Spec: docs/current/config-keybindings.md §7.2 (the pane-shortcut monitor pipeline) and §5
 * (the binding map). The map itself is NOT re-implemented here — `@nex/core/config` owns the
 * defaults, the override application and the trigger identity, so the client and the daemon
 * agree on what a config file means by construction.
 *
 * **Key identity.** Config files store macOS virtual key codes by name (`super+d`), which is a
 * *physical* key identity. PLAN.md's decision is to keep that as canonical storage and match
 * it against `KeyboardEvent.code` (also physical) in clients — so this module owns exactly one
 * new table: `code` → macOS keyCode. Matching on `code` (never `key`) means a binding survives
 * a non-US layout and a shifted character: `super+=` fires for ⌘⇧= on a US layout because both
 * produce `code: "Equal"`.
 *
 * **One layer, not two.** The Swift app splits dispatch between an OS menu-bar layer (16
 * `MENU_BAR_ACTIONS`) and the pane-shortcut monitor, and the monitor deliberately refuses the
 * menu actions (§7.2 step 6) because the OS already delivered them. A web client has no menu
 * layer, so this interceptor dispatches both sets. The distinction survives in one place where
 * it still earns its keep: while a text field is focused, only menu-bar actions fire — that is
 * exactly the behavior the split produced on macOS (the OS menu still works while you type in
 * the sidebar filter; ⌘D-style pane commands do not steal your keystrokes).
 */

import {
    DEFAULT_KEYBINDINGS,
    MENU_BAR_ACTIONS,
    actionForTrigger,
    applyKeybindOverrides,
    keyTriggerDisplayString,
    makeKeyTrigger,
    parseKeybindValue,
    resolveKeyBindings,
    triggersForAction,
    type KeyBindingMap,
    type KeyModifier,
    type KeyTrigger,
    type NexAction
} from '@nex/core/config';

// ── KeyboardEvent.code → macOS virtual key code ─────────────────────────────────────

/**
 * Physical-key table. Values are the same macOS key codes `@nex/core/config`'s
 * `KEY_NAME_TO_CODE` produces, so a trigger parsed from the config file and a trigger built
 * from a DOM event are the same `keyTriggerKey`.
 */
export const CODE_TO_KEY_CODE: ReadonlyMap<string, number> = new Map([
    ['KeyA', 0], ['KeyB', 11], ['KeyC', 8], ['KeyD', 2], ['KeyE', 14], ['KeyF', 3],
    ['KeyG', 5], ['KeyH', 4], ['KeyI', 34], ['KeyJ', 38], ['KeyK', 40], ['KeyL', 37],
    ['KeyM', 46], ['KeyN', 45], ['KeyO', 31], ['KeyP', 35], ['KeyQ', 12], ['KeyR', 15],
    ['KeyS', 1], ['KeyT', 17], ['KeyU', 32], ['KeyV', 9], ['KeyW', 13], ['KeyX', 7],
    ['KeyY', 16], ['KeyZ', 6],
    ['Digit1', 18], ['Digit2', 19], ['Digit3', 20], ['Digit4', 21], ['Digit5', 23],
    ['Digit6', 22], ['Digit7', 26], ['Digit8', 28], ['Digit9', 25], ['Digit0', 29],
    ['Enter', 36], ['NumpadEnter', 36], ['Tab', 48], ['Escape', 53], ['Space', 49],
    ['Backspace', 51], ['Delete', 117],
    ['ArrowLeft', 123], ['ArrowRight', 124], ['ArrowDown', 125], ['ArrowUp', 126],
    ['BracketLeft', 33], ['BracketRight', 30], ['Semicolon', 41], ['Quote', 39],
    ['Backquote', 50], ['Comma', 43], ['Period', 47], ['Slash', 44], ['Backslash', 42],
    ['Minus', 27], ['Equal', 24],
    ['F1', 122], ['F2', 120], ['F3', 99], ['F4', 118], ['F5', 96], ['F6', 97],
    ['F7', 98], ['F8', 100], ['F9', 101], ['F10', 109], ['F11', 103], ['F12', 111]
]);

/** The modifier/target surface of a `KeyboardEvent` this module actually reads. */
export interface KeyEventLike {
    readonly code: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly repeat?: boolean;
    readonly target?: unknown;
    preventDefault?(): void;
    stopPropagation?(): void;
}

export function modifiersFromEvent(event: KeyEventLike): KeyModifier[] {
    const modifiers: KeyModifier[] = [];
    if (event.ctrlKey) modifiers.push('ctrl');
    if (event.altKey) modifiers.push('alt');
    if (event.shiftKey) modifiers.push('shift');
    if (event.metaKey) modifiers.push('super');
    return modifiers;
}

/** A `KeyTrigger` for an event, or null when the physical key has no config-file name. */
export function triggerFromEvent(event: KeyEventLike): KeyTrigger | null {
    const keyCode = CODE_TO_KEY_CODE.get(event.code);
    if (keyCode === undefined) return null;
    return makeKeyTrigger(keyCode, modifiersFromEvent(event));
}

// ── binding map construction ────────────────────────────────────────────────────────

/**
 * `keybind` *values* (`"super+d=split_right"`) → a resolved map. Unparseable lines are
 * skipped with a warning in the app; here they are simply dropped, matching
 * `KeybindingService.loadFromDisk` (zero valid lines → the untouched defaults).
 */
export function keyBindingsFromOverrideLines(lines: readonly string[]): KeyBindingMap {
    const overrides = lines
        .map((line) => parseKeybindValue(line))
        .filter((override): override is NonNullable<typeof override> => override !== null);
    return resolveKeyBindings(overrides);
}

/**
 * The map for a client. The daemon does not sync the user's config file yet (no field on
 * `DaemonState`), so the defaults are the live answer and any override source assembly grows
 * later — a settings endpoint, a `hello` field — drops straight in here.
 */
export function clientKeyBindings(overrideLines?: readonly string[] | undefined): KeyBindingMap {
    if (overrideLines === undefined || overrideLines.length === 0) return DEFAULT_KEYBINDINGS;
    return keyBindingsFromOverrideLines(overrideLines);
}

export { DEFAULT_KEYBINDINGS, applyKeybindOverrides, actionForTrigger };

/**
 * The hint a menu row or palette entry shows for an action (config-keybindings.md §3.3), or
 * `undefined` when nothing is bound to it. `triggersForAction` sorts by `configString`, so a
 * multiply-bound action shows the same hint on every launch rather than whichever trigger the
 * map happened to iterate first.
 */
export function shortcutForAction(bindings: KeyBindingMap, action: NexAction): string | undefined {
    const trigger = triggersForAction(bindings, action)[0];
    return trigger === undefined ? undefined : keyTriggerDisplayString(trigger);
}

// ── dispatch ────────────────────────────────────────────────────────────────────────

export interface KeyActionContext {
    readonly action: NexAction;
    readonly trigger: KeyTrigger;
    readonly event: KeyEventLike;
}

/**
 * An action handler. Returning `false` means "my condition did not hold" — §7.2 step 7 — and
 * the event falls through untouched (to a text field, or to the terminal PTY). Returning
 * `true` or `undefined` consumes it.
 */
export type KeyActionHandler = (context: KeyActionContext) => boolean | void;

/** Every bindable action is optional: an unwired action simply falls through to the pane. */
export type KeyActionRegistry = Partial<Record<NexAction, KeyActionHandler>>;

export interface KeyDispatcherOptions {
    readonly bindings?: KeyBindingMap | (() => KeyBindingMap) | undefined;
    readonly actions: KeyActionRegistry | (() => KeyActionRegistry);
    /**
     * §7.2 step 1: while the palette is open every keystroke belongs to it, including plain
     * letters — the interceptor must not look at the map at all.
     */
    readonly isPaletteOpen?: (() => boolean) | undefined;
    /** §7.2 step 3: nothing pane-related dispatches without an active workspace. */
    readonly hasActiveWorkspace?: (() => boolean) | undefined;
    /**
     * §7.2 step 2: Escape clears a workspace multi-selection BEFORE any binding lookup (so it
     * beats the default `escape=close_search`). Return true when a selection was cleared.
     */
    readonly onEscape?: (() => boolean) | undefined;
    /** §7.2 step 4: never shadow the configured system-wide hotkey. */
    readonly globalHotkey?: (() => KeyTrigger | null) | undefined;
    /**
     * Web-pane priority layer (§7.3). Tri-state: `true` consumed, `false` deliberately not
     * consumed, `null`/absent not applicable → continue to the normal map.
     */
    readonly webPanePriority?: ((trigger: KeyTrigger, event: KeyEventLike) => boolean | null) | undefined;
    /** Overridable for hosts with their own idea of "a text field is focused". */
    readonly isEditableTarget?: ((target: unknown) => boolean) | undefined;
}

/** Returns true when the event was consumed (`preventDefault` + `stopPropagation` applied). */
export type KeyDispatcher = (event: KeyEventLike) => boolean;

const EDITABLE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * "The user is typing into chrome": the sidebar filter, an inline rename, the palette field.
 * Terminal surfaces are NOT editable elements — they are canvases — so pane bindings keep
 * working while a terminal has focus, which is the whole point of the monitor.
 */
export function isEditableTarget(target: unknown): boolean {
    if (target === null || typeof target !== 'object') return false;
    const element = target as { tagName?: unknown; isContentEditable?: unknown };
    if (element.isContentEditable === true) return true;
    return typeof element.tagName === 'string' && EDITABLE_TAGS.has(element.tagName);
}

function resolve<T>(source: T | (() => T)): T {
    return typeof source === 'function' ? (source as () => T)() : source;
}

/**
 * Builds the interceptor. Ordering follows §7.2's pseudocode exactly; the one deliberate
 * difference (no menu-bar layer) is documented in the module header.
 */
export function createKeyDispatcher(options: KeyDispatcherOptions): KeyDispatcher {
    const editable = options.isEditableTarget ?? isEditableTarget;

    return (event: KeyEventLike): boolean => {
        // 1. Palette open: let typing through untouched.
        if (options.isPaletteOpen?.() === true) return false;

        const trigger = triggerFromEvent(event);

        // 2. Escape clears an active multi-selection before any binding is consulted.
        if (event.code === 'Escape' && modifiersFromEvent(event).length === 0) {
            if (options.onEscape?.() === true) return consume(event);
        }

        if (trigger === null) return false;

        // 3. Pane-related work needs an active workspace.
        if (options.hasActiveWorkspace?.() === false) return false;

        // 4. Never dispatch the in-app binding that shadows the global hotkey.
        const hotkey = options.globalHotkey?.();
        if (hotkey !== null && hotkey !== undefined && sameTrigger(hotkey, trigger)) return false;

        // 5. Web-pane priority layer.
        const web = options.webPanePriority?.(trigger, event);
        if (web === true) return consume(event);
        if (web === false) return false;

        // 6. Normal lookup.
        const bindings = resolve(options.bindings ?? DEFAULT_KEYBINDINGS);
        const action = actionForTrigger(bindings, trigger);
        if (action === null) return false;

        // While chrome text is being edited only the (former) menu-bar actions survive; a
        // pane command must never eat a character the user is typing into a field.
        if (editable(event.target) && !MENU_BAR_ACTIONS.has(action)) return false;

        // 7. Dispatch; a handler that declines its condition falls through.
        const handler = resolve(options.actions)[action];
        if (handler === undefined) return false;
        if (handler({ action, trigger, event }) === false) return false;
        return consume(event);
    };
}

function sameTrigger(a: KeyTrigger, b: KeyTrigger): boolean {
    return a.keyCode === b.keyCode && a.modifiers.join('+') === b.modifiers.join('+');
}

function consume(event: KeyEventLike): boolean {
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
}

// ── installation ────────────────────────────────────────────────────────────────────

export interface KeyEventTarget {
    addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void, options?: unknown): void;
    removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void, options?: unknown): void;
}

/**
 * Wires a dispatcher as a capture-phase `keydown` listener (capture so chrome bindings are
 * decided before a pane's own handlers see the event) and returns the disposer.
 */
export function installKeyDispatcher(target: KeyEventTarget, dispatcher: KeyDispatcher): () => void {
    const listener = (event: KeyboardEvent): void => {
        dispatcher(event as unknown as KeyEventLike);
    };
    target.addEventListener('keydown', listener, true);
    return () => {
        target.removeEventListener('keydown', listener, true);
    };
}

// ── the action set assembly must cover ──────────────────────────────────────────────

/**
 * The actions WP3.4/3.5 wires today; everything else in `NEX_ACTIONS` is legal to register
 * and simply falls through until its feature lands (content panes: M5, web panes: M6).
 */
export const WIRED_KEY_ACTIONS: readonly NexAction[] = [
    'split_right',
    'split_down',
    'close_pane',
    'focus_next_pane',
    'focus_previous_pane',
    'move_pane_left',
    'move_pane_right',
    'move_pane_up',
    'move_pane_down',
    'toggle_zoom',
    'cycle_layout',
    'command_palette',
    'toggle_sidebar',
    'new_workspace',
    'new_group',
    'next_workspace',
    'previous_workspace',
    'switch_to_workspace_1',
    'switch_to_workspace_2',
    'switch_to_workspace_3',
    'switch_to_workspace_4',
    'switch_to_workspace_5',
    'switch_to_workspace_6',
    'switch_to_workspace_7',
    'switch_to_workspace_8',
    'switch_to_workspace_9'
];

/** `switch_to_workspace_N` → the 0-based index into `visibleWorkspaceOrder` (§3.2). */
export function workspaceSwitchIndex(action: NexAction): number | null {
    const match = /^switch_to_workspace_([1-9])$/.exec(action);
    if (match === null) return null;
    return Number.parseInt(match[1] as string, 10) - 1;
}

/**
 * Builds the nine `switch_to_workspace_N` handlers from one index callback, so assembly does
 * not have to spell out an almost-identical entry nine times.
 */
export function workspaceSwitchHandlers(
    switchToIndex: (index: number) => boolean | void
): KeyActionRegistry {
    const registry: KeyActionRegistry = {};
    for (let index = 0; index < 9; index += 1) {
        const action = `switch_to_workspace_${index + 1}` as NexAction;
        registry[action] = () => switchToIndex(index);
    }
    return registry;
}
