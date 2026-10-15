/**
 * The image pane (content-panes.md §12): where its pixels come from, when it fetches them again,
 * and the two zooms. jsdom loads no images, so `Image` is a stand-in the test answers by hand.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_CHANGED_MESSAGE } from '@kelpi/protocol';

import type { KelpiRuntime } from '../state';
import { assetCredentialFor } from './asset-credential';
import { ImagePane, imageCaption } from './ImagePane';

const PANE = 'EEEEEEEE-0000-4000-8000-000000000001';
const TARGET = 'ws://127.0.0.1:7777/ws?token=tok-1';
const BASE = `http://127.0.0.1:7777/pane-assets/c/${assetCredentialFor('tok-1')}/${PANE}/shot.png`;

/** Every `new Image()` the pane made, in order; the test settles each by hand. */
class FakeImage {
    static made: FakeImage[] = [];
    decoding = '';
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';
    constructor() {
        FakeImage.made.push(this);
    }
    load(width: number, height: number): void {
        this.naturalWidth = width;
        this.naturalHeight = height;
        act(() => this.onload?.());
    }
    fail(): void {
        act(() => this.onerror?.());
    }
}

type Listener = (payload: never) => void;

function fakeRuntime(target = TARGET, isConnected = false): KelpiRuntime & { emit(event: string, payload: unknown): void } {
    const listeners = new Map<string, Set<Listener>>();
    const connection = {
        target,
        isConnected,
        on(event: string, listener: Listener) {
            const set = listeners.get(event) ?? new Set<Listener>();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
        }
    };
    return {
        connection,
        emit(event: string, payload: unknown) {
            act(() => {
                for (const listener of listeners.get(event) ?? []) (listener as (value: unknown) => void)(payload);
            });
        }
    } as unknown as KelpiRuntime & { emit(event: string, payload: unknown): void };
}

/** A viewport of a fixed size: jsdom lays nothing out, so the fit scale reads these. */
function sizeViewport(width: number, height: number): void {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
}

beforeEach(() => {
    FakeImage.made = [];
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe(): void {}
            disconnect(): void {}
        }
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('ImagePane', () => {
    it('loads the file from the daemon the connection dials, under its credential', () => {
        sizeViewport(800, 600);
        render(<ImagePane runtime={fakeRuntime()} paneID={PANE} filePath="/pics/shot.png" />);
        expect(FakeImage.made.map((image) => image.src)).toEqual([BASE]);
        FakeImage.made[0]!.load(400, 300);
        const img = screen.getByTestId(`image-pane-img-${PANE}`) as HTMLImageElement;
        expect(img.getAttribute('src')).toBe(BASE);
        expect(img.draggable).toBe(false);
        expect(screen.getByTestId(`image-pane-caption-${PANE}`).textContent).toBe('400 × 300');
    });

    it('fetches the file again under a new URL when the daemon says it changed, keeping the old pixels meanwhile', () => {
        sizeViewport(800, 600);
        const runtime = fakeRuntime();
        render(<ImagePane runtime={runtime} paneID={PANE} filePath="/pics/shot.png" />);
        FakeImage.made[0]!.load(400, 300);

        runtime.emit('message', { type: IMAGE_CHANGED_MESSAGE, paneID: 'some-other-pane' });
        expect(FakeImage.made).toHaveLength(1);

        runtime.emit('message', { type: IMAGE_CHANGED_MESSAGE, paneID: PANE });
        expect(FakeImage.made[1]?.src).toBe(`${BASE}?v=1`);
        const img = (): HTMLImageElement => screen.getByTestId(`image-pane-img-${PANE}`) as HTMLImageElement;
        expect(img().getAttribute('src')).toBe(BASE);
        FakeImage.made[1]!.load(640, 480);
        expect(img().getAttribute('src')).toBe(`${BASE}?v=1`);
        expect(screen.getByTestId(`image-pane-caption-${PANE}`).textContent).toBe('640 × 480');
    });

    it('fetches again after a reconnect, not on the first connect', () => {
        sizeViewport(800, 600);
        const runtime = fakeRuntime();
        render(<ImagePane runtime={runtime} paneID={PANE} filePath="/pics/shot.png" />);
        runtime.emit('welcome', {});
        expect(FakeImage.made).toHaveLength(1);
        runtime.emit('welcome', {});
        expect(FakeImage.made[1]?.src).toBe(`${BASE}?v=1`);
    });

    it('counts the first welcome as a reconnect when it mounted on a live connection', () => {
        sizeViewport(800, 600);
        const runtime = fakeRuntime(TARGET, true);
        render(<ImagePane runtime={runtime} paneID={PANE} filePath="/pics/shot.png" />);
        runtime.emit('welcome', {});
        expect(FakeImage.made[1]?.src).toBe(`${BASE}?v=1`);
    });

    it('says why when the file cannot be drawn, and keeps the last good image when a reload fails', () => {
        sizeViewport(800, 600);
        const runtime = fakeRuntime();
        const view = render(<ImagePane runtime={runtime} paneID={PANE} filePath="/pics/shot.png" />);
        FakeImage.made[0]!.fail();
        expect(screen.getByTestId(`content-status-${PANE}`).textContent).toContain("Can't show shot.png");
        view.unmount();

        FakeImage.made = [];
        render(<ImagePane runtime={runtime} paneID={PANE} filePath="/pics/shot.png" />);
        FakeImage.made[0]!.load(400, 300);
        runtime.emit('message', { type: IMAGE_CHANGED_MESSAGE, paneID: PANE });
        FakeImage.made[1]!.fail();
        expect((screen.getByTestId(`image-pane-img-${PANE}`) as HTMLImageElement).getAttribute('src')).toBe(BASE);
        expect(screen.getByTestId(`image-pane-caption-${PANE}`).textContent).toBe('shot.png could not be reloaded');
    });

    it('fits a large image, shows actual size on a click, and fits again on a second', () => {
        sizeViewport(500, 400);
        render(<ImagePane runtime={fakeRuntime()} paneID={PANE} filePath="/pics/shot.png" />);
        FakeImage.made[0]!.load(2000, 1000);
        const pane = screen.getByTestId(`image-pane-${PANE}`);
        expect(pane.dataset['zoom']).toBe('fit');
        expect(screen.getByTestId(`image-pane-caption-${PANE}`).textContent).toBe('2000 × 1000 · 25%');
        const viewport = screen.getByRole('img', { name: 'shot.png' });
        expect(viewport.style.cursor).toBe('zoom-in');

        fireEvent.click(viewport);
        expect(pane.dataset['zoom']).toBe('actual');
        expect(viewport.style.cursor).toBe('zoom-out');
        expect(screen.getByTestId(`image-pane-caption-${PANE}`).textContent).toBe('2000 × 1000');

        fireEvent.click(viewport);
        expect(pane.dataset['zoom']).toBe('fit');
    });

    it('never zooms an image that already fits', () => {
        sizeViewport(500, 400);
        render(<ImagePane runtime={fakeRuntime()} paneID={PANE} filePath="/pics/icon.png" />);
        FakeImage.made[0]!.load(64, 64);
        const viewport = screen.getByRole('img', { name: 'icon.png' });
        expect(viewport.style.cursor).toBe('default');
        fireEvent.click(viewport);
        expect(screen.getByTestId(`image-pane-${PANE}`).dataset['zoom']).toBe('fit');
    });

    it('asks for focus on a press', () => {
        sizeViewport(500, 400);
        const onFocusRequest = vi.fn();
        render(<ImagePane runtime={fakeRuntime()} paneID={PANE} filePath="/pics/shot.png" onFocusRequest={onFocusRequest} />);
        FakeImage.made[0]!.load(64, 64);
        fireEvent.mouseDown(screen.getByRole('img', { name: 'shot.png' }), { button: 0 });
        expect(onFocusRequest).toHaveBeenCalledWith(PANE);
    });
});

describe('imageCaption', () => {
    it('says the size, and the scale only when fit shrinks it', () => {
        expect(imageCaption(1920, 1080, null)).toBe('1920 × 1080');
        expect(imageCaption(1920, 1080, 1)).toBe('1920 × 1080');
        expect(imageCaption(1920, 1080, 0.421)).toBe('1920 × 1080 · 42%');
        expect(imageCaption(100000, 10, 0.0001)).toBe('100000 × 10 · 1%');
    });
});
