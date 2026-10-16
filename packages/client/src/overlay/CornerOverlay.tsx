/**
 * The shell's corner layer: the toast stack, drawn in a see-through view ABOVE the web pages.
 *
 * `chrome/corner-layer.ts` has the why. This is the other document: the shell loads
 * `overlay.html` into a `WebContentsView`, places it over the box the page measured its stack in,
 * and drives it through one global, the same `executeJavaScript` route the page's half uses:
 *
 *     __kelpiCornerOverlay = { version, render(input), next() }
 *
 *   - `render(input)` draws a frame and resolves once it has painted, so the shell can move or
 *     hide the view without showing a stale card.
 *   - `next()` resolves with the next click, which the shell hands to the page's `act`.
 *
 * It draws the page's own `ToastCards` with the page's stylesheet and theme variables, so the
 * cards look the same whichever document painted them. It connects to nothing and keeps no state
 * of its own beyond the clicks the shell has not collected yet.
 */

import { flushSync } from 'react-dom';
import type { Root } from 'react-dom/client';
import type { ReactElement } from 'react';

import {
    CORNER_LAYER_VERSION,
    CORNER_OVERLAY_GLOBAL,
    type CornerAction,
    type CornerContent,
    type CornerFrame
} from '../chrome/corner-layer';
import { ToastCards } from '../chrome/ToastStack';

/** What the shell renders: the page's frame, and where in this view the stack goes. */
export interface CornerOverlayInput {
    readonly frame: CornerFrame;
    /**
     * CSS px from this view's right and bottom edges to the stack's. The stack is anchored to the
     * bottom right, as the page's is, so a card arriving on top only grows the view upward: while
     * the shell is still widening the view to fit it, the cards already up stay where they were.
     */
    readonly inset: { readonly right: number; readonly bottom: number };
}

/**
 * How long `render` waits for a paint it cannot see. A view the window is not compositing gets no
 * animation frames, and the shell must not wait on one for ever.
 */
export const PAINT_FALLBACK_MS = 250;

function readInput(value: unknown): CornerOverlayInput | null {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as { frame?: unknown; inset?: unknown };
    const frame = record.frame as CornerFrame | undefined;
    const inset = record.inset as { right?: unknown; bottom?: unknown } | undefined;
    if (typeof frame !== 'object' || frame === null || typeof inset !== 'object' || inset === null) return null;
    if (typeof inset.right !== 'number' || typeof inset.bottom !== 'number') return null;
    return { frame, inset: { right: inset.right, bottom: inset.bottom } };
}

function applyTheme(frame: CornerFrame): void {
    const root = globalThis.document?.documentElement;
    if (root === undefined || root === null) return;
    for (const [name, value] of Object.entries(frame.vars)) {
        if (name.startsWith('--kelpi-')) root.style.setProperty(name, value);
    }
    if (frame.theme !== null) root.dataset['kelpiTheme'] = frame.theme;
}

/** Resolves after the next painted frame, or after `PAINT_FALLBACK_MS` when none comes. */
function painted(): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (): void => {
            if (done) return;
            done = true;
            resolve(true);
        };
        const frame = globalThis.requestAnimationFrame as ((callback: () => void) => number) | undefined;
        frame?.(() => frame(finish));
        setTimeout(finish, PAINT_FALLBACK_MS);
    });
}

export function CornerOverlay(props: {
    readonly input: CornerOverlayInput | null;
    readonly onAction: (action: CornerAction) => void;
}): ReactElement | null {
    const content: CornerContent | null = props.input?.frame.content ?? null;
    const rect = props.input?.frame.rect ?? null;
    if (props.input === null || content === null || rect === null) return null;
    const { onAction } = props;
    return (
        <div
            data-testid="corner-layer-stack"
            className="fixed flex flex-col gap-2"
            style={{ right: props.input.inset.right, bottom: props.input.inset.bottom, width: rect.w }}
        >
            <ToastCards
                toasts={content.toasts}
                oldHosts={content.oldHosts}
                onDismiss={(id) => onAction({ kind: 'dismiss', id })}
                onRestartOldHosts={() => onAction({ kind: 'restart-old-hosts' })}
                onLaterOldHosts={() => onAction({ kind: 'later-old-hosts' })}
            />
        </div>
    );
}

/** Install `__kelpiCornerOverlay` on `target`, rendering into `root`. */
export function installCornerOverlay(target: Record<string, unknown>, root: Root): void {
    const queued: CornerAction[] = [];
    /**
     * One collector at a time. The shell starts a new one each time it re-attaches to a page, and
     * the old one's call is still pending in here: answered first, it would carry the click to a
     * loop that has already been superseded and drops it. So a new `next` releases the old one
     * with null, which its loop reads as "nothing", and then exits on its stale generation.
     */
    let waiting: ((action: CornerAction | null) => void) | null = null;
    const emit = (action: CornerAction): void => {
        const resolve = waiting;
        waiting = null;
        if (resolve === null) queued.push(action);
        else resolve(action);
    };
    target[CORNER_OVERLAY_GLOBAL] = Object.freeze({
        version: CORNER_LAYER_VERSION,
        render: (value: unknown): Promise<boolean> => {
            const input = readInput(value);
            if (input !== null) applyTheme(input.frame);
            // Synchronously, so the DOM is the new frame before anything can paint it.
            flushSync(() => {
                root.render(<CornerOverlay input={input} onAction={emit} />);
            });
            return painted();
        },
        next: (): Promise<CornerAction | null> => {
            const previous = waiting;
            waiting = null;
            previous?.(null);
            const action = queued.shift();
            if (action !== undefined) return Promise.resolve(action);
            return new Promise((resolve) => {
                waiting = resolve;
            });
        }
    });
}
