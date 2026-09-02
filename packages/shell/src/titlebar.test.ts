import { describe, expect, it } from 'vitest';

import {
    TITLE_BAR_HEIGHT,
    TRAFFIC_LIGHT_DIAMETER,
    TRAFFIC_LIGHT_GUTTER,
    TRAFFIC_LIGHT_INSET_PARAM,
    TRAFFIC_LIGHT_X,
    TRAFFIC_LIGHT_Y,
    WINDOW_CONTROLS_PARAM,
    titleBarLogLine,
    titleBarStyleFor,
    trafficLightQuery,
    windowControlsQuery
} from './titlebar.js';

describe('the hidden title bar (§APP-046)', () => {
    it('asks Electron for hiddenInset on macOS', () => {
        const decision = titleBarStyleFor('darwin');
        expect(decision.titleBarStyle).toBe('hiddenInset');
        expect(decision.trafficLightPosition).toEqual({ x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y });
    });

    it('centres the buttons in the DRAWN strip rather than in a native title bar', () => {
        // The whole point of the item: there is no native strip any more, so the lights are
        // centred against the client's own 32px bar. Off by a pixel and they sit high or low.
        expect(TITLE_BAR_HEIGHT).toBe(32);
        expect(TRAFFIC_LIGHT_Y).toBe((TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2);
        expect(TRAFFIC_LIGHT_Y * 2 + TRAFFIC_LIGHT_DIAMETER).toBe(TITLE_BAR_HEIGHT);
    });

    it('reserves the shipped app’s own 80pt leading gutter, with the cluster inside it', () => {
        // shell-ui.md §3: "80 leading (clears traffic lights)". The cluster is three 12pt
        // buttons with 8pt gaps — 52pt — so it must END before the gutter does.
        const clusterEnd = TRAFFIC_LIGHT_X + TRAFFIC_LIGHT_DIAMETER * 3 + 8 * 2;
        expect(TRAFFIC_LIGHT_GUTTER).toBe(80);
        expect(clusterEnd).toBeLessThan(TRAFFIC_LIGHT_GUTTER);
    });

    it('hides the frame on Windows and Linux too, and asks the PAGE for the buttons', () => {
        // §APP-046b. `hidden` rather than `hiddenInset`: only macOS has an inset cluster to
        // position. Neither platform gets a gutter, because a gutter reserves room for buttons
        // somebody ELSE draws — here the page draws them and already knows how wide they are.
        for (const platform of ['win32', 'linux']) {
            const decision = titleBarStyleFor(platform);
            expect(decision.titleBarStyle).toBe('hidden');
            expect(decision.trafficLightPosition).toBeUndefined();
            expect(decision.gutter).toBe(0);
            expect(decision.windowControls).toBe(true);
            // §APP-046b: Electron draws the application menu INSIDE the window on both, so an
            // unhidden menu bar would stack a strip above the drawn one — the defect this item
            // removes, rebuilt. Invisible on KDE (global menu over DBus), which is the trap.
            expect(decision.autoHideMenuBar).toBe(true);
            // …and no traffic-light inset, so the strip cannot reserve 80px of empty leading
            // space invented by a macOS feature.
            expect(trafficLightQuery(decision)).toBe('');
            expect(windowControlsQuery(decision)).toBe(`&${WINDOW_CONTROLS_PARAM}=1`);
        }
    });

    it('never asks the page to draw buttons it is not standing in for', () => {
        // macOS has REAL traffic lights over this strip: a page-drawn cluster would be a second,
        // fake set of window buttons beside AppKit's own.
        expect(titleBarStyleFor('darwin').windowControls).toBe(false);
        expect(windowControlsQuery(titleBarStyleFor('darwin'))).toBe('');
        // macOS has no in-window menu bar to fold away — the menu lives in the system bar.
        expect(titleBarStyleFor('darwin').autoHideMenuBar).toBe(false);
    });

    it('leaves an unknown platform the ordinary frame it already had', () => {
        // The conservative direction, and deliberately so: a frameless window whose controls we
        // failed to draw is a window with no way to close it.
        const decision = titleBarStyleFor('freebsd');
        expect(decision.titleBarStyle).toBeUndefined();
        expect(decision.trafficLightPosition).toBeUndefined();
        expect(decision.gutter).toBe(0);
        expect(decision.windowControls).toBe(false);
        expect(decision.autoHideMenuBar).toBe(false);
        expect(trafficLightQuery(decision)).toBe('');
        expect(windowControlsQuery(decision)).toBe('');
    });

    it('tells the page exactly one number', () => {
        expect(trafficLightQuery(titleBarStyleFor('darwin'))).toBe(
            `&${TRAFFIC_LIGHT_INSET_PARAM}=${String(TRAFFIC_LIGHT_GUTTER)}`
        );
    });
});

describe('the title-bar report (§APP-046’s assertion surface)', () => {
    it('reports a zero-height frame chrome when the title bar is hidden', () => {
        const line = titleBarLogLine({
            decision: titleBarStyleFor('darwin'),
            frameHeight: 800,
            contentHeight: 800
        });
        expect(line).toContain('style=hiddenInset');
        expect(line).toContain('trafficLights=13,10');
        expect(line).toContain('gutter=80');
        expect(line).toContain('chromeHeight=0');
    });

    it('makes the OLD defect visible as a number, so a regression cannot hide', () => {
        // A standard frame keeps ~28px for a native strip drawn ABOVE the client's own — the
        // "two stacked strips" this item is about. Every platform we ship hides its frame now,
        // so the case is stated directly rather than borrowed from a platform that no longer
        // demonstrates it — the point of the assertion is the LOG LINE, not the decision.
        const line = titleBarLogLine({
            decision: { gutter: 0, windowControls: false, autoHideMenuBar: false },
            frameHeight: 828,
            contentHeight: 800
        });
        expect(line).toContain('style=default');
        expect(line).toContain('trafficLights=none');
        expect(line).toContain('chromeHeight=28');
    });

    it('says WHO draws the window buttons, so the two frames are told apart from outside', () => {
        // §APP-046b: `chromeHeight=0` alone cannot distinguish "macOS, AppKit draws the lights"
        // from "Linux, the page draws them" — and the audit needs to know which cluster to look
        // for. One word in the line, from the same decision that created the window.
        const linux = titleBarLogLine({
            decision: titleBarStyleFor('linux'),
            frameHeight: 800,
            contentHeight: 800
        });
        expect(linux).toContain('style=hidden ');
        expect(linux).toContain('windowControls=client');
        expect(linux).toContain('menuBar=autohide');
        expect(linux).toContain('chromeHeight=0');

        const mac = titleBarLogLine({
            decision: titleBarStyleFor('darwin'),
            frameHeight: 800,
            contentHeight: 800
        });
        expect(mac).toContain('windowControls=native');
    });
});
