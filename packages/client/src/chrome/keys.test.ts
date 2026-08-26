import type { NexAction } from '@nex/core/config';
import { describe, expect, it, vi } from 'vitest';

import {
    CODE_TO_KEY_CODE,
    createKeyDispatcher,
    installKeyDispatcher,
    isEditableTarget,
    isTerminalSurface,
    keyBindingsFromOverrideLines,
    modifiersFromEvent,
    triggerFromEvent,
    workspaceSwitchHandlers,
    workspaceSwitchIndex,
    type KeyActionRegistry,
    type KeyEventLike
} from './index';

interface FakeEvent extends KeyEventLike {
    readonly prevented: () => number;
}

function keyEvent(
    code: string,
    modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
    target: unknown = null
): FakeEvent {
    let prevented = 0;
    return {
        code,
        metaKey: modifiers.meta ?? false,
        ctrlKey: modifiers.ctrl ?? false,
        altKey: modifiers.alt ?? false,
        shiftKey: modifiers.shift ?? false,
        target,
        preventDefault: () => {
            prevented += 1;
        },
        stopPropagation: () => undefined,
        prevented: () => prevented
    };
}

/**
 * A `contenteditable` div that reports `isContentEditable` — the flag the dispatcher reads.
 * jsdom implements the attribute but not the computed property, so it is defined explicitly.
 */
function contentEditableElement(): HTMLDivElement {
    const element = document.createElement('div');
    element.contentEditable = 'true';
    Object.defineProperty(element, 'isContentEditable', { value: true, configurable: true });
    return element;
}

/** A registry that records which action fired. */
function recorder(): { registry: KeyActionRegistry; fired: NexAction[] } {
    const fired: NexAction[] = [];
    const actions: NexAction[] = [
        'split_right',
        'split_down',
        'close_pane',
        'focus_next_pane',
        'focus_previous_pane',
        'move_pane_left',
        'toggle_zoom',
        'cycle_layout',
        'command_palette',
        'toggle_sidebar',
        'next_workspace',
        'previous_workspace',
        'increase_markdown_font_size',
        'close_search',
        'new_workspace'
    ];
    const registry: KeyActionRegistry = {};
    for (const action of actions) {
        registry[action] = () => {
            fired.push(action);
        };
    }
    return { registry, fired };
}

describe('code → keyCode identity', () => {
    it('maps physical codes onto the config file key codes', () => {
        expect(CODE_TO_KEY_CODE.get('KeyD')).toBe(2);
        expect(CODE_TO_KEY_CODE.get('Digit3')).toBe(20);
        expect(CODE_TO_KEY_CODE.get('BracketRight')).toBe(30);
        expect(CODE_TO_KEY_CODE.get('Escape')).toBe(53);
        // `code` is PHYSICAL: a shifted `=` is still Equal, so ⌘⇧= finds the ⌘= binding's key.
        expect(CODE_TO_KEY_CODE.get('Equal')).toBe(24);
        expect(CODE_TO_KEY_CODE.get('F13')).toBeUndefined();
    });

    it('reads modifiers in the canonical order', () => {
        expect(modifiersFromEvent(keyEvent('KeyD', { meta: true, shift: true }))).toEqual(['shift', 'super']);
        expect(triggerFromEvent(keyEvent('KeyD', { meta: true }))).toEqual({
            keyCode: 2,
            modifiers: ['super']
        });
        expect(triggerFromEvent(keyEvent('F13', { meta: true }))).toBeNull();
    });
});

describe('the default binding matrix', () => {
    const cases: ReadonlyArray<readonly [string, Parameters<typeof keyEvent>[1], NexAction]> = [
        ['KeyD', { meta: true }, 'split_right'],
        ['KeyD', { meta: true, shift: true }, 'split_down'],
        ['KeyW', { meta: true }, 'close_pane'],
        ['BracketRight', { meta: true }, 'focus_next_pane'],
        ['BracketLeft', { meta: true }, 'focus_previous_pane'],
        ['ArrowRight', { meta: true, alt: true }, 'focus_next_pane'],
        ['ArrowDown', { meta: true, alt: true }, 'next_workspace'],
        ['ArrowUp', { meta: true, alt: true }, 'previous_workspace'],
        ['ArrowLeft', { ctrl: true, shift: true }, 'move_pane_left'],
        ['Enter', { meta: true, shift: true }, 'toggle_zoom'],
        ['Space', { meta: true, shift: true }, 'cycle_layout'],
        ['KeyP', { meta: true }, 'command_palette'],
        ['KeyS', { meta: true, shift: true }, 'toggle_sidebar'],
        ['Equal', { meta: true }, 'increase_markdown_font_size'],
        ['Escape', {}, 'close_search']
    ];

    for (const [code, modifiers, action] of cases) {
        it(`${code} ${JSON.stringify(modifiers)} → ${action}`, () => {
            const { registry, fired } = recorder();
            const dispatch = createKeyDispatcher({ actions: registry });
            const event = keyEvent(code, modifiers);
            expect(dispatch(event)).toBe(true);
            expect(fired).toEqual([action]);
            expect(event.prevented()).toBe(1);
        });
    }

    it('switch_to_workspace_N indexes visibleWorkspaceOrder 0-based', () => {
        const indices: number[] = [];
        const dispatch = createKeyDispatcher({
            actions: workspaceSwitchHandlers((index) => {
                indices.push(index);
            })
        });
        expect(dispatch(keyEvent('Digit1', { meta: true }))).toBe(true);
        expect(dispatch(keyEvent('Digit9', { meta: true }))).toBe(true);
        expect(indices).toEqual([0, 8]);
        expect(workspaceSwitchIndex('switch_to_workspace_5')).toBe(4);
        expect(workspaceSwitchIndex('split_right')).toBeNull();
    });

    it('falls through for an unbound trigger, an unknown key and an unwired action', () => {
        const { registry, fired } = recorder();
        const dispatch = createKeyDispatcher({ actions: registry });
        expect(dispatch(keyEvent('KeyD'))).toBe(false); // no modifiers: goes to the PTY
        expect(dispatch(keyEvent('F13', { meta: true }))).toBe(false);
        // `super+e` = toggle_markdown_edit, which this registry does not wire.
        expect(dispatch(keyEvent('KeyE', { meta: true }))).toBe(false);
        expect(fired).toEqual([]);
    });

    it('a handler returning false declines its condition and the event falls through', () => {
        const dispatch = createKeyDispatcher({ actions: { split_right: () => false } });
        const event = keyEvent('KeyD', { meta: true });
        expect(dispatch(event)).toBe(false);
        expect(event.prevented()).toBe(0);
    });
});

describe('conditional rules', () => {
    it('dispatches nothing while the palette is open', () => {
        const { registry, fired } = recorder();
        const dispatch = createKeyDispatcher({ actions: registry, isPaletteOpen: () => true });
        expect(dispatch(keyEvent('KeyD', { meta: true }))).toBe(false);
        expect(fired).toEqual([]);
    });

    /**
     * N14's residual. Step 1 declining ⌘W is what let the shell's Close row take the WINDOW:
     * the bridge replays the chord through this dispatcher, an unconsumed replay reads as
     * "nothing here to close", and the row's fallback is `window.close()`.
     */
    describe('the close chord while a modal overlay is open (N14)', () => {
        it('hands ⌘W to the overlay and consumes it, so the window is never the fallback', () => {
            const { registry, fired } = recorder();
            let closed = 0;
            const dispatch = createKeyDispatcher({
                actions: registry,
                isPaletteOpen: () => true,
                onCloseChordWhileModal: () => {
                    closed += 1;
                    return true;
                }
            });
            const event = keyEvent('KeyW', { meta: true });
            expect(dispatch(event)).toBe(true);
            expect(event.prevented()).toBe(1);
            expect(closed).toBe(1);
            // The overlay closed; `close_pane` itself never ran, so no pane went with it.
            expect(fired).toEqual([]);
        });

        it('leaves every other keystroke to the overlay, ⌘W’s own letter included', () => {
            const { registry, fired } = recorder();
            const seen: string[] = [];
            const dispatch = createKeyDispatcher({
                actions: registry,
                isPaletteOpen: () => true,
                onCloseChordWhileModal: () => {
                    seen.push('asked');
                    return true;
                }
            });
            // A bare `w` typed into the palette field, and a chord bound to something else.
            expect(dispatch(keyEvent('KeyW'))).toBe(false);
            expect(dispatch(keyEvent('KeyD', { meta: true }))).toBe(false);
            expect(dispatch(keyEvent('KeyP', { meta: true }))).toBe(false);
            expect(seen).toEqual([]);
            expect(fired).toEqual([]);
        });

        it('follows the binding map rather than a hard-coded ⌘W', () => {
            const { registry } = recorder();
            const asked: string[] = [];
            const dispatch = createKeyDispatcher({
                // `close_pane` moved to ⌘⇧W; ⌘W now splits.
                bindings: keyBindingsFromOverrideLines(['super+shift+w=close_pane', 'super+w=split_right']),
                actions: registry,
                isPaletteOpen: () => true,
                onCloseChordWhileModal: () => {
                    asked.push('asked');
                    return true;
                }
            });
            expect(dispatch(keyEvent('KeyW', { meta: true }))).toBe(false);
            expect(dispatch(keyEvent('KeyW', { meta: true, shift: true }))).toBe(true);
            expect(asked).toEqual(['asked']);
        });

        it('falls through unchanged when the overlay declines, and when nothing is wired', () => {
            const { registry, fired } = recorder();
            const declines = createKeyDispatcher({
                actions: registry,
                isPaletteOpen: () => true,
                onCloseChordWhileModal: () => false
            });
            const declined = keyEvent('KeyW', { meta: true });
            expect(declines(declined)).toBe(false);
            expect(declined.prevented()).toBe(0);

            const unwired = createKeyDispatcher({ actions: registry, isPaletteOpen: () => true });
            expect(unwired(keyEvent('KeyW', { meta: true }))).toBe(false);
            expect(fired).toEqual([]);
        });

        it('is the modal path only: with no overlay up, ⌘W is the ordinary close_pane', () => {
            const { registry, fired } = recorder();
            const asked: string[] = [];
            const dispatch = createKeyDispatcher({
                actions: registry,
                isPaletteOpen: () => false,
                onCloseChordWhileModal: () => {
                    asked.push('asked');
                    return true;
                }
            });
            expect(dispatch(keyEvent('KeyW', { meta: true }))).toBe(true);
            expect(asked).toEqual([]);
            expect(fired).toEqual(['close_pane']);
        });

        /**
         * Consuming here must not take the chord away from Settings ▸ Keybindings' RECORDER,
         * which arms its own capture listener on `window` while a row is recording (it is
         * allowed to, precisely because the overlay gates this dispatcher). `consume` calls
         * `stopPropagation`, never `stopImmediatePropagation`, so a listener registered later
         * on the same node still runs — this pins that, because the alternative silently breaks
         * recording ⌘W.
         */
        it('does not silence a listener the recorder registers on the same node', () => {
            const { registry } = recorder();
            const dispatcher = createKeyDispatcher({
                actions: registry,
                isPaletteOpen: () => true,
                onCloseChordWhileModal: () => true
            });
            const removeDispatcher = installKeyDispatcher(window, dispatcher);
            const recorded: string[] = [];
            const armed = (event: KeyboardEvent): void => {
                recorded.push(`${event.code}${event.metaKey ? '+meta' : ''}`);
            };
            window.addEventListener('keydown', armed, true);
            try {
                document.body.dispatchEvent(
                    new KeyboardEvent('keydown', { code: 'KeyW', metaKey: true, bubbles: true, cancelable: true })
                );
            } finally {
                window.removeEventListener('keydown', armed, true);
                removeDispatcher();
            }
            expect(recorded).toEqual(['KeyW+meta']);
        });
    });

    it('suppresses pane bindings while a text field is focused, but keeps menu-bar ones', () => {
        const { registry, fired } = recorder();
        const dispatch = createKeyDispatcher({ actions: registry });
        const input = { tagName: 'INPUT' };
        expect(dispatch(keyEvent('KeyD', { meta: true }, input))).toBe(false);
        expect(dispatch(keyEvent('KeyW', { meta: true }, input))).toBe(false);
        expect(dispatch(keyEvent('KeyP', { meta: true }, input))).toBe(true);
        expect(dispatch(keyEvent('KeyS', { meta: true, shift: true }, input))).toBe(true);
        expect(fired).toEqual(['command_palette', 'toggle_sidebar']);
    });

    it('recognises the editable surfaces, and NOT a terminal canvas', () => {
        expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
        expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true);
        expect(isEditableTarget({ isContentEditable: true })).toBe(true);
        expect(isEditableTarget({ tagName: 'CANVAS' })).toBe(false);
        expect(isEditableTarget(null)).toBe(false);
    });

    /**
     * The UI audit's blocker B1. ghostty-web marks its host `contenteditable`, so the plain
     * flag test read every terminal as "the user is typing into chrome" and skipped the whole
     * pane keymap — in the state the app boots in and returns to after every split.
     */
    it('does not read a terminal surface as chrome text, whatever the engine focuses', () => {
        const host = document.createElement('div');
        host.setAttribute('data-terminal-host', '');

        // ghostty-web: a contenteditable host element. jsdom parses the attribute but never
        // computes `isContentEditable`, so it is stamped on directly — otherwise this test
        // would pass for the wrong reason (the flag the predicate reads being absent).
        const ghostty = contentEditableElement();
        host.append(ghostty);
        // xterm.js fallback: a hidden helper textarea inside the same host.
        const xtermHelper = document.createElement('textarea');
        host.append(xtermHelper);
        document.body.append(host);

        expect(isTerminalSurface(ghostty)).toBe(true);
        expect(isEditableTarget(ghostty)).toBe(false);
        expect(isEditableTarget(xtermHelper)).toBe(false);
        expect(isEditableTarget(host)).toBe(false);

        // …and chrome's own fields, which live outside any terminal host, are unaffected.
        const filter = document.createElement('input');
        const rename = contentEditableElement();
        document.body.append(filter, rename);
        expect(isTerminalSurface(filter)).toBe(false);
        expect(isEditableTarget(filter)).toBe(true);
        expect(isEditableTarget(rename)).toBe(true);

        host.remove();
        filter.remove();
        rename.remove();
    });

    it('dispatches pane actions while a terminal holds focus, and still suppresses them in a field', () => {
        const host = document.createElement('div');
        host.setAttribute('data-terminal-host', '');
        const terminal = contentEditableElement();
        host.append(terminal);
        document.body.append(host);

        const { registry, fired } = recorder();
        const dispatch = createKeyDispatcher({ actions: registry });

        // ⌘D (split_right) and ⌘W (close_pane) are pane actions: dead before this fix.
        expect(dispatch(keyEvent('KeyD', { meta: true }, terminal))).toBe(true);
        expect(dispatch(keyEvent('KeyW', { meta: true }, terminal))).toBe(true);
        expect(fired).toEqual(['split_right', 'close_pane']);

        const input = document.createElement('input');
        document.body.append(input);
        expect(dispatch(keyEvent('KeyD', { meta: true }, input))).toBe(false);
        expect(fired).toEqual(['split_right', 'close_pane']);

        host.remove();
        input.remove();
    });

    it('Escape clears a multi-selection before any binding lookup', () => {
        const { registry, fired } = recorder();
        let hasSelection = true;
        const dispatch = createKeyDispatcher({
            actions: registry,
            onEscape: () => {
                if (!hasSelection) return false;
                hasSelection = false;
                return true;
            }
        });
        expect(dispatch(keyEvent('Escape'))).toBe(true);
        expect(fired).toEqual([]); // close_search never ran
        expect(dispatch(keyEvent('Escape'))).toBe(true);
        expect(fired).toEqual(['close_search']);
    });

    it('needs an active workspace', () => {
        const { registry, fired } = recorder();
        const dispatch = createKeyDispatcher({ actions: registry, hasActiveWorkspace: () => false });
        expect(dispatch(keyEvent('KeyD', { meta: true }))).toBe(false);
        expect(fired).toEqual([]);
    });

    it('never shadows the configured global hotkey', () => {
        const { registry, fired } = recorder();
        const dispatch = createKeyDispatcher({
            actions: registry,
            globalHotkey: () => ({ keyCode: 2, modifiers: ['super'] })
        });
        expect(dispatch(keyEvent('KeyD', { meta: true }))).toBe(false);
        expect(fired).toEqual([]);
    });

    it('honours the web-pane priority layer as a tri-state', () => {
        const { registry, fired } = recorder();
        const dispatch = createKeyDispatcher({
            actions: registry,
            webPanePriority: (trigger) => {
                if (trigger.keyCode === 13) return true; // ⌘W consumed as "close tab"
                if (trigger.keyCode === 2) return false; // deliberately not consumed
                return null; // not applicable → normal map
            }
        });
        expect(dispatch(keyEvent('KeyW', { meta: true }))).toBe(true);
        expect(dispatch(keyEvent('KeyD', { meta: true }))).toBe(false);
        expect(dispatch(keyEvent('KeyP', { meta: true }))).toBe(true);
        expect(fired).toEqual(['command_palette']);
    });
});

describe('config overrides', () => {
    it('rebinds from `keybind` values and drops unparseable lines', () => {
        const bindings = keyBindingsFromOverrideLines(['super+d=toggle_zoom', 'nonsense', 'super+w=unbind']);
        const { registry, fired } = recorder();
        const dispatch = createKeyDispatcher({ actions: registry, bindings });
        expect(dispatch(keyEvent('KeyD', { meta: true }))).toBe(true);
        expect(dispatch(keyEvent('KeyW', { meta: true }))).toBe(false);
        expect(fired).toEqual(['toggle_zoom']);
    });
});

describe('installKeyDispatcher', () => {
    it('intercepts real keydown events in capture phase and detaches cleanly', () => {
        const fired: string[] = [];
        const dispatch = createKeyDispatcher({
            actions: {
                split_right: () => {
                    fired.push('split_right');
                }
            }
        });
        const dispose = installKeyDispatcher(globalThis.window, dispatch);
        const bubbled = vi.fn();
        globalThis.window.addEventListener('keydown', bubbled);

        globalThis.window.dispatchEvent(
            new KeyboardEvent('keydown', { code: 'KeyD', metaKey: true, bubbles: true, cancelable: true })
        );
        expect(fired).toEqual(['split_right']);
        expect(bubbled).not.toHaveBeenCalled(); // stopPropagation on a consumed event

        dispose();
        globalThis.window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', metaKey: true }));
        expect(fired).toEqual(['split_right']);
        globalThis.window.removeEventListener('keydown', bubbled);
    });
});
