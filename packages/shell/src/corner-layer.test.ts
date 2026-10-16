/**
 * The corner layer's controller, against a fake page and a fake overlay view.
 *
 * The properties that matter: the page is only told to stop drawing its own stack after the
 * layer has drawn a frame; every failure gives drawing back to the page; a view is shown before
 * a frame is drawn into it and emptied before it is hidden; and a click on the layer reaches the
 * page.
 */

import { describe, expect, it } from 'vitest';

import {
    CORNER_LAYER_VERSION,
    CORNER_MARGIN_PX,
    cornerCallScript,
    cornerOverlayURL,
    cornerPlacement,
    createCornerLayer,
    parseCornerAction,
    parseCornerFrame,
    type CornerOverlayView
} from './corner-layer.js';
import type { ViewBounds } from './webhost/geometry.js';

const METRICS = { contentWidth: 1200, contentHeight: 800, scaleFactor: 2 };

function frame(rev: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: CORNER_LAYER_VERSION,
        rev,
        attached: false,
        rect: { x: 880, y: 700, w: 308, h: 68 },
        content: { toasts: [{ id: 't1', title: 'Removed worktree', body: '/tmp/wt' }], oldHosts: null },
        vars: {},
        theme: 'dark',
        devicePixelRatio: 2,
        ...overrides
    };
}

const EMPTY = (rev: number, attached = false): Record<string, unknown> => frame(rev, { rect: null, content: null, attached });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Let every queued promise continuation run. */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The page: a probe answer, a queue of frames for `next`, and a record of every call. */
function fakePage(version: unknown = CORNER_LAYER_VERSION) {
    const calls: string[] = [];
    const frames: Record<string, unknown>[] = [];
    let waiting: ((frame: Record<string, unknown>) => void) | null = null;
    let fail: Error | null = null;
    return {
        calls,
        push(next: Record<string, unknown>): void {
            if (waiting !== null) {
                const resolve = waiting;
                waiting = null;
                resolve(next);
            } else frames.push(next);
        },
        breakWith(error: Error): void {
            fail = error;
        },
        run(script: string): Promise<unknown> {
            calls.push(script);
            if (fail !== null) return Promise.reject(fail);
            if (script.includes('.version')) return Promise.resolve(version);
            if (script.includes('"next"')) {
                const queued = frames.shift();
                if (queued !== undefined) return Promise.resolve(queued);
                return new Promise((resolve) => {
                    waiting = resolve;
                });
            }
            return Promise.resolve(true);
        }
    };
}

/** The overlay view: what was loaded, placed, hidden, drawn, in order. */
function fakeOverlay(options: { version?: unknown; load?: boolean; renderFails?: boolean } = {}) {
    const events: string[] = [];
    let click = deferred<unknown>();
    const view: CornerOverlayView & { events: string[]; click(action: unknown): void } = {
        events,
        click(action: unknown): void {
            const current = click;
            click = deferred<unknown>();
            current.resolve(action);
        },
        load(url: string): Promise<boolean> {
            events.push(`load ${url}`);
            return Promise.resolve(options.load ?? true);
        },
        run(script: string): Promise<unknown> {
            if (script.includes('.version')) return Promise.resolve('version' in options ? options.version : CORNER_LAYER_VERSION);
            if (script.includes('"next"')) return click.promise;
            if (script.includes('"render"')) {
                events.push(script.endsWith('["render"](null)') ? 'render empty' : 'render');
                return options.renderFails === true ? Promise.reject(new Error('render threw')) : Promise.resolve(true);
            }
            return Promise.resolve(null);
        },
        place(bounds: ViewBounds, zoom: number): void {
            events.push(`place ${String(bounds.x)},${String(bounds.y)} ${String(bounds.width)}x${String(bounds.height)} @${String(zoom)}`);
        },
        hide(): void {
            events.push('hide');
        },
        destroy(): void {
            events.push('destroy');
        }
    };
    return view;
}

function layerWith(page: ReturnType<typeof fakePage>, overlay: ReturnType<typeof fakeOverlay>) {
    const lines: string[] = [];
    const layer = createCornerLayer({
        runInPage: (script) => page.run(script),
        overlay,
        metrics: () => METRICS,
        log: (line) => lines.push(line),
        warn: (line) => lines.push(`WARN ${line}`),
        probeTimeoutMs: 200,
        renderTimeoutMs: 200
    });
    return { layer, lines };
}

const attachCalls = (page: ReturnType<typeof fakePage>): number => page.calls.filter((call) => call.includes('"attach"')).length;
const detachCalls = (page: ReturnType<typeof fakePage>): number => page.calls.filter((call) => call.includes('"detach"')).length;

describe('parseCornerFrame', () => {
    it('reads a frame and keeps the page original for the overlay', () => {
        const raw = frame(4, { attached: true });
        const parsed = parseCornerFrame(raw);
        expect(parsed).toMatchObject({ rev: 4, attached: true, rect: { x: 880, y: 700, w: 308, h: 68 }, hasContent: true, devicePixelRatio: 2 });
        expect(parsed?.raw).toBe(raw);
    });

    it('refuses another version, a bad rect or a missing flag', () => {
        expect(parseCornerFrame(frame(1, { version: 2 }))).toBeNull();
        expect(parseCornerFrame(frame(1, { rect: { x: 0, y: 0, w: -1, h: 4 } }))).toBeNull();
        expect(parseCornerFrame(frame(1, { rect: 'here' }))).toBeNull();
        expect(parseCornerFrame(frame(1, { attached: 'yes' }))).toBeNull();
        expect(parseCornerFrame(frame(1, { content: 'cards' }))).toBeNull();
        expect(parseCornerFrame(null)).toBeNull();
    });

    it('defaults an unusable device pixel ratio to 1', () => {
        expect(parseCornerFrame(frame(1, { devicePixelRatio: 0 }))?.devicePixelRatio).toBe(1);
    });
});

describe('parseCornerAction', () => {
    it('passes the three clicks and nothing else', () => {
        expect(parseCornerAction({ kind: 'dismiss', id: 'x' })).toEqual({ kind: 'dismiss', id: 'x' });
        expect(parseCornerAction({ kind: 'restart-old-hosts' })).toEqual({ kind: 'restart-old-hosts' });
        expect(parseCornerAction({ kind: 'later-old-hosts' })).toEqual({ kind: 'later-old-hosts' });
        expect(parseCornerAction({ kind: 'dismiss', id: 'x'.repeat(513) })).toBeNull();
        expect(parseCornerAction({ kind: 'eval', code: '1' })).toBeNull();
        expect(parseCornerAction(null)).toBeNull();
    });
});

describe('cornerPlacement', () => {
    it('adds the margin, converts to window DIPs and reports the inset back in CSS px', () => {
        // devicePixelRatio 2 on a 2x display: one CSS px is one DIP.
        const placed = cornerPlacement({ x: 880, y: 700, w: 308, h: 68 }, 2, METRICS);
        expect(placed).toEqual({
            bounds: { x: 880 - CORNER_MARGIN_PX, y: 700 - CORNER_MARGIN_PX, width: 308 + CORNER_MARGIN_PX * 2, height: 68 + CORNER_MARGIN_PX * 2 },
            inset: { right: CORNER_MARGIN_PX, bottom: CORNER_MARGIN_PX },
            zoom: 1
        });
    });

    it('clamps the margin at the window edge and says so in the inset', () => {
        const placed = cornerPlacement({ x: 1190, y: 790, w: 8, h: 8 }, 2, METRICS);
        expect(placed?.bounds).toEqual({ x: 1178, y: 778, width: 22, height: 22 });
        expect(placed?.inset).toEqual({ right: 2, bottom: 2 });
    });

    it('scales for a zoomed page', () => {
        const placed = cornerPlacement({ x: 100, y: 100, w: 50, h: 20 }, 3, METRICS, 0);
        expect(placed).toEqual({ bounds: { x: 150, y: 150, width: 75, height: 30 }, inset: { right: 0, bottom: 0 }, zoom: 1.5 });
    });

    it('is null for an empty box or one outside the window', () => {
        expect(cornerPlacement({ x: 10, y: 10, w: 0, h: 10 }, 2, METRICS)).toBeNull();
        expect(cornerPlacement({ x: 5000, y: 10, w: 10, h: 10 }, 2, METRICS)).toBeNull();
    });
});

describe('cornerOverlayURL', () => {
    it('is beside the page, without its query', () => {
        expect(cornerOverlayURL('http://127.0.0.1:4000/?token=abc&shellWindow=w')).toBe('http://127.0.0.1:4000/overlay.html');
    });

    it('is null for a page the daemon did not serve', () => {
        expect(cornerOverlayURL('data:text/html,stopped')).toBeNull();
        expect(cornerOverlayURL('file:///tmp/x.html')).toBeNull();
        expect(cornerOverlayURL('not a url')).toBeNull();
    });
});

describe('cornerCallScript', () => {
    it('embeds every argument as JSON', () => {
        expect(cornerCallScript('__g', 'act', { kind: 'dismiss', id: '");alert(1);("' })).toBe(
            'globalThis["__g"]["act"]({"kind":"dismiss","id":"\\");alert(1);(\\""})'
        );
    });
});

describe('createCornerLayer', () => {
    it('loads the overlay beside the page, and attaches only once a frame has been handled', async () => {
        const page = fakePage();
        const overlay = fakeOverlay();
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/?token=t');
        await settle();
        expect(overlay.events[0]).toBe('load http://127.0.0.1:4000/overlay.html');
        expect(layer.state).toBe('drawing');
        expect(attachCalls(page)).toBe(0);

        page.push(EMPTY(0));
        await settle();
        expect(attachCalls(page)).toBe(1);
        // Nothing up: nothing placed, nothing drawn.
        expect(overlay.events).toEqual(['load http://127.0.0.1:4000/overlay.html']);
    });

    it('shows a hidden view before drawing into it, and draws before moving a shown one', async () => {
        const page = fakePage();
        const overlay = fakeOverlay();
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        page.push(frame(1, { attached: true }));
        await settle();
        expect(overlay.events.slice(1)).toEqual(['place 868,688 332x92 @1', 'render']);

        page.push(frame(2, { attached: true, rect: { x: 880, y: 620, w: 308, h: 148 } }));
        await settle();
        expect(overlay.events.slice(3)).toEqual(['render', 'place 868,608 332x172 @1']);
        // Already attached: no attach call for either frame.
        expect(attachCalls(page)).toBe(0);
    });

    it('empties a shown view before hiding it', async () => {
        const page = fakePage();
        const overlay = fakeOverlay();
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        page.push(frame(1, { attached: true }));
        await settle();
        page.push(EMPTY(2, true));
        await settle();
        expect(overlay.events.slice(-2)).toEqual(['render empty', 'hide']);
    });

    it('stays off for a page without the bridge, and never loads the overlay', async () => {
        const page = fakePage(null);
        const overlay = fakeOverlay();
        const { layer, lines } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        expect(layer.state).toBe('off');
        expect(overlay.events).toEqual([]);
        expect(lines.some((line) => line.includes('no corner bridge'))).toBe(true);
    });

    it('stays off when the overlay comes up on another version, and takes it down', async () => {
        const page = fakePage();
        const overlay = fakeOverlay({ version: null });
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        expect(layer.state).toBe('off');
        expect(overlay.events).toEqual(['load http://127.0.0.1:4000/overlay.html', 'destroy']);
        expect(attachCalls(page)).toBe(0);
    });

    it('gives drawing back to the page when a frame does not draw', async () => {
        const page = fakePage();
        const overlay = fakeOverlay({ renderFails: true });
        const { layer, lines } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        page.push(frame(1, { attached: true }));
        await settle();
        expect(detachCalls(page)).toBe(1);
        expect(layer.state).toBe('off');
        expect(overlay.events.at(-1)).toBe('hide');
        expect(lines.some((line) => line.startsWith('WARN corner layer: off'))).toBe(true);
    });

    it('gives drawing back when the page stops answering', async () => {
        const page = fakePage();
        const overlay = fakeOverlay();
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        page.push(frame(1, { attached: true }));
        await settle();
        page.breakWith(new Error('Script failed to execute'));
        page.push(frame(2, { attached: true }));
        await settle();
        expect(layer.state).toBe('off');
    });

    it('relays a click on the layer to the page', async () => {
        const page = fakePage();
        const overlay = fakeOverlay();
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        overlay.click({ kind: 'dismiss', id: 't1' });
        await settle();
        overlay.click({ kind: 'nonsense' });
        await settle();
        const acts = page.calls.filter((call) => call.includes('"act"'));
        expect(acts).toEqual(['globalThis["__kelpiCorner"]["act"]({"kind":"dismiss","id":"t1"})']);
    });

    it('when the overlay dies: the page draws again, and a fresh overlay is loaded', async () => {
        const page = fakePage();
        const overlay = fakeOverlay();
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        page.push(frame(1, { attached: true }));
        await settle();
        layer.overlayGone('crashed');
        await settle();
        expect(detachCalls(page)).toBe(1);
        expect(overlay.events.filter((event) => event === 'destroy')).toHaveLength(1);
        expect(overlay.events.filter((event) => event.startsWith('load'))).toHaveLength(2);
        expect(layer.state).toBe('drawing');
    });

    it('gives up on an overlay that keeps dying', async () => {
        const page = fakePage();
        const overlay = fakeOverlay();
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        for (let i = 0; i < 4; i += 1) {
            layer.overlayGone('crashed');
            await settle();
        }
        expect(layer.state).toBe('off');
        expect(overlay.events.filter((event) => event.startsWith('load'))).toHaveLength(4);
    });

    it('a page that goes stops the loops; the next load starts them again', async () => {
        const page = fakePage();
        const overlay = fakeOverlay();
        const { layer } = layerWith(page, overlay);
        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        page.push(frame(1, { attached: true }));
        await settle();
        layer.pageGone('navigation');
        expect(layer.state).toBe('idle');
        expect(overlay.events.at(-1)).toBe('hide');
        // A frame the old loop would have drawn arrives after it was superseded: nothing happens.
        const drawn = overlay.events.length;
        page.push(frame(2, { attached: true }));
        await settle();
        expect(overlay.events.length).toBe(drawn);

        layer.pageLoaded('http://127.0.0.1:4000/');
        await settle();
        expect(layer.state).toBe('drawing');
    });
});
