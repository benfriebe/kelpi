/**
 * The corner toast stack, and the cards it draws.
 *
 * The cards are their own component because two documents draw them: this page, and the shell's
 * corner layer (`overlay/corner.tsx`), which draws them above the web pages (`./corner-layer.ts`
 * has the why). One component, one stylesheet, so the two cannot drift.
 */

import { useMemo, useRef, type CSSProperties, type ReactElement } from 'react';

import { useCornerLayer, type CornerAction, type CornerContent, type CornerOldHosts, type CornerToast } from './corner-layer';
import { useOverlayPresence } from './modal-presence';
import { OldTerminalHostNotice } from './OldTerminalHostNotice';
import { tokens } from './tokens';

export interface ToastCardsProps {
    readonly toasts: readonly CornerToast[];
    /** #372's standing card at the bottom of the stack, or null. */
    readonly oldHosts: CornerOldHosts | null;
    readonly onDismiss: (id: string) => void;
    readonly onRestartOldHosts: () => void;
    readonly onLaterOldHosts: () => void;
}

export function ToastCards(props: ToastCardsProps): ReactElement {
    return (
        <>
            {props.toasts.map((toast) => (
                <button
                    key={toast.id}
                    type="button"
                    data-testid={`toast-${toast.id}`}
                    className="max-w-[320px] rounded-md px-3 py-2 text-left"
                    style={{
                        background: tokens.surfaceBackground,
                        border: `1px solid ${tokens.divider}`,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
                    }}
                    onClick={() => props.onDismiss(toast.id)}
                >
                    <span className="block text-[12px] font-medium" style={{ color: tokens.textPrimary }}>
                        {toast.title}
                    </span>
                    {/* `break-words`: a body carrying a filesystem path or a URL is one
                        unbreakable token whose min-content width blows straight through
                        `max-w-[320px]`, pushing the toast off the right edge of the window. */}
                    <span className="block break-words text-[11px]" style={{ color: tokens.textSecondary }}>
                        {toast.body}
                    </span>
                </button>
            ))}
            {props.oldHosts === null ? null : (
                <OldTerminalHostNotice
                    hosts={props.oldHosts.hosts}
                    restarting={props.oldHosts.restarting}
                    onRestart={props.onRestartOldHosts}
                    onLater={props.onLaterOldHosts}
                />
            )}
        </>
    );
}

/**
 * Laid out but not painted: the layer is drawing these cards, and this copy is still the box it
 * draws them in. Not `visibility: hidden`, which would also drop the cards from hit testing and
 * leave a CDP click on a toast landing on whatever is behind it.
 */
const DRAWN_BY_LAYER: CSSProperties = { opacity: 0 };

/** The in-app fallback for a notification the browser would not (or could not) show. */
export function ToastStack(props: ToastCardsProps): ReactElement | null {
    const root = useRef<HTMLDivElement | null>(null);
    const { toasts, oldHosts } = props;
    const content = useMemo<CornerContent | null>(
        () =>
            toasts.length === 0 && oldHosts === null
                ? null
                : { toasts: toasts.map(({ id, title, body }) => ({ id, title, body })), oldHosts },
        [toasts, oldHosts]
    );
    const onAction = (action: CornerAction): void => {
        if (action.kind === 'dismiss') props.onDismiss(action.id);
        else if (action.kind === 'restart-old-hosts') props.onRestartOldHosts();
        else props.onLaterOldHosts();
    };
    const layer = useCornerLayer(root, content, onAction);
    /*
     * H1: a toast is DOM and a web pane's page is a native view drawn over it, so an unparked page
     * simply eats the notification. Where the shell's corner layer is drawing the stack, the stack
     * is above every page and nothing has to park: the page under it stays live, scrolls, and keeps
     * the keyboard. Everywhere else (a browser, a phone, an older shell, a layer that died) the
     * stack parks the panes it covers, as it always did.
     *
     * §N26: its RECT, not the window. A window modal is also what `interaction/surface.ts` stands a
     * PROMPT down for (§2.3), and a corner box has no business owning the window; an unmeasured rect
     * still parks every pane, so H1's guarantee is unchanged.
     */
    useOverlayPresence(root, content !== null && !layer);
    if (content === null) return null;
    return (
        <div
            ref={root}
            data-testid="toast-stack"
            data-drawn-by={layer ? 'shell' : 'page'}
            className="absolute bottom-8 right-3 z-40 flex flex-col gap-2"
            style={layer ? DRAWN_BY_LAYER : undefined}
        >
            <ToastCards {...props} />
        </div>
    );
}
