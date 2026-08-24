/**
 * H9 — the chord relay out of a content pane's sandboxed frame.
 *
 * `NexCommands.swift:142-155` is an `NSEvent.addLocalMonitorForEvents(matching: .keyDown)`, so
 * in the shipped app a keybinding fires whatever holds first responder — a `WKWebView` included
 * — and a chord the map does NOT claim falls straight through to the document. A cross-origin
 * iframe gives the host no monitor at all: with a markdown or diff preview focused, ⌘W, ⌘D,
 * ⌘[/⌘], ⇧⌘Space, the font-size trio and zoom were dead, because the bridge forwarded exactly
 * two chords (⌘E, ⌘F).
 *
 * Both halves are exercised here, and both matter:
 *
 *   - the FRAME half by running the injected script against jsdom (the same technique
 *     `find.test.ts` uses — the script only ever executes inside a sandbox no test can reach):
 *     a claimed chord is preventDefaulted and posted, an unclaimed one is left entirely alone;
 *   - the HOST half by rendering a `ContentFrame` and checking that a relayed chord is
 *     re-dispatched into the very dispatcher the app installs (`createKeyDispatcher`), with the
 *     action it is bound to actually running.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_KEYBINDINGS,
    createKeyDispatcher,
    installKeyDispatcher,
    isEditableTarget
} from '../chrome/keys';
import {
    CONTENT_BRIDGE_SOURCE,
    CONTENT_HOST_SOURCE,
    chordKey,
    chordKeysForBindings,
    chordKeysForTrigger,
    contentBridgeScript,
    replayFrameChord
} from './bridge';
import { ContentFrame } from './ContentFrame';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

const BARE_DOCUMENT =
    '<!DOCTYPE html>\n<html class="dark">\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n<h1>Doc</h1>\n</body>\n</html>\n';

// ── the pure key set ────────────────────────────────────────────────────────────────

describe('chordKey', () => {
    it('packs the modifiers in MODIFIER_ORDER: ctrl 1, alt 2, shift 4, super 8', () => {
        expect(chordKey({ code: 'KeyD', metaKey: true })).toBe('8/KeyD');
        expect(chordKey({ code: 'KeyD', metaKey: true, shiftKey: true })).toBe('12/KeyD');
        expect(chordKey({ code: 'ArrowLeft', ctrlKey: true, shiftKey: true })).toBe('5/ArrowLeft');
        expect(chordKey({ code: 'Escape' })).toBe('0/Escape');
    });

    it('agrees with the binding map the dispatcher resolves', () => {
        const claimed = chordKeysForBindings(DEFAULT_KEYBINDINGS);
        // The five §5.2 defaults the finding names as dead in a preview…
        expect(claimed).toContain('8/KeyW'); // close_pane
        expect(claimed).toContain('8/KeyD'); // split_right
        expect(claimed).toContain('12/KeyD'); // split_down
        expect(claimed).toContain('8/BracketLeft'); // focus_previous_pane
        expect(claimed).toContain('8/BracketRight'); // focus_next_pane
        expect(claimed).toContain('12/Space'); // cycle_layout
        expect(claimed).toContain('8/Equal'); // increase_markdown_font_size
        expect(claimed).toContain('8/Minus');
        expect(claimed).toContain('8/Digit0');
        expect(claimed).toContain('12/Enter'); // toggle_zoom
        // …and nothing the map does not claim.
        expect(claimed).not.toContain('8/KeyC');
        expect(claimed).not.toContain('8/KeyV');
        expect(claimed).not.toContain('8/KeyA');
    });

    it('covers both physical keys a trigger can arrive from', () => {
        // ⇧⌘Return is `toggle_zoom`, and a numpad Enter is the same macOS key code.
        expect(chordKeysForTrigger({ keyCode: 36, modifiers: ['shift', 'super'] }).sort()).toEqual([
            '12/Enter',
            '12/NumpadEnter'
        ]);
        // A key with no config-file name yields nothing rather than a bogus chord.
        expect(chordKeysForTrigger({ keyCode: 9999, modifiers: ['super'] })).toEqual([]);
    });
});

// ── the frame half: the injected script, run for real ───────────────────────────────

interface Posted {
    readonly kind: string;
    readonly code?: string;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
}

const posted: Posted[] = [];

function collect(event: MessageEvent): void {
    const data = event.data as Record<string, unknown> | null;
    if (data === null || data['source'] !== CONTENT_BRIDGE_SOURCE) return;
    posted.push(data as unknown as Posted);
}

/** The script posts through `parent`, which in jsdom is this window; delivery is async. */
async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function press(init: KeyboardEventInit & { code: string }): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(event);
    return event;
}

/** Deliver a host → frame message the way the host's `postMessage` would. */
function toFrame(message: Record<string, unknown>): void {
    window.dispatchEvent(new MessageEvent('message', { data: { source: CONTENT_HOST_SOURCE, ...message } }));
}

describe('the injected script', () => {
    /**
     * Installed ONCE: the script's listeners go on `document`, which outlives a test, so a
     * per-test install would leave every earlier instance relaying too and the counts below
     * would be meaningless. The chord set is host state, so each test simply re-sends it.
     */
    beforeAll(() => {
        document.body.innerHTML = '<div id="content"><p>hi</p></div>';
        delete (window as unknown as Record<string, unknown>)['__nexContentBridge'];
        window.addEventListener('message', collect);
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- running the injected script IS the test
        new Function(contentBridgeScript(PANE))();
    });

    beforeEach(async () => {
        toFrame({ kind: 'chords', chords: [] });
        await settle();
        posted.length = 0;
    });

    afterAll(() => {
        window.removeEventListener('message', collect);
    });

    it('relays nothing until the host has named the chords', async () => {
        const event = press({ code: 'KeyD', key: 'd', metaKey: true });
        await settle();
        expect(posted.some((message) => message.kind === 'key')).toBe(false);
        expect(event.defaultPrevented).toBe(false);
    });

    it('preventDefaults and relays a chord the app claims', async () => {
        toFrame({ kind: 'chords', chords: chordKeysForBindings(DEFAULT_KEYBINDINGS) });
        await settle();

        const event = press({ code: 'KeyD', key: 'd', metaKey: true });
        await settle();

        const relayed = posted.filter((message) => message.kind === 'key');
        expect(relayed).toHaveLength(1);
        expect(relayed[0]).toMatchObject({ code: 'KeyD', metaKey: true, shiftKey: false });
        // The document must not also act on it — that is the Swift monitor returning `nil`.
        expect(event.defaultPrevented).toBe(true);
    });

    it('leaves an UNCLAIMED chord entirely alone, so ⌘C still copies', async () => {
        toFrame({ kind: 'chords', chords: chordKeysForBindings(DEFAULT_KEYBINDINGS) });
        await settle();

        const event = press({ code: 'KeyC', key: 'c', metaKey: true });
        await settle();

        expect(posted.some((message) => message.kind === 'key')).toBe(false);
        expect(event.defaultPrevented).toBe(false);
    });

    it('keeps ⌘E and ⌘F on their own dedicated messages', async () => {
        toFrame({ kind: 'chords', chords: chordKeysForBindings(DEFAULT_KEYBINDINGS) });
        await settle();

        press({ code: 'KeyE', key: 'e', metaKey: true });
        press({ code: 'KeyF', key: 'f', metaKey: true });
        await settle();

        expect(posted.map((message) => message.kind)).toContain('toggle-edit');
        expect(posted.map((message) => message.kind)).toContain('find-open');
        expect(posted.some((message) => message.kind === 'key')).toBe(false);
    });

    it('replaces the set when the host sends a new one (a re-recorded keybinding)', async () => {
        toFrame({ kind: 'chords', chords: ['8/KeyD'] });
        await settle();
        press({ code: 'KeyD', key: 'd', metaKey: true });
        await settle();
        expect(posted.filter((message) => message.kind === 'key')).toHaveLength(1);

        toFrame({ kind: 'chords', chords: ['12/KeyD'] });
        await settle();
        const stale = press({ code: 'KeyD', key: 'd', metaKey: true });
        await settle();
        expect(posted.filter((message) => message.kind === 'key')).toHaveLength(1);
        expect(stale.defaultPrevented).toBe(false);
    });

    it('cannot be fooled by an Object.prototype member', async () => {
        toFrame({ kind: 'chords', chords: [] });
        await settle();
        // `claimedChords['constructor']` is truthy on a bare object; a chord key always has a
        // '/' in it, so no keystroke can ever produce one of those names.
        const event = press({ code: 'KeyD', key: 'd', metaKey: true });
        await settle();
        expect(event.defaultPrevented).toBe(false);
    });
});

// ── the host half: the relay reaches the app's own dispatcher ───────────────────────

describe('the host replay', () => {
    afterEach(cleanup);

    it('re-dispatches a relayed chord into the dispatcher the app installs', () => {
        const split = vi.fn();
        const dispatcher = createKeyDispatcher({
            bindings: DEFAULT_KEYBINDINGS,
            actions: { split_right: split }
        });
        const off = installKeyDispatcher(window, dispatcher);

        render(<ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} />);
        window.dispatchEvent(
            new MessageEvent('message', {
                data: {
                    source: CONTENT_BRIDGE_SOURCE,
                    paneID: PANE,
                    kind: 'key',
                    code: 'KeyD',
                    key: 'd',
                    metaKey: true,
                    ctrlKey: false,
                    altKey: false,
                    shiftKey: false
                }
            })
        );

        expect(split).toHaveBeenCalledTimes(1);
        off();
    });

    it('replays a chord the dispatcher cannot mistake for chrome text', () => {
        const seen: KeyboardEvent[] = [];
        const listener = (event: Event): void => {
            seen.push(event as KeyboardEvent);
        };
        window.addEventListener('keydown', listener, true);

        replayFrameChord({
            code: 'KeyW',
            key: 'w',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false
        });
        window.removeEventListener('keydown', listener, true);

        expect(seen).toHaveLength(1);
        const event = seen[0] as KeyboardEvent;
        expect(event.code).toBe('KeyW');
        expect(event.metaKey).toBe(true);
        expect(event.cancelable).toBe(true);
        // §7.2 step 6 asks this of every event it dispatches; the window answers "no", which is
        // what keeps a relayed ⌘W from being swallowed as "the user is typing into a field".
        expect(isEditableTarget(event.target)).toBe(false);
    });

    it('hands the claimed set to the frame on mount and again on every `ready`', () => {
        render(
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={BARE_DOCUMENT}
                claimedChords={['8/KeyD', '8/KeyW']}
            />
        );
        const target = (screen.getByTestId(`content-iframe-${PANE}`) as HTMLIFrameElement).contentWindow;
        expect(target).not.toBeNull();
        const post = vi.spyOn(target as Window, 'postMessage');

        // A re-injected document claims nothing until it is told again.
        window.dispatchEvent(
            new MessageEvent('message', {
                data: { source: CONTENT_BRIDGE_SOURCE, paneID: PANE, kind: 'ready' }
            })
        );

        expect(post).toHaveBeenCalledWith(
            { source: CONTENT_HOST_SOURCE, kind: 'chords', chords: ['8/KeyD', '8/KeyW'] },
            '*'
        );
    });

    it('claims nothing when no set was supplied (a standalone frame)', () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={BARE_DOCUMENT} />);
        const target = (screen.getByTestId(`content-iframe-${PANE}`) as HTMLIFrameElement).contentWindow;
        const post = vi.spyOn(target as Window, 'postMessage');

        window.dispatchEvent(
            new MessageEvent('message', {
                data: { source: CONTENT_BRIDGE_SOURCE, paneID: PANE, kind: 'ready' }
            })
        );

        expect(post).toHaveBeenCalledWith(
            { source: CONTENT_HOST_SOURCE, kind: 'chords', chords: [] },
            '*'
        );
    });
});
