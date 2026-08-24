/**
 * §H19 — the command palette arrives and leaves.
 *
 * `ContentView.swift:283, 286`: `.transition(.move(edge: .top).combined(with: .opacity))` under
 * `.animation(.easeOut(duration: 0.15), value: store.isCommandPaletteVisible)`. The most-used
 * overlay in the app slides down from the top edge while fading, over 150 ms, and leaves the same
 * way. The port's `if (!props.open) return null` hard-mounted and hard-unmounted it, and
 * `styles.css` had exactly three `@keyframes` — none of them the palette's.
 *
 * A transition is not something a screenshot can hold, so this reads the two halves that decide
 * it, the `sidebar-agent-dot.test.tsx` idiom: the KEYFRAMES parsed out of `styles.css` (the
 * distance, the direction and the curve live there and nowhere else) and the component's own
 * mount/phase machine under a held clock.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette, type PaletteItem } from './index';
import { PALETTE_TRANSITION_MS } from './CommandPalette';

afterEach(cleanup);

const stylesheet = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
    'utf8'
);

/** The body of a top-level `@keyframes <name> { … }` block, braces balanced. */
function keyframesBody(name: string): string {
    const start = stylesheet.indexOf(`@keyframes ${name} {`);
    expect(start, `@keyframes ${name} is not in styles.css`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = stylesheet.indexOf('{', start); i < stylesheet.length; i += 1) {
        if (stylesheet[i] === '{') depth += 1;
        else if (stylesheet[i] === '}') {
            depth -= 1;
            if (depth === 0) return stylesheet.slice(stylesheet.indexOf('{', start) + 1, i);
        }
    }
    throw new Error(`@keyframes ${name} is unterminated`);
}

/** The declaration block of a top-level rule, by its selector text. */
function ruleBody(selector: string): string {
    const start = stylesheet.indexOf(`\n${selector} {`);
    expect(start, `${selector} is not a top-level rule in styles.css`).toBeGreaterThan(-1);
    return stylesheet.slice(stylesheet.indexOf('{', start) + 1, stylesheet.indexOf('}', start));
}

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEMS: readonly PaletteItem[] = [
    {
        id: `ws:${W1}`,
        kind: 'workspace',
        icon: 'rectangle.stack',
        title: 'alpha',
        subtitle: '2 panes',
        workspaceID: W1,
        workspaceName: 'alpha',
        paneID: null,
        workspaceColor: 'blue'
    }
];

function props(open: boolean, overrides: Record<string, unknown> = {}) {
    return {
        open,
        query: '',
        onQueryChange: vi.fn(),
        items: ITEMS,
        onConfirm: vi.fn(),
        onDismiss: vi.fn(),
        ...overrides
    };
}

describe('the keyframes (§H19)', () => {
    it('the panel slides down from above while it fades in', () => {
        const frames = keyframesBody('nex-palette-enter');
        expect(frames).toContain('opacity: 0');
        // `.move(edge: .top)` — it comes FROM above, so the offset is negative.
        expect(frames).toMatch(/translateY\(-\d+px\)/);
        expect(frames).toContain('opacity: 1');
        expect(frames).toContain('transform: none');
    });

    it('and leaves the way it came — the half a mount-delay flag exists for', () => {
        const frames = keyframesBody('nex-palette-exit');
        expect(frames).toMatch(/from\s*\{\s*opacity:\s*1/);
        expect(frames).toMatch(/to\s*\{[^}]*opacity:\s*0/);
        expect(frames).toMatch(/translateY\(-\d+px\)/);
    });

    it('the scrim only fades: an inset-0 wash that also translated would bare an edge', () => {
        expect(keyframesBody('nex-palette-scrim-in')).not.toContain('translate');
        expect(keyframesBody('nex-palette-scrim-out')).not.toContain('translate');
    });

    it('both directions run for 150 ms on ease-out, the shipped curve and duration', () => {
        for (const selector of [
            "[data-palette-phase='entering'] .nex-palette-panel",
            "[data-palette-phase='exiting'] .nex-palette-panel",
            ".nex-palette-scrim[data-palette-phase='entering']",
            ".nex-palette-scrim[data-palette-phase='exiting']"
        ]) {
            const body = ruleBody(selector);
            expect(body, selector).toContain('150ms');
            expect(body, selector).toContain('ease-out');
            // `both`: the first frame is held before the run and the last one after it, so the
            // panel never flashes at full opacity for a frame on either edge.
            expect(body, selector).toContain('both');
        }
    });

    it('the component and the stylesheet agree on the duration', () => {
        expect(PALETTE_TRANSITION_MS).toBe(150);
        expect(ruleBody("[data-palette-phase='exiting'] .nex-palette-panel")).toContain(
            `${String(PALETTE_TRANSITION_MS)}ms`
        );
    });

    it('reduced motion turns all of it off', () => {
        const reduced = stylesheet.slice(stylesheet.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
        expect(reduced).toContain('nex-palette-panel');
        expect(reduced).toContain('nex-palette-scrim');
        expect(reduced).toContain('animation: none');
    });
});

describe('the mount machine (§H19)', () => {
    it('is entering while open, and carries both animated classes', () => {
        render(<CommandPalette {...props(true)} />);
        const backdrop = screen.getByTestId('palette-backdrop');
        expect(backdrop.dataset['palettePhase']).toBe('entering');
        expect(backdrop.className).toContain('nex-palette-scrim');
        expect(screen.getByTestId('command-palette').className).toContain('nex-palette-panel');
    });

    it('stays mounted for the exit, then goes — a hard unmount cannot animate', () => {
        vi.useFakeTimers();
        try {
            const view = render(<CommandPalette {...props(true)} />);
            view.rerender(<CommandPalette {...props(false)} />);

            const backdrop = screen.getByTestId('palette-backdrop');
            expect(backdrop.dataset['palettePhase']).toBe('exiting');
            // …and it is a picture, not a control: a click during the exit goes behind it.
            expect(backdrop.style.pointerEvents).toBe('none');

            act(() => vi.advanceTimersByTime(PALETTE_TRANSITION_MS - 1));
            expect(screen.queryByTestId('command-palette')).not.toBeNull();

            act(() => vi.advanceTimersByTime(2));
            expect(screen.queryByTestId('command-palette')).toBeNull();
            expect(screen.queryByTestId('palette-backdrop')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-opening inside the exit window cancels it, rather than unmounting mid-flight', () => {
        vi.useFakeTimers();
        try {
            const view = render(<CommandPalette {...props(true)} />);
            view.rerender(<CommandPalette {...props(false)} />);
            act(() => vi.advanceTimersByTime(60));
            view.rerender(<CommandPalette {...props(true)} />);
            expect(screen.getByTestId('palette-backdrop').dataset['palettePhase']).toBe('entering');

            // The cancelled timer must not fire later and take the re-opened palette with it.
            act(() => vi.advanceTimersByTime(500));
            expect(screen.queryByTestId('command-palette')).not.toBeNull();
            expect(screen.getByTestId('palette-backdrop').dataset['palettePhase']).toBe('entering');
        } finally {
            vi.useRealTimers();
        }
    });

    it('draws nothing at all when it has never been open', () => {
        render(<CommandPalette {...props(false)} />);
        expect(screen.queryByTestId('command-palette')).toBeNull();
        expect(screen.queryByTestId('palette-backdrop')).toBeNull();
    });

    it('releases the text field on the way out, so the next keystroke is not typed into it', () => {
        vi.useFakeTimers();
        try {
            const view = render(<CommandPalette {...props(true)} />);
            const input = screen.getByTestId('command-palette').querySelector('input');
            expect(document.activeElement).toBe(input);
            view.rerender(<CommandPalette {...props(false)} />);
            expect(document.activeElement).not.toBe(input);
        } finally {
            vi.useRealTimers();
        }
    });

    it('Escape still dismisses through the same path (the exit is presentation only)', () => {
        const onDismiss = vi.fn();
        render(<CommandPalette {...props(true, { onDismiss })} />);
        const input = screen.getByTestId('command-palette').querySelector('input');
        fireEvent.keyDown(input as HTMLInputElement, { key: 'Escape' });
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });
});
