import { describe, expect, it } from 'vitest';

import {
    TITLE_BAR_HEIGHT,
    TRAFFIC_LIGHT_DIAMETER,
    TRAFFIC_LIGHT_GUTTER,
    TRAFFIC_LIGHT_INSET_PARAM,
    TRAFFIC_LIGHT_X,
    TRAFFIC_LIGHT_Y,
    titleBarLogLine,
    titleBarStyleFor,
    trafficLightQuery
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

    it('leaves every other platform with the frame it already had, and nothing to reserve', () => {
        for (const platform of ['win32', 'linux', 'freebsd']) {
            const decision = titleBarStyleFor(platform);
            expect(decision.titleBarStyle).toBeUndefined();
            expect(decision.trafficLightPosition).toBeUndefined();
            expect(decision.gutter).toBe(0);
            // …and a page with no traffic lights around it is told nothing, so it cannot
            // reserve 80px of empty space invented by a macOS feature.
            expect(trafficLightQuery(decision)).toBe('');
        }
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
        // "two stacked strips" this item is about.
        const line = titleBarLogLine({
            decision: titleBarStyleFor('linux'),
            frameHeight: 828,
            contentHeight: 800
        });
        expect(line).toContain('style=default');
        expect(line).toContain('trafficLights=none');
        expect(line).toContain('chromeHeight=28');
    });
});
