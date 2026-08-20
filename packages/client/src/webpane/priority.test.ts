/**
 * The web-pane priority key layer (WEB-152/WEB-153, TERM-156, SET-188…SET-191).
 *
 * The table is small; what makes it worth a suite is the **tri-state**. Two of its three answers
 * are refusals, and they refuse for different reasons:
 *
 *   `null`  — "not mine": the normal keybinding map runs, which is how ⌘W still closes a pane on
 *             a single-tab web pane and how ⌘[ / ⌘] stay on focus-prev/next;
 *   `false` — "mine, deliberately declined": the event is left alone so the caret can move.
 *
 * Getting either one wrong is invisible in a screenshot and immediately obvious in use, which is
 * why every row below asserts the exact answer rather than "not true".
 */

import { describe, expect, it } from 'vitest';

import type { KeyEventLike } from '../chrome';
import { chromeTextIsFocused, createWebPanePriority, type FocusedWebPane } from './priority';

const KEY = {
    L: 37,
    R: 15,
    T: 17,
    W: 13,
    ArrowLeft: 123,
    ArrowRight: 124,
    BracketLeft: 33,
    BracketRight: 30,
    Equal: 24,
    Minus: 27,
    Zero: 29,
    D: 2
} as const;

interface Call {
    readonly verb: string;
    readonly args: readonly unknown[];
}

function harness(options: { pane?: FocusedWebPane | null; editing?: boolean } = {}): {
    priority: ReturnType<typeof createWebPanePriority>;
    calls: Call[];
} {
    const calls: Call[] = [];
    const record =
        (verb: string) =>
        (...args: unknown[]): void => {
            calls.push({ verb, args });
        };
    const pane =
        options.pane === undefined ? { paneID: 'P', tabID: 'T', tabCount: 2 } : options.pane;
    return {
        calls,
        priority: createWebPanePriority({
            focusedWebPane: () => pane,
            isChromeTextEditing: () => options.editing === true,
            focusURLBar: record('focusURLBar'),
            reload: record('reload'),
            back: record('back'),
            forward: record('forward'),
            newTab: record('newTab'),
            closeTab: record('closeTab'),
            cycleTab: record('cycleTab'),
            zoom: record('zoom')
        })
    };
}

function press(keyCode: number, modifiers: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean } = {}): [
    { keyCode: number },
    KeyEventLike
] {
    return [
        { keyCode },
        {
            code: '',
            metaKey: modifiers.meta !== false,
            shiftKey: modifiers.shift === true,
            ctrlKey: modifiers.ctrl === true,
            altKey: modifiers.alt === true
        }
    ];
}

describe('applicability', () => {
    it('declines entirely when the focused pane is not a web pane', () => {
        const { priority, calls } = harness({ pane: null });
        expect(priority(...press(KEY.R))).toBeNull();
        expect(calls).toEqual([]);
    });

    it('declines a combo it does not claim, so the normal map runs', () => {
        const { priority } = harness();
        // ⌘D is split_right on every pane type, web included.
        expect(priority(...press(KEY.D))).toBeNull();
    });

    it('declines anything without ⌘ — a bare key belongs to the page', () => {
        const { priority } = harness();
        expect(priority(...press(KEY.R, { meta: false }))).toBeNull();
        expect(priority(...press(KEY.T, { meta: false, ctrl: true }))).toBeNull();
    });

    it('declines ⌥⌘ and ⌃⌘ variants rather than guessing', () => {
        const { priority } = harness();
        expect(priority(...press(KEY.R, { alt: true }))).toBeNull();
        expect(priority(...press(KEY.W, { ctrl: true }))).toBeNull();
    });
});

describe('the table (WEB-152)', () => {
    it('maps ⌘L, ⌘R, ⌘T to the URL bar, reload and a new tab', () => {
        const { priority, calls } = harness();
        expect(priority(...press(KEY.L))).toBe(true);
        expect(priority(...press(KEY.R))).toBe(true);
        expect(priority(...press(KEY.T))).toBe(true);
        expect(calls.map((call) => call.verb)).toEqual(['focusURLBar', 'reload', 'newTab']);
    });

    it('maps ⌘← / ⌘→ to back / forward — NOT ⌘[ / ⌘] (SET-189)', () => {
        const { priority, calls } = harness();
        expect(priority(...press(KEY.ArrowLeft))).toBe(true);
        expect(priority(...press(KEY.ArrowRight))).toBe(true);
        expect(calls.map((call) => call.verb)).toEqual(['back', 'forward']);
        // ⌘[ / ⌘] stay on focus prev/next even inside a web pane.
        expect(priority(...press(KEY.BracketLeft))).toBeNull();
        expect(priority(...press(KEY.BracketRight))).toBeNull();
    });

    it('maps ⌘⇧[ / ⌘⇧] to previous / next tab', () => {
        const { priority, calls } = harness();
        expect(priority(...press(KEY.BracketLeft, { shift: true }))).toBe(true);
        expect(priority(...press(KEY.BracketRight, { shift: true }))).toBe(true);
        expect(calls).toEqual([
            { verb: 'cycleTab', args: ['P', -1] },
            { verb: 'cycleTab', args: ['P', 1] }
        ]);
    });

    it('maps ⌘= and ⌘⇧= to zoom in, ⌘- out, ⌘0 reset', () => {
        const { priority, calls } = harness();
        expect(priority(...press(KEY.Equal))).toBe(true);
        expect(priority(...press(KEY.Equal, { shift: true }))).toBe(true);
        expect(priority(...press(KEY.Minus))).toBe(true);
        expect(priority(...press(KEY.Zero))).toBe(true);
        expect(calls.map((call) => call.args[1])).toEqual(['in', 'in', 'out', 'reset']);
    });

    it('closes the active tab on ⌘W when there is more than one', () => {
        const { priority, calls } = harness();
        expect(priority(...press(KEY.W))).toBe(true);
        expect(calls).toEqual([{ verb: 'closeTab', args: ['P', 'T'] }]);
    });
});

describe('the deliberate deferrals (WEB-153)', () => {
    it('falls through for ⌘← / ⌘→ while the URL bar is being edited (SET-190)', () => {
        const { priority, calls } = harness({ editing: true });
        expect(priority(...press(KEY.ArrowLeft))).toBe(false);
        expect(priority(...press(KEY.ArrowRight))).toBe(false);
        expect(calls).toEqual([]);
    });

    it('falls through for tab cycling while editing, but NOT for ⌘L / ⌘R / ⌘T', () => {
        const { priority, calls } = harness({ editing: true });
        expect(priority(...press(KEY.BracketLeft, { shift: true }))).toBe(false);
        expect(priority(...press(KEY.BracketRight, { shift: true }))).toBe(false);
        expect(priority(...press(KEY.L))).toBe(true);
        expect(priority(...press(KEY.R))).toBe(true);
        expect(calls.map((call) => call.verb)).toEqual(['focusURLBar', 'reload']);
    });

    it('lets ⌘W reach the normal close-pane binding on a single-tab pane (SET-191)', () => {
        const { priority, calls } = harness({ pane: { paneID: 'P', tabID: 'T', tabCount: 1 } });
        expect(priority(...press(KEY.W))).toBeNull();
        expect(calls).toEqual([]);
    });

    it('lets ⌘W through on a tab-less pane too', () => {
        const { priority } = harness({ pane: { paneID: 'P', tabID: null, tabCount: 0 } });
        expect(priority(...press(KEY.W))).toBeNull();
    });
});

describe('chromeTextIsFocused', () => {
    it('matches only elements inside a marked chrome field', () => {
        const outside = { closest: () => null };
        const inside = { closest: (selector: string) => (selector.includes('web-chrome-text') ? {} : null) };
        expect(chromeTextIsFocused(outside)).toBe(false);
        expect(chromeTextIsFocused(inside)).toBe(true);
        expect(chromeTextIsFocused(null)).toBe(false);
        expect(chromeTextIsFocused({})).toBe(false);
    });
});
