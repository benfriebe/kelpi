/**
 * Fixtures and DOM helpers for the grid's tests (and for anyone assembling a grid demo).
 *
 * Deliberately framework-free — no `@testing-library/react` import — so this module stays
 * usable from a plain script and never drags a dev dependency into the app bundle.
 *
 * jsdom (26) implements neither `PointerEvent` nor `Element.setPointerCapture`, so
 * `firePointer` dispatches a `MouseEvent` under the pointer event's NAME. React dispatches
 * on the event type string, so `onPointerDown` and the grid's `window` listeners both fire,
 * and `clientX`/`clientY` survive — which is all the drag maths reads.
 */

import type { PaneModel } from './types';

export interface TestPaneOverrides extends Partial<PaneModel> {}

/** A `PaneModel` with spec defaults; override any field. */
export function testPane(id: string, overrides: TestPaneOverrides = {}): PaneModel {
    return {
        id,
        label: null,
        type: 'shell',
        title: null,
        workingDirectory: '/tmp',
        gitBranch: null,
        status: 'idle',
        filePath: null,
        isEditing: false,
        agentSessionID: null,
        agentKind: null,
        agentStartedAt: null,
        backgroundTaskCount: 0,
        ...overrides
    };
}

export type PointerEventName = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';

export interface PointerInit {
    readonly clientX?: number | undefined;
    readonly clientY?: number | undefined;
    readonly button?: number | undefined;
    readonly shiftKey?: boolean | undefined;
}

/** Dispatch a pointer-named `MouseEvent` (see the module note on jsdom). */
export function firePointer(target: EventTarget, type: PointerEventName, init: PointerInit = {}): void {
    target.dispatchEvent(
        new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: init.clientX ?? 0,
            clientY: init.clientY ?? 0,
            button: init.button ?? 0,
            shiftKey: init.shiftKey ?? false
        })
    );
}

/**
 * jsdom's layout engine reports a zero rect for everything, so the grid's client→container
 * coordinate conversion needs a stub. Pins the element's box at the given origin.
 */
export function stubBoundingRect(
    element: HTMLElement,
    box: { left: number; top: number; width: number; height: number }
): void {
    const rect: DOMRect = {
        x: box.left,
        y: box.top,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        right: box.left + box.width,
        bottom: box.top + box.height,
        toJSON: () => ({})
    };
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => rect
    });
}

/** `{ left, top, width, height }` as the grid writes them, for comparing against core rects. */
export function styleBox(element: HTMLElement): {
    left: string;
    top: string;
    width: string;
    height: string;
} {
    return {
        left: element.style.left,
        top: element.style.top,
        width: element.style.width,
        height: element.style.height
    };
}

/** The same box spelled from a core `Rect`, so a test can compare the two directly. */
export function expectedBox(rect: { x: number; y: number; width: number; height: number }): {
    left: string;
    top: string;
    width: string;
    height: string;
} {
    return {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
    };
}
