/**
 * §N31 — the side panels' slide, as it is actually rendered.
 *
 * `chrome/sidebar-reveal.test.ts` owns the arithmetic (the clip carries the panel's ground; the
 * panel is anchored to the edge it travels from; the two together cover the whole slot at every
 * point of the slide). This file owns the wiring, which is the half that actually flashed: the
 * styles have to reach the DOM nodes the browser composites, on BOTH panels, in every phase the
 * slide passes through.
 *
 * The defect they close, measured with `scripts/ui-audit/panel-slide-flash.mjs` on this tree:
 * the container between the slot and the panel painted nothing, so a slide opened a hole onto
 * whatever `<body>` paints — `transparent`, i.e. the desktop, under a window created transparent
 * (§N17) — and the inspector's panel, laid out at its clip's leading edge while travelling off
 * the trailing one, was not even inside its own reveal for the first half of every slide
 * (coverage 0 %, 100 % of the revealed strip fully cleared mid-flight).
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import type { JsonObject } from '@nex/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { SIDEBAR_PANEL_GROUND } from './chrome';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createNexRuntime, createNexStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: PANE_A,
        name: 'dev',
        color: 'blue',
        now: NOW
    });
    return store.getState() as unknown as JsonObject;
}

function setup(): void {
    const sockets = createFakeSocketFactory();
    const runtime = createNexRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createNexStore(),
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
}

afterEach(cleanup);

/** The inline `background` as React wrote it — the var reference, not a resolved colour. */
function inlineBackground(element: HTMLElement): string {
    return element.style.background;
}

describe('the sidebar’s slide (§N31)', () => {
    it('the clip paints the panel’s ground and is the panel’s containing block', () => {
        setup();
        const clip = screen.getByTestId('sidebar-clip');
        expect(inlineBackground(clip)).toBe(SIDEBAR_PANEL_GROUND);
        expect(clip.style.position).toBe('relative');
        // `overflow: hidden` is what makes the clip the animated width in the first place; if it
        // ever leaves, the panel stops being clipped and the slide stops being a slide.
        expect(clip.className).toContain('overflow-hidden');
    });

    it('the panel is anchored to the LEADING edge it travels from', () => {
        setup();
        const panel = screen.getByTestId('sidebar-panel');
        expect(panel.style.position).toBe('absolute');
        expect(panel.style.left).toBe('0px');
        expect(panel.style.right).toBe('auto');
        expect(panel.style.top).toBe('0px');
        expect(panel.style.bottom).toBe('0px');
    });

    it('keeps the ground on the clip while the panel is CLOSING, which is the flash window', () => {
        setup();
        fireEvent.click(screen.getByLabelText('Toggle sidebar'));
        const slot = screen.getByTestId('sidebar-slot');
        // Still mounted, still travelling — the phase the reveal exists in.
        expect(slot.getAttribute('data-sidebar-phase')).toBe('closing');
        expect(inlineBackground(screen.getByTestId('sidebar-clip'))).toBe(SIDEBAR_PANEL_GROUND);
        expect(screen.getByTestId('sidebar-panel').style.position).toBe('absolute');
    });
});

describe('the inspector’s slide (§N31)', () => {
    it('the clip paints the same ground, and the panel is anchored to the TRAILING edge', () => {
        setup();
        fireEvent.click(screen.getByTestId('toggle-inspector'));
        const clip = screen.getByTestId('inspector-clip');
        expect(inlineBackground(clip)).toBe(SIDEBAR_PANEL_GROUND);
        expect(clip.style.position).toBe('relative');
        expect(clip.className).toContain('overflow-hidden');

        const panel = screen.getByTestId('inspector-panel');
        expect(panel.style.position).toBe('absolute');
        // The half the port had backwards: a trailing panel anchored at `left` is outside its own
        // clip for most of the slide, because the clip's LEFT edge is the one that moves.
        expect(panel.style.right).toBe('0px');
        expect(panel.style.left).toBe('auto');
        expect(panel.style.top).toBe('0px');
        expect(panel.style.bottom).toBe('0px');
    });

    it('is mounted at the collapsed geometry first, with the ground already painted', () => {
        setup();
        fireEvent.click(screen.getByTestId('toggle-inspector'));
        // `opening` exists only so the browser gets one frame at the collapsed geometry to
        // transition from — and that frame must already be the panel's colour, not a hole.
        expect(screen.getByTestId('inspector-slot').getAttribute('data-inspector-phase')).toBe('opening');
        expect(inlineBackground(screen.getByTestId('inspector-clip'))).toBe(SIDEBAR_PANEL_GROUND);
    });
});
