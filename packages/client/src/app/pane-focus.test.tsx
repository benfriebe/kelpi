/**
 * N19 — who gets the caret when a pane is created, and who is allowed to keep it.
 *
 * The defect the owner reported is one line of consequence: ⇧⌘N draws the focus ring on a new
 * scratchpad and the `<textarea>` never receives DOM focus, so the first keystrokes go to the
 * terminal the scratchpad was split from. The cause is that ghostty-web drives keyboard input
 * through a hidden `<textarea>` inside the terminal host, so a DOM-level "is a text field
 * focused?" test cannot tell a live terminal from a sidebar rename — and `Terminal.blur()`
 * blurs the container rather than that textarea, so the terminal never lets go either.
 *
 * The Swift answers this with the responder chain: `SurfaceContainerView.swift:146-156` blocks
 * on `firstResponder is NSText` (a terminal surface is not `NSText`), and the two editors
 * `releaseFirstResponderIfHeld` on `true → false` precisely "so the next pane's focus claim
 * isn't blocked". These tests pin both halves, and then the whole thing end to end through the
 * component that mounts into a focused pane.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownPane } from '../content/MarkdownPane';
import { PlainTextEditor } from '../content/PlainTextEditor';
import { ScratchpadPane } from '../content/ScratchpadPane';
import { contentState, createFakeContentApi } from '../content/testing';
import {
    PANE_SURFACE_ATTR,
    engineFocusWindowOwner,
    focusPaneSurface,
    isPaneSurfaceCaret,
    openEngineFocusWindow,
    releaseFocusedPaneCaret,
    releasePaneCaret,
    shouldGrabFocus,
    undoSurfaceAutoFocus
} from './pane-focus';

const SCRATCH = 'DDDDDDDD-0000-4000-8000-000000000004';
const MD = 'DDDDDDDD-0000-4000-8000-000000000001';
const TERM = 'DDDDDDDD-0000-4000-8000-000000000009';

afterEach(() => {
    cleanup();
    document.body.replaceChildren();
});

/**
 * A stand-in for a live terminal pane: the pane wrapper the grid draws, the marked host, and
 * the hidden `<textarea>` the engine creates inside it (`terminal.ts:391`).
 */
function mountFakeTerminal(paneID: string = TERM): { host: HTMLElement; area: HTMLTextAreaElement } {
    const pane = document.createElement('div');
    pane.setAttribute('data-pane-id', paneID);
    const host = document.createElement('div');
    host.setAttribute('data-terminal-host', '');
    host.setAttribute(PANE_SURFACE_ATTR, '');
    const area = document.createElement('textarea');
    area.setAttribute('aria-label', 'Terminal input');
    host.appendChild(area);
    pane.appendChild(host);
    document.body.appendChild(pane);
    return { host, area };
}

/** A chrome text field: the sidebar rename, the palette, an inline pane rename. */
function mountChromeField(): HTMLInputElement {
    const input = document.createElement('input');
    document.body.appendChild(input);
    return input;
}

// ── the rule itself ─────────────────────────────────────────────────────────────────

describe('shouldGrabFocus', () => {
    it('grabs when nothing holds the caret', () => {
        expect(shouldGrabFocus(document.createElement('div'))).toBe(true);
    });

    it('never steals the caret from a CHROME text field (a rename, the palette)', () => {
        const input = mountChromeField();
        input.focus();
        expect(shouldGrabFocus(document.createElement('div'))).toBe(false);

        input.blur();
        expect(shouldGrabFocus(document.createElement('div'))).toBe(true);
    });

    it('DOES grab from another pane’s surface — a terminal is not chrome (N19)', () => {
        const terminal = mountFakeTerminal();
        terminal.area.focus();
        expect(document.activeElement).toBe(terminal.area);
        // The old rule saw `tagName === 'textarea'` and refused, which is the whole defect:
        // a scratchpad split off a terminal could never claim the caret.
        expect(shouldGrabFocus(document.createElement('div'))).toBe(true);
    });

    it('leaves a surface holding its own caret alone', () => {
        const terminal = mountFakeTerminal();
        terminal.area.focus();
        expect(shouldGrabFocus(terminal.host)).toBe(true);
    });

    it('classifies the caret’s owner: surface vs chrome', () => {
        const terminal = mountFakeTerminal();
        const input = mountChromeField();
        expect(isPaneSurfaceCaret(terminal.area)).toBe(true);
        expect(isPaneSurfaceCaret(terminal.host)).toBe(true);
        expect(isPaneSurfaceCaret(input)).toBe(false);
        expect(isPaneSurfaceCaret(null)).toBe(false);
    });
});

describe('releasePaneCaret', () => {
    it('lets go of a caret held inside the host (the port of releaseFirstResponderIfHeld)', () => {
        const terminal = mountFakeTerminal();
        terminal.area.focus();
        releasePaneCaret(terminal.host);
        expect(document.activeElement).not.toBe(terminal.area);
    });

    it('never undoes a claim that already landed somewhere else', () => {
        const terminal = mountFakeTerminal();
        const input = mountChromeField();
        input.focus();
        // The two panes' effects run in one commit, in whichever order the tree gives: the
        // loser must not blur the winner. Only nodes INSIDE the host are ever released.
        releasePaneCaret(terminal.host);
        expect(document.activeElement).toBe(input);
    });

    it('is a no-op without a host', () => {
        const input = mountChromeField();
        input.focus();
        releasePaneCaret(null);
        expect(document.activeElement).toBe(input);
    });
});

/**
 * §N35 — the engine grabs the caret on `open()`, and the port has to be able to say no.
 *
 * `Terminal.open()` ends with `this.focus()`, so a pane that is not the focused one takes the
 * keyboard simply by finishing its wasm load. On a client reload every pane remounts at once,
 * which makes the winner "whichever engine came up last".
 */
describe('undoSurfaceAutoFocus (§N35)', () => {
    it('puts the caret back where the engine took it from', () => {
        const typing = mountFakeTerminal('DDDDDDDD-0000-4000-8000-00000000000A');
        const arriving = mountFakeTerminal('DDDDDDDD-0000-4000-8000-00000000000B');
        typing.area.focus();
        // The engine's own grab, verbatim: it focuses its textarea, from wherever the caret was.
        const stolenFrom = document.activeElement;
        arriving.area.focus();
        expect(document.activeElement).toBe(arriving.area);

        undoSurfaceAutoFocus(arriving.host, stolenFrom);
        expect(document.activeElement).toBe(typing.area);
    });

    it('gives a chrome field its caret back — the case shouldGrabFocus exists to protect', () => {
        const input = mountChromeField();
        const arriving = mountFakeTerminal();
        input.focus();
        const stolenFrom = document.activeElement;
        arriving.area.focus();

        undoSurfaceAutoFocus(arriving.host, stolenFrom);
        expect(document.activeElement).toBe(input);
    });

    it('blurs when there is nowhere to give it back to', () => {
        const arriving = mountFakeTerminal();
        arriving.area.focus();
        undoSurfaceAutoFocus(arriving.host, document.body);
        expect(document.activeElement).not.toBe(arriving.area);
    });

    /**
     * The focused pane's engine has not built anything focusable yet — the case that made the
     * outcome depend on which engine finished its wasm load first. Dropping the caret on
     * `<body>` here is a window that draws a ring and takes no keystrokes; leaving it is a
     * transient the ring's owner ends the moment it opens.
     */
    it('leaves the caret alone rather than voiding it when the ringed pane cannot take it yet', () => {
        const loading = mountFakeTerminal('DDDDDDDD-0000-4000-8000-000000000010');
        loading.area.remove();
        (loading.host.closest('[data-pane-id]') as HTMLElement).setAttribute('data-focused', 'true');
        const arriving = mountFakeTerminal('DDDDDDDD-0000-4000-8000-000000000011');
        arriving.area.focus();

        undoSurfaceAutoFocus(arriving.host, document.body);
        expect(document.activeElement).toBe(arriving.area);
    });

    /**
     * The reload's own case, and the one the packaged stack found: the element the grab took the
     * caret from is already gone (the empty-grid placeholder that was on screen while the
     * snapshot was in flight), so "give it back" has nowhere to aim. The ring does.
     */
    it('falls back to the pane WEARING THE RING when the previous owner is gone', () => {
        const ringed = mountFakeTerminal('DDDDDDDD-0000-4000-8000-00000000000C');
        (ringed.host.closest('[data-pane-id]') as HTMLElement).setAttribute('data-focused', 'true');
        const gone = mountChromeField();
        const arriving = mountFakeTerminal('DDDDDDDD-0000-4000-8000-00000000000D');
        gone.focus();
        const stolenFrom = document.activeElement;
        gone.remove();
        arriving.area.focus();

        undoSurfaceAutoFocus(arriving.host, stolenFrom);
        expect(document.activeElement).toBe(ringed.area);
    });

    it('…and the ring never beats a chrome field that is still there', () => {
        const ringed = mountFakeTerminal('DDDDDDDD-0000-4000-8000-00000000000E');
        (ringed.host.closest('[data-pane-id]') as HTMLElement).setAttribute('data-focused', 'true');
        const renaming = mountChromeField();
        const arriving = mountFakeTerminal('DDDDDDDD-0000-4000-8000-00000000000F');
        renaming.focus();
        const stolenFrom = document.activeElement;
        arriving.area.focus();

        undoSurfaceAutoFocus(arriving.host, stolenFrom);
        expect(document.activeElement).toBe(renaming);
    });

    it('never touches a caret the engine did not take', () => {
        const input = mountChromeField();
        const arriving = mountFakeTerminal();
        input.focus();
        // Nothing inside the host holds the caret: this pane has nothing to undo, and a blur
        // here would cancel an edit that has nothing to do with it.
        undoSurfaceAutoFocus(arriving.host, null);
        expect(document.activeElement).toBe(input);
    });

    it('does not restore a node that has since been unmounted', () => {
        const gone = mountChromeField();
        const arriving = mountFakeTerminal();
        gone.focus();
        const stolenFrom = document.activeElement;
        gone.remove();
        arriving.area.focus();

        undoSurfaceAutoFocus(arriving.host, stolenFrom);
        expect(document.activeElement).not.toBe(arriving.area);
    });
});

/**
 * §N35 residual (a) — the arbiter, in its own right.
 *
 * The storm the run-AK verifier measured was not a bug in the hand-off; it was a bug in the
 * QUESTION. Every pane answered "who should hold the caret" for itself, so two panes coming up
 * beside each other each nominated the other, and the two undos took turns. The rules below are
 * the ones that make that unconstructible rather than merely rare.
 */
describe('the engine-autofocus arbiter (§N35 residual a)', () => {
    it('starts from whoever holds the caret when the FIRST engine arms', () => {
        const renaming = mountChromeField();
        renaming.focus();
        const arriving = mountFakeTerminal();

        const close = openEngineFocusWindow(arriving.host);
        expect(engineFocusWindowOwner()).toBe(renaming);
        close();
        // Closed, so there is no owner to consult: the last pane out turns the light off.
        expect(engineFocusWindowOwner()).toBeNull();
    });

    it('adopts a claim from OUTSIDE the window — a rename begun during a wasm load', () => {
        const arriving = mountFakeTerminal();
        const close = openEngineFocusWindow(arriving.host);
        expect(engineFocusWindowOwner()).toBeNull();

        const renaming = mountChromeField();
        renaming.focus();
        expect(engineFocusWindowOwner()).toBe(renaming);

        // …and the pane's own engine grabbing it gives it straight back, unasked.
        arriving.area.focus();
        undoSurfaceAutoFocus(arriving.host);
        expect(document.activeElement).toBe(renaming);
        close();
    });

    /** The rule the whole residual turns on: a grab is not an owner. */
    it('never records a caret held INSIDE a host whose engine is still grabbing', () => {
        const a = mountFakeTerminal('DDDDDDDD-0000-4000-8000-000000000020');
        const b = mountFakeTerminal('DDDDDDDD-0000-4000-8000-000000000021');
        const closeA = openEngineFocusWindow(a.host);
        const closeB = openEngineFocusWindow(b.host);

        // Both engines grab, in the order a reload produces.
        a.area.focus();
        b.area.focus();
        expect(engineFocusWindowOwner()).toBeNull();

        // So neither pane can be sent the other's caret: B's undo has nowhere to hand it but
        // the ring (absent here), and A is never nominated.
        undoSurfaceAutoFocus(b.host);
        expect(document.activeElement).not.toBe(a.area);
        closeA();
        closeB();
    });

    it('…and once a pane’s window CLOSES its caret is an owner again (it is live now)', () => {
        const live = mountFakeTerminal('DDDDDDDD-0000-4000-8000-000000000022');
        const arriving = mountFakeTerminal('DDDDDDDD-0000-4000-8000-000000000023');
        const closeLive = openEngineFocusWindow(live.host);
        const closeArriving = openEngineFocusWindow(arriving.host);
        closeLive();

        live.area.focus();
        expect(engineFocusWindowOwner()).toBe(live.area);
        arriving.area.focus();
        undoSurfaceAutoFocus(arriving.host);
        expect(document.activeElement).toBe(live.area);
        closeArriving();
    });

    /**
     * The arbiter's own `focus()` raises a `focusin` the receiving pane cannot tell from its
     * engine grabbing, so an undo that runs inside an undo is the recursion, one level down.
     */
    it('ignores an undo raised by its own hand-off — one hand-off per grab', () => {
        const a = mountFakeTerminal('DDDDDDDD-0000-4000-8000-000000000024');
        const b = mountFakeTerminal('DDDDDDDD-0000-4000-8000-000000000025');
        const closeA = openEngineFocusWindow(a.host);
        const closeB = openEngineFocusWindow(b.host);
        const answers: string[] = [];
        // Exactly what a live pane does inside its window: answer every grab in its own host.
        b.host.addEventListener('focusin', () => {
            answers.push('b');
            undoSurfaceAutoFocus(b.host);
        });

        a.area.focus();
        // Named explicitly, because the ownership rule above will not nominate B: this is the
        // re-entrancy guard on its own, with the hand-off forced.
        undoSurfaceAutoFocus(a.host, b.area);

        expect(answers).toEqual(['b']);
        expect(document.activeElement).toBe(b.area);
        closeA();
        closeB();
    });

    it('is a no-op without a host, and closing twice is harmless', () => {
        const close = openEngineFocusWindow(null);
        expect(() => {
            close();
            close();
        }).not.toThrow();
    });
});

describe('releaseFocusedPaneCaret (§N29)', () => {
    it('lets go of whichever pane surface holds the caret, without being told which', () => {
        // The gesture that needs this cannot name the outgoing pane: a click inside a web
        // pane's native view produces no DOM event at all, so the pane that is losing focus
        // never hears anything and keeps `document.activeElement`.
        const terminal = mountFakeTerminal();
        terminal.area.focus();
        releaseFocusedPaneCaret();
        expect(document.activeElement).not.toBe(terminal.area);
    });

    it('leaves a CHROME text field alone — that is the caret the NSText guard protects', () => {
        const input = mountChromeField();
        input.focus();
        releaseFocusedPaneCaret();
        expect(document.activeElement).toBe(input);
    });

    it('is a no-op when nothing holds the caret', () => {
        expect(() => releaseFocusedPaneCaret()).not.toThrow();
    });
});

describe('focusPaneSurface', () => {
    it('hands a terminal pane the engine’s own focusable', () => {
        const terminal = mountFakeTerminal();
        focusPaneSurface(TERM);
        expect(document.activeElement).toBe(terminal.area);
    });

    it('hands an EDITOR pane its textarea — the handoff that used to be a no-op (N19)', () => {
        const content = createFakeContentApi();
        const pane = document.createElement('div');
        pane.setAttribute('data-pane-id', SCRATCH);
        document.body.appendChild(pane);
        render(<ScratchpadPane paneID={SCRATCH} content={content} />, { container: pane });
        act(() => {
            content.push(contentState({ paneID: SCRATCH, type: 'scratchpad', mode: 'edit', text: 'hi' }));
        });

        focusPaneSurface(SCRATCH);
        expect(document.activeElement).toBe(screen.getByTestId(`content-textarea-${SCRATCH}`));
    });

    it('is a no-op for an unknown pane', () => {
        const input = mountChromeField();
        input.focus();
        focusPaneSurface('no-such-pane');
        expect(document.activeElement).toBe(input);
    });
});

// ── the component, which is what the owner actually pressed ─────────────────────────

describe('an editor mounting into a focused pane', () => {
    /** ⇧⌘N: the scratchpad is born out of the terminal that is holding the caret. */
    it('takes the caret from the terminal it was split off, and TYPING lands in it', () => {
        const terminal = mountFakeTerminal();
        terminal.area.focus();

        const content = createFakeContentApi();
        render(<ScratchpadPane paneID={SCRATCH} content={content} focused visible />);
        act(() => {
            content.push(contentState({ paneID: SCRATCH, type: 'scratchpad', mode: 'edit', text: '' }));
        });

        const area = screen.getByTestId(`content-textarea-${SCRATCH}`) as HTMLTextAreaElement;
        expect(document.activeElement).toBe(area);

        // No click anywhere: the next keystroke has to reach the buffer.
        fireEvent.change(area, { target: { value: 'note' } });
        expect(content.texts.at(-1)).toEqual({ paneID: SCRATCH, text: 'note' });
    });

    it('still refuses to interrupt a chrome text field', () => {
        const input = mountChromeField();
        input.focus();

        const content = createFakeContentApi();
        render(<ScratchpadPane paneID={SCRATCH} content={content} focused visible />);
        act(() => {
            content.push(contentState({ paneID: SCRATCH, type: 'scratchpad', mode: 'edit', text: '' }));
        });

        expect(document.activeElement).toBe(input);
    });

    it('does NOT take the caret when the pane is focused but off-screen (a background create)', () => {
        const terminal = mountFakeTerminal();
        terminal.area.focus();

        const content = createFakeContentApi();
        const view = render(<ScratchpadPane paneID={SCRATCH} content={content} focused visible={false} />);
        act(() => {
            content.push(contentState({ paneID: SCRATCH, type: 'scratchpad', mode: 'edit', text: '' }));
        });
        expect(document.activeElement).toBe(terminal.area);

        // …and claims it the moment the workspace it lives in comes on screen.
        view.rerender(<ScratchpadPane paneID={SCRATCH} content={content} focused visible />);
        expect(document.activeElement).toBe(screen.getByTestId(`content-textarea-${SCRATCH}`));
    });

    it('releases the caret when the pane loses focus, so the next claim is not blocked', () => {
        const view = render(<PlainTextEditor paneID={SCRATCH} ariaLabel="scratchpad" value="" onChange={() => undefined} focused visible />);
        const area = screen.getByTestId(`content-textarea-${SCRATCH}`);
        expect(document.activeElement).toBe(area);

        view.rerender(<PlainTextEditor paneID={SCRATCH} ariaLabel="scratchpad" value="" onChange={() => undefined} focused={false} visible />);
        expect(document.activeElement).not.toBe(area);
    });

    it('marks its textarea as the pane’s surface', () => {
        render(<PlainTextEditor paneID={SCRATCH} ariaLabel="scratchpad" value="" onChange={() => undefined} />);
        expect(screen.getByTestId(`content-textarea-${SCRATCH}`).hasAttribute(PANE_SURFACE_ATTR)).toBe(true);
    });

    /**
     * ⌘E, swept for the same gap. A markdown pane focused by its HEADER leaves the caret in
     * whatever terminal had it (the header tap moves pane focus, not DOM focus), so the editor
     * that replaces the preview arrives with a terminal holding the caret — the ⇧⌘N situation
     * exactly. `MarkdownEditorView.swift:78-80` claims first responder in `makeNSView` too.
     */
    it('markdown ⌘E puts the caret in the editor even when a terminal was holding it', () => {
        const terminal = mountFakeTerminal();
        terminal.area.focus();

        const content = createFakeContentApi();
        render(<MarkdownPane paneID={MD} content={content} focused visible />);
        act(() => {
            content.push(contentState({ paneID: MD, mode: 'view' }));
        });
        expect(screen.queryByTestId(`content-textarea-${MD}`)).toBeNull();
        expect(document.activeElement).toBe(terminal.area);

        act(() => {
            content.push(contentState({ paneID: MD, mode: 'edit', revision: 2 }));
        });
        const area = screen.getByTestId(`content-textarea-${MD}`) as HTMLTextAreaElement;
        expect(document.activeElement).toBe(area);

        fireEvent.change(area, { target: { value: '# edited' } });
        expect(content.texts.at(-1)).toEqual({ paneID: MD, text: '# edited' });
    });

    /**
     * The other direction, which the same rule has to keep working: an EDITOR holding the caret
     * must not block the next surface either — the external-editor pane (a real PTY mounted
     * into a markdown pane, CONT-081) and every ordinary pane-to-pane move go through here.
     * The Swift gets this from the editors' own `releaseFirstResponderIfHeld`; the port gets it
     * from both that and the surface rule, so the two effects are order-independent.
     */
    it('an editor holding the caret does not block the next pane’s surface', () => {
        render(<PlainTextEditor paneID={SCRATCH} ariaLabel="scratchpad" value="" onChange={() => undefined} focused visible />);
        const area = screen.getByTestId(`content-textarea-${SCRATCH}`);
        expect(document.activeElement).toBe(area);

        const arriving = document.createElement('div');
        arriving.setAttribute(PANE_SURFACE_ATTR, '');
        expect(shouldGrabFocus(arriving)).toBe(true);
    });
});
