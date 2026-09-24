/**
 * The root arrangement's route back: an 8 px strip where the toolbar was, with a handle that
 * restores it.
 *
 * Drawn by the host whenever the toolbar band is hidden, by Zen Mode or by View ▸ Toggle Toolbar
 * (`plugins/arrangement.ts`). It sits outside every slot, so no plugin can select it away, hide it
 * or draw over it, and it takes layout room rather than floating over the grid, so a native web
 * page can never cover it either. Eight pixels is what that costs, and it buys two things the
 * toolbar used to provide:
 *
 *   - **the drag region.** A shell window is `hiddenInset`: with no toolbar there is nothing to
 *     drag it by. The strip carries `data-titlebar-drag` (`styles.css`), and the handle, a
 *     button, opts back out of it by the same rule every toolbar control does.
 *   - **the way back.** The handle is a 40 by 4 px pill at rest. Hovered or focused it grows into
 *     a labelled button ("Exit Zen Mode" and its live chord, or "Show Toolbar"), which hangs below the strip
 *     over the top of the grid; only then does it register its rect, so a web page under it parks
 *     while it is open and at no other time (`modal-presence.ts` ▸ `useOverlayPresence`).
 *
 * The traffic lights that sat at the toolbar's leading edge are hidden by the shell for as long as
 * the toolbar is (`shell/src/titlebar.ts`), so nothing native lands on the strip either.
 */

import { useRef, useState, type ReactElement } from 'react';

import { useOverlayPresence } from './modal-presence';
import { tokens } from './tokens';

export const RESTORE_STRIP_HEIGHT_PX = 8;

export interface RestoreStripProps {
    /** Zen Mode is on: the handle leaves it. Otherwise only the toolbar is hidden and it shows that. */
    readonly zen: boolean;
    /** The live chord for `toggle_zen_mode`, or undefined when the user has unbound it. */
    readonly chord: string | undefined;
    /** Inside a shell window, where the strip has to be what the window is dragged by. */
    readonly dragRegion: boolean;
    readonly onRestore: () => void;
}

export function RestoreStrip(props: RestoreStripProps): ReactElement {
    const [expanded, setExpanded] = useState(false);
    const handle = useRef<HTMLButtonElement>(null);
    useOverlayPresence(handle, expanded);
    const label = props.zen ? 'Exit Zen Mode' : 'Show Toolbar';
    const chord = props.zen && props.chord !== undefined ? props.chord : null;
    return (
        <div
            data-testid="restore-strip"
            data-zen={props.zen ? 'true' : 'false'}
            data-titlebar-drag={props.dragRegion ? 'true' : undefined}
            className="relative shrink-0 border-b"
            style={{ height: RESTORE_STRIP_HEIGHT_PX, background: tokens.footerBackground, borderColor: tokens.divider, zIndex: 30 }}
        >
            <button
                ref={handle}
                type="button"
                data-testid="restore-strip-handle"
                data-expanded={expanded ? 'true' : 'false'}
                aria-label={chord === null ? label : `${label} (${chord})`}
                title={chord === null ? label : `${label} (${chord})`}
                className="absolute flex items-center gap-2 whitespace-nowrap rounded-full text-[11px] focus-visible:outline focus-visible:outline-1"
                style={expanded ? {
                    top: 2, left: '50%', transform: 'translateX(-50%)', height: 22, padding: '0 10px', background: tokens.headerBackground, color: tokens.textPrimary,
                    border: `1px solid ${tokens.divider}`, outlineColor: tokens.accent
                } : {
                    top: 2, left: '50%', transform: 'translateX(-50%)', height: 4, width: 40, padding: 0, background: tokens.textTertiary, border: 'none', outlineColor: tokens.accent
                }}
                onPointerEnter={() => setExpanded(true)}
                onPointerLeave={() => setExpanded(false)}
                onFocus={() => setExpanded(true)}
                onBlur={() => setExpanded(false)}
                onClick={() => {
                    setExpanded(false);
                    props.onRestore();
                }}
            >
                {expanded ? <>
                    <span>{label}</span>
                    {chord === null ? null : <span style={{ color: tokens.textTertiary }}>{chord}</span>}
                </> : null}
            </button>
        </div>
    );
}
