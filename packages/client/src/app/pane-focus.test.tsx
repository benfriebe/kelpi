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
    focusPaneSurface,
    isPaneSurfaceCaret,
    releasePaneCaret,
    shouldGrabFocus
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
