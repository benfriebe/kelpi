/**
 * §N17 — the pane's translucency reaches the ENGINE, or it reaches nothing.
 *
 * The owner's report was `background-opacity = 0.85` rendering a fully solid terminal pane on
 * the packaged app. Under the DOM fix the pane container is the single translucent layer
 * (`rgba(ghostty-bg, 0.85)`), but a container is only translucent if what sits ON it lets light
 * through, and the engine canvas did not: ghostty-web accepted `allowTransparency` and never
 * read it, so every default-background paint was an opaque `fillRect`.
 *
 * `0.4.0-nex.3` implements the option (`vendor/ghostty-web-patched`, `paintDefaultBackground`),
 * which makes THIS the load-bearing wire: the value has to travel prop → factory → engine, and
 * it has to be `false` unless assembly says otherwise, because a terminal that clears its own
 * background over an opaque window would show the page behind it instead of the theme.
 *
 * The Swift equivalent is not an option at all: libghostty applies `background-opacity` inside
 * the surface, which is exactly why `PaneGridView.swift:370-378` leaves a `.shell` pane's
 * wrapper unpainted while filling markdown / scratchpad / diff / web bodies.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalPane } from './TerminalPane';
import { createFakePtyApi, createFakeRendererFactory, installFakeResizeObserver } from './testing';

/** jsdom reports 0×0 for everything; the pane takes its box through this seam. */
const box = (width: number, height: number) => () => ({ width, height });

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    observers = installFakeResizeObserver();
});

afterEach(() => {
    cleanup();
    observers.restore();
    vi.restoreAllMocks();
});

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function mount(props: { allowTransparency?: boolean; background?: string } = {}) {
    const pty = createFakePtyApi();
    const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
    const view = render(
        <TerminalPane
            paneID="pane-1"
            ptyApi={pty}
            focused={false}
            visible
            createRenderer={renderers.factory}
            measure={box(800, 480)}
            {...props}
        />
    );
    await settle();
    return { renderers, root: view.container.querySelector('[data-pane-id]') as HTMLElement };
}

describe('TerminalPane engine transparency (§N17)', () => {
    it('hands the engine allowTransparency when assembly says the fill is translucent', async () => {
        const { renderers, root } = await mount({
            allowTransparency: true,
            background: 'rgba(10, 10, 12, 0.85)'
        });
        expect(renderers.last().options?.allowTransparency).toBe(true);
        // …and the container is what that clear composites onto.
        expect(root.style.backgroundColor).toBe('rgba(10, 10, 12, 0.85)');
    });

    it('hands the engine false at the default opacity, so the opaque path is untouched', async () => {
        const { renderers } = await mount({
            allowTransparency: false,
            background: 'rgba(10, 10, 12, 1)'
        });
        expect(renderers.last().options?.allowTransparency).toBe(false);
    });

    /**
     * A pane mounted WITHOUT the prop — a test harness, a standalone embed — must not silently
     * become see-through. The option is omitted entirely rather than passed as `false`, so the
     * renderer's own default (also `false`) decides and there is one answer, not two.
     */
    it('omits the option when nobody asked, rather than guessing', async () => {
        const { renderers } = await mount();
        expect(renderers.last().options?.allowTransparency).toBeUndefined();
    });

    /**
     * `data-terminal-transparent` reports what the LIVE engine was built with — the only
     * automatable proof that the opacity reached the renderer, since a screenshot composites
     * the page and cannot see through the window. It must track the engine, not the prop.
     */
    it('publishes the engine value on the pane root, and reports the built value', async () => {
        const { root } = await mount({ allowTransparency: true });
        expect(root.getAttribute('data-terminal-transparent')).toBe('true');

        const opaque = await mount({ allowTransparency: false });
        expect(opaque.root.getAttribute('data-terminal-transparent')).toBe('false');

        const unset = await mount();
        expect(unset.root.getAttribute('data-terminal-transparent')).toBe('false');
    });
});
