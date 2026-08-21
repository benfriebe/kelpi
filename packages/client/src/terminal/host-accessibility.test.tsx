/**
 * §TERM-036 — the terminal surface's accessibility identity.
 *
 * Its own file rather than more cases in `TerminalPane.test.tsx`: that suite is about the engine
 * lifecycle and is being edited by other work, and these four assertions are one clause each of
 * `SurfaceView.swift:703-715`.
 *
 * The *platform* half — that Blink turns `textbox` + `aria-multiline` into `AXTextArea`, and
 * that the help text lands as the node's AX description — is not jsdom's to answer, so it is
 * asserted against a real Chromium accessibility snapshot in the audit's `terminal-host-edges`
 * step. What is asserted here is the markup that snapshot is derived from.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    TERMINAL_ACCESSIBILITY_HELP,
    TerminalPane,
    terminalAccessibilityName
} from './TerminalPane';
import { createFakePtyApi, createFakeRendererFactory, installFakeResizeObserver } from './testing';

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    vi.useFakeTimers();
    observers = installFakeResizeObserver();
});

afterEach(() => {
    cleanup();
    observers.restore();
    vi.useRealTimers();
});

const PANE = 'AAAAAAAA-1111-4222-8333-444444444444';

/**
 * The PANE ROOT is the accessibility element, not `[data-terminal-host]` — ghostty-web's
 * `open()` owns the host's `role`/`aria-label`/`aria-multiline` and its `dispose()` removes
 * them, so anything rendered there is overwritten on mount and stripped on teardown.
 */
function renderPane(accessibilityName?: string): HTMLElement {
    const renderers = createFakeRendererFactory();
    const pty = createFakePtyApi();
    const { container } = render(
        <TerminalPane
            paneID={PANE}
            ptyApi={pty}
            focused={false}
            visible
            createRenderer={renderers.factory}
            measure={() => ({ width: 800, height: 480 })}
            {...(accessibilityName === undefined ? {} : { accessibilityName })}
        />
    );
    const root = container.querySelector<HTMLElement>(`[data-pane-id="${PANE}"][data-terminal-status]`);
    if (root === null) throw new Error('no pane root rendered');
    return root;
}

describe('terminalAccessibilityName', () => {
    it('names the pane the way its header does', () => {
        expect(terminalAccessibilityName('~/code/nex')).toBe('Terminal — ~/code/nex');
    });

    it('falls back to the bare word rather than to a uuid', () => {
        expect(terminalAccessibilityName()).toBe('Terminal');
        expect(terminalAccessibilityName('')).toBe('Terminal');
        expect(terminalAccessibilityName('   ')).toBe('Terminal');
    });
});

describe('§TERM-036 — the surface is an accessibility element', () => {
    it('carries a role, which is how a div opts in (`isAccessibilityElement`)', () => {
        expect(renderPane().getAttribute('role')).toBe('textbox');
    });

    it('is MULTILINE — `textbox` alone is AXTextField, and a terminal is not one', () => {
        expect(renderPane().getAttribute('aria-multiline')).toBe('true');
    });

    it('carries the help text "Terminal content area" as its description', () => {
        const host = renderPane();
        const describedBy = host.getAttribute('aria-describedby');
        expect(describedBy).not.toBeNull();
        const help = host.ownerDocument.getElementById(String(describedBy));
        expect(help?.textContent).toBe(TERMINAL_ACCESSIBILITY_HELP);
    });

    /** The regression this replaces: a 36-character id read aloud as the pane's name. */
    it('is named after the pane, never after its uuid', () => {
        const named = renderPane('~/code/nex');
        expect(named.getAttribute('aria-label')).toBe('Terminal — ~/code/nex');
        expect(named.getAttribute('aria-label')).not.toContain(PANE);

        const unnamed = renderPane();
        expect(unnamed.getAttribute('aria-label')).toBe('Terminal');
        expect(unnamed.getAttribute('aria-label')).not.toContain(PANE);
    });

    /**
     * The help span must be a SIBLING of the host, not a child: the engine owns everything
     * inside `[data-terminal-host]` and mounts its canvas there.
     */
    it('keeps the help text outside the element the engine mounts into', () => {
        const root = renderPane();
        const host = root.querySelector('[data-terminal-host]');
        expect(host).not.toBeNull();
        expect(host?.querySelector(`#terminal-help-${PANE}`)).toBeNull();
        expect(root.querySelector(`#terminal-help-${PANE}`)).not.toBeNull();
    });

    /**
     * And the identity must NOT be on the host, where the engine would overwrite it: the first
     * live read of this item came back as ghostty-web's static "Terminal input".
     */
    it('does not put the identity on the element the engine overwrites', () => {
        const host = renderPane('~/code/nex').querySelector('[data-terminal-host]');
        expect(host?.getAttribute('aria-label')).toBeNull();
        expect(host?.getAttribute('aria-describedby')).toBeNull();
    });
});
