/**
 * Geometry report normalisation — the daemon's whole share of embedded web panes.
 *
 * The interesting bits are the two things a host must be able to trust: that a rect it is
 * handed is numbers (a malformed report becomes "nothing to show", never NaN bounds), and that
 * `ownWindow` is true only for the window the host itself declared.
 */

import { describe, expect, it } from 'vitest';

import { geometryNotifyArgs, parseGeometryRect, type GeometryReportInput } from './geometry.js';

const PANE = 'AAAAAAAA-0000-4000-8000-00000000000A';

function report(overrides: Partial<GeometryReportInput> = {}): GeometryReportInput {
    return {
        paneID: PANE,
        rect: { x: 10, y: 20, w: 800, h: 600 },
        visible: true,
        devicePixelRatio: 2,
        ...overrides
    };
}

describe('parseGeometryRect', () => {
    it('reads a well-formed rect', () => {
        expect(parseGeometryRect({ x: 1, y: 2, w: 3, h: 4 })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    });

    it('degrades anything else into an empty rect rather than NaN bounds', () => {
        for (const value of [null, undefined, 'nope', [], { x: 'a', y: {}, w: NaN, h: Infinity }]) {
            expect(parseGeometryRect(value)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
        }
    });

    it('never reports a negative size', () => {
        expect(parseGeometryRect({ x: -5, y: -5, w: -100, h: -1 })).toEqual({
            x: -5,
            y: -5,
            w: 0,
            h: 0
        });
    });
});

describe('geometryNotifyArgs', () => {
    it('tags a report from the host’s own window', () => {
        const args = geometryNotifyArgs(report({ shellWindowID: 'WIN', tabID: 'T1' }), 'WIN');
        expect(args).toMatchObject({
            paneID: PANE,
            tabID: 'T1',
            rect: { x: 10, y: 20, w: 800, h: 600 },
            visible: true,
            devicePixelRatio: 2,
            ownWindow: true,
            shellWindowID: 'WIN'
        });
    });

    it('refuses the tag for another window, a browser, or a host with no window', () => {
        expect(geometryNotifyArgs(report({ shellWindowID: 'OTHER' }), 'WIN')['ownWindow']).toBe(false);
        // A plain browser client sends no window id at all: it can never own the host's views.
        expect(geometryNotifyArgs(report(), 'WIN')['ownWindow']).toBe(false);
        expect(geometryNotifyArgs(report({ shellWindowID: 'WIN' }), null)['ownWindow']).toBe(false);
    });

    it('folds a zero-sized rect into "not visible" so the host has one rule to implement', () => {
        const args = geometryNotifyArgs(
            report({ rect: { x: 0, y: 0, w: 0, h: 400 }, shellWindowID: 'WIN' }),
            'WIN'
        );
        expect(args['visible']).toBe(false);
    });

    it('omits the optional fields rather than sending nulls', () => {
        const args = geometryNotifyArgs(report(), null);
        expect('tabID' in args).toBe(false);
        expect('shellWindowID' in args).toBe(false);
        expect('clientID' in args).toBe(false);
        // A missing devicePixelRatio still yields a usable scale.
        expect(geometryNotifyArgs(report({ devicePixelRatio: NaN }), null)['devicePixelRatio']).toBe(1);
    });
});
