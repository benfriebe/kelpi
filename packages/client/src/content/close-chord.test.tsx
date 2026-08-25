/**
 * N14 — ⌘W with focus inside a content pane's frame must close a PANE, never the window.
 *
 * The observed defect (packaged app, 2026-08-25): with a terminal focused ⌘W closed only the
 * pane, but with focus inside a markdown preview — a cross-origin, sandboxed iframe with its own
 * renderer — the whole window went, because the app menu's bare `role: 'close'` was the only
 * thing that acted on the keystroke.
 *
 * H9's relay already claimed ⌘W, so this file pins the two edges that could still let it out,
 * and then the whole chain:
 *
 *   1. the claimed set is SEEDED into the document (no host handshake needed), so a re-injected
 *      preview — every watcher write, theme swap and font change re-injects one — relays from
 *      its first keystroke rather than from its first answered `ready`;
 *   2. the listener is capture-phase on `window`, so a script inside the rendered note (markdown
 *      passes raw HTML through) cannot stopPropagation() ⌘W back off the relay;
 *   3. end to end: a ⌘W pressed inside the frame arrives at the app's own key dispatcher as
 *      `close_pane`, on the very dispatcher `installKeyDispatcher` wires.
 *
 * Its own file rather than a describe in `chords.test.tsx` because the injected script installs
 * once per window (`__nexContentBridge`), and this one has to be installed with a SEED.
 *
 * What no test here can reach: the native menu. A CDP- or jsdom-synthesised ⌘W never touches
 * AppKit's key-equivalent path, so "the menu no longer closes the window" is proven on the shell
 * side (`shell/src/menu.test.ts`) and finished by one keypress in the packaged app.
 */

import { DEFAULT_KEYBINDINGS } from '@nex/core/config';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKeyDispatcher, installKeyDispatcher } from '../chrome/keys';
import {
    CONTENT_BRIDGE_SOURCE,
    chordKey,
    chordKeysForBindings,
    chordSeedObject,
    contentBridgeScript,
    prepareContentDocument
} from './bridge';
import { ContentFrame } from './ContentFrame';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

const BARE_DOCUMENT =
    '<!DOCTYPE html>\n<html class="dark">\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n<h1>Doc</h1>\n</body>\n</html>\n';

/** Everything the frame posted out, in order. */
const posted: Record<string, unknown>[] = [];

function collect(event: MessageEvent): void {
    const data = event.data as Record<string, unknown> | null;
    if (data === null || data['source'] !== CONTENT_BRIDGE_SOURCE) return;
    posted.push(data);
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function press(init: KeyboardEventInit & { code: string }): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(event);
    return event;
}

/*
 * The script installs ONCE per window (`__nexContentBridge`), and this file's whole subject is a
 * script installed WITH a seed — so it is installed here, for the file, and the collector lives
 * as long as it does. Every test starts from an empty `posted`.
 */
beforeAll(() => {
    document.body.innerHTML = '<div id="content"><p>hi</p></div>';
    delete (window as unknown as Record<string, unknown>)['__nexContentBridge'];
    window.addEventListener('message', collect);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the injected script IS the test
    new Function(contentBridgeScript(PANE, undefined, chordKeysForBindings(DEFAULT_KEYBINDINGS)))();
});

beforeEach(() => {
    posted.length = 0;
});

afterAll(() => {
    window.removeEventListener('message', collect);
});

// ── the frame half, installed WITH a seed and never told anything else ───────────────

describe('the injected script, seeded at injection (N14)', () => {
    it('relays ⌘W before the host has said a word', async () => {
        // No `chords` message has EVER been delivered in this window — the whole point.
        const event = press({ code: 'KeyW', key: 'w', metaKey: true });
        await settle();

        expect(event.defaultPrevented).toBe(true);
        expect(posted.filter((message) => message['kind'] === 'key')).toMatchObject([
            { code: 'KeyW', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false }
        ]);
    });

    it('still leaves an unclaimed chord alone — the seed is the map, not a blanket', async () => {
        const event = press({ code: 'KeyC', key: 'c', metaKey: true });
        await settle();

        expect(event.defaultPrevented).toBe(false);
        expect(posted.some((message) => message['kind'] === 'key')).toBe(false);
    });

    it('cannot be silenced by a script inside the note', async () => {
        // A rendered document may carry its own scripts (markdown passes raw HTML through). A
        // capture-phase listener on `document` is the earliest one such a script can install —
        // and the relay, on `window` in capture, still runs first.
        const greedy = (event: Event): void => event.stopPropagation();
        document.addEventListener('keydown', greedy, true);
        try {
            const event = press({ code: 'KeyW', key: 'w', metaKey: true });
            await settle();

            expect(event.defaultPrevented).toBe(true);
            expect(posted.filter((message) => message['kind'] === 'key')).toHaveLength(1);
        } finally {
            document.removeEventListener('keydown', greedy, true);
        }
    });
});

// ── the document the client actually injects ────────────────────────────────────────

describe('prepareContentDocument', () => {
    it('bakes the claimed set into the document the frame loads', () => {
        const html = prepareContentDocument(BARE_DOCUMENT, {
            paneID: PANE,
            claimedChords: ['8/KeyW', '8/KeyD']
        });

        expect(html).toContain('"8/KeyW":true');
        expect(html).toContain('"8/KeyD":true');
    });

    it('seeds nothing when nothing is claimed (a standalone frame)', () => {
        const html = prepareContentDocument(BARE_DOCUMENT, { paneID: PANE });
        expect(html).toContain('var claimedChords = {};');
    });

    it('refuses anything that is not a chord key, so the seed cannot smuggle', () => {
        // Every real key is `bits/Code`. `constructor` is the one that matters (truthy on a bare
        // object), and a quoted string with punctuation is the one that would matter if the seed
        // were ever built from something other than the binding map.
        expect(chordSeedObject(['constructor', '8/KeyW', 'a"};alert(1);//'])).toEqual({ '8/KeyW': true });
    });

    it('agrees with the frame’s own chord identity for ⌘W', () => {
        expect(chordKey({ code: 'KeyW', metaKey: true })).toBe('8/KeyW');
        expect(chordKeysForBindings(DEFAULT_KEYBINDINGS)).toContain('8/KeyW');
    });

    it('keeps every chord the map actually claims — the filter drops nothing real', () => {
        // The seed is filtered, so the filter has to be proven not to eat a legitimate chord:
        // every `KeyboardEvent.code` in the table is an alphanumeric identifier, brackets,
        // arrows and F-keys included.
        const claimed = chordKeysForBindings(DEFAULT_KEYBINDINGS);
        expect(Object.keys(chordSeedObject(claimed)).sort()).toEqual([...claimed].sort());
        // …and the three the app adds on top of the map (⌘, and ⌘/ ⇧⌘/) survive it too.
        expect(Object.keys(chordSeedObject(['8/Comma', '8/Slash', '12/Slash']))).toHaveLength(3);
    });
});

// ── the whole chain: a keystroke in the frame reaches `close_pane` ───────────────────

describe('a ⌘W inside the frame reaches the app’s dispatcher as close_pane', () => {
    afterEach(cleanup);

    it('runs close_pane on the dispatcher the app installs', async () => {
        /*
         * The keystroke first, and deliberately before anything is listening: in the real app the
         * frame's keydown is in ANOTHER renderer and the host window never sees it, so the only
         * thing that may reach the dispatcher here is the relayed message. jsdom has one window
         * for both halves, so the separation is made in time instead.
         */
        press({ code: 'KeyW', key: 'w', metaKey: true });
        await settle();
        const relayed = posted.find((message) => message['kind'] === 'key');
        expect(relayed).toBeDefined();

        const closePane = vi.fn(() => true);
        const splitRight = vi.fn(() => true);
        const dispatcher = createKeyDispatcher({
            bindings: DEFAULT_KEYBINDINGS,
            actions: { close_pane: closePane, split_right: splitRight }
        });
        const off = installKeyDispatcher(window, dispatcher);

        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT}
                claimedChords={chordKeysForBindings(DEFAULT_KEYBINDINGS)}
            />
        );

        window.dispatchEvent(new MessageEvent('message', { data: relayed }));

        expect(closePane).toHaveBeenCalledTimes(1);
        expect(splitRight).not.toHaveBeenCalled();
        off();
    });
});
